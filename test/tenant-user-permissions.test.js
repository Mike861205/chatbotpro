const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const db = read('src', 'db', 'index.js');
const users = read('src', 'routes', 'users.js');
const auth = read('src', 'middleware', 'auth.js');
const html = read('public', 'app.html');
const app = read('public', 'js', 'app.js');

test('el tenant crea usuarios internos con puesto, contraseña y módulos normalizados', () => {
  assert.match(db, /job_title TEXT DEFAULT/);
  assert.match(db, /permissions_json TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(users, /role='staff'/);
  assert.match(users, /bcrypt\.hash\(password, 12\)/);
  assert.match(users, /normalizeModules\(body\.permissions\)/);
});

test('los permisos se validan también en backend y no sólo en el menú', () => {
  assert.match(auth, /function requireModules/);
  assert.match(auth, /req\.user\.permissions\.includes\(key\)/);
  for (const file of ['dashboard.js', 'orders.js', 'pos.js', 'products.js', 'sales.js', 'inventory.js']) {
    assert.match(read('src', 'routes', file), /router\.use\(requireModules\(/, `${file} debe validar módulos`);
  }
});

test('Mi negocio ordena usuarios, permisos y visibilidad del panel', () => {
  const business = html.slice(html.indexOf('id="view-config"'));
  assert.match(business, /Usuarios y permisos/);
  assert.match(business, /id="internalUserPermissions"/);
  assert.match(business, /Módulos visibles en mi panel/);
  assert.match(app, /ME\?\.role === 'staff' && !permissions\.has\(view\)/);
  assert.match(app, /hiddenModules/);
});

test('el menú del usuario oculta títulos de grupos que no contienen módulos permitidos', () => {
  assert.match(app, /let hasVisibleModule = false/);
  assert.match(app, /while \(sibling && !sibling\.classList\.contains\('nav-label'\)\)/);
  assert.match(app, /lbl\.hidden = !hasVisibleModule/);
  assert.match(app, /staffMode && permissions\.has\('pedidos'\)/);
});
