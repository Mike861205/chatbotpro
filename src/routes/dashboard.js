const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const TZ = 'America/Mexico_City';

router.get('/stats', async (req, res, next) => {
  try {
    const t = req.tdb;

    const today = await t.get(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::float AS sales
       FROM {s}.orders
       WHERE (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
         AND status != 'cancelado'`
    );
    const totals = await t.get(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::float AS sales FROM {s}.orders WHERE status != 'cancelado'`
    );
    const pending = (await t.get(`SELECT COUNT(*)::int AS c FROM {s}.orders WHERE status = 'pendiente'`)).c;
    const productCount = (await t.get('SELECT COUNT(*)::int AS c FROM {s}.products WHERE active = 1')).c;
    const customerCount = (await t.get('SELECT COUNT(*)::int AS c FROM {s}.customers')).c;
    const avgTicket = totals.count ? totals.sales / totals.count : 0;

    // Ventas de los últimos 7 días (una sola consulta)
    const last7raw = await t.all(
      `SELECT d::date AS day,
              COALESCE(SUM(o.total),0)::float AS sales,
              COUNT(o.id)::int AS count
       FROM generate_series((now() AT TIME ZONE '${TZ}')::date - 6, (now() AT TIME ZONE '${TZ}')::date, interval '1 day') d
       LEFT JOIN {s}.orders o
         ON (o.created_at AT TIME ZONE '${TZ}')::date = d::date AND o.status != 'cancelado'
       GROUP BY d ORDER BY d`
    );
    const last7 = last7raw.map((r) => ({
      day: new Date(r.day).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }),
      sales: r.sales,
      count: r.count,
    }));

    // Top productos (agregado desde items JSON)
    const counts = {};
    for (const o of await t.all(`SELECT items FROM {s}.orders WHERE status != 'cancelado'`)) {
      for (const it of JSON.parse(o.items || '[]')) {
        counts[it.name] = (counts[it.name] || 0) + (it.qty || 1);
      }
    }
    const topProducts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    const byStatus = await t.all('SELECT status, COUNT(*)::int AS c FROM {s}.orders GROUP BY status');

    res.json({ today, totals, pending, productCount, customerCount, avgTicket, last7, topProducts, byStatus });
  } catch (e) { next(e); }
});

module.exports = router;
