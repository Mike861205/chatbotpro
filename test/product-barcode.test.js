const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeProductBarcode, isValidProductBarcode } = require('../src/utils/barcode');
const { normalizeAiCatalogProducts } = require('../src/utils/businessCatalog');

test('normaliza códigos de barras manuales y acepta formatos comunes', () => {
  assert.equal(normalizeProductBarcode(' 750 123 456 7890 '), '7501234567890');
  assert.equal(normalizeProductBarcode('ab-123'), 'AB-123');
  assert.equal(normalizeProductBarcode(''), null);
  assert.equal(isValidProductBarcode('7501234567890'), true);
  assert.equal(isValidProductBarcode('AB-123'), true);
  assert.equal(isValidProductBarcode('12'), false);
  assert.equal(isValidProductBarcode('ABC@123'), false);
});

test('conserva el código detectado por IA en cada producto', () => {
  const [product] = normalizeAiCatalogProducts([
    { name: 'Café', price: 45, categoryName: 'Bebidas', barcode: ' 750 123 456 7890 ' },
  ]);
  assert.equal(product.barcode, '7501234567890');
});
