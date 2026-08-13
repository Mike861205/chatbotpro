const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

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
