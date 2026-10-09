const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage } = require('../src/chatbot/engine');
const route = require('../src/routes/whatsapp');

function sessionDb(row) {
  let saved = row ? structuredClone(row.state) : null;
  return {
    get savedState() { return saved; },
    async get(sql, params) {
      if (sql.includes('chat_sessions')) return row ? { state: JSON.stringify(row.state), updated_at: row.updatedAt } : undefined;
      if (sql.includes('settings')) return params[0] === 'whatsapp' ? { value: '526141234567' } : null;
      throw new Error(`Consulta get inesperada: ${sql}`);
    },
    async all(sql) {
      if (sql.includes('settings')) return [];
      throw new Error(`Consulta all inesperada: ${sql}`);
    },
    async run(sql, params) {
      if (!sql.includes('chat_sessions')) throw new Error(`Consulta run inesperada: ${sql}`);
      saved = JSON.parse(params[1]);
      return { changes: 1 };
    },
  };
}

const midOrder = {
  step: 'ask_payment_method', currency: 'MXN', aiHistory: [],
  cart: [{ id: 9, name: 'Papas', qty: 1, price: 50 }],
  customer: { name: 'Ana', phone: '6141234567' },
};
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
const whatsapp = { sourceChannel: 'whatsapp', customerPhone: '526141234567', customerName: 'Ana' };

test('WhatsApp abre con la bienvenida cuando la conversación es nueva', async () => {
  const db = sessionDb(null);
  const reply = await handleMessage(db, 'restaurante', 'wa_1_new', 'Hola, quiero hacer un pedido', whatsapp);
  assert.match(reply.messages[0], /Bienvenido/);
  assert.equal(db.savedState.step, 'start');
  assert.equal(db.savedState.cart.length, 0);
});

test('WhatsApp reinicia un pedido abandonado después de 30 minutos', async () => {
  const db = sessionDb({ state: midOrder, updatedAt: minutesAgo(31) });
  const reply = await handleMessage(db, 'restaurante', 'wa_1_idle', 'Efectivo', whatsapp);
  assert.match(reply.messages[0], /Bienvenido/);
  assert.equal(db.savedState.step, 'start');
  assert.equal(db.savedState.cart.length, 0);
});

test('WhatsApp conserva el pedido en curso dentro de los 30 minutos', async () => {
  const db = sessionDb({ state: { ...midOrder, lastOptions: [{ label: 'Efectivo', value: 'pay_cash' }] }, updatedAt: minutesAgo(10) });
  await handleMessage(db, 'restaurante', 'wa_1_active', 'pay_cash', whatsapp);
  assert.notEqual(db.savedState.step, 'start');
  assert.equal(db.savedState.cart.length, 1);
});

test('un pedido terminado se cierra a los 30 minutos y vuelve a abrir el flujo', async () => {
  const done = { step: 'order_complete', cart: [], customer: {}, currency: 'MXN', aiHistory: [], lastOrderCompletedAt: minutesAgo(31) };
  const reopened = sessionDb({ state: done, updatedAt: minutesAgo(1) });
  const reply = await handleMessage(reopened, 'restaurante', 'wa_1_done', 'gracias', whatsapp);
  assert.match(reply.messages[0], /Bienvenido/);
  assert.equal(reopened.savedState.step, 'start');

  const recent = sessionDb({ state: { ...done, lastOrderCompletedAt: minutesAgo(5) }, updatedAt: minutesAgo(5) });
  const thanks = await handleMessage(recent, 'restaurante', 'wa_1_done', 'gracias', whatsapp);
  assert.match(thanks.messages[0], /ya quedó registrado/);
  assert.equal(recent.savedState.step, 'order_complete');
});

test('el asistente web no se reinicia por inactividad', async () => {
  const db = sessionDb({ state: { ...midOrder, lastOptions: [{ label: 'Efectivo', value: 'pay_cash' }] }, updatedAt: minutesAgo(120) });
  await handleMessage(db, 'restaurante', 'web_idle', 'pay_cash');
  assert.equal(db.savedState.cart.length, 1);
});

test('el webhook usa la hora del proveedor y reconoce archivos adjuntos', () => {
  const stamp = new Date(Date.now() - 5000).toISOString();
  const text = route.webhookMessage({ event: 'message.received', message: { id: 'm1', text: 'Hola', createdAt: stamp } });
  assert.equal(text.timestamp, stamp);

  const seconds = Math.floor(Date.now() / 1000) - 10;
  assert.equal(route.webhookMessage({ event: 'message.received', timestamp: seconds, message: { id: 'm2', text: 'Hi' } }).timestamp,
    new Date(seconds * 1000).toISOString());
  assert.equal(route.webhookMessage({ event: 'message.received', message: { id: 'm3', text: 'x', createdAt: '2001-01-01T00:00:00Z' } }).timestamp, null);

  const image = route.webhookMessage({ event: 'message.received', message: { id: 'm4', text: '📷 Image', attachments: [{ type: 'image', url: 'https://x.test/a.jpg' }] } });
  assert.equal(image.text, '');
  assert.equal(image.media.kind, 'image');
  const captioned = route.webhookMessage({ event: 'message.received', message: { id: 'm5', text: 'Mi comprobante', attachments: [{ type: 'image' }] } });
  assert.equal(captioned.text, 'Mi comprobante');
});

test('la bandeja entrega ubicación con coordenadas y botones ofrecidos al cliente', () => {
  const location = route.inboxMessageView({
    id: 1, direction: 'inbound', message_type: 'location', body: 'Casa', created_at: new Date(),
    payload_json: JSON.stringify({ event: 'message.received', metadata: { location: { latitude: 28.63, longitude: -106.07, name: 'Casa' } } }),
  });
  assert.deepEqual(location.location, { lat: 28.63, lng: -106.07, label: 'Casa' });

  const buttons = route.inboxMessageView({
    id: 2, direction: 'outbound', message_type: 'interactive', body: '*Selecciona una opción:*', created_at: new Date(),
    payload_json: JSON.stringify({ request: { buttons: [{ title: '👉 Ver menú' }, { title: '👉 Horarios' }] } }),
  });
  assert.deepEqual(buttons.options, ['👉 Ver menú', '👉 Horarios']);
  assert.equal('payload_json' in buttons, false);
});

test('los mensajes de una misma conversación se procesan en orden', async () => {
  const order = [];
  const slow = route.enqueueConversation('1:abc', async () => { await new Promise((resolve) => setTimeout(resolve, 40)); order.push('primero'); });
  const fast = route.enqueueConversation('1:abc', async () => { order.push('segundo'); });
  const other = route.enqueueConversation('1:other', async () => { order.push('otra conversación'); });
  await Promise.all([slow, fast, other]);
  assert.deepEqual(order, ['otra conversación', 'primero', 'segundo']);
});
