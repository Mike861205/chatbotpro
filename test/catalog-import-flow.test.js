const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const XLSX = require('xlsx');
const sharp = require('sharp');

function routerHarness(aiProducts = []) {
  const filename = path.join(__dirname, '../src/routes/products.js');
  const originalRequire = createRequire(filename);
  const requests = [];
  const middleware = (_req, _res, next) => next();
  class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: async (request) => {
        requests.push(request);
        return { choices: [{ message: { content: JSON.stringify({ products: aiProducts, notes: [] }) } }] };
      } } };
    }
  }
  const overrides = {
    openai: FakeOpenAI,
    '../db': { getSetting: async (_db, _key, fallback) => fallback, getSuperAdminSetting: async (_key, fallback) => fallback },
    '../config': { OPENAI_API_KEY: 'test-not-a-real-key' },
    '../middleware/auth': { requireAuth: middleware, requireOwner: middleware, requireModules: () => middleware },
    '../utils/uploads': { ...originalRequire('../utils/uploads'), createImageUpload: () => ({ single: () => middleware, array: () => middleware }) },
  };
  const module = { exports: {} };
  const context = vm.createContext({
    require: (name) => overrides[name] || originalRequire(name), module, exports: module.exports,
    console, process, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const router = module.exports;
  async function call(route, req) {
    const entry = router.stack.find((layer) => layer.route?.path === route && layer.route.methods.post);
    let error;
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; }, setHeader() {} };
    await entry.route.stack.at(-1).handle(req, res, (value) => { error = value; });
    return { res, error };
  }
  return { call, requests };
}

test('Excel entra al análisis real del catálogo como filas y devuelve el código en la revisión editable', async () => {
  const { call, requests } = routerHarness([{ name: 'Leche', price: 25, categoryName: 'Bebidas', barcode: '0001234567890' }]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Producto', 'Precio', 'Barcode'], ['Leche', 25, '0001234567890']]), 'Productos');
  const { res, error } = await call('/ai/suggest', {
    files: [{ originalname: 'productos.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) }],
    tdb: { all: async () => [] },
  });
  assert.equal(error, undefined);
  assert.equal(res.body.products[0].barcode, '0001234567890');
  assert.equal(res.body.spreadsheetCount, 1);
  assert.equal(res.body.imageCount, 0);
  const content = requests[0].messages[1].content;
  assert.ok(content.some((part) => part.type === 'text' && part.text.includes('0001234567890')));
  assert.ok(!content.some((part) => part.type === 'image_url'));
});

test('las páginas PDF preparadas en memoria conservan el recorte de foto en el mismo flujo', async () => {
  const { call } = routerHarness([{ name: 'Leche', price: 25, barcode: '000123', imageRegion: { imageIndex: 0, x: 10, y: 10, width: 60, height: 60, confidence: 0.9 } }]);
  const buffer = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  const { res, error } = await call('/ai/suggest', { files: [{ originalname: 'menu.jpg', mimetype: 'image/jpeg', buffer }], tdb: { all: async () => [] } });
  assert.equal(error, undefined);
  assert.equal(res.body.croppedImageCount, 1);
  assert.match(res.body.products[0].imageCandidate.dataUrl, /^data:image\/webp;base64,/);
});

test('la importación guarda el código completo y permite productos del mismo nombre con códigos distintos', async () => {
  const { call } = routerHarness();
  const inserted = [];
  const tx = {
    all: async () => [],
    get: async (sql, params) => {
      if (/WHERE barcode/.test(sql)) return null;
      if (/INSERT INTO \{s\}\.products/.test(sql)) { inserted.push(params); return { id: inserted.length }; }
      throw new Error(`Consulta inesperada: ${sql}`);
    }, run: async () => {},
  };
  const { res, error } = await call('/ai/import', {
    body: { products: [{ name: 'Leche', price: 25, barcode: '000123' }, { name: 'Leche', price: 30, barcode: '000124' }] },
    files: [], tdb: { tx: async (callback) => callback(tx) },
  });
  assert.equal(error, undefined);
  assert.equal(res.body.created, 2);
  assert.deepEqual(inserted.map((params) => params[6]), ['000123', '000124']);
});

test('reimportar un producto existente con el mismo código lo omite sin fallar por duplicado', async () => {
  const { call } = routerHarness();
  let barcodeChecks = 0;
  const tx = {
    all: async (sql) => /categories/.test(sql) ? [] : [{ id: 1, name: 'Leche', category_id: null, barcode: '000123' }],
    get: async () => { barcodeChecks += 1; return { id: 1, name: 'Leche' }; }, run: async () => {},
  };
  const { res, error } = await call('/ai/import', { body: { products: [{ name: 'Leche', price: 25, barcode: '000123' }] }, files: [], tdb: { tx: async (callback) => callback(tx) } });
  assert.equal(error, undefined);
  assert.equal(res.body.skippedCount, 1);
  assert.equal(res.body.created, 0);
  assert.equal(barcodeChecks, 0);
});

test('el backend rechaza códigos inválidos antes de escribir y duplicados entre productos del tenant', async () => {
  const { call } = routerHarness();
  const req = { files: [], body: { products: [{ name: 'Leche', price: 25, barcode: 'ABC@123' }] }, tdb: { tx: async () => { throw new Error('No debe escribir'); } } };
  const invalid = await call('/ai/import', req);
  assert.equal(invalid.error.statusCode, 400);
  req.body.products[0].barcode = '000123';
  req.tdb.tx = async (callback) => callback({ all: async () => [], get: async () => ({ id: 2, name: 'Pan' }) });
  const duplicate = await call('/ai/import', req);
  assert.equal(duplicate.error.statusCode, 409);
  assert.match(duplicate.error.message, /Pan/);
});
