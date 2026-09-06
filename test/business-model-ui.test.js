const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

test('el panel define una presentacion para los ocho modelos de negocio', () => {
  for (const businessType of [
    'restaurant', 'furniture', 'travel_agency', 'office_services',
    'screen_printing', 'carpentry', 'health', 'dentist',
  ]) {
    assert.match(appJs, new RegExp(`\\b${businessType}: \\{`));
  }
  assert.match(appJs, /travel_agency:[\s\S]*orders: 'Reservaciones'[\s\S]*items: 'Paquetes y servicios'/);
  assert.match(appJs, /dentist:[\s\S]*orders: 'Citas'[\s\S]*items: 'Tratamientos'/);
});

test('KDS, mesas y comer en sucursal se reservan para restaurante', () => {
  assert.match(appHtml, /data-view="kds"[^>]+data-business-feature="restaurant"/);
  assert.match(appHtml, /id="chatbotTabTables" data-business-feature="restaurant"/);
  assert.match(appHtml, /id="chatbotDineInOption" data-business-feature="restaurant"[\s\S]*id="botDineIn"/);
  assert.match(appJs, /view === 'kds' && !businessUi\(\)\.supportsRestaurantOperations/);
  assert.match(appJs, /setChatbotSubtab\(!ui\.supportsRestaurantOperations/);
});

test('cambiar el modelo reaplica textos, modulos y navegacion', () => {
  assert.match(appJs, /SETTINGS = await api\('\/api\/settings'\);[\s\S]*applyBusinessModelUI\(\);[\s\S]*applyUserScopeUI\(\);[\s\S]*renderInstructions\(\);[\s\S]*renderModuleVisibility\(\);/);
  assert.match(appJs, /VIEW_META\.pedidos = \[ui\.orders/);
  assert.match(appJs, /VIEW_META\.productos = \[ui\.items/);
});