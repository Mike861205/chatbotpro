const express = require('express');
const bcrypt = require('bcryptjs');
const OpenAI = require('openai');
const config = require('../config');
const { q, setSetting, getSuperAdminSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');
const { CURRENCIES, TIME_ZONES, regionalDefaults, isSupportedCurrency, isSupportedTimeZone } = require('../utils/regional');
const { normalizeCustomPaymentMethods, normalizePaymentAccounts } = require('../utils/paymentMethods');
const { validateFloatingIcons } = require('../utils/chatbotAppearance');
const { resolveCurrencyConversion, fetchAutomaticRate, positiveRate, PROVIDER_NAME, PROVIDER_URL } = require('../utils/currencyConversion');

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
  'currency_conversion_enabled',
  'currency_conversion_target',
  'currency_conversion_mode',
  'currency_conversion_rate',
  'currency_conversion_updated_at',
  'currency_conversion_chatbot_enabled',
  'currency_conversion_pos_enabled',
  'product_tax_enabled',
  'product_tax_mode',
  'product_tax_rate',
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
  'custom_payment_methods_json',
  'chatbot_bank_accounts_json',
  'chatbot_upsell_enabled',
  'chatbot_upsell_question',
  'chatbot_upsell_product_ids',
  'chatbot_upsell_offers_json',
  'chatbot_extra_options_json',
  'chatbot_floating_icons_json',
  'chatbot_pos_integration_enabled',
  'chatbot_pos_global_orders_enabled',
  'self_service_enabled',
  'self_service_auto_print',
  'self_service_payment_cash',
  'self_service_payment_debit',
  'self_service_payment_credit',
  'self_service_payment_transfer',
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
  'pos_round_edit_enabled',
  'pos_round_edit_require_pin',
  'pos_same_day_cancel_enabled',
  'pos_cancel_require_pin',
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
    const pinSetting = await req.tdb.get(
      "SELECT 1 AS configured FROM {s}.settings WHERE key = 'pos_authorization_pin_hash' AND COALESCE(value, '') <> '' LIMIT 1"
    );
    out.authorization_pin_configured = Boolean(pinSetting);
    if (out.currency_conversion_mode === 'automatic' && out.currency_conversion_enabled === '1') {
      try {
        const conversion = await resolveCurrencyConversion(req.tdb, { raw: out });
        out.currency_conversion_rate = conversion.rate ? String(conversion.rate) : out.currency_conversion_rate;
        out.currency_conversion_updated_at = conversion.updatedAt || out.currency_conversion_updated_at;
        out.currency_conversion_stale = conversion.stale ? '1' : '0';
      } catch (error) {
        out.currency_conversion_warning = error.message;
      }
    }
    res.json(out);
  } catch (e) { next(e); }
});

router.put('/', upload.single('logo'), async (req, res, next) => {
  let nextLogoPath = null;
  try {
    if (req.user.role !== 'owner' && !(req.user.role === 'staff' && req.user.permissions.some((key) => ['config', 'chatbot'].includes(key)))) return res.status(403).json({ error: 'No tienes permiso para modificar la configuración' });
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
        body.chatbot_bank_accounts_json = JSON.stringify(normalizePaymentAccounts(body.chatbot_bank_accounts_json, { context: 'transferencias' }));
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
    if (body.pos_authorization_pin !== undefined) {
      const pin = String(body.pos_authorization_pin || '').trim();
      if (pin && !/^\d{4,8}$/.test(pin)) {
        return res.status(400).json({ error: 'El NIP debe contener de 4 a 8 dígitos' });
      }
      await setSetting(req.tdb, 'pos_authorization_pin_hash', pin ? await bcrypt.hash(pin, 12) : '');
    }
    if (body.currency_conversion_target !== undefined) {
      body.currency_conversion_target = String(body.currency_conversion_target || '').trim().toUpperCase();
      if (!isSupportedCurrency(body.currency_conversion_target)) return res.status(400).json({ error: 'Selecciona una moneda de conversión válida' });
      const baseCurrency = body.currency || await req.tdb.get("SELECT value FROM {s}.settings WHERE key='currency'");
      if (body.currency_conversion_target === String(baseCurrency?.value || baseCurrency || '').toUpperCase()) {
        return res.status(400).json({ error: 'La moneda de conversión debe ser distinta de la moneda principal' });
      }
    }
    if (body.currency_conversion_mode !== undefined && !['manual', 'automatic'].includes(body.currency_conversion_mode)) {
      return res.status(400).json({ error: 'Selecciona un modo de tipo de cambio válido' });
    }
    if (body.currency_conversion_rate !== undefined && !positiveRate(body.currency_conversion_rate)) {
      return res.status(400).json({ error: 'El tipo de cambio debe ser mayor que cero' });
    }
    if (body.product_tax_enabled !== undefined && !['0', '1'].includes(String(body.product_tax_enabled))) {
      return res.status(400).json({ error: 'Indica si deseas activar o desactivar el IVA en productos' });
    }
    if (body.product_tax_mode !== undefined && !['added', 'included'].includes(String(body.product_tax_mode))) {
      return res.status(400).json({ error: 'Selecciona si el IVA se agrega al precio o ya está incluido' });
    }
    if (body.product_tax_rate !== undefined) {
      const productTaxRate = Number(body.product_tax_rate);
      if (!Number.isFinite(productTaxRate) || productTaxRate < 0 || productTaxRate > 1) {
        return res.status(400).json({ error: 'La tasa de IVA debe estar entre 0% y 100%' });
      }
      body.product_tax_rate = String(productTaxRate);
    }
    if (body.currency_conversion_mode === 'automatic') {
      const currentRows = await req.tdb.all(
        "SELECT key,value FROM {s}.settings WHERE key=ANY($1::text[])",
        [['currency', 'currency_conversion_target']]
      );
      const current = Object.fromEntries(currentRows.map((row) => [row.key, row.value]));
      const nextBase = body.currency || current.currency || 'MXN';
      const nextTarget = body.currency_conversion_target || current.currency_conversion_target || '';
      const pairChanged = nextBase !== current.currency || nextTarget !== current.currency_conversion_target;
      body.currency_conversion_updated_at = '';
      if (pairChanged) body.currency_conversion_rate = '';
    }
    if (body.chatbot_floating_icons_json !== undefined) {
      try {
        body.chatbot_floating_icons_json = JSON.stringify(validateFloatingIcons(body.chatbot_floating_icons_json));
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    if (body.custom_payment_methods_json !== undefined) {
      try {
        body.custom_payment_methods_json = JSON.stringify(normalizeCustomPaymentMethods(body.custom_payment_methods_json));
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }
    }
    const selfServicePaymentKeys = ['self_service_payment_cash', 'self_service_payment_debit', 'self_service_payment_credit', 'self_service_payment_transfer'];
    if (selfServicePaymentKeys.some((key) => body[key] !== undefined)) {
      const currentRows = await req.tdb.all('SELECT key,value FROM {s}.settings WHERE key=ANY($1::text[])', [selfServicePaymentKeys]);
      const current = Object.fromEntries(currentRows.map((row) => [row.key, row.value]));
      const hasEnabledPayment = selfServicePaymentKeys.some((key, index) => String(
        body[key] !== undefined ? body[key] : (current[key] ?? (index === 0 ? '1' : '0'))
      ) === '1');
      if (!hasEnabledPayment) return res.status(400).json({ error: 'Activa al menos una forma de pago para autoservicio' });
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

router.post('/currency-conversion/refresh', async (req, res, next) => {
  try {
    if (req.user.role !== 'owner' && !(req.user.role === 'staff' && req.user.permissions.some((key) => ['config', 'chatbot'].includes(key)))) {
      return res.status(403).json({ error: 'No tienes permiso para actualizar el tipo de cambio' });
    }
    const baseCurrency = String(req.body?.baseCurrency || '').trim().toUpperCase();
    const targetCurrency = String(req.body?.targetCurrency || '').trim().toUpperCase();
    if (!isSupportedCurrency(baseCurrency) || !isSupportedCurrency(targetCurrency)) {
      return res.status(400).json({ error: 'Selecciona monedas válidas para consultar la tasa' });
    }
    if (baseCurrency === targetCurrency) {
      return res.status(400).json({ error: 'La moneda de conversión debe ser distinta de la moneda principal' });
    }
    const fresh = await fetchAutomaticRate(baseCurrency, targetCurrency);
    res.json({
      ok: true,
      conversion: {
        enabled: true,
        configured: true,
        baseCurrency,
        targetCurrency,
        mode: 'automatic',
        rate: fresh.rate,
        updatedAt: fresh.updatedAt,
        provider: PROVIDER_NAME,
        providerUrl: PROVIDER_URL,
      },
    });
  } catch (error) {
    error.status = 502;
    next(error);
  }
});

function buildFallbackPromoTexts({ businessName, link, productNames = [], categoryNames = [], goal = 'general', details = '' }) {
  const sampleProducts = productNames.length ? productNames.slice(0, 3).join(', ') : '';
  const businessTag = businessName.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ]/g, '');

  return [
    {
      title: 'WhatsApp y Estados Directos',
      badge: 'WhatsApp & Estados',
      text: `🍔 ¡Hoy no te quedes con el antojo! En *${businessName}* estamos listos para consentirte 😋✨${sampleProducts ? `\n\nPrueba nuestros favoritos: *${sampleProducts}*` : ''}${details ? `\n\n💥 *Nota especial:* ${details}` : ''}\n\nHaz tu pedido fácil y rápido desde nuestra liga oficial:\n👉 ${link}\n\n🛵 ¡Directo a tu puerta o listo para recoger! 🚀`,
      hook: '¡Hoy no te quedes con el antojo!',
    },
    {
      title: 'Promoción y Oferta Especial',
      badge: 'Promo & Descuento',
      text: `🔥 ¡ATENCIÓN AMIGOS! 💥${details ? `\n\n🎁 *${details}*` : `\n\n🤤 Aprovecha las mejores promociones que tenemos hoy para ti en *${businessName}*.`}\n\nOrdena desde tu celular con 1 solo clic aquí:\n📲 ${link}\n\n¡No te quedes sin el tuyo, haz tu pedido ahora! 🛵💨`,
      hook: '¡Promoción especial por tiempo limitado!',
    },
    {
      title: 'Fin de Semana & Convivio',
      badge: 'Fin de semana',
      text: `🎉 ¡El plan perfecto para hoy es con *${businessName}*! 🥳🍕\n\nOlvídate de las filas y pide tus platillos favoritos en segundos:\n👇 Entra aquí para ver el menú y ordenar:\n🔗 ${link}\n\n¡Te lo preparamos con todo el sabor! 👨‍🍳🔥`,
      hook: '¡El plan perfecto para hoy!',
    },
    {
      title: 'Publicación para Instagram y Facebook',
      badge: 'Redes Sociales',
      text: `✨ ¡Pide en línea sin complicaciones! 📲 En *${businessName}* estrenamos pedidos directos por WhatsApp.\n\n1️⃣ Entra al link\n2️⃣ Elige lo que se te antoje\n3️⃣ ¡Y listo, nosotros nos encargamos del resto! 🛵🏠\n\n👉 Haz tu pedido aquí: ${link}\n\n#${businessTag || 'Food'} #PideEnLinea #ComidaDeliciosa #MenuDigital #Antojo`,
      hook: '¡Pide en línea sin complicaciones!',
    },
  ];
}

router.post('/ai-promo-texts', requireModules('chatbot'), async (req, res, next) => {
  try {
    const { goal = 'general', details = '', tone = 'friendly', link: clientLink = '' } = req.body || {};
    const businessName = req.tenant.business_name || 'Mi Negocio';
    const slug = req.tenant.slug;
    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const link = clientLink || `${origin}/${slug}`;

    let productNames = [];
    let categoryNames = [];
    try {
      const products = await req.tdb.all(`
        SELECT p.name, c.name AS category_name, p.price::float AS price
        FROM {s}.products p
        LEFT JOIN {s}.categories c ON c.id = p.category_id
        WHERE p.active = 1
        ORDER BY p.id DESC
        LIMIT 10
      `);
      productNames = (products || []).map((p) => p.name).filter(Boolean).slice(0, 8);
      categoryNames = [...new Set((products || []).map((p) => p.category_name).filter(Boolean))].slice(0, 5);
    } catch (dbErr) {
      console.warn('[ai-promo-texts] Error leyendo productos:', dbErr?.message || dbErr);
    }

    const [modelRaw, baseUrlRaw, keyEncRaw, enabledRaw] = await Promise.all([
      getSuperAdminSetting('openai_model', 'gpt-4o-mini'),
      getSuperAdminSetting('openai_base_url', ''),
      getSuperAdminSetting('openai_api_key_enc', ''),
      getSuperAdminSetting('openai_enabled', '1'),
    ]);
    const key = decrypt(keyEncRaw || '') || config.OPENAI_API_KEY || '';
    const model = String(modelRaw || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
    const baseUrl = String(baseUrlRaw || '').trim();
    const enabled = enabledRaw !== '0';

    let results = [];

    if (enabled && key) {
      try {
        const openai = new OpenAI(baseUrl ? { apiKey: key, baseURL: baseUrl } : { apiKey: key });

        const prompt = `Eres un copywriter experto en marketing digital gastronómico y redes sociales.
Genera exactamente 4 ideas de textos cortos y llamativos para que los clientes de "${businessName}" hagan pedidos en línea usando su liga.

DATOS DEL NEGOCIO:
- Nombre: ${businessName}
- Liga para ordenar: ${link}
${productNames.length ? `- Productos de muestra: ${productNames.join(', ')}` : ''}
${categoryNames.length ? `- Categorías: ${categoryNames.join(', ')}` : ''}
- Objetivo de la publicación: ${goal}
- Tono deseado: ${tone}
${details ? `- Detalles o promoción adicional: ${details}` : ''}

REGLAS:
1. Cada variación debe ser corta, persuasiva, con emojis llamativos y bien espaciada.
2. Cada variación DEBE incluir la liga exacta: "${link}".
3. Una idea debe ser ideal para Estados de WhatsApp, otra para Promo/Urgencia, otra para Fin de semana/Antojo y otra para Redes Sociales (Instagram/Facebook).
4. Devuelve ÚNICAMENTE un JSON con la clave "ideas" conteniendo un array de 4 objetos con la siguiente estructura:
{
  "ideas": [
    {
      "title": "Nombre corto de la idea (ej: WhatsApp y Estados)",
      "badge": "WhatsApp | Promo | Fin de semana | Redes",
      "text": "El texto completo con emojis y el link incluido listo para enviar o publicar",
      "hook": "Frase gancho inicial"
    }
  ]
}`;

        const response = await openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'Eres un generador de copies publicitarios gastronómicos para WhatsApp y redes sociales. Responde únicamente en JSON válido.' },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.8,
          max_tokens: 1200,
        });

        const rawContent = response.choices?.[0]?.message?.content || '{}';
        let parsed = JSON.parse(rawContent);
        if (Array.isArray(parsed)) results = parsed;
        else if (Array.isArray(parsed.ideas)) results = parsed.ideas;
        else if (Array.isArray(parsed.variations)) results = parsed.variations;
        else if (Array.isArray(parsed.messages)) results = parsed.messages;
        else if (Array.isArray(parsed.copies)) results = parsed.copies;
      } catch (aiErr) {
        console.warn('[ai-promo-texts] Error en OpenAI, usando generador inteligente:', aiErr?.message || aiErr);
      }
    }

    if (!results || !results.length) {
      results = buildFallbackPromoTexts({ businessName, link, productNames, categoryNames, goal, details });
    }

    res.json({ ok: true, ideas: results, businessName, link });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

