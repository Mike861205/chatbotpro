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
  assert.match(read('src/routes/invoicing.js'), /router\.put\('\/profile-draft', requireOwner/);
  assert.match(read('src/routes/invoicing.js'), /SET enabled=0,environment=\$1/);
  assert.equal((read('src/routes/invoicing.js').match(/csd_updated_at=CASE WHEN \$2='' OR rfc=\$2 THEN csd_updated_at ELSE NULL END/g) || []).length, 2);
  assert.match(read('src/routes/invoicing.js'), /complete: profileCompleteness\(row\)/);
  assert.match(read('src/routes/invoicing.js'), /router\.get\('\/public\/:slug\/logo\/:version\.png'/);
  assert.match(read('src/routes/invoicing.js'), /payload\.LogoUrl = logoUrl/);
  assert.match(read('src/routes/invoicing.js'), /req\.params\.version !== expectedVersion/);
  assert.equal((read('src/routes/invoicing.js').match(/applyMultiIssuerPresentation\(payload, tenant,/g) || []).length, 7);
  assert.match(read('src/routes/invoicing.js'), /if \(profile\.api_mode === 'web'\) return/);
  assert.match(client, /api\('\/api\/invoicing\/csd'/);
  assert.match(client, /api\('\/api\/invoicing\/direct-invoices'/);
  assert.match(client, /api\('\/api\/settings'/);
  assert.match(html, /id="invoicingSetupModal"/);
  assert.match(html, /id="setupLogo"[^>]*required/);
  assert.match(html, /id="setupRfc"/);
  assert.match(html, /id="setupLegalName"/);
  assert.match(html, /id="setupFiscalRegime"/);
  assert.match(html, /id="setupPostalCode"/);
  assert.match(html, /id="invoicingWelcomeModal"/);
  assert.match(html, /class="iv-operation-form iv-global-operation" id="manualGlobalForm"/);
  assert.match(html, /class="iv-collections-grid"/);
  assert.match(html, /class="iv-operation-form iv-identity-operation" id="identityForm"/);
  assert.match(html, /class="iv-operation-form iv-fiscal-operation" id="fiscalForm"/);
  assert.match(html, /class="iv-operation-form iv-csd-operation" id="csdForm"/);
  assert.match(css, /\.iv-operation-head/);
  assert.match(css, /--operation-accent: var\(--tenant-color/);
  assert.match(client, /document\.documentElement\.style\.setProperty\('--tenant-color', color\)/);
  assert.match(client, /\$\('#identityColor'\)\.addEventListener\('input'/);
  assert.match(client, /ME\?\.identityRequired.*showInvoicingSetup/);
  assert.match(client, /ME\?\.onboardingRequired.*showInvoicingWelcome/);
  assert.match(client, /api\('\/api\/invoicing\/profile-draft'/);
  assert.match(client, /api\('\/api\/auth\/identity\/complete'/);
  assert.match(client, /api\('\/api\/auth\/onboarding\/complete'/);
  assert.match(read('src/routes/auth.js'), /if \(req\.tenant\.product_code !== 'invoicing'\)/);
  assert.match(read('src/routes/auth.js'), /\? 'nombre, logo y color'/);
  assert.match(client, /¡Felicidades por tu registro, \$\{ownerName\}!/);
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