const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const db = read('src', 'db', 'index.js');
const products = read('src', 'routes', 'products.js');
const pos = read('src', 'routes', 'pos.js');
const chatbotRoute = read('src', 'routes', 'chatbot.js');
const engine = read('src', 'chatbot', 'engine.js');
const whatsapp = read('src', 'routes', 'whatsapp.js');
const orders = read('src', 'routes', 'orders.js');
const app = read('public', 'js', 'app.js');
const appHtml = read('public', 'app.html');

test('pos_active es una columna independiente que conserva el estado previo de cada producto', () => {
  assert.match(db, /ADD COLUMN IF NOT EXISTS pos_active INTEGER/);
  assert.match(db, /SET pos_active = COALESCE\(active, 1\) WHERE pos_active IS NULL/);
  assert.match(db, /ALTER COLUMN pos_active SET DEFAULT 1/);
});

test('apagar "visible en el chatbot" no oculta el producto del punto de venta', () => {
  assert.match(pos, /WHERE p\.pos_active = 1/);
  assert.match(pos, /!Number\(product\.pos_active\)/);
  assert.doesNotMatch(pos, /!product\.active \|\|/);
});

test('el chatbot web y WhatsApp siguen dependiendo sólo de active', () => {
  assert.match(engine, /FROM \{s\}\.products p LEFT JOIN \{s\}\.categories c ON c\.id = p\.category_id\s+WHERE p\.active = 1/);
  assert.match(chatbotRoute, /WHERE p\.active = 1/);
  assert.match(whatsapp, /FROM \{s\}\.products WHERE id=\$1 AND active=1/);
  assert.doesNotMatch(engine, /pos_active/);
  assert.doesNotMatch(chatbotRoute, /pos_active/);
});

test('la API de productos guarda y devuelve posActive', () => {
  assert.match(products, /p\.active, p\.pos_active/);
  assert.match(products, /pos_active=\$17/);
  assert.match(products, /req\.body\?\.posActive/);
});

test('el formulario de productos tiene un interruptor propio para punto de venta', () => {
  assert.match(appHtml, /id="pPosActive"/);
  assert.match(app, /fd\.append\('posActive'/);
  assert.match(app, /\$\('#pPosActive'\)\.checked/);
  assert.match(app, /function productVisibilityBadges/);
});

test('Pedidos filtra por sucursal en el servidor y en el panel', () => {
  assert.match(orders, /router\.get\('\/branches'/);
  assert.match(orders, /COALESCE\(NULLIF\(service_branch_id, 0\), NULLIF\(pickup_branch_id, 0\)\) = \$\$\{params\.length\}/);
  assert.match(appHtml, /id="ordersBranchFilter"/);
  assert.match(app, /params\.set\('branchId', orderBranchFilter\)/);
});
