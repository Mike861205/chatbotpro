const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const crypto = require('node:crypto');
const config = require('../config');

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

function createImageUpload({ scopeResolver, allowedMimePattern, tempPrefix }) {
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
      files: 1,
      fields: 50,
      parts: 51,
      fieldSize: 512 * 1024,
    },
    fileFilter: (req, file, cb) => {
      if (allowedMimePattern.test(String(file.mimetype || ''))) return cb(null, true);
      return cb(Object.assign(new Error('Formato de imagen no permitido'), {
        code: 'UNSUPPORTED_FILE_TYPE',
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
  await safeUnlink(file.path);
  return `/uploads/${scope}/${finalName}`;
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

module.exports = {
  createImageUpload,
  deleteManagedUpload,
  optimizeUploadedImage,
  safeUnlink,
};
