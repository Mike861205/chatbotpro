const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const config = require('../config');

const fsPromises = fs.promises;
const SPECIAL_MIME_TYPES = new Set(['image/gif', 'image/svg+xml']);

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function ensureScopedUploadsDir(scope) {
  const dir = path.join(config.UPLOADS_DIR, scope);
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
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      cb(null, `tmp_${tempPrefix}_${Date.now()}_${randomSuffix()}${ext}`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, allowedMimePattern.test(file.mimetype)),
  });
}

async function optimizeUploadedImage(file, { scope, outputPrefix, maxWidth = 1600, quality = 80 }) {
  if (!file) return null;

  const dir = ensureScopedUploadsDir(scope);
  const ext = path.extname(file.originalname || '').toLowerCase() || '.img';
  const baseName = `${outputPrefix}_${Date.now()}_${randomSuffix()}`;

  if (SPECIAL_MIME_TYPES.has(file.mimetype)) {
    const finalName = `${baseName}${ext}`;
    const finalPath = path.join(dir, finalName);
    await fsPromises.rename(file.path, finalPath);
    return `/uploads/${scope}/${finalName}`;
  }

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