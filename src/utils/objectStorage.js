const crypto = require('node:crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PUBLIC_PREFIX = '/assets/';
const PRIVATE_PREFIX = 's3-private:v1:';
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/;

function validateKey(key) {
  const value = String(key || '');
  if (!value || value.length > 600 || value.split('/').some(part => !SEGMENT.test(part) || part === '..' || part === '.')) {
    throw Object.assign(new Error('Ruta de archivo no permitida'), { status: 400 });
  }
  return value;
}

function privateKey(reference, scope) {
  if (Buffer.isBuffer(reference) && reference.subarray(0, PRIVATE_PREFIX.length).toString('utf8') !== PRIVATE_PREFIX) return null;
  const value = Buffer.isBuffer(reference) ? reference.toString('utf8') : String(reference || '');
  if (!value.startsWith(PRIVATE_PREFIX)) return null;
  const key = validateKey(value.slice(PRIVATE_PREFIX.length));
  if (!scope || !key.startsWith(`private/${validateKey(scope)}/`)) {
    throw Object.assign(new Error('Archivo de otro negocio'), { status: 403 });
  }
  return key;
}

function publicKey(reference) {
  const value = String(reference || '');
  if (!value.startsWith(PUBLIC_PREFIX)) return null;
  return `public/${validateKey(value.slice(PUBLIC_PREFIX.length))}`;
}

function createObjectStorage(env = process.env, suppliedClient) {
  const enabled = /^(true|1|on)$/i.test(String(env.S3_STORAGE_ENABLED || ''));
  const bucket = String(env.S3_BUCKET || 'assets');
  let client = suppliedClient;
  function getClient() {
    if (client) return client;
    const endpoint = new URL(env.AWS_ENDPOINT_URL_S3 || '');
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('Configuración S3 incompleta');
    }
    client = new S3Client({
      endpoint: endpoint.toString(), region: env.AWS_REGION || 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    });
    return client;
  }
  async function send(Command, input) {
    try { return await getClient().send(new Command({ Bucket: bucket, ...input })); }
    catch (error) {
      if (error.name === 'NotModified' || error.$metadata?.httpStatusCode === 304) return { $metadata: { httpStatusCode: 304 } };
      if (error.name === 'InvalidRange' || error.$metadata?.httpStatusCode === 416) throw Object.assign(new Error('Rango no válido'), { status: 416 });
      const missing = error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
      throw Object.assign(new Error(missing ? 'Archivo no encontrado' : 'Almacenamiento temporalmente no disponible. Intenta de nuevo.'), {
        status: missing ? 404 : 503, code: missing ? 'ASSET_NOT_FOUND' : 'ASSET_STORAGE_UNAVAILABLE',
      });
    }
  }
  function name(extension) {
    const ext = String(extension || 'bin').replace(/^\./, '').toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(ext)) throw new Error('Extensión no permitida');
    return `${Date.now()}_${crypto.randomBytes(18).toString('hex')}.${ext}`;
  }
  async function put({ scope, namespace = 'files', body, contentType = 'application/octet-stream', extension, public: isPublic = false, contentLength }) {
    validateKey(scope); validateKey(namespace);
    if (String(scope).includes('/') || String(namespace).includes('/')) throw new Error('Destino no permitido');
    const key = `${isPublic ? 'public' : 'private'}/${scope}/${namespace}/${name(extension)}`;
    const length = contentLength ?? (Buffer.isBuffer(body) ? body.length : undefined);
    await send(PutObjectCommand, { Key: key, Body: body, ContentType: contentType,
      ...(length !== undefined ? { ContentLength: length } : {}),
      CacheControl: isPublic ? 'public, max-age=31536000, immutable' : 'private, no-store',
    });
    return isPublic ? `${PUBLIC_PREFIX}${key.slice('public/'.length)}` : `${PRIVATE_PREFIX}${key}`;
  }
  async function readPublic(reference) {
    const key = publicKey(reference);
    if (!key) throw new Error('Referencia de archivo no válida');
    const result = await send(GetObjectCommand, { Key: key });
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async function openPublic(reference, { range, ifNoneMatch } = {}) {
    const key = publicKey(reference);
    if (!key) throw new Error('Referencia de archivo no válida');
    return send(GetObjectCommand, { Key: key, ...(range ? { Range: range } : {}), ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}) });
  }
  async function readPrivate(reference, scope) {
    const key = privateKey(reference, scope);
    if (!key) throw new Error('Referencia de archivo no válida');
    const result = await send(GetObjectCommand, { Key: key });
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async function deletePublic(reference) {
    const key = publicKey(reference);
    if (key) await send(DeleteObjectCommand, { Key: key });
  }
  async function deletePrivate(reference, scope) {
    const key = privateKey(reference, scope);
    if (key) await send(DeleteObjectCommand, { Key: key });
  }
  // Signing is local: no PostgreSQL query or S3 HEAD is needed for each image.
  async function signedPublicUrl(reference, expiresIn = 3600) {
    const key = publicKey(reference);
    if (!key) throw new Error('Referencia de archivo no válida');
    return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
  }
  return { enabled, put, readPublic, openPublic, readPrivate, deletePublic, deletePrivate, signedPublicUrl,
    destroy: () => client?.destroy?.() };
}

// Configuration is loaded first by the app. Reads remain available if new S3
// writes are disabled during a rollback; legacy files stay on their old paths.
require('../config');
const storage = createObjectStorage();
module.exports = { ...storage, createObjectStorage, publicKey, privateKey, PUBLIC_PREFIX, PRIVATE_PREFIX, validateKey };
