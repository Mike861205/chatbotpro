const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { argument, connectNeon } = require('./neon-connection');
const { localDateBoundary, localDayRange } = require('../src/utils/queryDates');

async function main() {
  const envFile = argument('--env');
  if (!envFile) throw new Error('Specify --env explicitly');
  process.env.ENV_FILE = envFile;
  const root = path.resolve(__dirname, '..');
  const revision = argument('--revision', 'd237dd8');
  if (!/^[a-zA-Z0-9._/-]+$/.test(revision)) throw new Error('Invalid revision');
  const client = await connectNeon(envFile, 'chatbotpro_compute_validation');
  const results = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='5s'");
    let calls = 0; let returnedRows = 0;
    let queue = Promise.resolve();
    const query = (sql, params) => {
      calls++;
      // A physical pg.Client executes one statement at a time.
      const result = queue.then(() => client.query(sql, params)).then((value) => { returnedRows += value.rows.length; return value; });
      queue = result.catch(() => {});
      return result;
    };
    const scoped = (slug) => {
      const schema = 't_' + slug.replace(/[^a-z0-9]/g, '_');
      const fix = (sql) => sql.replaceAll('{s}', `"${schema}"`);
      return { schema, inTransaction: true,
        all: async (sql, params) => (await query(fix(sql), params)).rows,
        get: async (sql, params) => (await query(fix(sql), params)).rows[0],
        run: async () => { throw new Error('Validation must never write'); },
      };
    };
    const db = { q: query, tdb: scoped, getSetting: async (t, key, fallback = '') => {
      const row = await t.get('SELECT value FROM {s}.settings WHERE key=$1', [key]);
      return row ? row.value : fallback;
    } };
    function loadRoute(name, original) {
      const relative = `src/routes/${name}.js`;
      const filename = path.join(root, relative);
      const source = original ? execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(filename, 'utf8');
      const loaded = new Module(filename, module);
      loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
      const normalRequire = loaded.require.bind(loaded);
      loaded.require = (id) => id === '../db' ? db : normalRequire(id);
      loaded._compile(source, filename);
      return loaded.exports;
    }
    const routes = Object.fromEntries(['orders', 'dashboard', 'kds', 'pos'].map((name) => [name, [loadRoute(name, true), loadRoute(name, false)]]));
    async function invoke(router, routePath, req) {
      const handler = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.get)?.route.stack.at(-1).handle;
      if (!handler) throw new Error(`Route missing: ${routePath}`);
      let body;
      const startCalls = calls; const startRows = returnedRows; const start = performance.now();
      await handler(req, { json(value) { body = value; return this; }, status() { return this; } }, (error) => { throw error; });
      return { body, calls: calls - startCalls, returnedRows: returnedRows - startRows, ms: +(performance.now() - start).toFixed(2) };
    }
    function normalized(body, route) {
      const value = JSON.parse(JSON.stringify(body));
      if (route === 'kds') { delete value.serverTime; value.tickets.sort((a, b) => a.id - b.id); }
      if (route === 'dashboard') { delete value.period.whereSql; delete value.period.seriesSql; value.byStatus.sort((a, b) => String(a.status).localeCompare(String(b.status))); }
      return value;
    }
    async function compare(name, routePath, req, label) {
      const old = await invoke(routes[name][0], routePath, req);
      const fresh = await invoke(routes[name][1], routePath, req);
      const oldBody = normalized(old.body, name); const newBody = normalized(fresh.body, name);
      if (!isDeepStrictEqual(oldBody, newBody)) {
        const differences = [];
        function inspect(a, b, location = '') {
          if (isDeepStrictEqual(a, b) || differences.length >= 10) return;
          if (a && b && typeof a === 'object' && typeof b === 'object') {
            if (Array.isArray(a) && a.length !== b.length) differences.push({ location: location + '.length', before: a.length, after: b.length });
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) inspect(a[key], b[key], `${location}.${key}`);
          } else differences.push({ location, before: typeof a === 'number' ? a : typeof a, after: typeof b === 'number' ? b : typeof b });
        }
        inspect(oldBody, newBody);
        throw new Error(`Results differ: ${req.tenant?.slug || req.params?.slug} ${name} ${label} ${JSON.stringify(differences)}`);
      }
      const result = { tenant: req.tenant?.slug || req.params?.slug, route: name, case: label, matched: true, old_calls: old.calls, new_calls: fresh.calls, old_rows: old.returnedRows, new_rows: fresh.returnedRows, old_ms: old.ms, new_ms: fresh.ms };
      results.push(result); console.log(JSON.stringify(result));
    }
    const slugs = argument('--tenants', 'el-pollo-loco,golosinas-axel,asadero-la-joya').split(',');
    const tenants = (await client.query('SELECT * FROM public.tenants WHERE slug=ANY($1::text[]) ORDER BY slug', [slugs])).rows;
    if (tenants.length !== new Set(slugs).size) throw new Error('Some tenants were not found');
    for (const tenant of tenants) {
      const tdb = scoped(tenant.slug); tdb.timezone = tenant.timezone;
      const base = { tenant, tdb, timezone: tenant.timezone, user: { role: 'owner' }, get() { return ''; } };
      for (const query of process.argv.includes('--kds-only') ? [] : [{ todayOnly: '1' }, { todayOnly: '1', status: 'pendiente' }, { startDate: '2026-01-01', endDate: '2026-11-25' }, { scheduled: 'upcoming' }, { limit: '5' }, { todayOnly: '1', branchId: 'none' }]) {
        await compare('orders', '/', { ...base, query }, JSON.stringify(query));
      }
      for (const period of process.argv.includes('--kds-only') ? [] : ['day', 'week', 'month', 'year']) await compare('dashboard', '/stats', { ...base, query: { period } }, period);
      if (!process.argv.includes('--kds-only')) await compare('pos', '/overview', { ...base, query: {} }, 'overview');
      const areas = await tdb.all('SELECT id,access_token FROM {s}.kds_areas WHERE active=1 ORDER BY id');
      for (const area of areas) await compare('kds', '/public/:slug/:token', { params: { slug: tenant.slug, token: area.access_token } }, `area ${area.id}`);
    }
    // Exercise the actual SQL at day boundaries, including 23/25-hour DST days.
    for (const [zone, day, hours] of [['America/New_York', '2026-03-08', 23], ['America/New_York', '2026-11-01', 25], ['America/Hermosillo', '2026-11-25', 24], ['America/Tegucigalpa', '2026-11-25', 24]]) {
      const bounds = (await client.query(`SELECT ${localDateBoundary('$2::date', '$1::text')} AS lo, ${localDateBoundary('$2::date', '$1::text', 1)} AS hi`, [zone, day])).rows[0];
      if ((bounds.hi - bounds.lo) / 3600000 !== hours) throw new Error('Incorrect local day length');
      const stamps = [-1, 0, 1, bounds.hi - bounds.lo - 1, bounds.hi - bounds.lo].map((offset) => new Date(+bounds.lo + offset).toISOString());
      const rows = (await client.query(`SELECT ts, (ts AT TIME ZONE $1)::date=$2::date AS original, (${localDayRange('ts', '$1::text', '$2::date')}) AS optimized FROM unnest($3::timestamptz[]) ts`, [zone, day, stamps])).rows;
      if (rows.some((row) => row.original !== row.optimized)) throw new Error('Date boundary mismatch');
      results.push({ case: 'local-day-boundaries', zone, day, hours, matched: true });
    }
    await client.query('ROLLBACK');
    if (argument('--output')) fs.writeFileSync(path.resolve(argument('--output')), JSON.stringify({ observed_at: new Date().toISOString(), revision, results }, null, 2));
    console.log(JSON.stringify({ matched: results.length, status: 'passed' }));
  } finally {
    await client.end();
    // Importing route dependencies creates an unused application pool.
    const databasePath = require.resolve('../src/db');
    if (require.cache[databasePath]) await require.cache[databasePath].exports.pool.end();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
