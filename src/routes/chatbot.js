// API pública del chatbot (sin autenticación): la usa la liga /c/:slug
const express = require('express');
const { q, tdb, getSetting } = require('../db');
const { handleMessage, newSessionId } = require('../chatbot/engine');

const router = express.Router();

async function findTenant(req, res, next) {
  try {
    const { rows } = await q('SELECT * FROM tenants WHERE slug = $1', [req.params.slug]);
    if (!rows[0]) return res.status(404).json({ error: 'Negocio no encontrado' });
    req.tenant = rows[0];
    req.tdb = tdb(rows[0].slug);
    next();
  } catch (e) { next(e); }
}

// Info pública de branding para la página del chat
router.get('/:slug/info', findTenant, async (req, res, next) => {
  try {
    res.json({
      slug: req.tenant.slug,
      businessName: await getSetting(req.tdb, 'business_name', req.tenant.business_name),
      logo: req.tenant.logo,
      primaryColor: req.tenant.primary_color,
      address: await getSetting(req.tdb, 'address'),
      hours: await getSetting(req.tdb, 'hours'),
      whatsapp: (await getSetting(req.tdb, 'whatsapp')).replace(/\D/g, ''),
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
