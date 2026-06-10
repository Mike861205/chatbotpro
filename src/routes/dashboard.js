const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/stats', (req, res) => {
  const db = req.tdb;
  const today = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales FROM orders
       WHERE date(created_at) = date('now','localtime') AND status != 'cancelado'`
    )
    .get();
  const totals = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS sales FROM orders WHERE status != 'cancelado'`)
    .get();
  const pending = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'pendiente'`).get().c;
  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products WHERE active = 1').get().c;

  // Ventas últimos 7 días
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total),0) AS sales, COUNT(*) AS count FROM orders
         WHERE date(created_at) = date('now','localtime', ?) AND status != 'cancelado'`
      )
      .get(`-${i} day`);
    const d = new Date();
    d.setDate(d.getDate() - i);
    last7.push({
      day: d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' }),
      sales: row.sales,
      count: row.count,
    });
  }

  // Top productos (agregado desde items JSON)
  const counts = {};
  for (const o of db.prepare(`SELECT items FROM orders WHERE status != 'cancelado'`).all()) {
    for (const it of JSON.parse(o.items || '[]')) {
      counts[it.name] = (counts[it.name] || 0) + (it.qty || 1);
    }
  }
  const topProducts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  // Distribución por estatus
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all();

  res.json({
    today,
    totals,
    pending,
    productCount,
    last7,
    topProducts,
    byStatus,
  });
});

module.exports = router;
