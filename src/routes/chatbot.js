// API pública del chatbot (sin autenticación): la usa la liga pública /:slug
const express = require('express');
const config = require('../config');
const { q, tdb, getSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const { handleMessage, newSessionId } = require('../chatbot/engine');
const { parseFloatingIcons } = require('../utils/chatbotAppearance');
const { normalizeTimeZone } = require('../utils/regional');
const { productAvailabilityFields } = require('../utils/productAvailability');
const { loadProductTaxConfig, effectiveProductPrice } = require('../utils/productTax');
const { getActivePromotions, decorateCatalogProducts } = require('../utils/promotions');

const router = express.Router();

function normalizeWhatsappNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  digits = digits.replace(/^00+/, '');
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  if (digits.length === 10) digits = `52${digits}`;
  if (digits.length < 11 || digits.length > 15) return '';
  return digits;
}

async function findTenant(req, res, next) {
  try {
    const { rows } = await q('SELECT * FROM tenants WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Negocio no encontrado' });
    if (rows[0].account_status !== 'active') {
      return res.status(403).json({ error: 'Este negocio no está activo actualmente' });
    }
    if (rows[0].billing_status === 'suspended') {
      return res.status(402).json({ error: 'Este negocio está temporalmente suspendido por pago pendiente' });
    }
    req.tenant = rows[0];
    req.tdb = tdb(rows[0].slug);
    req.tdb.timezone = normalizeTimeZone(rows[0].timezone);
    next();
  } catch (e) { next(e); }
}

// Info pública de branding para la página del chat
router.get('/:slug/info', findTenant, async (req, res, next) => {
  try {
    const configuredWhatsapp = await getSetting(req.tdb, 'whatsapp');
    const whatsappConnection = await req.tdb.get(
      `SELECT phone_number,metadata_json
       FROM {s}.whatsapp_connections
       WHERE enabled=1 AND status IN ('active','connected')
       ORDER BY id DESC LIMIT 1`
    );
    let zernioWhatsapp = whatsappConnection?.phone_number || '';
    try {
      const metadata = JSON.parse(whatsappConnection?.metadata_json || '{}');
      zernioWhatsapp = zernioWhatsapp || metadata?.sandbox?.number || '';
    } catch {}
    const fallbackWhatsapp = decrypt(req.tenant.phone_enc || '') || '';
    res.json({
      slug: req.tenant.slug,
      businessName: await getSetting(req.tdb, 'business_name', req.tenant.business_name),
      logo: req.tenant.logo,
      primaryColor: req.tenant.primary_color,
      address: await getSetting(req.tdb, 'address'),
      hours: await getSetting(req.tdb, 'hours'),
      whatsapp: normalizeWhatsappNumber(zernioWhatsapp)
        || normalizeWhatsappNumber(configuredWhatsapp)
        || normalizeWhatsappNumber(fallbackWhatsapp),
      floatingIcons: parseFloatingIcons(await getSetting(req.tdb, 'chatbot_floating_icons_json')),
    });
  } catch (e) { next(e); }
});

// Menú público para los QR de Productos
router.get('/:slug/menu', findTenant, async (req, res, next) => {
  try {
    if ((await getSetting(req.tdb, 'product_qr_enabled', '0')) !== '1') {
      return res.status(404).json({ error: 'El menú QR no está activado para este negocio' });
    }
    const requestedId = req.query.producto === undefined ? null : Number(req.query.producto);
    if (requestedId !== null && (!Number.isSafeInteger(requestedId) || requestedId <= 0)) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const rows = await req.tdb.all(
      `SELECT p.id, p.category_id, p.name, p.description, p.price::float AS price, p.image, p.sale_days,
              c.name AS category_name
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY COALESCE(c.sort, 0), c.name NULLS FIRST, p.name`
    );
    const now = new Date();
    const tax = await loadProductTaxConfig(req.tdb);
    const products = decorateCatalogProducts(rows.map((product) => ({
      ...product,
      price: effectiveProductPrice(product.price, tax),
      ...productAvailabilityFields(product, now, req.tdb.timezone),
    })), await getActivePromotions(req.tdb, 'chatbot'));
    const selected = requestedId === null ? products : products.filter((product) => Number(product.id) === requestedId);
    if (requestedId !== null && !selected.length) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({
      businessName: await getSetting(req.tdb, 'business_name', req.tenant.business_name),
      logo: req.tenant.logo,
      primaryColor: req.tenant.primary_color,
      currency: await getSetting(req.tdb, 'currency', 'MXN'),
      slug: req.tenant.slug,
      products: selected.map(({ id, name, description, category_id, category_name, image, availableToday,
        price, promotionalPrice, activePromotion }) => ({
        id, name, description, category_id, category_name, image, availableToday,
        price, promotionalPrice, promotion: activePromotion?.label || activePromotion?.name || '',
      })),
    });
  } catch (e) { next(e); }
});

// Mensaje al chatbot
router.post('/:slug/message', findTenant, async (req, res, next) => {
  try {
    let { sessionId, message } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) sessionId = newSessionId();
    if (typeof message !== 'string' || message.length > 500) message = String(message || '').slice(0, 500);
    const previewOrder = req.body?.preview === true
      && config.DEMO_LOGIN_ENABLED
      && req.tenant.slug === config.DEMO_TENANT_SLUG;
    const reseller = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(String(req.body?.reseller || ''))
      ? String(req.body.reseller)
      : '';
    const registrationUrl = `/register?source=chatbot-demo${reseller ? `&reseller=${encodeURIComponent(reseller)}` : ''}`;
    const reply = await handleMessage(req.tdb, req.tenant.slug, sessionId, message, { previewOrder, registrationUrl });
    res.json({ sessionId, ...reply });
  } catch (e) { next(e); }
});

module.exports = router;
