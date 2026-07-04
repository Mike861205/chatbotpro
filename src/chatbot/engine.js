// Motor del chatbot: máquina de estados con flujos guiados (botones) para
// tomar pedidos. Si hay OPENAI_API_KEY, responde preguntas libres con IA.
const crypto = require('crypto');
const config = require('../config');
const OpenAI = require('openai');
const { q, getSetting, getSuperAdminSetting } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { emitNewOrder, emitSessionUpdate } = require('../notifications');

let aiConfigCache = { expiresAt: 0, value: null };
const aiClientCache = new Map();
const reverseGeoCache = new Map();
let aiKeyDecryptWarningShown = false;

const SPANISH_STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'por', 'para', 'con', 'sin', 'que',
  'quiero', 'quisiera', 'puedo', 'puedes', 'tienen', 'tienes', 'hay', 'me', 'mi', 'del', 'al',
  'porfavor', 'favor', 'hola', 'buenas', 'gracias', 'menu', 'menú', 'ver', 'pedir', 'pedido',
]);

function normalizeSearchText(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function keywordTokens(raw) {
  return normalizeSearchText(raw)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !SPANISH_STOPWORDS.has(t));
}

function findProductByNaturalInput(products, userInput) {
  const inputNorm = normalizeSearchText(userInput);
  if (!inputNorm || inputNorm.length < 3) return null;

  // Fast path: full product name appears in user text.
  const direct = products.find((p) => {
    const nameNorm = normalizeSearchText(p.name);
    return nameNorm && inputNorm.includes(nameNorm);
  });
  if (direct) return direct;

  const inputTokens = keywordTokens(userInput);
  if (!inputTokens.length) return null;

  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const haystack = `${normalizeSearchText(p.name)} ${normalizeSearchText(p.description)} ${normalizeSearchText(p.category)}`;
    if (!haystack.trim()) continue;

    let score = 0;
    for (const token of inputTokens) {
      if (haystack.includes(token)) score += 1;
    }

    if (score >= 2 && score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  return best;
}

function pushAiHistory(state, role, content) {
  if (!state || !role || !content) return;
  if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
  state.aiHistory.push({ role, content: String(content).slice(0, 500) });
  if (state.aiHistory.length > 8) {
    state.aiHistory = state.aiHistory.slice(-8);
  }
}

function buildAiMenuText(products, maxChars = 4200) {
  if (!Array.isArray(products) || !products.length) return 'Sin productos cargados.';
  const lines = [];
  let used = 0;
  for (const p of products) {
    const line = `- ${p.name} (${p.category || 'General'}): ${money(p.price, 'MXN')}. ${String(p.description || '').trim()}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n') || 'Sin productos cargados.';
}

function normalizeDeliveryToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDeliveryFeeRules(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [zoneNameRaw, feeRaw, aliasesRaw = ''] = line.split('|').map((part) => part.trim());
      const fee = Number(feeRaw);
      if (!zoneNameRaw || !Number.isFinite(fee) || fee < 0) return null;
      const aliases = [zoneNameRaw, ...aliasesRaw.split(',').map((part) => part.trim())]
        .map(normalizeDeliveryToken)
        .filter(Boolean);
      return { zoneName: zoneNameRaw, fee, aliases };
    })
    .filter(Boolean);
}

function parseDeliveryZones(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];

    const normalizePoint = (point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const a = Number(point[0]);
      const b = Number(point[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      // Prefer [lat,lng], fallback from [lng,lat] (GeoJSON)
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
      if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return [b, a];
      return null;
    };

    const extractPoints = (zone) => {
      if (Array.isArray(zone?.points)) return zone.points.map(normalizePoint).filter(Boolean);
      const coordinates = zone?.geometry?.coordinates;
      if (Array.isArray(coordinates) && Array.isArray(coordinates[0]) && Array.isArray(coordinates[0][0])) {
        // GeoJSON polygon format: [ [ [lng, lat], ... ] ]
        return coordinates[0].map(normalizePoint).filter(Boolean);
      }
      return [];
    };

    return parsed
      .map((zone, i) => {
        const props = zone?.properties && typeof zone.properties === 'object' ? zone.properties : zone;
        const points = extractPoints(zone);
        const fee = Number(props?.fee);
        const name = String(props?.name || '').trim();
        if (!name || !Number.isFinite(fee) || fee < 0 || points.length < 3) return null;
        return {
          id: String(props?.id || zone?.id || `zone-${i + 1}`),
          name,
          fee,
          color: String(props?.color || zone?.color || '#0ea5e9'),
          points,
          active: props?.active !== false,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractColonyLabel(reverseGeo) {
  const source = reverseGeo?.address || {};
  return String(
    source.neighbourhood ||
      source.suburb ||
      source.city_district ||
      source.residential ||
      source.quarter ||
      ''
  ).trim();
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1];
    const yi = polygon[i][0];
    const xj = polygon[j][1];
    const yj = polygon[j][0];
    const intersects =
      yi > point[0] !== yj > point[0] &&
      point[1] < ((xj - xi) * (point[0] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

async function reverseGeocodeLocation(lat, lng) {
  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = reverseGeoCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'ChatBotPro/1.0 (delivery-zones)',
          Accept: 'application/json',
        },
        signal: controller.signal,
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    reverseGeoCache.set(cacheKey, { expiresAt: Date.now() + 6 * 60 * 60 * 1000, value: data });
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildLocationCandidates(geo, address, reverseGeo) {
  const source = reverseGeo?.address || {};
  return {
    resolvedLabel: reverseGeo?.display_name || '',
    candidates: [...new Set([
      geo?.label,
      address,
      reverseGeo?.display_name,
      source.neighbourhood,
      source.suburb,
      source.city_district,
      source.residential,
      source.quarter,
      source.hamlet,
      source.village,
      source.town,
      source.city,
      source.municipality,
      source.county,
      source.state,
    ].map(normalizeDeliveryToken).filter(Boolean))],
  };
}

function matchDeliveryFeeRule(rules, candidates) {
  for (const rule of rules) {
    for (const alias of rule.aliases) {
      if (candidates.some((candidate) => candidate.includes(alias))) {
        return { zoneName: rule.zoneName, fee: rule.fee };
      }
    }
  }
  return null;
}

async function resolveDeliveryFee(geo, address, rules, zones = []) {
  if (!Number.isFinite(geo?.lat) || !Number.isFinite(geo?.lng)) {
    return { fee: 0, zoneName: '', branchId: null, branchName: '', resolvedLabel: '' };
  }

  const activeZones = Array.isArray(zones) ? zones.filter((zone) => zone.active && Array.isArray(zone.points) && zone.points.length >= 3) : [];

  // Si hay zonas dibujadas, la resolución es 100% por polígono para evitar latencia innecesaria.
  if (activeZones.length) {
    const zoneMatch = activeZones.find((zone) => pointInPolygon([geo.lat, geo.lng], zone.points));
    const reverseGeo = await reverseGeocodeLocation(geo.lat, geo.lng);
    const colony = extractColonyLabel(reverseGeo);
    const resolvedLabel = colony || reverseGeo?.display_name || (zoneMatch ? zoneMatch.name : '');
    if (zoneMatch) {
      return {
        fee: zoneMatch.fee,
        zoneName: zoneMatch.name,
        branchId: zoneMatch.branchId != null && zoneMatch.branchId !== '' ? Number(zoneMatch.branchId) : null,
        branchName: zoneMatch.branchName || '',
        resolvedLabel,
      };
    }
    return { fee: 0, zoneName: '', branchId: null, branchName: '', resolvedLabel };
  }

  if (!rules.length) {
    return { fee: 0, zoneName: '', branchId: null, branchName: '', resolvedLabel: '' };
  }

  const reverseGeo = await reverseGeocodeLocation(geo.lat, geo.lng);
  const { resolvedLabel, candidates } = buildLocationCandidates(geo, address, reverseGeo);
  const match = matchDeliveryFeeRule(rules, candidates);
  if (!match) return { fee: 0, zoneName: '', branchId: null, branchName: '', resolvedLabel };

  return { fee: match.fee, zoneName: match.zoneName, branchId: null, branchName: '', resolvedLabel };
}

function deliveryZoneServiceLabel(customer) {
  const zoneName = String(customer?.deliveryZoneName || '').trim();
  const branchName = String(customer?.deliveryBranchName || '').trim();
  if (zoneName && branchName) return `${zoneName} · sucursal ${branchName}`;
  return zoneName || branchName;
}

async function getAiRuntimeConfig() {
  const now = Date.now();
  if (aiConfigCache.expiresAt > now && aiConfigCache.value) return aiConfigCache.value;

  const [enabledRaw, modelRaw, baseUrlRaw, keyEncRaw] = await Promise.all([
    getSuperAdminSetting('openai_enabled', ''),
    getSuperAdminSetting('openai_model', ''),
    getSuperAdminSetting('openai_base_url', ''),
    getSuperAdminSetting('openai_api_key_enc', ''),
  ]);

  const keyFromSuperAdmin = decrypt(keyEncRaw || '') || '';
  if (!keyFromSuperAdmin && keyEncRaw && !aiKeyDecryptWarningShown) {
    aiKeyDecryptWarningShown = true;
    console.warn('[openai] Existe una API key cifrada en superadmin_settings, pero no se pudo descifrar. Verifica DATA_ENCRYPTION_KEY del entorno actual.');
  }
  const key = keyFromSuperAdmin || config.OPENAI_API_KEY || '';
  const model = String(modelRaw || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const baseUrl = String(baseUrlRaw || '').trim();
  const enabled =
    enabledRaw === ''
      ? Boolean(key)
      : String(enabledRaw) === '1' && Boolean(key);

  aiConfigCache = {
    expiresAt: now + 60 * 1000,
    value: { enabled, key, model, baseUrl },
  };
  return aiConfigCache.value;
}

function getOpenAiClient(key, baseUrl) {
  const cacheKey = `${key}::${baseUrl || ''}`;
  if (aiClientCache.has(cacheKey)) return aiClientCache.get(cacheKey);
  const client = new OpenAI(baseUrl ? { apiKey: key, baseURL: baseUrl } : { apiKey: key });
  aiClientCache.set(cacheKey, client);
  return client;
}

function money(n, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(n || 0);
}

function paymentMethodLabel(method) {
  return {
    cash: 'Efectivo',
    transfer: 'Transferencia',
    card: 'Tarjeta',
  }[String(method || '')] || 'Sin definir';
}

function enabledPaymentOptions(settings) {
  const options = [];
  if (settings.cash) options.push({ label: '💵 Efectivo', value: 'pay_cash', method: 'cash' });
  if (settings.transfer) options.push({ label: '🏦 Transferencia', value: 'pay_transfer', method: 'transfer' });
  if (settings.card) options.push({ label: '💳 Tarjeta', value: 'pay_card', method: 'card' });
  return options;
}

async function getState(t, sessionId) {
  const row = await t.get('SELECT state FROM {s}.chat_sessions WHERE id = $1', [sessionId]);
  return row ? JSON.parse(row.state) : null;
}

async function saveState(t, sessionId, state) {
  await t.run(
    `INSERT INTO {s}.chat_sessions (id, state, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [sessionId, JSON.stringify(state)]
  );
}

async function activeProducts(t) {
  const rows = await t.all(
    `SELECT p.id, p.name, p.description, p.price::float AS price, p.image, c.name AS category
     FROM {s}.products p LEFT JOIN {s}.categories c ON c.id = p.category_id
     WHERE p.active = 1 ORDER BY c.sort, c.name, p.name`
  );
  return rows.map((p) => ({
    ...p,
    image: String(p.image || '').trim()
      ? (String(p.image).startsWith('/') ? String(p.image) : `/${String(p.image).replace(/^\/+/, '')}`)
      : '',
  }));
}

function cartTotal(cart) {
  return cart.reduce((s, it) => s + it.price * it.qty, 0);
}

function cartSummary(cart, currency) {
  if (!cart.length) return 'Tu carrito está vacío 🛒';
  const lines = cart.map((it) => {
    const modNote = it.modifiersLabel ? `\n  _${it.modifiersLabel}_` : '';
    return `• ${it.qty}x ${it.name}${it.variantName ? ` (${it.variantName})` : ''}${modNote} — ${money(it.price * it.qty, currency)}`;
  });
  return `🛒 *Tu pedido:*\n${lines.join('\n')}\n\n*Total: ${money(cartTotal(cart), currency)}*`;
}

function parseGeoInput(input) {
  const raw = String(input || '').trim();
  if (!raw.toLowerCase().startsWith('geo:')) return null;
  const payload = raw.slice(4);
  const [coordsPart, labelPart] = payload.split('|');
  const [latS, lngS] = String(coordsPart || '').split(',');
  const lat = Number(latS);
  const lng = Number(lngS);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = String(labelPart || '').trim().slice(0, 160);
  return { lat, lng, label };
}

function parseUpsellProductIds(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    }
  } catch {}
  return [...new Set(text.split(',').map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id > 0))];
}

function parseUpsellOffers(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((offer, idx) => {
        const question = String(offer?.question || '').trim();
        const productIds = parseUpsellProductIds(offer?.productIds || []);
        if (!question || !productIds.length) return null;
        return {
          id: String(offer?.id || `upsell_offer_${idx + 1}`),
          question,
          productIds,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeInfoUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(text)) return `https://${text}`;
  return '';
}

function parseChatbotInfoOptions(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const used = new Set();
    return parsed
      .map((item, idx) => {
        const label = String(item?.label || '').trim().slice(0, 42);
        const message = String(item?.message || '').trim().slice(0, 300);
        const url = normalizeInfoUrl(item?.url || '');
        let id = String(item?.id || `info_${idx + 1}`)
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 48);
        if (!id) id = `info_${idx + 1}`;
        while (used.has(id)) id = `${id}_${Math.random().toString(36).slice(2, 5)}`;
        used.add(id);
        if (!label || (!message && !url)) return null;
        return { id, label, message, url };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function locationSummary(customer) {
  const hasCoords = Number.isFinite(customer?.locationLat) && Number.isFinite(customer?.locationLng);
  if (!hasCoords && !customer?.locationResolved) return '';

  const lines = [];
  if (hasCoords) lines.push(`🗺️ Abrir en Maps: ${mapsUrl(customer.locationLat, customer.locationLng)}`);
  if (customer?.locationResolved) lines.push(`🏘️ Referencia Maps: ${customer.locationResolved}`);
  return lines.join('\n');
}

function pricingSummary(state, currency) {
  const subtotal = cartTotal(state.cart);
  const deliveryFee = Number(state.customer?.deliveryFee || 0);
  const deliveryLabel = deliveryZoneServiceLabel(state.customer);
  const orderNote = String(state.customer?.orderNote || '').trim();
  const lines = state.cart.map((it) => {
    const hasVariantInName = it.variantName
      ? String(it.name || '').toLowerCase().includes(String(it.variantName || '').toLowerCase())
      : false;
    const variantLabel = it.variantName && !hasVariantInName ? ` (${it.variantName})` : '';
    const modifiersText = it.modifiersLabel ? `\n  Opciones: ${it.modifiersLabel}` : '';
    return `• ${it.qty}x ${it.name}${variantLabel}${modifiersText} — ${money(it.price * it.qty, currency)}`;
  });
  return [
    '🛒 *Tu pedido:*',
    ...lines,
    '',
    `*Subtotal: ${money(subtotal, currency)}*`,
    ...(deliveryFee > 0 ? [`*Envío${deliveryLabel ? ` (${deliveryLabel})` : ''}: ${money(deliveryFee, currency)}*`] : []),
    `*Total: ${money(subtotal + deliveryFee, currency)}*`,
    ...(orderNote ? [`*🧾 Nota del pedido: ${orderNote}*`] : []),
  ].join('\n');
}

function normalizeWhatsappNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';

  // Si viene en formato internacional con 00...
  digits = digits.replace(/^00+/, '');

  // México con prefijo antiguo 521XXXXXXXXXX -> 52XXXXXXXXXX
  if (digits.length === 13 && digits.startsWith('521')) {
    digits = `52${digits.slice(3)}`;
  }

  // Si solo capturaron 10 dígitos locales, asumimos MX por defecto
  if (digits.length === 10) {
    digits = `52${digits}`;
  }

  if (digits.length < 11 || digits.length > 15) return '';
  return digits;
}

function mainOptions(cart, infoOptions = []) {
  const opts = [{ label: '📋 Ver menú', value: 'menu' }];
  (infoOptions || []).forEach((item) => {
    if (!item?.label || !item?.id) return;
    opts.push({ label: item.label, value: `info_${item.id}` });
  });
  if (cart.length) {
    opts.push({ label: '🛒 Ver carrito', value: 'cart' });
    opts.push({ label: '✅ Sería todo, gracias.', value: 'checkout' });
  }
  return opts;
}

function returningAddressText(profile) {
  const lines = [];
  if (profile.address) lines.push(`📍 Dirección: ${profile.address}`);
  if (Number.isFinite(profile.locationLat) && Number.isFinite(profile.locationLng)) {
    lines.push(`🗺️ Maps: ${mapsUrl(profile.locationLat, profile.locationLng)}`);
  }
  if (profile.locationResolved) lines.push(`🏷️ Referencia Maps: ${profile.locationResolved}`);
  if (profile.reference) lines.push(`📝 Referencia cliente: ${profile.reference}`);
  if (profile.lastDeliveryAt) lines.push(`🕒 Último pedido a domicilio: ${profile.lastDeliveryAt}`);
  return lines.join('\n');
}

async function findReturningCustomerByPhone(t, phoneRaw) {
  const digits = String(phoneRaw || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const phoneHash = lookupHash(digits);
  const row = await t.get(
    `SELECT
       c.id,
       c.name_enc,
       c.phone_enc,
       c.address_enc,
       o.customer_location_lat::float AS location_lat,
       o.customer_location_lng::float AS location_lng,
       o.customer_location_text,
       o.customer_location_resolved,
       o.notes AS customer_reference,
       o.delivery_fee::float AS delivery_fee,
       o.delivery_zone_name,
      o.service_branch_id,
      o.service_branch_name,
       to_char(o.created_at AT TIME ZONE 'America/Mexico_City', 'DD Mon YYYY, HH24:MI') AS last_delivery_at
     FROM {s}.customers c
     JOIN {s}.orders o ON o.customer_id = c.id
     WHERE c.phone_hash = $1
       AND o.delivery = 'domicilio'
     ORDER BY o.id DESC
     LIMIT 1`,
    [phoneHash]
  );
  if (!row) return null;
  const name = decrypt(row.name_enc) || '';
  const phone = decrypt(row.phone_enc) || digits;
  const address = decrypt(row.address_enc) || row.customer_location_text || '';
  return {
    id: Number(row.id),
    name,
    phone,
    address,
    locationLat: Number.isFinite(Number(row.location_lat)) ? Number(row.location_lat) : null,
    locationLng: Number.isFinite(Number(row.location_lng)) ? Number(row.location_lng) : null,
    locationText: row.customer_location_text || '',
    locationResolved: row.customer_location_resolved || '',
    reference: String(row.customer_reference || '').trim(),
    deliveryFee: Number(row.delivery_fee || 0),
    deliveryZoneName: row.delivery_zone_name || '',
    deliveryBranchId: Number.isFinite(Number(row.service_branch_id)) ? Number(row.service_branch_id) : null,
    deliveryBranchName: row.service_branch_name || '',
    lastDeliveryAt: row.last_delivery_at || '',
  };
}

async function showMenu(t, state) {
  const cats = await t.all('SELECT * FROM {s}.categories ORDER BY sort, name');
  const products = await activeProducts(t);
  if (!products.length) {
    return { messages: ['Por ahora no tenemos productos en el menú. ¡Vuelve pronto! 🙏'], options: [] };
  }
  const catsWithProducts = cats.filter((c) => products.some((p) => p.category === c.name));
  if (catsWithProducts.length > 1) {
    state.step = 'choosing_category';
    return {
      messages: ['¿Qué categoría te gustaría ver? 😋'],
      options: catsWithProducts.map((c) => ({ label: c.name, value: `cat_${c.id}` })),
    };
  }
  return showProducts(t, state, null);
}

async function showProducts(t, state, categoryId) {
  let products = await activeProducts(t);
  state.currentCategoryId = Number.isFinite(Number(categoryId)) ? Number(categoryId) : null;
  if (categoryId) {
    const cat = await t.get('SELECT name FROM {s}.categories WHERE id = $1', [categoryId]);
    if (cat) products = products.filter((p) => p.category === cat.name);
  }
  state.step = 'choosing_product';
  const currency = state.currency;
  const qtyById = new Map((state.cart || []).map((it) => [Number(it.id), Number(it.qty || 0)]));
  return {
    messages: ['Elige un producto para agregarlo a tu pedido:'],
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      priceLabel: money(p.price, currency),
      image: p.image,
      qty: qtyById.get(Number(p.id)) || 0,
    })),
    options: [{ label: '⬅️ Volver', value: 'start' }, ...(state.cart.length ? mainOptions(state.cart).slice(1) : [])],
  };
}

// ── Variantes / Modificadores: helpers ──
function addPendingProductToCart(state) {
  const prod = state.pendingProduct;
  if (!prod) return;
  const variantId = state.pendingVariantId || null;
  const variantName = state.pendingVariantName || null;
  let finalPrice = variantId ? (state.pendingVariantPrice ?? prod.price) : prod.price;

  const modifiersDetail = [];
  const modifiersLabelParts = [];
  let modifiersExtra = 0;
  for (const g of (prod.groups || [])) {
    const selIds = state.pendingModifiers[g.id] || [];
    if (!selIds.length) continue;
    const chosenOpts = (g.options || []).filter((o) => selIds.includes(o.id));
    modifiersDetail.push({ groupId: g.id, groupName: g.name, options: chosenOpts.map((o) => ({ id: o.id, name: o.name, extraPrice: Number(o.extra_price) })) });
    modifiersExtra += chosenOpts.reduce((s, o) => s + Number(o.extra_price), 0);
    modifiersLabelParts.push(chosenOpts.map((o) => o.name).join('/'));
  }
  finalPrice += modifiersExtra;
  const modifiersLabel = modifiersLabelParts.join(' · ');
  const displayName = [prod.name, variantName].filter(Boolean).join(' · ');
  const cartKey = `${prod.id}_${variantId || 'base'}_${modifiersLabel}`;

  const existing = state.cart.find((it) => it._cartKey === cartKey);
  const qtyToAdd = Math.max(1, Number(state.pendingAddQty || 1));
  if (existing) {
    existing.qty += qtyToAdd;
  } else {
    state.cart.push({
      id: prod.id,
      name: displayName,
      price: finalPrice,
      qty: qtyToAdd,
      _cartKey: cartKey,
      variantId,
      variantName,
      modifiers: modifiersDetail,
      modifiersLabel,
      modifiersExtraPrice: modifiersExtra,
    });
  }

  state.pendingProduct = null;
  state.pendingVariantId = null;
  state.pendingVariantName = null;
  state.pendingVariantPrice = null;
  state.pendingAddQty = null;
  state.pendingModifiers = {};
  state.pendingModifierGroupIndex = 0;
}

async function loadProductConfig(t, productId) {
  const prod = await t.get('SELECT id, name, price::float AS price FROM {s}.products WHERE id = $1 AND active = 1', [Number(productId)]);
  if (!prod) return null;
  const variants = await t.all(
    'SELECT id, name, price::float AS price FROM {s}.product_variants WHERE product_id = $1 AND active = 1 ORDER BY sort, id',
    [prod.id]
  );
  const groups = await t.all(
    'SELECT id, name, min_selections, max_selections FROM {s}.modifier_groups WHERE product_id = $1 ORDER BY sort, id',
    [prod.id]
  );
  for (const g of groups) {
    g.options = await t.all(
      'SELECT id, name, extra_price::float AS extra_price FROM {s}.modifier_options WHERE group_id = $1 AND active = 1 ORDER BY sort, id',
      [g.id]
    );
  }
  return {
    ...prod,
    variants,
    groups,
    hasVariants: variants.length > 1,
    hasModifiers: groups.length > 0,
  };
}

async function replyNextModifierGroup(state, reply, currency, t, finish, keepMessages = false) {
  const prod = state.pendingProduct;
  if (!prod) { state.step = 'start'; return finish(); }
  const groups = prod.groups || [];
  const gi = state.pendingModifierGroupIndex || 0;
  const group = groups[gi];

  if (!group) {
    addPendingProductToCart(state);
    const summary = cartSummary(state.cart, currency);
    state.step = 'start';
    reply.messages = (keepMessages ? reply.messages : []).concat([
      `✅ Agregado con tus opciones.\n\n${summary}`,
      '¿Deseas agregar más productos o finalizar tu pedido?',
    ]);
    reply.products = null;
    reply.options = [
      { label: '➕ Agregar más productos', value: 'menu' },
      { label: '✅ Sería todo, gracias.', value: 'checkout' },
      { label: '🛒 Ver carrito', value: 'cart' },
    ];
    return finish();
  }

  const sel = state.pendingModifiers[group.id] || [];
  const maxSel = Number(group.max_selections) || 1;
  const minSel = Number(group.min_selections) || 0;
  const reqLabel = group.min_selections > 0 ? ` _(obligatorio, mín ${group.min_selections})_` : ' _(opcional)_';
  const checkedLabel = (o) => sel.includes(o.id) ? '✅ ' : '';
  const optOptions = (group.options || []).map((o) => ({
    label: `${checkedLabel(o)}${o.name}${Number(o.extra_price) > 0 ? ` +${money(o.extra_price, currency)}` : ''}`,
    value: `mod_opt_${o.id}`,
  }));

  const nextLabel = gi < groups.length - 1 ? '➡️ Siguiente grupo' : '✅ Enviar selección';
  optOptions.push({ label: nextLabel, value: 'mod_next' });
  if (sel.length) optOptions.push({ label: '🧹 Limpiar selección', value: 'mod_clear' });
  if (group.min_selections === 0) optOptions.push({ label: '⏭️ Omitir', value: 'mod_skip' });

  const selText = sel.length
    ? `\nSeleccionados: ${(group.options || []).filter((o) => sel.includes(o.id)).map((o) => o.name).join(', ')}`
    : '';
  if (keepMessages) {
    const progress = `(${sel.length}/${maxSel})`;
    if (sel.length < minSel) {
      reply.messages = [`*${group.name}* ${progress}: falta seleccionar ${minSel - sel.length} para continuar.${selText}`];
    } else {
      reply.messages = [`*${group.name}* ${progress}: puedes elegir más o tocar *${nextLabel}*.${selText}`];
    }
  } else {
    reply.messages = [`*${group.name}*${reqLabel} — elige hasta ${maxSel} y después toca *${nextLabel}*.${selText}`];
  }
  reply.options = optOptions;
  return finish();
}

function buildOrderText(businessName, cart, customer, delivery, currency) {
  const subtotal = cartTotal(cart);
  const deliveryFee = Number(customer?.deliveryFee || 0);
  const deliveryLabel = deliveryZoneServiceLabel(customer);
  const orderNote = String(customer?.orderNote || '').trim();
  const lines = [
    `🧾 *Nuevo pedido — ${businessName}*`,
    '',
    ...cart.map((it) => {
      const varLine = it.variantName ? ` (${it.variantName})` : '';
      const modLine = it.modifiersLabel ? `\n  Opciones: ${it.modifiersLabel}` : '';
      return `• ${it.qty}x ${it.name}${varLine}${modLine} — ${money(it.price * it.qty, currency)}`;
    }),
    '',
    `*Subtotal: ${money(subtotal, currency)}*`,
    ...(deliveryFee > 0 ? [`*Envío${deliveryLabel ? ` (${deliveryLabel})` : ''}: ${money(deliveryFee, currency)}*`] : []),
    `*Total: ${money(subtotal + deliveryFee, currency)}*`,
    ...(orderNote ? [`*🧾 Nota del pedido: ${orderNote}*`] : []),
    '',
    `👤 ${customer.name}`,
    `📞 ${customer.phone}`,
    `💳 Pago: ${paymentMethodLabel(customer.paymentMethod)}`,
    delivery === 'domicilio'
      ? `📍 Entrega a domicilio: ${customer.address}`
      : `🏪 Recoger en sucursal${customer.branchName ? `: ${customer.branchName}` : ''}`,
    ...(delivery === 'domicilio' && customer?.deliveryBranchName ? [`🏪 Atiende: Sucursal ${customer.deliveryBranchName}`] : []),
    ...(delivery === 'domicilio' && customer?.reference ? [`📝 Referencia cliente: ${customer.reference}`] : []),
  ];
  const locationDetails = locationSummary(customer);
  if (locationDetails) lines.push(locationDetails);
  return lines.join('\n');
}

async function aiFallback(t, businessName, userText, state) {
  const aiCfg = await getAiRuntimeConfig();
  if (!aiCfg.enabled || !aiCfg.key) return null;
  try {
    const openaiClient = getOpenAiClient(aiCfg.key, aiCfg.baseUrl);
    const products = await activeProducts(t);
    const menuText = buildAiMenuText(products);
    const history = Array.isArray(state?.aiHistory) ? state.aiHistory.slice(-6) : [];
    const completion = await openaiClient.chat.completions.create({
      model: aiCfg.model || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 280,
      messages: [
        {
          role: 'system',
          content: `Eres el asistente de pedidos del restaurante "${businessName}".\n` +
            'Responde SIEMPRE en español claro, breve y coherente con el mensaje del cliente.\n' +
            'No inventes productos ni precios. Si no estás seguro, dilo y sugiere tocar "Ver menú".\n' +
            'Si el cliente quiere comprar, guía a acciones concretas con frases cortas.\n' +
            'No expliques políticas internas ni menciones que eres una IA.\n\n' +
            `Menú disponible:\n${menuText}`,
        },
        ...history,
        { role: 'user', content: userText },
      ],
    });
    return String(completion.choices[0]?.message?.content || '').trim() || null;
  } catch (e) {
    console.error('[openai]', e.message);
    return null;
  }
}

async function handleMessage(t, slug, sessionId, rawInput) {
  const input = String(rawInput || '').trim();
  const businessName = await getSetting(t, 'business_name', slug);
  const currency = await getSetting(t, 'currency', 'MXN');
  const deliveryFeeRules = parseDeliveryFeeRules(await getSetting(t, 'delivery_fee_rules', ''));
  const deliveryZones = parseDeliveryZones(await getSetting(t, 'delivery_zones_geojson', '[]'));
  let whatsapp = normalizeWhatsappNumber(await getSetting(t, 'whatsapp', ''));
  if (!whatsapp) {
    const tenantRow = await q('SELECT phone_enc FROM tenants WHERE slug = $1 LIMIT 1', [slug]);
    const tenantPhone = decrypt(tenantRow.rows[0]?.phone_enc || '');
    whatsapp = normalizeWhatsappNumber(tenantPhone);
  }
  const deliveryEnabled = (await getSetting(t, 'delivery_enabled', '1')) === '1';
  const pickupEnabled = (await getSetting(t, 'pickup_enabled', '1')) === '1';
  const locationEnabled = (await getSetting(t, 'location_enabled', '1')) === '1';
  const chatPaymentDeliverySettings = {
    cash: (await getSetting(t, 'chatbot_payment_delivery_cash', '1')) === '1',
    transfer: (await getSetting(t, 'chatbot_payment_delivery_transfer', '0')) === '1',
    card: (await getSetting(t, 'chatbot_payment_delivery_card', '0')) === '1',
  };
  const chatPaymentPickupSettings = {
    cash: (await getSetting(t, 'chatbot_payment_pickup_cash', '1')) === '1',
    transfer: (await getSetting(t, 'chatbot_payment_pickup_transfer', '0')) === '1',
    card: (await getSetting(t, 'chatbot_payment_pickup_card', '0')) === '1',
  };
  const upsellEnabled = (await getSetting(t, 'chatbot_upsell_enabled', '0')) === '1';
  const legacyUpsellQuestion = String(
    await getSetting(t, 'chatbot_upsell_question', '¿Deseas agregar alguno de estos productos a tu pedido?')
  ).trim() || '¿Deseas agregar alguno de estos productos a tu pedido?';
  const legacyUpsellProductIds = parseUpsellProductIds(await getSetting(t, 'chatbot_upsell_product_ids', '[]'));
  const upsellOffersRaw = parseUpsellOffers(await getSetting(t, 'chatbot_upsell_offers_json', '[]'));
  const chatbotInfoOptions = parseChatbotInfoOptions(await getSetting(t, 'chatbot_extra_options_json', '[]'));
  const upsellOffersConfig = upsellOffersRaw.length
    ? upsellOffersRaw
    : (legacyUpsellProductIds.length
      ? [{ id: 'legacy_offer_1', question: legacyUpsellQuestion, productIds: legacyUpsellProductIds }]
      : []);
  const upsellCatalog = upsellEnabled && upsellOffersConfig.length ? await activeProducts(t) : [];
  const upsellById = new Map(upsellCatalog.map((p) => [Number(p.id), p]));
  const upsellOffers = upsellOffersConfig
    .map((offer) => {
      const products = offer.productIds
        .map((id) => upsellById.get(Number(id)))
        .filter(Boolean);
      if (!products.length) return null;
      return {
        id: String(offer.id),
        question: String(offer.question || legacyUpsellQuestion).trim() || legacyUpsellQuestion,
        products,
      };
    })
    .filter(Boolean);

  let state = (await getState(t, sessionId)) || { step: 'start', cart: [], customer: {}, currency, aiHistory: [] };
  if (!Array.isArray(state.aiHistory)) state.aiHistory = [];
  state.currency = currency;

  const reply = { messages: [], options: [], products: null, cart: null, order: null };
  const lower = input.toLowerCase();

  const finish = async () => {
    await saveState(t, sessionId, state);
    reply.cart = { items: state.cart, total: cartTotal(state.cart), totalLabel: money(cartTotal(state.cart), currency) };
    // Notificar al tenant el estado en vivo de esta sesión
    emitSessionUpdate(slug, {
      sessionId: sessionId.slice(0, 10),
      step: state.step,
      cart: state.cart.map(i => ({ name: i.name, qty: i.qty, price: i.price })),
      cartTotal: cartTotal(state.cart),
      cartTotalLabel: money(cartTotal(state.cart), currency),
      customerName: state.customer?.name || '',
      delivery: state.delivery || '',
      ts: Date.now(),
    });
    return reply;
  };

  const resetUpsellProgress = () => {
    state.upsellDoneOfferIds = [];
    state.upsellCurrentOfferId = '';
  };

  const goToPaymentOrConfirm = () => {
    const chatPaymentOptions = state.delivery === 'recoger'
      ? enabledPaymentOptions(chatPaymentPickupSettings)
      : enabledPaymentOptions(chatPaymentDeliverySettings);
    if (!chatPaymentOptions.length) {
      state.customer.paymentMethod = 'cash';
      state.step = 'confirm';
      reply.messages.push(confirmText(state, businessName, currency));
      reply.options = confirmOptions();
      return;
    }
    state.step = 'ask_payment_method';
    reply.messages.push('¿Cómo pagarás tu pedido?');
    reply.options = chatPaymentOptions.map((opt) => ({ label: opt.label, value: opt.value }));
  };

  const availableUpsellOffer = () => {
    if (!upsellEnabled || !upsellOffers.length) return null;
    const cartIds = new Set((state.cart || []).map((it) => Number(it.id)));
    const doneIds = new Set((state.upsellDoneOfferIds || []).map((id) => String(id)));

    for (const offer of upsellOffers) {
      if (doneIds.has(String(offer.id))) continue;
      const products = (offer.products || []).filter((p) => !cartIds.has(Number(p.id))).slice(0, 6);
      if (!products.length) continue;
      return { id: String(offer.id), question: offer.question, products };
    }
    return null;
  };

  const upsellOptions = (offer) => {
    const opts = (offer?.products || []).map((p) => ({
      label: `➕ ${p.name} (${money(p.price, currency)})`,
      value: `upsell_add|${offer.id}|${p.id}`,
    }));
    opts.push({ label: '➡️ Siguiente ofrecimiento', value: `upsell_next|${offer.id}` });
    opts.push({ label: '✅ Sería todo, gracias.', value: 'upsell_continue' });
    return opts;
  };

  const continueCheckoutFlowCore = () => {
    const hasReturningData =
      Boolean(state.customer?.name) &&
      Boolean(state.customer?.phone) &&
      state.delivery === 'domicilio' &&
      Boolean(state.customer?.address);

    if (hasReturningData) {
      reply.messages = ['Usaré tus datos guardados del último pedido para agilizar ✅'];
      goToPaymentOrConfirm();
      return;
    }

    state.step = 'checkout_identity_choice';
    reply.messages = ['Antes de finalizar, ¿ya habías pedido con nosotros por este chatbot?'];
    reply.options = [
      { label: '🔁 Ya he pedido', value: 'returning_customer' },
      { label: '👤 Soy cliente nuevo', value: 'checkout_new_customer' },
    ];
  };

  const continueCheckoutFlow = () => {
    const offerable = availableUpsellOffer();
    if (offerable) {
      state.step = 'upsell_offer';
      state.upsellCurrentOfferId = offerable.id;
      reply.messages = [offerable.question];
      reply.options = upsellOptions(offerable);
      return;
    }
    continueCheckoutFlowCore();
  };

  const markUpsellOfferDone = (offerId) => {
    if (!offerId) return;
    const done = new Set((state.upsellDoneOfferIds || []).map((id) => String(id)));
    done.add(String(offerId));
    state.upsellDoneOfferIds = [...done];
    if (String(state.upsellCurrentOfferId || '') === String(offerId)) {
      state.upsellCurrentOfferId = '';
    }
  };

  const showPostSendOptions = () => {
    reply.options = [
      { label: '➕ Agregar más', value: 'menu' },
      { label: '✅ Sería todo, gracias.', value: 'checkout' },
      { label: '🛒 Ver carrito', value: 'cart' },
    ];
  };

  const askOrderNoteAfterSend = () => {
    state.step = 'ask_order_note_after_send_choice';
    reply.messages.push('¿Deseas agregar una nota a tu pedido?');
    reply.options = [
      { label: '✅ Sí', value: 'order_note_yes' },
      { label: '❌ No', value: 'order_note_no' },
    ];
  };

  // Comandos globales
  if (!input || lower === 'start' || lower === 'hola' || lower === 'inicio') {
    state.step = 'start';
    state.returningProfile = null;
    state.aiHistory = [];
    resetUpsellProgress();
    reply.messages = [await getSetting(t, 'welcome_message', `¡Hola! Bienvenido a ${businessName} 👋`)];
    reply.options = mainOptions(state.cart, chatbotInfoOptions);
    return finish();
  }
  if (lower.startsWith('info_')) {
    const selectedId = String(lower.slice('info_'.length)).trim();
    const selected = chatbotInfoOptions.find((item) => String(item.id) === selectedId);
    if (!selected) {
      reply.messages = ['Esa opción ya no está disponible.'];
      reply.options = mainOptions(state.cart, chatbotInfoOptions);
      return finish();
    }
    if (selected.message) reply.messages.push(selected.message);
    if (selected.url) reply.messages.push(`🔗 ${selected.url}`);
    reply.options = mainOptions(state.cart, chatbotInfoOptions);
    return finish();
  }
  if (lower === 'returning_customer') {
    if (!deliveryEnabled) {
      reply.messages = ['En este momento el negocio no tiene entregas a domicilio activas, así que no puedo recuperar dirección automática. Puedes pedir normalmente desde el menú.'];
      reply.options = mainOptions(state.cart, chatbotInfoOptions);
      return finish();
    }
    state.step = 'ask_returning_phone';
    reply.messages = ['¡Claro! Si ya has pedido, escribe tu *número de teléfono* para buscar tu última dirección a domicilio 📱'];
    return finish();
  }
  if (lower === 'menu' || lower === 'menú') {
    Object.assign(reply, await showMenu(t, state));
    return finish();
  }
  if (lower === 'cart' || lower === 'carrito') {
    reply.messages = [cartSummary(state.cart, currency)];
    reply.options = state.cart.length
      ? [
          { label: '✅ Sería todo, gracias.', value: 'checkout' },
          { label: '➕ Agregar más', value: 'menu' },
          { label: '🗑️ Vaciar carrito', value: 'clear_cart' },
        ]
      : [{ label: '📋 Ver menú', value: 'menu' }];
    return finish();
  }
  if (lower === 'clear_cart') {
    state.cart = [];
    state.step = 'start';
    resetUpsellProgress();
    reply.messages = ['Listo, vacié tu carrito. ¿Empezamos de nuevo? 😊'];
    reply.options = mainOptions(state.cart, chatbotInfoOptions);
    return finish();
  }

  // Selección de categoría
  if (lower.startsWith('cat_')) {
    Object.assign(reply, await showProducts(t, state, Number(lower.slice(4))));
    return finish();
  }

  // Selección de producto
  if (lower.startsWith('prod_apply_')) {
    const raw = lower.slice('prod_apply_'.length).trim();
    const parts = raw ? raw.split(',').filter(Boolean) : [];
    const parsed = parts
      .map((part) => {
        const [idStr, qtyStr] = part.split('-');
        return { id: Number(idStr), qty: Number(qtyStr) };
      })
      .filter((it) => Number.isFinite(it.id) && Number.isFinite(it.qty) && it.qty >= 0 && it.qty <= 50)
      .map((it) => ({ id: it.id, qty: Math.floor(it.qty) }));

    if (parsed.length) {
      const configurableItems = [];
      for (const item of parsed) {
        if (item.qty <= 0) continue;
        const cfg = await loadProductConfig(t, item.id);
        if (cfg && (cfg.hasVariants || cfg.hasModifiers)) configurableItems.push({ item, cfg });
      }

      if (configurableItems.length > 1) {
        reply.messages = ['Tienes varios productos con configuración (variantes/opciones). Para evitar errores, agrégalos uno por uno tocando el producto en el menú.'];
        reply.options = [
          { label: '📋 Ver menú', value: 'menu' },
          { label: '🛒 Ver carrito', value: 'cart' },
        ];
        return finish();
      }

      if (configurableItems.length === 1 && parsed.length === 1) {
        const { item, cfg } = configurableItems[0];
        state.pendingProduct = { id: cfg.id, name: cfg.name, price: cfg.price, variants: cfg.variants, groups: cfg.groups };
        state.pendingAddQty = Math.max(1, Number(item.qty || 1));
        state.pendingVariantId = null;
        state.pendingModifiers = {};
        state.pendingModifierGroupIndex = 0;
        if (cfg.hasVariants) {
          state.step = 'choosing_variant';
          reply.messages = [`¿Cómo lo quieres? Elige una opción de *${cfg.name}* para ${state.pendingAddQty} unidad(es):`];
          reply.options = cfg.variants.map((v) => ({ label: `${v.name} — ${money(v.price, currency)}`, value: `variant_${v.id}` }));
          return finish();
        }
        state.step = 'choosing_modifiers';
        return replyNextModifierGroup(state, reply, currency, t, finish);
      }

      if (configurableItems.length === 1 && parsed.length > 1) {
        reply.messages = ['Incluiste un producto con variantes/opciones junto con otros productos. Primero configura ese producto por separado, luego confirma los demás.'];
        reply.options = [
          { label: '📋 Ver menú', value: 'menu' },
          { label: '🛒 Ver carrito', value: 'cart' },
        ];
        return finish();
      }

      const lines = [];
      for (const item of parsed) {
        const prod = await t.get('SELECT id, name, price::float AS price FROM {s}.products WHERE id = $1 AND active = 1', [item.id]);
        if (!prod) continue;

        const existing = state.cart.find((it) => it.id === prod.id);
        if (item.qty <= 0) {
          state.cart = state.cart.filter((it) => it.id !== prod.id);
          lines.push(`• Quitado: *${prod.name}*`);
        } else {
          if (existing) existing.qty = item.qty;
          else state.cart.push({ id: prod.id, name: prod.name, price: prod.price, qty: item.qty });
          lines.push(`• *${item.qty}x ${prod.name}* = *${money(item.qty * Number(prod.price || 0), currency)}*`);
        }
      }

      resetUpsellProgress();

      state.step = 'start';
      const summary = cartSummary(state.cart, currency);
      reply.messages = [
        lines.length
          ? `✅ Cantidades confirmadas al checkout:\n${lines.join('\n')}`
          : 'No se pudo aplicar la selección.',
        summary,
      ];
      askOrderNoteAfterSend();
      return finish();
    }
  }

  if (lower.startsWith('prod_set_')) {
    const parts = lower.split('_');
    const id = Number(parts[2]);
    const qty = Number(parts[3]);
    if (Number.isFinite(id) && Number.isFinite(qty) && qty >= 0 && qty <= 50) {
      const cfg = await loadProductConfig(t, id);
      const prod = cfg;
      if (prod) {
        if ((cfg.hasVariants || cfg.hasModifiers) && Math.floor(qty) > 0) {
          state.pendingProduct = { id: cfg.id, name: cfg.name, price: cfg.price, variants: cfg.variants, groups: cfg.groups };
          state.pendingAddQty = Math.floor(qty);
          state.pendingVariantId = null;
          state.pendingModifiers = {};
          state.pendingModifierGroupIndex = 0;
          if (cfg.hasVariants) {
            state.step = 'choosing_variant';
            reply.messages = [`¿Cómo lo quieres? Elige una opción de *${cfg.name}* para ${state.pendingAddQty} unidad(es):`];
            reply.options = cfg.variants.map((v) => ({ label: `${v.name} — ${money(v.price, currency)}`, value: `variant_${v.id}` }));
            return finish();
          }
          state.step = 'choosing_modifiers';
          return replyNextModifierGroup(state, reply, currency, t, finish);
        }

        const existing = state.cart.find((it) => it.id === prod.id);
        const finalQty = Math.floor(qty);
        if (finalQty <= 0) {
          state.cart = state.cart.filter((it) => it.id !== prod.id);
        } else if (existing) {
          existing.qty = finalQty;
        } else {
          state.cart.push({ id: prod.id, name: prod.name, price: prod.price, qty: finalQty });
        }

        resetUpsellProgress();

        state.step = 'start';
        const lineTotal = money(finalQty * Number(prod.price || 0), currency);
        if (finalQty <= 0) {
          reply.messages = [`🗑️ Quité *${prod.name}* de tu pedido.`, cartSummary(state.cart, currency)];
          showPostSendOptions();
        } else {
          reply.messages = [`✅ Agregado al checkout: *${finalQty}x ${prod.name}* = *${lineTotal}*.`, cartSummary(state.cart, currency)];
          askOrderNoteAfterSend();
        }
        return finish();
      }
    }
  }

  if (state.step === 'ask_order_note_after_send_choice') {
    if (lower === 'order_note_yes') {
      state.step = 'ask_order_note_after_send_text';
      reply.messages = ['Perfecto, escribe tus instrucciones para tu pedido (ej: hamburguesa sin cebolla).'];
      reply.options = [{ label: 'Omitir nota', value: 'order_note_skip' }];
      return finish();
    }
    if (lower === 'order_note_no') {
      state.customer.orderNote = '';
      continueCheckoutFlow();
      return finish();
    }
    reply.messages = ['Elige una opción para continuar:'];
    reply.options = [
      { label: '✅ Sí', value: 'order_note_yes' },
      { label: '❌ No', value: 'order_note_no' },
    ];
    return finish();
  }

  if (state.step === 'ask_order_note_after_send_text') {
    if (lower === 'order_note_skip') {
      state.customer.orderNote = '';
      state.step = 'start';
      reply.messages = ['Listo, continuamos sin nota.'];
      showPostSendOptions();
      return finish();
    }

    const note = String(input || '').trim();
    if (note.length < 3) {
      reply.messages = ['Escribe una instrucción más clara o toca "Omitir nota".'];
      reply.options = [{ label: 'Omitir nota', value: 'order_note_skip' }];
      return finish();
    }

    state.customer.orderNote = note.slice(0, 220);
    state.step = 'start';
    reply.messages = [`✅ Nota agregada: ${state.customer.orderNote}`, cartSummary(state.cart, currency)];
    showPostSendOptions();
    return finish();
  }

  if (lower.startsWith('prod_dec_')) {
    const id = Number(lower.slice('prod_dec_'.length));
    if (Number.isFinite(id)) {
      const existing = state.cart.find((it) => it.id === id);
      if (existing) {
        existing.qty -= 1;
        if (existing.qty <= 0) {
          state.cart = state.cart.filter((it) => it.id !== id);
        }
      }
      resetUpsellProgress();
      state.step = 'choosing_product';
      Object.assign(reply, await showProducts(t, state, state.currentCategoryId));
      return finish();
    }
  }

  if (lower.startsWith('prod_')) {
    const prod = await loadProductConfig(t, Number(lower.slice(5)));
    if (prod) {
      const hasVariants = prod.hasVariants;
      const hasModifiers = prod.hasModifiers;

      if (hasVariants || hasModifiers) {
        state.pendingProduct = { id: prod.id, name: prod.name, price: prod.price, variants: prod.variants, groups: prod.groups };
        state.pendingAddQty = 1;
        state.pendingVariantId = null;
        state.pendingModifiers = {}; // { groupId: [optId, ...] }
        state.pendingModifierGroupIndex = 0;

        if (hasVariants) {
          state.step = 'choosing_variant';
          const varOptions = prod.variants.map((v) => ({ label: `${v.name} — ${money(v.price, currency)}`, value: `variant_${v.id}` }));
          reply.messages = [`¿Cómo lo quieres? Elige una opción de *${prod.name}*:`];
          reply.options = varOptions;
          return finish();
        }
        // No variants, go straight to modifiers
        state.step = 'choosing_modifiers';
        return replyNextModifierGroup(state, reply, currency, t, finish);
      }

      const existing = state.cart.find((it) => it.id === prod.id && !it._cartKey);
      if (existing) existing.qty += 1;
      else state.cart.push({ id: prod.id, name: prod.name, price: prod.price, qty: 1 });
      resetUpsellProgress();

      state.step = 'choosing_product';
      const menuReply = await showProducts(t, state, state.currentCategoryId);
      const currentQty = state.cart.find((it) => it.id === prod.id && !it._cartKey)?.qty || 0;
      reply.messages = [`✅ Llevas *${currentQty}x ${prod.name}* en tu pedido.`, ...menuReply.messages];
      reply.products = menuReply.products;
      reply.options = menuReply.options;
      return finish();
    }
  }

  // Elegir variante
  if (state.step === 'choosing_variant' && lower.startsWith('variant_')) {
    const variantId = Number(lower.slice('variant_'.length));
    const prod = state.pendingProduct;
    if (prod) {
      const variant = prod.variants.find((v) => v.id === variantId);
      if (variant) {
        state.pendingVariantId = variantId;
        state.pendingVariantName = variant.name;
        state.pendingVariantPrice = variant.price;
        if (prod.groups && prod.groups.length > 0) {
          state.pendingModifierGroupIndex = 0;
          state.step = 'choosing_modifiers';
          return replyNextModifierGroup(state, reply, currency, t, finish);
        }
        // No modifiers — add to cart
        addPendingProductToCart(state);
        const summary = cartSummary(state.cart, currency);
        state.step = 'start';
        reply.messages = [
          `✅ Agregado: *${state.cart[state.cart.length - 1]?.name || prod.name}*.\n\n${summary}`,
          '¿Deseas agregar más productos o finalizar tu pedido?',
        ];
        reply.products = null;
        reply.options = [
          { label: '➕ Agregar más productos', value: 'menu' },
          { label: '✅ Sería todo, gracias.', value: 'checkout' },
          { label: '🛒 Ver carrito', value: 'cart' },
        ];
        return finish();
      }
    }
    reply.messages = ['Por favor elige una de las opciones disponibles.'];
    return finish();
  }

  // Elegir modificadores
  if (state.step === 'choosing_modifiers') {
    const prod = state.pendingProduct;
    if (!prod) {
      state.step = 'start';
      return finish();
    }
    const groups = prod.groups || [];
    const gi = state.pendingModifierGroupIndex || 0;
    const group = groups[gi];
    if (!group) {
      // All groups done, add to cart
      addPendingProductToCart(state);
      const summary = cartSummary(state.cart, currency);
      state.step = 'start';
      reply.messages = [
        `✅ Agregado con tus opciones.\n\n${summary}`,
        '¿Deseas agregar más productos o finalizar tu pedido?',
      ];
      reply.products = null;
      reply.options = [
        { label: '➕ Agregar más productos', value: 'menu' },
        { label: '✅ Sería todo, gracias.', value: 'checkout' },
        { label: '🛒 Ver carrito', value: 'cart' },
      ];
      return finish();
    }

    if (lower.startsWith('mod_opt_')) {
      const optId = Number(lower.slice('mod_opt_'.length));
      if (!state.pendingModifiers[group.id]) state.pendingModifiers[group.id] = [];
      const sel = state.pendingModifiers[group.id];
      const idx = sel.indexOf(optId);
      const max = Number(group.max_selections) || 1;
      if (idx >= 0) {
        sel.splice(idx, 1); // toggle off
      } else if (max === 1) {
        state.pendingModifiers[group.id] = [optId];
      } else if (sel.length < max) {
        sel.push(optId);
      } else {
        reply.messages = [`Ya llegaste al máximo (${max}) en *${group.name}*. Desmarca una opción o confirma.`];
        return replyNextModifierGroup(state, reply, currency, t, finish, true);
      }
      return replyNextModifierGroup(state, reply, currency, t, finish, true);
    }

    if (lower === 'mod_clear') {
      state.pendingModifiers[group.id] = [];
      reply.messages = [`Limpié tu selección en *${group.name}*.`];
      return replyNextModifierGroup(state, reply, currency, t, finish, true);
    }

    if (lower === 'mod_next') {
      const sel = state.pendingModifiers[group.id] || [];
      if (group.min_selections > 0 && sel.length < group.min_selections) {
        reply.messages = [`Por favor selecciona al menos ${group.min_selections} opción de *${group.name}*.`];
        return replyNextModifierGroup(state, reply, currency, t, finish, true);
      }
      state.pendingModifierGroupIndex = gi + 1;
      return replyNextModifierGroup(state, reply, currency, t, finish);
    }

    if (lower === 'mod_skip') {
      if (group.min_selections > 0) {
        reply.messages = [`La sección *${group.name}* es obligatoria. Por favor elige al menos una opción.`];
        return replyNextModifierGroup(state, reply, currency, t, finish, true);
      }
      state.pendingModifierGroupIndex = gi + 1;
      return replyNextModifierGroup(state, reply, currency, t, finish);
    }
  }

  // Cantidad
  if (state.step === 'awaiting_qty') {
    const qty = lower.startsWith('qty_') ? Number(lower.slice(4)) : parseInt(input, 10);
    if (qty > 0 && qty <= 50 && state.pendingProduct) {
      const existing = state.cart.find((it) => it.id === state.pendingProduct.id);
      if (existing) existing.qty += qty;
      else state.cart.push({ ...state.pendingProduct, qty });
      resetUpsellProgress();
      const name = state.pendingProduct.name;
      state.pendingProduct = null;
      state.step = 'start';
      reply.messages = [`¡Agregado! ${qty}x *${name}* 🎉\n\n${cartSummary(state.cart, currency)}`];
      reply.options = [
        { label: '➕ Agregar más', value: 'menu' },
        { label: '✅ Sería todo, gracias.', value: 'checkout' },
      ];
      return finish();
    }
    reply.messages = ['Puedes tocar el botón + del producto para agregar más unidades, o elegir "➕ Agregar más".'];
    reply.options = [
      { label: '➕ Agregar más', value: 'menu' },
      { label: '✅ Sería todo, gracias.', value: 'checkout' },
    ];
    return finish();
  }

  if (state.step === 'ask_returning_phone') {
    const profile = await findReturningCustomerByPhone(t, input);
    if (!profile) {
      reply.messages = ['No encontré un pedido a domicilio previo con ese teléfono. Verifica el número o continúa como pedido nuevo.'];
      reply.options = [
        { label: '🔁 Intentar de nuevo', value: 'returning_customer' },
        { label: '📋 Ver menú', value: 'menu' },
      ];
      state.step = 'start';
      return finish();
    }

    state.returningProfile = profile;
    state.step = 'confirm_returning_address';
    reply.messages = [
      `Encontré tu último pedido, *${profile.name || 'cliente'}* 🙌`,
      `${returningAddressText(profile)}\n\n¿Esta es tu dirección para este nuevo pedido?`,
    ];
    reply.options = [
      { label: '✅ Sí, usar esta dirección', value: 'returning_address_yes' },
      { label: '✏️ No, capturar nueva', value: 'returning_address_no' },
      { label: '🏪 Usar para recoger en sucursal', value: 'returning_address_pickup' },
    ];
    return finish();
  }

  if (state.step === 'confirm_returning_address') {
    if (lower === 'returning_address_yes') {
      const p = state.returningProfile || {};
      state.customer.name = p.name || state.customer.name || '';
      state.customer.phone = String(p.phone || '').replace(/\D/g, '') || state.customer.phone || '';
      state.customer.address = p.address || p.locationText || '';
      state.customer.locationLat = p.locationLat;
      state.customer.locationLng = p.locationLng;
      state.customer.locationText = p.locationText || '';
      state.customer.locationResolved = p.locationResolved || '';
      state.customer.deliveryFee = Number(p.deliveryFee || 0);
      state.customer.deliveryZoneName = p.deliveryZoneName || '';
      state.customer.deliveryBranchId = Number.isFinite(Number(p.deliveryBranchId)) ? Number(p.deliveryBranchId) : null;
      state.customer.deliveryBranchName = p.deliveryBranchName || '';
      state.customer.reference = p.reference || '';
      state.delivery = 'domicilio';
      if (state.cart.length) {
        reply.messages = ['¡Perfecto! Ya usaré tus mismos datos de ubicación para este pedido 🚀'];
        goToPaymentOrConfirm();
      } else {
        state.step = 'start';
        const quickMessages = ['¡Perfecto! Ya usaré tus mismos datos de ubicación para este pedido 🚀', 'Ahora solo elige del menú y será más rápido.'];
        const menuReply = await showMenu(t, state);
        Object.assign(reply, menuReply);
        reply.messages = [...quickMessages, ...(menuReply.messages || [])];
      }
      return finish();
    }

    if (lower === 'returning_address_no') {
      state.returningProfile = null;
      state.step = 'ask_name';
      reply.messages = ['Sin problema. Vamos a registrar tus datos para este pedido. ¿Cuál es tu *nombre*?'];
      return finish();
    }

    if (lower === 'returning_address_pickup') {
      if (!pickupEnabled) {
        reply.messages = ['En este momento solo está activa la entrega a domicilio. ¿Deseas usar la dirección guardada?'];
        reply.options = [
          { label: '✅ Sí, usar esta dirección', value: 'returning_address_yes' },
          { label: '✏️ No, capturar nueva', value: 'returning_address_no' },
        ];
        return finish();
      }

      const p = state.returningProfile || {};
      state.customer.name = p.name || state.customer.name || '';
      state.customer.phone = String(p.phone || '').replace(/\D/g, '') || state.customer.phone || '';
      state.delivery = 'recoger';
      state.customer.address = '';
      state.customer.locationLat = null;
      state.customer.locationLng = null;
      state.customer.locationText = '';
      state.customer.locationResolved = '';
      state.customer.deliveryFee = 0;
      state.customer.deliveryZoneName = '';
      state.customer.deliveryBranchId = null;
      state.customer.deliveryBranchName = '';
      state.customer.reference = '';

      const branches = await t.all('SELECT id, name, address, reference FROM {s}.branches WHERE active = 1 ORDER BY name');
      if (branches.length) {
        state.step = 'ask_branch';
        state.branchOptions = branches;
        reply.messages = ['Perfecto, usaremos tus datos y ahora elige la sucursal para recoger 🏪'];
        reply.options = branches.map((b) => ({ label: `🏪 ${b.name}`, value: `branch_${b.id}` }));
        return finish();
      }

      state.step = locationEnabled ? 'ask_location_optional' : 'confirm';
      if (locationEnabled) {
        reply.messages = ['Perfecto, no hay sucursales configuradas. ¿Quieres compartir tu ubicación para ubicarte más fácil? (Opcional)'];
        reply.options = [
          { label: '📍 Compartir ubicación', value: 'share_location' },
          { label: 'Omitir', value: 'skip_location' },
        ];
      } else {
        goToPaymentOrConfirm();
      }
      return finish();
    }

    reply.messages = ['Confírmame si usarás la misma dirección del último pedido:'];
    reply.options = [
      { label: '✅ Sí, usar esta dirección', value: 'returning_address_yes' },
      { label: '✏️ No, capturar nueva', value: 'returning_address_no' },
      { label: '🏪 Usar para recoger en sucursal', value: 'returning_address_pickup' },
    ];
    return finish();
  }

  // Checkout
  if (lower === 'checkout') {
    if (!state.cart.length) {
      reply.messages = ['Tu carrito está vacío. ¡Mira nuestro menú! 😊'];
      reply.options = [{ label: '📋 Ver menú', value: 'menu' }];
      return finish();
    }

    if (String(state.customer.orderNote || '').trim()) {
      continueCheckoutFlow();
      return finish();
    }

    state.step = 'ask_order_note_choice';
    reply.messages = ['¿Deseas agregar una nota a tu pedido? (Ej: hamburguesa sin cebolla)'];
    reply.options = [
      { label: '✅ Sí, agregar nota', value: 'order_note_yes' },
      { label: '❌ No, continuar', value: 'order_note_no' },
    ];
    return finish();
  }

  if (state.step === 'ask_order_note_choice') {
    if (lower === 'order_note_yes') {
      state.step = 'ask_order_note_text';
      reply.messages = ['Perfecto. Escribe tus instrucciones para el pedido 📝'];
      reply.options = [{ label: 'Omitir nota', value: 'order_note_skip' }];
      return finish();
    }
    if (lower === 'order_note_no') {
      state.customer.orderNote = '';
      continueCheckoutFlow();
      return finish();
    }
    reply.messages = ['Elige una opción para continuar:'];
    reply.options = [
      { label: '✅ Sí, agregar nota', value: 'order_note_yes' },
      { label: '❌ No, continuar', value: 'order_note_no' },
    ];
    return finish();
  }

  if (state.step === 'ask_order_note_text') {
    if (lower === 'order_note_skip') {
      state.customer.orderNote = '';
      continueCheckoutFlow();
      return finish();
    }

    const note = String(input || '').trim();
    if (note.length < 3) {
      reply.messages = ['Escribe una nota un poco más clara o toca "Omitir nota".'];
      reply.options = [{ label: 'Omitir nota', value: 'order_note_skip' }];
      return finish();
    }

    state.customer.orderNote = note.slice(0, 220);
    continueCheckoutFlow();
    return finish();
  }

  if (state.step === 'upsell_offer') {
    if (lower === 'upsell_continue') {
      state.upsellDoneOfferIds = upsellOffers.map((offer) => String(offer.id));
      state.upsellCurrentOfferId = '';
      continueCheckoutFlowCore();
      return finish();
    }

    if (lower.startsWith('upsell_next|')) {
      const offerId = String(lower.split('|')[1] || '').trim();
      markUpsellOfferDone(offerId);
      continueCheckoutFlow();
      return finish();
    }

    if (lower.startsWith('upsell_add|')) {
      const parts = lower.split('|');
      const offerId = String(parts[1] || '').trim();
      const productId = Number(parts[2]);
      const offer = upsellOffers.find((item) => String(item.id) === offerId);
      const product = offer?.products?.find((item) => Number(item.id) === productId);
      if (!offer || !product) {
        const fallback = availableUpsellOffer();
        reply.messages = ['Ese ofrecimiento ya no está disponible, intenta con otra opción.'];
        if (fallback) reply.options = upsellOptions(fallback);
        else reply.options = [{ label: '✅ Sería todo, gracias.', value: 'upsell_continue' }];
        return finish();
      }

      const existing = state.cart.find((item) => Number(item.id) === Number(product.id));
      if (existing) existing.qty += 1;
      else state.cart.push({ id: product.id, name: product.name, price: product.price, qty: 1 });

      markUpsellOfferDone(offerId);
      reply.messages = [
        `✅ Excelente elección: agregué *${product.name}* a tu pedido.`,
        cartSummary(state.cart, currency),
      ];
      const nextOffer = availableUpsellOffer();
      if (nextOffer) {
        state.step = 'upsell_offer';
        state.upsellCurrentOfferId = nextOffer.id;
        reply.messages.push(nextOffer.question);
        reply.options = upsellOptions(nextOffer);
      } else {
        continueCheckoutFlowCore();
      }
      return finish();
    }

    const offerables = availableUpsellOffer();
    reply.messages = ['Elige una opción para continuar:'];
    reply.options = offerables ? upsellOptions(offerables) : [{ label: '✅ Sería todo, gracias.', value: 'upsell_continue' }];
    return finish();
  }

  if (state.step === 'checkout_identity_choice') {
    if (lower === 'returning_customer') {
      if (!deliveryEnabled) {
        state.step = 'ask_name';
        reply.messages = ['En este momento solo está activo el flujo normal. ¿Cuál es tu *nombre*?'];
        return finish();
      }
      state.step = 'ask_returning_phone';
      reply.messages = ['¡Claro! Si ya has pedido, escribe tu *número de teléfono* para recuperar tus datos 📱'];
      return finish();
    }
    if (lower === 'checkout_new_customer') {
      state.step = 'ask_name';
      reply.messages = ['¡Perfecto! Para completar tu pedido, ¿cuál es tu *nombre*?'];
      return finish();
    }
    reply.messages = ['Elige una opción para continuar:'];
    reply.options = [
      { label: '🔁 Ya he pedido', value: 'returning_customer' },
      { label: '👤 Soy cliente nuevo', value: 'checkout_new_customer' },
    ];
    return finish();
  }

  if (state.step === 'ask_name') {
    if (input.length < 2) {
      reply.messages = ['¿Me compartes tu nombre, por favor?'];
      return finish();
    }
    state.customer.name = input.slice(0, 80);
    state.step = 'ask_phone';
    reply.messages = [`Gracias, ${state.customer.name} 🙌 ¿Cuál es tu *número de teléfono* (10 dígitos)?`];
    return finish();
  }

  if (state.step === 'ask_phone') {
    const digits = input.replace(/\D/g, '');
    if (digits.length < 10) {
      reply.messages = ['Ese número no parece válido. Escríbelo con 10 dígitos, por favor 📞'];
      return finish();
    }
    state.customer.phone = digits;
    if (deliveryEnabled && pickupEnabled) {
      state.step = 'ask_delivery';
      reply.messages = ['¿Cómo quieres recibir tu pedido?'];
      reply.options = [
        { label: '🛵 A domicilio', value: 'delivery_domicilio' },
        { label: '🏪 Recoger en sucursal', value: 'delivery_recoger' },
      ];
    } else if (deliveryEnabled) {
      state.delivery = 'domicilio';
      state.step = 'ask_address';
      reply.messages = ['¿Cuál es tu *dirección* de entrega? 📍'];
      if (locationEnabled) reply.options = [{ label: '📍 Compartir ubicación', value: 'share_location' }];
    } else {
      state.delivery = 'recoger';
      const branches = await t.all('SELECT id, name, address, reference FROM {s}.branches WHERE active = 1 ORDER BY name');
      if (branches.length) {
        state.step = 'ask_branch';
        state.branchOptions = branches;
        reply.messages = ['¿En qué sucursal pasarás a recoger tu pedido?'];
        reply.options = branches.map((b) => ({ label: `🏪 ${b.name}`, value: `branch_${b.id}` }));
      } else {
        state.step = locationEnabled ? 'ask_location_optional' : 'confirm';
        if (locationEnabled) {
          reply.messages = ['¿Quieres compartir tu ubicación para ubicarte más fácil? (Opcional)'];
          reply.options = [
            { label: '📍 Compartir ubicación', value: 'share_location' },
            { label: 'Omitir', value: 'skip_location' },
          ];
        } else {
          goToPaymentOrConfirm();
        }
      }
    }
    return finish();
  }

  if (state.step === 'ask_delivery') {
    if (lower === 'delivery_domicilio') {
      state.delivery = 'domicilio';
      state.step = 'ask_address';
      reply.messages = ['¿Cuál es tu *dirección* de entrega? 📍'];
      if (locationEnabled) reply.options = [{ label: '📍 Compartir ubicación', value: 'share_location' }];
      return finish();
    }
    if (lower === 'delivery_recoger') {
      state.delivery = 'recoger';
      const branches = await t.all('SELECT id, name, address, reference FROM {s}.branches WHERE active = 1 ORDER BY name');
      if (branches.length) {
        state.step = 'ask_branch';
        state.branchOptions = branches;
        reply.messages = ['¿En qué sucursal pasarás a recoger tu pedido?'];
        reply.options = branches.map((b) => ({ label: `🏪 ${b.name}`, value: `branch_${b.id}` }));
      } else {
        state.step = locationEnabled ? 'ask_location_optional' : 'confirm';
        if (locationEnabled) {
          reply.messages = ['¿Quieres compartir tu ubicación para ubicarte más fácil? (Opcional)'];
          reply.options = [
            { label: '📍 Compartir ubicación', value: 'share_location' },
            { label: 'Omitir', value: 'skip_location' },
          ];
        } else {
          goToPaymentOrConfirm();
        }
      }
      return finish();
    }
    reply.messages = ['Elige una opción, por favor:'];
    reply.options = [
      { label: '🛵 A domicilio', value: 'delivery_domicilio' },
      { label: '🏪 Recoger en sucursal', value: 'delivery_recoger' },
    ];
    return finish();
  }

  if (state.step === 'ask_branch') {
    if (lower.startsWith('branch_')) {
      const branchId = Number(lower.slice(7));
      const chosen = (state.branchOptions || []).find((b) => Number(b.id) === branchId);
      if (!chosen) {
        reply.messages = ['Selecciona una sucursal válida, por favor.'];
        reply.options = (state.branchOptions || []).map((b) => ({ label: `🏪 ${b.name}`, value: `branch_${b.id}` }));
        return finish();
      }
      state.customer.branchId = chosen.id;
      state.customer.branchName = chosen.name;
      state.customer.branchAddress = chosen.address;
      state.customer.branchReference = chosen.reference;
      reply.messages = [
        `Perfecto, recogerás en *${chosen.name}* ✅\n${chosen.address}${chosen.reference ? `\nReferencia: ${chosen.reference}` : ''}`,
      ];
      goToPaymentOrConfirm();
      return finish();
    }
    reply.messages = ['Elige una sucursal para continuar:'];
    reply.options = (state.branchOptions || []).map((b) => ({ label: `🏪 ${b.name}`, value: `branch_${b.id}` }));
    return finish();
  }

  if (state.step === 'ask_address') {
    if (lower === 'share_location') {
      reply.messages = ['Activa la ubicación en tu celular para compartirla 📍'];
      reply.options = [{ label: '📍 Compartir ubicación', value: 'share_location' }];
      return finish();
    }
    if (lower === 'location_error') {
      reply.messages = [
        'No pude obtener tu ubicación automáticamente. Activa el permiso del navegador o escribe tu dirección/coordenadas para continuar.',
      ];
      reply.options = locationEnabled
        ? [
            { label: '📍 Compartir ubicación', value: 'share_location' },
            { label: 'Omitir', value: 'skip_location' },
          ]
        : [];
      return finish();
    }

    const geo = parseGeoInput(input);
    if (geo) {
      state.customer.locationLat = geo.lat;
      state.customer.locationLng = geo.lng;
      state.customer.locationText = geo.label || `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`;
      if (!state.customer.address) state.customer.address = state.customer.locationText;
      if (state.delivery === 'domicilio') {
        const feeInfo = await resolveDeliveryFee(geo, state.customer.address, deliveryFeeRules, deliveryZones);
        state.customer.deliveryFee = feeInfo.fee;
        state.customer.deliveryZoneName = feeInfo.zoneName;
        state.customer.deliveryBranchId = Number.isFinite(Number(feeInfo.branchId)) ? Number(feeInfo.branchId) : null;
        state.customer.deliveryBranchName = feeInfo.branchName || '';
        state.customer.locationResolved = feeInfo.resolvedLabel;
      }
      state.step = 'ask_reference';
      reply.messages = [
        `🗺️ Ubicación recibida. Abrir en Maps: ${mapsUrl(geo.lat, geo.lng)}${Number(state.customer.deliveryFee || 0) > 0 ? `\n🛵 Envío detectado: ${money(state.customer.deliveryFee, currency)}${state.customer.deliveryZoneName ? ` (${state.customer.deliveryZoneName})` : ''}` : ''}`,
        '¿Alguna referencia de tu domicilio? (ejemplo: portón negro, casa esquina).',
      ];
      reply.options = [{ label: 'Omitir referencia', value: 'skip_reference' }];
      return finish();
    }

    if (input.length < 5) {
      reply.messages = ['Necesito una dirección un poco más completa 🙏'];
      if (locationEnabled) reply.options = [{ label: '📍 Compartir ubicación', value: 'share_location' }];
      return finish();
    }
    state.customer.address = input.slice(0, 200);
    if (locationEnabled) {
      state.step = 'ask_location_optional';
      reply.messages = ['¿Quieres compartir también tu ubicación exacta? (Opcional)'];
      reply.options = [
        { label: '📍 Compartir ubicación', value: 'share_location' },
        { label: 'Omitir', value: 'skip_location' },
      ];
    } else {
      state.step = 'ask_reference';
      reply.messages = ['¿Alguna referencia de tu domicilio? (ejemplo: portón negro, casa esquina).'];
      reply.options = [{ label: 'Omitir referencia', value: 'skip_reference' }];
    }
    return finish();
  }

  if (state.step === 'ask_location_optional') {
    if (lower === 'skip_location') {
      if (state.delivery === 'domicilio') {
        state.step = 'ask_reference';
        reply.messages = ['¿Alguna referencia de tu domicilio? (ejemplo: portón negro, casa esquina).'];
        reply.options = [{ label: 'Omitir referencia', value: 'skip_reference' }];
      } else {
        goToPaymentOrConfirm();
      }
      return finish();
    }
    if (lower === 'location_error') {
      reply.messages = [
        'No pude obtener tu ubicación automáticamente. Activa el permiso del navegador o escribe tu dirección/coordenadas para continuar.',
      ];
      reply.options = [
        { label: '📍 Compartir ubicación', value: 'share_location' },
        { label: 'Omitir', value: 'skip_location' },
      ];
      return finish();
    }
    if (lower === 'share_location') {
      reply.messages = ['Activa la ubicación en tu celular para compartirla 📍'];
      reply.options = [
        { label: '📍 Compartir ubicación', value: 'share_location' },
        { label: 'Omitir', value: 'skip_location' },
      ];
      return finish();
    }
    const geo = parseGeoInput(input);
    if (geo) {
      state.customer.locationLat = geo.lat;
      state.customer.locationLng = geo.lng;
      state.customer.locationText = geo.label || `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`;
      if (state.delivery === 'domicilio') {
        const feeInfo = await resolveDeliveryFee(geo, state.customer.address, deliveryFeeRules, deliveryZones);
        state.customer.deliveryFee = feeInfo.fee;
        state.customer.deliveryZoneName = feeInfo.zoneName;
        state.customer.deliveryBranchId = Number.isFinite(Number(feeInfo.branchId)) ? Number(feeInfo.branchId) : null;
        state.customer.deliveryBranchName = feeInfo.branchName || '';
        state.customer.locationResolved = feeInfo.resolvedLabel;
      }
      if (state.delivery === 'domicilio') {
        state.step = 'ask_reference';
        reply.messages = [
          `🗺️ Ubicación recibida. Abrir en Maps: ${mapsUrl(geo.lat, geo.lng)}${Number(state.customer.deliveryFee || 0) > 0 ? `\n🛵 Envío detectado: ${money(state.customer.deliveryFee, currency)}${state.customer.deliveryZoneName ? ` (${state.customer.deliveryZoneName})` : ''}` : ''}`,
          '¿Alguna referencia de tu domicilio? (ejemplo: portón negro, casa esquina).',
        ];
        reply.options = [{ label: 'Omitir referencia', value: 'skip_reference' }];
      } else {
        reply.messages = [
          `🗺️ Ubicación recibida. Abrir en Maps: ${mapsUrl(geo.lat, geo.lng)}${Number(state.customer.deliveryFee || 0) > 0 ? `\n🛵 Envío detectado: ${money(state.customer.deliveryFee, currency)}${state.customer.deliveryZoneName ? ` (${state.customer.deliveryZoneName})` : ''}` : ''}`,
        ];
        goToPaymentOrConfirm();
      }
      return finish();
    }
    reply.messages = ['Elige una opción para continuar:'];
    reply.options = [
      { label: '📍 Compartir ubicación', value: 'share_location' },
      { label: 'Omitir', value: 'skip_location' },
    ];
    return finish();
  }

  if (state.step === 'ask_reference') {
    if (lower === 'skip_reference') {
      state.customer.reference = '';
      goToPaymentOrConfirm();
      return finish();
    }

    const ref = String(input || '').trim();
    if (ref.length < 3) {
      reply.messages = ['Puedes escribirme una referencia más clara o tocar "Omitir referencia".'];
      reply.options = [{ label: 'Omitir referencia', value: 'skip_reference' }];
      return finish();
    }

    state.customer.reference = ref.slice(0, 180);
    goToPaymentOrConfirm();
    return finish();
  }

  if (state.step === 'ask_payment_method') {
    const chatPaymentOptions = state.delivery === 'recoger'
      ? enabledPaymentOptions(chatPaymentPickupSettings)
      : enabledPaymentOptions(chatPaymentDeliverySettings);
    const selected = {
      pay_cash: 'cash',
      pay_transfer: 'transfer',
      pay_card: 'card',
    }[lower];
    if (!selected || !chatPaymentOptions.some((opt) => opt.method === selected)) {
      reply.messages = ['Elige una opción de pago válida para continuar:'];
      reply.options = chatPaymentOptions.map((opt) => ({ label: opt.label, value: opt.value }));
      return finish();
    }
    state.customer.paymentMethod = selected;
    state.step = 'confirm';
    reply.messages = [confirmText(state, businessName, currency)];
    reply.options = confirmOptions();
    return finish();
  }

  if (state.step === 'confirm') {
    if (lower === 'confirm_yes') {
      // Guarda cliente CIFRADO y crea el pedido en el schema aislado del tenant
      const phoneHash = lookupHash(state.customer.phone);
      let customer = await t.get('SELECT id FROM {s}.customers WHERE phone_hash = $1', [phoneHash]);
      if (!customer) {
        customer = await t.get(
          'INSERT INTO {s}.customers (name_enc, phone_enc, phone_hash, address_enc) VALUES ($1,$2,$3,$4) RETURNING id',
          [encrypt(state.customer.name), encrypt(state.customer.phone), phoneHash, encrypt(state.customer.address || '')]
        );
      } else {
        // Mantiene la ficha del cliente actualizada para métricas y fidelidad.
        await t.run(
          'UPDATE {s}.customers SET name_enc = $1, phone_enc = $2, address_enc = $3 WHERE id = $4',
          [encrypt(state.customer.name), encrypt(state.customer.phone), encrypt(state.customer.address || ''), customer.id]
        );
      }
      const subtotal = cartTotal(state.cart);
      const deliveryFee = Number(state.customer.deliveryFee || 0);
      const total = subtotal + deliveryFee;
      const serviceBranchId = state.delivery === 'domicilio'
        ? (Number.isFinite(Number(state.customer.deliveryBranchId)) ? Number(state.customer.deliveryBranchId) : null)
        : (Number.isFinite(Number(state.customer.branchId)) ? Number(state.customer.branchId) : null);
      const serviceBranchName = state.delivery === 'domicilio'
        ? (state.customer.deliveryBranchName || null)
        : (state.customer.branchName || null);
      const orderRow = await t.get(
        `INSERT INTO {s}.orders
         (customer_id, items, subtotal, total, status, channel, delivery, notes, pickup_branch_id, pickup_branch_name, customer_location_lat, customer_location_lng, customer_location_text, customer_location_resolved, delivery_fee, delivery_zone_name, service_branch_id, service_branch_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [
          customer.id,
          JSON.stringify(state.cart),
          subtotal,
          total,
          'pendiente',
          'chatbot',
          state.delivery || 'recoger',
          state.delivery === 'domicilio' ? (state.customer.reference || null) : null,
          state.customer.branchId || null,
          state.customer.branchName || null,
          Number.isFinite(state.customer.locationLat) ? state.customer.locationLat : null,
          Number.isFinite(state.customer.locationLng) ? state.customer.locationLng : null,
          state.customer.locationText || null,
          state.customer.locationResolved || null,
          deliveryFee,
          state.customer.deliveryZoneName || null,
          serviceBranchId,
          serviceBranchName,
        ]
      );
      await t.run('UPDATE {s}.orders SET payment_method = $1 WHERE id = $2', [state.customer.paymentMethod || '', orderRow.id]);

      const orderText = buildOrderText(businessName, state.cart, state.customer, state.delivery, currency);
      const waLink = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(orderText)}` : null;

      // Notificar al tenant (Socket.io + Web Push)
      emitNewOrder(slug, {
        id: orderRow.id,
        total,
        totalLabel: money(total, currency),
        delivery: state.delivery || 'recoger',
        customerName: state.customer.name || '',
        items: state.cart.map(i => `${i.qty}x ${i.name}`).join(', '),
        summary: orderText,
        businessName,
      }).catch(() => {});

      reply.messages = [
        `🎉 *¡Pedido #${orderRow.id} recibido!*\n\nEn breve lo confirmamos. ¡Gracias por tu preferencia! 🙏`,
      ];
      reply.order = { id: orderRow.id, total, totalLabel: money(total, currency), whatsappLink: waLink, summary: orderText };
      if (waLink) reply.messages.push('👇 Toca el botón para enviar el resumen de tu pedido por WhatsApp y agilizar la atención.');
      if (!waLink) reply.messages.push('⚠️ El negocio aún no tiene un WhatsApp válido para envío automático. Tu pedido ya quedó registrado.');
      state = { step: 'start', cart: [], customer: {}, currency };
      reply.options = [{ label: '🆕 Hacer otro pedido', value: 'start' }];
      return finish();
    }
    if (lower === 'confirm_edit_note') {
      state.step = 'confirm_edit_note_text';
      reply.messages = ['Escribe la nota de tu pedido. Ejemplo: hamburguesa sin cebolla.'];
      reply.options = [{ label: '🗑️ Quitar nota', value: 'confirm_remove_note' }];
      return finish();
    }
    if (lower === 'confirm_remove_note') {
      state.customer.orderNote = '';
      state.step = 'confirm';
      reply.messages = ['✅ Nota eliminada.', confirmText(state, businessName, currency)];
      reply.options = confirmOptions();
      return finish();
    }
    if (lower === 'confirm_no') {
      state.step = 'start';
      reply.messages = ['Sin problema, tu carrito sigue guardado. ¿Qué deseas hacer?'];
      reply.options = mainOptions(state.cart, chatbotInfoOptions);
      return finish();
    }
  }

  if (state.step === 'confirm_edit_note_text') {
    if (lower === 'confirm_remove_note') {
      state.customer.orderNote = '';
      state.step = 'confirm';
      reply.messages = ['✅ Nota eliminada.', confirmText(state, businessName, currency)];
      reply.options = confirmOptions();
      return finish();
    }

    const note = String(input || '').trim();
    if (note.length < 3) {
      reply.messages = ['Escribe una nota más clara o toca "Quitar nota".'];
      reply.options = [{ label: '🗑️ Quitar nota', value: 'confirm_remove_note' }];
      return finish();
    }

    state.customer.orderNote = note.slice(0, 220);
    state.step = 'confirm';
    reply.messages = ['✅ Nota actualizada.', confirmText(state, businessName, currency)];
    reply.options = confirmOptions();
    return finish();
  }

  // Texto libre: busca producto por nombre
  const products = await activeProducts(t);
  const match = findProductByNaturalInput(products, input);
  if (match) {
    const existing = state.cart.find((it) => it.id === match.id);
    if (existing) existing.qty += 1;
    else state.cart.push({ id: match.id, name: match.name, price: match.price, qty: 1 });
    resetUpsellProgress();
    reply.messages = [`¡Agregado! 1x *${match.name}* 🎉\n\n${cartSummary(state.cart, currency)}`];
    reply.options = [
      { label: '➕ Agregar más', value: 'menu' },
      { label: '✅ Sería todo, gracias.', value: 'checkout' },
    ];
    return finish();
  }

  // IA opcional para preguntas libres
  const ai = await aiFallback(t, businessName, input, state);
  pushAiHistory(state, 'user', input);
  if (ai) pushAiHistory(state, 'assistant', ai);
  reply.messages = [ai || 'No estoy seguro de haber entendido 🤔 ¿Te ayudo con alguna de estas opciones?'];
  reply.options = mainOptions(state.cart, chatbotInfoOptions);
  return finish();
}

function confirmText(state, businessName, currency) {
  const c = state.customer;
  const locationDetails = locationSummary(c);
  return (
    `${pricingSummary(state, currency)}\n\n` +
    `👤 ${c.name}\n📞 ${c.phone}\n` +
    `💳 Pago: ${paymentMethodLabel(c.paymentMethod)}\n` +
    (state.delivery === 'domicilio'
      ? `📍 ${c.address}`
      : `🏪 Recoger en sucursal${c.branchName ? `: ${c.branchName}` : ''}`) +
    (state.delivery === 'domicilio' && c.deliveryBranchName ? `\n🏪 Atiende: Sucursal ${c.deliveryBranchName}` : '') +
    (state.delivery === 'domicilio' && c.reference ? `\n📝 Referencia: ${c.reference}` : '') +
    (locationDetails ? `\n${locationDetails}` : '') +
    '\n\n¿Confirmamos tu pedido?'
  );
}

function confirmOptions() {
  return [
    { label: '✅ Sí, confirmar', value: 'confirm_yes' },
    { label: '📝 Editar nota', value: 'confirm_edit_note' },
    { label: '❌ No, regresar', value: 'confirm_no' },
  ];
}

function newSessionId() {
  return crypto.randomUUID();
}

module.exports = { handleMessage, newSessionId };
