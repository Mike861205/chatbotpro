// Modulo centralizado de notificaciones en tiempo real.
// Gestiona Socket.io rooms por tenant y Web Push para segundo plano.
const EventEmitter = require('events');
const webpush = require('web-push');
const config = require('./config');
const { tdb } = require('./db');

const emitter = new EventEmitter();
let _io = null;

const sessionPushMarks = new Map();
const SESSION_PUSH_TTL_MS = 30 * 60 * 1000;

if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    config.VAPID_SUBJECT,
    config.VAPID_PUBLIC_KEY,
    config.VAPID_PRIVATE_KEY
  );
}

function setIo(io) {
  _io = io;
}

function canSendWebPush() {
  return Boolean(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
}

function cleanSessionPushMarks() {
  const now = Date.now();
  for (const [key, ts] of sessionPushMarks) {
    if (now - ts > SESSION_PUSH_TTL_MS) sessionPushMarks.delete(key);
  }
}

async function sendTenantPush(slug, payload, options = {}) {
  if (!canSendWebPush()) return { sent: 0, skipped: 'vapid' };
  try {
    const t = tdb(slug);
    const { rows } = await t.all('SELECT endpoint, p256dh, auth FROM {s}.push_subscriptions');
    if (!rows.length) return { sent: 0, skipped: 'no_subscriptions' };

    const dead = [];
    let sent = 0;
    await Promise.all(
      rows.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: options.ttl || 300, urgency: options.urgency || 'high' }
          );
          sent += 1;
        } catch (err) {
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
    return { sent, dead: dead.length };
  } catch (e) {
    console.error('[push] error general:', e.message);
    return { sent: 0, error: e.message };
  }
}

function maybePushSessionUpdate(slug, sessionData) {
  const sessionId = String(sessionData?.sessionId || '').trim();
  const step = String(sessionData?.step || '');
  if (!slug || !sessionId) return;

  cleanSessionPushMarks();

  const hasCart = Array.isArray(sessionData.cart) && sessionData.cart.length > 0;
  const milestones = [];
  if (step && step !== 'start') milestones.push('active');
  if (hasCart) milestones.push('cart');
  if (step === 'confirm') milestones.push('confirm');
  if (!milestones.length) return;

  const milestone = milestones[milestones.length - 1];
  const key = `${slug}:${sessionId}:${milestone}`;
  if (sessionPushMarks.has(key)) return;
  sessionPushMarks.set(key, Date.now());

  const title = milestone === 'confirm'
    ? `Cliente listo para confirmar - ${slug}`
    : `Cliente activo en chatbot - ${slug}`;
  const body = hasCart
    ? `Carrito: ${sessionData.cartTotalLabel || sessionData.cartTotal || ''}`
    : `Paso: ${step}`;

  sendTenantPush(slug, {
    title,
    body,
    slug,
    sessionId,
    event: milestone === 'confirm' ? 'session_confirm' : 'session_active',
    url: '/notificaciones',
  }, { ttl: 120, urgency: 'high' }).catch(() => {});
}

function emitSessionUpdate(slug, sessionData) {
  if (_io) {
    _io.to(`tenant:${slug}`).emit('session_update', sessionData);
  }
  maybePushSessionUpdate(slug, sessionData);
}

async function emitNewOrder(slug, order) {
  if (_io) {
    _io.to(`tenant:${slug}`).emit('new_order', order);
  }

  await sendTenantPush(slug, {
    title: `Nuevo pedido #${order.id} - ${order.businessName || slug}`,
    body: order.summary || `Total: ${order.totalLabel || order.total}`,
    slug,
    orderId: order.id,
    event: 'new_order',
    url: '/notificaciones',
  }, { ttl: 300, urgency: 'high' });
}

module.exports = { emitter, setIo, emitNewOrder, emitSessionUpdate, sendTenantPush };
