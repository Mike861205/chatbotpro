const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isMexicoIdentity,
  invoicingPortalUrl,
  validateFiscalProfile,
  validateReceiver,
  validateInvoiceEmail,
  maskInvoiceEmail,
  globalInformationForReceiver,
  resolveExpeditionPostalCode,
  paymentFormFromSale,
  buildFacturamaItems,
  buildGlobalFacturamaItems,
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
    defaultIvaRate: 0.16, defaultIsrRate: 0, defaultCardPaymentForm: '04',
  });
  assert.equal(issuer.rfc, 'EKU9003173C9');
  assert.equal(validateReceiver({ rfc: 'XAXX010101000', name: 'PUBLICO EN GENERAL', fiscalRegime: '616', postalCode: '78240', cfdiUse: 'S01' }).cfdiUse, 'S01');
  const generic = validateReceiver(
    { rfc: 'XAXX010101000', name: 'Nombre incorrecto', fiscalRegime: '625', postalCode: '23477', cfdiUse: 'G03' },
    { issuerPostalCode: '78240' }
  );
  assert.deepEqual(
    { name: generic.name, fiscalRegime: generic.fiscalRegime, postalCode: generic.postalCode, cfdiUse: generic.cfdiUse },
    { name: 'PUBLICO EN GENERAL', fiscalRegime: '616', postalCode: '78240', cfdiUse: 'S01' }
  );
  const branchGeneric = validateReceiver(
    { rfc: 'XAXX010101000', name: 'Otro', fiscalRegime: '625', postalCode: '78240', cfdiUse: 'G03' },
    { expeditionPostalCode: '23477', issuerPostalCode: '78240' }
  );
  assert.equal(branchGeneric.postalCode, '23477');
  assert.deepEqual(globalInformationForReceiver(branchGeneric, '2026-08-23T15:51:00-06:00'), {
    Periodicity: '01', Months: '08', Year: 2026,
  });
  assert.equal(globalInformationForReceiver({ rfc: 'EKU9003173C9' }), null);
  assert.equal(resolveExpeditionPostalCode({ environment: 'sandbox', sandbox_shared: true, postal_code: '78240' }, '23456'), '78240');
  assert.equal(resolveExpeditionPostalCode({ environment: 'production', sandbox_shared: false, postal_code: '78240' }, '23456'), '23456');
  assert.throws(() => validateReceiver({ rfc: 'INVALIDO' }), /RFC/);
});

test('valida y protege el correo usado para entregar CFDI', () => {
  assert.equal(validateInvoiceEmail(' Cliente@Ejemplo.MX '), 'cliente@ejemplo.mx');
  assert.equal(maskInvoiceEmail('cliente@ejemplo.mx'), 'c***@ejemplo.mx');
  assert.throws(() => validateInvoiceEmail('correo-invalido'), /correo electrónico válido/);
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

test('conserva seis decimales fiscales y permite consumo total o desglosado', () => {
  const profile = {
    default_product_code: '01010101', default_unit_code: 'E48', default_unit_name: 'Unidad de servicio',
    default_tax_object: '02', default_iva_rate: 0.16, default_isr_rate: 0,
  };
  const sale = { items: [{ id: 1, name: 'Aros', qty: 1, price: 80 }, { id: 2, name: 'Alitas', qty: 1, price: 199 }], delivery_fee: 0, total: 279 };
  const detailed = buildFacturamaItems(sale, new Map(), profile, { conceptMode: 'detailed' });
  assert.equal(detailed[0].Subtotal, 68.965517);
  assert.equal(detailed[0].Taxes[0].Total, 11.034483);
  assert.equal(detailed[0].Total, 80);
  const total = buildFacturamaItems(sale, new Map(), profile, { conceptMode: 'total' });
  assert.equal(total.length, 1);
  assert.equal(total[0].Description, 'Consumo');
  assert.equal(total[0].Total, 279);
});

test('la factura global conserva cada ticket y cuadra el total seleccionado', () => {
  const profile = {
    default_product_code: '01010101', default_unit_code: 'E48', default_unit_name: 'Unidad de servicio',
    default_tax_object: '02', default_iva_rate: 0.16, default_isr_rate: 0,
  };
  const sales = [
    { id: 67, items: [{ name: 'Aros', qty: 1, price: 80 }], delivery_fee: 0, total: 80 },
    { id: 68, items: [{ name: 'Combo', qty: 1, price: 199 }], delivery_fee: 0, total: 199 },
  ];
  const concepts = buildGlobalFacturamaItems(sales, new Map(), profile, { conceptMode: 'detailed' });
  assert.equal(concepts.length, 2);
  assert.match(concepts[0].Description, /^Ticket #67/);
  assert.match(concepts[1].Description, /^Ticket #68/);
  assert.equal(concepts.reduce((sum, item) => sum + item.Total, 0), 279);
  const totalConcept = buildGlobalFacturamaItems(sales, new Map(), profile, { conceptMode: 'total' });
  assert.equal(totalConcept.length, 1);
  assert.equal(totalConcept[0].Description, 'Consumo');
  assert.equal(totalConcept[0].Total, 279);
});

test('calcula IVA e ISR retenido por producto conservando el total cobrado', () => {
  const profile = {
    default_product_code: '01010101', default_unit_code: 'E48', default_unit_name: 'Unidad de servicio',
    default_tax_object: '02', default_iva_rate: 0.16, default_isr_rate: 0.10,
  };
  const items = buildFacturamaItems(
    { items: [{ id: 7, name: 'Servicio profesional', qty: 1, price: 106 }], delivery_fee: 0, total: 106 },
    new Map(),
    profile
  );
  assert.equal(items[0].Subtotal, 100);
  assert.deepEqual(items[0].Taxes.map((tax) => [tax.Name, tax.Total, tax.IsRetention]), [
    ['IVA', 16, false],
    ['ISR', 10, true],
  ]);
  assert.equal(items[0].Total, 106);
});

test('los datos SAT por producto viven en Productos y Facturación conserva sólo valores globales', () => {
  const app = read('public/app.html');
  const client = read('public/js/app.js');
  const productsRoute = read('src/routes/products.js');
  assert.match(app, /id="prodTabFiscal"/);
  assert.match(app, /id="pIsrRate"/);
  assert.match(app, /id="fiscalIsrRate"/);
  assert.doesNotMatch(app, /id="fiscalProductsTable"/);
  assert.match(client, /fd\.append\('satProductCode'/);
  assert.match(productsRoute, /isr_rate::float AS isr_rate/);
});

test('el POS muestra errores de timbrado dentro del modal y prepara público general en sandbox', () => {
  const app = read('public/app.html');
  const client = read('public/js/app.js');
  const css = read('public/css/styles.css');
  assert.match(app, /id="posInvoiceError"/);
  assert.match(app, /id="posInvoiceGeneric"/);
  assert.match(client, /function showPosInvoiceError/);
  assert.match(client, /function setPosGenericReceiver/);
  assert.match(client, /environment === 'sandbox'/);
  assert.match(client, /const form = event\.currentTarget;/);
  assert.match(client, /form\.hidden = true/);
  assert.doesNotMatch(client, /event\.currentTarget\.hidden = true/);
  assert.match(read('public/invoice.html'), /name="conceptMode" value="total"/);
  assert.match(css, /\.pos-invoice-error/);
  assert.match(css, /z-index: 2500/);
});

test('mapea el medio de pago POS al catálogo SAT', () => {
  assert.equal(paymentFormFromSale({ payment_method: 'cash' }), '01');
  assert.equal(paymentFormFromSale({ payment_method: 'card' }, '04'), '04');
  assert.equal(paymentFormFromSale({ payment_method: 'transfer' }), '03');
  assert.equal(paymentFormFromSale({ payment_method: 'mixed', payment_breakdown: { cash: 20, card: 80 } }), '04');
});

test('la integración está montada, aislada por México y expone POS y portal público', () => {
  const server = read('server.js');
  const database = read('src/db/index.js');
  const auth = read('src/routes/auth.js');
  const route = read('src/routes/invoicing.js');
  const app = read('public/app.html');
  const client = read('public/js/app.js');
  assert.match(server, /app\.use\('\/api\/invoicing'/);
  assert.match(server, /hostname\.startsWith\('facturacion\.'/);
  assert.match(auth, /invoicingEligible/);
  assert.match(route, /router\.use\(requireMexico\)/);
  assert.match(route, /\/public\/:slug\/issue/);
  assert.match(route, /\/sales\/:id\/issue/);
  assert.match(route, /invoiceAccessMatches/);
  assert.match(database, /invoice_code TEXT/);
  assert.match(database, /orders_invoice_code/);
  assert.match(app, /data-mexico-only="true"/);
  assert.match(app, /id="view-facturacion"/);
  assert.match(client, /C&Oacute;DIGO DE FACTURACI&Oacute;N/);
  assert.match(client, /friendlyInvoiceCode/);
});

test('el envío de facturas por Facturama está disponible en POS y portal público', () => {
  const service = read('src/services/facturama.js');
  const route = read('src/routes/invoicing.js');
  const app = read('public/js/app.js');
  const portal = read('public/js/invoice.js');
  const html = read('public/invoice.html');
  assert.match(service, /sendCfdiEmail/);
  assert.match(service, /issuedLite/);
  assert.match(route, /public\/:slug\/invoices\/:id\/email/);
  assert.match(route, /router\.post\('\/invoices\/:id\/email'/);
  assert.match(route, /event_type,detail,actor/);
  assert.match(route, /'email_sent'/);
  assert.match(app, /data-pos-invoice-email-form/);
  assert.match(portal, /invoiceEmailForm/);
  assert.match(html, /id="invoiceEmail"/);
});

test('la factura global enlaza tickets, bloquea duplicados y se opera desde el historial POS', () => {
  const database = read('src/db/index.js');
  const invoicing = read('src/routes/invoicing.js');
  const pos = read('src/routes/pos.js');
  const app = read('public/app.html');
  const client = read('public/js/app.js');
  assert.match(database, /CREATE TABLE IF NOT EXISTS "\$\{s\}"\.global_invoices/);
  assert.match(database, /global_invoice_orders_live/);
  assert.match(database, /concept_mode TEXT NOT NULL DEFAULT 'detailed'/);
  assert.match(invoicing, /router\.post\('\/global\/issue'/);
  assert.match(invoicing, /router\.get\('\/global\/eligible'/);
  assert.match(invoicing, /buildGlobalFacturamaItems/);
  assert.match(invoicing, /Este ticket ya está incluido en la factura global/);
  assert.match(invoicing, /Sólo puedes facturar ventas de tu sucursal asignada/);
  assert.match(invoicing, /req\.user\.role === 'cashier'/);
  assert.match(pos, /global_invoice_status/);
  assert.match(app, /id="posGlobalIssue"/);
  assert.match(app, /id="posGlobalConceptMode"/);
  assert.match(app, /id="posInvoiceClose"/);
  assert.match(client, /POS_GLOBAL_INVOICE_SELECTION/);
  assert.match(client, /data-global-ticket/);
  assert.match(client, /data-pos-invoice-return/);
  assert.match(client, /conceptMode: selectedConceptMode/);
});

test('el portal público es responsivo y presenta la identidad completa del tenant', () => {
  const route = read('src/routes/invoicing.js');
  const html = read('public/invoice.html');
  const css = read('public/css/invoice.css');
  const client = read('public/js/invoice.js');
  assert.match(route, /settings\.business_name \|\| tenant\.business_name/);
  assert.match(route, /legalName: profile\.legal_name/);
  assert.match(route, /branches: branches\.map/);
  assert.match(html, /id="businessLogo"/);
  assert.match(html, /class="mobile-business-header"/);
  assert.match(html, /data-progress-step="receiver"/);
  assert.match(html, /id="portalUnavailable"/);
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /grid-template-columns: minmax\(340px, 410px\)/);
  assert.match(client, /function applyBusiness\(portal\)/);
  assert.match(client, /function renderTicketSummary\(ticket\)/);
  assert.match(client, /applyGenericReceiverDefaults/);
  assert.match(client, /params\.get\('code'\) \|\| params\.get\('token'\)/);
  assert.doesNotMatch(client, /ticketSummary'\)\.innerHTML/);
});

test('no hay credenciales Facturama embebidas en archivos versionados', () => {
  const combined = [
    '.env.example', 'src/config.js', 'src/services/facturama.js', 'src/routes/invoicing.js',
  ].map(read).join('\n');
  assert.doesNotMatch(combined, /pamm861205/i);
  assert.match(read('.env.example'), /FACTURAMA_PASSWORD=\s*(?:\r?\n|$)/);
});
