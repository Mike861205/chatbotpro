const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const bcrypt = require('bcryptjs');

const routePath = path.join(__dirname, '..', 'src', 'routes', 'costs.js');
const localRequire = createRequire(routePath);
const pinHash = bcrypt.hashSync('1234', 4);
const routes = new Map();
const router = {
  use() {},
  get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
  post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
  put(route, ...handlers) { routes.set(`PUT ${route}`, handlers); },
  delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers); },
};
const context = {
  require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === '../utils/costing') return { ensureCostingSchema: async () => {}, money: (value) => Number(Number(value).toFixed(2)), preciseCost: Number };
    if (name === '../db') return { getSetting: async () => pinHash };
    return localRequire(name);
  },
  module: { exports: {} },
  exports: {},
  console,
};
vm.runInNewContext(fs.readFileSync(routePath, 'utf8'), context, { filename: routePath });

const { requireModules } = localRequire('../middleware/auth');
const cashier = { role: 'cashier', branchId: 7, username: 'caja7', permissions: [] };

function response() {
  return {
    code: 200,
    body: null,
    set() { return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function handle(method, route, req, res) {
  const handlers = routes.get(`${method} ${route}`);
  assert.ok(handlers, `Ruta ${method} ${route} registrada`);
  await handlers.at(-1)(req, res, (error) => { throw error; });
}

test('Gastos permite acceso al cajero sin darle acceso a productos de costo', () => {
  let allowed = false;
  requireModules('gastos')({ user: cashier }, response(), () => { allowed = true; });
  assert.equal(allowed, true);
  const denied = response();
  requireModules('costos')({ user: cashier }, denied, () => {});
  assert.equal(denied.code, 403);
});

test('el historial de cajero fuerza su sucursal en gastos manuales y de POS', async () => {
  const calls = [];
  const req = {
    user: cashier,
    timezone: 'America/Mexico_City',
    query: { from: '2026-10-01', to: '2026-10-31', branch: 'all' },
    tdb: {
      async all(sql, params) {
        calls.push({ sql, params });
        return sql.includes('SELECT id, name, active') ? [{ id: 7, name: 'Auroras', active: 1 }] : [];
      },
    },
  };
  const res = response();
  await handle('GET', '/expenses', req, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.branch, '7');
  assert.equal(res.body.branches.length, 1);
  assert.match(calls[0].sql, /e\.branch_id = \$3/);
  assert.match(calls[0].sql, /ps\.branch_id = \$3/);
  assert.deepEqual(Array.from(calls[0].params), ['2026-10-01', '2026-10-31', 7]);
  assert.deepEqual(Array.from(calls[1].params), [7]);
});

test('un acceso no principal solo recibe gastos, tarjetas y borrados de su sucursal', async () => {
  const res = response();
  await handle('GET', '/expenses', {
    user: { role: 'staff', branchId: 7, username: 'encargado', permissions: ['gastos'] },
    timezone: 'America/Mexico_City', query: { period: 'all', branch: 'all' },
    tdb: { async all(sql) {
      if (sql.includes('SELECT id, name, active')) return [{ id: 7, name: 'Auroras', active: 1 }];
      if (sql.includes('FROM {s}.deleted_expenses')) return [
        { id: 31, branch_id: 7, concept: 'Gas', amount: 30 },
        { id: 32, branch_id: 8, concept: 'Renta', amount: 80 },
      ];
      return [
        { id: 1, branch_id: 7, concept: 'Gas', amount: 100 },
        { id: 2, branch_id: 8, concept: 'Renta', amount: 500 },
      ];
    } },
  }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.branchRestricted, true);
  assert.equal(res.body.branch, '7');
  assert.equal(res.body.globalTotal, 100);
  assert.deepEqual(Array.from(res.body.expenses, (row) => row.id), [1]);
  assert.deepEqual(Array.from(res.body.deletedExpenses, (row) => row.id), [31]);
  assert.deepEqual(Array.from(res.body.branchTotals, (row) => row.id), [7]);
});

test('la búsqueda por concepto o texto filtra gastos, totales y exportación sin cambiar la sucursal del dueño', async () => {
  const res = response();
  await handle('GET', '/expenses', {
    user: { role: 'owner', username: 'dueno' },
    timezone: 'America/Mexico_City', query: { period: 'all', branch: 'all', q: 'energia' },
    tdb: { async all(sql) {
      if (sql.includes('SELECT id, name, active')) return [{ id: 7, name: 'Auroras', active: 1 }, { id: 8, name: 'Lomas', active: 1 }];
      if (sql.includes('FROM {s}.deleted_expenses')) return [];
      return [
        { id: 1, branch_id: 7, concept: 'Energía eléctrica', amount: 100 },
        { id: 2, branch_id: 8, concept: 'Renta', amount: 500 },
      ];
    } },
  }, res);
  assert.equal(res.body.branchRestricted, false);
  assert.equal(res.body.total, 100);
  assert.deepEqual(Array.from(res.body.expenses, (row) => row.id), [1]);
  assert.deepEqual(Array.from(res.body.branchTotals, (row) => row.total), [100, 0]);
});

test('el gasto global y las tarjetas incluyen todas las sucursales del rango, aunque la tabla esté filtrada', async () => {
  const calls = [];
  const req = {
    user: { role: 'owner', username: 'owner', permissions: [] },
    timezone: 'America/Mexico_City',
    query: { from: '2026-10-01', to: '2026-10-31', branch: '7' },
    tdb: { async all(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, name, active')) return [
        { id: 7, name: 'Auroras', active: 1 }, { id: 8, name: 'Lomas', active: 1 },
      ];
      return [
        { id: 1, branch_id: 7, amount: 100 },
        { id: 2, branch_id: 8, amount: 50 },
        { id: 3, branch_id: null, amount: 20 },
      ];
    } },
  };
  const res = response();
  await handle('GET', '/expenses', req, res);
  assert.equal(res.body.globalTotal, 170);
  assert.equal(res.body.generalTotal, 20);
  assert.deepEqual(Array.from(res.body.branchTotals, ({ id, total }) => [id, total]), [[7, 100], [8, 50]]);
  assert.equal(res.body.total, 100);
  assert.deepEqual(Array.from(res.body.expenses, ({ id }) => id), [1]);
  assert.equal(calls[0].params.length, 2);
  assert.doesNotMatch(calls[0].sql, /e\.branch_id = \$3/);
});

test('el historial completo del cajero sigue limitado a su sucursal', async () => {
  const queries = [];
  const res = response();
  await handle('GET', '/expenses', {
    user: cashier, timezone: 'America/Mexico_City', query: { period: 'all', branch: 'all' },
    tdb: { async all(sql, params) {
      if (sql.includes('SELECT id, name, active')) return [{ id: 7, name: 'Auroras', active: 1 }];
      queries.push(sql);
      assert.deepEqual(Array.from(params), [7]);
      return [];
    } },
  }, res);
  assert.equal(res.body.allDates, true);
  assert.match(queries[0], /e\.branch_id = \$1/);
  assert.match(queries[0], /ps\.branch_id = \$1/);
  assert.match(queries[1], /d\.branch_id = \$1/);
});

test('el cajero no puede crear ni eliminar gastos de otra sucursal', async () => {
  const postRes = response();
  await handle('POST', '/expenses', {
    user: cashier,
    body: { branchId: 8, expenseDate: '2026-10-07', concept: 'Renta', amount: 100 },
    tdb: { get() { throw new Error('No debe consultar la base de datos'); } },
  }, postRes);
  assert.equal(postRes.code, 403);

  let deleteSql = '';
  const deleteRes = response();
  await handle('DELETE', '/expenses/:id', {
    user: cashier,
    params: { id: '15' },
    body: { pin: '1234' },
    tdb: { async tx(callback) { return callback({ async get(sql, params) {
      deleteSql = sql;
      assert.deepEqual(Array.from(params), [15, 7]);
      return undefined;
    } }); } },
  }, deleteRes);
  assert.match(deleteSql, /e\.branch_id=\$2/);
  assert.equal(deleteRes.code, 404);
});

test('el NIP del negocio protege el borrado del cajero', async () => {
  let openedTransaction = false;
  const res = response();
  await handle('DELETE', '/expenses/:id', {
    user: cashier, params: { id: '-15' }, body: { pin: '0000' },
    tdb: { async tx() { openedTransaction = true; } },
  }, res);
  assert.equal(res.code, 403);
  assert.equal(openedTransaction, false);
});

test('borrar un gasto POS conserva auditoría y ajusta la caja cerrada vinculada', async () => {
  const statements = [];
  const res = response();
  await handle('DELETE', '/expenses/:id', {
    user: { role: 'owner', username: 'dueno' }, params: { id: '-15' }, body: {}, timezone: 'America/Mexico_City',
    tdb: { async tx(callback) { return callback({
      async get(sql, params) {
        if (sql.includes('FROM {s}.pos_cash_movements')) {
          assert.deepEqual(Array.from(params), [15, 'America/Mexico_City']);
          return { id: 15, branch_id: 7, branch_name: 'Auroras', session_id: 3, expense_date: '2026-10-07', concept: 'Luz', amount: 100, notes: '', created_by: 'caja7', created_at: '2026-10-07' };
        }
        assert.match(sql, /pos_sessions WHERE id=\$1 FOR UPDATE/);
        return { id: 3 };
      },
      async run(sql, params) { statements.push({ sql, params }); return { rowCount: 1 }; },
    }); } },
  }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.match(statements[0].sql, /INSERT INTO \{s\}\.deleted_expenses/);
  assert.deepEqual(Array.from(statements[0].params).slice(0, 5), ['pos', 15, 7, 'Auroras', 3]);
  assert.match(statements[1].sql, /DELETE FROM \{s\}\.pos_cash_movements/);
  assert.match(statements.at(-1).sql, /expected_amount = expected_amount \+ \$2/);
  assert.deepEqual(Array.from(statements.at(-1).params), [3, 100]);
});

test('el cajero registra gastos en su sucursal con el flujo existente', async () => {
  let inserted = false;
  const req = {
    user: cashier,
    body: { branchId: 7, expenseDate: '2026-10-07', concept: 'Renta', amount: 100, notes: 'Caja' },
    tdb: { async get(sql, params) {
      if (sql.includes('FROM {s}.branches')) {
        assert.deepEqual(Array.from(params), [7]);
        return { id: 7, name: 'Auroras' };
      }
      inserted = true;
      assert.match(sql, /INSERT INTO \{s\}\.business_expenses/);
      assert.deepEqual(Array.from(params), [7, 'Auroras', '2026-10-07', 'Renta', 100, 'Caja', 'caja7']);
      return { id: 21 };
    } },
  };
  const res = response();
  await handle('POST', '/expenses', req, res);
  assert.equal(inserted, true);
  assert.equal(res.body.id, 21);
});
