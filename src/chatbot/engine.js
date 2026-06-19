// Motor del chatbot: máquina de estados con flujos guiados (botones) para
// tomar pedidos. Si hay OPENAI_API_KEY, responde preguntas libres con IA.
const crypto = require('crypto');
const config = require('../config');
const OpenAI = require('openai');
const { q, getSetting, getSuperAdminSetting } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');

let aiConfigCache = { expiresAt: 0, value: null };
const aiClientCache = new Map();
const reverseGeoCache = new Map();

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
    return parsed
      .map((zone, i) => {
        const points = Array.isArray(zone?.points)
          ? zone.points
              .map((p) => [Number(p?.[0]), Number(p?.[1])])
              .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
          : [];
        const fee = Number(zone?.fee);
        const name = String(zone?.name || '').trim();
        if (!name || !Number.isFinite(fee) || fee < 0 || points.length < 3) return null;
        return {
          id: String(zone?.id || `zone-${i + 1}`),
          name,
          fee,
          points,
          active: zone?.active !== false,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
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
    return { fee: 0, zoneName: '', resolvedLabel: '' };
  }

  const activeZones = Array.isArray(zones) ? zones.filter((zone) => zone.active && Array.isArray(zone.points) && zone.points.length >= 3) : [];

  // Si hay zonas dibujadas, la resolución es 100% por polígono para evitar latencia innecesaria.
  if (activeZones.length) {
    const zoneMatch = activeZones.find((zone) => pointInPolygon([geo.lat, geo.lng], zone.points));
    if (zoneMatch) {
      return { fee: zoneMatch.fee, zoneName: zoneMatch.name, resolvedLabel: zoneMatch.name };
    }
    return { fee: 0, zoneName: '', resolvedLabel: '' };
  }

  if (!rules.length) {
    return { fee: 0, zoneName: '', resolvedLabel: '' };
  }

  const reverseGeo = await reverseGeocodeLocation(geo.lat, geo.lng);
  const { resolvedLabel, candidates } = buildLocationCandidates(geo, address, reverseGeo);
  const match = matchDeliveryFeeRule(rules, candidates);
  if (!match) return { fee: 0, zoneName: '', resolvedLabel };

  return { fee: match.fee, zoneName: match.zoneName, resolvedLabel };
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
  return t.all(
    `SELECT p.id, p.name, p.description, p.price::float AS price, p.image, c.name AS category
     FROM {s}.products p LEFT JOIN {s}.categories c ON c.id = p.category_id
     WHERE p.active = 1 ORDER BY c.sort, c.name, p.name`
  );
}

function cartTotal(cart) {
  return cart.reduce((s, it) => s + it.price * it.qty, 0);
}

function cartSummary(cart, currency) {
  if (!cart.length) return 'Tu carrito está vacío 🛒';
  const lines = cart.map((it) => `• ${it.qty}x ${it.name} — ${money(it.price * it.qty, currency)}`);
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

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

function locationSummary(customer) {
  const hasCoords = Number.isFinite(customer?.locationLat) && Number.isFinite(customer?.locationLng);
  const locationLabel = String(customer?.locationText || '').trim();
  if (!hasCoords && !locationLabel) return '';

  const lines = [];
  if (locationLabel) lines.push(`🧭 Ubicación compartida: ${locationLabel}`);
  if (hasCoords) {
    lines.push(`📍 Coordenadas: ${customer.locationLat.toFixed(5)}, ${customer.locationLng.toFixed(5)}`);
    lines.push(`🗺️ Abrir en Maps: ${mapsUrl(customer.locationLat, customer.locationLng)}`);
  }
  if (customer?.locationResolved) lines.push(`🏘️ Referencia Maps: ${customer.locationResolved}`);
  return lines.join('\n');
}

function pricingSummary(state, currency) {
  const subtotal = cartTotal(state.cart);
  const deliveryFee = Number(state.customer?.deliveryFee || 0);
  const lines = state.cart.map((it) => `• ${it.qty}x ${it.name} — ${money(it.price * it.qty, currency)}`);
  return [
    '🛒 *Tu pedido:*',
    ...lines,
    '',
    `*Subtotal: ${money(subtotal, currency)}*`,
    ...(deliveryFee > 0 ? [`*Envío${state.customer?.deliveryZoneName ? ` (${state.customer.deliveryZoneName})` : ''}: ${money(deliveryFee, currency)}*`] : []),
    `*Total: ${money(subtotal + deliveryFee, currency)}*`,
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

function mainOptions(cart) {
  const opts = [{ label: '📋 Ver menú', value: 'menu' }];
  if (cart.length) {
    opts.push({ label: '🛒 Ver carrito', value: 'cart' });
    opts.push({ label: '✅ Finalizar pedido', value: 'checkout' });
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
  if (categoryId) {
    const cat = await t.get('SELECT name FROM {s}.categories WHERE id = $1', [categoryId]);
    if (cat) products = products.filter((p) => p.category === cat.name);
  }
  state.step = 'choosing_product';
  const currency = state.currency;
  return {
    messages: ['Elige un producto para agregarlo a tu pedido:'],
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      priceLabel: money(p.price, currency),
      image: p.image,
    })),
    options: [{ label: '⬅️ Volver', value: 'start' }, ...(state.cart.length ? mainOptions(state.cart).slice(1) : [])],
  };
}

function buildOrderText(businessName, cart, customer, delivery, currency) {
  const subtotal = cartTotal(cart);
  const deliveryFee = Number(customer?.deliveryFee || 0);
  const lines = [
    `🧾 *Nuevo pedido — ${businessName}*`,
    '',
    ...cart.map((it) => `• ${it.qty}x ${it.name} — ${money(it.price * it.qty, currency)}`),
    '',
    `*Subtotal: ${money(subtotal, currency)}*`,
    ...(deliveryFee > 0 ? [`*Envío${customer?.deliveryZoneName ? ` (${customer.deliveryZoneName})` : ''}: ${money(deliveryFee, currency)}*`] : []),
    `*Total: ${money(subtotal + deliveryFee, currency)}*`,
    '',
    `👤 ${customer.name}`,
    `📞 ${customer.phone}`,
    delivery === 'domicilio'
      ? `📍 Entrega a domicilio: ${customer.address}`
      : `🏪 Recoger en sucursal${customer.branchName ? `: ${customer.branchName}` : ''}`,
    ...(delivery === 'domicilio' && customer?.reference ? [`📝 Referencia cliente: ${customer.reference}`] : []),
  ];
  const locationDetails = locationSummary(customer);
  if (locationDetails) lines.push(locationDetails);
  return lines.join('\n');
}

async function aiFallback(t, businessName, userText) {
  const aiCfg = await getAiRuntimeConfig();
  if (!aiCfg.enabled || !aiCfg.key) return null;
  try {
    const openaiClient = getOpenAiClient(aiCfg.key, aiCfg.baseUrl);
    const products = await activeProducts(t);
    const menuText = products.map((p) => `- ${p.name} (${p.category || 'General'}): $${p.price}. ${p.description}`).join('\n');
    const completion = await openaiClient.chat.completions.create({
      model: aiCfg.model || 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `Eres el asistente de pedidos del restaurante "${businessName}". Responde en español, breve y amable. Solo hablas del menú y pedidos. Menú:\n${menuText}\nSi el cliente quiere ordenar, sugiérele tocar el botón "Ver menú".`,
        },
        { role: 'user', content: userText },
      ],
    });
    return completion.choices[0]?.message?.content || null;
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

  let state = (await getState(t, sessionId)) || { step: 'start', cart: [], customer: {}, currency };
  state.currency = currency;

  const reply = { messages: [], options: [], products: null, cart: null, order: null };
  const lower = input.toLowerCase();

  const finish = async () => {
    await saveState(t, sessionId, state);
    reply.cart = { items: state.cart, total: cartTotal(state.cart), totalLabel: money(cartTotal(state.cart), currency) };
    return reply;
  };

  // Comandos globales
  if (!input || lower === 'start' || lower === 'hola' || lower === 'inicio') {
    state.step = 'start';
    state.returningProfile = null;
    reply.messages = [await getSetting(t, 'welcome_message', `¡Hola! Bienvenido a ${businessName} 👋`)];
    reply.options = mainOptions(state.cart);
    return finish();
  }
  if (lower === 'returning_customer') {
    if (!deliveryEnabled) {
      reply.messages = ['En este momento el negocio no tiene entregas a domicilio activas, así que no puedo recuperar dirección automática. Puedes pedir normalmente desde el menú.'];
      reply.options = mainOptions(state.cart);
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
          { label: '✅ Finalizar pedido', value: 'checkout' },
          { label: '➕ Agregar más', value: 'menu' },
          { label: '🗑️ Vaciar carrito', value: 'clear_cart' },
        ]
      : [{ label: '📋 Ver menú', value: 'menu' }];
    return finish();
  }
  if (lower === 'clear_cart') {
    state.cart = [];
    state.step = 'start';
    reply.messages = ['Listo, vacié tu carrito. ¿Empezamos de nuevo? 😊'];
    reply.options = mainOptions(state.cart);
    return finish();
  }

  // Selección de categoría
  if (lower.startsWith('cat_')) {
    Object.assign(reply, await showProducts(t, state, Number(lower.slice(4))));
    return finish();
  }

  // Selección de producto
  if (lower.startsWith('prod_')) {
    const prod = await t.get('SELECT id, name, price::float AS price FROM {s}.products WHERE id = $1 AND active = 1', [
      Number(lower.slice(5)),
    ]);
    if (prod) {
      state.step = 'awaiting_qty';
      state.pendingProduct = { id: prod.id, name: prod.name, price: prod.price };
      reply.messages = [`*${prod.name}* — ${money(prod.price, currency)}\n¿Cuántos quieres?`];
      reply.options = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: `qty_${n}` }));
      return finish();
    }
  }

  // Cantidad
  if (state.step === 'awaiting_qty') {
    const qty = lower.startsWith('qty_') ? Number(lower.slice(4)) : parseInt(input, 10);
    if (qty > 0 && qty <= 50 && state.pendingProduct) {
      const existing = state.cart.find((it) => it.id === state.pendingProduct.id);
      if (existing) existing.qty += qty;
      else state.cart.push({ ...state.pendingProduct, qty });
      const name = state.pendingProduct.name;
      state.pendingProduct = null;
      state.step = 'start';
      reply.messages = [`¡Agregado! ${qty}x *${name}* 🎉\n\n${cartSummary(state.cart, currency)}`];
      reply.options = [
        { label: '➕ Agregar más', value: 'menu' },
        { label: '✅ Finalizar pedido', value: 'checkout' },
      ];
      return finish();
    }
    reply.messages = ['Por favor indícame una cantidad válida (1 a 50).'];
    reply.options = [1, 2, 3].map((n) => ({ label: String(n), value: `qty_${n}` }));
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
      state.customer.reference = p.reference || '';
      state.delivery = 'domicilio';
      if (state.cart.length) {
        state.step = 'confirm';
        reply.messages = [
          '¡Perfecto! Ya usaré tus mismos datos de ubicación para este pedido 🚀',
          confirmText(state, businessName, currency),
        ];
        reply.options = confirmOptions();
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
        reply.messages = [confirmText(state, businessName, currency)];
        reply.options = confirmOptions();
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

    const hasReturningData =
      Boolean(state.customer?.name) &&
      Boolean(state.customer?.phone) &&
      state.delivery === 'domicilio' &&
      Boolean(state.customer?.address);

    if (hasReturningData) {
      state.step = 'confirm';
      reply.messages = [
        'Usaré tus datos guardados del último pedido para agilizar ✅',
        confirmText(state, businessName, currency),
      ];
      reply.options = confirmOptions();
      return finish();
    }

    state.step = 'checkout_identity_choice';
    reply.messages = ['Antes de finalizar, ¿ya habías pedido con nosotros?'];
    reply.options = [
      { label: '🔁 Ya he pedido', value: 'returning_customer' },
      { label: '👤 Soy cliente nuevo', value: 'checkout_new_customer' },
    ];
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
          reply.messages = [confirmText(state, businessName, currency)];
          reply.options = confirmOptions();
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
          reply.messages = [confirmText(state, businessName, currency)];
          reply.options = confirmOptions();
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
      if (locationEnabled) {
        state.step = 'ask_location_optional';
        reply.messages = [
          `Perfecto, recogerás en *${chosen.name}* ✅\n${chosen.address}${chosen.reference ? `\nReferencia: ${chosen.reference}` : ''}`,
          '¿Quieres compartir tu ubicación para ubicarte más fácil? (Opcional)',
        ];
        reply.options = [
          { label: '📍 Compartir ubicación', value: 'share_location' },
          { label: 'Omitir', value: 'skip_location' },
        ];
      } else {
        state.step = 'confirm';
        reply.messages = [
          `Perfecto, recogerás en *${chosen.name}* ✅\n${chosen.address}${chosen.reference ? `\nReferencia: ${chosen.reference}` : ''}`,
          confirmText(state, businessName, currency),
        ];
        reply.options = confirmOptions();
      }
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
        state.step = 'confirm';
        reply.messages = [confirmText(state, businessName, currency)];
        reply.options = confirmOptions();
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
        state.step = 'confirm';
        reply.messages = [
          `🗺️ Ubicación recibida. Abrir en Maps: ${mapsUrl(geo.lat, geo.lng)}${Number(state.customer.deliveryFee || 0) > 0 ? `\n🛵 Envío detectado: ${money(state.customer.deliveryFee, currency)}${state.customer.deliveryZoneName ? ` (${state.customer.deliveryZoneName})` : ''}` : ''}`,
          confirmText(state, businessName, currency),
        ];
        reply.options = confirmOptions();
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
      state.step = 'confirm';
      reply.messages = [confirmText(state, businessName, currency)];
      reply.options = confirmOptions();
      return finish();
    }

    const ref = String(input || '').trim();
    if (ref.length < 3) {
      reply.messages = ['Puedes escribirme una referencia más clara o tocar "Omitir referencia".'];
      reply.options = [{ label: 'Omitir referencia', value: 'skip_reference' }];
      return finish();
    }

    state.customer.reference = ref.slice(0, 180);
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
      const orderRow = await t.get(
        `INSERT INTO {s}.orders
         (customer_id, items, subtotal, total, status, channel, delivery, notes, pickup_branch_id, pickup_branch_name, customer_location_lat, customer_location_lng, customer_location_text, customer_location_resolved, delivery_fee, delivery_zone_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
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
        ]
      );

      const orderText = buildOrderText(businessName, state.cart, state.customer, state.delivery, currency);
      const waLink = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(orderText)}` : null;

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
    if (lower === 'confirm_no') {
      state.step = 'start';
      reply.messages = ['Sin problema, tu carrito sigue guardado. ¿Qué deseas hacer?'];
      reply.options = mainOptions(state.cart);
      return finish();
    }
  }

  // Texto libre: busca producto por nombre
  const products = await activeProducts(t);
  const match = products.find((p) => p.name.toLowerCase().includes(lower) && lower.length >= 3);
  if (match) {
    state.step = 'awaiting_qty';
    state.pendingProduct = { id: match.id, name: match.name, price: match.price };
    reply.messages = [`¡Encontré *${match.name}*! — ${money(match.price, currency)}\n¿Cuántos quieres?`];
    reply.options = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: `qty_${n}` }));
    return finish();
  }

  // IA opcional para preguntas libres
  const ai = await aiFallback(t, businessName, input);
  reply.messages = [ai || 'No estoy seguro de haber entendido 🤔 ¿Te ayudo con alguna de estas opciones?'];
  reply.options = mainOptions(state.cart);
  return finish();
}

function confirmText(state, businessName, currency) {
  const c = state.customer;
  const locationDetails = locationSummary(c);
  return (
    `${pricingSummary(state, currency)}\n\n` +
    `👤 ${c.name}\n📞 ${c.phone}\n` +
    (state.delivery === 'domicilio'
      ? `📍 ${c.address}`
      : `🏪 Recoger en sucursal${c.branchName ? `: ${c.branchName}` : ''}`) +
    (state.delivery === 'domicilio' && c.reference ? `\n📝 Referencia: ${c.reference}` : '') +
    (locationDetails ? `\n${locationDetails}` : '') +
    '\n\n¿Confirmamos tu pedido?'
  );
}

function confirmOptions() {
  return [
    { label: '✅ Sí, confirmar', value: 'confirm_yes' },
    { label: '❌ No, regresar', value: 'confirm_no' },
  ];
}

function newSessionId() {
  return crypto.randomUUID();
}

module.exports = { handleMessage, newSessionId };
