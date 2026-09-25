const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectProspectTenant,
  scanStorageHygiene,
  moveScopeToQuarantine,
  purgeQuarantine,
  tenantIsProtected,
} = require('../src/utils/storageHygiene');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

async function writeFile(target, contents, old = false) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, contents);
  if (old) {
    const timestamp = new Date(Date.now() - 2 * 86400000);
    await fs.promises.utimes(target, timestamp, timestamp);
  }
}

test('SuperAdmin expone Higiene, cuarentena y protege visualmente a los clientes', () => {
  const route = read('src', 'routes', 'superadmin.js');
  const html = read('public', 'superadmin.html');
  const client = read('public', 'js', 'superadmin.js');
  const database = read('src', 'db', 'index.js');
  const legacyCleanup = read('scripts', 'cleanup-uploads.js');

  assert.match(html, /data-sa-view="storage-hygiene"/);
  assert.match(html, /id="saViewStorageHygiene"/);
  assert.match(html, /id="saStorageActionModal"/);
  assert.match(client, /sa-client-protected/);
  assert.match(client, /confirmationPhrases\.delete/);
  assert.match(route, /ELIMINAR PROSPECTO \$\{tenant\.slug\}/);
  assert.match(route, /router\.get\('\/storage-hygiene'/);
  assert.match(route, /router\.post\('\/storage-hygiene\/prospects\/:id\/delete'/);
  assert.match(route, /router\.post\('\/storage-hygiene\/jobs\/:id\/purge'/);
  assert.match(route, /tenant\.customer_since \|\| tenant\.has_payment/);
  assert.match(route, /await purgeQuarantine\(moved\.key\)/);
  assert.match(route, /SET status='purged',purged_at=now\(\)/);
  assert.match(route, /job\.action === 'delete_prospect'/);
  assert.match(client, /Eliminación inmediata/);
  assert.match(client, /base privada y todos sus archivos/);
  assert.match(client, /Purgar ahora/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS storage_cleanup_jobs/);
  assert.match(legacyCleanup, /const dryRun = true/);
});

test('el análisis separa clientes protegidos, prospectos y carpetas huérfanas', async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cbp-storage-scan-'));
  const uploadsDir = path.join(temp, 'uploads');
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));

  await writeFile(path.join(uploadsDir, 'prospecto', 'live.webp'), 'live', true);
  await writeFile(path.join(uploadsDir, 'prospecto', 'dead.webp'), 'dead-image', true);
  await writeFile(path.join(uploadsDir, 'prospecto', 'recent.upload'), 'working');
  await writeFile(path.join(uploadsDir, 'cliente', 'protected.webp'), 'client', true);
  await writeFile(path.join(uploadsDir, 'tenant-borrado', 'old.webp'), 'orphan-scope', true);
  await writeFile(path.join(uploadsDir, 'superadmin', 'logo.webp'), 'platform', true);

  const tenants = [
    { id: 1, slug: 'prospecto', business_name: 'Prospecto', logo: '', customer_since: null, payment_count: 0, created_at: new Date(Date.now() - 40 * 86400000), sales_stage: 'new', trial_status: 'expired' },
    { id: 2, slug: 'cliente', business_name: 'Cliente', logo: '/uploads/cliente/protected.webp', customer_since: new Date(), payment_count: 1, created_at: new Date(), sales_stage: 'won' },
  ];
  const query = async (sql) => {
    if (sql.includes('FROM storage_cleanup_jobs')) return { rows: [] };
    return { rows: tenants };
  };
  const tenantDbFactory = () => ({ all: async () => [{ image: '/uploads/prospecto/live.webp' }] });
  const report = await scanStorageHygiene({ query, tenantDbFactory, uploadsDir });

  assert.equal(report.summary.protectedClients, 1);
  assert.equal(report.prospects.length, 1);
  assert.equal(report.prospects[0].storage.files, 3);
  assert.equal(report.prospects[0].storage.referencedFiles, 1);
  assert.equal(report.prospects[0].storage.orphanFiles, 1);
  assert.equal(report.prospects[0].storage.recentUnreferencedFiles, 1);
  assert.deepEqual(report.orphanScopes.map((item) => item.scope), ['tenant-borrado']);
});

test('un pago histórico protege al tenant aunque customer_since esté vacío', () => {
  assert.equal(tenantIsProtected({ customer_since: null, payment_count: 1 }), true);
  assert.equal(tenantIsProtected({ customer_since: new Date(), payment_count: 0 }), true);
  assert.equal(tenantIsProtected({ customer_since: null, payment_count: 0 }), false);
});

test('una lectura incompleta del esquema bloquea la limpieza del prospecto', async () => {
  const prospect = { id: 9, slug: 'fallido', business_name: 'Fallido', customer_since: null, payment_count: 0, created_at: new Date(), sales_stage: 'new' };
  const result = await inspectProspectTenant(prospect, () => ({ all: async () => { throw new Error('schema no disponible'); } }));
  assert.equal(result.scanComplete, false);
  assert.match(result.scanError, /schema no disponible/);
});

test('la carpeta sale de uploads, entra en cuarentena y solo después puede purgarse', async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cbp-storage-quarantine-'));
  const uploadsDir = path.join(temp, 'uploads');
  const quarantineDir = path.join(temp, 'quarantine');
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(uploadsDir, 'prospecto-demo', 'image.webp'), 'image', true);

  const moved = await moveScopeToQuarantine('prospecto-demo', 17, { uploadsDir, quarantineDir });
  assert.equal(moved.moved, true);
  await assert.rejects(fs.promises.access(path.join(uploadsDir, 'prospecto-demo')));
  await fs.promises.access(path.join(quarantineDir, moved.key, 'image.webp'));

  const purged = await purgeQuarantine(moved.key, { quarantineDir });
  assert.equal(purged, true);
  await assert.rejects(fs.promises.access(path.join(quarantineDir, moved.key)));
});
