const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('persiste y recupera el origen independiente del canal actual del pedido', () => {
  const db = source('src/db/index.js');
  const orders = source('src/routes/orders.js');
  const chatbot = source('src/chatbot/engine.js');
  const selfService = source('src/routes/selfService.js');
  const pos = source('src/routes/pos.js');

  assert.match(db, /orders ADD COLUMN IF NOT EXISTS source_channel TEXT DEFAULT ''/);
  assert.match(db, /WHEN self_service_device_id IS NOT NULL[\s\S]+THEN 'kiosk'/);
  assert.match(db, /WHEN channel = 'chatbot' THEN 'chatbot'/);
  assert.match(orders, /channel, source_channel, self_service_device_id, self_service_folio/);
  assert.match(chatbot, /channel, source_channel, delivery[\s\S]+\$6,'chatbot',\$7/);
  assert.match(selfService, /channel,source_channel,delivery[\s\S]+'kiosk','kiosk','mostrador'/);
  assert.match(pos, /SET channel = 'pos',[\s\S]+source_channel = 'chatbot'/);
  assert.match(pos, /'confirmado', 'pos', 'pos'/);
});

test('identifica cada procedencia y conserva chatbot después de pasarlo al POS', () => {
  const app = source('public/js/app.js');
  const css = source('public/css/styles.css');

  assert.match(app, /function orderSourceChannel\(order\)/);
  assert.match(app, /label: 'Chatbot → Punto de venta'/);
  assert.match(app, /label: 'Chatbot'/);
  assert.match(app, /label: 'Autoservicio'/);
  assert.match(app, /label: 'Punto de venta'/);
  assert.match(app, /order-origin-chip \$\{origin\.tone\}/);
  assert.match(css, /\.order-origin-chip\.chatbot-pos/);
  assert.match(css, /\.order-origin-chip\.kiosk/);
  assert.match(css, /\.order-origin-chip\.pos/);
});

test('solo el chatbot con coordenadas reales muestra Abrir ubicación', () => {
  const app = source('public/js/app.js');

  assert.match(app, /const canShowChatbotLocation = origin\.source === 'chatbot'/);
  assert.match(app, /o\.customer_location_lat !== null[\s\S]+Number\.isFinite\(Number\(o\.customer_location_lat\)\)/);
  assert.match(app, /const mapLink = canShowChatbotLocation && hasLatitude && hasLongitude/);
  assert.match(app, /const locationText = canShowChatbotLocation && o\.customer_location_text/);
});
