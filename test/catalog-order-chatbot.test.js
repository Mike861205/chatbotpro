const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCatalogSortMode, sortCatalogProducts } = require('../src/chatbot/engine');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('el orden del catálogo admite más vendidos, abecedario y categoría', () => {
  assert.equal(normalizeCatalogSortMode('top_sold'), 'top_sold');
  assert.equal(normalizeCatalogSortMode('alphabetical'), 'alphabetical');
  assert.equal(normalizeCatalogSortMode('category'), 'category');
  assert.equal(normalizeCatalogSortMode('invalid'), 'top_sold');

  const products = [
    { id: 1, name: 'Zeta', category: 'Bebidas', category_sort: 2 },
    { id: 2, name: 'Alfa', category: 'Comida', category_sort: 1 },
    { id: 3, name: 'Beta', category: 'Comida', category_sort: 1 },
  ];
  assert.deepEqual(sortCatalogProducts(products, 'alphabetical').map((item) => item.id), [2, 3, 1]);
  assert.deepEqual(sortCatalogProducts(products, 'category').map((item) => item.id), [2, 3, 1]);
  assert.deepEqual(
    sortCatalogProducts(products, 'top_sold', new Map([[1, 4], [2, 9], [3, 2]])).map((item) => item.id),
    [2, 1, 3]
  );
});

test('el menú completo del asistente usa la preferencia del tenant y muestra grupos por categoría', () => {
  const appHtml = read('public', 'app.html');
  const chatHtml = read('public', 'chat.html');
  const engine = read('src', 'chatbot', 'engine.js');
  const settings = read('src', 'routes', 'settings.js');

  assert.match(appHtml, /option value="category">Por categoría<\/option>/);
  assert.match(engine, /showFullMenu\s*\?\s*normalizeCatalogSortMode\(await getSetting\(t, 'pos_catalog_sort_mode', 'top_sold'\)\)/);
  assert.match(engine, /orderFullMenuCatalog\(t, products, normalizedMode\)/);
  assert.match(chatHtml, /data\.catalogSortMode === 'category'/);
  assert.match(chatHtml, /product-category-heading/);
  assert.match(settings, /\['top_sold', 'alphabetical', 'category'\]/);
});
