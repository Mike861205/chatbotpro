const PROMOTION_TYPES = new Set(['percentage', 'fixed_amount', 'fixed_price', 'buy_x_pay_y']);
const PROMOTION_CHANNELS = new Set(['pos', 'chatbot']);

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(Math.max(0, number).toFixed(2)) : 0;
}

function unitMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(Math.max(0, number).toFixed(6)) : 0;
}

function parseIds(value) {
  if (Array.isArray(value)) return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  try { return parseIds(JSON.parse(value || '[]')); } catch { return []; }
}

function parseDays(value) {
  if (Array.isArray(value)) return [...new Set(value.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  try { return parseDays(JSON.parse(value || '[]')); } catch { return []; }
}

function localClockParts(at = new Date(), timeZone = 'America/Mexico_City') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(at);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    minute: (Number(byType.hour) * 60) + Number(byType.minute),
    weekday: weekdays[byType.weekday],
  };
}

function timeMinute(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!match) return fallback;
  return Math.min(1439, Math.max(0, Number(match[1]) * 60 + Number(match[2])));
}

function isPromotionActive(promotion, channel, at = new Date(), timeZone = 'America/Mexico_City') {
  if (!promotion || !Number(promotion.active) || !PROMOTION_CHANNELS.has(channel)) return false;
  if (channel === 'pos' && !Number(promotion.pos_enabled ?? promotion.posEnabled)) return false;
  if (channel === 'chatbot' && !Number(promotion.chatbot_enabled ?? promotion.chatbotEnabled)) return false;
  const clock = localClockParts(at, timeZone);
  const startsOn = String(promotion.starts_on ?? promotion.startsOn ?? '').slice(0, 10);
  const endsOn = String(promotion.ends_on ?? promotion.endsOn ?? '').slice(0, 10);
  if (startsOn && clock.date < startsOn) return false;
  if (endsOn && clock.date > endsOn) return false;
  const days = parseDays(promotion.days_of_week ?? promotion.daysOfWeek);
  const start = timeMinute(promotion.start_time ?? promotion.startTime, 0);
  const end = timeMinute(promotion.end_time ?? promotion.endTime, 1439);
  if (start <= end) return (!days.length || days.includes(clock.weekday)) && clock.minute >= start && clock.minute <= end;
  // Horario que cruza medianoche: después de las 00:00 pertenece al día anterior.
  if (clock.minute >= start) return !days.length || days.includes(clock.weekday);
  const previousDay = (clock.weekday + 6) % 7;
  return clock.minute <= end && (!days.length || days.includes(previousDay));
}

function promotionLabel(promotion) {
  const type = promotion.type;
  if (type === 'percentage') return `${money(promotion.value)}% de descuento`;
  if (type === 'fixed_amount') return `$${money(promotion.value).toFixed(2)} de descuento`;
  if (type === 'fixed_price') return `Precio especial $${money(promotion.value).toFixed(2)}`;
  if (type === 'buy_x_pay_y') return `${Number(promotion.buy_qty)}x${Number(promotion.pay_qty)}`;
  return 'Promoción';
}

function normalizePromotion(row, productIds = [], categoryIds = []) {
  return {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    description: String(row.description || '').trim(),
    type: String(row.type || ''),
    value: money(row.value),
    buyQty: Number(row.buy_qty || row.buyQty || 0),
    payQty: Number(row.pay_qty || row.payQty || 0),
    allProducts: Boolean(Number(row.all_products ?? row.allProducts)),
    productIds: parseIds(productIds.length ? productIds : row.product_ids),
    categoryIds: parseIds(categoryIds.length ? categoryIds : row.category_ids),
    daysOfWeek: parseDays(row.days_of_week ?? row.daysOfWeek),
    startsOn: String(row.starts_on ?? row.startsOn ?? '').slice(0, 10),
    endsOn: String(row.ends_on ?? row.endsOn ?? '').slice(0, 10),
    startTime: String(row.start_time ?? row.startTime ?? '00:00').slice(0, 5),
    endTime: String(row.end_time ?? row.endTime ?? '23:59').slice(0, 5),
    posEnabled: Boolean(Number(row.pos_enabled ?? row.posEnabled)),
    chatbotEnabled: Boolean(Number(row.chatbot_enabled ?? row.chatbotEnabled)),
    active: Boolean(Number(row.active)),
    priority: Number(row.priority || 0),
    label: promotionLabel({
      type: row.type, value: row.value, buy_qty: row.buy_qty ?? row.buyQty, pay_qty: row.pay_qty ?? row.payQty,
    }),
    createdAt: row.created_at || row.createdAt || '',
    updatedAt: row.updated_at || row.updatedAt || '',
  };
}

async function listPromotions(t) {
  const rows = await t.all(`
    SELECT p.*,
      COALESCE((SELECT array_agg(pp.product_id ORDER BY pp.product_id) FROM {s}.promotion_products pp WHERE pp.promotion_id = p.id), '{}') AS product_ids,
      COALESCE((SELECT array_agg(pc.category_id ORDER BY pc.category_id) FROM {s}.promotion_categories pc WHERE pc.promotion_id = p.id), '{}') AS category_ids
    FROM {s}.promotions p
    ORDER BY p.active DESC, p.priority DESC, p.created_at DESC, p.id DESC
  `);
  return rows.map((row) => normalizePromotion(row));
}

async function getActivePromotions(t, channel, at = new Date()) {
  if (!PROMOTION_CHANNELS.has(channel)) return [];
  // Los adaptadores mínimos usados por integraciones/pruebas antiguas no exponen schema.
  if (!t?.schema) return [];
  const promotions = await listPromotions(t);
  return promotions.filter((promotion) => isPromotionActive(promotion, channel, at, t.timezone));
}

function appliesToProduct(promotion, productId, categoryId = null) {
  return promotion.allProducts
    || promotion.productIds.includes(Number(productId))
    || (Number(categoryId) > 0 && promotion.categoryIds.includes(Number(categoryId)));
}

function promotionTieRank(promotion) {
  const timestamp = Date.parse(promotion.updatedAt || promotion.createdAt || '') || 0;
  return [Number(promotion.priority || 0), timestamp, Number(promotion.id || 0)];
}

function winsPromotionTie(candidate, current) {
  const next = promotionTieRank(candidate);
  const previous = promotionTieRank(current);
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return false;
}

function candidateFor(item, promotion) {
  const qty = Math.max(1, Number(item.qty || item.quantity || 1));
  const originalUnitPrice = money(item.originalUnitPrice ?? item.listPrice ?? item.originalPrice ?? item.price);
  const extras = Math.min(originalUnitPrice, money(item.modifiersExtraPrice || 0));
  const baseUnit = money(originalUnitPrice - extras);
  const originalTotal = money(originalUnitPrice * qty);
  let total = originalTotal;
  if (promotion.type === 'percentage') total = money((baseUnit * (1 - promotion.value / 100) + extras) * qty);
  if (promotion.type === 'fixed_amount') total = money((Math.max(0, baseUnit - promotion.value) + extras) * qty);
  if (promotion.type === 'fixed_price') total = money((Math.min(baseUnit, promotion.value) + extras) * qty);
  if (promotion.type === 'buy_x_pay_y') {
    const buy = Math.max(2, Number(promotion.buyQty || 2));
    const pay = Math.max(1, Math.min(buy - 1, Number(promotion.payQty || buy - 1)));
    const freeUnits = Math.floor(qty / buy) * (buy - pay);
    total = money(originalTotal - (baseUnit * freeUnits));
  }
  return { originalUnitPrice, originalTotal, total, discount: money(originalTotal - total) };
}

function applyPromotions(items = [], promotions = []) {
  return items.map((rawItem) => {
    const item = { ...rawItem };
    const productId = Number(item.productId ?? item.id);
    const categoryId = Number(item.categoryId ?? item.category_id ?? 0);
    const eligible = promotions.filter((promotion) => appliesToProduct(promotion, productId, categoryId));
    item.activePromotions = eligible.map((promotion) => ({
      id: promotion.id, name: promotion.name, type: promotion.type, value: promotion.value,
      buyQty: promotion.buyQty, payQty: promotion.payQty, priority: promotion.priority, label: promotion.label,
      createdAt: promotion.createdAt, updatedAt: promotion.updatedAt,
    }));
    let best = null;
    for (const promotion of eligible) {
      const candidate = candidateFor(item, promotion);
      if (candidate.discount <= 0) continue;
      if (!best || candidate.discount > best.discount || (candidate.discount === best.discount && winsPromotionTie(promotion, best.promotion))) {
        best = { ...candidate, promotion };
      }
    }
    const originalUnitPrice = money(item.originalUnitPrice ?? item.listPrice ?? item.originalPrice ?? item.price);
    const qty = Math.max(1, Number(item.qty || item.quantity || 1));
    delete item.promotion;
    item.originalUnitPrice = originalUnitPrice;
    item.listPrice = originalUnitPrice;
    item.lineSubtotal = money(originalUnitPrice * qty);
    item.discountAmount = best?.discount || 0;
    item.lineTotal = best?.total ?? item.lineSubtotal;
    item.price = unitMoney(item.lineTotal / qty);
    if (item.taxEnabled === true && Number.isFinite(Number(item.taxRate))) {
      item.taxBasePrice = unitMoney(item.price / (1 + Number(item.taxRate)));
      item.taxAmount = unitMoney(item.price - item.taxBasePrice);
    }
    if (best) {
      item.promotion = {
        id: best.promotion.id, name: best.promotion.name, type: best.promotion.type,
        value: best.promotion.value, buyQty: best.promotion.buyQty, payQty: best.promotion.payQty,
        priority: best.promotion.priority, label: best.promotion.label,
      };
    }
    return item;
  });
}

async function applyPromotionsToItems(t, items, channel, at = new Date()) {
  return applyPromotions(items, await getActivePromotions(t, channel, at));
}

function decorateCatalogProducts(products = [], promotions = []) {
  return products.map((product) => {
    const originalPrice = money(product.price);
    const applied = applyPromotions([{ id: product.id, price: originalPrice, qty: 1 }], promotions)[0];
    const applicable = promotions.filter((promotion) => appliesToProduct(promotion, product.id, product.categoryId ?? product.category_id));
    const buyOffer = applicable.find((promotion) => promotion.type === 'buy_x_pay_y');
    const matchedPromotion = applied.promotion
      ? applicable.find((promotion) => promotion.id === applied.promotion.id)
      : buyOffer;
    const activePromotion = matchedPromotion || null;
    return {
      ...product,
      originalPrice,
      promotionalPrice: applied.promotion ? applied.price : originalPrice,
      activePromotion,
      activePromotions: applicable,
    };
  });
}

module.exports = {
  PROMOTION_TYPES,
  PROMOTION_CHANNELS,
  money,
  parseDays,
  parseIds,
  isPromotionActive,
  promotionLabel,
  normalizePromotion,
  listPromotions,
  getActivePromotions,
  appliesToProduct,
  applyPromotions,
  applyPromotionsToItems,
  decorateCatalogProducts,
};
