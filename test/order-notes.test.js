const test = require('node:test');
const assert = require('node:assert/strict');
const { operationalOrderNote } = require('../src/utils/orderNotes');

test('usa la nota operativa separada en pedidos de chatbot', () => {
  const note = operationalOrderNote({
    channel: 'chatbot',
    notes: 'Casa azul frente al parque',
    order_notes: 'Sin cebolla y salsa aparte',
  });
  assert.equal(note, 'Sin cebolla y salsa aparte');
});

test('no confunde la referencia de entrega del chatbot con una nota de cocina', () => {
  assert.equal(operationalOrderNote({ channel: 'chatbot', notes: 'Portón negro' }), '');
});

test('mantiene compatibilidad con notas históricas del punto de venta', () => {
  assert.equal(operationalOrderNote({ channel: 'pos', notes: 'Término medio' }), 'Término medio');
  assert.equal(operationalOrderNote({ channel: 'table_round', notes: 'Bebidas sin hielo' }), 'Bebidas sin hielo');
});
