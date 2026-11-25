const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { argument, connectNeon } = require('./neon-connection');
const { createVersionedRead } = require('../src/utils/versionedRead');

async function main() {
  const envFile = argument('--env');
  if (!envFile || envFile.includes('production')) throw new Error('Run against a development/test branch only');
  const reader = await connectNeon(envFile, 'chatbotpro_cache_validation');
  let writer; let created = false;
  const schema = 'compute_cache_test_' + crypto.randomBytes(8).toString('hex');
  try {
    const branch = (await reader.query("SELECT current_setting('neon.branch_id',true) AS id")).rows[0].id;
    if (branch === 'br-old-king-apn7ojxn') throw new Error('Refusing to write to the production branch');
    writer = await connectNeon(envFile, 'chatbotpro_cache_validation_writer');
    await reader.query(`CREATE SCHEMA "${schema}"`); created = true;
    await reader.query(`CREATE TABLE "${schema}".orders(qty integer)`);
    await reader.query(`INSERT INTO "${schema}".orders VALUES(1)`);
    const read = createVersionedRead(); let loads = 0;
    const t = { schema, get: async (sql) => (await reader.query(sql)).rows[0] };
    const loader = async () => { loads++; return (await reader.query(`SELECT sum(qty)::int AS quantity FROM "${schema}".orders`)).rows[0].quantity; };
    assert.equal(await read(t, 'sales', loader), 1);
    assert.equal(await read(t, 'sales', loader), 1);
    assert.equal(loads, 1);
    await writer.query(`INSERT INTO "${schema}".orders VALUES(2)`);
    assert.equal(await read(t, 'sales', loader), 3);
    assert.equal(loads, 2);
    await writer.query('BEGIN');
    await writer.query(`UPDATE "${schema}".orders SET qty=99`);
    assert.equal(await read(t, 'sales', loader), 3, 'Uncommitted changes stay invisible');
    await writer.query('COMMIT');
    assert.equal(await read(t, 'sales', loader), 198, 'Commit invalidates a previously in-progress writer');
    await writer.query('BEGIN');
    await writer.query(`UPDATE "${schema}".orders SET qty=123`);
    assert.equal(await read(t, 'sales', loader), 198);
    await writer.query('ROLLBACK');
    assert.equal(await read(t, 'sales', loader), 198, 'Rollback cannot leak into cached results');
    await reader.query('BEGIN');
    const tx = { ...t, inTransaction: true };
    await reader.query(`UPDATE "${schema}".orders SET qty=5`);
    assert.equal(await read(tx, 'sales', loader), 10);
    await reader.query(`UPDATE "${schema}".orders SET qty=6`);
    assert.equal(await read(tx, 'sales', loader), 12, 'Own writes bypass cached snapshots');
    await reader.query('ROLLBACK');
    console.log(JSON.stringify({ status: 'passed', branch_id: branch, checks: ['cache-hit', 'external-insert', 'uncommitted-update', 'commit', 'rollback', 'own-writes'] }));
  } finally {
    if (writer) { await writer.query('ROLLBACK').catch(() => {}); await writer.end(); }
    await reader.query('ROLLBACK').catch(() => {});
    // Remove only the scratch schema created by this invocation.
    if (created) await reader.query(`DROP SCHEMA "${schema}" CASCADE`);
    await reader.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
