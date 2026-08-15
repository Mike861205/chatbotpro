const express = require('express');
const { q, setSetting } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');
const { CURRENCIES, TIME_ZONES, regionalDefaults, isSupportedCurrency, isSupportedTimeZone } = require('../utils/regional');

const router = express.Router();
router.use(requireAuth);

const upload = createImageUpload({
  scopeResolver: (req) => req.tenant.slug,
  allowedMimePattern: /^image\/(png|jpe?g|webp|gif)$/,
  tempPrefix: 'logo',
});

const SETTING_KEYS = [
  'business_name',
  'welcome_message',
  'whatsapp',
  'currency',
  'timezone',
  'address',
  'hours',
  'delivery_enabled',
  'pickup_enabled',
  'dine_in_enabled',
  'chatbot_receiving_modes_json',
  'location_enabled',
  'chatbot_payment_delivery_cash',
  'chatbot_payment_delivery_transfer',
  'chatbot_payment_delivery_card',
  'chatbot_payment_pickup_cash',
  'chatbot_payment_pickup_transfer',
  'chatbot_payment_pickup_card',
  'chatbot_bank_accounts_json',
  'chatbot_upsell_enabled',
  'chatbot_upsell_question',
  'chatbot_upsell_product_ids',
  'chatbot_upsell_offers_json',
  'chatbot_extra_options_json',
  'chatbot_pos_integration_enabled',
  'business_type',
  'delivery_zones_geojson',
  'delivery_fee_rules',
  'ticket_width_mm',
  'ticket_font_size_px',
  'ticket_line_height',
  'ticket_show_logo',
  'ticket_print_mode',
  'ticket_mobile_zoom_percent',
  'pos_catalog_sort_mode',
];

function normalizeReceivingModes(raw) {
  let modes;
  try {
    modes = JSON.parse(String(raw || '[]'));
  } catch {
    throw new Error('La configuración de modalidades para recibir pedidos no es válida');
  }
  if (!Array.isArray(modes) || modes.length > 10) {
    throw new Error('Puedes configurar hasta 10 modalidades personalizadas');
  }
  const used = new Set();
  return modes.map((mode, index) => {
    const label = String(mode?.label || '').trim().replace(/\s+/g, ' ').slice(0, 42);
    const behavior = ['delivery', 'branch', 'simple'].includes(mode?.behavior) ? mode.behavior : 'simple';
    let id = String(mode?.id || `custom_${index + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 36);
    if (!id || ['domicilio', 'recoger', 'comer_sucursal'].includes(id)) id = `custom_${index + 1}`;
    while (used.has(id)) id = `${id}_${index + 1}`.slice(0, 36);
    used.add(id);
    if (!label) throw new Error('Escribe el nombre de cada modalidad personalizada');
    return { id, label, behavior, enabled: mode?.enabled !== false };
  });
}

function normalizeBankAccounts(raw) {
  let accounts;
  try {
    accounts = JSON.parse(String(raw || '[]'));
  } catch {
    throw new Error('La configuración de cuentas bancarias no es válida');
  }
  if (!Array.isArray(accounts) || accounts.length > 10) {
    throw new Error('Puedes configurar hasta 10 cuentas bancarias');
  }
  return accounts.map((account) => {
    const bankName = String(account?.bankName || '').trim().slice(0, 80);
    const holderName = String(account?.holderName || '').trim().slice(0, 100);
    const identifier = String(account?.identifier || '').trim().slice(0, 50);
    const identifierType = ['account', 'clabe', 'card'].includes(account?.identifierType)
      ? account.identifierType
      : '';
    if (!bankName || !holderName || !identifier || !identifierType) {
      throw new Error('Completa banco, titular, tipo y número en cada cuenta bancaria');
    }
    return { bankName, holderName, identifierType, identifier };
  });
}

router.get('/', async (req, res, next) => {
  try {
    const out = Object.fromEntries(SETTING_KEYS.map((key) => [key, '']));
    const rows = await req.tdb.all(
      'SELECT key, value FROM {s}.settings WHERE key = ANY($1::text[])',
      [SETTING_KEYS]
    );
    for (const row of rows) out[row.key] = row.value;
    const automatic = regionalDefaults(req.tenant.phone_country);
    out.currency = out.currency || automatic.currency;
    out.timezone = out.timezone || req.tenant.timezone || automatic.timezone;
    out.regional = { currencies: CURRENCIES, timezones: TIME_ZONES, country: req.tenant.phone_country || '' };
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
    if (body.currency !== undefined) {
      body.currency = String(body.currency || '').trim().toUpperCase();
      if (!isSupportedCurrency(body.currency)) return res.status(400).json({ error: 'Selecciona una moneda válida' });
    }
    if (body.timezone !== undefined) {
      body.timezone = String(body.timezone || '').trim();
      if (!isSupportedTimeZone(body.timezone)) return res.status(400).json({ error: 'Selecciona una zona horaria válida' });
    }
    if (body.chatbot_bank_accounts_json !== undefined) {
      try {
        body.chatbot_bank_accounts_json = JSON.stringify(normalizeBankAccounts(body.chatbot_bank_accounts_json));
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    if (body.chatbot_receiving_modes_json !== undefined) {
      try {
        body.chatbot_receiving_modes_json = JSON.stringify(normalizeReceivingModes(body.chatbot_receiving_modes_json));
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    for (const k of SETTING_KEYS) {
      if (body[k] !== undefined) await setSetting(req.tdb, k, body[k]);
    }
    if (body.business_name) {
      await q('UPDATE tenants SET business_name = $1 WHERE id = $2', [body.business_name, req.tenant.id]);
    }
    if (body.primary_color && /^#[0-9a-fA-F]{6}$/.test(body.primary_color)) {
      await q('UPDATE tenants SET primary_color = $1 WHERE id = $2', [body.primary_color, req.tenant.id]);
    }
    if (body.timezone) {
      await q('UPDATE tenants SET timezone = $1 WHERE id = $2', [body.timezone, req.tenant.id]);
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
