const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const storage = require('./objectStorage');
const root = path.join(config.DATA_DIR, 'whatsapp-bot-media');

function legacyPath(reference, scope) {
  storage.validateKey(scope);
  if (String(scope).includes('/')) throw new Error('Negocio no permitido');
  const directory = path.resolve(root, scope);
  const filename = String(reference || '');
  // Menu settings historically store a basename; message rows store an
  // absolute path. Both must resolve inside this tenant's original folder.
  const target = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(directory, filename);
  if (!target.startsWith(`${directory}${path.sep}`)) throw Object.assign(new Error('Archivo no permitido'), { status: 403 });
  return target;
}
async function saveMedia(bytes, scope) {
  if (storage.enabled) return storage.put({ scope, namespace: 'whatsapp', body: bytes, extension: 'jpg', contentType: 'image/jpeg' });
  const target = legacyPath(`${crypto.randomUUID()}.jpg`, scope);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, bytes, { mode: 0o600 });
  return target;
}
async function readMedia(reference, scope) {
  if (storage.privateKey(reference, scope)) return storage.readPrivate(reference, scope);
  try { return await fs.readFile(legacyPath(reference, scope)); }
  catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Archivo no encontrado'), { status: 404 });
    throw error;
  }
}
async function deleteMedia(reference, scope) {
  if (!reference) return;
  if (storage.privateKey(reference, scope)) return storage.deletePrivate(reference, scope);
  return fs.rm(legacyPath(reference, scope), { force: true });
}
module.exports = { saveMedia, readMedia, deleteMedia };
