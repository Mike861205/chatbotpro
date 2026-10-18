const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const superAdminHtml = fs.readFileSync(path.join(root, 'public', 'superadmin.html'), 'utf8');
const superAdminRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'superadmin.js'), 'utf8');
const subscriptionView = appHtml.split('id="view-suscripciones"')[1].split('id="view-instrucciones"')[0];

test('suscripciones muestra exactamente tres tarjetas: mensual, licencia de por vida y SAT', () => {
  assert.equal((subscriptionView.match(/class="plan-card /g) || []).length, 3);
  assert.match(subscriptionView, /class="plan-card plan-regular"/);
  assert.match(subscriptionView, /class="plan-card plan-annual"/);
  assert.match(subscriptionView, /class="plan-card plan-invoicing"/);
  assert.doesNotMatch(subscriptionView, /plan-promo|Promoción primer año|12 MSI|Ahorra 12%|\$7,500/);
});

test('el plan mensual cuesta $999 MXN y usa el enlace y producto proporcionados', () => {
  assert.match(subscriptionView, /<span class="amt">999<\/span><span class="per">\/ mes MXN<\/span>/);
  assert.equal((subscriptionView.match(/https:\/\/buy\.stripe\.com\/3cIfZgcrP6fTgoHc2i4c80n/g) || []).length, 2);
  assert.equal((subscriptionView.match(/data-stripe-product="prod_VSxemV6UWJXzea"/g) || []).length, 2);
});

test('la licencia distingue el pago único de $10,999 MXN de los USD $80 anuales de infraestructura', () => {
  assert.match(subscriptionView, /<span class="amt">10,999<\/span>/);
  assert.match(subscriptionView, /USD \$80 al año/);
  assert.match(subscriptionView, /servidores, memoria y almacenamiento/);
  assert.match(subscriptionView, /no se vuelve a cobrar cada año/);
  assert.equal((subscriptionView.match(/https:\/\/buy\.stripe\.com\/6oUeVccrP6fTb4n0jA4c80o/g) || []).length, 2);
  assert.equal((subscriptionView.match(/data-stripe-product="prod_VSxcoUjDuPIO5V"/g) || []).length, 2);
  assert.match(superAdminHtml, /value="lifetime"/);
  assert.match(superAdminRoute, /\['lifetime', 'annual'\]\.includes\(planCode\) \? '1 year' : '1 month'/);
});

test('conserva la tarjeta de Facturación SAT de $1,499 MXN y sus beneficios', () => {
  assert.match(subscriptionView, /class="plan-card plan-invoicing"/);
  assert.match(subscriptionView, /<span class="amt">1,499<\/span>/);
  assert.match(subscriptionView, /href="https:\/\/buy\.stripe\.com\/bJe8wO77v6fT5K37M24c80m"/);
  assert.match(subscriptionView, /data-stripe-product="prod_V863lSz1ZCJG47"/);
  assert.match(subscriptionView, /100 timbres de bienvenida/);
  assert.match(subscriptionView, /CFDI 4\.0 y facturación global ante el SAT/);
});

test('las tres tarjetas conservan los beneficios operativos y el límite de sucursales', () => {
  for (const benefit of [
    'Punto de venta y caja por sucursal',
    'Pedidos en tiempo real y KDS para restaurantes',
    'Costo de ventas, utilidad y márgenes',
    'Inventarios y stock por sucursal',
    'Promociones, compras y gastos',
    'Incluye de 1 a 2 sucursales',
  ]) {
    assert.equal(subscriptionView.split(benefit).length - 1, 3, benefit);
  }
  assert.match(subscriptionView, /¿Tu negocio necesita 3 o más sucursales activas\?/);
});
