const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

function captureHarness() {
  const elements = new Map();
  function $(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', textContent: '', events: {}, validation: '',
      addEventListener(type, listener) { this.events[type] = listener; },
      setCustomValidity(value) { this.validation = value; },
      reportValidity() { this.reported = true; },
      focus() { this.focused = true; }, select() { this.selected = true; },
    });
    return elements.get(selector);
  }
  const context = vm.createContext({ $, PRODUCTS_CACHE: [{ id: 1, name: 'Leche', barcode: '000123' }],
    normalizePosBarcode: (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, ''),
  });
  vm.runInContext(app.slice(app.indexOf('function syncProductBarcodeStatus('), app.indexOf('function openProdModal(')), context);
  return { $, context };
}

test('el botón enfoca y selecciona el campo del producto abierto sin borrar ni guardar', () => {
  const { $ } = captureHarness();
  $('#pBarcode').value = 'OLD123';
  $('#pBarcodeCapture').events.click();
  assert.equal($('#pBarcode').value, 'OLD123');
  assert.equal($('#pBarcode').focused, true);
  assert.equal($('#pBarcode').selected, true);
  assert.match($('#pBarcodeStatus').textContent, /Esperando el lector/);
});

test('Enter del lector conserva ceros, confirma captura y bloquea el envío accidental del formulario', () => {
  const { $ } = captureHarness();
  $('#pId').value = '2';
  $('#pBarcode').value = ' 000 456 ';
  let prevented = false;
  let stopped = false;
  $('#pBarcode').events.keydown({ key: 'Enter', currentTarget: $('#pBarcode'), preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal($('#pBarcode').value, '000456');
  assert.equal($('#pBarcode').validation, '');
  assert.match($('#pBarcodeStatus').textContent, /Código capturado.*Guardar/);
});

test('no acepta código duplicado de otro producto pero permite conservar el del producto editado', () => {
  const { $, context } = captureHarness();
  $('#pBarcode').value = '000123';
  $('#pId').value = '2';
  assert.equal(context.syncProductBarcodeStatus(), false);
  assert.match($('#pBarcode').validation, /Leche/);
  $('#pId').value = '1';
  assert.equal(context.syncProductBarcodeStatus(), true);
  assert.equal($('#pBarcode').validation, '');
  $('#pBarcode').value = '';
  assert.equal(context.syncProductBarcodeStatus(), true);
});

test('captura inválida pide corrección sin transformar el código en uno distinto', () => {
  const { $ } = captureHarness();
  $('#pBarcode').value = 'ABC@123';
  $('#pBarcode').events.keydown({ key: 'Enter', currentTarget: $('#pBarcode'), preventDefault() {}, stopPropagation() {} });
  assert.equal($('#pBarcode').value, 'ABC@123');
  assert.equal($('#pBarcode').reported, true);
  assert.match($('#pBarcode').validation, /3 a 64/);
});

test('el POS reconoce el código guardado sólo con el lector activo y sin modales ni cobro en curso', () => {
  const added = [];
  const input = { value: '000123' };
  const context = vm.createContext({
    POS_OVERVIEW: { products: [{ id: 7, barcode: '000123' }] }, POS_CHECKOUT_IN_FLIGHT: false,
    enabled: true, modalOpen: false, $: () => input,
    normalizePosBarcode: (value) => String(value || '').trim().toUpperCase().replace(/\s+/g, ''),
    barcodeFeatureEnabled: () => context.enabled,
    document: { querySelector: () => context.modalOpen },
    toast() {}, addPosProduct: (id) => added.push(id),
  });
  vm.runInContext(app.slice(app.indexOf('function addPosProductByBarcode('), app.indexOf("$('#posBarcodeInput')?.addEventListener('keydown'")), context);
  assert.equal(context.addPosProductByBarcode('000123'), true);
  assert.deepEqual(added, [7]);
  assert.equal(input.value, '');
  assert.equal(context.addPosProductByBarcode('999999'), false);
  context.enabled = false;
  assert.equal(context.addPosProductByBarcode('000123'), false);
  context.enabled = true;
  context.modalOpen = true;
  assert.equal(context.addPosProductByBarcode('000123'), false);
  context.modalOpen = false;
  context.POS_CHECKOUT_IN_FLIGHT = true;
  assert.equal(context.addPosProductByBarcode('000123'), false);
  assert.deepEqual(added, [7]);
});

test('un escaneo en el POS con un botón enfocado agrega el código y evita activar ese botón con Enter', () => {
  let listener;
  let tick = 1000;
  const added = [];
  const context = vm.createContext({
    CURRENT_VIEW: 'pos', POS_CHECKOUT_IN_FLIGHT: false, POS_BARCODE_BUFFER: '', POS_BARCODE_LAST_KEY_AT: 0,
    barcodeFeatureEnabled: () => true, Date: { now: () => (tick += 10) },
    document: { addEventListener: (_type, callback) => { listener = callback; }, querySelector: () => null },
    addPosProductByBarcode: (code) => added.push(code),
  });
  const start = app.indexOf("document.addEventListener('keydown'", app.indexOf("$('#posBarcodeInput')?.addEventListener('keydown'"));
  vm.runInContext(app.slice(start, app.indexOf('function moneyNum(', start)), context);
  let prevented = false;
  for (const key of [...'000123', 'Enter']) listener({ key, target: { matches: () => false }, preventDefault() { prevented = true; } });
  assert.deepEqual(added, ['000123']);
  assert.equal(prevented, true);
  assert.equal(context.POS_BARCODE_BUFFER, '');
});
