const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const db = read('src', 'db', 'index.js');
const route = read('src', 'routes', 'kds.js');
const app = read('public', 'js', 'app.js');
const screen = read('public', 'js', 'kds.js');
const notifications = read('src', 'notifications.js');
const { normalizeBranchId } = require('../src/chatbot/engine');

test('el esquema y el panel permiten crear una pantalla Delivery sin asignar productos', () => {
  assert.match(db, /area_type TEXT NOT NULL DEFAULT 'preparation'/);
  assert.match(route, /areaType === 'preparation' && !categoryIds\.length && !productIds\.length/);
  assert.match(app, /type: \$\('#kdsAreaType'\)\.value/);
  assert.match(app, /kdsAddDeliveryBtn/);
});

test('Delivery recibe sólo domicilios y deriva la fase de todas las áreas de preparación', () => {
  assert.match(route, /function orderIsDelivery\(order\)/);
  assert.match(route, /isDeliveryArea && !isDeliveryOrder/);
  assert.match(route, /String\(order\?\.delivery_address \|\| ''\)\.trim\(\)/);
  assert.match(route, /o\.channel = 'chatbot'[\s\S]+NULLIF\(o\.service_branch_id, 0\) IS NULL[\s\S]+o\.receiving_mode_behavior = 'delivery'/);
  assert.doesNotMatch(route, /customer_location_(?:lat|lng)[\s\S]{0,120}isDeliveryOrder/);
  assert.match(route, /function deliveryPreparationStatus\(preparationProgress\)/);
  assert.match(route, /preparationProgress\.every/);
  assert.match(route, /status !== 'completed' \|\| visibleTicket\.status !== 'ready'/);
});

test('la pantalla Delivery muestra datos operativos y se actualiza en tiempo real', () => {
  assert.match(screen, /deliveryNeighborhood/);
  assert.match(screen, /moneyLabel\(ticket\.total\)/);
  assert.match(screen, /preparationProgress/);
  assert.match(notifications, /emitKdsUpdate/);
  assert.match(screen, /socket\.on\('kds_update'/);
});

test('KDS normaliza sucursales nulas o cero antes de filtrar pedidos', () => {
  const chatbot = read('src', 'chatbot', 'engine.js');
  const orders = read('src', 'routes', 'orders.js');
  assert.match(chatbot, /function normalizeBranchId\(value\)/);
  assert.match(chatbot, /let serviceBranchId = isAddressDelivery\(\)[\s\S]+normalizeBranchId\(state\.customer\.(?:deliveryBranchId|branchId)\)/);
  assert.match(route, /NULLIF\(o\.service_branch_id, 0\) = \$2/);
  assert.match(route, /NULLIF\(o\.pickup_branch_id, 0\) = \$2/);
  assert.match(route, /\$3::boolean = TRUE[\s\S]+\$2::int IS NULL[\s\S]+o\.channel = 'chatbot'/);
  assert.match(orders, /COALESCE\(NULLIF\(\$1::int, 0\), NULLIF\(\$2::int, 0\)\)/);
  assert.equal(normalizeBranchId(null), null);
  assert.equal(normalizeBranchId(0), null);
  assert.equal(normalizeBranchId('7'), 7);
});

test('el asistente conserva la sucursal de la zona cuando sí recibe ubicación', () => {
  const chatbot = read('src', 'chatbot', 'engine.js');
  assert.match(chatbot, /branchId: normalizeBranchId\(props\?\.branchId/);
  assert.match(chatbot, /branchName: String\(props\?\.branchName/);
  assert.match(chatbot, /state\.customer\.deliveryBranchId = Number\.isFinite/);
});
