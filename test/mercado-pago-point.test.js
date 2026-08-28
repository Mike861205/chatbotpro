const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Mercado Pago Point usa Orders, idempotencia y terminal virtual de sandbox', () => {
  const point = read('src/utils/mercadoPagoPoint.js');
  assert.match(point, /\/v1\/orders/);
  assert.match(point, /X-Idempotency-Key/);
  assert.match(point, /NEWLAND_N950__SBX0000001/);
  assert.match(point, /config\.MERCADO_PAGO_POINT_MODE === 'sandbox'\s*\? sandboxTerminal/);
  assert.match(point, /config\.NODE_ENV !== 'production'/);
  assert.match(point, /print_on_terminal: 'no_ticket'/);
  assert.match(point, /status: 'processed'/);
  assert.match(point, /status_detail: 'accredited'/);
});

test('el autocobro valida proveedor, monto y acreditacion antes de confirmar la venta', () => {
  const route = read('src/routes/selfService.js');
  const checkout = read('src/utils/selfServiceCheckout.js');
  const database = read('src/db/index.js');
  assert.match(route, /orders\/:id\/point/);
  assert.match(route, /providerPayment\.statusDetail !== 'accredited'/);
  assert.match(route, /monto acreditado por Mercado Pago no coincide/);
  assert.match(checkout, /FOR UPDATE OF o/);
  assert.match(checkout, /payment_provider=\$8/);
  assert.match(checkout, /applyBranchSaleStock/);
  assert.match(database, /ALTER TABLE "\$\{s\}"\.self_service_payments ADD COLUMN IF NOT EXISTS pos_session_id INTEGER/);
});

test('el kiosco imprime ticket final solo tras pago Point aprobado y conserva caja para otros medios', () => {
  const client = read('public/js/self-service.js');
  const html = read('public/self-service.html');
  assert.match(client, /result\.paymentMethod === 'card'/);
  assert.match(client, /finishPointPayment/);
  assert.match(client, /printKioskTicket\(sale, true\)/);
  assert.match(client, /PENDIENTE DE COBRO · NO ES TICKET DE VENTA/);
  assert.match(html, /efectivo y transferencia se confirman en caja/);
});

test('las credenciales privadas permanecen fuera de los archivos versionados', () => {
  const files = ['src/config.js', 'src/utils/mercadoPagoPoint.js', 'src/routes/selfService.js', 'public/js/self-service.js'];
  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /TEST-[a-z0-9-]{20,}/i, `${file} no debe contener credenciales`);
  }
});
