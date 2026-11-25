const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('node:crypto');
const config = require('../config');
const objectStorage = require('./objectStorage');

const fsPromises = fs.promises;

function randomSuffix() {
  return crypto.randomBytes(12).toString('hex');
}

function ensureScopedUploadsDir(scope) {
  const cleanScope = String(scope || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(cleanScope)) {
    throw Object.assign(new Error('Destino de archivo no permitido'), { status: 400 });
  }
  const dir = path.join(config.UPLOADS_DIR, cleanScope);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createImageUpload({ scopeResolver, allowedMimePattern, fileValidator, unsupportedMessage, tempPrefix, maxFiles = 1, maxFields = 50, fieldSize = 512 * 1024 }) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        cb(null, ensureScopedUploadsDir(scopeResolver(req)));
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      cb(null, `tmp_${tempPrefix}_${Date.now()}_${randomSuffix()}.upload`);
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: maxFiles,
      fields: maxFields,
      parts: maxFiles + maxFields,
      fieldSize,
    },
    fileFilter: (req, file, cb) => {
      if (fileValidator ? fileValidator(file) : allowedMimePattern.test(String(file.mimetype || ''))) return cb(null, true);
      return cb(Object.assign(new Error(unsupportedMessage || 'Formato de imagen no permitido'), {
        code: fileValidator ? 'UNSUPPORTED_CATALOG_FILE' : 'UNSUPPORTED_FILE_TYPE',
        status: 415,
      }));
    },
  });
}

async function optimizeUploadedImage(file, { scope, outputPrefix, maxWidth = 1600, quality = 80 }) {
  if (!file) return null;

  const dir = ensureScopedUploadsDir(scope);
  const baseName = `${outputPrefix}_${Date.now()}_${randomSuffix()}`;

  const finalName = `${baseName}.webp`;
  const finalPath = path.join(dir, finalName);
  await sharp(file.path)
    .rotate()
    .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toFile(finalPath);
  try {
    if (objectStorage.enabled) {
      const reference = await objectStorage.put({ scope: String(scope).toLowerCase(), namespace: outputPrefix,
        body: await fsPromises.readFile(finalPath),
        extension: 'webp', contentType: 'image/webp', public: true });
      return reference;
    }
    return `/uploads/${scope}/${finalName}`;
  } finally {
    await safeUnlink(file.path);
    if (objectStorage.enabled) await safeUnlink(finalPath);
  }
}

async function saveImageBuffer(bytes, { scope, outputPrefix = 'image', maxWidth = 1600, quality = 80 }) {
  const cleanScope = String(scope || '').trim().toLowerCase();
  const dir = ensureScopedUploadsDir(cleanScope);
  const finalName = `${outputPrefix}_${Date.now()}_${randomSuffix()}.webp`;
  const finalPath = path.join(dir, finalName);
  try {
    await sharp(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []), { failOn: 'none' })
      .rotate()
      .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toFile(finalPath);
    if (objectStorage.enabled) {
      try {
        return await objectStorage.put({ scope: cleanScope, namespace: outputPrefix,
          body: await fsPromises.readFile(finalPath),
          extension: 'webp', contentType: 'image/webp', public: true });
      } finally { await safeUnlink(finalPath); }
    }
    return `/uploads/${cleanScope}/${finalName}`;
  } catch (error) {
    await safeUnlink(finalPath);
    throw error;
  }
}

function resolveManagedUploadPath(publicPath) {
  const clean = String(publicPath || '').trim();
  if (!clean.startsWith('/uploads/')) return null;

  const relativePath = clean.replace(/^\/uploads\//, '').split('/').filter(Boolean);
  if (!relativePath.length) return null;

  const absolutePath = path.resolve(config.UPLOADS_DIR, ...relativePath);
  const uploadsRoot = path.resolve(config.UPLOADS_DIR) + path.sep;
  if (!absolutePath.startsWith(uploadsRoot) && absolutePath !== path.resolve(config.UPLOADS_DIR)) return null;

  return absolutePath;
}

async function safeUnlink(targetPath) {
  if (!targetPath) return;
  try {
    await fsPromises.unlink(targetPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function deleteManagedUpload(publicPath) {
  if (String(publicPath || '').startsWith(objectStorage.PUBLIC_PREFIX)) {
    // A cleanup outage must not roll back a successfully saved product/logo
    // and then remove its new image in the caller's error handler.
    await objectStorage.deletePublic(publicPath).catch(error => {
      console.warn('[storage] Asset cleanup deferred', error.code || 'storage_error');
    });
    return;
  }
  const absolutePath = resolveManagedUploadPath(publicPath);
  if (!absolutePath) return;
  await safeUnlink(absolutePath);

  const parentDir = path.dirname(absolutePath);
  if (path.resolve(parentDir) === path.resolve(config.UPLOADS_DIR)) return;

  try {
    const files = await fsPromises.readdir(parentDir);
    if (!files.length) await fsPromises.rmdir(parentDir);
  } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(err.code)) throw err;
  }
}

async function readManagedUpload(publicPath) {
  if (String(publicPath || '').startsWith(objectStorage.PUBLIC_PREFIX)) return objectStorage.readPublic(publicPath);
  const absolutePath = resolveManagedUploadPath(publicPath);
  if (!absolutePath) throw Object.assign(new Error('Archivo no permitido'), { status: 404 });
  return fsPromises.readFile(absolutePath);
}

module.exports = {
  createImageUpload,
  deleteManagedUpload,
  optimizeUploadedImage,
  saveImageBuffer,
  resolveManagedUploadPath,
  safeUnlink,
  readManagedUpload,
};
