const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('el servidor separa el producto fiscal por subdominio y conserva rutas para localhost', () => {
  const server = read('server.js');
  assert.match(server, /isInvoicingHost/);
  assert.match(server, /productPage\('index\.html', 'invoicing-home\.html'\)/);
  assert.match(server, /app\.get\('\/facturacion\/registro', page\('invoicing-register\.html'\)\)/);
  assert.match(server, /app\.get\('\/facturacion\/panel', page\('invoicing-app\.html'\)\)/);
  assert.match(server, /app\.get\('\/facturacion\/:slug', validSlug, page\('invoice\.html'\)\)/);
});

test('el registro fiscal marca el producto y dirige a un panel exclusivo', () => {
  const database = read('src/db/index.js');
  const auth = read('src/routes/auth.js');
  const registration = read('public/invoicing-register.html');
  const login = read('public/invoicing-login.html');
  assert.match(database, /product_code TEXT NOT NULL DEFAULT 'chatbotpro'/);
  assert.match(auth, /productCode === 'invoicing'/);
  assert.match(auth, /cleanProductCode === 'invoicing' && normalizedPhone\.country !== 'MX'/);
  assert.match(auth, /cleanProductCode === 'invoicing' \? 1 : 0/);
  assert.match(database, /product_code='invoicing'/);
  assert.match(database, /invoicing_environment='production'/);
  assert.match(database, /movement_type IN \('trial_grant','courtesy_grant'\)/);
  assert.match(registration, /productCode: 'invoicing'/);
  assert.match(registration, /phoneCountry: 'MX'/);
  assert.match(registration, /pattern="\[0-9\]\{10\}"/);
  assert.doesNotMatch(registration, /phone-input\.js/);
  assert.match(registration, /location\.replace\('\/facturacion\/panel'\)/);
  assert.match(login, /me\.tenant\?\.productCode !== 'invoicing'/);
  assert.match(login, /productCode: 'invoicing'/);
  assert.match(auth, /tenantProductCode !== requestedProductCode/);
  assert.match(auth, /WRONG_PRODUCT/);
  assert.match(read('public/login.html'), /productCode: 'chatbotpro'/);
  assert.match(read('public/js/app.js'), /productCode === 'invoicing'/);
});

test('el panel independiente usa el motor fiscal real y presenta la identidad del negocio', () => {
  const html = read('public/invoicing-app.html');
  const client = read('public/js/invoicing-app.js');
  const css = read('public/css/invoicing-product.css');
  assert.match(html, /id="view-summary"/);
  assert.match(html, /id="view-documents"/);
  assert.match(html, /id="view-portal"/);
  assert.match(html, /id="view-settings"/);
  assert.match(client, /api\('\/api\/invoicing\/bootstrap'\)/);
  assert.match(client, /api\('\/api\/invoicing\/documents\?limit=20'\)/);
  assert.match(client, /api\('\/api\/invoicing\/profile'/);
  assert.match(client, /api\('\/api\/invoicing\/csd'/);
  assert.match(client, /api\('\/api\/invoicing\/direct-invoices'/);
  assert.match(client, /api\('\/api\/settings'/);
  assert.match(client, /ME\.tenant\.primaryColor/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

test('Super Admin mantiene una cartera separada para facturación independiente', () => {
  const routes = read('src/routes/superadmin.js');
  const html = read('public/superadmin.html');
  const client = read('public/js/superadmin.js');
  assert.match(routes, /router\.get\('\/invoicing-businesses'/);
  assert.match(routes, /WHERE t\.product_code='invoicing'/);
  assert.match(routes, /fiscal_profile_complete/);
  assert.match(html, /data-sa-view="invoicing"/);
  assert.match(html, /id="saViewInvoicing"/);
  assert.match(client, /async function loadInvoicingBusinesses/);
  assert.match(client, /manageTenantStamps/);
  assert.match(client, /openFollowUpModal\('tenant'/);
});

test('las ventas de POS externo se facturan sin crear pedidos internos', () => {
  const database = read('src/db/index.js');
  const routes = read('src/routes/invoicing.js');
  assert.match(database, /CREATE TABLE IF NOT EXISTS "\$\{s\}"\.direct_invoices/);
  assert.match(routes, /async function issueDirectInvoice/);
  assert.match(routes, /router\.post\('\/direct-invoices'/);
  assert.match(routes, /document_type: 'direct'/);
  assert.doesNotMatch(routes.slice(routes.indexOf('async function issueDirectInvoice'), routes.indexOf('\n// Portal público')), /INSERT INTO \{s\}\.orders/);
});