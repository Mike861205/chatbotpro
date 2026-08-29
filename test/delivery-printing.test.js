const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const db = read('src/db/index.js');
const chatbot = read('src/chatbot/engine.js');
const orders = read('src/routes/orders.js');
const pos = read('src/routes/pos.js');
const app = read('public/js/app.js');

test('persiste por separado domicilio, colonia y referencia de entrega', () => {
  for (const column of ['delivery_address', 'delivery_neighborhood', 'delivery_reference']) {
    assert.match(db, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
    assert.match(chatbot, new RegExp(column));
    assert.match(pos, new RegExp(column));
  }
});

test('el chatbot solicita la colonia antes de completar un domicilio', () => {
  assert.match(chatbot, /state\.step = 'ask_neighborhood'/);
  assert.match(chatbot, /if \(state\.step === 'ask_neighborhood'\)/);
  assert.match(chatbot, /colonia, barrio o sector/i);
});

test('el asistente usa el vocabulario solicitado para notas y domicilio', () => {
  assert.match(chatbot, /Ej\. salsa de soya, salsa agridulce\.\.\./);
  assert.match(chatbot, /Sí, usar este domicilio/);
  assert.match(chatbot, /Incluye calle\/edificio/);
  assert.doesNotMatch(chatbot, /hamburguesa sin cebolla/i);
  assert.doesNotMatch(chatbot, /usar esta dirección/i);
  assert.doesNotMatch(chatbot, /número exterior\/interior/i);
});

test('compartir ubicación no sustituye la calle y número del domicilio', () => {
  assert.match(chatbot, /state\.step = 'ask_address_after_location'/);
  assert.match(chatbot, /if \(state\.step === 'ask_address_after_location'\)/);
  assert.doesNotMatch(chatbot, /state\.customer\.address = state\.customer\.locationText/);
});

test('el punto de venta exige domicilio y colonia para una entrega', () => {
  assert.match(pos, /isDelivery && \(!deliveryAddress \|\| !deliveryNeighborhood\)/);
  assert.match(app, /id="posDeliveryAddress"/);
  assert.match(app, /id="posDeliveryNeighborhood"/);
  assert.match(app, /id="posDeliveryReference"/);
});

test('tickets y comandas imprimen los datos de domicilio disponibles', () => {
  assert.match(app, /openOrderComandaPrintWindow/);
  assert.match(app, /DOMICILIO:<\/b>/);
  assert.match(app, /COLONIA \/ BARRIO:<\/b>/);
  assert.match(app, /REFERENCIA:<\/b>/);
  assert.match(app, /UBICACI[^<]*:<\/b>/);
});

test('pedidos históricos conservan el domicilio y la referencia anteriores', () => {
  assert.match(orders, /delivery_address: String\(o\.delivery_address \|\| \(customer \? decrypt\(customer\.address_enc\) : ''\) \|\| ''\)/);
  assert.match(orders, /delivery_reference: String\(o\.delivery_reference \|\| \(o\.channel === 'chatbot' \? o\.notes : ''\) \|\| ''\)/);
});
