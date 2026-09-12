const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAiCatalogPrompt, moneyValue, normalizeAiCatalogProducts } = require('../src/utils/businessCatalog');

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

test('el prompt separa variantes, ingredientes incluidos y opciones elegibles', () => {
  const prompt = buildAiCatalogPrompt('restaurant', ['Hamburguesas']);
  assert.match(prompt, /UN solo producto base/);
  assert.match(prompt, /modifierGroups/);
  assert.match(prompt, /No conviertas la lista descriptiva de ingredientes incluidos en opciones/);
  assert.match(prompt, /minSelections\/maxSelections/);
});

test('normaliza productos completos con variantes y grupos de modificadores', () => {
  const [product] = normalizeAiCatalogProducts([{
    name: 'Hamburguesa',
    description: 'Carne, queso y pan',
    price: '$120.00',
    categoryName: 'Hamburguesas',
    variants: [{ name: 'Doble', price: '$165' }],
    modifierGroups: [{
      name: 'Quitar ingredientes',
      minSelections: 0,
      maxSelections: 2,
      options: [{ name: 'Sin cebolla', extraPrice: 0 }, { name: 'Sin tomate', extra_price: 0 }],
    }],
  }]);

  assert.equal(product.price, 120);
  assert.deepEqual(product.variants, [{ name: 'Doble', price: 165 }]);
  assert.equal(product.modifierGroups[0].maxSelections, 2);
  assert.equal(product.modifierGroups[0].options.length, 2);
});

test('consolida el formato anterior de una fila por variante', () => {
  const products = normalizeAiCatalogProducts([
    { name: 'Pizza chica', variantGroup: 'Pizza', variantName: 'Chica', price: 100, categoryName: 'Pizzas' },
    { name: 'Pizza grande', variantGroup: 'Pizza', variantName: 'Grande', price: 180, categoryName: 'Pizzas' },
  ]);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, 'Pizza');
  assert.deepEqual(products[0].variants.map((item) => item.name), ['Chica', 'Grande']);
});

test('reconoce variantes repetidas por tamaño sin recortar un producto aislado', () => {
  const products = normalizeAiCatalogProducts([
    { name: 'Pizza chica', price: 100, categoryName: 'Pizzas' },
    { name: 'Pizza grande', price: 180, categoryName: 'Pizzas' },
    { name: 'Alitas 12 pzas', price: 150, categoryName: 'Alitas' },
  ]);
  assert.equal(products[0].name, 'Pizza');
  assert.deepEqual(products[0].variants.map((item) => item.name), ['chica', 'grande']);
  assert.equal(products[1].name, 'Alitas 12 pzas');
  assert.equal(products[1].variants.length, 0);
});

test('normaliza formatos monetarios comunes sin inventar negativos', () => {
  assert.equal(moneyValue('$1,299.50'), 1299.5);
  assert.equal(moneyValue('1.299,50'), 1299.5);
  assert.equal(moneyValue('-50'), 0);
});
