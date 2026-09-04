const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeProductTaxConfig,
  effectiveProductPrice,
  productTaxLineSnapshot,
  applyProductTaxToCatalogProduct,
} = require('../src/utils/productTax');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('IVA desactivado conserva exactamente el precio capturado', () => {
  const config = normalizeProductTaxConfig({ enabled: false, mode: 'added', rate: 0.16 });
  assert.equal(effectiveProductPrice(100, config), 100);
  assert.deepEqual(productTaxLineSnapshot(100, config), {});
});

test('IVA agregado suma la tasa manual al precio capturado', () => {
  const config = normalizeProductTaxConfig({ enabled: true, mode: 'added', rate: 0.16 });
  assert.equal(effectiveProductPrice(100, config), 116);
  assert.deepEqual(productTaxLineSnapshot(116, config), {
    taxEnabled: true,
    taxMode: 'added',
    taxRate: 0.16,
    taxBasePrice: 100,
    taxAmount: 16,
  });
});

test('IVA incluido conserva el precio y desglosa base e impuesto', () => {
  const config = normalizeProductTaxConfig({ enabled: true, mode: 'included', rate: 0.16 });
  assert.equal(effectiveProductPrice(100, config), 100);
  assert.deepEqual(productTaxLineSnapshot(100, config), {
    taxEnabled: true,
    taxMode: 'included',
    taxRate: 0.16,
    taxBasePrice: 86.21,
    taxAmount: 13.79,
  });
});

test('aplica IVA agregado a productos, variantes y modificadores del catálogo', () => {
  const product = applyProductTaxToCatalogProduct({
    id: 1,
    price: 100,
    variants: [{ id: 2, price: 150 }],
    modifierGroups: [{ id: 3, options: [{ id: 4, extra_price: 10 }] }],
  }, { enabled: true, mode: 'added', rate: 0.16 });
  assert.equal(product.price, 116);
  assert.equal(product.variants[0].price, 174);
  assert.equal(product.modifierGroups[0].options[0].extra_price, 11.6);
});

test('el panel permite activar IVA, elegir ambos modos y capturar la tasa manual', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src', 'routes', 'settings.js'), 'utf8');
  for (const id of ['cfgProductTaxEnabled', 'cfgProductTaxRate', 'cfgProductTaxPreview']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /data-product-tax-mode="added"/);
  assert.match(html, /data-product-tax-mode="included"/);
  assert.ok(html.indexOf('id="productTaxForm"') > html.indexOf('id="view-productos"'));
  assert.ok(html.indexOf('id="productTaxForm"') < html.indexOf('id="view-costos"'));
  assert.match(client, /async function saveProductTaxConfig/);
  assert.match(client, /cfgProductTaxEnabled'\)\?\.addEventListener\('change', async/);
  assert.match(client, /fd\.append\('product_tax_rate', String\(ratePercent \/ 100\)\)/);
  assert.match(settings, /'product_tax_enabled'/);
  assert.match(settings, /'product_tax_mode'/);
  assert.match(settings, /'product_tax_rate'/);
});

test('los cortes acumulan y muestran el IVA congelado de las líneas POS', () => {
  const route = read('src/routes/pos.js');
  const client = read('public/js/app.js');
  assert.match(route, /const taxRows = await t\.all/);
  assert.match(route, /line\?\.taxEnabled !== true/);
  assert.match(route, /productTax: \{/);
  assert.match(client, /Base gravable productos/);
  assert.match(client, /IVA productos/);
});