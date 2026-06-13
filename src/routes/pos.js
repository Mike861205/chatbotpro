const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'mixed']);
const MOVEMENT_KINDS = new Set(['income', 'withdrawal', 'expense']);
const TZ = 'America/Mexico_City';
const SALES_HISTORY_FILTERS = new Set(['today', 'week', 'month', 'custom']);

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function sameMoney(a, b) {
  return Math.abs(n(a) - n(b)) < 0.01;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeIsoDate(value) {
  const date = String(value || '').trim();
  if (!date) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
}

async function getOpenSession(t) {
  return t.get(
    `SELECT id, status, opening_amount::float AS opening_amount, closing_amount::float AS closing_amount,
            expected_amount::float AS expected_amount, difference_amount::float AS difference_amount,
            notes, opened_by, closed_by,
            to_char(opened_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS closed_at
     FROM {s}.pos_sessions
     WHERE status = 'open'
     ORDER BY opened_at DESC
     LIMIT 1`
  );
}

async function getLastClosedSession(t) {
  return t.get(
    `SELECT id, status, opening_amount::float AS opening_amount, closing_amount::float AS closing_amount,
            expected_amount::float AS expected_amount, difference_amount::float AS difference_amount,
            notes, opened_by, closed_by,
            to_char(opened_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS closed_at
     FROM {s}.pos_sessions
     WHERE status = 'closed'
     ORDER BY closed_at DESC NULLS LAST
     LIMIT 1`
  );
}

async function getSessionTotals(t, sessionId) {
  const sales = await t.get(
    `SELECT COUNT(*)::int AS tickets,
            COALESCE(SUM(total), 0)::float AS total_sales,
            COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0)::float AS sales_cash_only,
            COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0)::float AS sales_card_only,
            COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN total ELSE 0 END), 0)::float AS sales_transfer_only,
            COALESCE(SUM(CASE WHEN payment_method = 'mixed' THEN total ELSE 0 END), 0)::float AS sales_mixed,
            COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total WHEN payment_method = 'mixed' THEN COALESCE((payment_breakdown::jsonb ->> 'cash')::numeric, 0) ELSE 0 END), 0)::float AS collected_cash,
            COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total WHEN payment_method = 'mixed' THEN COALESCE((payment_breakdown::jsonb ->> 'card')::numeric, 0) ELSE 0 END), 0)::float AS collected_card,
            COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN total WHEN payment_method = 'mixed' THEN COALESCE((payment_breakdown::jsonb ->> 'transfer')::numeric, 0) ELSE 0 END), 0)::float AS collected_transfer
     FROM {s}.orders
     WHERE channel = 'pos' AND pos_session_id = $1 AND status != 'cancelado'`,
    [sessionId]
  );
  const canceled = await t.get(
    `SELECT COUNT(*)::int AS canceled_tickets,
            COALESCE(SUM(total), 0)::float AS canceled_total
     FROM {s}.orders
     WHERE channel = 'pos' AND pos_session_id = $1 AND status = 'cancelado'`,
    [sessionId]
  );
  const moves = await t.get(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END), 0)::float AS incomes,
            COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN amount ELSE 0 END), 0)::float AS withdrawals,
            COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0)::float AS expenses
     FROM {s}.pos_cash_movements
     WHERE session_id = $1`,
    [sessionId]
  );
  return {
    tickets: Number(sales?.tickets || 0),
    totalSales: n(sales?.total_sales),
    salesByMethod: {
      cash: n(sales?.sales_cash_only),
      card: n(sales?.sales_card_only),
      transfer: n(sales?.sales_transfer_only),
      mixed: n(sales?.sales_mixed),
    },
    collected: {
      cash: n(sales?.collected_cash),
      card: n(sales?.collected_card),
      transfer: n(sales?.collected_transfer),
    },
    movements: {
      income: n(moves?.incomes),
      withdrawal: n(moves?.withdrawals),
      expense: n(moves?.expenses),
    },
    cancellations: {
      tickets: Number(canceled?.canceled_tickets || 0),
      total: n(canceled?.canceled_total),
    },
  };
}

function expectedCashForSession(session, totals) {
  return n(session.opening_amount) + totals.collected.cash + totals.movements.income - totals.movements.withdrawal - totals.movements.expense;
}

async function listRecentSales(t, sessionId = null) {
  const params = [];
  let where = `WHERE channel = 'pos'`;
  if (sessionId) {
    params.push(sessionId);
    where += ` AND pos_session_id = $${params.length}`;
  }
  params.push(15);
  const rows = await t.all(
    `SELECT id, total::float AS total, status, payment_method, payment_breakdown, cash_received::float AS cash_received,
            cash_change::float AS cash_change, notes, items,
            to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.orders
     ${where}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => ({
    ...row,
    items: JSON.parse(row.items || '[]'),
    payment_breakdown: row.payment_breakdown ? JSON.parse(row.payment_breakdown) : null,
  }));
}

async function listSalesHistoryPage(t, options = {}) {
  const {
    page = 1,
    filter = 'today',
    startDate = null,
    endDate = null,
  } = options;
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = 10;
  const safeFilter = SALES_HISTORY_FILTERS.has(filter) ? filter : 'today';
  const localCreatedAt = `(created_at AT TIME ZONE '${TZ}')`;

  const params = [];
  const where = [`channel = 'pos'`];

  if (safeFilter === 'today') {
    where.push(`${localCreatedAt}::date = (now() AT TIME ZONE '${TZ}')::date`);
  }

  if (safeFilter === 'week') {
    where.push(
      `${localCreatedAt} >= date_trunc('week', now() AT TIME ZONE '${TZ}')`,
      `${localCreatedAt} < date_trunc('week', now() AT TIME ZONE '${TZ}') + INTERVAL '1 week'`
    );
  }

  if (safeFilter === 'month') {
    where.push(
      `${localCreatedAt} >= date_trunc('month', now() AT TIME ZONE '${TZ}')`,
      `${localCreatedAt} < date_trunc('month', now() AT TIME ZONE '${TZ}') + INTERVAL '1 month'`
    );
  }

  if (safeFilter === 'custom') {
    if (!startDate || !endDate) {
      throw badRequest('Selecciona fecha inicial y fecha final para el rango personalizado');
    }
    if (startDate > endDate) {
      throw badRequest('La fecha inicial no puede ser mayor a la fecha final');
    }
    params.push(startDate);
    where.push(`${localCreatedAt}::date >= $${params.length}::date`);
    params.push(endDate);
    where.push(`${localCreatedAt}::date <= $${params.length}::date`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const totalRow = await t.get(`SELECT COUNT(*)::int AS c FROM {s}.orders ${whereSql}`, params);
  const total = Number(totalRow?.c || 0);
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const boundedPage = Math.min(safePage, totalPages);
  const offset = (boundedPage - 1) * safeSize;

  const rows = await t.all(
    `SELECT id, total::float AS total, status, payment_method, payment_breakdown, cash_received::float AS cash_received,
            cash_change::float AS cash_change, notes, items,
            to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.orders
     ${whereSql}
     ORDER BY id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeSize, offset]
  );

  return {
    rows: rows.map((row) => ({
      ...row,
      items: JSON.parse(row.items || '[]'),
      payment_breakdown: row.payment_breakdown ? JSON.parse(row.payment_breakdown) : null,
    })),
    page: boundedPage,
    pageSize: safeSize,
    total,
    totalPages,
    filter: safeFilter,
    startDate,
    endDate,
  };
}

async function listRecentMovements(t, sessionId) {
  if (!sessionId) return [];
  return t.all(
    `SELECT id, kind, amount::float AS amount, note, created_by,
            to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.pos_cash_movements
     WHERE session_id = $1
     ORDER BY id DESC LIMIT 20`,
    [sessionId]
  );
}

function normalizePayment(method, paymentInput, total, cashReceivedInput) {
  const breakdown = {
    cash: 0,
    card: 0,
    transfer: 0,
  };
  let cashReceived = 0;
  let cashChange = 0;

  if (!PAYMENT_METHODS.has(method)) throw new Error('Método de pago inválido');

  if (method === 'cash') {
    breakdown.cash = n(total);
    cashReceived = Math.max(n(cashReceivedInput), n(total));
    if (cashReceived < n(total)) throw new Error('El efectivo recibido no cubre el total');
    cashChange = n(cashReceived - total);
    return { method, breakdown, cashReceived, cashChange };
  }

  if (method === 'card') {
    breakdown.card = n(total);
    return { method, breakdown, cashReceived: 0, cashChange: 0 };
  }

  if (method === 'transfer') {
    breakdown.transfer = n(total);
    return { method, breakdown, cashReceived: 0, cashChange: 0 };
  }

  breakdown.cash = n(paymentInput?.cash);
  breakdown.card = n(paymentInput?.card);
  breakdown.transfer = n(paymentInput?.transfer);
  const used = [breakdown.cash, breakdown.card, breakdown.transfer].filter((value) => value > 0).length;
  const paid = n(breakdown.cash + breakdown.card + breakdown.transfer);
  if (used < 2) throw new Error('El pago mixto debe usar al menos dos medios de pago');
  if (!sameMoney(paid, total)) throw new Error('La suma de pagos no coincide con el total de la venta');
  if (breakdown.cash > 0) {
    cashReceived = Math.max(n(cashReceivedInput), breakdown.cash);
    if (cashReceived < breakdown.cash) throw new Error('El efectivo recibido no cubre la parte en efectivo');
    cashChange = n(cashReceived - breakdown.cash);
  }
  return { method, breakdown, cashReceived, cashChange };
}

router.get('/overview', async (req, res, next) => {
  try {
    const categories = await req.tdb.all('SELECT id, name, sort FROM {s}.categories ORDER BY sort, name');
    const products = await req.tdb.all(
      `SELECT p.id, p.category_id, p.name, p.description, p.price::float AS price, p.image, c.name AS category_name
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY COALESCE(c.sort, 0), c.name NULLS FIRST, p.name`
    );
    const session = await getOpenSession(req.tdb);
    const sessionTotals = session ? await getSessionTotals(req.tdb, session.id) : null;
    const activeSession = session
      ? {
          ...session,
          totals: sessionTotals,
          expectedCash: expectedCashForSession(session, sessionTotals),
        }
      : null;
    const lastClosedSession = await getLastClosedSession(req.tdb);

    res.json({
      categories,
      products,
      activeSession,
      lastClosedSession,
      recentSales: await listRecentSales(req.tdb, activeSession?.id || null),
      recentMovements: await listRecentMovements(req.tdb, activeSession?.id || null),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/sales-history', async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const filter = String(req.query.filter || 'today').trim();
    const startDate = normalizeIsoDate(req.query.startDate);
    const endDate = normalizeIsoDate(req.query.endDate);
    if (req.query.startDate && !startDate) throw badRequest('La fecha inicial no es válida');
    if (req.query.endDate && !endDate) throw badRequest('La fecha final no es válida');
    const data = await listSalesHistoryPage(req.tdb, { page, filter, startDate, endDate });
    res.json(data);
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.post('/session/open', async (req, res, next) => {
  try {
    const existing = await getOpenSession(req.tdb);
    if (existing) return res.status(409).json({ error: 'Ya hay una caja abierta' });
    const openingAmount = n(req.body?.openingAmount);
    const notes = String(req.body?.notes || '').trim().slice(0, 240);
    const row = await req.tdb.get(
      `INSERT INTO {s}.pos_sessions (status, opening_amount, notes, opened_by)
       VALUES ('open', $1, $2, $3)
       RETURNING id`,
      [openingAmount, notes, req.user.username]
    );
    const session = await getOpenSession(req.tdb);
    res.json({ ok: true, sessionId: row.id, activeSession: { ...session, totals: await getSessionTotals(req.tdb, row.id), expectedCash: openingAmount } });
  } catch (e) {
    next(e);
  }
});

router.post('/session/close', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb);
    if (!session) return res.status(400).json({ error: 'No hay una caja abierta' });
    const totals = await getSessionTotals(req.tdb, session.id);
    const expectedAmount = expectedCashForSession(session, totals);
    const closingAmount = n(req.body?.closingAmount);
    const notes = String(req.body?.notes || '').trim().slice(0, 240);
    const differenceAmount = n(closingAmount - expectedAmount);
    await req.tdb.run(
      `UPDATE {s}.pos_sessions
       SET status = 'closed', closing_amount = $1, expected_amount = $2, difference_amount = $3,
           notes = CASE WHEN COALESCE(notes, '') = '' THEN $4 ELSE notes || E'\n' || $4 END,
           closed_by = $5, closed_at = now()
       WHERE id = $6`,
      [closingAmount, expectedAmount, differenceAmount, notes, req.user.username, session.id]
    );
    const closed = await getLastClosedSession(req.tdb);
    res.json({
      ok: true,
      closedSession: closed,
      totals,
      expectedAmount,
      closingAmount,
      differenceAmount,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/movements', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb);
    if (!session) return res.status(400).json({ error: 'Abre una caja antes de registrar movimientos' });
    const kind = String(req.body?.kind || '').trim();
    const amount = n(req.body?.amount);
    const note = String(req.body?.note || '').trim().slice(0, 240);
    if (!MOVEMENT_KINDS.has(kind)) return res.status(400).json({ error: 'Tipo de movimiento inválido' });
    if (amount <= 0) return res.status(400).json({ error: 'El monto debe ser mayor a cero' });
    await req.tdb.run(
      'INSERT INTO {s}.pos_cash_movements (session_id, kind, amount, note, created_by) VALUES ($1, $2, $3, $4, $5)',
      [session.id, kind, amount, note, req.user.username]
    );
    const totals = await getSessionTotals(req.tdb, session.id);
    res.json({ ok: true, totals, expectedCash: expectedCashForSession(session, totals), recentMovements: await listRecentMovements(req.tdb, session.id) });
  } catch (e) {
    next(e);
  }
});

async function createPosSale(req, res, next) {
  try {
    const session = await getOpenSession(req.tdb);
    if (!session) return res.status(400).json({ error: 'Abre una caja antes de registrar una venta' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Agrega al menos un producto al ticket' });
    const ids = [...new Set(items.map((item) => Number(item.productId)).filter((id) => Number.isInteger(id) && id > 0))];
    if (!ids.length) return res.status(400).json({ error: 'Los productos del ticket no son válidos' });
    const rows = await req.tdb.all(
      `SELECT id, name, price::float AS price, active, category_id
       FROM {s}.products
       WHERE id = ANY($1::int[])`,
      [ids]
    );
    const byId = new Map(rows.map((row) => [Number(row.id), row]));
    const saleItems = items.map((item) => {
      const product = byId.get(Number(item.productId));
      const qty = Number(item.qty);
      if (!product || !product.active) throw new Error('Uno de los productos ya no está disponible');
      if (!Number.isInteger(qty) || qty <= 0) throw new Error('La cantidad de un producto es inválida');
      return {
        id: product.id,
        name: product.name,
        price: n(product.price),
        qty,
      };
    });
    const subtotal = n(saleItems.reduce((sum, item) => sum + item.price * item.qty, 0));
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const payment = normalizePayment(paymentMethod, req.body?.payments || {}, subtotal, req.body?.cashReceived);
    const notes = String(req.body?.notes || '').trim().slice(0, 240);
    const row = await req.tdb.get(
      `INSERT INTO {s}.orders
       (customer_id, items, subtotal, total, status, channel, delivery, notes, payment_method, payment_breakdown, cash_received, cash_change, pos_session_id)
       VALUES (NULL, $1, $2, $3, 'entregado', 'pos', 'mostrador', $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        JSON.stringify(saleItems),
        subtotal,
        subtotal,
        notes,
        payment.method,
        JSON.stringify(payment.breakdown),
        payment.cashReceived || null,
        payment.cashChange || null,
        session.id,
      ]
    );
    const totals = await getSessionTotals(req.tdb, session.id);
    res.json({
      ok: true,
      sale: {
        id: row.id,
        total: subtotal,
        items: saleItems,
        paymentMethod: payment.method,
        paymentBreakdown: payment.breakdown,
        cashReceived: payment.cashReceived,
        cashChange: payment.cashChange,
        notes,
      },
      totals,
      expectedCash: expectedCashForSession(session, totals),
      recentSales: await listRecentSales(req.tdb, session.id),
    });
  } catch (e) {
    if (e.message) return res.status(400).json({ error: e.message });
    next(e);
  }
}

router.post('/sales/:id/cancel', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Venta inválida' });
    const sale = await req.tdb.get(
      `SELECT id, status, notes, pos_session_id
       FROM {s}.orders
       WHERE id = $1 AND channel = 'pos'
       LIMIT 1`,
      [id]
    );
    if (!sale) return res.status(404).json({ error: 'No se encontró la venta POS' });
    if (sale.status === 'cancelado') return res.status(409).json({ error: 'La venta ya está cancelada' });

    const reason = String(req.body?.reason || '').trim().slice(0, 180);
    const stamp = new Date().toLocaleString('es-MX', { timeZone: TZ });
    const cancelText = reason
      ? `[CANCELADO ${stamp}] ${reason}`
      : `[CANCELADO ${stamp}] Cancelación manual en caja`;
    await req.tdb.run(
      `UPDATE {s}.orders
       SET status = 'cancelado',
           notes = CASE
             WHEN COALESCE(notes, '') = '' THEN $1
             ELSE notes || E'\n' || $1
           END
       WHERE id = $2`,
      [cancelText, id]
    );

    const totals = sale.pos_session_id ? await getSessionTotals(req.tdb, sale.pos_session_id) : null;
    res.json({ ok: true, saleId: id, totals });
  } catch (e) {
    next(e);
  }
});

router.put('/sales/:id/payment', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Venta inválida' });
    const sale = await req.tdb.get(
      `SELECT id, total::float AS total, status, pos_session_id
       FROM {s}.orders
       WHERE id = $1 AND channel = 'pos'
       LIMIT 1`,
      [id]
    );
    if (!sale) return res.status(404).json({ error: 'No se encontró la venta POS' });
    if (sale.status === 'cancelado') return res.status(409).json({ error: 'No se puede cambiar pago de una venta cancelada' });

    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const payment = normalizePayment(paymentMethod, req.body?.payments || {}, n(sale.total), req.body?.cashReceived);
    await req.tdb.run(
      `UPDATE {s}.orders
       SET payment_method = $1,
           payment_breakdown = $2,
           cash_received = $3,
           cash_change = $4
       WHERE id = $5`,
      [
        payment.method,
        JSON.stringify(payment.breakdown),
        payment.cashReceived || null,
        payment.cashChange || null,
        id,
      ]
    );

    const updated = await req.tdb.get(
      `SELECT id, total::float AS total, status, payment_method, payment_breakdown,
              cash_received::float AS cash_received, cash_change::float AS cash_change,
              notes, items,
              to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at
       FROM {s}.orders
       WHERE id = $1`,
      [id]
    );
    const totals = sale.pos_session_id ? await getSessionTotals(req.tdb, sale.pos_session_id) : null;
    res.json({
      ok: true,
      sale: {
        ...updated,
        items: JSON.parse(updated.items || '[]'),
        payment_breakdown: updated.payment_breakdown ? JSON.parse(updated.payment_breakdown) : null,
      },
      totals,
    });
  } catch (e) {
    if (e.message) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.post('/sales', createPosSale);
router.post('/checkout', createPosSale);

module.exports = router;