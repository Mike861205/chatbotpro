const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const express = require('express');
const storage = require('../src/utils/objectStorage');
const config = require('../src/config');
const uploads = require('../src/utils/uploads');
const documents = require('../src/utils/storedDocuments');
const media = require('../src/utils/whatsappMedia');

function mockStore() {
  const objects = new Map();
  const calls = [];
  const client = { async send(command) {
    const { Key, Body } = command.input;
    calls.push(command);
    if (command.constructor.name === 'PutObjectCommand') {
      const chunks = [];
      if (Body && typeof Body[Symbol.asyncIterator] === 'function' && !Buffer.isBuffer(Body)) {
        for await (const part of Body) chunks.push(Buffer.from(part));
      } else chunks.push(Buffer.from(Body));
      objects.set(Key, Buffer.concat(chunks));
      return {};
    }
    if (command.constructor.name === 'GetObjectCommand') {
      if (!objects.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToByteArray: async () => objects.get(Key) } };
    }
    if (command.constructor.name === 'DeleteObjectCommand') { objects.delete(Key); return {}; }
    throw new Error('unexpected operation');
  } };
  return { ...storage.createObjectStorage({ S3_STORAGE_ENABLED: 'true', S3_BUCKET: 'assets' }, client), objects, calls };
}

function useMock(t) {
  const mock = mockStore();
  const before = {};
  for (const key of ['enabled', 'put', 'readPublic', 'readPrivate', 'deletePublic', 'deletePrivate', 'signedPublicUrl']) {
    before[key] = storage[key]; storage[key] = mock[key];
  }
  t.after(() => Object.assign(storage, before));
  return mock;
}

test('S3 guarda rutas únicas, contenido y MIME; público y privado tienen prefijos distintos', async () => {
  const mock = mockStore();
  const one = await mock.put({ scope: 'tenant-a', body: Buffer.from('video'), contentType: 'video/mp4', extension: 'mp4', public: true });
  const two = await mock.put({ scope: 'tenant-a', body: Buffer.from('video'), contentType: 'video/mp4', extension: 'mp4', public: true });
  assert.notEqual(one, two);
  assert.match(one, /^\/assets\/tenant-a\/files\/.+\.mp4$/);
  assert.equal((await mock.readPublic(one)).toString(), 'video');
  assert.equal(mock.calls[0].input.ContentType, 'video/mp4');
  assert.equal(mock.calls[0].input.Bucket, 'assets');
  const privateRef = await mock.put({ scope: 'tenant-a', body: Buffer.from('private'), extension: 'pdf' });
  assert.match(privateRef, /^s3-private:v1:private\/tenant-a\//);
  assert.equal((await mock.readPrivate(privateRef, 'tenant-a')).toString(), 'private');
  const callCount = mock.calls.length;
  await assert.rejects(mock.readPrivate(privateRef, 'tenant-b'), { status: 403 });
  await assert.rejects(mock.deletePrivate(privateRef, 'tenant-b'), { status: 403 });
  assert.equal(mock.calls.length, callCount);
  await mock.deletePublic(one);
  await assert.rejects(mock.readPublic(one), { status: 404 });
});

test('referencias impiden traversal, claves privadas por URL pública y secretos en errores', async () => {
  for (const key of ['../private/file', 'a/../b', '/a', 'a//b', 'a/%2e%2e/b', 'a\\b']) assert.throws(() => storage.validateKey(key));
  assert.equal(storage.publicKey('s3-private:v1:private/tenant-a/file.pdf'), null);
  assert.equal(storage.publicKey('/assets/private/tenant-a/file.pdf'), 'public/private/tenant-a/file.pdf');
  const broken = storage.createObjectStorage({ S3_STORAGE_ENABLED: 'true' }, { send: async () => { throw new Error('SECRET_DO_NOT_DISPLAY'); } });
  await assert.rejects(broken.put({ scope: 'a', body: Buffer.from('a') }), error => error.status === 503 && !error.message.includes('SECRET'));
  await assert.rejects(mockStore().put({ scope: 'a/b', body: Buffer.from('a') }));
});

test('nuevas imágenes se optimizan en WebP, van a S3 y eliminan temporales; las antiguas siguen legibles', async t => {
  const mock = useMock(t);
  const scope = `test-s3-${crypto.randomBytes(8).toString('hex')}`;
  const directory = path.join(config.UPLOADS_DIR, scope);
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'blue' } }).png().toBuffer();
  const legacy = path.join(directory, 'legacy.png');
  await fs.writeFile(legacy, png);
  const uploaded = path.join(directory, 'tmp.upload');
  await fs.writeFile(uploaded, png);
  const reference = await uploads.optimizeUploadedImage({ path: uploaded }, { scope, outputPrefix: 'prod' });
  assert.match(reference, /^\/assets\//);
  assert.equal((await sharp(await uploads.readManagedUpload(reference)).metadata()).format, 'webp');
  assert.deepEqual(await fs.readdir(directory), ['legacy.png']);
  assert.deepEqual(await uploads.readManagedUpload(`/uploads/${scope}/legacy.png`), png);
  const ref2 = await uploads.saveImageBuffer(png, { scope, outputPrefix: 'checada' });
  assert.match(ref2, /^\/assets\//);
  assert.deepEqual(await fs.readdir(directory), ['legacy.png']);
  await uploads.deleteManagedUpload(reference);
  assert.equal(mock.objects.has(storage.publicKey(reference)), false);
  assert.deepEqual(await fs.readFile(legacy), png);
});

test('si S3 falla no se devuelve una ruta guardada y se retiran archivos temporales', async t => {
  useMock(t);
  storage.put = async () => { throw Object.assign(new Error('storage unavailable'), { status: 503 }); };
  const scope = `test-s3-${crypto.randomBytes(8).toString('hex')}`;
  const directory = path.join(config.UPLOADS_DIR, scope);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer();
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'temp.upload'); await fs.writeFile(file, png);
  await assert.rejects(uploads.optimizeUploadedImage({ path: file }, { scope, outputPrefix: 'prod' }), { status: 503 });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('PDF nuevos guardan solo referencia en BYTEA, CFDI cifra referencia y conserva base64 histórico', async t => {
  useMock(t);
  const bytes = Buffer.from('%PDF-1.7 sample');
  const ref = await documents.storeDocument(bytes, { scope: 'tenant-a' });
  assert.ok(Buffer.isBuffer(ref));
  assert.match(ref.toString(), /^s3-private:v1:/);
  assert.deepEqual(await documents.readDocument(ref, 'tenant-a'), bytes);
  assert.deepEqual(await documents.readDocument(bytes, 'tenant-a'), bytes);
  await assert.rejects(documents.readDocument(ref, 'tenant-b'), { status: 403 });
  const xml = Buffer.from('<invoice/>').toString('base64');
  const tdb = { schema: 't_tenant_a' };
  const stored = await documents.storeBase64Document(xml, tdb, 'xml');
  const { encrypt, decrypt } = require('../src/utils/crypto');
  const encrypted = encrypt(stored);
  assert.equal(await documents.readBase64Document(decrypt(encrypted), tdb), xml);
  assert.equal(await documents.readBase64Document(xml, tdb), xml);
  await assert.rejects(documents.readBase64Document(stored, { schema: 't_tenant_b' }), { status: 403 });
  storage.enabled = false;
  assert.deepEqual(await documents.storeDocument(bytes, { scope: 'tenant-a' }), bytes);
  assert.equal(await documents.readBase64Document(stored, tdb), xml);
});

test('medios de WhatsApp conservan lectura local y protegen menú y adjuntos de otros tenants', async t => {
  useMock(t);
  const scope = `test-s3-${crypto.randomBytes(8).toString('hex')}`;
  const directory = path.join(config.DATA_DIR, 'whatsapp-bot-media', scope);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(directory, { recursive: true });
  const legacy = path.join(directory, 'menu.jpg'); await fs.writeFile(legacy, 'legacy');
  assert.equal((await media.readMedia('menu.jpg', scope)).toString(), 'legacy');
  assert.equal((await media.readMedia(legacy, scope)).toString(), 'legacy');
  const ref = await media.saveMedia(Buffer.from('new'), scope);
  assert.match(ref, /^s3-private:v1:/);
  assert.equal((await media.readMedia(ref, scope)).toString(), 'new');
  await assert.rejects(media.readMedia(ref, 'other-tenant'), { status: 403 });
  await assert.rejects(media.readMedia('../other-tenant/menu.jpg', scope), { status: 403 });
  await media.deleteMedia(ref, scope);
  assert.deepEqual(await fs.readdir(directory), ['menu.jpg']);
});

test('URL pública estable redirige con firma renovada; CSP permite solo el endpoint configurado', async t => {
  useMock(t);
  storage.signedPublicUrl = async reference => `https://example.storage.neon.tech/assets/${storage.publicKey(reference)}?signature=temporary`;
  const oldEndpoint = process.env.AWS_ENDPOINT_URL_S3;
  process.env.AWS_ENDPOINT_URL_S3 = 'https://example.storage.neon.tech';
  t.after(() => { if (oldEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_S3; else process.env.AWS_ENDPOINT_URL_S3 = oldEndpoint; });
  const app = express();
  app.use(require('../src/middleware/security').securityHeaders());
  app.use('/assets', require('../src/middleware/assets').servePublicAsset);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/assets/tenant-a/prod/image.webp`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /assets\/public\/tenant-a\/prod\/image.webp/);
  assert.match(response.headers.get('cache-control'), /max-age=300/);
  assert.match(response.headers.get('content-security-policy'), /img-src[^;]+https:\/\/example.storage.neon.tech/);
  assert.match(response.headers.get('content-security-policy'), /media-src[^;]+https:\/\/example.storage.neon.tech/);
  assert.equal((await fetch(`${base}/assets/a/%252e%252e/file`)).status, 404);
  assert.equal((await fetch(`${base}/assets/a/file`, { method: 'POST' })).status, 405);
});

function responseCapture() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key] = value; return this; }, setHeader(key, value) { this.headers[key] = value; },
    type(value) { this.contentType = value; return this; }, send(value) { this.body = value; return this; },
    json(value) { this.body = value; return this; }, end() { return this; } };
}
function handler(router, route, method = 'get') {
  return router.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack.at(-1).handle;
}

test('rutas SAR suben PDF y descargan todos los adjuntos nuevos e históricos sin modificar importes', async t => {
  useMock(t);
  const router = require('../src/routes/sar');
  const pdf = Buffer.from('%PDF-1.7 SAR fixture');
  let sqlParams;
  const req = { tenant: { slug: 'tenant-a' }, user: { role: 'owner', username: 'owner' },
    params: { period: '2026-11' }, body: { adjustmentType: 'period_payment', amount: '123.45', reference: 'Receipt 123' },
    file: { buffer: pdf, originalname: 'receipt.pdf' },
    tdb: { get: async (_sql, params) => { sqlParams = params; return { id: 42 }; } } };
  const response = responseCapture();
  await handler(router, '/filings/:period/adjustments', 'post')(req, response, error => { throw error; });
  assert.equal(response.statusCode, 201);
  assert.equal(sqlParams[2], 123.45);
  const ref = sqlParams[5]; assert.match(ref.toString(), /^s3-private:v1:/);
  for (const [route, column] of [
    ['/authorizations/:id/pdf', 'source_pdf'], ['/orders/:id/exoneration-proof', 'sar_exoneration_proof_pdf'],
    ['/purchases/:id/pdf', 'source_pdf'], ['/filings/adjustments/:id/pdf', 'proof_pdf'], ['/filings/receipts/:id/pdf', 'receipt_pdf'],
  ]) {
    for (const value of [ref, pdf]) {
      const output = responseCapture();
      await handler(router, route)({ ...req, params: { id: 42 }, tdb: { get: async () => ({ [column]: value }) } }, output, error => { throw error; });
      assert.deepEqual(output.body, pdf, route);
    }
  }
});

test('rutas CFDI individual, global, directo y REP entregan bytes idénticos para S3 e histórico', async t => {
  useMock(t);
  const { encrypt } = require('../src/utils/crypto');
  const router = require('../src/routes/invoicing');
  for (const format of ['pdf', 'xml']) {
    const bytes = Buffer.from(format === 'pdf' ? '%PDF-1.7 CFDI fixture' : '<cfdi:Comprobante/>');
    const base64 = bytes.toString('base64');
    const stored = await documents.storeBase64Document(base64, { schema: 't_tenant_a' }, format);
    for (const content of [stored, base64]) {
      for (const route of ['/invoices/:id/:format', '/global-invoices/:id/:format', '/direct-invoices/:id/:format', '/payment-complements/:id/:format']) {
        const response = responseCapture();
        await handler(router, route)({ params: { id: 42, format }, tdb: { schema: 't_tenant_a', get: async () => ({ id: 42, uuid: 'fixture', [`${format}_enc`]: encrypt(content) }) } }, response, error => { throw error; });
        assert.deepEqual(response.body, bytes, route);
        assert.match(response.headers['Content-Disposition'], new RegExp(`\\.${format}"$`));
      }
    }
  }
});

test('menú WhatsApp se guarda privado y sus rutas descargan menú y mensaje del mismo tenant', async t => {
  useMock(t);
  const router = require('../src/routes/whatsappBot');
  let setting = '';
  const req = { tenant: { slug: 'tenant-a' }, user: { role: 'owner' }, params: { id: 42 },
    file: { buffer: await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).png().toBuffer() },
    tdb: { get: async () => ({ value: setting, media_path: setting }), run: async (_sql, params) => { setting = params[1]; } } };
  const uploaded = responseCapture();
  await handler(router, '/menu-image', 'post')(req, uploaded, error => { throw error; });
  assert.equal(uploaded.statusCode, 201);
  assert.match(setting, /^s3-private:v1:/);
  for (const route of ['/menu-image', '/media/:id']) {
    const downloaded = responseCapture();
    await handler(router, route)(req, downloaded, error => { throw error; });
    assert.equal((await sharp(downloaded.body).metadata()).format, 'jpeg');
  }
});
