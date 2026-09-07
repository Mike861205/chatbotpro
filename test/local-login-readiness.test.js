const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('localhost abre el puerto antes de las migraciones y espera el esquema maestro para autenticar', () => {
  const server = read('server.js');
  const database = read('src', 'db', 'index.js');

  assert.ok(server.indexOf('httpServer.listen(') < server.indexOf('initMaster({'));
  assert.match(server, /app\.use\('\/api',[\s\S]*?await databaseReadyPromise/);
  assert.match(server, /onMasterReady:\s*config\.NODE_ENV === 'development'\s*\?\s*markDatabaseReady/);
  assert.match(database, /async function initMaster\(options = \{}\)/);
  assert.ok(database.indexOf("options.onMasterReady") < database.indexOf("const existing = await q('SELECT id, slug, business_name, product_code FROM tenants')"));
});

test('los logins de tenant y SuperAdmin reintentan sólo fallos transitorios de arranque', async () => {
  const helper = read('public', 'js', 'auth-request.js');
  const tenantLogin = read('public', 'login.html');
  const superadminLogin = read('public', 'superadmin-login.html');
  let calls = 0;
  const expected = { status: 200, ok: true };
  const context = {
    window: {},
    setTimeout: (callback) => { callback(); return 1; },
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return expected;
    },
  };

  vm.runInNewContext(helper, context);
  const response = await context.window.CBPAuthRequest.fetch('/api/auth/login', {}, { attempts: 2, baseDelayMs: 0 });

  assert.equal(response, expected);
  assert.equal(calls, 2);
  assert.match(tenantLogin, /auth-request\.js[^\n]*[\s\S]*CBPAuthRequest\.fetch\(endpoint/);
  assert.match(superadminLogin, /auth-request\.js[^\n]*[\s\S]*CBPAuthRequest\.fetch\('\/api\/superadmin\/login'/);
});

test('el service worker no intercepta ni almacena logins o respuestas de API', () => {
  const serviceWorker = read('public', 'sw.js');

  assert.match(serviceWorker, /cbp-notify-v3/);
  assert.match(serviceWorker, /url\.pathname !== '\/notificaciones'/);
  assert.match(serviceWorker, /!url\.pathname\.startsWith\('\/static\/'\)/);
  assert.doesNotMatch(serviceWorker, /PRECACHE\s*=\s*\[[^\]]*\/login/);
});
