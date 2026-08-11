const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrderText } = require('../src/chatbot/engine');

const cart = [{ qty: 1, name: 'Combo pollo', price: 90 }];
const customer = {
  name: 'Patricio',
  phone: '9612375695',
  paymentMethod: 'cash',
  branchName: 'Centro',
};

test('incluye el ID real del pedido en el encabezado del resumen de WhatsApp', () => {
  const summary = buildOrderText('El Pollo Loco', cart, customer, 'recoger', 'MXN', undefined, 56);
  assert.match(summary, /^🧾 \*Nuevo pedido #56 — El Pollo Loco\*/);
});

test('respeta el encabezado del giro e incorpora el mismo ID', () => {
  const labels = { newOrderHeader: 'Nueva solicitud de servicio', pickupLabel: '🏢 En la oficina' };
  const summary = buildOrderText('Daddy RH', cart, customer, 'recoger', 'MXN', labels, 87);
  assert.match(summary, /^🧾 \*Nueva solicitud de servicio #87 — Daddy RH\*/);
});
