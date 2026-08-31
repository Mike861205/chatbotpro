const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeCustomPaymentMethods, normalizePaymentAccounts, parseCustomPaymentMethods } = require('../src/utils/paymentMethods');

const root = path.join(__dirname, '..');

test('normaliza medios locales con identificadores estables y activación', () => {
  const methods = normalizeCustomPaymentMethods(JSON.stringify([
    { label: 'Pago Móvil', active: true },
    { label: 'Pix', active: false },
  ]));
  assert.deepEqual(methods, [
    { id: 'custom_pago_movil', label: 'Pago Móvil', active: true, accountDetailsEnabled: false, accounts: [] },
    { id: 'custom_pix', label: 'Pix', active: false, accountDetailsEnabled: false, accounts: [] },
  ]);
  assert.deepEqual(parseCustomPaymentMethods('contenido inválido'), []);
});

test('permite cuentas configurables por cada medio de pago local', () => {
  const [method] = normalizeCustomPaymentMethods([{
    label: 'Pago Móvil',
    accountDetailsEnabled: true,
    accounts: [{
      bankName: 'Banco de Venezuela',
      holderName: 'Comercial Ejemplo',
      identifierType: 'phone',
      identifier: '+58 412-1234567',
    }],
  }]);
  assert.equal(method.accountDetailsEnabled, true);
  assert.deepEqual(method.accounts[0].fields, [
    { label: 'Banco o institución', value: 'Banco de Venezuela' },
    { label: 'Nombre del titular', value: 'Comercial Ejemplo' },
    { label: 'Teléfono', value: '+58 412-1234567' },
  ]);
  assert.throws(
    () => normalizeCustomPaymentMethods([{ label: 'Pago Móvil', accountDetailsEnabled: true, accounts: [] }]),
    /al menos una cuenta/
  );
  assert.deepEqual(normalizePaymentAccounts([{ fields: [
    { label: 'Entidad receptora', value: 'Banco Ejemplo' },
    { label: 'Cédula o RIF', value: 'V-12345678' },
    { label: 'Concepto', value: 'Pedido web' },
  ] }])[0].fields[2], { label: 'Concepto', value: 'Pedido web' });
  assert.throws(
    () => normalizePaymentAccounts([{ fields: [{ label: 'Referencia', value: '' }] }]),
    /título y la información/
  );
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
  assert.match(app, /data-custom-payment-accounts-enabled/);
  assert.match(chatbot, /attachAccountsForPayment/);
  assert.match(app, /totals\.customPayments/);
  assert.match(app, /payments\?\.custom/);
  assert.match(app, /method\.tickets/);
});
