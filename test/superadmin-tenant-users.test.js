const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('SuperAdmin permite ver y recuperar el acceso de usuarios de un tenant', () => {
  const route = read('src', 'routes', 'superadmin.js');
  const html = read('public', 'superadmin.html');
  const client = read('public', 'js', 'superadmin.js');

  assert.match(route, /router\.get\('\/tenants\/:id\/users', requireSuperAdmin/);
  assert.match(route, /router\.patch\('\/tenants\/:tenantId\/users\/:userId', requireSuperAdmin/);
  assert.match(route, /SELECT id, username, role, display_name, job_title, branch_id, cashier_slug, active, created_at/);
  assert.doesNotMatch(route, /SELECT id, username, password_hash, role/);
  assert.match(route, /req\.body\.newPassword/);
  assert.match(route, /req\.body\.active/);
  assert.match(html, /id="saUsersModal"/);
  assert.match(client, /data-sa-users/);
  assert.match(client, /Restablecer clave/);
  assert.match(client, /Desbloquear/);
});