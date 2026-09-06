const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAiCatalogPrompt } = require('../src/utils/businessCatalog');

test('el importador IA usa instrucciones del giro seleccionado', () => {
  const travel = buildAiCatalogPrompt('travel_agency', ['Tours']);
  const furniture = buildAiCatalogPrompt('furniture', ['Salas']);
  const health = buildAiCatalogPrompt('health', ['Estudios']);

  assert.match(travel, /agencia de viajes/);
  assert.match(travel, /paquete, tour, traslado o servicio reservable/);
  assert.doesNotMatch(travel, /menú de restaurante/);
  assert.match(furniture, /medidas, materiales, colores o acabados/);
  assert.match(health, /no inventes diagnósticos/);
});

test('un giro desconocido conserva el comportamiento de restaurante', () => {
  assert.match(buildAiCatalogPrompt('otro', []), /menú de restaurante o cafetería/);
});