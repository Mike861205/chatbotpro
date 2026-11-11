const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/routes/pos');
const { isPayrollCategoryName, releaseAdvance, pendingAdvanceAdjustments } = require('../src/utils/payrollAdvances');
const { computePayrollItem } = require('../src/utils/timeClock');

const movementHandler = router.stack.find((layer) => layer.route?.path === '/movements' && layer.route.methods.post).route.stack.at(-1).handle;

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, set() { return this; } };
}

test('detecta categorías de nómina sin importar mayúsculas ni acentos', () => {
  for (const name of ['NOMINA', 'Nomina', 'Nómina', 'nóminas', 'NOMINA ADELANTOS']) assert.equal(isPayrollCategoryName(name), true, name);
  for (const name of ['Renta', 'PAN PERLA', 'Antinomina', '']) assert.equal(isPayrollCategoryName(name), false, name);
});

function posMock({ employees, category = { id: 5, name: 'NOMINA' } }) {
  const inserted = [];
  const advances = [];
  const exec = {
    async get(sql, params) {
      if (sql.includes('FROM {s}.pos_sessions')) return { id: 11, opening_amount: 100, branch_id: 7, branch_name: 'Centro' };
      if (sql.includes('FROM {s}.expense_categories')) return category;
      if (sql.includes('INSERT INTO {s}.pos_cash_movements')) { inserted.push(params); return { id: 99 }; }
      return {};
    },
    async all(sql) { return sql.includes('FROM {s}.employees') ? employees : []; },
    async run(sql, params) { if (sql.includes('payroll_advances')) advances.push(params); return { rowCount: 1 }; },
  };
  return { tdb: { ...exec, async tx(fn) { return fn(exec); } }, inserted, advances };
}

const employees = [{ id: 3, name: 'Juan Pérez', emp_code: '0003', branch_id: 7, branch_name: 'Centro' }];

test('un gasto de nómina en caja exige elegir al empleado', async () => {
  const { tdb, inserted } = posMock({ employees });
  for (const employeeId of [undefined, 999]) {
    const res = response();
    await movementHandler({ user: { role: 'cashier', branchId: 7, username: 'caja7' }, tdb, body: { kind: 'expense', amount: 500, categoryId: 5, employeeId } }, res, (error) => { throw error; });
    assert.equal(res.code, 400);
    assert.match(res.body.error, /empleado/);
  }
  assert.equal(inserted.length, 0);
});

test('un gasto de nómina en caja registra el adelanto del empleado', async () => {
  const { tdb, inserted, advances } = posMock({ employees });
  const res = response();
  await movementHandler({ user: { role: 'cashier', branchId: 7, username: 'caja7' }, tdb, body: { kind: 'expense', amount: 500, categoryId: 5, employeeId: 3, note: 'Primer pago' } }, res, (error) => { throw error; });
  assert.equal(res.code, 200);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0][3], /Primer pago/);
  assert.match(inserted[0][3], /Juan Pérez/);
  assert.equal(advances.length, 1);
  assert.deepEqual([advances[0][0], advances[0][2], advances[0][5], advances[0][7], advances[0][8]], [3, 500, 7, 'pos', 99]);
});

test('si el negocio no tiene empleados en el checador el gasto de nómina funciona como gasto normal', async () => {
  const { tdb, inserted, advances } = posMock({ employees: [] });
  const res = response();
  await movementHandler({ user: { role: 'cashier', branchId: 7, username: 'caja7' }, tdb, body: { kind: 'expense', amount: 200, categoryId: 5, note: 'Pago' } }, res, (error) => { throw error; });
  assert.equal(res.code, 200);
  assert.equal(inserted.length, 1);
  assert.equal(advances.length, 0);
});

test('un gasto de otra categoría no pide empleado', async () => {
  const { tdb, inserted, advances } = posMock({ employees, category: { id: 6, name: 'COCA COLA' } });
  const res = response();
  await movementHandler({ user: { role: 'cashier', branchId: 7, username: 'caja7' }, tdb, body: { kind: 'expense', amount: 80, categoryId: 6, note: 'Refrescos' } }, res, (error) => { throw error; });
  assert.equal(res.code, 200);
  assert.equal(inserted.length, 1);
  assert.equal(advances.length, 0);
});

test('no se puede borrar el gasto de un adelanto ya descontado en una nómina', async () => {
  const applied = { async get() { return { id: 1, period_id: 4, period_name: 'Nómina quincena' }; }, async run() { throw new Error('no debe borrar'); } };
  await assert.rejects(() => releaseAdvance(applied, 'pos', 99), (error) => error.statusCode === 409 && /Nómina quincena/.test(error.message));
  const calls = [];
  const pending = { async get() { return { id: 1, period_id: null }; }, async run(sql, params) { calls.push(params); } };
  await releaseAdvance(pending, 'pos', 99);
  assert.deepEqual(calls, [[1]]);
  await releaseAdvance({ async get() { return undefined; }, async run() { throw new Error('nada que borrar'); } }, 'manual', 5);
});

test('los adelantos pendientes se agrupan por empleado y restan del neto', async () => {
  const map = await pendingAdvanceAdjustments({ async all() {
    return [{ id: 1, employee_id: 3, amount: 500, day: '03/11/2026', note: 'Primer pago' }, { id: 2, employee_id: 3, amount: 300, day: '05/11/2026', note: '' }];
  } }, '2026-11-15');
  const adjustments = map.get(3);
  assert.equal(adjustments.length, 2);
  assert.ok(adjustments.every((item) => item.kind === 'deduction' && item.advance_id));
  const totals = { absent_days: 0, worked_days: 10, regular_minutes: 0, double_overtime_minutes: 0, triple_overtime_minutes: 0, late_minutes: 0, late_count: 0, worked_minutes: 0, expected_minutes: 0, overtime_minutes: 0, scheduled_days: 10, rest_days: 0, open_shifts: 0, early_leave_minutes: 0 };
  const row = { employee: { id: 3, name: 'Juan', pay_type: 'monthly', pay_rate: 3000 }, totals, days: [] };
  const withAdvances = computePayrollItem({ row, config: {}, from: '2026-11-01', to: '2026-11-15', adjustments });
  const without = computePayrollItem({ row, config: {}, from: '2026-11-01', to: '2026-11-15', adjustments: [] });
  assert.equal(withAdvances.other_deductions, 800);
  assert.equal(without.net_pay - withAdvances.net_pay, 800);
});
