const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const db = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src', 'routes', 'auth.js'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'src', 'routes', 'settings.js'), 'utf8');
const middleware = fs.readFileSync(path.join(root, 'src', 'middleware', 'auth.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const register = fs.readFileSync(path.join(root, 'public', 'register.html'), 'utf8');

test('crea la configuración inicial del tenant en una sola operación', () => {
  assert.match(db, /FROM unnest\(\$1::text\[\], \$2::text\[\]\)/);
  assert.doesNotMatch(db, /for \(const \[k, v\] of Object\.entries\(defaults\)\)/);
});

test('agrupa las validaciones y crea tenant y propietario atómicamente', () => {
  assert.match(auth, /const \[conflictResult, passwordHash\] = await Promise\.all/);
  assert.match(auth, /WITH new_tenant AS/);
  assert.match(auth, /new_user AS/);
  assert.match(auth, /SELECT id, \$8, \$9, 0 FROM new_tenant/);
  assert.match(auth, /FROM new_tenant CROSS JOIN new_user/);
});

test('el arranque del panel evita consultas consecutivas innecesarias', () => {
  assert.match(settings, /WHERE key = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(settings, /for \(const k of SETTING_KEYS\) out\[k\] = await getSetting/);
  assert.match(middleware, /SELECT row_to_json\(u\) AS auth_user, row_to_json\(t\) AS tenant/);
  assert.match(app, /\[ME, SETTINGS\] = await Promise\.all/);
});

test('precarga el panel y da respuesta visual inmediata al enviar el registro', () => {
  assert.match(register, /rel="prefetch" href="\/app"/);
  assert.match(register, /fetch\('\/api\/auth\/register-ready'/);
  assert.match(auth, /router\.get\('\/register-ready'/);
  assert.match(register, /Preparando tu panel/);
  assert.match(register, /aria-busy/);
  assert.match(register, /location\.replace\('\/app'\)/);
});
