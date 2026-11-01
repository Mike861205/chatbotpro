const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { q, tdb, getSetting } = require('../db');
const { requireAuth, requireModules } = require('../middleware/auth');
const { handleMessage } = require('../chatbot/engine');
const { emitWhatsAppUpdate } = require('../notifications');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');

const router = express.Router();
const secret = String(process.env.WHATSAPP_BOT_GATEWAY_SECRET || '');
const gateway = `http://127.0.0.1:${Number(process.env.WHATSAPP_BOT_GATEWAY_PORT || 3013)}`;
const mediaRoot = path.join(__dirname, '../..', 'data', 'whatsapp-bot-media');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const presets = [
  { key: 'welcome', name: 'Bienvenida', body: '¡Hola {nombre}! 👋 Bienvenido a {negocio}. Escribe *menú* para ver nuestros productos o cuéntame qué te gustaría pedir. Te guiaré paso a paso.' },
  { key: 'location_request', name: 'Solicitar ubicación', body: '📍 Para calcular el servicio a domicilio, comparte tu ubicación actual desde WhatsApp: toca el clip o + → Ubicación → Enviar ubicación actual. Después te pediré la dirección. El costo de envío se calculará con las zonas y tarifas configuradas por {negocio}; si está fuera de cobertura, te avisaremos antes de confirmar el costo.' },
  { key: 'order_confirmation', name: 'Confirmación con total y envío', body: '✅ *Pedido #{pedido} recibido en {negocio}*\nHola {nombre}, este es tu resumen:\n{productos}\n\nSubtotal: {subtotal}\nServicio a domicilio: {envio}\n*Total: {total}*\nModalidad: {servicio}\nDirección: {direccion}\nUbicación: {ubicacion}\n{nota_envio}' },
  { key: 'preparing', name: 'Pedido en preparación', body: '👨‍🍳 Hola {nombre}, estamos preparando tu pedido #{pedido} de {negocio}.\nTotal: {total}.\nTe avisaremos cuando esté listo.' },
  { key: 'ready', name: 'Pedido listo', body: '🎉 ¡Listo, {nombre}! Tu pedido #{pedido} está preparado.\nModalidad: {servicio}.\nTotal: {total}.\nGracias por elegir {negocio}.' },
  { key: 'delivery', name: 'Pedido en camino', body: '🛵 Hola {nombre}, tu pedido #{pedido} va en camino.\nDirección: {direccion}\nUbicación: {ubicacion}\nEnvío: {envio}\nTotal: {total}.' },
];
const ORDER_VARIABLES = new Set(['pedido', 'productos', 'subtotal', 'envio', 'total', 'servicio', 'direccion', 'ubicacion', 'zona', 'nota_envio']);
function presetBody(key) { return presets.find(preset => preset.key === key)?.body || ''; }
async function activePresetBody(t, key) {
  const saved = await t.get('SELECT body FROM {s}.whatsapp_bot_templates WHERE preset_key=$1 LIMIT 1', [key]);
  return saved?.body || presetBody(key);
}
function formatMoney(value, currency = 'MXN') {
  try { return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(Number(value || 0)); }
  catch { return `$${Number(value || 0).toFixed(2)}`; }
}
function orderTemplateValues(order, { businessName, currency }) {
  let items = [];
  try { items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]'); } catch {}
  const delivery = order.receiving_mode_behavior === 'delivery' || order.delivery === 'domicilio';
  const pending = delivery && /pendiente de validar/i.test(String(order.delivery_zone_name || ''));
  const lat = order.customer_location_lat == null ? NaN : Number(order.customer_location_lat);
  const lng = order.customer_location_lng == null ? NaN : Number(order.customer_location_lng);
  const location = Number.isFinite(lat) && Number.isFinite(lng) ? `https://www.google.com/maps?q=${lat},${lng}` : delivery ? 'Pendiente de compartir' : 'No aplica';
  return {
    nombre: decrypt(order.name_enc || '') || 'cliente', negocio: businessName, pedido: String(order.id),
    productos: items.map(item => `• ${Number(item.qty || 1)}x ${String(item.name || 'Producto').slice(0, 100)}`).join('\n') || 'Productos del pedido',
    subtotal: formatMoney(order.subtotal, currency),
    envio: delivery ? pending ? 'Por confirmar' : formatMoney(order.delivery_fee, currency) : 'No aplica',
    total: pending ? `${formatMoney(order.total, currency)} + envío por confirmar` : formatMoney(order.total, currency),
    servicio: delivery ? 'Entrega a domicilio' : order.receiving_mode_label || 'Recoger en sucursal',
    direccion: delivery ? order.delivery_address || 'Pendiente de indicar' : order.pickup_branch_name || 'Recoger en sucursal',
    ubicacion: location,
    zona: order.delivery_zone_name || (delivery ? 'Por confirmar' : 'No aplica'),
    nota_envio: pending ? '⚠️ La zona y el costo final del servicio a domicilio están pendientes de validar.' : '',
  };
}
async function loadOrderContext(t, orderId) {
  const order = await t.get(`SELECT o.id,o.items,o.subtotal,o.total,o.delivery_fee,o.delivery_zone_name,o.delivery,
    o.receiving_mode_behavior,o.receiving_mode_label,o.delivery_address,o.pickup_branch_name,
    o.customer_location_lat,o.customer_location_lng,c.name_enc,c.phone_enc
    FROM {s}.orders o LEFT JOIN {s}.customers c ON c.id=o.customer_id
    WHERE o.id=$1 AND o.source_channel='whatsapp_bot' LIMIT 1`, [orderId]);
  if (!order) return null;
  const businessName = await getSetting(t, 'business_name', 'Tu negocio');
  const currency = await getSetting(t, 'currency', 'MXN');
  return { values: orderTemplateValues(order, { businessName, currency }), phone: validPhone(decrypt(order.phone_enc || '')) };
}
function renderTemplate(body, values) {
  return String(body).replace(/\{([a-zA-Z][\w]{0,39})\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key] ?? '').slice(0, 500) : match);
}
function variables(body) { return [...new Set([...String(body).matchAll(/\{([a-zA-Z][\w]{0,39})\}/g)].map(match => match[1]))]; }
function validateAutomaticTemplate(presetKey, body) {
  const allowed = presetKey === 'location_request' ? new Set(['negocio']) :
    presetKey === 'order_confirmation' ? new Set(['nombre', 'negocio', ...ORDER_VARIABLES]) : null;
  if (!allowed) return '';
  const unsupported = variables(body).filter(key => !allowed.has(key));
  return unsupported.length ? `La plantilla automática no puede usar estas variables: ${unsupported.join(', ')}` : '';
}
async function templatePayload(t, body, input, { requireRecipient = false } = {}) {
  const orderId = Number(input?.orderId);
  const context = Number.isInteger(orderId) && orderId > 0 ? await loadOrderContext(t, orderId) : null;
  if (orderId && !context) throw Object.assign(new Error('Pedido de WhatsApp Bot no encontrado'), { status: 404 });
  if (!context && variables(body).some(key => ORDER_VARIABLES.has(key))) {
    throw Object.assign(new Error('Selecciona un pedido para calcular el subtotal, envío, total y ubicación reales'), { status: 400 });
  }
  const supplied = input?.values && typeof input.values === 'object' && !Array.isArray(input.values) ? input.values : {};
  const values = { ...supplied, negocio: await getSetting(t, 'business_name', 'Tu negocio'), ...(context?.values || {}) };
  const missing = variables(body).filter(key => !Object.hasOwn(values, key));
  if (missing.length) throw Object.assign(new Error(`Faltan variables: ${missing.join(', ')}`), { status: 400 });
  const phone = context ? context.phone : validPhone(input?.phone);
  if (requireRecipient && !phone) throw Object.assign(new Error('Este pedido no tiene teléfono válido; indica un número con clave de país'), { status: 400 });
  return { text: renderTemplate(body, values), phone, values };
}
function replyChoices(reply) {
  return [
    ...(reply.products || []).map(product => ({ label: `${product.name} · ${product.priceLabel || ''}`, value: `prod_${product.id}` })),
    ...(reply.options || []).filter(option => option.value !== 'share_location').map(option => ({ label: option.label, value: option.value })),
  ].slice(0, 30);
}
function validPhone(value) { const phone = String(value || '').replace(/\D/g, ''); return /^\d{8,15}$/.test(phone) ? phone : ''; }
function owner(req, res, next) { return req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Sólo el propietario puede administrar la conexión' }); }
async function gatewayCall(route, method = 'GET', body) {
  if (secret.length < 32) { const error = new Error('Configura WHATSAPP_BOT_GATEWAY_SECRET para activar el canal'); error.status = 503; throw error; }
  let response;
  try { response = await fetch(`${gateway}${route}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) }); }
  catch { const error = new Error('La pasarela WhatsApp Bot no está disponible'); error.status = 503; throw error; }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(result.error || 'Error en la pasarela'); error.status = response.status; throw error; }
  return result;
}
function fail(next, error) { if (error.status) return next(Object.assign(error, { statusCode: error.status })); return next(error); }
function signatureMatches(req) {
  if (secret.length < 32 || !req.rawBody) return false;
  const supplied = String(req.get('x-gateway-signature') || '');
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
const queues = new Map();
function enqueue(key, task) {
  const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
async function sendAndRecord(t, sessionId, jid, text) {
  const result = await gatewayCall(`/sessions/${sessionId}/send`, 'POST', { jid, message: text });
  await t.run(`INSERT INTO {s}.whatsapp_bot_messages(session_id,external_message_id,contact_jid_enc,contact_jid_hash,direction,body)
    VALUES($1,$2,$3,$4,'outbound',$5) ON CONFLICT(session_id,external_message_id) DO NOTHING`,
  [sessionId, result.messageId || crypto.randomUUID(), encrypt(jid), lookupHash(jid), text]);
}
async function runBot(t, tenant, sessionId, jid, text, customerName) {
  const chatId = `wab_${crypto.createHash('sha256').update(`${sessionId}:${jid}`).digest('hex').slice(0, 48)}`;
  if (!text.trim()) { await sendAndRecord(t, sessionId, jid, 'Recibí tu imagen 📷. Para continuar con tu pedido, escribe lo que necesitas o envía *hola*.'); return; }
  let input = text;
  if (/^\d{1,2}$/.test(input.trim())) {
    const row = await t.get('SELECT choices_json FROM {s}.whatsapp_bot_choices WHERE session_id=$1 AND contact_jid_hash=$2', [sessionId, lookupHash(jid)]);
    try {
      const choices = JSON.parse(row?.choices_json || '[]');
      input = choices[Number(input.trim()) - 1]?.value || input;
    } catch {}
  }
  const reply = await handleMessage(t, tenant, chatId, input, {
    orderChannel: 'chatbot', sourceChannel: 'whatsapp', customerPhone: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : '', customerName,
  });
  const messages = (reply.messages || []).filter(message => !/el negocio aún no tiene un WhatsApp válido/i.test(String(message)));
  if ((reply.options || []).some(option => option.value === 'share_location')) {
    const businessName = await getSetting(t, 'business_name', 'el negocio');
    const prompt = renderTemplate(await activePresetBody(t, 'location_request'), { negocio: businessName });
    if (messages.length) messages[messages.length - 1] = prompt;
    else messages.push(prompt);
  }
  const choices = replyChoices(reply);
  await t.run(`INSERT INTO {s}.whatsapp_bot_choices(session_id,contact_jid_hash,choices_json) VALUES($1,$2,$3)
    ON CONFLICT(session_id,contact_jid_hash) DO UPDATE SET choices_json=EXCLUDED.choices_json`, [sessionId, lookupHash(jid), JSON.stringify(choices)]);
  if (choices.length) messages.push(`Responde con el número de una opción:\n${choices.map((option, index) => `${index + 1}. ${option.label}`).join('\n')}`);
  if (reply.order?.id) {
    await t.run(`UPDATE {s}.orders SET source_channel='whatsapp_bot', whatsapp_external_id=$1 WHERE id=$2`, [`baileys:${sessionId}:${jid}`, reply.order.id]);
    const context = await loadOrderContext(t, reply.order.id);
    if (context) messages[0] = renderTemplate(await activePresetBody(t, 'order_confirmation'), context.values);
  }
  for (const message of messages.filter(Boolean)) await sendAndRecord(t, sessionId, jid, String(message));
  emitWhatsAppUpdate(tenant, { event: 'message' });
}

// Private callback. A valid HMAC and the registry mapping determine the tenant.
router.post('/internal/message', async (req, res, next) => {
  try {
    if (!signatureMatches(req)) return res.status(401).json({ error: 'Firma inválida' });
    const { sessionId, messageId, jid, pushName, text, type, mediaBase64 } = req.body || {};
    if (!uuid.test(String(sessionId)) || !/^[A-Za-z0-9_-]{8,180}$/.test(String(messageId)) || !/^\d{8,20}@(s\.whatsapp\.net|lid)$/.test(String(jid))) return res.status(400).json({ error: 'Mensaje inválido' });
    const registry = (await q(`SELECT r.tenant_slug FROM whatsapp_bot_registry r
      JOIN tenants t ON t.slug=r.tenant_slug
      WHERE r.session_id=$1 AND r.enabled=TRUE AND t.account_status='active' AND t.billing_status<>'suspended'`, [sessionId])).rows[0];
    if (!registry) return res.status(404).json({ error: 'Sesión desconocida' });
    const t = tdb(registry.tenant_slug);
    const kind = type === 'image' ? 'image' : type === 'location' ? 'location' : 'text';
    const geo = kind === 'location' ? String(text || '').match(/^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:\|.*)?$/) : null;
    if (kind === 'location' && (!geo || Math.abs(Number(geo[1])) > 90 || Math.abs(Number(geo[2])) > 180)) return res.status(400).json({ error: 'Ubicación inválida' });
    const storedBody = kind === 'location' ? `Ubicación compartida: https://www.google.com/maps?q=${geo[1]},${geo[2]}` : String(text || '').slice(0, 10000);
    let mediaPath = '';
    if (kind === 'image' && typeof mediaBase64 === 'string' && mediaBase64.length < 700000 && /^[A-Za-z0-9+/=]+$/.test(mediaBase64)) {
      const dir = path.join(mediaRoot, registry.tenant_slug);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      mediaPath = path.join(dir, `${crypto.randomUUID()}.jpg`);
      await fs.writeFile(mediaPath, Buffer.from(mediaBase64, 'base64'), { mode: 0o600 });
    }
    const row = await t.get(`INSERT INTO {s}.whatsapp_bot_messages(session_id,external_message_id,contact_jid_enc,contact_jid_hash,direction,message_type,body,media_path)
      VALUES($1,$2,$3,$4,'inbound',$5,$6,$7) ON CONFLICT(session_id,external_message_id) DO NOTHING RETURNING id`,
    [sessionId, messageId, encrypt(jid), lookupHash(jid), kind, storedBody, mediaPath]);
    if (!row) { if (mediaPath) await fs.rm(mediaPath, { force: true }); return res.json({ ok: true, duplicate: true }); }
    res.json({ ok: true });
    enqueue(`${sessionId}:${jid}`, () => runBot(t, registry.tenant_slug, sessionId, jid, String(text || '').slice(0, 10000), String(pushName || '').slice(0, 120)))
      .catch(error => console.error('[whatsapp-bot][engine]', registry.tenant_slug, error.message));
  } catch (error) { next(error); }
});

router.use(requireAuth, requireModules('whatsapp-bot'));
async function connectionStatus(req) {
  const row = (await q('SELECT session_id FROM whatsapp_bot_registry WHERE tenant_slug=$1 AND enabled=TRUE', [req.tenant.slug])).rows[0];
  let connection = { status: 'not_connected', qr: '', phone: '' };
  if (row) connection = await gatewayCall(`/sessions/${row.session_id}`).catch(error => ({ status: 'unavailable', qr: '', phone: '', error: error.message }));
  if (connection.phone) {
    const zernio = await req.tdb.get(`SELECT id FROM {s}.whatsapp_connections
      WHERE enabled=1 AND regexp_replace(phone_number,'[^0-9]','','g')=$1 LIMIT 1`, [connection.phone]);
    connection.conflict = Boolean(zernio);
  }
  return connection;
}
router.get('/status', async (req, res, next) => {
  try { res.json({ connection: await connectionStatus(req) }); }
  catch (error) { fail(next, error); }
});
router.get('/', async (req, res, next) => {
  try {
    const connection = await connectionStatus(req);
    const templates = await req.tdb.all('SELECT id,name,body,preset_key AS "presetKey",created_at,updated_at FROM {s}.whatsapp_bot_templates ORDER BY id DESC');
    const orders = await req.tdb.all(`SELECT o.id,o.total,o.created_at,c.name_enc,c.phone_enc
      FROM {s}.orders o LEFT JOIN {s}.customers c ON c.id=o.customer_id
      WHERE o.source_channel='whatsapp_bot' ORDER BY o.id DESC LIMIT 30`);
    const currency = await getSetting(req.tdb, 'currency', 'MXN');
    const businessName = await getSetting(req.tdb, 'business_name', req.tenant.business_name || 'Tu negocio');
    res.json({ connection, templates, presets, businessName, orders: orders.map(row => ({
      id: Number(row.id), label: `#${row.id} · ${decrypt(row.name_enc || '') || 'Cliente'} · ${formatMoney(row.total, currency)}`,
      phone: validPhone(decrypt(row.phone_enc || '')),
    })) });
  } catch (error) { fail(next, error); }
});
router.get('/orders/:id/context', async (req, res, next) => {
  try {
    const context = await loadOrderContext(req.tdb, Number(req.params.id));
    if (!context) return res.status(404).json({ error: 'Pedido de WhatsApp Bot no encontrado' });
    res.json(context);
  } catch (error) { next(error); }
});
router.post('/connect', owner, async (req, res, next) => {
  try {
    let row = (await q('SELECT session_id FROM whatsapp_bot_registry WHERE tenant_slug=$1', [req.tenant.slug])).rows[0];
    if (!row) row = (await q(`INSERT INTO whatsapp_bot_registry(session_id,tenant_slug) VALUES($1,$2)
      ON CONFLICT(tenant_slug) DO UPDATE SET enabled=TRUE RETURNING session_id`, [crypto.randomUUID(), req.tenant.slug])).rows[0];
    else await q('UPDATE whatsapp_bot_registry SET enabled=TRUE WHERE tenant_slug=$1', [req.tenant.slug]);
    await gatewayCall('/sessions', 'POST', { id: row.session_id, tenant: req.tenant.slug });
    res.json({ ok: true });
  } catch (error) { fail(next, error); }
});
router.post('/disconnect', owner, async (req, res, next) => {
  try {
    const row = (await q('SELECT session_id FROM whatsapp_bot_registry WHERE tenant_slug=$1', [req.tenant.slug])).rows[0];
    if (row) {
      await gatewayCall(`/sessions/${row.session_id}`, 'DELETE');
      await q('DELETE FROM whatsapp_bot_registry WHERE tenant_slug=$1', [req.tenant.slug]);
    }
    res.json({ ok: true });
  } catch (error) { fail(next, error); }
});
router.post('/test', async (req, res, next) => {
  try {
    const phone = validPhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Indica un número con clave de país' });
    const row = (await q('SELECT session_id FROM whatsapp_bot_registry WHERE tenant_slug=$1 AND enabled=TRUE', [req.tenant.slug])).rows[0];
    if (!row) return res.status(409).json({ error: 'Conecta WhatsApp primero' });
    const text = String(req.body?.message || 'Hola, esta es una prueba de WhatsApp Bot.').trim().slice(0, 10000);
    if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
    await sendAndRecord(req.tdb, row.session_id, `${phone}@s.whatsapp.net`, text);
    res.json({ ok: true });
  } catch (error) { fail(next, error); }
});
router.post('/templates', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    const presetKey = presets.some(preset => preset.key === req.body?.presetKey) ? req.body.presetKey : '';
    if (!name || !body) return res.status(400).json({ error: 'Nombre y texto son obligatorios' });
    const invalid = validateAutomaticTemplate(presetKey, body);
    if (invalid) return res.status(400).json({ error: invalid });
    const row = await req.tdb.get(`INSERT INTO {s}.whatsapp_bot_templates(name,body,preset_key) VALUES($1,$2,$3)
      ON CONFLICT (preset_key) WHERE preset_key <> '' DO UPDATE SET name=EXCLUDED.name,body=EXCLUDED.body,updated_at=now()
      RETURNING id,name,body,preset_key AS "presetKey"`, [name, body, presetKey]);
    res.status(201).json({ template: row, variables: variables(body) });
  } catch (error) { next(error); }
});
router.put('/templates/:id', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const body = String(req.body?.body || '').trim().slice(0, 4000);
    if (!name || !body) return res.status(400).json({ error: 'Nombre y texto son obligatorios' });
    const current = await req.tdb.get('SELECT preset_key FROM {s}.whatsapp_bot_templates WHERE id=$1', [Number(req.params.id)]);
    if (!current) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const invalid = validateAutomaticTemplate(current.preset_key, body);
    if (invalid) return res.status(400).json({ error: invalid });
    const row = await req.tdb.get('UPDATE {s}.whatsapp_bot_templates SET name=$1,body=$2,updated_at=now() WHERE id=$3 RETURNING id,name,body,preset_key AS "presetKey"', [name, body, Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json({ template: row, variables: variables(body) });
  } catch (error) { next(error); }
});
router.delete('/templates/:id', async (req, res, next) => {
  try { await req.tdb.run('DELETE FROM {s}.whatsapp_bot_templates WHERE id=$1', [Number(req.params.id)]); res.json({ ok: true }); }
  catch (error) { next(error); }
});
router.post('/templates/:id/preview', async (req, res, next) => {
  try {
    const row = await req.tdb.get('SELECT body FROM {s}.whatsapp_bot_templates WHERE id=$1', [Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Plantilla no encontrada' });
    const prepared = await templatePayload(req.tdb, row.body, req.body);
    res.json({ text: prepared.text, variables: variables(row.body) });
  } catch (error) { fail(next, error); }
});
async function sendTemplate(req, res, next, body) {
  try {
    const row = (await q('SELECT session_id FROM whatsapp_bot_registry WHERE tenant_slug=$1 AND enabled=TRUE', [req.tenant.slug])).rows[0];
    if (!row) return res.status(409).json({ error: 'Conecta WhatsApp primero' });
    const prepared = await templatePayload(req.tdb, body, req.body, { requireRecipient: true });
    await sendAndRecord(req.tdb, row.session_id, `${prepared.phone}@s.whatsapp.net`, prepared.text);
    res.json({ ok: true, text: prepared.text });
  } catch (error) { fail(next, error); }
}
router.post('/templates/send', async (req, res, next) => {
  const body = String(req.body?.body || '').trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: 'Escribe una plantilla' });
  return sendTemplate(req, res, next, body);
});
router.post('/templates/:id/send', async (req, res, next) => {
  try {
    const template = await req.tdb.get('SELECT body FROM {s}.whatsapp_bot_templates WHERE id=$1', [Number(req.params.id)]);
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });
    return sendTemplate(req, res, next, template.body);
  } catch (error) { fail(next, error); }
});
router.get('/messages', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(`SELECT m.id,m.contact_jid_enc,
      COALESCE(to_jsonb(m)->>'contact_jid','') AS legacy_jid,
      m.direction,m.message_type,m.body,m.created_at,m.media_path <> '' AS has_media
      FROM {s}.whatsapp_bot_messages m ORDER BY m.id DESC LIMIT 100`);
    res.json({ messages: rows.map(({ contact_jid_enc, legacy_jid, ...row }) => ({ ...row, contact_jid: decrypt(contact_jid_enc) || legacy_jid })) });
  } catch (error) { next(error); }
});
router.get('/media/:id', async (req, res, next) => {
  try {
    const row = await req.tdb.get('SELECT media_path FROM {s}.whatsapp_bot_messages WHERE id=$1', [Number(req.params.id)]);
    if (!row?.media_path) return res.status(404).end();
    res.type('jpeg').sendFile(row.media_path);
  } catch (error) { next(error); }
});
router.renderTemplate = renderTemplate;
router.variables = variables;
router.replyChoices = replyChoices;
router.orderTemplateValues = orderTemplateValues;
router.validateAutomaticTemplate = validateAutomaticTemplate;
module.exports = router;
