const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
const analysisStart = app.indexOf('function costingCatalogAnalysis(rows) {');
const renderStart = app.indexOf('function renderCostingStats() {', analysisStart);
const renderEnd = app.indexOf('function populateCostingFilters() {', renderStart);
const analysisSource = app.slice(analysisStart, renderStart);
const renderSource = app.slice(renderStart, renderEnd);

const products = [
  { id: 1, active: 1, salePrice: 200, unitCost: 80 },
  { id: 2, active: 1, salePrice: 100, unitCost: 70 },
  { id: 3, active: 1, salePrice: 90, unitCost: 0 },
  { id: 4, active: 0, salePrice: 500, unitCost: 300 },
];

test('explica cada $100 con precios y costos configurados, excluyendo faltantes e inactivos', () => {
  const analyze = vm.runInNewContext(`${analysisSource}; costingCatalogAnalysis`);
  const result = analyze(products);
  assert.equal(result.saleTotal, 300);
  assert.equal(result.costTotal, 150);
  assert.equal(result.profitTotal, 150);
  assert.equal(result.costPerHundred, 50);
  assert.equal(result.profitPerHundred, 50);
  assert.equal(result.configuredCount, 2);
  assert.equal(result.missingCostCount, 1);
  assert.equal(result.activeCount, 3);
});

test('la explicación visible muestra el ejemplo con las cifras del tenant y los costos faltantes', () => {
  const hosts = { '#costingStats': { innerHTML: '' }, '#costingExplanation': { innerHTML: '' } };
  const context = {
    $: (selector) => hosts[selector],
    costingFilteredProducts: () => products,
    COSTING_DRAFT: new Map(),
    COSTING_DIRTY: new Set(),
    fmtMoney: (value) => `$${Number(value).toFixed(2)}`,
  };
  vm.runInNewContext(`${analysisSource}\n${renderSource}; renderCostingStats()`, context);
  assert.match(html, /id="costingExplanation"/);
  assert.match(hosts['#costingExplanation'].innerHTML, /Por cada \$100\.00/);
  assert.match(hosts['#costingExplanation'].innerHTML, /\$50\.00.*costo de tus productos o insumos/);
  assert.match(hosts['#costingExplanation'].innerHTML, /cobras <strong>\$300\.00<\/strong>, pagas <strong>\$150\.00/);
  assert.match(hosts['#costingExplanation'].innerHTML, /Faltan costos en 1 artículo/);
  assert.match(hosts['#costingStats'].innerHTML, /Margen del catálogo[\s\S]*50\.0%/);
});

test('si los costos superan el precio, muestra pérdida por cada $100', () => {
  const analyze = vm.runInNewContext(`${analysisSource}; costingCatalogAnalysis`);
  const result = analyze([{ id: 1, active: 1, salePrice: 80, unitCost: 100 }]);
  assert.equal(result.costPerHundred, 125);
  assert.equal(result.profitPerHundred, -25);
  assert.equal(result.lossCount, 1);
});
