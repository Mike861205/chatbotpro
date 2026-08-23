const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isMexicoIdentity,
  invoicingPortalUrl,
  validateFiscalProfile,
  validateReceiver,
  paymentFormFromSale,
  buildFacturamaItems,
} = require('../src/utils/invoicing');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('habilita facturación sólo para identidad México o lada +52', () => {
  assert.equal(isMexicoIdentity({ phone_country: 'MX' }), true);
  assert.equal(isMexicoIdentity({ phone_calling_code: '+52' }), true);
  assert.equal(isMexicoIdentity({ phoneCountry: 'US', phoneCallingCode: '1' }), false);
});

test('el portal usa localhost durante pruebas y el subdominio configurado en producción', () => {
  const localReq = { hostname: 'localhost', protocol: 'http', get: (name) => name === 'host' ? 'localhost:3000' : '' };
  const productionReq = { hostname: 'chatbotpro.systemdem.online', protocol: 'https', get: () => 'chatbotpro.systemdem.online' };
  const origin = 'https://facturacion.chatbotpro.systemdem.online';
  assert.equal(invoicingPortalUrl(localReq, origin, 'daddypollo'), 'http://localhost:3000/facturacion/daddypollo');
  assert.equal(invoicingPortalUrl(productionReq, origin, 'daddypollo'), `${origin}/daddypollo`);
});

test('valida datos fiscales CFDI 4.0 de emisor y receptor', () => {
  const issuer = validateFiscalProfile({
    rfc: 'EKU9003173C9', legalName: 'ESCUELA KEMPER URGATE', fiscalRegime: '601',
    postalCode: '78240', series: 'TEST', defaultProductCode: '01010101',
    defaultUnitCode: 'E48', defaultUnitName: 'Unidad de servicio', defaultTaxObject: '02',
    defaultIvaRate: 0.16, defaultCardPaymentForm: '04',
  });
  assert.equal(issuer.rfc, 'EKU9003173C9');
  assert.equal(validateReceiver({ rfc: 'XAXX010101000', name: 'PUBLICO EN GENERAL', fiscalRegime: '616', postalCode: '78240', cfdiUse: 'S01' }).cfdiUse, 'S01');
  assert.throws(() => validateReceiver({ rfc: 'INVALIDO' }), /RFC/);
});

test('convierte precios POS con IVA incluido a conceptos Facturama sin alterar el total', () => {
  const profile = {
    default_product_code: '01010101', default_unit_code: 'E48', default_unit_name: 'Unidad de servicio',
    default_tax_object: '02', default_iva_rate: 0.16, delivery_product_code: '78101800',
  };
  const items = buildFacturamaItems(
    { items: [{ id: 7, name: 'Consumo', qty: 2, price: 58 }], delivery_fee: 20, total: 136 },
    new Map(),
    profile
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].Subtotal, 100);
  assert.equal(items[0].Taxes[0].Total, 16);
  assert.equal(items.reduce((sum, item) => sum + item.Total, 0), 136);
});

test('mapea el medio de pago POS al catálogo SAT', () => {
  assert.equal(paymentFormFromSale({ payment_method: 'cash' }), '01');
  assert.equal(paymentFormFromSale({ payment_method: 'card' }, '04'), '04');
  assert.equal(paymentFormFromSale({ payment_method: 'transfer' }), '03');
  assert.equal(paymentFormFromSale({ payment_method: 'mixed', payment_breakdown: { cash: 20, card: 80 } }), '04');
});

test('la integración está montada, aislada por México y expone POS y portal público', () => {
  const server = read('server.js');
  const auth = read('src/routes/auth.js');
  const route = read('src/routes/invoicing.js');
  const app = read('public/app.html');
  assert.match(server, /app\.use\('\/api\/invoicing'/);
  assert.match(server, /hostname\.startsWith\('facturacion\.'/);
  assert.match(auth, /invoicingEligible/);
  assert.match(route, /router\.use\(requireMexico\)/);
  assert.match(route, /\/public\/:slug\/issue/);
  assert.match(route, /\/sales\/:id\/issue/);
  assert.match(app, /data-mexico-only="true"/);
  assert.match(app, /id="view-facturacion"/);
});

test('no hay credenciales Facturama embebidas en archivos versionados', () => {
  const combined = [
    '.env.example', 'src/config.js', 'src/services/facturama.js', 'src/routes/invoicing.js',
  ].map(read).join('\n');
  assert.doesNotMatch(combined, /pamm861205/i);
  assert.match(read('.env.example'), /FACTURAMA_PASSWORD=\s*(?:\r?\n|$)/);
});
