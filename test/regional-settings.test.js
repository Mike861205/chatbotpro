const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CURRENCIES,
  TIME_ZONES,
  regionalDefaults,
  isSupportedCurrency,
  isSupportedTimeZone,
} = require('../src/utils/regional');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const db = read('src', 'db', 'index.js');
const auth = read('src', 'routes', 'auth.js');
const settings = read('src', 'routes', 'settings.js');
const middleware = read('src', 'middleware', 'auth.js');
const orders = read('src', 'routes', 'orders.js');
const pos = read('src', 'routes', 'pos.js');
const kds = read('src', 'routes', 'kds.js');
const appHtml = read('public', 'app.html');
const appScript = read('public', 'js', 'app.js');
const kdsScript = read('public', 'js', 'kds.js');

test('incluye monedas de Centroamérica, Sudamérica y el Caribe', () => {
  for (const code of ['MXN', 'GTQ', 'BZD', 'HNL', 'NIO', 'CRC', 'PAB', 'DOP', 'COP', 'PEN', 'BOB', 'PYG', 'CLP', 'ARS', 'UYU', 'BRL', 'USD']) {
    assert.equal(isSupportedCurrency(code), true, `falta ${code}`);
    assert.doesNotThrow(() => new Intl.NumberFormat('es-MX', { style: 'currency', currency: code }).format(1));
  }
  assert.ok(CURRENCIES.length >= 25);
});

test('asigna automáticamente moneda y zona horaria usando el país del teléfono', () => {
  assert.deepEqual(regionalDefaults('GT'), { currency: 'GTQ', timezone: 'America/Guatemala' });
  assert.deepEqual(regionalDefaults('CO'), { currency: 'COP', timezone: 'America/Bogota' });
  assert.deepEqual(regionalDefaults('AR'), { currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires' });
  assert.deepEqual(regionalDefaults('BR'), { currency: 'BRL', timezone: 'America/Sao_Paulo' });
  assert.match(auth, /regionalDefaults\(normalizedPhone\.country\)/);
  assert.match(auth, /isSupportedTimeZone\(timezone\)/);
  assert.match(read('public', 'register.html'), /resolvedOptions\(\)\.timeZone/);
  assert.match(auth, /phone_calling_code, timezone/);
  assert.match(auth, /initTenantDefaults\(cleanSlug, cleanBusinessName, regional, tenant\.id\)/);
});

test('todas las zonas ofrecidas son IANA válidas', () => {
  assert.ok(TIME_ZONES.length >= 40);
  for (const item of TIME_ZONES) {
    assert.equal(isSupportedTimeZone(item.value), true);
    assert.doesNotThrow(() => new Intl.DateTimeFormat('es-MX', { timeZone: item.value }).format(new Date()));
  }
});

test('persiste y permite configurar la zona horaria en Mi negocio', () => {
  assert.match(db, /timezone TEXT NOT NULL DEFAULT 'America\/Mexico_City'/);
  assert.match(db, /currency: regional\.currency/);
  assert.match(db, /timezone: regional\.timezone/);
  assert.match(settings, /'timezone'/);
  assert.match(settings, /isSupportedCurrency/);
  assert.match(settings, /isSupportedTimeZone/);
  assert.match(settings, /UPDATE tenants SET timezone = \$1 WHERE id = \$2/);
  assert.match(appHtml, /id="cfgTimezone"/);
  assert.match(appHtml, /Zona horaria local/);
  assert.match(appScript, /fd\.append\('timezone'/);
  assert.match(appScript, /Hora local del negocio/);
});

test('pedidos, POS, comandas y KDS usan la zona horaria del tenant', () => {
  assert.match(middleware, /req\.timezone = normalizeTimeZone\(tenant\.timezone\)/);
  assert.match(orders, /AT TIME ZONE '\$\{req\.timezone\}'/);
  assert.match(pos, /tenantTimeZone\(t\)/);
  assert.match(pos, /timeZone: req\.timezone/);
  assert.match(kds, /AT TIME ZONE '\$\{tenant\.timezone\}'/);
  assert.match(kdsScript, /payload\?\.tenant\?\.timezone/);
  assert.match(appScript, /function fmtBusinessDateTime/);
  assert.match(appScript, /createdAt: fmtBusinessDateTime\(\)/);
});

test('el encabezado muestra fecha, hora y zona local actualizadas cada segundo', () => {
  assert.match(appHtml, /id="tenantClock"/);
  assert.match(appHtml, /id="tenantLocalDate"/);
  assert.match(appHtml, /id="tenantLocalTime"/);
  assert.match(appHtml, /id="tenantTimezoneLabel"/);
  assert.match(appHtml, /id="configureTimezoneBtn"/);
  assert.match(appHtml, /Configura tu horario local/);
  assert.match(appScript, /function updateTenantClock\(\)/);
  assert.match(appScript, /setInterval\(updateTenantClock, 1000\)/);
  assert.match(appScript, /timeZone: timezone/);
  assert.match(appScript, /startTenantClock\(\)/);
  assert.match(appScript, /configureTimezoneBtn/);
  assert.match(appScript, /await navigate\('config'\)/);
  assert.match(appScript, /scrollIntoView/);
});
