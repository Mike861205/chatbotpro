const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { paymentFormFromSale } = require('../src/utils/invoicing');

const root = path.join(__dirname, '..');
const portal = fs.readFileSync(path.join(root, 'public/js/invoice.js'), 'utf8');
const portalStart = portal.indexOf('function configureTicketPayment(');
const portalEnd = portal.indexOf('function invoiceDownloads(', portalStart);
assert.ok(portalStart >= 0 && portalEnd > portalStart);
const elements = Object.fromEntries([
  '#receiverPaymentFormRow', '#receiverPaymentForm', '#receiverPaymentFormLabel', '#receiverPaymentFormHint',
].map((id) => [id, { hidden: false, required: false, value: '', innerHTML: '', textContent: '' }]));
const portalContext = { $: (id) => elements[id] };
vm.runInNewContext(`${portal.slice(portalStart, portalEnd)}\nthis.configureTicketPayment = configureTicketPayment;`, portalContext);

const routes = fs.readFileSync(path.join(root, 'src/routes/invoicing.js'), 'utf8');
const routeStart = routes.indexOf('function requirePublicPlatformPaymentForm(');
const routeEnd = routes.indexOf('async function issueSaleInvoice(', routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
const routeContext = {};
vm.runInNewContext(`${routes.slice(routeStart, routeEnd)}\nthis.requireForm = requirePublicPlatformPaymentForm;`, routeContext);

test('el QR exige elegir el medio real de una venta Plataforma sin asignar 31 en silencio', () => {
  portalContext.configureTicketPayment({ paymentMethod: 'platform', paymentForm: '31' });
  assert.equal(elements['#receiverPaymentFormRow'].hidden, false);
  assert.equal(elements['#receiverPaymentForm'].required, true);
  assert.equal(elements['#receiverPaymentForm'].value, '');
  assert.match(elements['#receiverPaymentForm'].innerHTML, /value="28"/);
  assert.match(elements['#receiverPaymentForm'].innerHTML, /value="04"/);
  assert.match(elements['#receiverPaymentForm'].innerHTML, /value="31"/);
});

test('el servidor acepta débito, crédito o intermediario sólo cuando el QR lo confirma', () => {
  const sale = { payment_method: 'platform', total: 199 };
  assert.throws(() => routeContext.requireForm(sale, '', true), /Confirma cómo se pagó/);
  assert.throws(() => routeContext.requireForm(sale, '01', true), /Confirma cómo se pagó/);
  for (const code of ['28', '04', '03', '31']) {
    assert.doesNotThrow(() => routeContext.requireForm(sale, code, true));
    assert.equal(paymentFormFromSale(sale, '04', code), code);
  }
  assert.doesNotThrow(() => routeContext.requireForm(sale, '', false));
});

test('una venta con tarjeta conserva el selector anterior y su tipo registrado', () => {
  portalContext.configureTicketPayment({ paymentMethod: 'card', paymentBreakdown: { cardType: 'debit' } });
  assert.equal(elements['#receiverPaymentForm'].value, '28');
  assert.equal(elements['#receiverPaymentForm'].required, true);
  assert.doesNotMatch(elements['#receiverPaymentForm'].innerHTML, /value="31"/);
});
