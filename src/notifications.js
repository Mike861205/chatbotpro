// Módulo centralizado de notificaciones en tiempo real.
// Gestiona Socket.io rooms por tenant y Web Push para segundo plano.
const EventEmitter = require('events');
const webpush = require('web-push');
const config = require('./config');
const { tdb } = require('./db');

const emitter = new EventEmitter();
let _io = null; // instancia de Socket.io (se inyecta desde server.js)

if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    config.VAPID_SUBJECT,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY
  );
}

/**
 * Registra la instancia de Socket.io. Llamar desde server.js después de crearla.
 */
function setIo(io) {
  _io = io;
}

/**
 * Emite un nuevo pedido a todos los listeners del tenant:
 *  - Socket.io: sala 'tenant:<slug>'
 *  - Web Push: todas las subscripciones guardadas del tenant
 */
async function emitNewOrder(slug, order) {
  // 1. Socket.io (tiempo real cuando la página está abierta)
  if (_io) {
    _io.to(`tenant:${slug}`).emit('new_order', order);
  }

  // 2. Web Push (notificaciones de fondo)
  if (!config.VAPID_PUBLIC_KEY) return; // VAPID no configurado, skip
  try {
    const t = tdb(slug);
    const { rows } = await t.all('SELECT endpoint, p256dh, auth FROM {s}.push_subscriptions');
    const payload = JSON.stringify({
      title: `🛒 Pedido #${order.id} — ${order.businessName || slug}`,
      body: order.summary || `Total: ${order.totalLabel || order.total}`,
      slug,
      orderId: order.id,
    });
    const dead = [];
    await Promise.all(
      rows.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 300 }
          );
        } catch (err) {
          // 410 Gone = suscripción expirada/revocada, limpiar
          if (err.statusCode === 410 || err.statusCode === 404) dead.push(sub.endpoint);
          else console.error('[push] error enviando a', sub.endpoint.slice(-20), err.statusCode || err.message);
        }
      })
    );
    if (dead.length) {
      for (const ep of dead) {
        await t.run('DELETE FROM {s}.push_subscriptions WHERE endpoint = $1', [ep]).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[push] error general:', e.message);
  }
}

module.exports = { emitter, setIo, emitNewOrder };
