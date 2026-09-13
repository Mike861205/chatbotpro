const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('el usuario es único dentro de cada negocio y la migración protege los datos existentes', () => {
  const db = read('src/db/index.js');
  assert.match(db, /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_username_unique ON users \(tenant_id, lower\(username\)\)/);
  assert.ok(db.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_username_unique') < db.indexOf('DROP CONSTRAINT IF EXISTS users_username_key'));
  assert.doesNotMatch(db.match(/CREATE TABLE IF NOT EXISTS users \([\s\S]*?\);/)[0], /username TEXT UNIQUE/);
  for (const name of ['src/routes/users.js', 'src/routes/cashiers.js']) {
    assert.match(read(name), /tenant_id\s*=\s*\$1 AND lower\(username\)\s*=\s*\$2/);
  }
});

test('el registro reserva una liga disponible y no rechaza usuarios de otros negocios', () => {
  const auth = read('src/routes/auth.js');
  assert.match(auth, /availableRegistrationSlug\(cleanSlug\)/);
  assert.match(auth, /initTenantDefaults\(availableSlug, cleanBusinessName, regional, tenant\.id\)/);
  assert.doesNotMatch(auth, /user_exists/);
  assert.match(read('public/register.html'), /CBPAuthRequest\.fetch\('\/api\/auth\/register-ready'/);
  assert.match(read('public/register.html'), /const res = await CBPAuthRequest\.fetch\('\/api\/auth\/register'/);
  assert.match(auth, /resumed: true/);
});

test('el acceso desambigua el usuario por producto y liga de negocio', () => {
  const auth = read('src/routes/auth.js');
  assert.match(auth, /tenants\.slug = \$2/);
  assert.match(auth, /BUSINESS_SLUG_REQUIRED/);
  for (const name of ['public/login.html', 'public/invoicing-login.html']) {
    assert.match(read(name), /businessSlug: document\.getElementById\('businessSlug'\)\.value/);
  }
});
