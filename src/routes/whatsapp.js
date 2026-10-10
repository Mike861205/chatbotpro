const express = require('express');
const crypto = require('node:crypto');
const { q, tdb } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { handleMessage } = require('../chatbot/engine');
const { emitWhatsAppUpdate, sendTenantPush } = require('../notifications');
const config = require('../config');
const { connectionChoices, selectConnectionChoice } = require('../utils/zernioSetup');

const router = express.Router();
const ZERNIO_BASE_URL = String(process.env.ZERNIO_API_BASE_URL || 'https://zernio.com/api').replace(/\/+$/, '');
const WEBHOOK_MAX_PAYLOAD = 250000;
const WEBHOOK_EVENTS = [
  'message.received', 'message.sent', 'message.delivered', 'message.read', 'message.failed',
  'conversation.started', 'whatsapp.template.status_updated',
];

function clean(value, max = 240) {
  return String(value ?? '').trim().slice(0, max);
}

function safeJson(value, fallback = {}) {
  try { return typeof value === 'string' ? JSON.parse(value || '{}') : (value ?? fallback); } catch { return fallback; }
}

function safePayload(value) {
  const raw = JSON.stringify(value ?? {});
  return raw.length > WEBHOOK_MAX_PAYLOAD ? `${raw.slice(0, WEBHOOK_MAX_PAYLOAD)}…` : raw;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secretMatches(expected, supplied) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(supplied || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function publicBaseUrl(req) {
  return String(config.WHATSAPP_PUBLIC_URL || `${req.protocol}://${req.get('host') || ''}`)
    .trim().replace(/\/+$/, '');
}

function webhookUrlFor(req, webhookToken) {
  return `${publicBaseUrl(req)}/api/whatsapp/webhook/${encodeURIComponent(webhookToken)}`;
}

function isPublicWebhookUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch { return false; }
}

function webhookSignatureMatches(req, secret) {
  if (!secret) return true;
  const supplied = String(req.get('x-zernio-signature') || req.get('x-late-signature') || '').trim().replace(/^sha256=/i, '');
  if (!supplied || !req.rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return secretMatches(expected, supplied);
}

function getPath(object, path) {
  return String(path).split('.').reduce((current, key) => current == null ? undefined : current[key], object);
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function whatsappLocation(payload) {
  const candidates = [
    getPath(payload, 'metadata.location'),
    getPath(payload, 'message.metadata.location'),
    getPath(payload, 'data.metadata.location'),
    getPath(payload, 'data.message.metadata.location'),
    getPath(payload, 'location'),
    getPath(payload, 'message.location'),
    getPath(payload, 'data.location'),
    getPath(payload, 'data.message.location'),
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? safeJson(candidate, null) : candidate;
    if (!value || typeof value !== 'object') continue;
    const lat = Number(value.latitude ?? value.lat ?? value.latitud);
    const lng = Number(value.longitude ?? value.lng ?? value.lon ?? value.longitud);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    const label = clean(value.label ?? value.name ?? value.address ?? value.url ?? '', 160)
      .replace(/[|\r\n]+/g, ' ')
      .trim();
    return { lat, lng, label };
  }
  return null;
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^00+/, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : '';
}

function connectionPublic(row, req) {
  if (!row) return null;
  const webhookToken = decrypt(row.webhook_token_enc || '') || '';
  const metadata = safeJson(row.metadata_json, {});
  const sandbox = metadata.sandbox && typeof metadata.sandbox === 'object' ? metadata.sandbox : null;
  const webhookUrl = webhookToken ? webhookUrlFor(req, webhookToken) : '';
  return {
    id: Number(row.id),
    profileId: /^sk_/i.test(row.profile_id || '') ? '' : (row.profile_id || ''),
    zernioAccountId: row.zernio_account_id || '',
    wabaId: row.waba_id || '',
    phoneNumberId: row.phone_number_id || '',
    phoneNumber: row.phone_number || '',
    displayName: row.display_name || '',
    mode: row.mode || 'business_app',
    isSandbox: row.mode === 'sandbox',
    status: row.status || 'pending',
    enabled: Boolean(Number(row.enabled)),
    hasApiKey: Boolean(row.api_key_enc),
    hasMetaAccessToken: Boolean(row.meta_access_token_enc),
    lastError: row.last_error || '',
    lastHealthCheck: row.last_health_check || null,
    sandbox: sandbox ? {
      number: sandbox.number || '',
      accountId: sandbox.accountId || '',
      sessionId: sandbox.sessionId || '',
      phone: sandbox.phone || '',
      status: sandbox.status || 'pending',
      expiresAt: sandbox.expiresAt || null,
      activatedAt: sandbox.activatedAt || null,
      templateName: sandbox.templateName || 'sandbox_start',
      templateLanguage: sandbox.templateLanguage || 'en',
    } : null,
    webhookUrl: req.user?.role === 'owner' ? webhookUrl : '',
    webhookPublic: isPublicWebhookUrl(webhookUrl),
    webhookRegistered: Boolean(metadata.zernioWebhookId),
    webhookError: metadata.webhookError || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function zernioRequest({ apiKey, path, method = 'GET', body, retries = 0 }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await zernioRequestOnce({ apiKey, path, method, body });
    } catch (error) {
      const transient = error.providerStatus === 429 || error.providerStatus === 502 || error.providerStatus === 503;
      if (!transient || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}

async function zernioRequestOnce({ apiKey, path, method = 'GET', body }) {
  const token = String(apiKey || '').trim();
  if (!token) throw Object.assign(new Error('Falta la API key de Zernio'), { status: 400, code: 'ZERNIO_API_KEY_REQUIRED' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${ZERNIO_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || data?.error || `Zernio respondió ${response.status}`;
      throw Object.assign(new Error(clean(detail, 300)), { status: response.status >= 500 ? 502 : 400, providerStatus: response.status, providerData: data });
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('Zernio no respondió a tiempo'), { status: 504, code: 'ZERNIO_TIMEOUT' });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverZernioConnection(apiKey, mode) {
  if (mode === 'sandbox') {
    const data = await zernioRequest({ apiKey, path: '/v1/phone-numbers' });
    const sandbox = (data?.data || data)?.sandbox;
    if (!sandbox?.accountId) throw Object.assign(new Error('Zernio no tiene sandbox disponible para esta cuenta'), { status: 404 });
    return { choices: [], sandbox };
  }
  const results = await Promise.allSettled([
    zernioRequest({ apiKey, path: '/v1/phone-numbers' }),
    zernioRequest({ apiKey, path: '/v1/accounts?platform=whatsapp' }),
    zernioRequest({ apiKey, path: '/v1/profiles' }),
  ]);
  const authFailure = results.find((result) => result.status === 'rejected' && result.reason?.providerStatus === 401);
  if (authFailure) throw authFailure.reason;
  if (results.every((result) => result.status === 'rejected')) throw results[0].reason;
  const data = results.map((result) => result.status === 'fulfilled' ? result.value : {});
  const choices = connectionChoices(...data);
  if (!choices.length) throw Object.assign(new Error('No encontramos un número ni un perfil disponible. Configúralo primero en Zernio y vuelve a consultar.'), { status: 409 });
  return { choices };
}

async function ensureZernioWebhook({ req, t, connection }) {
  const apiKey = decrypt(connection.api_key_enc || '') || '';
  const webhookToken = decrypt(connection.webhook_token_enc || '') || '';
  const url = webhookToken ? webhookUrlFor(req, webhookToken) : '';
  if (!apiKey || !url) return { registered: false, reason: 'Faltan credenciales o token de webhook' };
  if (!isPublicWebhookUrl(url)) {
    return {
      registered: false,
      reason: 'La URL de webhook no es pública HTTPS. Configura WHATSAPP_PUBLIC_URL con un dominio o túnel HTTPS.',
      url,
    };
  }

  const metadata = safeJson(connection.metadata_json, {});
  const secret = decrypt(connection.webhook_secret_enc || '') || crypto.randomBytes(32).toString('hex');
  const settings = await zernioRequest({ apiKey, path: '/v1/webhooks/settings' });
  const payload = settings?.data && typeof settings.data === 'object' ? settings.data : settings;
  const webhooks = Array.isArray(payload?.webhooks) ? payload.webhooks : [];
  const existing = webhooks.find((hook) =>
    String(hook?._id || hook?.id || '') === String(metadata.zernioWebhookId || '') ||
    String(hook?.url || '') === url
  );
  const webhookId = existing?._id || existing?.id || '';
  const body = {
    ...(webhookId ? { webhookId } : {}),
    name: `ChatBotPro WhatsApp ${req.tenant.slug}`.slice(0, 80),
    url,
    events: WEBHOOK_EVENTS,
    secret,
    isActive: true,
    // La cuenta compartida del sandbox no pertenece al equipo de Zernio y
    // rechaza el filtro accountIds; en producción sí aislamos por cuenta.
    ...(connection.zernio_account_id && connection.mode !== 'sandbox' ? { accountIds: [connection.zernio_account_id] } : {}),
    ...(connection.profile_id && connection.mode !== 'sandbox' ? { profileIds: [connection.profile_id] } : {}),
  };
  const result = await zernioRequest({
    apiKey,
    path: '/v1/webhooks/settings',
    method: webhookId ? 'PUT' : 'POST',
    body,
  });
  const webhook = result?.webhook || result?.data?.webhook || result?.data || {};
  const nextMetadata = {
    ...metadata,
    zernioWebhookId: String(webhook?._id || webhook?.id || webhookId || ''),
    webhookUrl: url,
    webhookRegisteredAt: new Date().toISOString(),
    webhookError: '',
  };
  const updated = await t.get(
    `UPDATE {s}.whatsapp_connections
     SET webhook_secret_enc=$1,metadata_json=$2,
         last_error=CASE WHEN last_error=$4 THEN '' ELSE last_error END,updated_at=now()
     WHERE id=$3 RETURNING *`,
    [encrypt(secret), JSON.stringify(nextMetadata), connection.id, metadata.webhookError || '']
  );
  return { registered: true, connection: updated || connection, webhook };
}

async function connectionWithSecret(t, id) {
  const row = await t.get('SELECT * FROM {s}.whatsapp_connections WHERE id = $1 LIMIT 1', [id]);
  if (!row) throw Object.assign(new Error('Conexión de WhatsApp no encontrada'), { status: 404 });
  return row;
}

// Zernio can echo our own API messages back as message.sent. Whichever copy
// arrives first is kept so the inbox never shows the same reply twice.
async function recordOutbound(t, conversation, { messageId, type, body, source, payload }) {
  const echo = await t.get(
    `SELECT id FROM {s}.whatsapp_messages
     WHERE conversation_id=$1 AND direction='outbound' AND body=$2 AND external_message_id<>$3
       AND source IN ('', 'cellular') AND created_at > now() - interval '2 minutes'
     ORDER BY id DESC LIMIT 1`,
    [conversation.id, body, messageId]
  );
  if (echo) {
    await t.run('UPDATE {s}.whatsapp_messages SET source=$1, message_type=$2, payload_json=$3 WHERE id=$4', [source, type, payload, echo.id]);
  } else {
    await t.run(
      `INSERT INTO {s}.whatsapp_messages
        (conversation_id, external_message_id, direction, message_type, body, source, status, payload_json)
       VALUES ($1,$2,'outbound',$3,$4,$5,'sent',$6)
       ON CONFLICT (external_message_id) DO UPDATE SET source=EXCLUDED.source, message_type=EXCLUDED.message_type, payload_json=EXCLUDED.payload_json
       WHERE {s}.whatsapp_messages.source IN ('', 'cellular')`,
      [conversation.id, messageId, type, body, source, payload]
    );
  }
  await t.run('UPDATE {s}.whatsapp_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [conversation.id]);
}

async function sendText(t, connection, conversation, text, source = 'bot') {
  const body = clean(text, 10000);
  if (!body) return null;
  const data = await zernioRequest({
    apiKey: decrypt(connection.api_key_enc),
    path: `/v1/inbox/conversations/${encodeURIComponent(conversation.external_id)}/messages`,
    method: 'POST',
    body: { accountId: connection.zernio_account_id, message: body },
    retries: 2,
  });
  const messageId = clean(firstValue(data, ['data.messageId', 'messageId', 'data.id', 'id']) || `out_${sha256(`${Date.now()}_${body}`)}`, 180);
  await recordOutbound(t, conversation, { messageId, type: 'text', body, source, payload: safePayload(data) });
  return { messageId, data };
}

function whatsappDisplayText(value, max = 1000) {
  return String(value ?? '')
    .replace(/[\*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function whatsappPromptText(value) {
  const text = String(value || '').trim();
  if (/^Elige una opción para continuar:?$/i.test(text)) return '*Selecciona una opción:*';
  if (/^Selecciona una opción para continuar:?$/i.test(text)) return '*Selecciona una opción:*';
  if (/^Elige un producto para continuar:?$/i.test(text)) return '*Selecciona un producto:*';
  if (/^Selecciona un producto para continuar:?$/i.test(text)) return '*Selecciona un producto:*';
  return value;
}

// WhatsApp reply buttons have a much smaller title limit than the web
// assistant. Prefer a complete, clear label over cutting the last character
// of a sentence such as "gracias" or "productos".
function whatsappButtonTitle(value) {
  const raw = whatsappDisplayText(value, 120);
  const compact = raw
    .replace(/^➕\s*Agregar más productos\.?$/i, '➕ Agregar otro')
    .replace(/^➡️\s*Siguiente ofrecimiento\.?$/i, '➡️ Siguiente')
    .replace(/^✅\s*Sería todo, gracias\.?$/i, '✅ Finalizar pedido')
    .replace(/^✏️\s*Editar productos\.?$/i, '✏️ Editar pedido')
    .replace(/^❌\s*No, regresar\.?$/i, '↩️ Regresar')
    .replace(/^✅\s*Sí, confirmar\.?$/i, '✅ Confirmar')
    .replace(/^✅\s*Sí, agregar nota\.?$/i, '✅ Agregar nota')
    .replace(/^❌\s*No, continuar\.?$/i, '↩️ Continuar')
    .replace(/^📍\s*(?:Compartir|Comparte tu) ubicación\.?$/i, '📍 Ubicación')
    .replace(/^⏭️\s*Omitir referencia\.?$/i, '⏭️ Omitir referencia')
    .replace(/^Omitir\.?$/i, 'Omitir')
    .replace(/^Capturar nueva dirección de entrega$/i, 'Nueva dirección')
    .replace(/^👤\s*Soy cliente nuevo$/i, '👤 Cliente nuevo')
    .replace(/^🔁\s*Ya he pedido$/i, '🔁 Ya he pedido')
    .replace(/^🏪\s*Recoger en sucursal$/i, '🏪 Recoger')
    .replace(/^🍽️\s*Comer en sucursal$/i, '🍽️ Comer aquí')
    .replace(/^💵\s*Sí, ocupo vuelto.*$/i, '💵 Necesito cambio')
    .replace(/^✅\s*Pagaré exacto.*$/i, '✅ Pago exacto');
  const short = compact
    .replace(/^⏭️\s*Omitir referencia$/i, 'Omitir ref.')
    .replace(/^📍\s*Ubicación$/i, 'Ubicación')
    .replace(/^✅\s*Finalizar pedido$/i, 'Finalizar')
    .replace(/^↩️\s*Continuar$/i, 'Continuar')
    .replace(/^↩️\s*Regresar$/i, 'Regresar');
  return whatsappDisplayText(`👉 ${short}`, 20);
}

function whatsappTransportId(value) {
  // Los comandos del motor llevan guiones bajos (order_note_no); no se deben
  // limpiar como texto visible o llegarían alterados al tocar el botón.
  const canonical = String(value ?? '').replace(/[*`~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!canonical) return '';
  // Zernio/WhatsApp may normalize punctuation from list-row IDs. Encode
  // command values containing separators so the callback remains lossless.
  if (/^[a-z0-9]+$/i.test(canonical)) return canonical;
  return `cb${Buffer.from(canonical, 'utf8').toString('hex')}`;
}

function whatsappEngineInput(value) {
  const raw = clean(value, 200);
  if (!raw) return '';
  const encoded = raw.match(/^cb([0-9a-f]+)$/i);
  if (encoded && encoded[1].length % 2 === 0) {
    try {
      const decoded = Buffer.from(encoded[1], 'hex').toString('utf8');
      if (decoded) return decoded;
    } catch {}
  }

  // Backward compatibility for list messages already sent before the
  // lossless encoding was introduced (e.g. cat4 -> cat_4).
  const legacy = raw.match(/^(cat|prod|variant|branch|modifier)(\d+)$/i);
  if (legacy) return `${legacy[1].toLowerCase()}_${legacy[2]}`;

  // Zernio can compact underscores from older WhatsApp button payloads
  // (share_location -> sharelocation). Restore the canonical commands so an
  // old button still advances the same engine state instead of repeating the
  // menu prompt.
  const compactAliases = {
    sharelocation: 'share_location',
    skiplocation: 'skip_location',
    skipreference: 'skip_reference',
    checkoutnewcustomer: 'checkout_new_customer',
    receivingmodedomicilio: 'receiving_mode_domicilio',
    receivingmodepickup: 'receiving_mode_pickup',
    receivingmodedinein: 'receiving_mode_dinein',
    cashchangeneeded: 'cash_change_needed',
    cashexact: 'cash_exact',
    ordernoteskip: 'order_note_skip',
    upsellcontinue: 'upsell_continue',
    upsellnext: 'upsell_next',
  };
  if (compactAliases[raw.toLowerCase()]) return compactAliases[raw.toLowerCase()];
  return raw;
}

function whatsappInteractiveRows(reply) {
  const rows = [];
  const seen = new Set();
  const add = (id, title, description = '') => {
    const normalizedId = whatsappTransportId(id);
    const normalizedTitle = whatsappDisplayText(title, 24);
    if (!normalizedId || !normalizedTitle || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    rows.push({
      id: normalizedId,
      title: normalizedTitle,
      ...(description ? { description: whatsappDisplayText(description, 72) } : {}),
    });
  };

  for (const product of (Array.isArray(reply.products) ? reply.products : [])) {
    const variants = Array.isArray(product.variants) ? product.variants.filter((variant) => variant?.name) : [];
    const variantHint = variants.length > 1
      ? `${variants.length} variantes · desde ${whatsappDisplayText(product.priceLabel || '', 48)}`
      : '';
    add(`prod_${product.id}`, product.name, variantHint || product.priceLabel || product.description || '');
  }
  for (const option of (Array.isArray(reply.options) ? reply.options : [])) {
    add(option.value, option.label);
  }
  return rows;
}

function whatsappProductRows(reply) {
  const rows = [];
  const seen = new Set();
  for (const product of (Array.isArray(reply.products) ? reply.products : [])) {
    const variants = Array.isArray(product.variants) ? product.variants.filter((variant) => variant?.name) : [];
    const variantHint = variants.length > 1
      ? `${variants.length} variantes · desde ${whatsappDisplayText(product.priceLabel || '', 48)}`
      : '';
    const id = whatsappTransportId(`prod_${product.id}`);
    const title = whatsappDisplayText(product.name, 24);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const qty = Number(product.qty) || 0;
    const baseHint = variantHint || product.priceLabel || product.description;
    const description = qty > 0 ? `${baseHint ? `${baseHint} · ` : ''}✔ Llevas ${qty}` : baseHint;
    rows.push({
      id,
      title,
      ...(description ? { description: whatsappDisplayText(description, 72) } : {}),
    });
  }
  return rows;
}

function whatsappUpsellRows(reply) {
  const rows = [];
  const seen = new Set();
  for (const option of (Array.isArray(reply.options) ? reply.options : [])) {
    if (!String(option?.value || '').toLowerCase().startsWith('upsell_add|')) continue;
    const id = whatsappTransportId(option.value);
    const raw = whatsappDisplayText(option.label, 120);
    const match = raw.match(/^➕\s*(.*?)\s*\(([^()]*)\)$/);
    const name = match?.[1] || raw.replace(/^➕\s*/i, '');
    const price = match?.[2] || '';
    const title = whatsappDisplayText(name, 24);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      title,
      ...(price ? { description: whatsappDisplayText(`${price} · Agregar al pedido`, 72) } : {}),
    });
  }
  return rows;
}

// Títulos que dejan claro qué hace cada botón de WhatsApp (máx. 20 caracteres).
const WHATSAPP_BUTTON_TITLES = {
  order_note_yes: '✏️ Agregar nota',
  order_note_no: 'Sin nota',
  order_note_skip: 'Sin nota',
};

// Opciones largas (categorías, sucursales) van en una lista nativa en vez de
// varios botones de 3 con nombres cortados.
const WHATSAPP_CHOICE_GROUPS = [
  {
    key: 'categories',
    test: /^(cat_\d+|promo_cat_(\d+|all))$/,
    button: 'Ver categorías',
    moreButton: 'Más categorías',
    moreBody: '*Más categorías:*',
    hint: 'Toca *Ver categorías* y elige una. Dentro de cada categoría puedes agregar varios productos.',
  },
  {
    key: 'branches',
    test: /^branch_\d+$/,
    button: 'Ver sucursales',
    moreButton: 'Más sucursales',
    moreBody: '*Más sucursales:*',
    hint: 'Toca *Ver sucursales* y elige una.',
  },
];

function whatsappChoiceGroup(reply) {
  for (const group of WHATSAPP_CHOICE_GROUPS) {
    const rows = [];
    const seen = new Set();
    const values = new Set();
    let longLabel = false;
    for (const option of (Array.isArray(reply.options) ? reply.options : [])) {
      const value = String(option?.value || '').toLowerCase();
      if (!group.test.test(value)) continue;
      const id = whatsappTransportId(option.value);
      const label = whatsappDisplayText(String(option.label || '').replace(/^🏪\s*/, ''), 72);
      const title = whatsappDisplayText(label, 24);
      if (!id || !title || seen.has(id)) continue;
      seen.add(id);
      values.add(value);
      if (label.length > 16) longLabel = true;
      rows.push({ id, title, ...(label.length > title.length ? { description: label } : {}) });
    }
    if (rows.length > 3 || (rows.length > 1 && longLabel)) return { ...group, rows, values };
  }
  return null;
}

function whatsappOptionRows(reply, skipValues = new Set()) {
  const rows = [];
  const seen = new Set();
  for (const option of (Array.isArray(reply.options) ? reply.options : [])) {
    if (String(option?.value || '').toLowerCase() === 'share_location') continue;
    if (String(option?.value || '').toLowerCase().startsWith('upsell_add|')) continue;
    if (skipValues.has(String(option?.value || '').toLowerCase())) continue;
    const id = whatsappTransportId(option.value);
    const forced = WHATSAPP_BUTTON_TITLES[String(option.value || '').toLowerCase()];
    const title = forced ? whatsappDisplayText(`👉 ${forced}`, 20) : whatsappButtonTitle(option.label);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, title });
  }
  return rows;
}

function whatsappBankAccountsText(accounts, title = 'Datos para transferencia') {
  const list = Array.isArray(accounts) ? accounts : [];
  if (!list.length) return '';
  const sections = list.map((account, index) => {
    const heading = list.length > 1 ? `🏦 *Cuenta ${index + 1}*` : '🏦 *Datos de la cuenta*';
    const fields = (Array.isArray(account?.fields) ? account.fields : [])
      .filter((field) => field?.label && field?.value)
      .map((field) => `*${String(field.label).trim()}:* \`${String(field.value).trim()}\``)
      .join('\n');
    return [heading, fields].filter(Boolean).join('\n');
  }).filter(Boolean);
  if (!sections.length) return '';
  return [
    `💳 *${String(title || 'Datos para transferencia').trim()}*`,
    'Mantén presionado cada dato para copiarlo y pegarlo en tu transferencia:',
    ...sections,
    'Conserva tu comprobante de pago.',
  ].join('\n\n');
}

const WHATSAPP_LIST_ROWS = 10;
const WHATSAPP_PRODUCT_PAGE_ROWS = 8;
const WHATSAPP_GENERIC_BODY = '*Selecciona una opción:*';

function whatsappProductListMessage(reply, productRows) {
  const category = whatsappDisplayText(reply.categoryName, 60);
  const intro = category ? `*${category}*` : '*Productos*';
  const hint = 'Toca *Ver productos* y elige uno: se agrega a tu pedido. Puedes pedir *varios productos* de esta categoría; después de cada uno toca *Agregar otro* para volver aquí.';
  let rows = productRows;
  let range = '';
  let page = 1;
  if (productRows.length > WHATSAPP_LIST_ROWS) {
    const pages = Math.ceil(productRows.length / WHATSAPP_PRODUCT_PAGE_ROWS);
    page = Math.min(Math.max(1, Number(reply.productPage) || 1), pages);
    const start = (page - 1) * WHATSAPP_PRODUCT_PAGE_ROWS;
    rows = productRows.slice(start, start + WHATSAPP_PRODUCT_PAGE_ROWS);
    range = `\nMostrando ${start + 1}-${start + rows.length} de ${productRows.length}.${page < pages ? ' Usa *Ver más productos* para seguir viendo.' : ''}`;
    if (page > 1) rows = [{ id: whatsappTransportId(`prods_page_${page - 1}`), title: '◀ Anteriores', description: 'Volver a los productos anteriores' }, ...rows];
    if (page < pages) rows = [...rows, { id: whatsappTransportId(`prods_page_${page + 1}`), title: 'Ver más productos ▶', description: `Faltan ${productRows.length - (start + WHATSAPP_PRODUCT_PAGE_ROWS)} productos por ver` }];
  }
  const bodyText = `${intro}\n${hint}${range}`.slice(0, 1000);
  return {
    kind: 'list',
    bodyText,
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: 'Ver productos', sections: [{ rows }] },
    },
  };
}

function whatsappInteractiveMessages(reply, { leadText = '' } = {}) {
  const messages = [];
  const productRows = whatsappProductRows(reply);
  const upsellRows = whatsappUpsellRows(reply);
  const choiceGroup = !productRows.length && !upsellRows.length ? whatsappChoiceGroup(reply) : null;
  const optionRows = whatsappOptionRows(reply, choiceGroup ? choiceGroup.values : new Set());
  // El texto de la pregunta viaja dentro del primer mensaje interactivo para
  // que el cliente vea una sola burbuja clara en lugar de texto + "Selecciona".
  let lead = String(leadText || '').trim();
  const takeBody = () => {
    const body = lead || WHATSAPP_GENERIC_BODY;
    lead = '';
    return body;
  };

  if ((reply.options || []).some((option) => String(option?.value || '').toLowerCase() === 'share_location')) {
    messages.push({
      kind: 'location-request',
      bodyText: '📍 *Comparte tu ubicación*',
      interactive: { type: 'locationrequestmessage' },
    });
  }

  const addButtonMessages = (rows, firstBody) => {
    for (let index = 0; index < rows.length; index += 3) {
      const chunk = rows.slice(index, index + 3);
      messages.push({
        kind: 'buttons',
        bodyText: index === 0 ? firstBody() : WHATSAPP_GENERIC_BODY,
        buttons: chunk.map((row) => ({ type: 'postback', title: row.title, payload: row.id })),
      });
    }
  };

  if (upsellRows.length) {
    for (let index = 0; index < upsellRows.length; index += WHATSAPP_LIST_ROWS) {
      const chunk = upsellRows.slice(index, index + WHATSAPP_LIST_ROWS);
      const bodyText = index === 0 ? takeBody() : '*Más complementos:*';
      messages.push({
        kind: 'list',
        bodyText,
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: { button: 'Ver complementos', sections: [{ rows: chunk }] },
        },
      });
    }
  } else if (productRows.length) {
    lead = '';
    // Hasta tres productos caben como botones; el resto va en UNA lista
    // nativa. Los catálogos largos se paginan desde el motor (prods_page_N)
    // para no enviar varias listas iguales.
    if (productRows.length <= 3 && !reply.categoryName) {
      addButtonMessages(productRows, () => '*Selecciona un producto:*');
    } else {
      messages.push(whatsappProductListMessage(reply, productRows));
    }
  } else if (choiceGroup) {
    for (let index = 0; index < choiceGroup.rows.length; index += WHATSAPP_LIST_ROWS) {
      const chunk = choiceGroup.rows.slice(index, index + WHATSAPP_LIST_ROWS);
      const bodyText = index === 0
        ? `${takeBody()}\n${choiceGroup.hint}`.slice(0, 1000)
        : choiceGroup.moreBody;
      messages.push({
        kind: 'list',
        bodyText,
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: { button: index === 0 ? choiceGroup.button : choiceGroup.moreButton, sections: [{ rows: chunk }] },
        },
      });
    }
  }

  // Las acciones de salida/confirmación quedan fuera de las listas para que
  // el cliente siempre vea cómo continuar o regresar.
  if (optionRows.length) {
    addButtonMessages(optionRows, takeBody);
  }
  return messages;
}

async function sendInteractive(t, connection, conversation, message, source = 'bot') {
  const body = {
    accountId: connection.zernio_account_id,
    ...(message.kind === 'buttons'
      ? { message: message.bodyText, buttons: message.buttons }
      : message.kind === 'location-request'
        ? { message: message.bodyText, interactive: message.interactive }
      : { interactive: message.interactive }),
  };
  const data = await zernioRequest({
    apiKey: decrypt(connection.api_key_enc),
    path: `/v1/inbox/conversations/${encodeURIComponent(conversation.external_id)}/messages`,
    method: 'POST',
    body,
    retries: 2,
  });
  const messageId = clean(firstValue(data, ['data.messageId', 'messageId', 'data.id', 'id']) || `out_${sha256(`${Date.now()}_${JSON.stringify(body)}`)}`, 180);
  await recordOutbound(t, conversation, {
    messageId, type: 'interactive', body: message.bodyText, source,
    payload: safePayload({ request: body, response: data }),
  });
  return { messageId, data };
}

function whatsappProductIdFromInput(value) {
  const input = String(value || '').trim().toLowerCase();
  const direct = input.match(/^prod_(\d+)$/);
  if (direct) return Number(direct[1]);
  const upsell = input.match(/^upsell_add\|[^|]+\|(\d+)$/);
  return upsell ? Number(upsell[1]) : 0;
}

function whatsappMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
    if (!config.WHATSAPP_PUBLIC_URL) return '';
    return new URL(raw.startsWith('/') ? raw : `/${raw}`, `${config.WHATSAPP_PUBLIC_URL}/`).toString();
  } catch {
    return '';
  }
}

async function sendProductImage(t, connection, conversation, productId) {
  if (!Number.isInteger(Number(productId)) || Number(productId) <= 0) return null;
  const product = await t.get('SELECT id, name, description, price::float AS price, image FROM {s}.products WHERE id=$1 AND active=1 LIMIT 1', [Number(productId)]);
  const imageUrl = whatsappMediaUrl(product?.image);
  if (!product || !imageUrl) return null;

  const caption = [
    whatsappDisplayText(product.name, 180),
    product.price !== null && product.price !== undefined ? `Precio: ${Number(product.price).toFixed(2)}` : '',
    whatsappDisplayText(product.description, 300),
  ].filter(Boolean).join('\n');
  const body = {
    accountId: connection.zernio_account_id,
    message: caption,
    attachmentUrl: imageUrl,
    attachmentType: 'image',
  };
  try {
    const data = await zernioRequest({
      apiKey: decrypt(connection.api_key_enc),
      path: `/v1/inbox/conversations/${encodeURIComponent(conversation.external_id)}/messages`,
      method: 'POST',
      body,
    });
    const messageId = clean(firstValue(data, ['data.messageId', 'messageId', 'data.id', 'id']) || `out_${sha256(`${Date.now()}_${imageUrl}`)}`, 180);
    await recordOutbound(t, conversation, {
      messageId, type: 'image', body: caption, source: 'bot',
      payload: safePayload({ request: body, response: data }),
    });
    return { messageId, data };
  } catch (error) {
    // An unavailable image must never interrupt the tenant's order flow.
    console.warn('[whatsapp][product-image]', productId, error.message);
    return null;
  }
}

const BOT_MESSAGE_GAP_MS = Number.isFinite(Number(process.env.WHATSAPP_BOT_MESSAGE_GAP_MS))
  ? Math.max(0, Number(process.env.WHATSAPP_BOT_MESSAGE_GAP_MS)) : 350;
const pause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// La última pregunta del bot viaja como cuerpo del primer botón/lista: una
// sola burbuja clara en lugar de texto + "Selecciona una opción".
function whatsappReplyPlan(reply, { hasBankCard = false } = {}) {
  const texts = [...(reply.messages || [])];
  let leadText = '';
  const probe = whatsappInteractiveMessages(reply);
  if (probe.length && ['buttons', 'list'].includes(probe[0].kind) && texts.length) {
    const last = String(texts[texts.length - 1] || '');
    const candidate = whatsappPromptText(last);
    const isBankIntro = hasBankCard && /^Datos para realizar tu pago con /i.test(last.trim());
    if (!isBankIntro && !reply.bankAccounts?.length && candidate && candidate.length <= 900) {
      leadText = candidate;
      texts.pop();
    }
  }
  return { texts, interactives: whatsappInteractiveMessages(reply, { leadText }) };
}

async function sendBotReply(t, connection, conversation, reply, onSent = () => {}) {
  const bankText = whatsappBankAccountsText(reply.bankAccounts, reply.bankAccountTitle);
  const hasBankCard = Boolean(bankText);
  let sentCount = 0;
  // A short pause keeps WhatsApp delivery order stable and reads like a person typing.
  const deliver = async (label, send) => {
    if (sentCount > 0) await pause(BOT_MESSAGE_GAP_MS);
    try {
      await send();
      sentCount += 1;
      onSent();
    } catch (error) {
      console.warn(`[whatsapp][${label}]`, error.message);
    }
  };
  const { texts, interactives } = whatsappReplyPlan(reply, { hasBankCard });
  for (const message of texts) {
    // The web assistant renders bankAccounts as a visual card. WhatsApp gets
    // one copy-friendly text card instead of receiving the fallback twice.
    if (hasBankCard && /^Datos para realizar tu pago con /i.test(String(message || '').trim())) continue;
    await deliver('send-text', () => sendText(t, connection, conversation, whatsappPromptText(message), 'bot'));
  }
  if (bankText) await deliver('send-bank-details', () => sendText(t, connection, conversation, bankText, 'bot'));
  for (const interactive of interactives) {
    await deliver('send-interactive', () => sendInteractive(t, connection, conversation, interactive, 'bot'));
  }
  return sentCount;
}

// Messages from the same chat are handled strictly one at a time; otherwise two
// quick taps read the same session state and the replies arrive out of order.
const conversationQueues = new Map();
function enqueueConversation(key, task) {
  const next = (conversationQueues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  conversationQueues.set(key, next);
  next.catch(() => {}).finally(() => { if (conversationQueues.get(key) === next) conversationQueues.delete(key); });
  return next;
}

const MEDIA_ACK = 'Recibí tu archivo 📎 y el equipo del negocio lo revisará. Para continuar con tu pedido elige una opción del último menú o escribe *hola* para empezar de nuevo.';
const BOT_ERROR_REPLY = 'Tuve un problema para procesar tu mensaje 🙏. Escribe *hola* para retomar tu pedido desde el inicio.';

// Zernio expects a webhook response within five seconds. Persisting the event
// and the inbound message happens in the request; the potentially slow AI and
// outbound WhatsApp calls continue after the 2xx response.
function processWhatsAppBotReply(args) {
  const { connection, externalConversationId } = args;
  return enqueueConversation(`${connection.id}:${externalConversationId}`, () => runWhatsAppBotReply(args));
}

async function runWhatsAppBotReply({ t, tenantSlug, connection, conversation, parsed, externalConversationId }) {
  const notify = () => emitWhatsAppUpdate(tenantSlug, { conversationId: Number(conversation.id), event: 'message' });
  try {
    // A person may have taken the chat while this message was waiting its turn.
    const live = await t.get('SELECT bot_enabled FROM {s}.whatsapp_conversations WHERE id=$1', [conversation.id]);
    if (live && Number(live.bot_enabled) !== 1) return;
    if (!parsed.text) {
      await sendBotReply(t, connection, conversation, { messages: [MEDIA_ACK] }, notify);
      return;
    }
    const sessionId = `wa_${connection.id}_${sha256(externalConversationId).slice(0, 42)}`;
    let reply;
    try {
      reply = await handleMessage(t, tenantSlug, sessionId, parsed.text, {
        orderChannel: 'chatbot',
        sourceChannel: 'whatsapp',
        customerPhone: parsed.participant,
        customerName: parsed.senderName,
      });
    } catch (error) {
      console.error('[whatsapp][engine]', tenantSlug, error.message);
      await sendBotReply(t, connection, conversation, { messages: [BOT_ERROR_REPLY] }, notify).catch(() => {});
      return;
    }
    const selectedProductId = whatsappProductIdFromInput(parsed.text);
    if (selectedProductId) {
      const image = await sendProductImage(t, connection, conversation, selectedProductId);
      if (image) notify();
    }
    await sendBotReply(t, connection, conversation, reply, notify);
    if (reply.order?.id) {
      await t.run(
        `UPDATE {s}.orders
         SET source_channel='whatsapp', whatsapp_conversation_id=$1, whatsapp_external_id=$2
         WHERE id=$3`,
        [conversation.id, externalConversationId, reply.order.id]
      );
    }
  } catch (error) {
    // A transient provider limit or one failed outbound message must not make
    // an otherwise connected channel appear disconnected in the UI.
    await t.run(
      `UPDATE {s}.whatsapp_connections
       SET last_error=$1,
           status=CASE WHEN status IN ('active','connected') THEN status ELSE 'error' END,
           updated_at=now()
       WHERE id=$2`,
      [clean(error.message, 500), connection.id]
    ).catch(() => {});
    console.error('[whatsapp][bot]', tenantSlug, error.message);
  }
}

const MEDIA_LABELS = {
  image: '📷 Imagen', photo: '📷 Imagen', video: '🎥 Video', audio: '🎤 Audio', voice: '🎤 Nota de voz',
  ptt: '🎤 Nota de voz', document: '📄 Documento', file: '📄 Documento', sticker: '🙂 Sticker',
  contacts: '👤 Contacto', contact: '👤 Contacto',
};

// Attachments arrive in several provider shapes; only the kind and a label are
// needed so the inbox shows the same placeholder WhatsApp would.
function whatsappMedia(payload) {
  const list = ['message.attachments', 'data.message.attachments', 'attachments', 'data.attachments']
    .map((path) => getPath(payload, path)).find((value) => Array.isArray(value) && value.length);
  const first = list?.[0] && typeof list[0] === 'object' ? list[0] : null;
  const declared = clean(first?.type || first?.mediaType || firstValue(payload, [
    'message.type', 'message.messageType', 'data.message.type', 'data.message.messageType', 'messageType', 'data.messageType',
  ]), 40).toLowerCase();
  const mime = clean(first?.mimeType || first?.mime_type || first?.contentType || '', 80).toLowerCase();
  const kind = MEDIA_LABELS[declared] ? declared : (MEDIA_LABELS[mime.split('/')[0]] ? mime.split('/')[0] : (first ? 'document' : ''));
  if (!kind) return null;
  return { kind, label: MEDIA_LABELS[kind], url: clean(first?.url || first?.link || '', 1000) };
}

// Prefer the provider's own send time so rapid or retried webhooks keep the
// conversation order WhatsApp shows; fall back to arrival time when unusable.
function providerTimestamp(payload) {
  const raw = firstValue(payload, [
    'message.timestamp', 'message.createdAt', 'message.sentAt', 'message.created_at',
    'data.message.timestamp', 'data.message.createdAt', 'data.message.sentAt', 'data.message.created_at',
    'data.timestamp', 'data.createdAt', 'timestamp', 'createdAt', 'created_at',
  ]);
  if (raw === '') return null;
  let ms = NaN;
  if (typeof raw === 'number' || /^\d{9,13}$/.test(String(raw).trim())) {
    const n = Number(raw);
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    ms = Date.parse(String(raw));
  }
  const now = Date.now();
  if (!Number.isFinite(ms) || ms > now + 60000 || ms < now - 7 * 24 * 3600 * 1000) return null;
  return new Date(ms).toISOString();
}

function webhookMessage(payload) {
  const eventType = clean(firstValue(payload, ['event', 'type', 'eventType', 'data.event', 'data.type']), 80).toLowerCase();
  const messageId = clean(firstValue(payload, [
    'messageId', 'message.platformMessageId', 'message.id', 'data.messageId', 'data.message.platformMessageId', 'data.message.id', 'data.id', 'id',
  ]), 180);
  const conversationId = clean(firstValue(payload, [
    'conversationId', 'conversation.id', 'data.conversationId', 'data.conversation.id', 'data.threadId',
  ]), 180);
  const participant = normalizePhone(firstValue(payload, [
    'participantId', 'from', 'message.sender.phoneNumber', 'message.sender.phone', 'message.sender.id', 'sender.phoneNumber', 'sender.phone', 'sender.id', 'contact.phone', 'data.participantId',
    'data.from', 'data.message.sender.phoneNumber', 'data.sender.phoneNumber', 'data.sender.phone', 'data.sender.id', 'data.contact.phone',
  ]));
  const recipient = normalizePhone(firstValue(payload, [
    'to', 'message.recipient.phoneNumber', 'message.recipient.phone', 'message.recipient.id', 'recipient.phoneNumber', 'recipient.phone', 'recipient.id', 'data.to', 'data.message.recipient.phoneNumber', 'data.recipient.phoneNumber', 'data.recipient.phone', 'data.recipient.id',
  ]));
  const senderName = clean(firstValue(payload, [
    'message.sender.name', 'sender.name', 'contact.name', 'data.message.sender.name', 'data.sender.name', 'data.contact.name', 'profile.name',
  ]), 160);
  const messageValue = firstValue(payload, [
    'message.text', 'message.body', 'data.message.text', 'data.message.body', 'text', 'body', 'data.text',
  ]);
  const interactiveId = whatsappEngineInput(firstValue(payload, [
    'metadata.interactiveId', 'message.metadata.interactiveId', 'data.metadata.interactiveId', 'data.message.metadata.interactiveId',
    // Zernio has emitted interactive replies in several compatible shapes
    // over time. Accept the provider's native button/list reply fields too;
    // otherwise a visible button such as "Horarios" falls through as free
    // text and the engine repeats its generic fallback.
    'interactiveId', 'interactive_id', 'message.interactiveId', 'message.interactive_id',
    'data.interactiveId', 'data.interactive_id', 'data.message.interactiveId', 'data.message.interactive_id',
    'message.button.payload', 'message.button.id', 'message.button_reply.payload', 'message.button_reply.id',
    'message.buttonReply.payload', 'message.buttonReply.id',
    'message.interactive.button_reply.payload', 'message.interactive.button_reply.id',
    'message.interactive.buttonReply.payload', 'message.interactive.buttonReply.id',
    'message.interactive.list_reply.payload', 'message.interactive.list_reply.id',
    'message.interactive.listReply.payload', 'message.interactive.listReply.id',
    'data.message.button.payload', 'data.message.button.id', 'data.message.button_reply.payload', 'data.message.button_reply.id',
    'data.message.interactive.button_reply.payload', 'data.message.interactive.button_reply.id',
    'data.message.interactive.list_reply.payload', 'data.message.interactive.list_reply.id',
    'button.payload', 'button.id', 'button_reply.payload', 'button_reply.id',
    'interactive.button_reply.payload', 'interactive.button_reply.id', 'interactive.list_reply.payload', 'interactive.list_reply.id',
    'data.interactive.button_reply.payload', 'data.interactive.button_reply.id',
    'data.interactive.list_reply.payload', 'data.interactive.list_reply.id',
  ]), 200);
  const interactiveType = clean(firstValue(payload, [
    'metadata.interactiveType', 'message.metadata.interactiveType', 'data.metadata.interactiveType', 'data.message.metadata.interactiveType',
  ]), 80);
  const interactiveTitle = clean(firstValue(payload, [
    'metadata.interactiveTitle', 'message.metadata.interactiveTitle', 'data.metadata.interactiveTitle', 'data.message.metadata.interactiveTitle',
    'interactiveTitle', 'interactive_title', 'message.interactiveTitle', 'message.interactive_title',
    'message.button.title', 'message.button_reply.title', 'message.buttonReply.title',
    'message.interactive.button_reply.title', 'message.interactive.buttonReply.title',
    'message.interactive.list_reply.title', 'message.interactive.listReply.title',
    'data.message.button.title', 'data.message.button_reply.title',
    'data.message.interactive.button_reply.title', 'data.message.interactive.list_reply.title',
    'button.title', 'button_reply.title', 'interactive.button_reply.title', 'interactive.list_reply.title',
    'data.interactive.button_reply.title', 'data.interactive.list_reply.title',
  ]), 200);
  const media = whatsappMedia(payload);
  const location = whatsappLocation(payload);
  const rawTextValue = typeof messageValue === 'object' ? clean(messageValue?.body || messageValue?.text || '') : clean(messageValue, 10000);
  // Attachment events sometimes carry a generic placeholder ("📷 Image") as text.
  const mediaPlaceholder = /^[^\p{L}\p{N}]*(image|photo|video|audio|voice( note)?|document|file|sticker|imagen|foto|nota de voz|documento|archivo)[^\p{L}\p{N}]*$/iu;
  const textValue = media && mediaPlaceholder.test(rawTextValue) ? '' : rawTextValue;
  // Zernio returns list/button taps in metadata rather than message text. The
  // ID is intentionally passed to the existing chatbot engine because its
  // machine commands are already the canonical option values.
  // Location events similarly carry a human-readable message such as
  // "📍 Location" while the actual coordinates live in metadata.location.
  // Convert them to the engine's canonical geo:<lat>,<lng>|<label> format.
  const locationText = location ? `geo:${location.lat},${location.lng}|${location.label}` : '';
  const text = interactiveId || locationText || textValue || interactiveTitle;
  const source = clean(firstValue(payload, ['source', 'data.source', 'metadata.source']), 80);
  const timestamp = providerTimestamp(payload);
  const incoming = eventType.includes('received') || eventType.includes('inbound') || eventType === 'message.new';
  const outgoing = eventType.includes('sent') || eventType.includes('outbound') || eventType.includes('outgoing');
  return { eventType, messageId, conversationId, participant, recipient, senderName, text, interactiveId, interactiveType, interactiveTitle, location, media, timestamp, source, incoming, outgoing };
}

function whatsappConversationCustomerName(parsed, connection = null) {
  // The sender on message.sent is the business account. It must never replace
  // the contact name in the tenant inbox. Only message.received can establish
  // or refresh the customer identity.
  if (!parsed?.incoming) return '';
  const name = clean(parsed.senderName, 160);
  if (!name) return '';
  const channelName = clean(connection?.display_name, 160).toLowerCase().replace(/\s+/g, ' ');
  return channelName && name.toLowerCase().replace(/\s+/g, ' ') === channelName ? '' : name;
}

// Chats attended by the bot ping at most once per minute; chats a person has
// taken over notify on every message.
const pushMarks = new Map();
const BOT_PUSH_COOLDOWN_MS = 60 * 1000;

function pushInboundMessage({ tenantSlug, conversation, parsed }) {
  const botAttended = Number(conversation.bot_enabled) === 1;
  const key = `${tenantSlug}:${conversation.id}`;
  const now = Date.now();
  if (botAttended && now - (pushMarks.get(key) || 0) < BOT_PUSH_COOLDOWN_MS) return;
  pushMarks.set(key, now);
  if (pushMarks.size > 2000) for (const [mark, at] of pushMarks) if (now - at > BOT_PUSH_COOLDOWN_MS) pushMarks.delete(mark);

  const name = decrypt(conversation.customer_name_enc || '') || decrypt(conversation.customer_phone_enc || '') || 'Cliente WhatsApp';
  const body = parsed.location ? '\ud83d\udccd Ubicaci\u00f3n compartida'
    : parsed.interactiveTitle || (parsed.interactiveId ? 'Eligi\u00f3 una opci\u00f3n' : (parsed.text || parsed.media?.label || 'Nuevo mensaje'));
  sendTenantPush(tenantSlug, {
    title: name,
    body: clean(body, 140),
    slug: tenantSlug,
    event: 'whatsapp_message',
    conversationId: Number(conversation.id),
    url: `/bandeja?c=${Number(conversation.id)}`,
  }, { ttl: 600, urgency: 'high', topic: 'whatsapp' }).catch(() => {});
}

async function handleWebhook(req, res, next) {
  try {
    const rawToken = String(req.params.token || '').trim();
    if (!rawToken || rawToken.length < 32) return res.status(404).json({ error: 'Webhook no encontrado' });
    const tokenRow = await q(
      `SELECT tenant_slug, connection_id
       FROM whatsapp_webhook_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL LIMIT 1`,
      [lookupHash(rawToken)]
    );
    if (!tokenRow.rows[0]) return res.status(404).json({ error: 'Webhook no encontrado' });

    const tenantSlug = tokenRow.rows[0].tenant_slug;
    const t = tdb(tenantSlug);
    const connection = await t.get('SELECT * FROM {s}.whatsapp_connections WHERE id = $1 LIMIT 1', [tokenRow.rows[0].connection_id]);
    if (!connection) return res.status(404).json({ error: 'Conexión no encontrada' });

    const configuredSecret = decrypt(connection.webhook_secret_enc || '');
    const suppliedSecret = configuredSecret && webhookSignatureMatches(req, configuredSecret) ? configuredSecret : '';
    if (configuredSecret && !secretMatches(configuredSecret, suppliedSecret)) return res.status(401).json({ error: 'Firma de webhook inválida' });

    const payload = req.body || {};
    const parsed = webhookMessage(payload);
    const externalEventId = clean(
      String(req.get('x-zernio-event-id') || req.get('x-late-event-id') || '') || firstValue(payload, ['eventId', 'event_id', 'id', 'data.eventId']) || `${parsed.messageId || 'event'}_${sha256(safePayload(payload)).slice(0, 24)}`,
      180
    );
    const inserted = await t.get(
      `INSERT INTO {s}.whatsapp_events(connection_id,external_event_id,event_type,payload_json,processed)
       VALUES($1,$2,$3,$4,0)
       ON CONFLICT(external_event_id) DO NOTHING
       RETURNING id`,
      [connection.id, externalEventId, parsed.eventType, safePayload(payload)]
    );
    if (!inserted) return res.json({ ok: true, duplicate: true });

    const statusMatch = parsed.eventType.match(/^message\.(delivered|read|failed)$/);
    if (statusMatch && parsed.messageId) {
      // Ticks/failed state in the inbox come from provider lifecycle events.
      const changed = await t.get(
        `UPDATE {s}.whatsapp_messages SET status=$1
         WHERE external_message_id=$2 AND direction='outbound'
           AND ($1='failed' OR status NOT IN ('read','failed') AND NOT (status='delivered' AND $1='delivered'))
         RETURNING conversation_id`,
        [statusMatch[1], parsed.messageId]
      );
      if (changed) emitWhatsAppUpdate(tenantSlug, { conversationId: Number(changed.conversation_id), event: 'status' });
    }

    const storedMessageId = parsed.messageId || (parsed.text || parsed.media ? `evt_${externalEventId}` : '');
    const shouldStoreMessage = parsed.incoming
      ? Boolean(parsed.text || parsed.media || parsed.participant || parsed.conversationId)
      : Boolean(parsed.outgoing && parsed.text && (parsed.conversationId || parsed.recipient || parsed.participant));
    if (shouldStoreMessage) {
      const externalConversationId = parsed.conversationId || (parsed.incoming ? parsed.participant : (parsed.recipient || parsed.participant)) || `event_${inserted.id}`;
      // Outbound lifecycle events can identify the business sender/recipient
      // differently depending on the Zernio transport. The contact identity
      // is authoritative only on the inbound message.received event.
      const customerPhone = parsed.incoming ? parsed.participant : '';
      const customerName = whatsappConversationCustomerName(parsed, connection);
      const conversation = await t.get(
        `INSERT INTO {s}.whatsapp_conversations
          (connection_id,external_id,customer_phone_enc,customer_phone_hash,customer_name_enc,status,bot_enabled,last_message_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'open',1,now(),now())
         ON CONFLICT(connection_id,external_id) DO UPDATE SET
           customer_phone_enc=CASE WHEN COALESCE(EXCLUDED.customer_phone_enc, '') = '' THEN {s}.whatsapp_conversations.customer_phone_enc ELSE EXCLUDED.customer_phone_enc END,
           customer_phone_hash=CASE WHEN EXCLUDED.customer_phone_hash='' THEN {s}.whatsapp_conversations.customer_phone_hash ELSE EXCLUDED.customer_phone_hash END,
           customer_name_enc=CASE WHEN COALESCE(EXCLUDED.customer_name_enc, '') = '' THEN {s}.whatsapp_conversations.customer_name_enc ELSE EXCLUDED.customer_name_enc END,
           last_message_at=now(), updated_at=now()
         RETURNING *`,
        [connection.id, externalConversationId, customerPhone ? encrypt(customerPhone) : '', customerPhone ? lookupHash(customerPhone) : '', customerName ? encrypt(customerName) : '']
      );

      let inboundMessageStored = !storedMessageId;
      if (storedMessageId && (parsed.text || parsed.media)) {
        const messageBody = parsed.location
          ? (parsed.location.label || `Ubicación: ${parsed.location.lat}, ${parsed.location.lng}`)
          : (parsed.interactiveTitle || parsed.text || parsed.media?.label || '');
        const messageType = parsed.location ? 'location' : (parsed.interactiveId ? 'interactive' : (!parsed.text && parsed.media ? parsed.media.kind : 'text'));
        const messageSource = parsed.source || (parsed.incoming ? 'whatsapp' : 'cellular');
        const botEcho = !parsed.incoming && await t.get(
          `SELECT id FROM {s}.whatsapp_messages
           WHERE conversation_id=$1 AND direction='outbound' AND body=$2 AND (source='bot' OR source LIKE 'human:%')
             AND created_at > now() - interval '2 minutes' LIMIT 1`,
          [conversation.id, messageBody]
        );
        const messageRow = botEcho ? null : await t.get(
          `INSERT INTO {s}.whatsapp_messages
            (conversation_id,external_message_id,direction,message_type,body,source,status,payload_json,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now()))
           ON CONFLICT(external_message_id) DO NOTHING
           RETURNING id`,
          [conversation.id, storedMessageId, parsed.incoming ? 'inbound' : 'outbound', messageType, messageBody, messageSource, parsed.incoming ? 'received' : 'sent', safePayload(payload), parsed.timestamp]
        );
        inboundMessageStored = Boolean(messageRow);
      }

      if (parsed.incoming && (parsed.text || parsed.media) && inboundMessageStored && Number(conversation.bot_enabled) === 1 && Number(connection.enabled) === 1) {
        setImmediate(() => {
          processWhatsAppBotReply({ t, tenantSlug, connection, conversation, parsed, externalConversationId }).catch((error) => {
            console.error('[whatsapp][bot-queue]', tenantSlug, error.message);
          });
        });
      }
      if (parsed.incoming && (parsed.text || parsed.media) && inboundMessageStored) {
        pushInboundMessage({ tenantSlug, conversation, parsed });
      }
      emitWhatsAppUpdate(tenantSlug, { conversationId: Number(conversation.id), event: 'message' });
    }

    await t.run('UPDATE {s}.whatsapp_events SET processed=1 WHERE id=$1', [inserted.id]);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
}

// Webhook y callback OAuth son públicos; se protegen con token/estado, no con cookie de sesión.
router.post('/webhook/:token', express.json({ limit: '1mb' }), handleWebhook);

router.get('/oauth/callback', async (req, res, next) => {
  try {
    const tenantSlug = clean(req.query.tenant, 80).toLowerCase();
    const connectionId = Number(req.query.connectionId);
    const state = clean(req.query.state, 180);
    const callbackProfileId = clean(req.query.profileId || req.query.profile_id, 120);
    const connected = clean(req.query.connected, 40).toLowerCase();
    if (!tenantSlug || !Number.isInteger(connectionId) || connectionId <= 0) return res.status(400).send('Solicitud de conexión incompleta.');
    const t = tdb(tenantSlug);
    const connection = await t.get('SELECT * FROM {s}.whatsapp_connections WHERE id=$1 LIMIT 1', [connectionId]);
    if (!connection) return res.status(400).send('La conexión ya no existe o pertenece a otro negocio.');
    const metadata = safeJson(connection?.metadata_json, {});
    const nextMetadata = { ...metadata };
    delete nextMetadata.oauthState;
    delete nextMetadata.oauthStartedAt;
    const oauthStartedAt = Date.parse(String(metadata.oauthStartedAt || ''));
    const oauthIsFresh = Number.isFinite(oauthStartedAt)
      && oauthStartedAt <= Date.now()
      && Date.now() - oauthStartedAt <= 30 * 60 * 1000;
    const stateIsValid = Boolean(state && metadata.oauthState && metadata.oauthState === state);
    // Compatibilidad acotada para callbacks iniciados antes de que se incluyera
    // state en redirect_url: exige la misma cuenta, perfil, conexión reciente y
    // respuesta exitosa de WhatsApp. Los nuevos flujos siempre usan state.
    const legacyCallbackIsValid = !state
      && !req.query.error
      && connected === 'whatsapp'
      && Boolean(callbackProfileId && connection.profile_id && callbackProfileId === connection.profile_id)
      && oauthIsFresh;
    if (!stateIsValid && !legacyCallbackIsValid) return res.status(400).send('La sesión de conexión expiró o no es válida.');
    if (callbackProfileId && connection.profile_id && callbackProfileId !== connection.profile_id) {
      return res.status(400).send('El Profile ID recibido no coincide con esta conexión.');
    }
    if (req.query.error) {
      await t.run('UPDATE {s}.whatsapp_connections SET metadata_json=$1,status=\'error\', last_error=$2, updated_at=now() WHERE id=$3', [JSON.stringify(nextMetadata), clean(req.query.error_description || req.query.error, 500), connectionId]);
      return res.send('<!doctype html><meta charset="utf-8"><title>WhatsApp</title><p>No se completó la conexión. Puedes cerrar esta ventana.</p>');
    }
    const accountId = clean(req.query.accountId || req.query.account_id, 180);
    if (!accountId) return res.status(400).send('Zernio no devolvió el Account ID de la conexión.');
    await t.run(
      `UPDATE {s}.whatsapp_connections
       SET profile_id=COALESCE(NULLIF($1,''),profile_id),
           zernio_account_id=COALESCE(NULLIF($2,''),zernio_account_id),
           metadata_json=$3, status='connected', enabled=1, last_error='', last_health_check=now(), updated_at=now()
       WHERE id=$4`,
      [callbackProfileId, accountId, JSON.stringify(nextMetadata), connectionId]
    );
    emitWhatsAppUpdate(tenantSlug, { connectionId, event: 'connection' });
    return res.send('<!doctype html><meta charset="utf-8"><title>WhatsApp conectado</title><style>body{font-family:system-ui;padding:32px;color:#172033}b{color:#087f5b}</style><h2><b>WhatsApp conectado</b></h2><p>La conexión fue recibida. Regresa a ChatBotPro para probarla.</p>');
  } catch (error) { return next(error); }
});

router.use(requireAuth);
router.use(requireModules('whatsapp'));

function isAnalyticsDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

router.get('/analytics', async (req, res, next) => {
  try {
    const timezone = String(req.timezone || 'UTC').replace(/'/g, "''");
    const requestedFrom = String(req.query.from || '');
    const requestedTo = String(req.query.to || '');
    let from = isAnalyticsDate(requestedFrom) ? requestedFrom : '';
    let to = isAnalyticsDate(requestedTo) ? requestedTo : '';
    if (!from || !to) {
      const today = await req.tdb.get(`SELECT (now() AT TIME ZONE '${timezone}')::date::text AS today`);
      from = from || today?.today;
      to = to || from;
    }
    if (!from || !to || from > to) return res.status(400).json({ error: 'El rango de fechas no es válido' });

    const row = await req.tdb.get(
      `SELECT
        COALESCE((SELECT COUNT(DISTINCT m.conversation_id)
          FROM {s}.whatsapp_messages m
          WHERE (m.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1::date AND $2::date), 0)::int AS chats,
        COALESCE((SELECT COUNT(*)
          FROM {s}.whatsapp_messages m
          WHERE (m.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1::date AND $2::date
            AND m.direction = 'outbound'
            AND LOWER(COALESCE(m.status, '')) NOT IN ('failed', 'error')), 0)::int AS messages_with_cost,
        COALESCE((SELECT COUNT(*)
          FROM {s}.orders o
          WHERE LOWER(COALESCE(o.source_channel, '')) = 'whatsapp'
            AND (o.created_at AT TIME ZONE '${timezone}')::date BETWEEN $1::date AND $2::date
            AND LOWER(COALESCE(o.status, '')) NOT IN ('cancelado', 'cancelled', 'canceled', 'fallido', 'failed', 'anulado', 'void')), 0)::int AS successful_orders`,
      [from, to]
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      from,
      to,
      timezone: req.timezone,
      totals: {
        chats: Number(row?.chats || 0),
        messagesWithCost: Number(row?.messages_with_cost || 0),
        successfulOrders: Number(row?.successful_orders || 0),
      },
      definitions: {
        chats: 'Conversaciones con actividad en el rango seleccionado.',
        messagesWithCost: 'Mensajes enviados por la API y registrados sin error; el cargo real lo determina Zernio/Meta.',
        successfulOrders: 'Pedidos de WhatsApp registrados que no están cancelados ni fallidos.',
      },
    });
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    const connections = await req.tdb.all('SELECT * FROM {s}.whatsapp_connections ORDER BY id DESC');
    const publicConnections = connections.map((row) => connectionPublic(row, req));
    if (req.query.connectionsOnly === '1') {
      return res.json({
        connections: publicConnections.map(({ id, phoneNumber, enabled, sandbox }) => ({
          id,
          phoneNumber,
          enabled,
          sandbox: sandbox?.number ? { number: sandbox.number } : null,
        })),
      });
    }
    const conversations = await req.tdb.all(
      `SELECT c.id,c.external_id,c.status,c.bot_enabled,c.last_message_at,c.updated_at,
              c.customer_phone_enc,c.customer_name_enc,
              (SELECT body FROM {s}.whatsapp_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
              (SELECT message_type FROM {s}.whatsapp_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_type,
              (SELECT direction FROM {s}.whatsapp_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_direction
       FROM {s}.whatsapp_conversations c
       ORDER BY COALESCE(c.last_message_at,c.updated_at) DESC LIMIT 100`
    );
    res.json({
      connections: publicConnections,
      conversations: conversations.map((row) => ({
        id: Number(row.id), externalId: row.external_id, status: row.status, botEnabled: Boolean(Number(row.bot_enabled)),
        lastMessageAt: row.last_message_at, updatedAt: row.updated_at, lastMessage: row.last_message || '',
        lastMessageType: row.last_message_type || '', lastDirection: row.last_direction || '',
        customerName: decrypt(row.customer_name_enc || '') || '', customerPhone: decrypt(row.customer_phone_enc || '') || '',
      })),
    });
  } catch (error) { next(error); }
});

router.post('/connections/discover', requireOwner, async (req, res, next) => {
  try {
    const saved = req.body?.id ? await connectionWithSecret(req.tdb, Number(req.body.id)) : null;
    const apiKey = clean(req.body?.apiKey, 600) || decrypt(saved?.api_key_enc || '');
    const mode = ['api', 'business_app', 'sandbox'].includes(req.body?.mode) ? req.body.mode : 'api';
    const discovery = await discoverZernioConnection(apiKey, mode);
    // Return only channel identity; provider tokens never leave the server.
    res.json({ choices: discovery.choices, sandbox: discovery.sandbox ? { phoneNumber: discovery.sandbox.phoneNumber || '' } : null });
  } catch (error) { next(error); }
});

router.post('/connections', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};
    const id = Number(body.id || 0);
    const saved = id ? await connectionWithSecret(req.tdb, id) : null;
    const mode = ['api', 'business_app', 'sandbox'].includes(body.mode) ? body.mode : (saved?.mode || 'api');
    const apiKey = clean(body.apiKey, 600);
    const activeApiKey = apiKey || decrypt(saved?.api_key_enc || '');
    const metaAccessToken = clean(body.metaAccessToken, 1000);
    const webhookSecret = clean(body.webhookSecret, 300);
    if (!activeApiKey) return res.status(400).json({ error: 'Captura la API key de Zernio para conectar WhatsApp' });
    if ([body.profileId, body.zernioAccountId].some((value) => /^sk_/i.test(String(value || '')))) {
      return res.status(400).json({ error: 'Pega la clave de Zernio en API key y selecciona tu número' });
    }
    const discovery = await discoverZernioConnection(activeApiKey, mode);
    const requested = { channelId: clean(body.channelId, 300), profileId: clean(body.profileId, 120), zernioAccountId: clean(body.zernioAccountId, 180) };
    if (!requested.channelId && !requested.profileId && !requested.zernioAccountId && saved?.mode !== 'sandbox') {
      requested.zernioAccountId = saved?.zernio_account_id || '';
      requested.profileId = saved?.profile_id || '';
    }
    const selected = mode === 'sandbox' ? null : selectConnectionChoice(discovery.choices, requested);
    if (mode !== 'sandbox' && !selected) return res.status(409).json({ error: 'Selecciona el número o la cuenta de Zernio que usará este negocio', choices: discovery.choices });
    const profileId = selected?.profileId || '';
    const zernioAccountId = selected?.zernioAccountId || discovery.sandbox?.accountId || '';
    const channelChanged = Boolean(saved && (saved.mode !== mode || saved.zernio_account_id !== zernioAccountId || saved.profile_id !== profileId));
    const wabaId = channelChanged ? '' : clean(body.wabaId ?? saved?.waba_id, 180);
    const phoneNumberId = channelChanged ? '' : clean(body.phoneNumberId ?? saved?.phone_number_id, 180);
    const phoneNumber = clean(selected?.phoneNumber || discovery.sandbox?.phoneNumber || (channelChanged ? '' : saved?.phone_number), 40);
    const displayName = clean(req.tenant.business_name || req.tenant.businessName || selected?.displayName || saved?.display_name || req.tenant.slug, 160);
    const previousMetadata = safeJson(saved?.metadata_json, {});
    const nextMetadata = { ...previousMetadata };
    if (channelChanged) { delete nextMetadata.oauthState; delete nextMetadata.oauthStartedAt; }
    if (mode === 'sandbox') nextMetadata.sandbox = {
      ...(saved?.mode === 'sandbox' ? previousMetadata.sandbox : {}),
      number: phoneNumber,
      accountId: zernioAccountId,
      templateName: discovery.sandbox?.template?.name || 'sandbox_start',
      templateLanguage: discovery.sandbox?.template?.language || 'en',
    };
    else delete nextMetadata.sandbox;
    let row;
    if (id) {
      row = saved;
      const updated = await req.tdb.get(
        `UPDATE {s}.whatsapp_connections SET
           profile_id=$1,zernio_account_id=$2,waba_id=$3,phone_number_id=$4,phone_number=$5,display_name=$6,mode=$7,
           api_key_enc=CASE WHEN $8='' THEN api_key_enc ELSE $9 END,
           meta_access_token_enc=CASE WHEN $10='' THEN meta_access_token_enc ELSE $11 END,
           webhook_secret_enc=CASE WHEN $12='' THEN webhook_secret_enc ELSE $13 END,
           metadata_json=$14,updated_at=now(),last_error='',
           status=CASE WHEN $16 THEN 'pending' ELSE status END,
           enabled=CASE WHEN $16 THEN 0 ELSE enabled END
         WHERE id=$15 RETURNING *`,
        [profileId, zernioAccountId, wabaId, phoneNumberId, phoneNumber, displayName, mode, apiKey, apiKey ? encrypt(apiKey) : '', metaAccessToken, metaAccessToken ? encrypt(metaAccessToken) : '', webhookSecret, webhookSecret ? encrypt(webhookSecret) : '', JSON.stringify(nextMetadata), id, channelChanged]
      );
      row = updated || row;
    } else {
      const token = crypto.randomBytes(32).toString('base64url');
      row = await req.tdb.get(
        `INSERT INTO {s}.whatsapp_connections
          (profile_id,zernio_account_id,waba_id,phone_number_id,phone_number,display_name,mode,status,enabled,api_key_enc,meta_access_token_enc,webhook_secret_enc,webhook_token_enc,webhook_token_hash,metadata_json)
         VALUES($1,$2,$3,$4,$5,$6,$7,'pending',0,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [profileId, zernioAccountId, wabaId, phoneNumberId, phoneNumber, displayName, mode, encrypt(apiKey) || '', encrypt(metaAccessToken) || '', encrypt(webhookSecret) || '', encrypt(token), lookupHash(token), JSON.stringify(nextMetadata)]
      );
      await q(
        `INSERT INTO whatsapp_webhook_tokens(token_hash,tenant_slug,connection_id)
         VALUES($1,$2,$3) ON CONFLICT(token_hash) DO NOTHING`,
        [lookupHash(token), req.tenant.slug, row.id]
      );
    }
    if (mode !== 'sandbox' && zernioAccountId) {
      try {
        await zernioRequest({ apiKey: activeApiKey, path: `/v1/whatsapp/number-info?accountId=${encodeURIComponent(zernioAccountId)}` });
        row = await req.tdb.get("UPDATE {s}.whatsapp_connections SET status='active',enabled=1,last_health_check=now(),updated_at=now() WHERE id=$1 RETURNING *", [row.id]) || row;
      } catch (error) {
        row = await req.tdb.get("UPDATE {s}.whatsapp_connections SET status='pending',enabled=0,last_error=$1,last_health_check=now(),updated_at=now() WHERE id=$2 RETURNING *", [clean(error.message, 500), row.id]) || row;
      }
    }
    let webhookSetup = { registered: false };
    try {
      webhookSetup = await ensureZernioWebhook({ req, t: req.tdb, connection: row });
      if (webhookSetup.connection) row = webhookSetup.connection;
    } catch (error) {
      webhookSetup = { registered: false, reason: clean(error.message, 300) };
      const metadata = safeJson(row.metadata_json, {});
      row = await req.tdb.get(
        'UPDATE {s}.whatsapp_connections SET metadata_json=$1,last_error=$2,updated_at=now() WHERE id=$3 RETURNING *',
        [JSON.stringify({ ...metadata, webhookError: webhookSetup.reason }), webhookSetup.reason, row.id]
      ) || row;
    }
    res.status(id ? 200 : 201).json({ ok: true, connection: connectionPublic(row, req),
      webhookSetup: { registered: Boolean(webhookSetup.registered), reason: webhookSetup.reason || '' } });
  } catch (error) { next(error); }
});

router.post('/connections/:id/webhook', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    const setup = await ensureZernioWebhook({ req, t: req.tdb, connection });
    if (!setup.registered) return res.status(409).json({ error: setup.reason, connection: connectionPublic(connection, req) });
    res.json({ ok: true, connection: connectionPublic(setup.connection || connection, req), webhook: setup.webhook });
  } catch (error) { next(error); }
});

router.post('/connections/:id/connect-url', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    if (connection.mode === 'sandbox') return res.status(400).json({ error: 'Usa las acciones de Sandbox para esta conexión' });
    const apiKey = decrypt(connection.api_key_enc);
    if (!apiKey) return res.status(400).json({ error: 'Guarda primero la API key de Zernio' });
    if (!connection.profile_id || /^sk_/i.test(connection.profile_id)) return res.status(400).json({ error: 'Consulta tus números de Zernio, selecciona la cuenta y guarda la conexión antes de abrir Meta' });
    const state = crypto.randomBytes(24).toString('base64url');
    const metadata = { ...safeJson(connection.metadata_json, {}), oauthState: state, oauthStartedAt: new Date().toISOString() };
    await req.tdb.run('UPDATE {s}.whatsapp_connections SET metadata_json=$1,updated_at=now() WHERE id=$2', [JSON.stringify(metadata), connection.id]);
    const callbackUrl = new URL(`${publicBaseUrl(req)}/api/whatsapp/oauth/callback`);
    callbackUrl.searchParams.set('tenant', req.tenant.slug);
    callbackUrl.searchParams.set('connectionId', String(connection.id));
    callbackUrl.searchParams.set('state', state);
    const params = new URLSearchParams({
      profileId: connection.profile_id,
      redirect_url: callbackUrl.toString(),
      onboarding: connection.mode || 'business_app',
    });
    const data = await zernioRequest({ apiKey, path: `/v1/connect/whatsapp?${params.toString()}` });
    const authUrl = firstValue(data, ['authUrl', 'data.authUrl', 'url', 'data.url']);
    if (!authUrl) throw Object.assign(new Error('Zernio no devolvió una URL de conexión'), { status: 502 });
    res.json({ authUrl, state });
  } catch (error) { next(error); }
});

router.post('/connections/:id/sandbox/discover', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    const data = await zernioRequest({ apiKey: decrypt(connection.api_key_enc), path: '/v1/phone-numbers' });
    const payload = data?.sandbox ? data : (data?.data || data);
    const sandbox = payload?.sandbox;
    if (!sandbox?.isSandbox && !sandbox?.accountId) return res.status(404).json({ error: 'Zernio no tiene sandbox disponible para esta cuenta' });
    const metadata = safeJson(connection.metadata_json, {});
    const current = metadata.sandbox || {};
    const nextSandbox = {
      ...current,
      number: clean(sandbox.phoneNumber || current.number, 40),
      accountId: clean(sandbox.accountId || current.accountId, 180),
      templateName: clean(sandbox.template?.name || current.templateName || 'sandbox_start', 120),
      templateLanguage: clean(sandbox.template?.language || current.templateLanguage || 'en', 30),
    };
    const updated = await req.tdb.get(
      `UPDATE {s}.whatsapp_connections SET mode='sandbox',zernio_account_id=$1,metadata_json=$2,status='pending',enabled=0,last_error='',updated_at=now() WHERE id=$3 RETURNING *`,
      [nextSandbox.accountId, JSON.stringify({ ...metadata, sandbox: nextSandbox }), connection.id]
    );
    let webhookSetup = { registered: false };
    try { webhookSetup = await ensureZernioWebhook({ req, t: req.tdb, connection: updated }); } catch (error) { webhookSetup = { registered: false, reason: clean(error.message, 300) }; }
    res.json({ ok: true, connection: connectionPublic(webhookSetup.connection || updated, req), webhookSetup });
  } catch (error) { next(error); }
});

router.post('/connections/:id/sandbox/session', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: 'Captura un teléfono válido para la prueba' });
    const data = await zernioRequest({
      apiKey: decrypt(connection.api_key_enc),
      path: '/v1/whatsapp/sandbox/sessions',
      method: 'POST',
      body: { phone: `+${phone}` },
    });
    const session = data?.session || data?.data?.session || {};
    const metadata = safeJson(connection.metadata_json, {});
    const current = metadata.sandbox || {};
    const nextSandbox = {
      ...current,
      phone: clean(session.phoneE164 || phone, 40),
      sessionId: clean(session.id || '', 180),
      status: clean(session.status || 'pending', 30),
      expiresAt: session.expiresAt || null,
      activatedAt: session.activatedAt || null,
      number: clean(firstValue(data, ['sandboxNumber', 'data.sandboxNumber']) || current.number, 40),
    };
    const updated = await req.tdb.get(
      `UPDATE {s}.whatsapp_connections SET mode='sandbox',metadata_json=$1,status='pending',enabled=0,last_error='',updated_at=now() WHERE id=$2 RETURNING *`,
      [JSON.stringify({ ...metadata, sandbox: nextSandbox }), connection.id]
    );
    let webhookSetup = { registered: false };
    try { webhookSetup = await ensureZernioWebhook({ req, t: req.tdb, connection: updated }); } catch (error) { webhookSetup = { registered: false, reason: clean(error.message, 300) }; }
    res.json({ ok: true, session, connection: connectionPublic(webhookSetup.connection || updated, req), webhookSetup });
  } catch (error) { next(error); }
});

router.get('/connections/:id/sandbox/session', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    const data = await zernioRequest({ apiKey: decrypt(connection.api_key_enc), path: '/v1/whatsapp/sandbox/sessions' });
    const payload = Array.isArray(data?.sessions) ? data : (data?.data || data);
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    const metadata = safeJson(connection.metadata_json, {});
    const current = metadata.sandbox || {};
    const session = sessions.find((item) => String(item.id) === String(current.sessionId)) || sessions[0] || null;
    const nextSandbox = session ? { ...current, phone: clean(session.phoneE164 || current.phone, 40), sessionId: clean(session.id || current.sessionId, 180), status: clean(session.status || current.status || 'pending', 30), expiresAt: session.expiresAt || current.expiresAt || null, activatedAt: session.activatedAt || current.activatedAt || null } : current;
    const active = connection.mode === 'sandbox' && nextSandbox.status === 'active';
    const updated = await req.tdb.get(
      `UPDATE {s}.whatsapp_connections SET mode='sandbox',metadata_json=$1,status=$2,enabled=$3,last_health_check=now(),updated_at=now() WHERE id=$4 RETURNING *`,
      [JSON.stringify({ ...metadata, sandbox: nextSandbox }), active ? 'active' : 'pending', active ? 1 : 0, connection.id]
    );
    res.json({ ok: true, session, connection: connectionPublic(updated, req) });
  } catch (error) { next(error); }
});

router.delete('/connections/:id/sandbox/session', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    const metadata = safeJson(connection.metadata_json, {});
    const sessionId = clean(metadata.sandbox?.sessionId, 180);
    if (sessionId) await zernioRequest({ apiKey: decrypt(connection.api_key_enc), path: `/v1/whatsapp/sandbox/sessions/${encodeURIComponent(sessionId)}`, method: 'DELETE' });
    const nextMetadata = { ...metadata };
    delete nextMetadata.sandbox;
    const updated = await req.tdb.get(
      `UPDATE {s}.whatsapp_connections SET mode='sandbox',metadata_json=$1,status='disabled',enabled=0,last_error='',updated_at=now() WHERE id=$2 RETURNING *`,
      [JSON.stringify(nextMetadata), connection.id]
    );
    res.json({ ok: true, connection: connectionPublic(updated, req) });
  } catch (error) { next(error); }
});

router.post('/connections/:id/sandbox/start-conversation', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    const metadata = safeJson(connection.metadata_json, {});
    const sandbox = metadata.sandbox || {};
    if (connection.mode !== 'sandbox' || sandbox.status !== 'active') return res.status(409).json({ error: 'Activa primero el teléfono de prueba del sandbox' });
    const participantId = normalizePhone(sandbox.phone);
    if (!participantId || !connection.zernio_account_id) return res.status(409).json({ error: 'El sandbox todavía no tiene cuenta o teléfono activo' });
    const data = await zernioRequest({
      apiKey: decrypt(connection.api_key_enc),
      path: '/v1/inbox/conversations',
      method: 'POST',
      body: { accountId: connection.zernio_account_id, participantId, templateName: sandbox.templateName || 'sandbox_start', templateLanguage: sandbox.templateLanguage || 'en', templateParams: [] },
    });
    const conversationId = clean(firstValue(data, ['data.conversationId', 'conversationId']), 180);
    const messageId = clean(firstValue(data, ['data.messageId', 'messageId']) || `sandbox_${sha256(`${Date.now()}_${participantId}`)}`, 180);
    if (!conversationId) throw Object.assign(new Error('Zernio no devolvió el ID de la conversación sandbox'), { status: 502 });
    const conversation = await req.tdb.get(
      `INSERT INTO {s}.whatsapp_conversations(connection_id,external_id,customer_phone_enc,customer_phone_hash,customer_name_enc,status,bot_enabled,last_message_at,updated_at)
       VALUES($1,$2,$3,$4,'','open',1,now(),now())
       ON CONFLICT(connection_id,external_id) DO UPDATE SET customer_phone_enc=EXCLUDED.customer_phone_enc,customer_phone_hash=EXCLUDED.customer_phone_hash,last_message_at=now(),updated_at=now()
       RETURNING *`,
      [connection.id, conversationId, encrypt(participantId), lookupHash(participantId)]
    );
    await req.tdb.run(
      `INSERT INTO {s}.whatsapp_messages(conversation_id,external_message_id,direction,message_type,body,source,status,payload_json)
       VALUES($1,$2,'outbound','template',$3,'sandbox','sent',$4)
       ON CONFLICT(external_message_id) DO NOTHING`,
      [conversation.id, messageId, sandbox.templateName || 'sandbox_start', safePayload(data)]
    );
    emitWhatsAppUpdate(req.tenant.slug, { conversationId: Number(conversation.id), event: 'message' });
    res.json({ ok: true, conversationId, messageId });
  } catch (error) { next(error); }
});

router.post('/connections/:id/test', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    if (connection.mode === 'sandbox') return res.status(400).json({ error: 'Revisa la sesión desde las acciones de Sandbox' });
    if (!connection.zernio_account_id) return res.status(400).json({ error: 'Completa la conexión con Meta antes de revisar el canal' });
    const data = await zernioRequest({ apiKey: decrypt(connection.api_key_enc), path: `/v1/whatsapp/number-info?accountId=${encodeURIComponent(connection.zernio_account_id)}` });
    const updated = await req.tdb.get(`UPDATE {s}.whatsapp_connections SET status='active',enabled=1,last_error='',last_health_check=now(),updated_at=now() WHERE id=$1 RETURNING *`, [connection.id]);
    let webhookSetup = { registered: false };
    try { webhookSetup = await ensureZernioWebhook({ req, t: req.tdb, connection: updated }); } catch (error) { webhookSetup = { registered: false, reason: clean(error.message, 300) }; }
    res.json({ ok: true, connection: connectionPublic(webhookSetup.connection || updated, req), numberInfo: data,
      webhookSetup: { registered: Boolean(webhookSetup.registered), reason: webhookSetup.reason || '' } });
  } catch (error) {
    await req.tdb.run('UPDATE {s}.whatsapp_connections SET status=\'error\',last_error=$1,last_health_check=now(),updated_at=now() WHERE id=$2', [clean(error.message, 500), Number(req.params.id)]).catch(() => {});
    next(error);
  }
});

router.post('/connections/:id/profile-photo', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    if (connection.mode === 'sandbox') return res.status(400).json({ error: 'El sandbox no tiene un perfil de WhatsApp propio' });
    if (!connection.zernio_account_id) return res.status(400).json({ error: 'Conecta tu número de WhatsApp antes de sincronizar la foto' });
    const apiKey = decrypt(connection.api_key_enc);
    if (!apiKey) return res.status(400).json({ error: 'Guarda primero la API key de Zernio' });
    const logo = String(req.tenant.logo || '').trim();
    if (!logo) return res.status(400).json({ error: 'Configura primero el logo en Mi negocio' });
    const publicBase = String(config.WHATSAPP_PUBLIC_URL || '').replace(/\/+$/, '');
    const photoUrl = /^https:\/\//i.test(logo)
      ? logo
      : publicBase ? `${publicBase}/${logo.replace(/^\/+/, '')}` : '';
    if (!/^https:\/\//i.test(photoUrl)) {
      return res.status(400).json({ error: 'Configura PUBLIC_APP_URL o WHATSAPP_PUBLIC_URL con HTTPS para publicar el logo' });
    }

    let data;
    try {
      data = await zernioRequest({
        apiKey,
        path: '/v1/whatsapp/business-profile/photo',
        method: 'POST',
        body: { accountId: connection.zernio_account_id, url: photoUrl },
      });
    } catch (error) {
      if (Number(error.providerStatus) === 422) {
        return res.status(409).json({ error: 'La foto está bloqueada por coexistencia. Cámbiala desde la app WhatsApp Business del teléfono.' });
      }
      throw error;
    }

    const metadata = safeJson(connection.metadata_json, {});
    const updated = await req.tdb.get(
      'UPDATE {s}.whatsapp_connections SET metadata_json=$1,last_error=\'\',updated_at=now() WHERE id=$2 RETURNING *',
      [JSON.stringify({ ...metadata, profilePhotoUrl: photoUrl, profilePhotoSyncedAt: new Date().toISOString() }), connection.id]
    );
    res.json({ ok: true, connection: connectionPublic(updated || connection, req), profilePhoto: data });
  } catch (error) { next(error); }
});

router.post('/connections/:id/toggle', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const row = await connectionWithSecret(req.tdb, id);
    const enabled = req.body?.enabled === undefined ? !Boolean(Number(row.enabled)) : Boolean(req.body.enabled);
    const updated = await req.tdb.get('UPDATE {s}.whatsapp_connections SET enabled=$1,status=CASE WHEN $1=1 THEN CASE WHEN status=\'error\' THEN \'connected\' ELSE status END ELSE \'disabled\' END,updated_at=now() WHERE id=$2 RETURNING *', [enabled ? 1 : 0, id]);
    res.json({ ok: true, connection: connectionPublic(updated, req) });
  } catch (error) { next(error); }
});

router.delete('/connections/:id', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await connectionWithSecret(req.tdb, id);
    await q('UPDATE whatsapp_webhook_tokens SET revoked_at=now() WHERE tenant_slug=$1 AND connection_id=$2 AND revoked_at IS NULL', [req.tenant.slug, id]);
    await req.tdb.run('DELETE FROM {s}.whatsapp_connections WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// Shapes a stored row for the inbox: coordinates for location pins, the
// buttons/list rows the customer was offered, and the image URL if any.
function inboxMessageView(row) {
  const view = {
    id: row.id, external_message_id: row.external_message_id, direction: row.direction, message_type: row.message_type,
    body: row.body, source: row.source, status: row.status, created_at: row.created_at,
  };
  if (!['location', 'interactive', 'image'].includes(row.message_type)) return view;
  const payload = safeJson(row.payload_json, {});
  if (row.message_type === 'location') {
    const location = whatsappLocation(payload);
    if (location) view.location = location;
  } else if (row.message_type === 'interactive') {
    const request = payload.request || {};
    const rows = (request.interactive?.action?.sections || []).flatMap((section) => section.rows || []);
    const titles = [...(request.buttons || []), ...rows].map((item) => clean(item.title, 40)).filter(Boolean);
    if (request.interactive?.type === 'locationrequestmessage') titles.push('📍 Enviar ubicación');
    if (titles.length) view.options = titles.slice(0, 12);
    if (request.interactive?.action?.button) view.listButton = clean(request.interactive.action.button, 40);
  } else if (row.message_type === 'image') {
    const url = clean(payload.request?.attachmentUrl, 1000);
    if (/^https?:\/\//i.test(url)) view.mediaUrl = url;
  }
  return view;
}

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversation = await req.tdb.get('SELECT id FROM {s}.whatsapp_conversations WHERE id=$1 LIMIT 1', [Number(req.params.id)]);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
    // Newest 300, returned oldest-first with id as a stable tie-breaker.
    const rows = await req.tdb.all(
      `SELECT * FROM (
         SELECT id,external_message_id,direction,message_type,body,source,status,created_at,
                CASE WHEN message_type IN ('location','interactive','image') THEN payload_json ELSE '' END AS payload_json
         FROM {s}.whatsapp_messages WHERE conversation_id=$1 ORDER BY created_at DESC, id DESC LIMIT 300
       ) latest ORDER BY created_at ASC, id ASC`,
      [conversation.id]
    );
    res.set('Cache-Control', 'no-store');
    res.json(rows.map(inboxMessageView));
  } catch (error) { next(error); }
});

router.post('/conversations/:id/takeover', async (req, res, next) => {
  try {
    const botEnabled = req.body?.botEnabled === true ? 1 : 0;
    const row = await req.tdb.get('UPDATE {s}.whatsapp_conversations SET bot_enabled=$1,status=$2,assigned_user_id=$3,updated_at=now() WHERE id=$4 RETURNING id,bot_enabled,status,assigned_user_id', [botEnabled, botEnabled ? 'open' : 'human', botEnabled ? null : req.user.uid, Number(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json({ ok: true, conversation: row });
  } catch (error) { next(error); }
});

router.post('/conversations/:id/send', async (req, res, next) => {
  try {
    const conversation = await req.tdb.get('SELECT * FROM {s}.whatsapp_conversations WHERE id=$1 LIMIT 1', [Number(req.params.id)]);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
    const connection = await req.tdb.get('SELECT * FROM {s}.whatsapp_connections WHERE id=$1 LIMIT 1', [conversation.connection_id]);
    if (!connection || !Number(connection.enabled)) return res.status(409).json({ error: 'La conexión de WhatsApp no está activa' });
    const text = clean(req.body?.message, 10000);
    if (!text) return res.status(400).json({ error: 'Escribe un mensaje' });
    const sent = await sendText(req.tdb, connection, conversation, text, `human:${req.user.uid}`);
    await req.tdb.run('UPDATE {s}.whatsapp_conversations SET bot_enabled=0,status=\'human\',assigned_user_id=$1,updated_at=now() WHERE id=$2', [req.user.uid, conversation.id]);
    emitWhatsAppUpdate(req.tenant.slug, { conversationId: Number(conversation.id), event: 'message' });
    res.json({ ok: true, messageId: sent.messageId });
  } catch (error) { next(error); }
});

// Exposed on the router only for focused unit tests; the HTTP API remains the
// Express router itself.
router.whatsappInteractiveMessages = whatsappInteractiveMessages;
router.whatsappReplyPlan = whatsappReplyPlan;
router.whatsappButtonTitle = whatsappButtonTitle;
router.whatsappEngineInput = whatsappEngineInput;
router.whatsappBankAccountsText = whatsappBankAccountsText;
router.webhookMessage = webhookMessage;
router.whatsappConversationCustomerName = whatsappConversationCustomerName;
router.inboxMessageView = inboxMessageView;
router.enqueueConversation = enqueueConversation;

module.exports = router;
