const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');

test('muestra la tercera opción anual con el enlace y producto de Stripe correctos', () => {
  assert.match(appHtml, /class="plan-card plan-annual"/);
  assert.match(appHtml, /href="https:\/\/buy\.stripe\.com\/bJe6oGcrPaw92xRd6m4c80l"/);
  assert.match(appHtml, /data-stripe-product="prod_V3VTGzS7W24dg2"/);
  assert.match(appHtml, /Ahorra(?:s)? 12%/);
  assert.match(appHtml, /12 meses sin intereses/);
  assert.match(appHtml, /<strong>625<\/strong><em>\/ mes MXN<\/em>/);
  assert.match(appHtml, /Total anual \$7,500 MXN/);
});

test('informa que los pagos internacionales se convierten a pesos mexicanos', () => {
  assert.match(appHtml, /Pagos desde otros países/);
  assert.match(appHtml, /EL COBRO ES EN PESOS MEXICANOS \(MXN\)/);
  assert.match(appHtml, /conversión desde tu moneda local/);
});

test('mantiene los beneficios principales en las tres tarjetas', () => {
  for (const benefit of [
    'Punto de venta y caja por sucursal',
    'KDS de pedidos en tiempo real',
    'Costo de ventas, utilidad y márgenes',
    'Inventarios y stock por sucursal',
  ]) {
    assert.equal(appHtml.split(benefit).length - 1, 3, `${benefit} debe aparecer en los tres planes`);
  }
});
