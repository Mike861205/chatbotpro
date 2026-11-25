const { argument, connectNeon } = require('./neon-connection');
const { PERFORMANCE_INDEXES, indexStatement } = require('../src/utils/performanceIndexes');

async function main() {
  const envFile = argument('--env');
  const slugs = argument('--tenants').split(',').filter(Boolean);
  if (!envFile || !slugs.length || slugs.some((slug) => !/^[a-z0-9-]{3,40}$/.test(slug))) {
    throw new Error('Usage: node scripts/optimize-neon-indexes.js --env .env.production --tenants slug1,slug2 [--project id] [--apply]');
  }
  const client = await connectNeon(envFile, 'chatbotpro_compute_indexes');
  try {
    const project = (await client.query("SELECT current_setting('neon.project_id',true) AS id")).rows[0].id;
    if (argument('--project') && project !== argument('--project')) throw new Error('Project does not match');
    await client.query("SET lock_timeout='2s'");
    await client.query("SET statement_timeout='2min'");
    const tenants = (await client.query('SELECT slug FROM public.tenants WHERE slug=ANY($1::text[]) ORDER BY slug', [slugs])).rows;
    if (tenants.length !== new Set(slugs).size) throw new Error('Some tenants were not found');
    for (const { slug } of tenants) {
      const schema = 't_' + slug.replace(/[^a-z0-9]/g, '_');
      for (const definition of PERFORMANCE_INDEXES) {
        const existing = (await client.query(
          'SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2',
          [schema, definition[0]]
        )).rows[0];
        if (existing && !existing.indisvalid) throw new Error(`Invalid index requires review: ${schema}.${definition[0]}`);
        const sql = indexStatement(schema, definition, true);
        if (!process.argv.includes('--apply')) { console.log(sql + ';'); continue; }
        if (existing) { console.log(JSON.stringify({ schema, index: definition[0], status: 'exists' })); continue; }
        const started = Date.now();
        await client.query(sql);
        const valid = (await client.query('SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid=to_regclass($1)', [`${schema}.${definition[0]}`])).rows[0]?.indisvalid;
        if (!valid) throw new Error(`Index was not validated: ${schema}.${definition[0]}`);
        console.log(JSON.stringify({ schema, index: definition[0], status: 'created', elapsed_ms: Date.now() - started }));
      }
    }
  } finally { await client.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
