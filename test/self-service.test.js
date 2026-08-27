const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('monta una pantalla pública de autoservicio protegida por dispositivo', () => {
  const server = read('server.js');
  const route = read('src/routes/selfService.js');
  assert.match(server, /app\.use\('\/api\/self-service'/);
  assert.match(server, /app\.get\('\/autoservicio\/:slug\/:token'/);
  assert.match(route, /self_service_enabled/);
  assert.match(route, /self_service_devices/);
  assert.match(route, /access_token=\$1 AND d\.active=1/);
  assert.match(route, /createRateLimiter/);
});

test('el pedido se cotiza en servidor y nace pendiente de cobro', () => {
  const route = read('src/routes/selfService.js');
  assert.match(route, /normalizeKioskItems/);
  assert.match(route, /modifier_options WHERE active=1/);
  assert.match(route, /variants\.length > 1 && !variant/);
  assert.match(route, /modifiersExtraPrice \+= Number\(option\.extra_price/);
  assert.match(route, /'pendiente_cobro','kiosk'/);
  assert.match(route, /self_service_folio/);
  assert.match(route, /emitSelfServiceOrder/);
  assert.match(route, /normalizeCustomer/);
  assert.match(route, /customerName/);
  assert.match(route, /INSERT INTO \{s\}\.customers/);
  assert.match(route, /encrypt\(customerData\.name\)/);
});

test('la caja cobra antes de descontar inventario y liberar a cocina', () => {
  const pos = read('src/routes/pos.js');
  const kds = read('src/routes/kds.js');
  assert.match(pos, /listPendingSelfServiceOrders/);
  assert.match(pos, /router\.post\('\/self-service\/:id\/checkout'/);
  assert.match(pos, /order\.status !== 'pendiente_cobro'/);
  assert.match(pos, /SET channel='pos',status='confirmado'/);
  assert.match(pos, /decrementBranchStockForSale/);
  assert.match(pos, /emitNewOrder/);
  assert.match(kds, /NOT \(o\.channel = 'kiosk' AND o\.status = 'pendiente_cobro'\)/);
});

test('la interfaz ofrece catálogo táctil, carrito, folio, voz y administración por tenant', () => {
  const html = read('public/self-service.html');
  const client = read('public/js/self-service.js');
  const app = read('public/js/app.js');
  const settings = read('src/routes/settings.js');
  assert.match(html, /id="kioskProducts"/);
  assert.match(html, /id="kioskCheckout"/);
  assert.match(client, /SpeechSynthesisUtterance/);
  assert.match(client, /agregado a tu pedido/);
  assert.match(client, /kioskCustomerForm/);
  assert.match(client, /a nombre de \$\{result\.customerName\}/);
  assert.match(client, /printKioskTicket/);
  assert.match(client, /Pedido a nombre de/);
  assert.match(client, /Esperando confirmación de caja/);
  assert.match(app, /renderPosSelfServiceQueue/);
  assert.match(app, /Confirmar pago y enviar a cocina|selfServiceCheckoutForm/);
  assert.match(settings, /'self_service_auto_print'/);
});

test('el nombre viaja hasta la cola, el cobro y el ticket del punto de venta', () => {
  const pos = read('src/routes/pos.js');
  const client = read('public/js/app.js');
  assert.match(pos, /LEFT JOIN \{s\}\.customers c ON c\.id=o\.customer_id/);
  assert.match(pos, /customerName: decrypt\(row\.name_enc\)/);
  assert.match(pos, /customerName: decrypt\(result\.order\.name_enc\)/);
  assert.match(client, /pos-self-service-customer/);
  assert.match(client, /A nombre de \$\{esc\(ticket\.customerName\)\}/);
});

test('el tenant controla los pagos de autoservicio y el cajero confirma el medio real', () => {
  const route = read('src/routes/selfService.js');
  const settings = read('src/routes/settings.js');
  const kiosk = read('public/js/self-service.js');
  const pos = read('public/js/app.js');
  assert.match(settings, /'self_service_payment_cash'/);
  assert.match(settings, /'self_service_payment_debit'/);
  assert.match(settings, /'self_service_payment_credit'/);
  assert.match(settings, /'self_service_payment_transfer'/);
  assert.match(route, /enabledSelfServicePayments/);
  assert.match(route, /normalizeSelfServicePayment/);
  assert.match(route, /payment_method,payment_breakdown/);
  assert.match(kiosk, /id="kioskPaymentOptions"|kioskPaymentOptions/);
  assert.match(kiosk, /PENDIENTE DE COBRO · NO ES TICKET DE VENTA/);
  assert.match(kiosk, /El ticket final se imprime después de confirmar el pago en el POS/);
  assert.match(pos, /preferredMethod/);
  assert.match(pos, /printSelfServiceOrder\(result\.sale, false\)/);
  assert.match(pos, /Tarjeta de débito/);
  assert.match(pos, /Tarjeta de crédito/);
});

test('el modal de cobro destaca el cambio y se adapta a pantallas pequeñas', () => {
  const html = read('public/app.html');
  const client = read('public/js/app.js');
  const styles = read('public/css/styles.css');
  assert.match(html, /self-service-checkout-summary/);
  assert.match(html, /id="selfServiceCashShortcuts"/);
  assert.match(html, /id="selfServiceChangeCard"/);
  assert.match(html, /id="selfServiceCheckoutSubmit"/);
  assert.match(client, /renderSelfServiceCashShortcuts/);
  assert.match(client, /classList\.toggle\('insufficient'/);
  assert.match(client, /Procesando pago/);
  assert.match(styles, /\.self-service-checkout-modal/);
  assert.match(styles, /@media\(max-width:620px\)/);
});

test('el esquema migra también tenants existentes', () => {
  const database = read('src/db/index.js');
  assert.match(database, /CREATE TABLE IF NOT EXISTS "\$\{s\}"\.self_service_devices/);
  assert.match(database, /ALTER TABLE "\$\{s\}"\.orders ADD COLUMN IF NOT EXISTS self_service_device_id/);
  assert.match(database, /ALTER TABLE "\$\{s\}"\.orders ADD COLUMN IF NOT EXISTS self_service_folio/);
});
