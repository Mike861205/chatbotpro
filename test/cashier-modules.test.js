const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const orders = read('src', 'routes', 'orders.js');
const pos = read('src', 'routes', 'pos.js');
const app = read('public', 'js', 'app.js');

test('el cajero tiene acceso a pedidos, cancelaciones y cortes con aislamiento de sucursal', () => {
  // Backend orders
  assert.match(orders, /req\.user\?\.role === 'cashier'/);
  assert.match(orders, /COALESCE\(service_branch_id, pickup_branch_id\) =/);
  assert.doesNotMatch(orders, /router\.use\(requireOwner\)/);

  // Backend audit-log and cuts
  assert.match(pos, /router\.get\('\/audit-log', async/);
  assert.match(pos, /router\.get\('\/cuts', async/);
  assert.match(pos, /const isCashier = req\.user\?\.role === 'cashier'/);

  // Frontend allowed views & scoping
  assert.match(app, /CASHIER_ALLOWED_VIEWS = new Set\(\['pos', 'pedidos', 'cancelaciones', 'cortes'\]\)/);
  assert.match(app, /if \(isCashierUser\(\)\) \{\s*return CASHIER_ALLOWED_VIEWS\.has\(view\) \? view : 'pos';\s*\}/);
  assert.match(app, /AUDIT_BRANCH = ME\?\.branchId \? String\(ME\.branchId\) : 'general'/);
  assert.match(app, /CUTS_BRANCH = ME\?\.branchId \? String\(ME\.branchId\) : 'general'/);
});
