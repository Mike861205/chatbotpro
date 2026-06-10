const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const master = require('../db/master');
const { requireAuth } = require('../middleware/auth');
const { getSetting, setSetting } = require('../db/tenant');

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
  limits: { fileSize: 2 * 1024 * 1024 },
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

router.get('/', (req, res) => {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(req.tdb, k);
  out.logo = req.tenant.logo;
  out.primary_color = req.tenant.primary_color;
  out.slug = req.tenant.slug;
  res.json(out);
});

router.put('/', upload.single('logo'), (req, res) => {
  const body = req.body || {};
  for (const k of SETTING_KEYS) {
    if (body[k] !== undefined) setSetting(req.tdb, k, body[k]);
  }
  // Actualiza branding en la BD maestra
  if (body.business_name) {
    master.prepare('UPDATE tenants SET business_name = ? WHERE id = ?').run(body.business_name, req.tenant.id);
  }
  if (body.primary_color && /^#[0-9a-fA-F]{6}$/.test(body.primary_color)) {
    master.prepare('UPDATE tenants SET primary_color = ? WHERE id = ?').run(body.primary_color, req.tenant.id);
  }
  if (req.file) {
    const logoPath = `/uploads/${req.tenant.slug}/${req.file.filename}`;
    master.prepare('UPDATE tenants SET logo = ? WHERE id = ?').run(logoPath, req.tenant.id);
  }
  res.json({ ok: true });
});

module.exports = router;
