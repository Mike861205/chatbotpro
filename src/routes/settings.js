const express = require('express');
const { q, getSetting, setSetting } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');

const router = express.Router();
router.use(requireAuth);

const upload = createImageUpload({
  scopeResolver: (req) => req.tenant.slug,
  allowedMimePattern: /^image\/(png|jpe?g|webp|svg\+xml)$/,
  tempPrefix: 'logo',
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
  'location_enabled',
  'chatbot_payment_delivery_cash',
  'chatbot_payment_delivery_transfer',
  'chatbot_payment_delivery_card',
  'chatbot_payment_pickup_cash',
  'chatbot_payment_pickup_transfer',
  'chatbot_payment_pickup_card',
  'chatbot_pos_integration_enabled',
  'delivery_zones_geojson',
  'delivery_fee_rules',
  'ticket_width_mm',
  'ticket_font_size_px',
  'ticket_line_height',
  'ticket_show_logo',
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
  let nextLogoPath = null;
  try {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'No tienes permiso para modificar la configuración' });
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
      nextLogoPath = await optimizeUploadedImage(req.file, { scope: req.tenant.slug, outputPrefix: 'logo', maxWidth: 1200, quality: 82 });
      await q('UPDATE tenants SET logo = $1 WHERE id = $2', [nextLogoPath, req.tenant.id]);
      if (req.tenant.logo && req.tenant.logo !== nextLogoPath) {
        const refs = await q('SELECT COUNT(*)::int AS total FROM tenants WHERE logo = $1 AND id <> $2', [req.tenant.logo, req.tenant.id]);
        if (!Number(refs.rows[0]?.total || 0)) await deleteManagedUpload(req.tenant.logo);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    try {
      if (nextLogoPath) await deleteManagedUpload(nextLogoPath);
      else if (req.file) await safeUnlink(req.file.path);
    } catch {}
    next(e);
  }
});

module.exports = router;
