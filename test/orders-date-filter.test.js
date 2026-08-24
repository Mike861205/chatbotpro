const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const kdsJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'kds.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('al desactivar pedidos del día usa un rango predeterminado de siete días', () => {
  assert.match(appJs, /start\.setDate\(start\.getDate\(\) - 6\)/);
  assert.match(appJs, /else \{\s*resetOrdersToDefaultWeek\(\);\s*\}/);
  assert.match(appJs, /\? 'últimos 7 días'\s*: 'rango personalizado'/);
});

test('limpiar fechas desactiva el filtro diario y elimina por completo el rango', () => {
  assert.match(
    appJs,
    /\$\('#ordersClearDate'\)[\s\S]*?orderTodayOnly = false;\s*orderDateStart = '';\s*orderDateEnd = '';/,
  );
  assert.doesNotMatch(appJs, /async function loadOrders\(\) \{\s*if \(!orderTodayOnly && !orderDateStart && !orderDateEnd\) resetOrdersToDefaultWeek\(\);/);
  assert.match(appJs, /let dateModeLabel = 'todas las fechas'/);
  assert.match(appJs, /\? 'últimos 7 días'\s*: 'rango personalizado'/);
});

test('el monitor de pedidos usa eventos y no mantiene Neon activo con polling frecuente', () => {
  assert.match(appJs, /ORDER_ALERT_FALLBACK_MS = 30 \* 60 \* 1000/);
  assert.match(appJs, /ORDER_ALERT_SOCKET\.on\('new_order'/);
  assert.match(appJs, /document\.addEventListener\('visibilitychange'/);
  assert.match(appJs, /if \(document\.hidden\) return;/);
  assert.doesNotMatch(appJs, /ORDER_ALERT_POLL_MS|setInterval\([\s\S]{0,120}refreshPendingOrdersMonitor/);
});

test('KDS usa eventos y un respaldo adaptativo que se pausa al ocultarse', () => {
  assert.match(kdsJs, /socket\.on\('new_order'/);
  assert.match(kdsJs, /ACTIVE_FALLBACK_MS = 60 \* 1000/);
  assert.match(kdsJs, /IDLE_FALLBACK_MS = 30 \* 60 \* 1000/);
  assert.match(kdsJs, /document\.addEventListener\('visibilitychange'/);
  assert.doesNotMatch(kdsJs, /POLL_MS = 4000|setInterval\(\(\) => refresh\(\)/);
});

test('el mantenimiento de cobranza no despierta Neon cada hora', () => {
  assert.match(serverJs, /BILLING_REFRESH_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(serverJs, /setInterval\([\s\S]*?BILLING_REFRESH_INTERVAL_MS\)/);
  assert.doesNotMatch(serverJs, /}, 60 \* 60 \* 1000\);/);
});
