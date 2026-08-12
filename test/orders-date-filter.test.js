const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test('al desactivar pedidos del día usa un rango predeterminado de siete días', () => {
  assert.match(appJs, /start\.setDate\(start\.getDate\(\) - 6\)/);
  assert.match(appJs, /else \{\s*resetOrdersToDefaultWeek\(\);\s*\}/);
  assert.match(appJs, /Desactivado · últimos 7 días/);
});

test('limpiar fechas conserva el límite semanal cuando el filtro diario está apagado', () => {
  assert.match(
    appJs,
    /\$\('#ordersClearDate'\)[\s\S]*?if \(orderTodayOnly\)[\s\S]*?else \{\s*resetOrdersToDefaultWeek\(\);\s*\}/,
  );
});
