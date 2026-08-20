const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');
const { ensurePurchasingSchema } = require('../utils/purchasing');
const { ensureBranchStockSchema, initializeBranchStock, applyBranchSaleStock, restoreBranchSaleStock } = require('../utils/branchStock');
const { operationalOrderNote } = require('../utils/orderNotes');

const router = express.Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  try {
    await ensurePurchasingSchema(req.tdb);
    await ensureBranchStockSchema(req.tdb);
    await initializeBranchStock(req.tdb, req.user?.username || 'system');
    next();
  } catch (error) {
    next(error);
  }
});

const STATUSES = ['pendiente', 'confirmado', 'preparando', 'enviado', 'entregado', 'cancelado'];

async function decorate(t, o) {
  const customer = o.customer_id
    ? await t.get('SELECT * FROM {s}.customers WHERE id = $1', [o.customer_id])
    : null;
  return {
    ...o,
    delivery_address: String(o.delivery_address || (customer ? decrypt(customer.address_enc) : '') || ''),
    delivery_neighborhood: String(o.delivery_neighborhood || ''),
    delivery_reference: String(o.delivery_reference || (o.channel === 'chatbot' ? o.notes : '') || ''),
    order_note: operationalOrderNote(o),
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
    const { status, limit, todayOnly, startDate, endDate } = req.query;
    let sql = `SELECT id, customer_id, items, subtotal::float AS subtotal, total::float AS total,
      delivery_fee::float AS delivery_fee, delivery_zone_name, receiving_mode_label, receiving_mode_behavior, delivery_address, delivery_neighborhood, delivery_reference, cancel_note, status, channel, delivery, notes, order_notes, payment_method,
        pickup_branch_name, service_branch_name, customer_location_lat, customer_location_lng, customer_location_text,
        customer_location_resolved,
                      to_char(created_at AT TIME ZONE '${req.timezone}', 'DD Mon YYYY, HH24:MI') AS created_at
               FROM {s}.orders`;
    const params = [];
    const where = ["channel <> 'table_account'"];

    if (req.user?.role === 'cashier') {
      if (req.user.branchId) {
        params.push(Number(req.user.branchId));
        where.push(`COALESCE(service_branch_id, pickup_branch_id) = $${params.length}`);
      } else {
        where.push('COALESCE(service_branch_id, pickup_branch_id) IS NULL');
      }
    }

    if (status && STATUSES.includes(status)) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const isTodayOnly = String(todayOnly || '').toLowerCase() === '1' || String(todayOnly || '').toLowerCase() === 'true';
    if (isTodayOnly) {
      where.push(`(created_at AT TIME ZONE '${req.timezone}')::date = (now() AT TIME ZONE '${req.timezone}')::date`);
    } else {
      const validDate = /^\d{4}-\d{2}-\d{2}$/;
      if (startDate && validDate.test(String(startDate))) {
        params.push(String(startDate));
        where.push(`(created_at AT TIME ZONE '${req.timezone}')::date >= $${params.length}::date`);
      }
      if (endDate && validDate.test(String(endDate))) {
        params.push(String(endDate));
        where.push(`(created_at AT TIME ZONE '${req.timezone}')::date <= $${params.length}::date`);
      }
    }

    if (where.length) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }

    params.push(Math.min(Number(limit) || 500, 500));
    sql += ` ORDER BY id DESC LIMIT $${params.length}`;
    const rows = await req.tdb.all(sql, params);
    res.json(await Promise.all(rows.map((o) => decorate(req.tdb, o))));
  } catch (e) { next(e); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { status, cancel_note } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Estatus inválido' });

    if (req.user?.role === 'cashier') {
      const existing = await req.tdb.get('SELECT id, service_branch_id, pickup_branch_id FROM {s}.orders WHERE id = $1', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Pedido no encontrado' });
      const orderBranch = existing.service_branch_id || existing.pickup_branch_id;
      if (req.user.branchId) {
        if (Number(orderBranch || 0) !== Number(req.user.branchId)) {
          return res.status(403).json({ error: 'No tienes permiso para modificar pedidos de otra sucursal' });
        }
      } else if (orderBranch != null) {
        return res.status(403).json({ error: 'No tienes permiso para modificar pedidos de otra sucursal' });
      }
    }

    if (status === 'cancelado') {
      const note = String(cancel_note || '').trim();
      if (note.length < 3) return res.status(400).json({ error: 'Escribe un motivo de cancelación válido' });
      const changed = await req.tdb.tx(async (tx) => {
        const order = await tx.get('SELECT id,status,items,service_branch_id,pickup_branch_id,branch_stock_applied FROM {s}.orders WHERE id=$1 FOR UPDATE', [req.params.id]);
        if (!order) return false;
        if (order.status !== 'cancelado' && Number(order.branch_stock_applied)) {
          await restoreBranchSaleStock(tx, order.service_branch_id || order.pickup_branch_id, order.items);
        }
        await tx.run('UPDATE {s}.orders SET status=$1,cancel_note=$2,branch_stock_applied=0 WHERE id=$3', [status, note.slice(0, 280), req.params.id]);
        return true;
      });
      if (!changed) return res.status(404).json({ error: 'Pedido no encontrado' });
      return res.json({ ok: true });
    }

    const changed = await req.tdb.tx(async (tx) => {
      const order = await tx.get('SELECT id,status,items,service_branch_id,pickup_branch_id,branch_stock_applied FROM {s}.orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!order) return false;
      let applied = Number(order.branch_stock_applied);
      if (order.status === 'cancelado' && !applied && await applyBranchSaleStock(tx, order.service_branch_id || order.pickup_branch_id, order.items)) {
        applied = 1;
      }
      await tx.run('UPDATE {s}.orders SET status=$1,cancel_note=NULL,branch_stock_applied=$2 WHERE id=$3', [status, applied, req.params.id]);
      return true;
    });
    if (!changed) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// Agrupa los ítems del pedido por áreas KDS configuradas
router.get('/:id/comanda-areas', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: 'ID de pedido inválido' });
    }

    // Obtener el pedido
    const orderRow = await req.tdb.get(
      `SELECT id, items, service_branch_id, pickup_branch_id FROM {s}.orders WHERE id = $1`,
      [orderId]
    );
    if (!orderRow) return res.status(404).json({ error: 'Pedido no encontrado' });

    let items = [];
    try { items = JSON.parse(orderRow.items || '[]'); } catch { items = []; }
    if (!Array.isArray(items)) items = [];

    // Obtener todas las áreas KDS activas con sus asignaciones
    const areaRows = await req.tdb.all(
      `SELECT a.id, a.name, a.color,
              COALESCE(array_agg(DISTINCT ac.category_id) FILTER (WHERE ac.category_id IS NOT NULL), '{}') AS category_ids,
              COALESCE(array_agg(DISTINCT ap.product_id)  FILTER (WHERE ap.product_id  IS NOT NULL), '{}') AS product_ids
       FROM {s}.kds_areas a
       LEFT JOIN {s}.kds_area_categories ac ON ac.area_id = a.id
       LEFT JOIN {s}.kds_area_products   ap ON ap.area_id = a.id
       WHERE a.active = 1
       GROUP BY a.id, a.name, a.color
       ORDER BY a.id ASC`
    );

    // Si no hay áreas configuradas → devolver todos los ítems como una sola comanda
    if (!areaRows || areaRows.length === 0) {
      return res.json({ areas: null, items });
    }

    // Obtener info de productos para resolver categoría
    const productIds = [...new Set(
      items.map((it) => Number(it?.id ?? it?.productId)).filter((id) => Number.isInteger(id) && id > 0)
    )];
    const productMap = new Map();
    if (productIds.length) {
      const products = await req.tdb.all(
        `SELECT id, category_id FROM {s}.products WHERE id = ANY($1::int[])`,
        [productIds]
      );
      products.forEach((p) => productMap.set(Number(p.id), Number(p.category_id)));
    }

    // Construir reglas de área
    const areas = areaRows.map((a) => ({
      id: Number(a.id),
      name: String(a.name),
      color: String(a.color || '#ff6b35'),
      categoryIds: new Set((a.category_ids || []).map(Number)),
      productIds: new Set((a.product_ids || []).map(Number)),
      items: [],
    }));

    const unassignedItems = [];

    for (const item of items) {
      const productId = Number(item?.id ?? item?.productId);
      const categoryId = productMap.get(productId);
      let assigned = false;

      for (const area of areas) {
        const byProduct  = Number.isInteger(productId) && productId > 0 && area.productIds.has(productId);
        const byCategory = Number.isInteger(categoryId) && area.categoryIds.has(categoryId);
        if (byProduct || byCategory) {
          area.items.push(item);
          assigned = true;
          break; // cada ítem va solo a la primera área que coincida
        }
      }

      if (!assigned) unassignedItems.push(item);
    }

    // Filtrar áreas sin ítems
    const activeAreas = areas
      .filter((a) => a.items.length > 0)
      .map(({ id, name, color, items: aItems }) => ({ id, name, color, items: aItems }));

    // Si hay ítems sin área asignada, agregar grupo "General"
    if (unassignedItems.length > 0) {
      activeAreas.push({ id: 0, name: 'General', color: '#6b7280', items: unassignedItems });
    }

    res.json({ areas: activeAreas, items });
  } catch (e) { next(e); }
});

module.exports = router;
