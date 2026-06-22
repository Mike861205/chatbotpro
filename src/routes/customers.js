const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

function decodeCustomerField(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const dec = decrypt(raw);
  if (dec && String(dec).trim()) return String(dec).trim();
  // Compatibilidad con datos legacy que pudieron guardarse sin cifrar.
  return raw;
}

router.get('/', async (req, res, next) => {
  try {
    const { startDate, endDate, sort } = req.query;
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 10), 1000);

    const validDate = /^\d{4}-\d{2}-\d{2}$/;
    const dateFilters = [`channel = 'chatbot'`];
    const params = [];

    if (startDate && validDate.test(String(startDate))) {
      params.push(String(startDate));
      dateFilters.push(`(created_at AT TIME ZONE 'America/Mexico_City')::date >= $${params.length}::date`);
    }
    if (endDate && validDate.test(String(endDate))) {
      params.push(String(endDate));
      dateFilters.push(`(created_at AT TIME ZONE 'America/Mexico_City')::date <= $${params.length}::date`);
    }

    const sortMap = {
      orders_desc: 'orders_count DESC, total_spent DESC, last_order_raw DESC NULLS LAST',
      orders_asc: 'orders_count ASC, total_spent ASC, last_order_raw DESC NULLS LAST',
      amount_desc: 'total_spent DESC, orders_count DESC, last_order_raw DESC NULLS LAST',
      recent_desc: 'last_order_raw DESC NULLS LAST, orders_count DESC, total_spent DESC',
      name_asc: 'customer_name ASC, orders_count DESC, total_spent DESC',
    };
    const orderBy = sortMap[String(sort || '')] || sortMap.orders_desc;

    params.push(limit);
    const rows = await req.tdb.all(
      `WITH filtered_orders AS (
         SELECT id, customer_id, total, created_at
         FROM {s}.orders
         WHERE ${dateFilters.join(' AND ')}
       )
       SELECT
         c.id,
         c.name_enc,
         c.phone_enc,
         to_char(c.created_at AT TIME ZONE 'America/Mexico_City', 'DD Mon YYYY') AS customer_since,
         COUNT(fo.id)::int AS orders_count,
         COALESCE(SUM(fo.total), 0)::float AS total_spent,
         MAX(fo.created_at) AS last_order_raw,
         to_char(MAX(fo.created_at) AT TIME ZONE 'America/Mexico_City', 'DD Mon YYYY, HH24:MI') AS last_order_at,
         lower(coalesce(c.name_enc, '')) AS customer_name
       FROM {s}.customers c
       LEFT JOIN filtered_orders fo ON fo.customer_id = c.id
       GROUP BY c.id, c.name_enc, c.phone_enc, c.created_at
       HAVING COUNT(fo.id) > 0
       ORDER BY ${orderBy}
       LIMIT $${params.length}`,
      params
    );

    const customers = rows.map((row) => ({
      id: Number(row.id),
      name: decodeCustomerField(row.name_enc, 'Cliente'),
      phone: decodeCustomerField(row.phone_enc, ''),
      customer_since: row.customer_since || '',
      orders_count: Number(row.orders_count || 0),
      total_spent: Number(row.total_spent || 0),
      last_order_at: row.last_order_at || '',
    }));

    res.json(customers);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
