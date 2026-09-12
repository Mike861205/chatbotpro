const express = require('express');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { PROMOTION_TYPES, BUY_PAY_RULES, listPromotions, isPromotionActive, parseDays, parseIds } = require('../utils/promotions');

const router = express.Router();
router.use(requireAuth);
router.use(requireModules('promociones'));
router.use(requireOwner);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanPromotion(body = {}) {
  const type = String(body.type || '').trim();
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const description = String(body.description || '').trim().replace(/\s+/g, ' ').slice(0, 300);
  const value = Number(body.value || 0);
  const buyQty = Number(body.buyQty || 0);
  const payQty = Number(body.payQty || 0);
  const buyPayRule = String(body.buyPayRule || 'same_product').trim();
  const allProducts = body.allProducts === true || body.allProducts === 1 || body.allProducts === '1';
  const productIds = parseIds(body.productIds);
  const categoryIds = parseIds(body.categoryIds);
  const daysOfWeek = parseDays(body.daysOfWeek);
  const startsOn = String(body.startsOn || '').trim();
  const endsOn = String(body.endsOn || '').trim();
  const startTime = String(body.startTime || '00:00').trim();
  const endTime = String(body.endTime || '23:59').trim();
  if (!name) throw badRequest('Escribe un nombre para la promoción');
  if (!PROMOTION_TYPES.has(type)) throw badRequest('El tipo de promoción no es válido');
  if (!allProducts && !productIds.length && !categoryIds.length) throw badRequest('Selecciona al menos una categoría o un producto');
  if (type === 'percentage' && (!Number.isFinite(value) || value <= 0 || value > 100)) throw badRequest('El porcentaje debe estar entre 0.01 y 100');
  if (['fixed_amount', 'fixed_price'].includes(type) && (!Number.isFinite(value) || value < 0)) throw badRequest('El importe no es válido');
  if (type === 'buy_x_pay_y' && (!Number.isInteger(buyQty) || !Number.isInteger(payQty) || buyQty < 2 || payQty < 1 || payQty >= buyQty)) {
    throw badRequest('En compra X paga Y, X debe ser mayor que Y y ambos deben ser enteros');
  }
  if (type === 'buy_x_pay_y' && !BUY_PAY_RULES.has(buyPayRule)) throw badRequest('La regla de cobro de compra X paga Y no es válida');
  if (startsOn && !/^\d{4}-\d{2}-\d{2}$/.test(startsOn)) throw badRequest('La fecha inicial no es válida');
  if (endsOn && !/^\d{4}-\d{2}-\d{2}$/.test(endsOn)) throw badRequest('La fecha final no es válida');
  if (startsOn && endsOn && startsOn > endsOn) throw badRequest('La fecha final debe ser posterior a la inicial');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) throw badRequest('El horario no es válido');
  return {
    name, description, type, value: Number.isFinite(value) ? value : 0, buyQty, payQty, buyPayRule, allProducts,
    productIds, categoryIds, daysOfWeek, startsOn: startsOn || null, endsOn: endsOn || null, startTime, endTime,
    posEnabled: body.posEnabled !== false && body.posEnabled !== 0 && body.posEnabled !== '0',
    chatbotEnabled: body.chatbotEnabled !== false && body.chatbotEnabled !== 0 && body.chatbotEnabled !== '0',
    active: body.active !== false && body.active !== 0 && body.active !== '0',
    priority: Math.trunc(Math.max(0, Math.min(999, Number(body.priority || 0)))) || 0,
  };
}

async function validateProducts(t, promotion) {
  if (promotion.allProducts) return;
  const [products, categories] = await Promise.all([
    promotion.productIds.length ? t.all('SELECT id FROM {s}.products WHERE id = ANY($1::int[])', [promotion.productIds]) : [],
    promotion.categoryIds.length ? t.all('SELECT id FROM {s}.categories WHERE id = ANY($1::int[])', [promotion.categoryIds]) : [],
  ]);
  if (products.length !== promotion.productIds.length) throw badRequest('Uno o más productos ya no existen');
  if (categories.length !== promotion.categoryIds.length) throw badRequest('Una o más categorías ya no existen');
}

async function saveScope(t, promotionId, promotion) {
  await t.run('DELETE FROM {s}.promotion_products WHERE promotion_id = $1', [promotionId]);
  await t.run('DELETE FROM {s}.promotion_categories WHERE promotion_id = $1', [promotionId]);
  if (!promotion.allProducts && promotion.productIds.length) {
    await t.run(
      `INSERT INTO {s}.promotion_products (promotion_id, product_id)
       SELECT $1, product_id FROM unnest($2::int[]) AS product_id`,
      [promotionId, promotion.productIds]
    );
  }
  if (!promotion.allProducts && promotion.categoryIds.length) {
    await t.run(
      `INSERT INTO {s}.promotion_categories (promotion_id, category_id)
       SELECT $1, category_id FROM unnest($2::int[]) AS category_id`,
      [promotionId, promotion.categoryIds]
    );
  }
}

router.get('/', async (req, res, next) => {
  try {
    const [promotions, products, categories, usageRows] = await Promise.all([
      listPromotions(req.tdb),
      req.tdb.all(`SELECT p.id,p.category_id,p.name,p.price::float AS price,p.active,c.name AS category_name
        FROM {s}.products p LEFT JOIN {s}.categories c ON c.id=p.category_id ORDER BY c.sort,c.name,p.name`),
      req.tdb.all(`SELECT c.id,c.name,c.sort,count(p.id)::int AS product_count
        FROM {s}.categories c LEFT JOIN {s}.products p ON p.category_id=c.id
        GROUP BY c.id ORDER BY c.sort,c.name`),
      req.tdb.all(`
        SELECT (line.item->'promotion'->>'id')::int AS promotion_id,
               count(DISTINCT o.id)::int AS order_count,
               COALESCE(sum(CASE WHEN (line.item->>'discountAmount') ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (line.item->>'discountAmount')::numeric ELSE 0 END),0)::float AS discount_total
        FROM {s}.orders o
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(NULLIF(o.items,''),'[]')::jsonb) AS line(item)
        WHERE o.status <> 'cancelado' AND (line.item->'promotion'->>'id') ~ '^[0-9]+$'
        GROUP BY (line.item->'promotion'->>'id')::int`),
    ]);
    const now = new Date();
    const posIds = new Set(promotions.filter((promotion) => isPromotionActive(promotion, 'pos', now, req.tdb.timezone)).map((promotion) => promotion.id));
    const chatbotIds = new Set(promotions.filter((promotion) => isPromotionActive(promotion, 'chatbot', now, req.tdb.timezone)).map((promotion) => promotion.id));
    const usage = new Map(usageRows.map((row) => [Number(row.promotion_id), row]));
    res.json({ promotions: promotions.map((promotion) => ({
      ...promotion,
      runningPos: posIds.has(promotion.id),
      runningChatbot: chatbotIds.has(promotion.id),
      running: posIds.has(promotion.id) || chatbotIds.has(promotion.id),
      orderCount: Number(usage.get(promotion.id)?.order_count || 0),
      discountTotal: Number(usage.get(promotion.id)?.discount_total || 0),
    })), products, categories });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const p = cleanPromotion(req.body);
    await validateProducts(req.tdb, p);
    const row = await req.tdb.tx(async (tx) => {
      const created = await tx.get(
        `INSERT INTO {s}.promotions
         (name,description,type,value,buy_qty,pay_qty,buy_pay_rule,all_products,days_of_week,starts_on,ends_on,start_time,end_time,pos_enabled,chatbot_enabled,active,priority,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [p.name,p.description,p.type,p.value,p.buyQty,p.payQty,p.buyPayRule,p.allProducts?1:0,JSON.stringify(p.daysOfWeek),p.startsOn,p.endsOn,p.startTime,p.endTime,p.posEnabled?1:0,p.chatbotEnabled?1:0,p.active?1:0,p.priority,req.user.username]
      );
      await saveScope(tx, created.id, p);
      return created;
    });
    res.json({ ok: true, id: row.id });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const exists = await req.tdb.get('SELECT id FROM {s}.promotions WHERE id=$1', [id]);
    if (!exists) return res.status(404).json({ error: 'Promoción no encontrada' });
    const p = cleanPromotion(req.body);
    await validateProducts(req.tdb, p);
    await req.tdb.tx(async (tx) => {
      await tx.run(
        `UPDATE {s}.promotions SET name=$1,description=$2,type=$3,value=$4,buy_qty=$5,pay_qty=$6,buy_pay_rule=$7,all_products=$8,
         days_of_week=$9,starts_on=$10,ends_on=$11,start_time=$12,end_time=$13,pos_enabled=$14,chatbot_enabled=$15,
         active=$16,priority=$17,updated_at=now() WHERE id=$18`,
        [p.name,p.description,p.type,p.value,p.buyQty,p.payQty,p.buyPayRule,p.allProducts?1:0,JSON.stringify(p.daysOfWeek),p.startsOn,p.endsOn,p.startTime,p.endTime,p.posEnabled?1:0,p.chatbotEnabled?1:0,p.active?1:0,p.priority,id]
      );
      await saveScope(tx, id, p);
    });
    res.json({ ok: true });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); next(error); }
});

router.patch('/:id/toggle', async (req, res, next) => {
  try {
    const active = req.body?.active === true || req.body?.active === 1 || req.body?.active === '1';
    const row = await req.tdb.get('UPDATE {s}.promotions SET active=$1,updated_at=now() WHERE id=$2 RETURNING active', [active ? 1 : 0, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Promoción no encontrada' });
    res.json({ ok: true, active: Boolean(Number(row.active)) });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await req.tdb.tx(async (tx) => {
      await tx.run('DELETE FROM {s}.promotion_products WHERE promotion_id=$1', [req.params.id]);
      await tx.run('DELETE FROM {s}.promotion_categories WHERE promotion_id=$1', [req.params.id]);
      await tx.run('DELETE FROM {s}.promotions WHERE id=$1', [req.params.id]);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
