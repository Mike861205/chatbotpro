const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['pendiente', 'confirmado', 'preparando', 'enviado', 'entregado', 'cancelado'];

function decorate(req, o) {
  const customer = o.customer_id
    ? req.tdb.prepare('SELECT * FROM customers WHERE id = ?').get(o.customer_id)
    : null;
  return {
    ...o,
    items: JSON.parse(o.items || '[]'),
    customer: customer
      ? {
          name: decrypt(customer.name_enc) || 'Cliente',
          phone: decrypt(customer.phone_enc) || '',
          address: decrypt(customer.address_enc) || '',
        }
      : null,
  };
}

router.get('/', (req, res) => {
  const { status, limit } = req.query;
  let sql = 'SELECT * FROM orders';
  const params = [];
  if (status && STATUSES.includes(status)) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 100, 500));
  res.json(req.tdb.prepare(sql).all(...params).map((o) => decorate(req, o)));
});

router.patch('/:id', (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estatus inválido' });
  const r = req.tdb.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ ok: true });
});

module.exports = router;
