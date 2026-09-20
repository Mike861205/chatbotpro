const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBusinessSystemPrompt, buildOrderText, defaultReceivingModes, getLabels, parseCashAmount } = require('../src/chatbot/engine');

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

test('agrega al resumen la información de cambio sin alterar el total', () => {
  const summary = buildOrderText('Negocio', [{ qty: 1, name: 'Producto', price: 45 }], {
    ...customer,
    cashChangePreference: 'change',
    cashTendered: 50,
  }, 'recoger', 'USD', undefined, 88);
  assert.match(summary, /\*Total: USD\s?45\.00\*/);
  assert.match(summary, /Pagará con: USD\s?50\.00/);
  assert.match(summary, /Cambio \/ vuelto: USD\s?5\.00/);
});

test('el resumen indica cuando el pago en efectivo será exacto', () => {
  const summary = buildOrderText('Negocio', cart, {
    ...customer,
    cashChangePreference: 'exact',
  }, 'recoger', 'MXN');
  assert.match(summary, /Cambio \/ vuelto: No ocupa; pagará exacto/);
});

test('entiende montos de efectivo escritos con números o letras', () => {
  assert.equal(parseCashAmount('50'), 50);
  assert.equal(parseCashAmount('$1,250.50 USD'), 1250.5);
  assert.equal(parseCashAmount('mil doscientos cincuenta'), 1250);
  assert.equal(parseCashAmount('cincuenta punto cincuenta'), 50.5);
});

test('cada giro presenta su catalogo con lenguaje propio', () => {
  const expected = {
    restaurant: 'Ver menú',
    furniture: 'Ver catálogo',
    travel_agency: 'Ver paquetes',
    office_services: 'Ver servicios',
    screen_printing: 'Ver catálogo',
    carpentry: 'Ver catálogo',
    health: 'Ver servicios',
    dentist: 'Ver tratamientos',
  };

  for (const [businessType, buttonText] of Object.entries(expected)) {
    assert.match(getLabels(businessType).browseButton, new RegExp(buttonText));
    assert.match(buildBusinessSystemPrompt(businessType, 'Negocio prueba', 'Elemento $100'), /Negocio prueba/);
  }
});

test('solo restaurante ofrece comer en sucursal como modalidad predeterminada', () => {
  const flags = { deliveryEnabled: true, pickupEnabled: true, dineInEnabled: true };
  const restaurantModes = defaultReceivingModes('restaurant', getLabels('restaurant'), flags);
  const travelModes = defaultReceivingModes('travel_agency', getLabels('travel_agency'), flags);

  assert.ok(restaurantModes.some((mode) => mode.id === 'comer_sucursal'));
  assert.ok(!travelModes.some((mode) => mode.id === 'comer_sucursal'));
  assert.match(getLabels('travel_agency').confirmQuestion, /reservación/);
  assert.match(getLabels('dentist').confirmQuestion, /cita dental/);
});
