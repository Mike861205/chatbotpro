const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { pool, q, tdb } = require('../src/db');
const { resolve } = path;

const dryRun = process.argv.includes('--dry-run');
const fsPromises = fs.promises;
const uploadsRoot = resolve(config.UPLOADS_DIR);

async function walk(dir) {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function normalizeUploadPath(publicPath) {
  const clean = String(publicPath || '').trim();
  if (!clean.startsWith('/uploads/')) return null;
  return resolve(uploadsRoot, clean.replace(/^\/uploads\//, ''));
}

function toPublicPath(absolutePath) {
  const relative = path.relative(uploadsRoot, absolutePath).split(path.sep).join('/');
  return `/uploads/${relative}`;
}

async function collectReferencedUploads() {
  const referenced = new Set();
  const tenants = await q('SELECT id, slug, logo FROM tenants');

  for (const tenant of tenants.rows) {
    const logoPath = normalizeUploadPath(tenant.logo);
    if (logoPath) referenced.add(logoPath);

    const products = await tdb(tenant.slug).all("SELECT image FROM {s}.products WHERE image IS NOT NULL AND image <> ''");
    for (const product of products) {
      const imagePath = normalizeUploadPath(product.image);
      if (imagePath) referenced.add(imagePath);
    }
  }

  const superadminLogo = await q("SELECT value FROM superadmin_settings WHERE key = 'superadmin_logo_url' LIMIT 1");
  const superadminLogoPath = normalizeUploadPath(superadminLogo.rows[0]?.value);
  if (superadminLogoPath) referenced.add(superadminLogoPath);

  return referenced;
}

async function removeEmptyDirectories(dir) {
  if (resolve(dir) === uploadsRoot) return;
  const entries = await fsPromises.readdir(dir);
  if (entries.length) return;
  await fsPromises.rmdir(dir);
  await removeEmptyDirectories(path.dirname(dir));
}

async function main() {
  try {
    const referenced = await collectReferencedUploads();
    const existing = fs.existsSync(uploadsRoot) ? await walk(uploadsRoot) : [];
    const orphaned = existing.filter((file) => !referenced.has(resolve(file)));

    console.log(`[cleanup] Referenciados: ${referenced.size}`);
    console.log(`[cleanup] Encontrados en disco: ${existing.length}`);
    console.log(`[cleanup] Huerfanos: ${orphaned.length}`);

    for (const file of orphaned) {
      const publicPath = toPublicPath(file);
      if (dryRun) {
        console.log(`[dry-run] ${publicPath}`);
        continue;
      }

      await fsPromises.unlink(file);
      console.log(`[deleted] ${publicPath}`);
      await removeEmptyDirectories(path.dirname(file));
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[cleanup] Error:', err.message);
  process.exit(1);
});