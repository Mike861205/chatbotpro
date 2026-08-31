const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('al registrarse, un lead demo se vincula al prospecto y deja de listarse como lead', () => {
  const db = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'src', 'routes', 'auth.js'), 'utf8');
  const superadmin = fs.readFileSync(path.join(root, 'src', 'routes', 'superadmin.js'), 'utf8');
  const resellers = fs.readFileSync(path.join(root, 'src', 'routes', 'resellers.js'), 'utf8');

  assert.match(db, /demo_leads ADD COLUMN IF NOT EXISTS converted_tenant_id INTEGER REFERENCES tenants\(id\) ON DELETE CASCADE/);
  assert.match(db, /SELECT id, phone_hash FROM demo_leads WHERE converted_tenant_id IS NULL/);
  assert.match(auth, /converted_tenant_id = \$2/);
  assert.match(superadmin, /const where = \['dl\.converted_tenant_id IS NULL'\]/);
  assert.match(superadmin, /WHERE dl\.converted_tenant_id IS NULL\s+ORDER BY COALESCE/);
  assert.match(resellers, /WHERE dl\.reseller_id = \$1 AND dl\.converted_tenant_id IS NULL/);
});

test('el lead se convierte dentro del demo solicitando solamente usuario y contraseña', () => {
  const auth = fs.readFileSync(path.join(root, 'src', 'routes', 'auth.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

  assert.match(auth, /router\.post\('\/demo-convert', authAttemptLimiter, requireAuth/);
  assert.match(auth, /SELECT id, contact_name, phone_enc, phone_country, phone_calling_code,[\s\S]*business_giro, reseller_id/);
  assert.match(auth, /availableDemoTenantSlug\(businessName, demoLeadId\)/);
  assert.match(auth, /converted_tenant_id = \$2/);
  assert.match(html, /id="demoConversionUsername"/);
  assert.match(html, /id="demoConversionPassword"/);
  assert.doesNotMatch(html.match(/<form id="demoConversionForm"[\s\S]*?<\/form>/)?.[0] || '', /ownerName|phoneCountry|businessName/);
  assert.match(script, /api\('\/api\/auth\/demo-convert'/);
  assert.match(script, /location\.replace\(result\.redirectTo \|\| '\/app'\)/);
});
