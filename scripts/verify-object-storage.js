// Creates only isolated diagnostic objects. No tenant/database writes.
const fs = require('node:fs');
const path = require('node:path');
const envIndex = process.argv.indexOf('--env');
if (envIndex >= 0) process.env.ENV_FILE = process.argv[envIndex + 1];
require('../src/config');
const storage = require('../src/utils/objectStorage');
const sharp = require('sharp');
const { storeDocument, readDocument } = require('../src/utils/storedDocuments');
const { saveMedia, readMedia, deleteMedia } = require('../src/utils/whatsappMedia');
const { saveImageBuffer, readManagedUpload } = require('../src/utils/uploads');

async function main() {
  if (!storage.enabled) throw new Error('S3 storage is not enabled');
  const publicUrlIndex = process.argv.indexOf('--url');
  const baseUrl = publicUrlIndex < 0 ? '' : process.argv[publicUrlIndex + 1];
  if (baseUrl && !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(baseUrl)) throw new Error('Use a localhost --url');
  const scope = `storage-check-${require('node:crypto').randomBytes(8).toString('hex')}`;
  const created = [];
  const checks = [];
  const check = (name, condition) => {
    if (!condition) throw new Error(`Failed: ${name}`);
    checks.push({ name, passed: true });
  };
  try {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#2d9969' } }).png().toBuffer();
    const image = await saveImageBuffer(png, { scope, outputPrefix: 'diagnostics' }); created.push({ public: true, ref: image });
    check('image stored in bucket', image.startsWith('/assets/'));
    check('optimized webp readable', (await sharp(await readManagedUpload(image)).metadata()).format === 'webp');
    const url = await storage.signedPublicUrl(image);
    const signed = await fetch(url, { signal: AbortSignal.timeout(15000) });
    check('presigned image download', signed.status === 200 && signed.headers.get('content-type') === 'image/webp');
    await signed.arrayBuffer();
    const anonymous = await fetch(url.split('?')[0], { signal: AbortSignal.timeout(15000) });
    check('bucket stays private', anonymous.status === 403 || anonymous.status === 401); await anonymous.arrayBuffer();
    if (baseUrl) {
      const result = await fetch(`${baseUrl}${image}`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      check('stable same-origin URL downloads object', result.status === 200 && result.headers.get('content-type') === 'image/webp');
      await result.arrayBuffer();
      const unchanged = await fetch(`${baseUrl}${image}`, { headers: { 'If-None-Match': result.headers.get('etag') }, signal: AbortSignal.timeout(15000) });
      check('conditional browser cache', unchanged.status === 304); await unchanged.arrayBuffer();
      const home = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(15000) });
      check('CSP allows storage endpoint', (home.headers.get('content-security-policy') || '').includes(new URL(process.env.AWS_ENDPOINT_URL_S3).origin)); await home.arrayBuffer();
    }
    const pdf = Buffer.from('%PDF-1.7\nDiagnostic storage round-trip only\n%%EOF');
    const doc = await storeDocument(pdf, { scope, namespace: 'diagnostics' }); created.push({ ref: doc });
    check('PDF stores only reference', doc.toString().startsWith(storage.PRIVATE_PREFIX));
    check('PDF round-trip', (await readDocument(doc, scope)).equals(pdf));
    let denied = false;
    try { await readDocument(doc, 'different-tenant'); } catch (error) { denied = error.status === 403; }
    check('cross-tenant PDF rejected', denied);
    const whatsapp = await saveMedia(png, scope); created.push({ ref: whatsapp });
    check('WhatsApp media round-trip', (await readMedia(whatsapp, scope)).equals(png));
    // Test range access used by large media without uploading a large fixture.
    const video = await storage.put({ scope, namespace: 'diagnostics', body: Buffer.alloc(4096, 7), extension: 'mp4', contentType: 'video/mp4', public: true });
    created.push({ public: true, ref: video });
    const partial = await fetch(await storage.signedPublicUrl(video), { headers: { Range: 'bytes=0-127' }, signal: AbortSignal.timeout(15000) });
    check('media byte ranges', partial.status === 206 && (await partial.arrayBuffer()).byteLength === 128);
    if (baseUrl) {
      const range = await fetch(`${baseUrl}${video}`, { headers: { Range: 'bytes=0-127' }, signal: AbortSignal.timeout(15000) });
      check('same-origin media ranges', range.status === 206 && (await range.arrayBuffer()).byteLength === 128);
      const head = await fetch(`${baseUrl}${video}`, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      check('same-origin HEAD metadata', head.status === 200 && Number(head.headers.get('content-length')) === 4096);
    }
    check('no permanent local image', (await fs.promises.readdir(path.join(require('../src/config').UPLOADS_DIR, scope))).length === 0);
  } finally {
    for (const item of created) {
      if (item.public) await storage.deletePublic(item.ref);
      else await storage.deletePrivate(item.ref, scope);
    }
    const localDirectory = path.resolve(require('../src/config').UPLOADS_DIR, scope);
    if (path.dirname(localDirectory) !== path.resolve(require('../src/config').UPLOADS_DIR)) throw new Error('Unsafe diagnostic path');
    await fs.promises.rmdir(localDirectory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    storage.destroy();
  }
  const report = { observed_at: new Date().toISOString(), bucket: process.env.S3_BUCKET || 'assets', checks, diagnostic_objects_removed: true };
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); storage.destroy(); process.exitCode = 1; });
