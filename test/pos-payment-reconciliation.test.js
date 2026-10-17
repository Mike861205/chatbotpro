const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes/pos');

const handler = router.stack.find((layer) => layer.route?.path === '/payment-reconciliation/:method').route.stack.at(-1).handle;

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, set() { return this; }, json(body) { this.body = body; return this; } };
}

test('conciliación de tarjetas separa débito, crédito y pagos mixtos con importes del turno', async () => {
  const res = response();
  const queries = [];
  await handler({
    params: { method: 'card' }, user: { role: 'cashier', username: 'caja7', branchId: 7 },
    tdb: {
      timezone: 'America/Mexico_City',
      async get() { return { id: 20, branch_id: 7, branch_name: 'Auroras' }; },
      async all(sql, params) {
        queries.push({ sql, params });
        return [
          { id: 1, invoice_code: 'POS-1', payment_method: 'card', payment_breakdown: JSON.stringify({ cardType: 'debit' }), effective_total: 120, paid_at: '17 Oct 2026, 10:00' },
          { id: 2, invoice_code: 'POS-2', payment_method: 'mixed', payment_breakdown: JSON.stringify({ card: 40, cash: 60, cardType: 'credit' }), effective_total: 100, paid_at: '17 Oct 2026, 10:15' },
          { id: 3, invoice_code: 'POS-3', payment_method: 'transfer', payment_breakdown: '{}', effective_total: 80, paid_at: '17 Oct 2026, 10:30' },
        ];
      },
    },
  }, res, (error) => { throw error; });
  assert.equal(res.code, 200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.total, 160);
  assert.deepEqual(Array.from(res.body.groups, (group) => [group.type, group.count, group.total]), [
    ['debit', 1, 120], ['credit', 1, 40], ['unknown', 0, 0],
  ]);
  assert.equal(res.body.transactions[1].mixed, true);
  assert.match(queries[0].sql, /credit_paid_session_id=\$1/);
  assert.deepEqual(queries[0].params, [20]);
});

test('conciliación de transferencias suma solo los importes de transferencia', async () => {
  const res = response();
  await handler({
    params: { method: 'transfer' }, user: { role: 'owner', username: 'dueno' }, get() { return ''; },
    tdb: {
      async get() { return { id: 21, branch_name: 'Auroras' }; },
      async all() { return [
        { id: 1, payment_method: 'transfer', payment_breakdown: '{}', effective_total: 70 },
        { id: 2, payment_method: 'mixed', payment_breakdown: JSON.stringify({ card: 20, transfer: 30 }), effective_total: 50 },
      ]; },
    },
  }, res, (error) => { throw error; });
  assert.equal(res.body.count, 2);
  assert.equal(res.body.total, 100);
  assert.equal(res.body.groups.length, 0);
});

test('conciliación de un medio local conserva nombre, cantidad y total', async () => {
  const res = response();
  await handler({
    params: { method: 'custom_vales' }, user: { role: 'cashier', username: 'caja7', branchId: 7 },
    tdb: {
      async get(sql) {
        if (sql.includes('FROM {s}.settings')) return { value: JSON.stringify([{ id: 'custom_vales', label: 'Vales locales' }]) };
        return { id: 22, branch_name: 'Auroras' };
      },
      async all() { return [{ id: 5, payment_method: 'custom_vales', payment_breakdown: '{}', effective_total: 95 }]; },
    },
  }, res, (error) => { throw error; });
  assert.equal(res.body.label, 'Vales locales');
  assert.equal(res.body.count, 1);
  assert.equal(res.body.total, 95);
});
