const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/routes/pos.js'), 'utf8');
const start = source.indexOf('function normalizePayment(');
const end = source.indexOf('async function normalizeTenantPayment(', start);
assert.ok(start >= 0 && end > start);

const money = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
};
const context = {
  n: money,
  sameMoney: (a, b) => Math.abs(money(a) - money(b)) < 0.01,
  badRequest: (message) => new Error(message),
  PAYMENT_METHODS: new Set(['cash', 'card', 'transfer', 'platform', 'mixed', 'credit']),
  isCustomPaymentMethod: (method) => String(method || '').startsWith('custom_'),
};
vm.runInNewContext(`${source.slice(start, end)}\nthis.normalizePayment = normalizePayment;`, context);

test('Plataforma registra el total como digital sin efectivo ni cambio', () => {
  const payment = context.normalizePayment('platform', {}, 125.5, 0);
  assert.equal(payment.method, 'platform');
  assert.equal(payment.breakdown.platform, 125.5);
  assert.equal(payment.breakdown.cash, 0);
  assert.equal(payment.cashReceived, 0);
  assert.equal(payment.cashChange, 0);
});

test('un pago mixto conserva por separado Plataforma y el efectivo de caja', () => {
  const payment = context.normalizePayment('mixed', { cash: 25, platform: 75 }, 100, 30);
  assert.equal(payment.breakdown.cash, 25);
  assert.equal(payment.breakdown.platform, 75);
  assert.equal(payment.cashReceived, 30);
  assert.equal(payment.cashChange, 5);
  assert.throws(() => context.normalizePayment('mixed', { cash: 25, platform: 70 }, 100, 25), /suma de pagos/);
});

test('el efectivo esperado del corte usa sólo el componente cobrado en efectivo', () => {
  const fn = source.slice(source.indexOf('function expectedCashForSession('), source.indexOf('function paymentBreakdownForMethod('));
  const cashContext = { n: money };
  vm.runInNewContext(`${fn}\nthis.expectedCashForSession = expectedCashForSession;`, cashContext);
  const totals = {
    collected: { cash: 25, platform: 75 },
    movements: { income: 10, withdrawal: 5, expense: 0 },
  };
  assert.equal(cashContext.expectedCashForSession({ opening_amount: 100 }, totals), 130);
});
