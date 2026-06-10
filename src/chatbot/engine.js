// Motor del chatbot: máquina de estados con flujos guiados (botones) para
// tomar pedidos. Si hay OPENAI_API_KEY, responde preguntas libres con IA.
const crypto = require('crypto');
const config = require('../config');
const { getSetting } = require('../db/tenant');
const { encrypt, lookupHash } = require('../utils/crypto');

let openaiClient = null;
if (config.OPENAI_API_KEY) {
  const OpenAI = require('openai');
  openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
}

function money(n, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(n || 0);
}

function getState(db, sessionId) {
  const row = db.prepare('SELECT state FROM chat_sessions WHERE id = ?').get(sessionId);
  return row ? JSON.parse(row.state) : null;
}

function saveState(db, sessionId, state) {
  db.prepare(
    `INSERT INTO chat_sessions (id, state, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
  ).run(sessionId, JSON.stringify(state));
}

function activeProducts(db) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.description, p.price, p.image, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.active = 1 ORDER BY c.sort, c.name, p.name`
    )
    .all();
}

function cartTotal(cart) {
  return cart.reduce((s, it) => s + it.price * it.qty, 0);
}

function cartSummary(cart, currency) {
  if (!cart.length) return 'Tu carrito está vacío 🛒';
  const lines = cart.map((it) => `• ${it.qty}x ${it.name} — ${money(it.price * it.qty, currency)}`);
  return `🛒 *Tu pedido:*\n${lines.join('\n')}\n\n*Total: ${money(cartTotal(cart), currency)}*`;
}

function mainOptions(cart) {
  const opts = [{ label: '📋 Ver menú', value: 'menu' }];
  if (cart.length) {
    opts.push({ label: '🛒 Ver carrito', value: 'cart' });
    opts.push({ label: '✅ Finalizar pedido', value: 'checkout' });
  }
  return opts;
}

function showMenu(db, state) {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sort, name').all();
  const products = activeProducts(db);
  if (!products.length) {
    return {
      messages: ['Por ahora no tenemos productos en el menú. ¡Vuelve pronto! 🙏'],
      options: [],
    };
  }
  const catsWithProducts = cats.filter((c) => products.some((p) => p.category === c.name));
  if (catsWithProducts.length > 1) {
    state.step = 'choosing_category';
    return {
      messages: ['¿Qué categoría te gustaría ver? 😋'],
      options: catsWithProducts.map((c) => ({ label: c.name, value: `cat_${c.id}` })),
    };
  }
  return showProducts(db, state, null);
}

function showProducts(db, state, categoryId) {
  let products = activeProducts(db);
  if (categoryId) {
    const cat = db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId);
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
  const lines = [
    `🧾 *Nuevo pedido — ${businessName}*`,
    '',
    ...cart.map((it) => `• ${it.qty}x ${it.name} — ${money(it.price * it.qty, currency)}`),
    '',
    `*Total: ${money(cartTotal(cart), currency)}*`,
    '',
    `👤 ${customer.name}`,
    `📞 ${customer.phone}`,
    delivery === 'domicilio' ? `📍 Entrega a domicilio: ${customer.address}` : '🏪 Recoger en sucursal',
  ];
  return lines.join('\n');
}

async function aiFallback(db, businessName, userText) {
  if (!openaiClient) return null;
  try {
    const products = activeProducts(db);
    const menuText = products.map((p) => `- ${p.name} (${p.category || 'General'}): $${p.price}. ${p.description}`).join('\n');
    const completion = await openaiClient.chat.completions.create({
      model: 'gpt-4o-mini',
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

async function handleMessage(db, slug, sessionId, rawInput) {
  const input = String(rawInput || '').trim();
  const businessName = getSetting(db, 'business_name', slug);
  const currency = getSetting(db, 'currency', 'MXN');
  const whatsapp = getSetting(db, 'whatsapp', '').replace(/\D/g, '');
  const deliveryEnabled = getSetting(db, 'delivery_enabled', '1') === '1';
  const pickupEnabled = getSetting(db, 'pickup_enabled', '1') === '1';

  let state = getState(db, sessionId) || { step: 'start', cart: [], customer: {}, currency };
  state.currency = currency;

  const reply = { messages: [], options: [], products: null, cart: null, order: null };
  const lower = input.toLowerCase();

  const finish = () => {
    saveState(db, sessionId, state);
    reply.cart = { items: state.cart, total: cartTotal(state.cart), totalLabel: money(cartTotal(state.cart), currency) };
    return reply;
  };

  // Comandos globales
  if (!input || lower === 'start' || lower === 'hola' || lower === 'inicio') {
    state.step = 'start';
    reply.messages = [getSetting(db, 'welcome_message', `¡Hola! Bienvenido a ${businessName} 👋`)];
    reply.options = mainOptions(state.cart);
    return finish();
  }
  if (lower === 'menu' || lower === 'menú') {
    Object.assign(reply, showMenu(db, state));
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
    Object.assign(reply, showProducts(db, state, Number(lower.slice(4))));
    return finish();
  }

  // Selección de producto
  if (lower.startsWith('prod_')) {
    const prod = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(lower.slice(5)));
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

  // Checkout
  if (lower === 'checkout') {
    if (!state.cart.length) {
      reply.messages = ['Tu carrito está vacío. ¡Mira nuestro menú! 😊'];
      reply.options = [{ label: '📋 Ver menú', value: 'menu' }];
      return finish();
    }
    state.step = 'ask_name';
    reply.messages = ['¡Perfecto! Para completar tu pedido, ¿cuál es tu *nombre*?'];
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
    } else {
      state.delivery = 'recoger';
      state.step = 'confirm';
      reply.messages = [confirmText(state, businessName, currency)];
      reply.options = confirmOptions();
    }
    return finish();
  }

  if (state.step === 'ask_delivery') {
    if (lower === 'delivery_domicilio') {
      state.delivery = 'domicilio';
      state.step = 'ask_address';
      reply.messages = ['¿Cuál es tu *dirección* de entrega? 📍'];
      return finish();
    }
    if (lower === 'delivery_recoger') {
      state.delivery = 'recoger';
      state.step = 'confirm';
      reply.messages = [confirmText(state, businessName, currency)];
      reply.options = confirmOptions();
      return finish();
    }
    reply.messages = ['Elige una opción, por favor:'];
    reply.options = [
      { label: '🛵 A domicilio', value: 'delivery_domicilio' },
      { label: '🏪 Recoger en sucursal', value: 'delivery_recoger' },
    ];
    return finish();
  }

  if (state.step === 'ask_address') {
    if (input.length < 5) {
      reply.messages = ['Necesito una dirección un poco más completa 🙏'];
      return finish();
    }
    state.customer.address = input.slice(0, 200);
    state.step = 'confirm';
    reply.messages = [confirmText(state, businessName, currency)];
    reply.options = confirmOptions();
    return finish();
  }

  if (state.step === 'confirm') {
    if (lower === 'confirm_yes') {
      // Guarda cliente CIFRADO y crea el pedido en la BD aislada del tenant
      const phoneHash = lookupHash(state.customer.phone);
      let customer = db.prepare('SELECT id FROM customers WHERE phone_hash = ?').get(phoneHash);
      if (!customer) {
        const r = db
          .prepare('INSERT INTO customers (name_enc, phone_enc, phone_hash, address_enc) VALUES (?, ?, ?, ?)')
          .run(encrypt(state.customer.name), encrypt(state.customer.phone), phoneHash, encrypt(state.customer.address || ''));
        customer = { id: r.lastInsertRowid };
      }
      const total = cartTotal(state.cart);
      const r = db
        .prepare('INSERT INTO orders (customer_id, items, subtotal, total, status, channel, delivery) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(customer.id, JSON.stringify(state.cart), total, total, 'pendiente', 'chatbot', state.delivery || 'recoger');

      const orderText = buildOrderText(businessName, state.cart, state.customer, state.delivery, currency);
      const waLink = whatsapp ? `https://wa.me/${whatsapp}?text=${encodeURIComponent(orderText)}` : null;

      reply.messages = [
        `🎉 *¡Pedido #${r.lastInsertRowid} recibido!*\n\nEn breve lo confirmamos. ¡Gracias por tu preferencia! 🙏`,
      ];
      reply.order = { id: r.lastInsertRowid, total, totalLabel: money(total, currency), whatsappLink: waLink, summary: orderText };
      if (waLink) reply.messages.push('👇 Toca el botón para enviar el resumen de tu pedido por WhatsApp y agilizar la atención.');
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
  const products = activeProducts(db);
  const match = products.find((p) => p.name.toLowerCase().includes(lower) && lower.length >= 3);
  if (match) {
    state.step = 'awaiting_qty';
    state.pendingProduct = { id: match.id, name: match.name, price: match.price };
    reply.messages = [`¡Encontré *${match.name}*! — ${money(match.price, currency)}\n¿Cuántos quieres?`];
    reply.options = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: `qty_${n}` }));
    return finish();
  }

  // IA opcional para preguntas libres
  const ai = await aiFallback(db, businessName, input);
  reply.messages = [ai || 'No estoy seguro de haber entendido 🤔 ¿Te ayudo con alguna de estas opciones?'];
  reply.options = mainOptions(state.cart);
  return finish();
}

function confirmText(state, businessName, currency) {
  const c = state.customer;
  return (
    `${cartSummary(state.cart, currency)}\n\n` +
    `👤 ${c.name}\n📞 ${c.phone}\n` +
    (state.delivery === 'domicilio' ? `📍 ${c.address}` : '🏪 Recoger en sucursal') +
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
