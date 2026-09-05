const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const schema = read('src', 'db', 'index.js');
const pos = read('src', 'routes', 'pos.js');
const sales = read('src', 'routes', 'sales.js');
const dashboard = read('src', 'routes', 'dashboard.js');
const invoicing = read('src', 'routes', 'invoicing.js');
const html = read('public', 'app.html');
const app = read('public', 'js', 'app.js');
const css = read('public', 'css', 'styles.css');

test('persiste crédito y atribuye su liquidación a la caja receptora', () => {
  assert.match(schema, /payment_status TEXT NOT NULL DEFAULT 'paid'/);
  assert.match(schema, /credit_paid_session_id INTEGER/);
  assert.match(schema, /credit_paid_at TIMESTAMPTZ/);
  assert.match(pos, /paymentStatus = payment\.method === 'credit' \? 'pending' : 'paid'/);
  assert.match(pos, /credit_paid_session_id = CASE WHEN \$6 THEN \$7/);
  assert.match(pos, /WHERE id = \$5 AND \(NOT \$6 OR payment_status = 'pending'\)/);
  assert.match(pos, /eventType = 'credit_sale_paid'/);
});

test('excluye deuda abierta del corte y conserva auditoría histórica', () => {
  assert.match(pos, /COALESCE\(payment_status, 'paid'\) = 'paid'/);
  assert.match(pos, /credit_paid_session_id = \$1/);
  assert.match(pos, /o\.credit_paid_at > ps\.closed_at/);
  assert.match(pos, /openCredit:/);
  assert.match(pos, /function expectedCashForSession\(session, totals\)/);
  assert.match(pos, /n\(session\.opening_amount\) \+ totals\.collected\.cash \+ totals\.movements\.income/);
  assert.match(pos, /totals\.movements\.withdrawal - totals\.movements\.expense/);
  assert.match(app, /Créditos abiertos al cierre/);
  assert.match(app, /no forman parte del efectivo esperado ni de la diferencia de caja/);
});

test('permite registrar, ver, cobrar e imprimir ventas a crédito', () => {
  assert.match(html, /id="posCreditQueue"/);
  assert.match(app, /data-pos-method="\$\{method\}"/);
  assert.match(app, /creditCustomerName/);
  assert.match(app, /data-settle-credit/);
  assert.match(app, /VENTA A CRÉDITO/);
  assert.match(app, /CRÉDITO LIQUIDADO/);
  assert.match(css, /\.pos-credit-card/);
});

test('reporta el crédito al cobrarlo y bloquea facturación mientras esté pendiente', () => {
  assert.match(sales, /COALESCE\(o\.credit_paid_at, o\.created_at\) AS financial_at/);
  assert.match(dashboard, /COALESCE\(payment_status, 'paid'\) = 'paid'/);
  assert.match(invoicing, /Liquida las ventas a crédito antes de facturarlas/);
  assert.match(invoicing, /La venta a crédito debe liquidarse antes de facturar/);
  assert.match(app, /row\.payment_status !== 'pending'/);
});
