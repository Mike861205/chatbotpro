const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCustomPaymentMethods, parseCustomPaymentMethods } = require('../src/utils/paymentMethods');

const root = path.join(__dirname, '..');

test('normaliza medios locales con identificadores estables y activación', () => {
  const methods = normalizeCustomPaymentMethods(JSON.stringify([
    { label: 'Pago Móvil', active: true },
    { label: 'Pix', active: false },
  ]));
  assert.deepEqual(methods, [
    { id: 'custom_pago_movil', label: 'Pago Móvil', active: true },
    { id: 'custom_pix', label: 'Pix', active: false },
  ]);
  assert.deepEqual(parseCustomPaymentMethods('contenido inválido'), []);
});

test('limita y valida el catálogo personalizado del tenant', () => {
  assert.throws(() => normalizeCustomPaymentMethods('[{"label":""}]'), /nombre/);
  assert.throws(
    () => normalizeCustomPaymentMethods(Array.from({ length: 16 }, (_, index) => ({ label: `Método ${index}` }))),
    /hasta 15/
  );
});

test('el catálogo local se conecta con configuración, chatbot y POS', () => {
  const settings = fs.readFileSync(path.join(root, 'src/routes/settings.js'), 'utf8');
  const chatbot = fs.readFileSync(path.join(root, 'src/chatbot/engine.js'), 'utf8');
  const pos = fs.readFileSync(path.join(root, 'src/routes/pos.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  assert.match(settings, /custom_payment_methods_json/);
  assert.match(chatbot, /enabledPaymentOptions\(chatPaymentDeliverySettings, customPaymentMethods\)/);
  assert.match(chatbot, /pay_custom_/);
  assert.match(pos, /normalizeTenantPayment/);
  assert.match(pos, /customPayments/);
  assert.match(pos, /GROUP BY payment_method/);
  assert.match(app, /activeCustomMethods/);
  assert.match(app, /Chatbot y POS/);
  assert.match(app, /totals\.customPayments/);
  assert.match(app, /payments\?\.custom/);
  assert.match(app, /method\.tickets/);
});
