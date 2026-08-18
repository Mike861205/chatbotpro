const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const db = read('src', 'db', 'index.js');
const settings = read('src', 'routes', 'settings.js');
const pos = read('src', 'routes', 'pos.js');
const appHtml = read('public', 'app.html');
const app = read('public', 'js', 'app.js');

test('el tenant configura pedidos chatbot globales desde servicio a domicilio', () => {
  assert.match(db, /chatbot_pos_global_orders_enabled: '0'/);
  assert.match(settings, /'chatbot_pos_global_orders_enabled'/);
  assert.match(appHtml, /id="chatbotDeliveryPanel"[\s\S]+id="botPosGlobalOrders"/);
  assert.match(app, /fd\.append\('chatbot_pos_global_orders_enabled', value\)/);
});

test('el modo por sucursal filtra la cola y bloquea importaciones ajenas', () => {
  assert.match(pos, /const restrictToSessionBranch = !globalOrdersEnabled && Boolean\(session\?\.branch_id\)/);
  assert.match(pos, /const branchFilter = restrictToSessionBranch[\s\S]+COALESCE\(o\.service_branch_id, o\.pickup_branch_id\) = \$2/);
  assert.match(pos, /o\.payment_method, o\.pickup_branch_id, o\.pickup_branch_name/);
  assert.match(pos, /const assignedBranchId = Number\(sourceOrder\.service_branch_id \|\| sourceOrder\.pickup_branch_id \|\| 0\)/);
  assert.match(pos, /if \(!globalOrdersEnabled && session\.branch_id && assignedBranchId > 0 && assignedBranchId !== Number\(session\.branch_id\)\)/);
});

test('el modo global permite que la primera caja tome y reasigne el pedido', () => {
  assert.match(pos, /getSetting\(t, 'chatbot_pos_global_orders_enabled', '0'\)/);
  assert.match(pos, /const update = await req\.tdb\.tx\(async \(tx\) => \{[\s\S]+SET channel = 'pos',[\s\S]+service_branch_id = \$7,[\s\S]+service_branch_name = \$8/);
  assert.match(pos, /WHERE id = \$5[\s\S]+AND channel = 'chatbot'/);
  assert.match(pos, /decrementBranchStockForSale\(tx, session\.branch_id, costedSourceItems\)/);
});