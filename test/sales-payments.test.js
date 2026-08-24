const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el endpoint de reporte de ventas desglosa efectivo, tarjeta, transferencias y pagos múltiples en SQL', () => {
  const salesJs = fs.readFileSync(path.join(__dirname, '../src/routes/sales.js'), 'utf8');
  assert.match(salesJs, /payment_cash/);
  assert.match(salesJs, /payment_card/);
  assert.match(salesJs, /payment_transfer/);
  assert.match(salesJs, /selectedMonthCash/);
  assert.match(salesJs, /selectedMonthCard/);
  assert.match(salesJs, /selectedMonthTransfer/);
  assert.match(salesJs, /selectedMonthPayments/);
});

test('la interfaz de ventas renderiza tarjetas de efectivo, tarjeta y transferencias y badges en calendario', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(appJs, /Efectivo cobrado/);
  assert.match(appJs, /Tarjeta cobrada/);
  assert.match(appJs, /Transferencias/);
  assert.match(appJs, /sales-calendar-payments/);
  assert.match(appJs, /sales-pay-chip sales-pay-cash/);
  assert.match(appJs, /sales-pay-chip sales-pay-card/);
  assert.match(appJs, /sales-pay-chip sales-pay-transfer/);
});

test('las ventas POS nuevas entran a Pedidos con sucursal y tipo de tarjeta', () => {
  const posJs = fs.readFileSync(path.join(__dirname, '../src/routes/pos.js'), 'utf8');
  const ordersJs = fs.readFileSync(path.join(__dirname, '../src/routes/orders.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

  assert.match(posJs, /VALUES \(NULL, \$1, \$2, \$3, 'confirmado', 'pos'/);
  assert.match(posJs, /breakdown\.cardType = cardType/);
  assert.match(ordersJs, /payment_method, payment_breakdown/);
  assert.match(ordersJs, /payment_breakdown: paymentBreakdown/);
  assert.match(appJs, /function orderBranchLabel\(order\)/);
  assert.match(appJs, /orderPaymentLabel\(o\.payment_method, o\.payment_breakdown\)/);
  assert.match(appJs, /Tarjeta débito/);
  assert.match(appJs, /Tarjeta crédito/);
});
