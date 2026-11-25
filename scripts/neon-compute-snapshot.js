const fs = require('node:fs');
const path = require('node:path');
const { argument, connectNeon } = require('./neon-connection');

async function main() {
  if (!argument('--env')) throw new Error('Specify --env explicitly');
  const client = await connectNeon(argument('--env'), 'chatbotpro_compute_snapshot');
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    const identity = (await client.query("SELECT now() AS observed_at,current_setting('neon.project_id',true) AS project_id,current_setting('neon.branch_id',true) AS branch_id,current_setting('neon.endpoint_id',true) AS endpoint_id,pg_postmaster_start_time() AS started_at")).rows[0];
    const database = (await client.query('SELECT xact_commit,xact_rollback,blks_read,blks_hit,tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted,temp_bytes,deadlocks,stats_reset FROM pg_stat_database WHERE datname=current_database()')).rows[0];
    const tables = (await client.query(`SELECT schemaname,relname,n_live_tup,n_dead_tup,seq_scan,seq_tup_read,idx_scan,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_user_tables
      WHERE relname=ANY($1::text[]) ORDER BY schemaname,relname`, [['orders', 'kds_ticket_states', 'table_rounds', 'settings', 'pos_cash_movements', 'tenants', 'users']])).rows;
    const snapshot = { ...identity, database, tables };
    if (argument('--compare')) {
      const before = JSON.parse(fs.readFileSync(path.resolve(argument('--compare')), 'utf8'));
      if (before.endpoint_id !== snapshot.endpoint_id) throw new Error('Cannot compare different endpoints');
      const hours = (new Date(snapshot.observed_at) - new Date(before.observed_at)) / 3600000;
      const oldTables = new Map(before.tables.map((row) => [`${row.schemaname}.${row.relname}`, row]));
      snapshot.comparison = { hours, counters_reset: JSON.stringify(before.database.stats_reset) !== JSON.stringify(snapshot.database.stats_reset), tables: tables.map((row) => {
        const key = `${row.schemaname}.${row.relname}`; const old = oldTables.get(key);
        const diff = Object.fromEntries(['seq_scan','seq_tup_read','idx_scan','n_tup_ins','n_tup_upd','n_tup_del'].map((field) => [field, old ? Number(row[field] || 0) - Number(old[field] || 0) : null]));
        return { table: key, ...diff, reset_or_new: !old || Object.values(diff).some((value) => value < 0) };
      }) };
    }
    await client.query('ROLLBACK');
    if (argument('--output')) fs.writeFileSync(path.resolve(argument('--output')), JSON.stringify(snapshot, null, 2));
    const totals = {};
    for (const row of tables) totals[row.relname] = (totals[row.relname] || 0) + Number(row.seq_tup_read);
    console.log(JSON.stringify({ observed_at: snapshot.observed_at, project_id: snapshot.project_id, endpoint_id: snapshot.endpoint_id, seq_rows: totals, comparison_hours: snapshot.comparison?.hours }));
  } finally { await client.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
