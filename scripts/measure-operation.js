const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const { argument, connectNeon } = require('./neon-connection');

async function main() {
  const envFile = argument('--env');
  const baseUrl = argument('--url');
  if (!envFile || !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(baseUrl)) throw new Error('Specify --env and a localhost --url');
  const root = path.resolve(__dirname, '..');
  const env = { ...dotenv.parse(fs.readFileSync(path.join(root, '.env'))), ...dotenv.parse(fs.readFileSync(path.resolve(root, envFile))) };
  const client = await connectNeon(envFile, 'chatbotpro_operation_measurement');
  const results = [];
  try {
    const slugs = argument('--tenants', 'el-pollo-loco,golosinas-axel,asadero-la-joya').split(',');
    const owners = (await client.query(`SELECT DISTINCT ON(t.slug) t.id AS tid,t.slug,u.id AS uid,u.username FROM public.tenants t JOIN public.users u ON u.tenant_id=t.id
      WHERE t.slug=ANY($1::text[]) AND u.role='owner' AND u.active=1 ORDER BY t.slug,u.id`, [slugs])).rows;
    if (owners.length !== slugs.length) throw new Error('An active tenant owner was not found');
    for (const owner of owners) {
      // Read-only support session; no token or response data is logged.
      const token = jwt.sign({ uid: owner.uid, tid: owner.tid, slug: owner.slug, username: owner.username, typ: 'owner', imp: true }, env.JWT_SECRET, { expiresIn: '5m', issuer: 'chatbotpro', audience: 'cbp:owner' });
      for (const route of ['/api/dashboard/stats?period=day', '/api/orders?todayOnly=1&limit=50', '/api/pos/overview']) {
        const samples = [];
        for (let i = 0; i < 4; i++) {
          const started = performance.now();
          const response = await fetch(baseUrl + route, { headers: { Cookie: `cbp_owner_token=${token}`, 'x-cbp-auth-scope': 'owner' }, signal: AbortSignal.timeout(20000) });
          const text = await response.text();
          if (!response.ok) throw new Error(`Unexpected status ${response.status} for ${owner.slug} ${route}`);
          JSON.parse(text);
          samples.push(+(performance.now() - started).toFixed(2));
        }
        const result = { tenant: owner.slug, route, samples_ms: samples, first_ms: samples[0], warm_max_ms: Math.max(...samples.slice(1)), warm_mean_ms: +(samples.slice(1).reduce((sum, ms) => sum + ms, 0) / 3).toFixed(2) };
        results.push(result); console.log(JSON.stringify(result));
      }
    }
    if (argument('--output')) fs.writeFileSync(path.resolve(argument('--output')), JSON.stringify({ observed_at: new Date().toISOString(), url: baseUrl, results }, null, 2));
  } finally { await client.end(); }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
