// Rutas para gestión de Push Subscriptions (Web Push API)
const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const config = require('../config');
const { tdb } = require('../db');
const { sendTenantPush } = require('../notifications');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

// Devuelve la clave pública VAPID para que el frontend pueda suscribirse
router.get('/vapid-public-key', (req, res) => {
  if (!config.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Web Push no está configurado en este servidor' });
  }
  res.json({ publicKey: config.VAPID_PUBLIC_KEY });
});

// Guarda una nueva suscripción push del cliente
router.post('/subscribe', async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 500) {
      return res.status(400).json({ error: 'endpoint inválido' });
    }
    if (!keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'keys inválidas' });
    }
    const tenantSlug = req.tenant?.slug || req.user.slug;
    const t = tdb(tenantSlug);
    await t.run(
      `INSERT INTO {s}.push_subscriptions (endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [endpoint, keys.p256dh, keys.auth, String(req.headers['user-agent'] || '').slice(0, 200)]
    );
    res.json({ ok: true, tenant: tenantSlug });
  } catch (e) { next(e); }
});

// Elimina una suscripción push (cuando el usuario des-activa notificaciones)
router.post('/test', async (req, res, next) => {
  try {
    const tenantSlug = req.tenant?.slug || req.user.slug;
    const result = await sendTenantPush(tenantSlug, {
      title: `Prueba de notificaciones - ${req.tenant?.business_name || tenantSlug}`,
      body: 'Si ves este aviso, la PWA puede recibir pedidos con la app cerrada.',
      slug: tenantSlug,
      event: 'test_push',
      url: '/notificaciones',
    }, { ttl: 60, urgency: 'high' });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint requerido' });
    const tenantSlug = req.tenant?.slug || req.user.slug;
    const t = tdb(tenantSlug);
    await t.run('DELETE FROM {s}.push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
