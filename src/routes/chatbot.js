// API pública del chatbot (sin autenticación): la usa la liga pública /:slug
const express = require('express');
const { q, tdb, getSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const { handleMessage, newSessionId } = require('../chatbot/engine');

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
    next();
  } catch (e) { next(e); }
}

// Info pública de branding para la página del chat
router.get('/:slug/info', findTenant, async (req, res, next) => {
  try {
    const configuredWhatsapp = await getSetting(req.tdb, 'whatsapp');
    const fallbackWhatsapp = decrypt(req.tenant.phone_enc || '') || '';
    res.json({
      slug: req.tenant.slug,
      businessName: await getSetting(req.tdb, 'business_name', req.tenant.business_name),
      logo: req.tenant.logo,
      primaryColor: req.tenant.primary_color,
      address: await getSetting(req.tdb, 'address'),
      hours: await getSetting(req.tdb, 'hours'),
      whatsapp: normalizeWhatsappNumber(configuredWhatsapp) || normalizeWhatsappNumber(fallbackWhatsapp),
    });
  } catch (e) { next(e); }
});

// Mensaje al chatbot
router.post('/:slug/message', findTenant, async (req, res, next) => {
  try {
    let { sessionId, message } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 64) sessionId = newSessionId();
    if (typeof message !== 'string' || message.length > 500) message = String(message || '').slice(0, 500);
    const reply = await handleMessage(req.tdb, req.tenant.slug, sessionId, message);
    res.json({ sessionId, ...reply });
  } catch (e) { next(e); }
});

module.exports = router;
