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

test('no inventa un código eliminando caracteres inválidos ni truncando dígitos', () => {
  for (const barcode of ['ABC@123', '1'.repeat(65)]) {
    const [product] = normalizeAiCatalogProducts([{ name: 'Leche', price: 25, barcode }]);
    assert.equal(product.barcode, '');
    assert.ok(product.warnings.some((warning) => /código de barras/.test(warning)));
    assert.throws(() => normalizeAiCatalogProducts([{ name: 'Leche', barcode }], { strictBarcodes: true }), /código de barras/);
  }
});

test('productos con distinto código no se mezclan en variantes ni se pierden al consolidar', () => {
  const products = normalizeAiCatalogProducts([
    { name: 'Leche chica', price: 20, barcode: '000123' },
    { name: 'Leche grande', price: 30, barcode: '000124' },
    { name: 'Pan', price: 15, barcode: '000125' },
    { name: 'Pan', price: 18, barcode: '000126' },
  ]);
  assert.equal(products.length, 4);
  assert.deepEqual(products.map((product) => product.barcode), ['000123', '000124', '000125', '000126']);
  assert.ok(products.every((product) => product.variants.length === 0));
});
