const express = require('express');
const crypto = require('node:crypto');
const { q, tdb } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { handleMessage } = require('../chatbot/engine');
const { emitWhatsAppUpdate } = require('../notifications');
const config = require('../config');

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
    profileId: row.profile_id || '',
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

async function zernioRequest({ apiKey, path, method = 'GET', body }) {
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
     SET webhook_secret_enc=$1,metadata_json=$2,last_error='',updated_at=now()
     WHERE id=$3 RETURNING *`,
    [encrypt(secret), JSON.stringify(nextMetadata), connection.id]
  );
  return { registered: true, connection: updated || connection, webhook };
}

async function connectionWithSecret(t, id) {
  const row = await t.get('SELECT * FROM {s}.whatsapp_connections WHERE id = $1 LIMIT 1', [id]);
  if (!row) throw Object.assign(new Error('Conexión de WhatsApp no encontrada'), { status: 404 });
  return row;
}

async function sendText(t, connection, conversation, text, source = 'bot') {
  const body = clean(text, 10000);
  if (!body) return null;
  const data = await zernioRequest({
    apiKey: decrypt(connection.api_key_enc),
    path: `/v1/inbox/conversations/${encodeURIComponent(conversation.external_id)}/messages`,
    method: 'POST',
    body: { accountId: connection.zernio_account_id, message: body },
  });
  const messageId = clean(firstValue(data, ['data.messageId', 'messageId', 'data.id', 'id']) || `out_${sha256(`${Date.now()}_${body}`)}`, 180);
  await t.run(
    `INSERT INTO {s}.whatsapp_messages
      (conversation_id, external_message_id, direction, message_type, body, source, status, payload_json)
     VALUES ($1,$2,'outbound','text',$3,$4,'sent',$5)
     ON CONFLICT (external_message_id) DO NOTHING`,
    [conversation.id, messageId, body, source, safePayload(data)]
  );
  await t.run('UPDATE {s}.whatsapp_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [conversation.id]);
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
    .replace(/^🔁\s*Ya he pedido$/i, '🔁 Ya he pedido');
  const short = compact
    .replace(/^⏭️\s*Omitir referencia$/i, 'Omitir ref.')
    .replace(/^📍\s*Ubicación$/i, 'Ubicación')
    .replace(/^✅\s*Finalizar pedido$/i, 'Finalizar')
    .replace(/^↩️\s*Continuar$/i, 'Continuar')
    .replace(/^↩️\s*Regresar$/i, 'Regresar');
  return whatsappDisplayText(`👉 ${short}`, 20);
}

function whatsappTransportId(value) {
  const canonical = whatsappDisplayText(value, 180);
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
    rows.push({
      id,
      title,
      ...(variantHint || product.priceLabel || product.description
        ? { description: whatsappDisplayText(variantHint || product.priceLabel || product.description, 72) }
        : {}),
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
    const title = whatsappDisplayText(`👉 ${name}`, 24);
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

function whatsappOptionRows(reply) {
  const rows = [];
  const seen = new Set();
  for (const option of (Array.isArray(reply.options) ? reply.options : [])) {
    if (String(option?.value || '').toLowerCase() === 'share_location') continue;
    if (String(option?.value || '').toLowerCase().startsWith('upsell_add|')) continue;
    const id = whatsappTransportId(option.value);
    const title = whatsappButtonTitle(option.label);
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

function whatsappInteractiveMessages(reply) {
  const messages = [];
  const productRows = whatsappProductRows(reply);
  const upsellRows = whatsappUpsellRows(reply);
  const optionRows = whatsappOptionRows(reply);

  if ((reply.options || []).some((option) => String(option?.value || '').toLowerCase() === 'share_location')) {
    messages.push({
      kind: 'location-request',
      bodyText: '📍 *Comparte tu ubicación*',
      interactive: { type: 'locationrequestmessage' },
    });
  }

  const addButtonMessages = (rows, bodyText) => {
    for (let index = 0; index < rows.length; index += 3) {
      const chunk = rows.slice(index, index + 3);
      messages.push({
        kind: 'buttons',
        bodyText,
        buttons: chunk.map((row) => ({ type: 'postback', title: row.title, payload: row.id })),
      });
    }
  };

  if (upsellRows.length) {
    const bodyText = '*Selecciona una opción:*';
    for (let index = 0; index < upsellRows.length; index += 10) {
      const chunk = upsellRows.slice(index, index + 10);
      const pageLabel = upsellRows.length > 10 ? ` ${Math.floor(index / 10) + 1}/${Math.ceil(upsellRows.length / 10)}` : '';
      messages.push({
        kind: 'list',
        bodyText,
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: whatsappDisplayText(`Ver complementos${pageLabel}`, 20),
            sections: [{ rows: chunk }],
          },
        },
      });
    }
  } else if (productRows.length) {
    const bodyText = '*Selecciona un producto:*';
    // Up to three products can be shown as visible buttons. Larger catalogs
    // use WhatsApp's native list so the customer can browse without receiving
    // a long wall of button messages.
    if (productRows.length <= 3) {
      addButtonMessages(productRows, bodyText);
    } else {
      for (let index = 0; index < productRows.length; index += 10) {
        const chunk = productRows.slice(index, index + 10);
        const pageLabel = productRows.length > 10 ? ` ${Math.floor(index / 10) + 1}/${Math.ceil(productRows.length / 10)}` : '';
        messages.push({
          kind: 'list',
          bodyText,
          interactive: {
            type: 'list',
            body: { text: bodyText },
            action: {
              button: whatsappDisplayText(`Ver productos${pageLabel}`, 20),
              sections: [{ rows: chunk }],
            },
          },
        });
      }
    }
  }

  // Keep exit/confirmation actions outside product lists so the customer can
  // always see how to continue or leave the current step.
  if (optionRows.length) {
    addButtonMessages(optionRows, '*Selecciona una opción:*');
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
  });
  const messageId = clean(firstValue(data, ['data.messageId', 'messageId', 'data.id', 'id']) || `out_${sha256(`${Date.now()}_${JSON.stringify(body)}`)}`, 180);
  await t.run(
    `INSERT INTO {s}.whatsapp_messages
      (conversation_id, external_message_id, direction, message_type, body, source, status, payload_json)
     VALUES ($1,$2,'outbound','interactive',$3,$4,'sent',$5)
     ON CONFLICT (external_message_id) DO NOTHING`,
    [conversation.id, messageId, message.bodyText, source, safePayload({ request: body, response: data })]
  );
  await t.run('UPDATE {s}.whatsapp_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [conversation.id]);
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
    await t.run(
      `INSERT INTO {s}.whatsapp_messages
        (conversation_id, external_message_id, direction, message_type, body, source, status, payload_json)
       VALUES ($1,$2,'outbound','image',$3,'bot','sent',$4)
       ON CONFLICT (external_message_id) DO NOTHING`,
      [conversation.id, messageId, caption, safePayload({ request: body, response: data })]
    );
    await t.run('UPDATE {s}.whatsapp_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1', [conversation.id]);
    return { messageId, data };
  } catch (error) {
    // An unavailable image must never interrupt the tenant's order flow.
    console.warn('[whatsapp][product-image]', productId, error.message);
    return null;
  }
}

async function sendBotReply(t, connection, conversation, reply) {
  const bankText = whatsappBankAccountsText(reply.bankAccounts, reply.bankAccountTitle);
  const hasBankCard = Boolean(bankText);
  for (const message of (reply.messages || [])) {
    // The web assistant renders bankAccounts as a visual card. WhatsApp gets
    // one copy-friendly text card instead of receiving the fallback twice.
    if (hasBankCard && /^Datos para realizar tu pago con /i.test(String(message || '').trim())) continue;
    try {
      await sendText(t, connection, conversation, whatsappPromptText(message), 'bot');
    } catch (error) {
      console.warn('[whatsapp][send-text]', error.message);
    }
  }
  if (bankText) {
    try {
      await sendText(t, connection, conversation, bankText, 'bot');
    } catch (error) {
      console.warn('[whatsapp][send-bank-details]', error.message);
    }
  }
  for (const interactive of whatsappInteractiveMessages(reply)) {
    try {
      await sendInteractive(t, connection, conversation, interactive, 'bot');
    } catch (error) {
      console.warn('[whatsapp][send-interactive]', error.message);
    }
  }
}

// Zernio expects a webhook response within five seconds. Persisting the event
// and the inbound message happens in the request; the potentially slow AI and
// outbound WhatsApp calls continue after the 2xx response.
async function processWhatsAppBotReply({ t, tenantSlug, connection, conversation, parsed, externalConversationId }) {
  try {
    const sessionId = `wa_${connection.id}_${sha256(externalConversationId).slice(0, 42)}`;
    const reply = await handleMessage(t, tenantSlug, sessionId, parsed.text, {
      orderChannel: 'chatbot',
      sourceChannel: 'whatsapp',
      customerPhone: parsed.participant,
      customerName: parsed.senderName,
    });
    const selectedProductId = whatsappProductIdFromInput(parsed.text);
    if (selectedProductId) await sendProductImage(t, connection, conversation, selectedProductId);
    await sendBotReply(t, connection, conversation, reply);
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
  const location = whatsappLocation(payload);
  const textValue = typeof messageValue === 'object' ? clean(messageValue?.body || messageValue?.text || '') : clean(messageValue, 10000);
  // Zernio returns list/button taps in metadata rather than message text. The
  // ID is intentionally passed to the existing chatbot engine because its
  // machine commands are already the canonical option values.
  // Location events similarly carry a human-readable message such as
  // "📍 Location" while the actual coordinates live in metadata.location.
  // Convert them to the engine's canonical geo:<lat>,<lng>|<label> format.
  const locationText = location ? `geo:${location.lat},${location.lng}|${location.label}` : '';
  const text = interactiveId || locationText || textValue || interactiveTitle;
  const source = clean(firstValue(payload, ['source', 'data.source', 'metadata.source']), 80);
  const incoming = eventType.includes('received') || eventType.includes('inbound') || eventType === 'message.new';
  const outgoing = eventType.includes('sent') || eventType.includes('outbound') || eventType.includes('outgoing');
  return { eventType, messageId, conversationId, participant, recipient, senderName, text, interactiveId, interactiveType, interactiveTitle, location, source, incoming, outgoing };
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

    const shouldStoreMessage = parsed.incoming
      ? Boolean(parsed.text || parsed.participant || parsed.conversationId)
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
           customer_phone_enc=CASE WHEN EXCLUDED.customer_phone_enc IS NULL THEN {s}.whatsapp_conversations.customer_phone_enc ELSE EXCLUDED.customer_phone_enc END,
           customer_phone_hash=CASE WHEN EXCLUDED.customer_phone_hash='' THEN {s}.whatsapp_conversations.customer_phone_hash ELSE EXCLUDED.customer_phone_hash END,
           customer_name_enc=CASE WHEN EXCLUDED.customer_name_enc IS NULL THEN {s}.whatsapp_conversations.customer_name_enc ELSE EXCLUDED.customer_name_enc END,
           last_message_at=now(), updated_at=now()
         RETURNING *`,
        [connection.id, externalConversationId, customerPhone ? encrypt(customerPhone) : null, customerPhone ? lookupHash(customerPhone) : '', customerName ? encrypt(customerName) : null]
      );

      if (parsed.messageId && parsed.text) {
        const messageBody = parsed.location
          ? (parsed.location.label || `Ubicación: ${parsed.location.lat}, ${parsed.location.lng}`)
          : (parsed.interactiveTitle || parsed.text);
        await t.run(
          `INSERT INTO {s}.whatsapp_messages
            (conversation_id,external_message_id,direction,message_type,body,source,status,payload_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT(external_message_id) DO NOTHING`,
          [conversation.id, parsed.messageId, parsed.incoming ? 'inbound' : 'outbound', parsed.location ? 'location' : (parsed.interactiveId ? 'interactive' : 'text'), messageBody, parsed.source || (parsed.incoming ? 'whatsapp' : 'cellular'), parsed.incoming ? 'received' : 'sent', safePayload(payload)]
        );
      }

      if (parsed.incoming && parsed.text && Number(conversation.bot_enabled) === 1 && Number(connection.enabled) === 1) {
        setImmediate(() => {
          processWhatsAppBotReply({ t, tenantSlug, connection, conversation, parsed, externalConversationId }).catch((error) => {
            console.error('[whatsapp][bot-queue]', tenantSlug, error.message);
          });
        });
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

router.get('/', async (req, res, next) => {
  try {
    const connections = await req.tdb.all('SELECT * FROM {s}.whatsapp_connections ORDER BY id DESC');
    const conversations = await req.tdb.all(
      `SELECT c.id,c.external_id,c.status,c.bot_enabled,c.last_message_at,c.updated_at,
              c.customer_phone_enc,c.customer_name_enc,
              (SELECT body FROM {s}.whatsapp_messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM {s}.whatsapp_conversations c
       ORDER BY COALESCE(c.last_message_at,c.updated_at) DESC LIMIT 100`
    );
    res.json({
      connections: connections.map((row) => connectionPublic(row, req)),
      conversations: conversations.map((row) => ({
        id: Number(row.id), externalId: row.external_id, status: row.status, botEnabled: Boolean(Number(row.bot_enabled)),
        lastMessageAt: row.last_message_at, updatedAt: row.updated_at, lastMessage: row.last_message || '',
        customerName: decrypt(row.customer_name_enc || '') || '', customerPhone: decrypt(row.customer_phone_enc || '') || '',
      })),
    });
  } catch (error) { next(error); }
});

router.post('/connections', requireOwner, async (req, res, next) => {
  try {
    const body = req.body || {};
    const id = Number(body.id || 0);
    const profileId = clean(body.profileId, 120);
    const zernioAccountId = clean(body.zernioAccountId, 180);
    const wabaId = clean(body.wabaId, 180);
    const phoneNumberId = clean(body.phoneNumberId, 180);
    const phoneNumber = clean(body.phoneNumber, 40);
    const displayName = clean(body.displayName, 160);
    const mode = ['api', 'business_app', 'sandbox'].includes(body.mode) ? body.mode : 'business_app';
    const apiKey = clean(body.apiKey, 600);
    const metaAccessToken = clean(body.metaAccessToken, 1000);
    const webhookSecret = clean(body.webhookSecret, 300);
    if (mode !== 'sandbox' && !profileId && !zernioAccountId) return res.status(400).json({ error: 'Captura el Profile ID o el Account ID de Zernio' });
    if (mode === 'sandbox' && !id && !apiKey) return res.status(400).json({ error: 'Captura la API key de Zernio para usar el sandbox' });
    let row;
    if (id) {
      row = await connectionWithSecret(req.tdb, id);
      const metadata = safeJson(row.metadata_json, {});
      const nextMetadata = { ...metadata };
      if (mode !== 'sandbox') delete nextMetadata.sandbox;
      const updated = await req.tdb.get(
        `UPDATE {s}.whatsapp_connections SET
           profile_id=$1,zernio_account_id=$2,waba_id=$3,phone_number_id=$4,phone_number=$5,display_name=$6,mode=$7,
           api_key_enc=CASE WHEN $8='' THEN api_key_enc ELSE $9 END,
           meta_access_token_enc=CASE WHEN $10='' THEN meta_access_token_enc ELSE $11 END,
           webhook_secret_enc=CASE WHEN $12='' THEN webhook_secret_enc ELSE $13 END,
           metadata_json=$14,updated_at=now(),last_error=''
         WHERE id=$15 RETURNING *`,
        [profileId, zernioAccountId, wabaId, phoneNumberId, phoneNumber, displayName, mode, apiKey, apiKey ? encrypt(apiKey) : '', metaAccessToken, metaAccessToken ? encrypt(metaAccessToken) : '', webhookSecret, webhookSecret ? encrypt(webhookSecret) : '', JSON.stringify(nextMetadata), id]
      );
      row = updated || row;
    } else {
      const token = crypto.randomBytes(32).toString('base64url');
      row = await req.tdb.get(
        `INSERT INTO {s}.whatsapp_connections
          (profile_id,zernio_account_id,waba_id,phone_number_id,phone_number,display_name,mode,status,enabled,api_key_enc,meta_access_token_enc,webhook_secret_enc,webhook_token_enc,webhook_token_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,'pending',0,$8,$9,$10,$11,$12) RETURNING *`,
        [profileId, zernioAccountId, wabaId, phoneNumberId, phoneNumber, displayName, mode, encrypt(apiKey) || '', encrypt(metaAccessToken) || '', encrypt(webhookSecret) || '', encrypt(token), lookupHash(token)]
      );
      await q(
        `INSERT INTO whatsapp_webhook_tokens(token_hash,tenant_slug,connection_id)
         VALUES($1,$2,$3) ON CONFLICT(token_hash) DO NOTHING`,
        [lookupHash(token), req.tenant.slug, row.id]
      );
    }
    let webhookSetup = { registered: false };
    try {
      webhookSetup = await ensureZernioWebhook({ req, t: req.tdb, connection: row });
      if (webhookSetup.connection) row = webhookSetup.connection;
    } catch (error) {
      webhookSetup = { registered: false, reason: clean(error.message, 300) };
      const metadata = safeJson(row.metadata_json, {});
      await req.tdb.run(
        'UPDATE {s}.whatsapp_connections SET metadata_json=$1,last_error=$2,updated_at=now() WHERE id=$3',
        [JSON.stringify({ ...metadata, webhookError: webhookSetup.reason }), webhookSetup.reason, row.id]
      ).catch(() => {});
    }
    res.status(id ? 200 : 201).json({ ok: true, connection: connectionPublic(row, req), webhookSetup });
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
    if (!connection.zernio_account_id) return res.status(400).json({ error: 'Captura el Account ID de Zernio antes de probar' });
    const data = await zernioRequest({ apiKey: decrypt(connection.api_key_enc), path: `/v1/whatsapp/number-info?accountId=${encodeURIComponent(connection.zernio_account_id)}` });
    const updated = await req.tdb.get(`UPDATE {s}.whatsapp_connections SET status='active',enabled=1,last_error='',last_health_check=now(),updated_at=now() WHERE id=$1 RETURNING *`, [connection.id]);
    let webhookSetup = { registered: false };
    try { webhookSetup = await ensureZernioWebhook({ req, t: req.tdb, connection: updated }); } catch (error) { webhookSetup = { registered: false, reason: clean(error.message, 300) }; }
    res.json({ ok: true, connection: connectionPublic(webhookSetup.connection || updated, req), numberInfo: data, webhookSetup });
  } catch (error) {
    await req.tdb.run('UPDATE {s}.whatsapp_connections SET status=\'error\',last_error=$1,last_health_check=now(),updated_at=now() WHERE id=$2', [clean(error.message, 500), Number(req.params.id)]).catch(() => {});
    next(error);
  }
});

router.post('/connections/:id/profile-photo', requireOwner, async (req, res, next) => {
  try {
    const connection = await connectionWithSecret(req.tdb, Number(req.params.id));
    if (connection.mode === 'sandbox') return res.status(400).json({ error: 'El sandbox no tiene un perfil de WhatsApp propio' });
    if (!connection.zernio_account_id) return res.status(400).json({ error: 'Captura el Account ID de Zernio antes de sincronizar la foto' });
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

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const conversation = await req.tdb.get('SELECT id FROM {s}.whatsapp_conversations WHERE id=$1 LIMIT 1', [Number(req.params.id)]);
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });
    const rows = await req.tdb.all('SELECT id,external_message_id,direction,message_type,body,source,status,created_at FROM {s}.whatsapp_messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 300', [conversation.id]);
    res.json(rows);
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
router.whatsappButtonTitle = whatsappButtonTitle;
router.whatsappBankAccountsText = whatsappBankAccountsText;
router.webhookMessage = webhookMessage;
router.whatsappConversationCustomerName = whatsappConversationCustomerName;

module.exports = router;
