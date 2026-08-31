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

test('el esquema y el panel permiten crear una pantalla Delivery sin asignar productos', () => {
  assert.match(db, /area_type TEXT NOT NULL DEFAULT 'preparation'/);
  assert.match(route, /areaType === 'preparation' && !categoryIds\.length && !productIds\.length/);
  assert.match(app, /type: \$\('#kdsAreaType'\)\.value/);
  assert.match(app, /kdsAddDeliveryBtn/);
});

test('Delivery recibe sólo domicilios y deriva la fase de todas las áreas de preparación', () => {
  assert.match(route, /isDeliveryArea && !isDeliveryOrder/);
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