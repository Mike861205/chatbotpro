const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const db = read('src/db/index.js');
const settings = read('src/routes/settings.js');
const chatbot = read('src/chatbot/engine.js');
const orders = read('src/routes/orders.js');
const pos = read('src/routes/pos.js');
const appHtml = read('public/app.html');
const app = read('public/js/app.js');
const kds = read('src/routes/kds.js');

test('comer en sucursal queda habilitado por defecto', () => {
  assert.match(db, /dine_in_enabled: '1'/);
  assert.match(settings, /'dine_in_enabled'/);
  assert.match(chatbot, /getSetting\(t, 'dine_in_enabled', '1'\)/);
  assert.match(chatbot, /id: 'comer_sucursal', label: '🍽️ Comer en sucursal', behavior: 'branch'/);
});

test('Mi chatbot permite activar las tres modalidades principales', () => {
  assert.match(appHtml, /id="botDelivery"/);
  assert.match(appHtml, /id="botPickup"/);
  assert.match(appHtml, /id="botDineIn"/);
  assert.match(app, /dine_in_enabled/);
});

test('el tenant puede crear modalidades personalizadas con comportamiento', () => {
  assert.match(appHtml, /id="botReceivingModeLabel"/);
  assert.match(appHtml, /id="botReceivingModeBehavior"/);
  assert.match(app, /function parseChatbotReceivingModes/);
  assert.match(settings, /function normalizeReceivingModes/);
  assert.match(settings, /Puedes configurar hasta 10 modalidades personalizadas/);
  assert.match(chatbot, /parseCustomReceivingModes/);
});

test('el chatbot muestra opciones dinámicas y procesa su selección', () => {
  assert.match(chatbot, /const receivingModes = \[/);
  assert.match(chatbot, /value: `receiving_mode_\$\{mode\.id\}`/);
  assert.match(chatbot, /await startReceivingMode\(selectedMode\)/);
  assert.match(chatbot, /mode\.behavior === 'delivery'/);
  assert.match(chatbot, /mode\.behavior === 'branch'/);
});

test('los pedidos conservan nombre y comportamiento de la modalidad elegida', () => {
  assert.match(db, /receiving_mode_label TEXT DEFAULT ''/);
  assert.match(db, /receiving_mode_behavior TEXT DEFAULT ''/);
  assert.match(orders, /receiving_mode_label, receiving_mode_behavior/);
  assert.match(chatbot, /delivery, receiving_mode_label, receiving_mode_behavior/);
  assert.match(kds, /receivingModeLabel/);
});

test('solo comer en sucursal abre una cuenta de mesa al importar', () => {
  assert.match(pos, /const isDineInOrder = sourceOrder\.delivery === 'comer_sucursal'/);
  assert.match(pos, /INSERT INTO \{s\}\.table_accounts/);
  assert.match(pos, /INSERT INTO \{s\}\.table_rounds/);
  assert.match(pos, /channel = 'table_account'/);
  assert.match(orders, /channel <> 'table_account'/);
});

test('la interfaz solicita una mesa libre para los pedidos de consumo en sucursal', () => {
  assert.match(app, /queueOrder\?\.delivery === 'comer_sucursal'/);
  assert.match(app, /Abrir en mesa/);
  assert.match(app, /openPosTablesModal\(\{ chatbotOrderId: id \}\)/);
  assert.match(app, /body: JSON\.stringify\(chatbotOrderId \? \{ tableId, waiterName \}/);
});

test('al cerrar la mesa reutiliza el pedido original y evita descontar stock dos veces', () => {
  assert.match(pos, /linkedOrder\?\.channel === 'table_account'/);
  assert.match(pos, /UPDATE \{s\}\.orders[\s\S]+status='entregado', channel='pos'/);
  assert.match(pos, /!Number\(linkedOrder\?\.branch_stock_applied\)/);
  assert.match(pos, /account\.source_channel === 'chatbot'[\s\S]+decrementBranchStockForSale\(tx, session\.branch_id, roundItems\)/);
});
