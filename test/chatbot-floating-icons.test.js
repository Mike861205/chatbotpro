const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_FLOATING_ICONS, parseFloatingIcons, validateFloatingIcons } = require('../src/utils/chatbotAppearance');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('normaliza iconos flotantes por tenant y conserva el fondo anterior como predeterminado', () => {
  assert.deepEqual(parseFloatingIcons(''), DEFAULT_FLOATING_ICONS);
  assert.deepEqual(validateFloatingIcons(['🦐', '🐟', '🦐']), ['🦐', '🐟']);
  assert.deepEqual(validateFloatingIcons([]), []);
  assert.throws(() => validateFloatingIcons(['icono-no-permitido']), /catálogo/);
  assert.throws(() => validateFloatingIcons(new Array(9).fill('🍕')), /8 iconos/);
});

test('Mi chatbot ofrece catálogo, colecciones y vista previa en la pestaña Flujo', () => {
  const html = read('public', 'app.html');
  const app = read('public', 'js', 'app.js');
  assert.match(html, /id="botFloatingIconCatalog"/);
  assert.match(html, /id="botFloatingIconsPreview"/);
  assert.match(app, /Comida rápida/);
  assert.match(app, /China y asiática/);
  assert.match(app, /Mariscos/);
  assert.match(app, /Tecnología/);
  assert.match(app, /Dinero y finanzas/);
  assert.match(app, /chatbot_floating_icons_json/);
});

test('la liga pública reemplaza el fondo fijo con los iconos configurados', () => {
  const route = read('src', 'routes', 'chatbot.js');
  const chat = read('public', 'chat.html');
  assert.match(route, /floatingIcons: parseFloatingIcons/);
  assert.match(chat, /function renderFloatingBackground\(icons\)/);
  assert.match(chat, /renderFloatingBackground\(info\.floatingIcons\)/);
});
