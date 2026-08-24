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

test('agrega el plan de Facturación Electrónica SAT con Stripe y 100 timbres', () => {
  assert.match(appHtml, /class="plan-card plan-invoicing"/);
  assert.match(appHtml, /Facturación Electrónica/);
  assert.match(appHtml, /<span class="amt">1,499<\/span>/);
  assert.match(appHtml, /href="https:\/\/buy\.stripe\.com\/bJe8wO77v6fT5K37M24c80m"/);
  assert.match(appHtml, /data-stripe-product="prod_V863lSz1ZCJG47"/);
  assert.match(appHtml, /data-plan-code="invoicing_sat"/);
  assert.match(appHtml, /100 timbres de bienvenida/);
  assert.match(appHtml, /CFDI 4\.0 y facturación global ante el SAT/);
  assert.match(appHtml, /Multiemisor por RFC y sucursal/);
});

test('mantiene los beneficios principales en las cuatro tarjetas', () => {
  for (const benefit of [
    'Punto de venta y caja por sucursal',
    'KDS de pedidos en tiempo real',
    'Costo de ventas, utilidad y márgenes',
    'Inventarios y stock por sucursal',
  ]) {
    assert.equal(appHtml.split(benefit).length - 1, 4, `${benefit} debe aparecer en los cuatro planes`);
  }
});

test('las cuatro tarjetas explican que incluyen de una a dos sucursales', () => {
  assert.equal(appHtml.split('Incluye de 1 a 2 sucursales').length - 1, 4);
  assert.equal(appHtml.split('ph-fill ph-storefront').length >= 4, true);
  assert.equal(appHtml.split('Activas al mismo tiempo').length - 1, 4);
});

test('explica que tres o más sucursales requieren cotización personalizada', () => {
  assert.match(appHtml, /¿Tu negocio necesita 3 o más sucursales activas\?/);
  assert.match(appHtml, /El precio varía según el número de sucursales activas/);
  assert.match(appHtml, /Precio personalizado/);
  assert.ok(appHtml.indexOf('subs-extra-branches-notice') < appHtml.indexOf('subs-currency-notice'));
});
