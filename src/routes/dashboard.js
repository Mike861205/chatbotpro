const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

const TZ = 'America/Mexico_City';

const PERIOD_META = {
  day: {
    key: 'day',
    salesLabel: 'Ventas de hoy',
    ordersLabel: 'Pedidos de hoy',
    chartTitle: 'Ventas por hora',
    topTitle: 'Más vendidos de hoy',
    whereSql: `(created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`,
    seriesSql: `SELECT bucket,
                       COALESCE(SUM(o.total),0)::float AS sales,
                       COUNT(o.id)::int AS count
                FROM generate_series(
                       date_trunc('day', now() AT TIME ZONE '${TZ}'),
                       date_trunc('day', now() AT TIME ZONE '${TZ}') + interval '23 hour',
                       interval '1 hour'
                     ) bucket
                LEFT JOIN {s}.orders o
                  ON date_trunc('hour', o.created_at AT TIME ZONE '${TZ}') = bucket
                 AND o.status != 'cancelado'
                GROUP BY bucket
                ORDER BY bucket`,
  },
  week: {
    key: 'week',
    salesLabel: 'Ventas de la semana',
    ordersLabel: 'Pedidos de la semana',
    chartTitle: 'Ventas de la semana',
    topTitle: 'Más vendidos de la semana',
    whereSql: `(created_at AT TIME ZONE '${TZ}') >= date_trunc('week', now() AT TIME ZONE '${TZ}')
      AND (created_at AT TIME ZONE '${TZ}') < date_trunc('week', now() AT TIME ZONE '${TZ}') + interval '1 week'`,
    seriesSql: `SELECT bucket,
                       COALESCE(SUM(o.total),0)::float AS sales,
                       COUNT(o.id)::int AS count
                FROM generate_series(
                       date_trunc('week', now() AT TIME ZONE '${TZ}'),
                       date_trunc('week', now() AT TIME ZONE '${TZ}') + interval '6 day',
                       interval '1 day'
                     ) bucket
                LEFT JOIN {s}.orders o
                  ON (o.created_at AT TIME ZONE '${TZ}')::date = bucket::date
                 AND o.status != 'cancelado'
                GROUP BY bucket
                ORDER BY bucket`,
  },
  month: {
    key: 'month',
    salesLabel: 'Ventas del mes',
    ordersLabel: 'Pedidos del mes',
    chartTitle: 'Ventas del mes',
    topTitle: 'Más vendidos del mes',
    whereSql: `(created_at AT TIME ZONE '${TZ}') >= date_trunc('month', now() AT TIME ZONE '${TZ}')
      AND (created_at AT TIME ZONE '${TZ}') < date_trunc('month', now() AT TIME ZONE '${TZ}') + interval '1 month'`,
    seriesSql: `SELECT bucket,
                       COALESCE(SUM(o.total),0)::float AS sales,
                       COUNT(o.id)::int AS count
                FROM generate_series(
                       date_trunc('month', now() AT TIME ZONE '${TZ}'),
                       date_trunc('month', now() AT TIME ZONE '${TZ}') + interval '1 month' - interval '1 day',
                       interval '1 day'
                     ) bucket
                LEFT JOIN {s}.orders o
                  ON (o.created_at AT TIME ZONE '${TZ}')::date = bucket::date
                 AND o.status != 'cancelado'
                GROUP BY bucket
                ORDER BY bucket`,
  },
  year: {
    key: 'year',
    salesLabel: 'Ventas del año',
    ordersLabel: 'Pedidos del año',
    chartTitle: 'Ventas del año',
    topTitle: 'Más vendidos del año',
    whereSql: `(created_at AT TIME ZONE '${TZ}') >= date_trunc('year', now() AT TIME ZONE '${TZ}')
      AND (created_at AT TIME ZONE '${TZ}') < date_trunc('year', now() AT TIME ZONE '${TZ}') + interval '1 year'`,
    seriesSql: `SELECT bucket,
                       COALESCE(SUM(o.total),0)::float AS sales,
                       COUNT(o.id)::int AS count
                FROM generate_series(
                       date_trunc('year', now() AT TIME ZONE '${TZ}'),
                       date_trunc('year', now() AT TIME ZONE '${TZ}') + interval '11 month',
                       interval '1 month'
                     ) bucket
                LEFT JOIN {s}.orders o
                  ON date_trunc('month', o.created_at AT TIME ZONE '${TZ}') = bucket
                 AND o.status != 'cancelado'
                GROUP BY bucket
                ORDER BY bucket`,
  },
};

function normalizePeriod(value) {
  return PERIOD_META[value] ? value : 'day';
}

function formatSeriesLabel(period, value) {
  const date = new Date(value);
  const common = { timeZone: 'UTC' };
  if (period === 'day') {
    return date.toLocaleTimeString('es-MX', { ...common, hour: '2-digit', minute: '2-digit' });
  }
  if (period === 'year') {
    return date.toLocaleDateString('es-MX', { ...common, month: 'short' });
  }
  return date.toLocaleDateString('es-MX', { ...common, weekday: 'short', day: 'numeric' });
}

router.get('/stats', async (req, res, next) => {
  try {
    const t = req.tdb;
    const period = normalizePeriod(String(req.query.period || 'day'));
    const meta = PERIOD_META[period];

    const today = await t.get(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::float AS sales
       FROM {s}.orders
       WHERE ${meta.whereSql}
         AND status != 'cancelado'`
    );
    const totals = await t.get(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::float AS sales FROM {s}.orders WHERE status != 'cancelado'`
    );
    const pending = (await t.get(`SELECT COUNT(*)::int AS c FROM {s}.orders WHERE status = 'pendiente' AND ${meta.whereSql}`)).c;
    const productCount = (await t.get('SELECT COUNT(*)::int AS c FROM {s}.products WHERE active = 1')).c;
    const customerCount = (await t.get('SELECT COUNT(*)::int AS c FROM {s}.customers')).c;
    const avgTicket = today.count ? today.sales / today.count : 0;

    const last7raw = await t.all(meta.seriesSql);
    const last7 = last7raw.map((r) => ({
      day: formatSeriesLabel(period, r.bucket),
      sales: r.sales,
      count: r.count,
    }));

    const counts = {};
    for (const o of await t.all(`SELECT items FROM {s}.orders WHERE status != 'cancelado' AND ${meta.whereSql}`)) {
      for (const it of JSON.parse(o.items || '[]')) {
        counts[it.name] = (counts[it.name] || 0) + (it.qty || 1);
      }
    }
    const topProducts = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    const byStatus = await t.all(`SELECT status, COUNT(*)::int AS c FROM {s}.orders WHERE ${meta.whereSql} GROUP BY status`);

    res.json({ today, totals, pending, productCount, customerCount, avgTicket, last7, topProducts, byStatus, period: meta });
  } catch (e) { next(e); }
});

module.exports = router;
