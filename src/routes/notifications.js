// Rutas para gestión de Push Subscriptions (Web Push API)
const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const config = require('../config');
const { tdb } = require('../db');

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
    const t = tdb(req.user.tenantSlug);
    await t.run(
      `INSERT INTO {s}.push_subscriptions (endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
      [endpoint, keys.p256dh, keys.auth, String(req.headers['user-agent'] || '').slice(0, 200)]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Elimina una suscripción push (cuando el usuario des-activa notificaciones)
router.post('/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint || typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint requerido' });
    const t = tdb(req.user.tenantSlug);
    await t.run('DELETE FROM {s}.push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
