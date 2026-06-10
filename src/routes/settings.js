const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const { q, getSetting, setSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.UPLOADS_DIR, req.tenant.slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `logo_${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.mimetype)),
});

const SETTING_KEYS = [
  'business_name',
  'welcome_message',
  'whatsapp',
  'currency',
  'address',
  'hours',
  'delivery_enabled',
  'pickup_enabled',
];

router.get('/', async (req, res, next) => {
  try {
    const out = {};
    for (const k of SETTING_KEYS) out[k] = await getSetting(req.tdb, k);
    out.logo = req.tenant.logo;
    out.primary_color = req.tenant.primary_color;
    out.slug = req.tenant.slug;
    res.json(out);
  } catch (e) { next(e); }
});

router.put('/', upload.single('logo'), async (req, res, next) => {
  try {
    const body = req.body || {};
    for (const k of SETTING_KEYS) {
      if (body[k] !== undefined) await setSetting(req.tdb, k, body[k]);
    }
    if (body.business_name) {
      await q('UPDATE tenants SET business_name = $1 WHERE id = $2', [body.business_name, req.tenant.id]);
    }
    if (body.primary_color && /^#[0-9a-fA-F]{6}$/.test(body.primary_color)) {
      await q('UPDATE tenants SET primary_color = $1 WHERE id = $2', [body.primary_color, req.tenant.id]);
    }
    if (req.file) {
      const logoPath = `/uploads/${req.tenant.slug}/${req.file.filename}`;
      await q('UPDATE tenants SET logo = $1 WHERE id = $2', [logoPath, req.tenant.id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
