const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../src/routes/whatsappBot');

test('plantillas preservan variables pendientes y sustituyen sólo claves exactas', () => {
  const body = 'Hola {nombre}, pedido {pedido}. {desconocida}';
  assert.deepEqual(route.variables(body), ['nombre', 'pedido', 'desconocida']);
  assert.equal(route.renderTemplate(body, { nombre: 'Ana', pedido: 42 }), 'Hola Ana, pedido 42. {desconocida}');
  assert.equal(route.renderTemplate('{nombre} {nombre_completo}', { nombre: 'Ana' }), 'Ana {nombre_completo}');
});

test('las elecciones del catálogo conservan comandos del motor y límite de 30', () => {
  const choices = route.replyChoices({
    products: [{ id: 8, name: 'Tacos', priceLabel: '$50' }],
    options: [{ label: 'Comparte tu ubicación', value: 'share_location' }, { label: 'Volver', value: 'menu' }],
  });
  assert.deepEqual(choices, [
    { label: 'Tacos · $50', value: 'prod_8' },
    { label: 'Volver', value: 'menu' },
  ]);
  assert.equal(route.replyChoices({ products: Array.from({ length: 40 }, (_, id) => ({ id, name: `P${id}` })) }).length, 30);
});

test('la confirmación usa envío y total reales y señala una tarifa pendiente', () => {
  const order = {
    id: 42, items: JSON.stringify([{ qty: 2, name: 'Tacos' }]), subtotal: 100, delivery_fee: 35,
    total: 135, delivery: 'domicilio', receiving_mode_behavior: 'delivery',
    delivery_address: 'Calle 1', delivery_zone_name: 'Centro',
    customer_location_lat: 28.633, customer_location_lng: -106.069,
  };
  const values = route.orderTemplateValues(order, { businessName: 'Mi negocio', currency: 'MXN' });
  assert.equal(values.envio, '$35.00');
  assert.equal(values.total, '$135.00');
  assert.match(values.ubicacion, /28\.633,-106\.069/);
  assert.match(values.productos, /2x Tacos/);
  const pending = route.orderTemplateValues({ ...order, delivery_fee: 0, total: 100, delivery_zone_name: 'Pendiente de validar' }, { businessName: 'Mi negocio', currency: 'MXN' });
  assert.equal(pending.envio, 'Por confirmar');
  assert.match(pending.total, /envío por confirmar/);
});

test('las plantillas automáticas sólo aceptan variables disponibles en su momento', () => {
  assert.equal(route.validateAutomaticTemplate('location_request', 'Ubicación para {negocio}'), '');
  assert.match(route.validateAutomaticTemplate('location_request', 'Total {total}'), /total/);
  assert.equal(route.validateAutomaticTemplate('order_confirmation', '{nombre}: {subtotal} + {envio} = {total}'), '');
});
