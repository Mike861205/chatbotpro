const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizePrinterConfig } = require('../src/utils/printerConfig');
const { signQzRequest } = require('../src/utils/qzSigning');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('normaliza impresoras directas y limita copias y destinos', () => {
  const config = normalizePrinterConfig({
    mode: 'qz',
    printers: [
      { id: 'Caja USB', label: 'Caja', name: 'POS-80', copies: 8, destinations: ['ticket', 'ticket', 'invalid'] },
      { id: 'cocina', label: 'Cocina', name: 'BT-58', branchId: 4, widthMm: 58, destinations: ['area:12'] },
    ],
  });

  assert.equal(config.mode, 'qz');
  assert.equal(config.printers[0].id, 'cajausb');
  assert.equal(config.printers[0].copies, 3);
  assert.deepEqual(config.printers[0].destinations, ['ticket']);
  assert.equal(config.printers[1].branchId, 4);
  assert.equal(config.printers[1].widthMm, 58);
});

test('rechaza impresión directa sin impresoras o sin destinos', () => {
  assert.throws(() => normalizePrinterConfig({ mode: 'qz', printers: [] }), /Agrega al menos una impresora/);
  assert.throws(
    () => normalizePrinterConfig({ mode: 'qz', printers: [{ name: 'Cocina', destinations: [] }] }),
    /Asigna al menos un destino/
  );
});

test('firma únicamente operaciones QZ de impresión permitidas', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const request = JSON.stringify({ call: 'print', params: { printer: { name: 'Caja' } }, timestamp: Date.now() });
  const signature = signQzRequest(request, privateKey);

  assert.equal(crypto.verify('RSA-SHA512', Buffer.from(request), publicKey, Buffer.from(signature, 'base64')), true);
  assert.throws(() => signQzRequest(JSON.stringify({ call: 'file.write', params: {} }), privateKey), /no permitida/);
  assert.throws(() => signQzRequest('not-json', privateKey), /inválida/);
});

test('expone QZ Tray y la configuración de impresoras por tenant', () => {
  const html = read('public/app.html');
  const server = read('server.js');
  const settings = read('src/routes/settings.js');
  const printing = read('src/routes/printing.js');

  assert.match(html, /id="cfgDirectPrintMode"/);
  assert.match(html, /id="directPrinterList"/);
  assert.match(html, /https:\/\/qz\.io\/download\//);
  assert.match(html, /\/static\/vendor\/qz-tray\.js/);
  assert.match(server, /app\.get\('\/static\/vendor\/qz-tray\.js'/);
  assert.match(server, /app\.use\('\/api\/printing'/);
  assert.match(printing, /signQzRequest\(request, privateKey\)/);
  assert.match(settings, /'multi_printer_config_json'/);
  assert.match(settings, /normalizePrinterConfig\(body\.multi_printer_config_json\)/);
});

test('despacha el cobro y las comandas por QZ respetando áreas y sucursal', () => {
  const client = read('public/js/app.js');
  const orders = read('src/routes/orders.js');

  assert.match(client, /async function dispatchDirectPrint\(/);
  assert.match(client, /function printersForDestination\(/);
  assert.match(client, /printersForDestination\(printers, 'ticket', branchId\)/);
  assert.match(client, /return branchPrinters\.length \? branchPrinters : assigned\.filter/);
  assert.match(client, /`area:\$\{area\.id\}`/);
  assert.match(client, /if \(LAST_POS_SALE\) printPosSaleOutputs\(\)/);
  assert.match(client, /openOrderComandaPrintWindowBrowser\(order\)/);
  assert.match(orders, /a\.branch_id IS NULL OR a\.branch_id = COALESCE\(\$1::int, \$2::int\)/);
  assert.match(orders, /ORDER BY \(a\.branch_id IS NULL\) ASC/);
});
