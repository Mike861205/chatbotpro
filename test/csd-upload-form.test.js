const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
const start = source.indexOf("$('#fiscalCsdForm')?.addEventListener('submit'");
const end = source.indexOf('async function openPosInvoiceModal(', start);
assert.ok(start >= 0 && end > start);

function uploadHarness(response) {
  let submit;
  let resetCount = 0;
  let reloadCount = 0;
  const messages = [];
  const button = { disabled: false };
  const form = {
    querySelector: () => button,
    reset: () => { resetCount += 1; },
  };
  const event = { currentTarget: form, preventDefault() {} };
  const context = {
    $: () => ({ addEventListener: (_type, handler) => { submit = handler; } }),
    FormData: class { constructor(target) { assert.equal(target, form); } },
    getAuthScope: () => '',
    fetch: async () => { event.currentTarget = null; return response; },
    toast: (message, error) => messages.push({ message, error: Boolean(error) }),
    loadInvoicing: async () => { reloadCount += 1; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { submit: () => submit(event), button, messages, get resetCount() { return resetCount; }, get reloadCount() { return reloadCount; } };
}

test('la carga exitosa conserva el formulario tras await y actualiza la pantalla', async () => {
  const ui = uploadHarness({ ok: true, json: async () => ({ legalName: 'DANIEL RODRIGUEZ RODRIGUEZ' }) });
  await ui.submit();
  assert.equal(ui.resetCount, 1);
  assert.equal(ui.reloadCount, 1);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.messages.length, 1);
  assert.equal(ui.messages[0].error, false);
  assert.match(ui.messages[0].message, /Sellos digitales cargados/);
});

test('una respuesta 422 muestra el error y conserva los archivos seleccionados', async () => {
  const ui = uploadHarness({ ok: false, json: async () => ({ error: 'El CSD ya existe' }) });
  await ui.submit();
  assert.equal(ui.resetCount, 0);
  assert.equal(ui.reloadCount, 0);
  assert.equal(ui.button.disabled, false);
  assert.deepEqual(ui.messages, [{ message: 'El CSD ya existe', error: true }]);
});

test('la pantalla de facturación dedicada tampoco pierde el formulario tras await', async () => {
  const dedicatedSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/invoicing-app.js'), 'utf8');
  const dedicatedStart = dedicatedSource.indexOf("$('#csdForm').addEventListener('submit'");
  const dedicatedEnd = dedicatedSource.indexOf("$('#identityForm').addEventListener('submit'", dedicatedStart);
  assert.ok(dedicatedStart >= 0 && dedicatedEnd > dedicatedStart);
  let submit;
  let resetCount = 0;
  let initialized = 0;
  let view = '';
  const messages = [];
  const form = { reset: () => { resetCount += 1; } };
  const event = { currentTarget: form, preventDefault() {} };
  const context = {
    $: () => ({ addEventListener: (_type, handler) => { submit = handler; } }),
    FormData: class { constructor(target) { assert.equal(target, form); } },
    api: async () => { event.currentTarget = null; return { ok: true }; },
    toast: (message, error) => messages.push({ message, error: Boolean(error) }),
    initialize: async () => { initialized += 1; },
    setView: (value) => { view = value; },
  };
  vm.runInNewContext(dedicatedSource.slice(dedicatedStart, dedicatedEnd), context);

  await submit(event);

  assert.equal(resetCount, 1);
  assert.equal(initialized, 1);
  assert.equal(view, 'settings');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].error, false);
});
