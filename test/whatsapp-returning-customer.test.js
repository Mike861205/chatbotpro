const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage, findReturningCustomerByPhone, phoneHashCandidates } = require('../src/chatbot/engine');
const { encrypt, lookupHash } = require('../src/utils/crypto');

const whatsapp = { sourceChannel: 'whatsapp', customerPhone: '526141234567', customerName: 'Perfil WA' };
const categories = [{ id: 1, name: 'Chickenbake', sort: 1 }, { id: 2, name: 'Bebidas', sort: 2 }];
const products = [
  { id: 10, category_id: 1, name: 'Pollo', description: '', price: 100, image: '', sale_days: '', category: 'Chickenbake', category_sort: 1 },
  { id: 11, category_id: 2, name: 'Refresco', description: '', price: 20, image: '', sale_days: '', category: 'Bebidas', category_sort: 2 },
];

function fakeDb({ state, customerRows = {}, branches = [] }) {
  let saved = structuredClone(state);
  return {
    get savedState() { return saved; },
    async get(sql, params) {
      if (sql.includes('chat_sessions')) return { state: JSON.stringify(saved), updated_at: new Date().toISOString() };
      if (sql.includes('o.delivery_address')) return customerRows.delivery;
      if (sql.includes('o.receiving_mode_label')) return customerRows.lastOrder;
      if (sql.includes('FROM {s}.customers c')) return customerRows.customer;
      return null;
    },
    async all(sql) {
      if (sql.includes('FROM {s}.products')) return products;
      if (sql.includes('FROM {s}.categories')) return categories;
      if (sql.includes('FROM {s}.branches')) return branches;
      return [];
    },
    async run(sql, params) {
      if (sql.includes('chat_sessions')) saved = JSON.parse(params[1]);
      return { changes: 1 };
    },
  };
}

const cartState = (extra = {}) => ({
  step: 'start', currency: 'MXN', aiHistory: [], lastOptions: [],
  cart: [{ id: 10, name: 'Pollo', qty: 1, price: 100 }], customer: {}, ...extra,
});

test('"Agregar otro" muestra todas las categorías del menú, no solo la anterior', async () => {
  const db = fakeDb({ state: cartState({ step: 'start', browseMode: 'category', lastOptions: [{ label: '➕ Agregar otro', value: 'more_products' }] }) });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_more', 'more_products', whatsapp);
  assert.deepEqual(reply.options.map((o) => o.label), ['Chickenbake', 'Bebidas']);
  assert.equal(db.savedState.step, 'choosing_category');
  assert.equal(db.savedState.cart.length, 1);
});

test('phoneHashCandidates cubre variantes con y sin lada de país', () => {
  const hashes = phoneHashCandidates('526141234567');
  for (const variant of ['526141234567', '6141234567', '5216141234567']) assert.ok(hashes.includes(lookupHash(variant)), variant);
  assert.ok(phoneHashCandidates('6141234567').includes(lookupHash('526141234567')));
});

test('el perfil del cliente recuerda la última sucursal si recogió en tienda', async () => {
  const db = fakeDb({
    state: cartState(),
    customerRows: {
      customer: { id: 5, name_enc: encrypt('Ana'), phone_enc: encrypt('6141234567') },
      lastOrder: { id: 9, delivery: 'recoger_sucursal', receiving_mode_label: 'Recoger en sucursal', receiving_mode_behavior: 'branch', pickup_branch_id: 3, pickup_branch_name: 'Aurora' },
    },
  });
  const profile = await findReturningCustomerByPhone(db, '526141234567');
  assert.equal(profile.name, 'Ana');
  assert.equal(profile.hasDeliveryHistory, false);
  assert.equal(profile.lastMode, 'branch');
  assert.equal(profile.lastBranchId, 3);
  assert.equal(profile.lastBranchName, 'Aurora');
});

test('un número sin pedidos previos no se reconoce como cliente', async () => {
  const db = fakeDb({ state: cartState() });
  assert.equal(await findReturningCustomerByPhone(db, '526141234567'), null);
});

test('WhatsApp ofrece la última sucursal a un cliente que ya recogió en tienda', async () => {
  const known = { id: 5, name: 'Ana', phone: '6141234567', hasDeliveryHistory: false, lastMode: 'branch', lastModeId: 'recoger_sucursal', lastBranchId: 3, lastBranchName: 'Aurora' };
  const db = fakeDb({
    state: cartState({ step: 'ask_order_note_choice', knownProfile: known, knownProfileChecked: true }),
    branches: [{ id: 3, name: 'Aurora', address: 'Av. Principal 1', reference: '' }],
  });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_known', 'order_note_no', whatsapp);
  const values = (reply.options || []).map((o) => o.value);
  assert.ok(!values.includes('returning_customer'), 'no debe preguntar si ya pidió');
  assert.ok(values.includes('returning_pickup_same'));
  assert.ok(values.includes('returning_other_mode'));
  assert.match(reply.messages.join('\n'), /Aurora/);
  assert.equal(db.savedState.step, 'confirm_returning_address');
});

test('WhatsApp ofrece el último domicilio a un cliente con entregas previas', async () => {
  const known = { id: 5, name: 'Ana', phone: '6141234567', hasDeliveryHistory: true, lastMode: 'delivery', address: 'Calle 5 #10', neighborhood: 'Centro' };
  const db = fakeDb({ state: cartState({ step: 'ask_order_note_choice', knownProfile: known, knownProfileChecked: true }) });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_known_d', 'order_note_no', whatsapp);
  const values = (reply.options || []).map((o) => o.value);
  assert.ok(!values.includes('returning_customer'));
  assert.ok(values.includes('returning_address_yes'));
  assert.ok(values.includes('returning_address_no'));
  assert.match(reply.messages.join('\n'), /Calle 5 #10/);
});

test('WhatsApp con un cliente nuevo mantiene la pregunta de identidad', async () => {
  const db = fakeDb({ state: cartState({ step: 'ask_order_note_choice', knownProfileChecked: true }) });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_new_c', 'order_note_no', whatsapp);
  assert.ok((reply.options || []).some((o) => o.value === 'returning_customer'));
});

test('el asistente web no consulta el teléfono automáticamente', async () => {
  const db = fakeDb({ state: cartState({ step: 'ask_order_note_choice' }) });
  await handleMessage(db, 'restaurante', 'web_known', 'order_note_no');
  assert.equal(db.savedState.knownProfileChecked, undefined);
});

test('"Sí, recoger en la misma sucursal" fija sucursal y avanza al pago sin repetir datos', async () => {
  const profile = { id: 5, name: 'Ana', phone: '6141234567', hasDeliveryHistory: false, lastMode: 'branch', lastModeId: 'recoger_sucursal', lastBranchId: 3, lastBranchName: 'Aurora' };
  const db = fakeDb({
    state: cartState({ step: 'confirm_returning_address', returningProfile: profile, knownProfileChecked: true }),
    branches: [{ id: 3, name: 'Aurora', address: 'Av. Principal 1', reference: '' }],
  });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_same', 'returning_pickup_same', whatsapp);
  assert.equal(db.savedState.customer.branchId, 3);
  assert.equal(db.savedState.customer.name, 'Ana');
  assert.notEqual(db.savedState.step, 'confirm_returning_address');
  assert.notEqual(db.savedState.step, 'ask_name');
  assert.match(reply.messages.join('\n'), /Aurora/);
});

test('"Cambiar sucursal o modalidad" vuelve a mostrar las modalidades de recepción', async () => {
  const profile = { id: 5, name: 'Ana', phone: '6141234567', hasDeliveryHistory: false, lastMode: 'branch', lastBranchId: 3, lastBranchName: 'Aurora' };
  const db = fakeDb({ state: cartState({ step: 'confirm_returning_address', returningProfile: profile, knownProfileChecked: true }) });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_other', 'returning_other_mode', whatsapp);
  assert.equal(db.savedState.step, 'ask_delivery');
  assert.ok(reply.options.length >= 1);
});
