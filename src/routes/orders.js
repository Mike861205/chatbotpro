const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

const STATUSES = ['pendiente', 'confirmado', 'preparando', 'enviado', 'entregado', 'cancelado'];

async function decorate(t, o) {
  const customer = o.customer_id
    ? await t.get('SELECT * FROM {s}.customers WHERE id = $1', [o.customer_id])
    : null;
  return {
    ...o,
    subtotal: Number(o.subtotal || 0),
    total: Number(o.total),
    delivery_fee: Number(o.delivery_fee || 0),
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

router.get('/', async (req, res, next) => {
  try {
    const { status, limit } = req.query;
      let sql = `SELECT id, customer_id, items, subtotal::float AS subtotal, total::float AS total,
        delivery_fee::float AS delivery_fee, delivery_zone_name, cancel_note, status, channel, delivery, notes,
        pickup_branch_name, customer_location_lat, customer_location_lng, customer_location_text,
        customer_location_resolved,
                      to_char(created_at AT TIME ZONE 'America/Mexico_City', 'DD Mon YYYY, HH24:MI') AS created_at
               FROM {s}.orders`;
    const params = [];
    if (status && STATUSES.includes(status)) {
      params.push(status);
      sql += ` WHERE status = $${params.length}`;
    }
    params.push(Math.min(Number(limit) || 100, 500));
    sql += ` ORDER BY id DESC LIMIT $${params.length}`;
    const rows = await req.tdb.all(sql, params);
    res.json(await Promise.all(rows.map((o) => decorate(req.tdb, o))));
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { status, cancel_note } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estatus inválido' });

    if (status === 'cancelado') {
      const note = String(cancel_note || '').trim();
      if (note.length < 3) return res.status(400).json({ error: 'Escribe un motivo de cancelación válido' });
      const r = await req.tdb.run('UPDATE {s}.orders SET status = $1, cancel_note = $2 WHERE id = $3', [status, note.slice(0, 280), req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.json({ ok: true });
    }

    const r = await req.tdb.run('UPDATE {s}.orders SET status = $1, cancel_note = NULL WHERE id = $2', [status, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
