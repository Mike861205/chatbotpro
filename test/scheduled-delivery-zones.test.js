const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDeliveryZones, resolveDeliveryFee } = require('../src/chatbot/engine');

const engineSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'chatbot', 'engine.js'), 'utf8');

test('calcula el cargo y la sucursal usando las coordenadas dentro del polígono del tenant', async () => {
  const zones = parseDeliveryZones(JSON.stringify([{
    id: 'zona-centro',
    name: 'Zona Centro',
    fee: 45,
    branchId: 7,
    branchName: 'Sucursal Marina',
    active: true,
    points: [
      [22.89, -109.94],
      [22.89, -109.90],
      [22.93, -109.90],
      [22.93, -109.94],
    ],
  }]));

  const quote = await resolveDeliveryFee(
    { lat: 22.90219, lng: -109.92105 },
    'Domicilio de prueba',
    [],
    zones
  );

  assert.deepEqual(quote, {
    fee: 45,
    zoneName: 'Zona Centro',
    branchId: 7,
    branchName: 'Sucursal Marina',
    resolvedLabel: 'Zona Centro',
  });
});

test('una coordenada fuera de las zonas no obtiene cargo ni cobertura', async () => {
  const zones = parseDeliveryZones(JSON.stringify([{
    name: 'Zona Centro',
    fee: 45,
    active: true,
    points: [[22.89, -109.94], [22.89, -109.90], [22.93, -109.90], [22.93, -109.94]],
  }]));

  const quote = await resolveDeliveryFee({ lat: 23.1, lng: -109.7 }, '', [], zones);
  assert.equal(quote.fee, 0);
  assert.equal(quote.zoneName, '');
});

test('pedidos normales y programados revalidan la zona antes de guardarse', () => {
  assert.match(engineSource, /const deliveryCoordinatesRequired = activeDeliveryZones\.length > 0/);
  assert.match(engineSource, /if \(state\.step === 'confirm'\)[\s\S]+const deliveryQuote = await refreshDeliveryQuote\(\)/);
  assert.match(engineSource, /requestValidDeliveryLocation\(deliveryQuote\.reason\)/);
  assert.match(engineSource, /const total = subtotal \+ deliveryFee[\s\S]+state\.customer\.scheduledFor \|\| null/);
  assert.match(engineSource, /!deliveryCoordinatesRequired \? \[\{ label: 'Omitir', value: 'skip_location' \}\] : \[\]/);
});
