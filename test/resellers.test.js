const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const db = read('src/db/index.js');
const auth = read('src/routes/auth.js');
const routes = read('src/routes/resellers.js');
const server = read('server.js');
const superadminHtml = read('public/superadmin.html');
const resellerHtml = read('public/reseller.html');

test('persiste resellers y atribuye tenants y leads demo', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS resellers/);
  assert.match(db, /ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reseller_id/);
  assert.match(db, /ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS reseller_id/);
  assert.match(auth, /INSERT INTO tenants[^`]+reseller_id/s);
  assert.match(auth, /INSERT INTO demo_leads[^`]+reseller_id/s);
});

test('el portal reseller limita consultas y seguimiento por reseller_id', () => {
  assert.match(routes, /WHERE t\.reseller_id = \$1/);
  assert.match(routes, /WHERE dl\.reseller_id = \$1/);
  assert.match(routes, /WHERE id = \$1 AND reseller_id = \$2/);
  assert.match(routes, /requireReseller/);
});

test('expone enlaces de captación y acceso sin incluir integraciones', () => {
  assert.match(server, /app\.get\('\/resellers\/:slug'/);
  assert.match(server, /reseller=\$\{encodeURIComponent/);
  assert.match(superadminHtml, /data-sa-view="resellers"/);
  assert.match(resellerHtml, />Prospectos</);
  assert.match(resellerHtml, />Clientes</);
  assert.match(resellerHtml, />Leads demo</);
  assert.match(resellerHtml, />Seguimiento</);
  assert.doesNotMatch(resellerHtml, /Integraciones/);
});
