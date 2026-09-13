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
  assert.match(prompt, /Piña habanero, BBQ, Picositas/);
  assert.match(prompt, /lista vertical de sabores\/salsas\/tipos alternativos/);
  assert.match(prompt, /sección independiente “Extras” o “Adicionales”/);
  assert.match(prompt, /prioriza siempre el documento real/);
  assert.match(prompt, /No uses una sola categoría genérica/);
  assert.match(prompt, /Combo\/Mix en “Combos”/);
  assert.match(prompt, /Para imageRegion usa coordenadas porcentuales 0-100/);
});

test('normaliza una región de foto del menú sin confundir porcentajes con escala unitaria', () => {
  const [percentProduct, unitProduct] = normalizeAiCatalogProducts([
    { name: 'Alitas', categoryName: 'Alitas', price: 169, imageIndex: 0, imageRegion: { x: 1, y: 5, width: 30, height: 25, confidence: 0.9 } },
    { name: 'Hamburguesa', categoryName: 'Hamburguesas', price: 139, imageRegion: { imageIndex: 1, x: 0.1, y: 0.2, width: 0.4, height: 0.5 } },
  ]);
  assert.deepEqual(percentProduct.imageRegion, { imageIndex: 0, x: 1, y: 5, width: 30, height: 25, confidence: 0.9 });
  assert.deepEqual(unitProduct.imageRegion, { imageIndex: 1, x: 10, y: 20, width: 40, height: 50, confidence: 0.7 });
});

test('reclasifica categorías genéricas usando el producto y la sección real del menú', () => {
  const products = normalizeAiCatalogProducts([
    { name: 'Alitas', categoryName: 'Comida Rápida', sourceSection: 'ALITAS', price: 169 },
    { name: 'Hamburguesa y Papas', categoryName: 'Comida Rápida', sourceSection: 'HAMBURGUESA Y PAPAS', price: 139 },
    { name: 'Orden de Pollo', categoryName: 'Comida Rápida', sourceSection: 'ORDEN DE POLLO', price: 169 },
    { name: 'Mix Daddy', categoryName: 'Comida Rápida', sourceSection: 'MIX DADDY', price: 259 },
    { name: 'Combo Daddy', categoryName: 'Comida Rápida', sourceSection: 'COMBO DADDY', price: 419 },
    { name: 'Aros de Cebolla', categoryName: 'Comida Rápida', sourceSection: 'EXTRAS', price: 89 },
    { name: 'Orden de Costilla BBQ', categoryName: 'Comida Rápida', sourceSection: 'COSTILLAS', price: 199 },
    { name: 'Refresco', categoryName: 'General', sourceSection: 'BEBIDAS', price: 35 },
    { name: 'Pastel de chocolate', categoryName: 'Menú', sourceSection: 'POSTRES', price: 75 },
  ], { inferCategories: true });

  assert.deepEqual(products.map((product) => product.categoryName), [
    'Alitas', 'Hamburguesas', 'Pollo y papas', 'Combos', 'Combos', 'Extras', 'Costillas', 'Bebidas', 'Postres',
  ]);
});

test('conserva una categoría específica elegida por IA o editada por el tenant', () => {
  const [product] = normalizeAiCatalogProducts([{
    name: 'Alitas', categoryName: 'Promoción del viernes', price: 169,
  }], { inferCategories: true });
  assert.equal(product.categoryName, 'Promoción del viernes');
});

test('recupera listas directas de salsas o sabores como opciones seleccionables', () => {
  const [product] = normalizeAiCatalogProducts([{
    name: 'Alitas',
    price: 169,
    categoryName: 'Alitas',
    salsas: ['Piña habanero', 'BBQ', 'Picositas', 'Ajo parmesano', 'Pimienta limón', 'Mango habanero', 'Tamarindo'],
  }]);
  assert.equal(product.modifierGroups.length, 1);
  assert.equal(product.modifierGroups[0].name, 'Elige tu salsa');
  assert.equal(product.modifierGroups[0].minSelections, 1);
  assert.equal(product.modifierGroups[0].maxSelections, 1);
  assert.deepEqual(product.modifierGroups[0].options.map((option) => option.name), [
    'Piña habanero', 'BBQ', 'Picositas', 'Ajo parmesano', 'Pimienta limón', 'Mango habanero', 'Tamarindo',
  ]);
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
