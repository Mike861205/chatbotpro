const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function menuHandler(settings = { product_qr_enabled: '1' }) {
  const filename = path.join(root, 'src/routes/chatbot.js');
  const originalRequire = createRequire(filename);
  const module = { exports: {} };
  const middleware = (_req, _res, next) => next();
  const overrides = {
    '../db': {
      q: async () => ({ rows: [] }), tdb: () => ({}),
      getSetting: async (_db, key, fallback) => settings[key] ?? fallback,
    },
    '../utils/productTax': { loadProductTaxConfig: async () => ({ enabled: false }), effectiveProductPrice: (value) => value },
    '../utils/promotions': { getActivePromotions: async () => [], decorateCatalogProducts: (products) => products },
  };
  vm.runInNewContext(read('src', 'routes', 'chatbot.js'), {
    require: (name) => overrides[name] || originalRequire(name),
    module, exports: module.exports, console, process, Buffer,
  }, { filename });
  const route = module.exports.stack.find((layer) => layer.route?.path === '/:slug/menu');
  assert.ok(route);
  return route.route.stack.at(-1).handle;
}

async function callMenu(handler, query = {}, rows = []) {
  let catalogSql = '';
  const req = {
    query, tenant: { slug: 'tienda', business_name: 'Mi tienda', logo: '', primary_color: '#16a34a' },
    tdb: { timezone: 'America/Mexico_City', all: async (sql) => { catalogSql = sql; return rows; } },
  };
  const res = {
    statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  let error;
  await handler(req, res, (value) => { error = value; });
  assert.equal(error, undefined);
  res.catalogSql = catalogSql;
  return res;
}

test('menú QR público se apaga por tenant y no muestra productos ocultos', async () => {
  const disabled = await callMenu(menuHandler({ product_qr_enabled: '0' }));
  assert.equal(disabled.statusCode, 404);

  const rows = [
    { id: 7, name: 'Agua', price: 18, sale_days: '[]', category_name: 'Bebidas' },
    { id: 9, name: 'Taco', price: 25, sale_days: '[]', category_name: 'Comida' },
  ];
  const handler = menuHandler();
  const general = await callMenu(handler, {}, rows);
  assert.match(general.catalogSql, /WHERE p\.active = 1/);
  assert.deepEqual(Array.from(general.body.products, (product) => product.id), [7, 9]);
  assert.equal(general.body.products[0].availableToday, true);
  assert.equal(general.body.products[0].barcode, undefined);
  const single = await callMenu(handler, { producto: '9' }, rows);
  assert.deepEqual(Array.from(single.body.products, (product) => product.id), [9]);
  assert.equal((await callMenu(handler, { producto: '99' }, rows)).statusCode, 404);
  assert.equal((await callMenu(handler, { producto: 'invalid' }, rows)).statusCode, 404);
});

test('búsqueda del POS encuentra nombre, código de barras, clave SAT e ID', () => {
  const source = read('public', 'js', 'app.js');
  const code = source.slice(source.indexOf('function getVisiblePosProducts()'), source.indexOf('function syncPosCartFromCatalog()'));
  assert.ok(code.startsWith('function getVisiblePosProducts()'));
  const context = {
    POS_OVERVIEW: { products: [
      { id: 15, name: 'Agua mineral', barcode: '000123456', sat_product_code: '50202306' },
      { id: 17, name: 'Refresco', barcode: '789654123', sat_product_code: '50202301' },
    ], categories: [] },
    POS_CATEGORY_FILTER: 'all', POS_PRODUCT_SEARCH: '', POS_PRODUCT_SORT: 'alphabetical',
    sortCatalogItems: (items) => items,
    normalizePosBarcode: (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, ''),
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  for (const [query, id] of [['Agua', 15], ['000123', 15], ['50202301', 17], ['17', 17], ['015', 15]]) {
    context.POS_PRODUCT_SEARCH = query;
    assert.equal(context.getVisiblePosProducts()[0]?.id, id, query);
  }
});

test('el menú QR tiene ruta, página móvil y controles de impresión en Productos', () => {
  assert.match(read('server.js'), /app\.get\('\/menu\/:slug', validSlug, page\('menu\.html'\)\)/);
  assert.match(read('public', 'menu.html'), /@media\(max-width:640px\)/);
  assert.match(read('public', 'app.html'), /id="productQrEnabled"/);
  assert.match(read('public', 'app.html'), /id="generalProductQrBtn"/);
  assert.match(read('public', 'js', 'app.js'), /function productBarcodeHTML\(product\)/);
  assert.match(read('public', 'js', 'app.js'), /function productQrButtonHTML\(product\)/);
});
