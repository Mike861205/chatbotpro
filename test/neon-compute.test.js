const test = require('node:test');
const assert = require('node:assert/strict');
const { getSettings } = require('../src/utils/settings');
const { createSingleFlight } = require('../src/utils/singleFlight');
const { createVersionedRead } = require('../src/utils/versionedRead');
const { migrateTenantSchemas } = require('../src/utils/schemaMigrations');
const orders = require('../src/routes/orders');
const { encrypt } = require('../src/utils/crypto');

test('grouped settings preserve empty/null/zero values and per-tenant defaults without stale reads', async () => {
  let calls = 0;
  const a = { async all(_sql, [keys]) { calls++; assert.deepEqual(keys, ['enabled', 'name', 'nullable', 'missing']); return [{ key: 'enabled', value: '0' }, { key: 'name', value: '' }, { key: 'nullable', value: null }]; } };
  const defaults = { enabled: '1', name: 'Fallback', nullable: 'Fallback', missing: 'New tenant' };
  assert.deepEqual(await getSettings(a, defaults), { enabled: '0', name: '', nullable: null, missing: 'New tenant' });
  assert.equal(calls, 1);
  const b = { async all() { return [{ key: 'name', value: 'Other tenant' }]; } };
  assert.equal((await getSettings(b, defaults)).name, 'Other tenant');
  a.all = async () => [{ key: 'name', value: 'Changed immediately' }];
  assert.equal((await getSettings(a, defaults)).name, 'Changed immediately');
  assert.equal(defaults.name, 'Fallback');
});

test('concurrent reads share only in-flight work and retry after a failure', async () => {
  const share = createSingleFlight();
  let finish;
  let calls = 0;
  const first = share('tenant-a/area-1', () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const second = share('tenant-a/area-1', () => { throw new Error('duplicate work'); });
  assert.equal(first, second);
  assert.equal(await share('tenant-b/area-1', () => 'other'), 'other');
  await Promise.resolve(); finish('board');
  assert.equal(await second, 'board');
  assert.equal(calls, 1);
  assert.equal(await share('tenant-a/area-1', () => 'fresh'), 'fresh');
  await assert.rejects(share('failed', () => { throw new Error('unavailable'); }), /unavailable/);
  assert.equal(await share('failed', () => 'recovered'), 'recovered');
});

test('sales ranking refreshes on PostgreSQL snapshot changes, isolates tenants, and protects cached values', async () => {
  const read = createVersionedRead();
  let version = '10:20:12'; let calls = 0;
  const a = { schema: 't_a', async get() { return { version }; } };
  const b = { ...a, schema: 't_b' };
  const loader = async () => [{ product_id: 7, sold_qty: ++calls }];
  const first = await read(a, 'sales', loader); first[0].sold_qty = 999;
  assert.equal((await read(a, 'sales', loader))[0].sold_qty, 1);
  assert.equal((await read(b, 'sales', loader))[0].sold_qty, 2);
  // The same xmax with a committed formerly in-progress writer must invalidate.
  version = '10:20:';
  assert.equal((await read(a, 'sales', loader))[0].sold_qty, 3);
  version = '10:21:';
  assert.equal((await read(a, 'sales', loader))[0].sold_qty, 4);
});

test('sales ranking does not cache a transaction that may see its own writes', async () => {
  const read = createVersionedRead(); let rows = 1;
  const tx = { schema: 't_a', inTransaction: true, get() { throw new Error('snapshot is insufficient for own writes'); } };
  assert.equal(await read(tx, 'sales', async () => rows), 1);
  rows = 2;
  assert.equal(await read(tx, 'sales', async () => rows), 2);
});

test('schema migrations skip unchanged prospects and never mark a failed migration complete', async () => {
  const writes = [];
  const query = async (sql, params) => {
    if (sql.startsWith('SELECT')) return { rows: [{ schema_name: 't_prospect', version: 'v1' }] };
    if (sql.startsWith('INSERT')) writes.push(params);
    return { rows: [] };
  };
  const tenants = [{ slug: 'prospect' }, { slug: 'active' }];
  const versionFor = (t) => ({ schema: `t_${t.slug}`, version: 'v1' });
  const visited = [];
  assert.deepEqual(await migrateTenantSchemas(query, tenants, versionFor, async (t) => visited.push(t.slug)), { migrated: 1, skipped: 1 });
  assert.deepEqual(visited, ['active']);
  assert.deepEqual(writes, [['t_active', 'v1']]);
  writes.length = 0;
  await assert.rejects(migrateTenantSchemas(query, [{ slug: 'active' }], versionFor, async () => { throw new Error('migration failed'); }), /migration failed/);
  assert.deepEqual(writes, []);
});

test('order listing loads each customer in a batch and preserves addresses, decryption and missing customers', async () => {
  const handler = orders.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.get).route.stack.at(-1).handle;
  const queries = [];
  const customer = { id: 5, name_enc: encrypt('Ana'), phone_enc: encrypt('6141234567'), address_enc: encrypt('Saved address') };
  const row = { id: 1, customer_id: 5, items: '[{"name":"Pollo","qty":1}]', total: '100.00', subtotal: '90.00', delivery_fee: '10.00', channel: 'chatbot', notes: 'Delivery reference', payment_breakdown: '{invalid' };
  const t = {
    get() { throw new Error('per-customer lookups must not run'); },
    async all(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM {s}.customers')) { assert.deepEqual(params, [[5, 99]]); return [customer]; }
      return [row, { ...row, id: 2, delivery_address: 'Order address' }, { ...row, id: 3, customer_id: null }, { ...row, id: 4, customer_id: 99 }];
    },
  };
  let body;
  await handler({ query: { todayOnly: '1' }, user: { role: 'cashier', branchId: 7 }, timezone: 'America/Hermosillo', tdb: t }, { json(value) { body = value; } }, (error) => { throw error; });
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /COALESCE\(service_branch_id, pickup_branch_id\) = \$1/);
  assert.equal(body[0].customer.name, 'Ana');
  assert.equal(body[0].delivery_address, 'Saved address');
  assert.equal(body[1].delivery_address, 'Order address');
  assert.equal(body[2].customer, null);
  assert.equal(body[3].customer, null);
  assert.equal(body[0].payment_breakdown, null);
  assert.equal(body[0].total, 100);
  assert.equal(body[0].delivery_reference, 'Delivery reference');
});
