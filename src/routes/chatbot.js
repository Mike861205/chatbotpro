// API pública del chatbot (sin autenticación): la usa la liga /c/:slug
const express = require('express');
const master = require('../db/master');
const { getTenantDb, getSetting } = require('../db/tenant');
const { handleMessage, newSessionId } = require('../chatbot/engine');

const router = express.Router();

function findTenant(req, res, next) {
  const tenant = master.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Negocio no encontrado' });
  req.tenant = tenant;
  req.tdb = getTenantDb(tenant.slug);
  next();
}

// Info pública de branding para la página del chat
router.get('/:slug/info', findTenant, (req, res) => {
  res.json({
    slug: req.tenant.slug,
    businessName: getSetting(req.tdb, 'business_name', req.tenant.business_name),
    logo: req.tenant.logo,
    primaryColor: req.tenant.primary_color,
    address: getSetting(req.tdb, 'address'),
    hours: getSetting(req.tdb, 'hours'),
    whatsapp: getSetting(req.tdb, 'whatsapp').replace(/\D/g, ''),
  });
});

// Mensaje al chatbot
router.post('/:slug/message', findTenant, async (req, res) => {
  try {
    let { sessionId, message } = req.body || {};
    if (!sessionId) sessionId = newSessionId();
    if (typeof message !== 'string' || message.length > 500) message = String(message || '').slice(0, 500);
    const reply = await handleMessage(req.tdb, req.tenant.slug, sessionId, message);
    res.json({ sessionId, ...reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error en el chatbot' });
  }
});

module.exports = router;
