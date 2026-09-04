const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const pos = read('src', 'routes', 'pos.js');
const app = read('public', 'js', 'app.js');

test('el propietario puede seleccionar una caja abierta por sucursal', () => {
  assert.match(pos, /x-cbp-pos-branch-id/);
  assert.match(pos, /function selectedOwnerPosBranchId\(req\)/);
  assert.match(pos, /req\.user\?\.role === 'cashier'/);
  assert.match(pos, /openSessions: allOpenSessions/);
  assert.match(pos, /SELECT id, branch_id, branch_name, opened_by,[\s\S]+WHERE status = 'open'/);
  assert.match(pos, /ORDER BY ps\.opened_at DESC/);
  assert.match(pos, /ORDER BY ps\.closed_at DESC NULLS LAST LIMIT 1/);
});

test('el navegador conserva la caja administrada solo durante la pestaña', () => {
  assert.match(app, /sessionStorage\.setItem\(posManagedBranchStorageKey\(\), String\(value\)\)/);
  assert.match(app, /headers\.set\('x-cbp-pos-branch-id', String\(managedBranchId\)\)/);
  assert.match(app, /data-manage-pos-branch/);
  assert.match(app, /id="posManagedBranchSelect"/);
  assert.match(app, /setManagedPosBranchId\(null\)[\s\S]+Caja cerrada/);
});

test('el cajero continúa limitado a su sucursal asignada', () => {
  assert.match(pos, /const cashierBranchId = user\?\.role === 'cashier' \? Number\(user\?\.branchId \|\| 0\) : null/);
  assert.match(pos, /forBranchId: cashierBranchId \|\| selectedBranchId \|\| null/);
});

test('las sucursales sin liga muestran la acción para crear su acceso de cajero', () => {
  assert.match(app, /const missingBranches = branches\.filter/);
  assert.match(app, /data-create-cashier-branch/);
  assert.match(app, /Sin cajero asignado/);
  assert.match(app, /openCashierModal\(null, Number\(button\.dataset\.createCashierBranch\)\)/);
});
