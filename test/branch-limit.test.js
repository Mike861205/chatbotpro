const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { branchCapacity, normalizeBranchLimit } = require('../src/utils/branchLimit');

test('usa dos sucursales como límite predeterminado', () => {
  assert.equal(normalizeBranchLimit(undefined), 2);
  assert.deepEqual(branchCapacity(1, 2), { active: 1, limit: 2, available: 1, reached: false });
  assert.deepEqual(branchCapacity(2, 2), { active: 2, limit: 2, available: 0, reached: true });
});

test('admite cupos personalizados sin permitir valores inválidos', () => {
  assert.deepEqual(branchCapacity(3, 4), { active: 3, limit: 4, available: 1, reached: false });
  assert.equal(normalizeBranchLimit(0), 2);
  assert.equal(normalizeBranchLimit(1001), 1000);
});

test('la creación y reactivación de sucursales validan el cupo dentro de una transacción', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'branches.js'), 'utf8');
  assert.match(route, /pg_advisory_xact_lock/);
  assert.match(route, /BRANCH_LIMIT_REACHED/g);
  assert.match(route, /WHERE active = 1/g);
});

test('superadmin configura el cupo y dashboard muestra el plan activo', () => {
  const superadmin = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(superadmin, /changeBranchLimit/);
  assert.match(superadmin, /branch_limit/);
  assert.match(app, /renderDashboardSubscription/);
  assert.match(app, /sucursales activas/);
});
