const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getSetting } = require('../db');
const { decrypt } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'mixed']);
const MOVEMENT_KINDS = new Set(['income', 'withdrawal', 'expense']);
const TZ = 'America/Mexico_City';
const SALES_HISTORY_FILTERS = new Set(['today', 'week', 'month', 'custom']);
const CHATBOT_IMPORTABLE_STATUSES = new Set(['pendiente', 'confirmado', 'preparando', 'enviado']);

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function normalizePublicMediaPath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value;
  return value.startsWith('/') ? value : `/${value.replace(/^\/+/, '')}`;
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

/**
 * Retorna la sesión abierta del usuario:
 * - Cajero: filtra por branch_id (su sucursal asignada).
 * - Admin/owner: filtra por opened_by (solo ve su propia sesión abierta).
 * Esto permite que varias sucursales tengan sesiones abiertas simultáneamente.
 */
async function getOpenSession(t, { forUsername = null, forBranchId = null } = {}) {
  const SEL = `SELECT id, status, opening_amount::float AS opening_amount, closing_amount::float AS closing_amount,
            expected_amount::float AS expected_amount, difference_amount::float AS difference_amount,
            branch_id, branch_name,
            notes, opened_by, closed_by,
            to_char(opened_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS closed_at
     FROM {s}.pos_sessions`;

  const branchId = Number.isInteger(Number(forBranchId)) && Number(forBranchId) > 0 ? Number(forBranchId) : null;
  if (branchId) {
    return t.get(`${SEL} WHERE status = 'open' AND branch_id = $1 ORDER BY opened_at DESC LIMIT 1`, [branchId]);
  }
  if (forUsername) {
    return t.get(`${SEL} WHERE status = 'open' AND opened_by = $1 ORDER BY opened_at DESC LIMIT 1`, [forUsername]);
  }
  return t.get(`${SEL} WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1`);
}

async function getLastClosedSession(t, { forUsername = null, forBranchId = null } = {}) {
  const SEL = `SELECT id, status, opening_amount::float AS opening_amount, closing_amount::float AS closing_amount,
            expected_amount::float AS expected_amount, difference_amount::float AS difference_amount,
            branch_id, branch_name,
            notes, opened_by, closed_by,
            to_char(opened_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS closed_at
     FROM {s}.pos_sessions`;

  const branchId = Number.isInteger(Number(forBranchId)) && Number(forBranchId) > 0 ? Number(forBranchId) : null;
  if (branchId) {
    return t.get(`${SEL} WHERE status = 'closed' AND branch_id = $1 ORDER BY closed_at DESC NULLS LAST LIMIT 1`, [branchId]);
  }
  if (forUsername) {
    return t.get(`${SEL} WHERE status = 'closed' AND opened_by = $1 ORDER BY closed_at DESC NULLS LAST LIMIT 1`, [forUsername]);
  }
  return t.get(`${SEL} WHERE status = 'closed' ORDER BY closed_at DESC NULLS LAST LIMIT 1`);
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
            COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN total WHEN payment_method = 'mixed' THEN COALESCE((payment_breakdown::jsonb ->> 'transfer')::numeric, 0) ELSE 0 END), 0)::float AS collected_transfer,
            COUNT(CASE WHEN delivery = 'domicilio' THEN 1 END)::int AS delivery_tickets,
            COALESCE(SUM(CASE WHEN delivery = 'domicilio' THEN total ELSE 0 END), 0)::float AS delivery_total,
            COALESCE(SUM(CASE WHEN delivery = 'domicilio' THEN COALESCE(delivery_fee, 0) ELSE 0 END), 0)::float AS delivery_fees
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
    delivery: {
      tickets: Number(sales?.delivery_tickets || 0),
      total: n(sales?.delivery_total),
      fees: n(sales?.delivery_fees),
    },
  };
}

function expectedCashForSession(session, totals) {
  return n(session.opening_amount) + totals.collected.cash + totals.movements.income - totals.movements.withdrawal - totals.movements.expense;
}

async function isChatbotPosIntegrationEnabled(t) {
  const value = await getSetting(t, 'chatbot_pos_integration_enabled', '0');
  return String(value || '0') === '1';
}

async function getProductExtrasMaps(t, productIds = []) {
  const ids = [...new Set((productIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  const variantsMap = new Map();
  const groupsMap = new Map();
  if (!ids.length) return { variantsMap, groupsMap };

  const variants = await t.all(
    `SELECT id, product_id, name, price::float AS price, sort, active
     FROM {s}.product_variants
     WHERE active = 1 AND product_id = ANY($1::int[])
     ORDER BY product_id, sort, id`,
    [ids]
  );

  for (const v of variants) {
    if (!variantsMap.has(v.product_id)) variantsMap.set(v.product_id, []);
    variantsMap.get(v.product_id).push(v);
  }

  const groups = await t.all(
    `SELECT id, product_id, name, min_selections, max_selections, sort
     FROM {s}.modifier_groups
     WHERE product_id = ANY($1::int[])
     ORDER BY product_id, sort, id`,
    [ids]
  );

  const groupIds = groups.map((g) => Number(g.id)).filter((id) => Number.isInteger(id) && id > 0);
  const options = groupIds.length
    ? await t.all(
      `SELECT id, group_id, name, extra_price::float AS extra_price, sort, active
       FROM {s}.modifier_options
       WHERE active = 1 AND group_id = ANY($1::int[])
       ORDER BY group_id, sort, id`,
      [groupIds]
    )
    : [];

  const optionsByGroup = new Map();
  for (const o of options) {
    if (!optionsByGroup.has(o.group_id)) optionsByGroup.set(o.group_id, []);
    optionsByGroup.get(o.group_id).push(o);
  }

  for (const g of groups) {
    const group = { ...g, options: optionsByGroup.get(g.id) || [] };
    if (!groupsMap.has(g.product_id)) groupsMap.set(g.product_id, []);
    groupsMap.get(g.product_id).push(group);
  }

  return { variantsMap, groupsMap };
}

function paymentBreakdownForMethod(method, total) {
  const amount = n(total);
  if (method === 'card') return { cash: 0, card: amount, transfer: 0 };
  if (method === 'transfer') return { cash: 0, card: 0, transfer: amount };
  return { cash: amount, card: 0, transfer: 0 };
}

async function loadChatbotOrderForImport(t, orderId) {
  return t.get(
    `SELECT o.id, o.customer_id, o.items, o.total::float AS total, o.status, o.channel, o.delivery, o.notes,
            o.payment_method, o.pickup_branch_name, o.customer_location_text, o.customer_location_resolved,
            o.delivery_fee::float AS delivery_fee, o.delivery_zone_name, o.service_branch_id, o.service_branch_name,
            to_char(o.created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at,
            c.name_enc, c.phone_enc, c.address_enc
     FROM {s}.orders o
     LEFT JOIN {s}.customers c ON c.id = o.customer_id
     WHERE o.id = $1
     LIMIT 1`,
    [orderId]
  );
}

function chatbotSummaryNote(order) {
  const name = decrypt(order?.name_enc) || 'Cliente';
  const phone = decrypt(order?.phone_enc) || '';
  const address = decrypt(order?.address_enc) || '';
  const parts = [];
  parts.push(`Pedido chatbot #${order.id}`);
  parts.push(`Cliente: ${name}${phone ? ` (${phone})` : ''}`);
  parts.push(`Entrega: ${order.delivery === 'domicilio' ? 'Domicilio' : `Recoger${order.pickup_branch_name ? ` · ${order.pickup_branch_name}` : ''}`}`);
  if (order.service_branch_name) parts.push(`Sucursal gestora: ${order.service_branch_name}`);
  if (address) parts.push(`Dirección: ${address}`);
  if (order.customer_location_text) parts.push(`Ubicación: ${order.customer_location_text}`);
  if (order.customer_location_resolved) parts.push(`Referencia mapa: ${order.customer_location_resolved}`);
  if (order.delivery === 'domicilio' && Number(order.delivery_fee || 0) > 0) {
    parts.push(`Envío: ${n(order.delivery_fee)}${order.delivery_zone_name ? ` (${order.delivery_zone_name})` : ''}`);
  }
  if (order.notes) parts.push(`Nota cliente: ${order.notes}`);
  return parts.join('\n');
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
    branchId = null,
  } = options;
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = 10;
  const safeFilter = SALES_HISTORY_FILTERS.has(filter) ? filter : 'today';
  const localCreatedAt = `(created_at AT TIME ZONE '${TZ}')`;

  const params = [];
  const where = [`channel = 'pos'`];

  if (Number.isInteger(Number(branchId)) && Number(branchId) > 0) {
    params.push(Number(branchId));
    where.push(`service_branch_id = $${params.length}`);
  }

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

function userSessionContext(user) {
  return {
    forUsername: user?.username || null,
    forBranchId: user?.branchId || null,
  };
}

router.get('/overview', async (req, res, next) => {
  try {
    const categories = await req.tdb.all('SELECT id, name, sort FROM {s}.categories ORDER BY sort, name');
    const branches = await req.tdb.all('SELECT id, name, address, reference, active FROM {s}.branches WHERE active = 1 ORDER BY name');
    // Sessiones activas de otras sucursales (para bloquear selección en admin)
    const allOpenSessions = await req.tdb.all(
      `SELECT branch_id, branch_name, opened_by FROM {s}.pos_sessions WHERE status = 'open'`
    );
    const products = await req.tdb.all(
      `SELECT p.id, p.category_id, p.name, p.description, p.price::float AS price, p.image, c.name AS category_name
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY COALESCE(c.sort, 0), c.name NULLS FIRST, p.name`
    );
    const { variantsMap, groupsMap } = await getProductExtrasMaps(req.tdb, products.map((p) => p.id));
    const productsWithExtras = products.map((p) => ({
      ...p,
      image: normalizePublicMediaPath(p.image),
      variants: variantsMap.get(p.id) || [],
      modifierGroups: groupsMap.get(p.id) || [],
    }));
    const ctx = userSessionContext(req.user);
    const session = await getOpenSession(req.tdb, ctx);
    const sessionTotals = session ? await getSessionTotals(req.tdb, session.id) : null;
    const activeSession = session
      ? {
          ...session,
          totals: sessionTotals,
          expectedCash: expectedCashForSession(session, sessionTotals),
        }
      : null;
    const lastClosedSession = await getLastClosedSession(req.tdb, ctx);
    const chatbotIntegrationEnabled = await isChatbotPosIntegrationEnabled(req.tdb);

    // Sucursales bloqueadas por otras sesiones abiertas (distintas al usuario actual)
    const blockedBranchIds = allOpenSessions
      .filter((s) => s.branch_id && s.opened_by !== req.user.username)
      .map((s) => Number(s.branch_id));

    res.json({
      categories,
      branches,
      products: productsWithExtras,
      activeSession,
      lastClosedSession,
      chatbotIntegrationEnabled,
      blockedBranchIds,
      recentSales: await listRecentSales(req.tdb, activeSession?.id || null),
      recentMovements: await listRecentMovements(req.tdb, activeSession?.id || null),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/chatbot-orders', async (req, res, next) => {
  try {
    const enabled = await isChatbotPosIntegrationEnabled(req.tdb);
    if (!enabled) return res.status(403).json({ error: 'Activa la integración de pedidos chatbot en Mi negocio para usar esta función' });
    const session = await getOpenSession(req.tdb, userSessionContext(req.user));

    const pageSize = 10;
    const safePage = Math.max(1, Number(req.query.page || 1) || 1);
    const countParams = [Array.from(CHATBOT_IMPORTABLE_STATUSES)];
    const branchFilter = session?.branch_id
      ? ` AND COALESCE(o.service_branch_id, o.pickup_branch_id) = $2`
      : '';
    if (session?.branch_id) countParams.push(Number(session.branch_id));

    const totalRow = await req.tdb.get(
      `SELECT COUNT(*)::int AS c
       FROM {s}.orders o
       WHERE o.channel = 'chatbot'
         AND o.status = ANY($1::text[])
         ${branchFilter}
         AND (o.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date`,
      countParams
    );
    const total = Number(totalRow?.c || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const boundedPage = Math.min(safePage, totalPages);
    const offset = (boundedPage - 1) * pageSize;

    const rowParams = [Array.from(CHATBOT_IMPORTABLE_STATUSES)];
    let limitIndex = 2;
    let offsetIndex = 3;
    if (session?.branch_id) {
      rowParams.push(Number(session.branch_id));
      limitIndex = 3;
      offsetIndex = 4;
    }
    rowParams.push(pageSize, offset);

    const rows = await req.tdb.all(
      `SELECT o.id, o.items, o.total::float AS total, o.status, o.delivery, o.notes, o.payment_method,
              o.pickup_branch_name, o.customer_location_text, o.customer_location_resolved,
              o.service_branch_id, o.service_branch_name,
              to_char(o.created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at,
              c.name_enc, c.phone_enc
       FROM {s}.orders o
       LEFT JOIN {s}.customers c ON c.id = o.customer_id
       WHERE o.channel = 'chatbot'
         AND o.status = ANY($1::text[])
         ${branchFilter}
         AND (o.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
       ORDER BY o.id ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      rowParams
    );

    const result = rows.map((row) => ({
      id: row.id,
      total: n(row.total),
      status: row.status,
      delivery: row.delivery,
      payment_method: row.payment_method || 'cash',
      notes: row.notes || '',
      pickup_branch_name: row.pickup_branch_name,
      service_branch_id: row.service_branch_id,
      service_branch_name: row.service_branch_name,
      customer_location_text: row.customer_location_text,
      customer_location_resolved: row.customer_location_resolved,
      created_at: row.created_at,
      customer_name: decrypt(row.name_enc) || 'Cliente',
      customer_phone: decrypt(row.phone_enc) || '',
      items: JSON.parse(row.items || '[]'),
    }));

    res.json({ rows: result, page: boundedPage, pageSize, total, totalPages, sessionBranchName: session?.branch_name || '' });
  } catch (e) {
    next(e);
  }
});

router.post('/chatbot-orders/:id/import', async (req, res, next) => {
  try {
    const enabled = await isChatbotPosIntegrationEnabled(req.tdb);
    if (!enabled) return res.status(403).json({ error: 'Activa la integración de pedidos chatbot en Mi negocio para usar esta función' });

    const session = await getOpenSession(req.tdb, userSessionContext(req.user));
    if (!session) return res.status(400).json({ error: 'Abre una caja antes de importar pedidos chatbot al POS' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Pedido de chatbot inválido' });

    const sourceOrder = await loadChatbotOrderForImport(req.tdb, id);
    if (!sourceOrder) return res.status(404).json({ error: 'No se encontró el pedido de chatbot' });
    if (sourceOrder.channel !== 'chatbot') return res.status(409).json({ error: 'Este pedido ya fue integrado al POS' });
    if (session.branch_id && Number(sourceOrder.service_branch_id || 0) > 0 && Number(sourceOrder.service_branch_id) !== Number(session.branch_id)) {
      return res.status(409).json({ error: `Este pedido corresponde a la sucursal ${sourceOrder.service_branch_name || 'asignada'} y no a la caja abierta.` });
    }
    if (!CHATBOT_IMPORTABLE_STATUSES.has(sourceOrder.status)) {
      return res.status(409).json({ error: 'Solo puedes integrar pedidos chatbot activos (no cancelados ni entregados)' });
    }

    const isToday = await req.tdb.get(
      `SELECT 1 AS ok
       FROM {s}.orders
       WHERE id = $1
         AND (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
       LIMIT 1`,
      [id]
    );
    if (!isToday) {
      return res.status(409).json({ error: 'Solo puedes pasar a caja pedidos del día de operación' });
    }

    const sourceItems = JSON.parse(sourceOrder.items || '[]');
    if (!Array.isArray(sourceItems) || !sourceItems.length) {
      return res.status(400).json({ error: 'El pedido no tiene productos para cobrar en caja' });
    }

    const paymentMethod = PAYMENT_METHODS.has(sourceOrder.payment_method)
      ? sourceOrder.payment_method
      : 'cash';
    const paymentBreakdown = paymentBreakdownForMethod(paymentMethod, sourceOrder.total);
    const mergedNote = chatbotSummaryNote(sourceOrder);

    const update = await req.tdb.run(
      `UPDATE {s}.orders
       SET channel = 'pos',
           status = 'entregado',
           pos_session_id = $1,
           payment_method = $2,
           payment_breakdown = $3,
           service_branch_id = $7,
           service_branch_name = $8,
           cash_received = CASE WHEN $2 = 'cash' THEN total ELSE NULL END,
           cash_change = 0,
           notes = CASE
             WHEN COALESCE(notes, '') = '' THEN $4
             ELSE notes || E'\n\n' || $4
           END
       WHERE id = $5
         AND channel = 'chatbot'
         AND status = ANY($6::text[])
         AND (created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
       RETURNING id, total::float AS total, payment_method, payment_breakdown, cash_received::float AS cash_received,
                 cash_change::float AS cash_change, notes, items,
                 to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at`,
      [session.id, paymentMethod, JSON.stringify(paymentBreakdown), mergedNote, id, Array.from(CHATBOT_IMPORTABLE_STATUSES), session.branch_id || null, session.branch_name || null]
    );

    if (!update.rowCount) {
      return res.status(409).json({ error: 'El pedido ya no está disponible para integrarse al POS' });
    }

    const saleRow = await req.tdb.get(
      `SELECT id, subtotal::float AS subtotal, total::float AS total, delivery_fee::float AS delivery_fee,
              status, payment_method, payment_breakdown, cash_received::float AS cash_received,
              cash_change::float AS cash_change, notes, items,
              to_char(created_at AT TIME ZONE '${TZ}', 'DD Mon YYYY, HH24:MI') AS created_at
       FROM {s}.orders
       WHERE id = $1`,
      [id]
    );

    const totals = await getSessionTotals(req.tdb, session.id);
    res.json({
      ok: true,
      sale: {
        ...saleRow,
        subtotal: Number(saleRow.subtotal || saleRow.total || 0),
        deliveryFee: Number(saleRow.delivery_fee || 0),
        items: JSON.parse(saleRow.items || '[]'),
        payment_breakdown: saleRow.payment_breakdown ? JSON.parse(saleRow.payment_breakdown) : null,
      },
      totals,
      expectedCash: expectedCashForSession(session, totals),
      recentSales: await listRecentSales(req.tdb, session.id),
    });
  } catch (e) {
    console.error('[pos][chatbot-import] error:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'No se pudo pasar el pedido a caja' });
  }
});

router.get('/sales-history', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user));
    const page = Number(req.query.page || 1);
    const filter = String(req.query.filter || 'today').trim();
    const startDate = normalizeIsoDate(req.query.startDate);
    const endDate = normalizeIsoDate(req.query.endDate);
    if (req.query.startDate && !startDate) throw badRequest('La fecha inicial no es válida');
    if (req.query.endDate && !endDate) throw badRequest('La fecha final no es válida');
    const data = await listSalesHistoryPage(req.tdb, { page, filter, startDate, endDate, branchId: session?.branch_id || null });
    res.json(data);
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.post('/session/open', async (req, res, next) => {
  try {
    const openingAmount = n(req.body?.openingAmount);
    const notes = String(req.body?.notes || '').trim().slice(0, 240);
    const branchIdRaw = req.user.role === 'cashier' ? Number(req.user.branchId || 0) : Number(req.body?.branchId);
    const activeBranches = await req.tdb.all('SELECT id, name FROM {s}.branches WHERE active = 1 ORDER BY name');
    const selectedBranch = Number.isInteger(branchIdRaw) && branchIdRaw > 0
      ? activeBranches.find((branch) => Number(branch.id) === branchIdRaw)
      : null;
    if (activeBranches.length && !selectedBranch) {
      return res.status(400).json({ error: 'Selecciona la sucursal para abrir la caja' });
    }

    // Verificar que el usuario no tenga ya una caja abierta
    const myExisting = await getOpenSession(req.tdb, userSessionContext(req.user));
    if (myExisting) return res.status(409).json({ error: 'Ya tienes una caja abierta' });

    // Verificar que la sucursal no esté ya tomada por otro usuario
    if (selectedBranch) {
      const branchConflict = await req.tdb.get(
        `SELECT id, opened_by FROM {s}.pos_sessions WHERE status = 'open' AND branch_id = $1 LIMIT 1`,
        [selectedBranch.id]
      );
      if (branchConflict) {
        return res.status(409).json({
          error: `La sucursal "${selectedBranch.name}" ya tiene una caja abierta (por ${branchConflict.opened_by}). Debe cerrarse antes de abrirla desde aquí.`,
        });
      }
    }

    const row = await req.tdb.get(
      `INSERT INTO {s}.pos_sessions (status, opening_amount, branch_id, branch_name, notes, opened_by)
       VALUES ('open', $1, $2, $3, $4, $5)
       RETURNING id`,
      [openingAmount, selectedBranch?.id || null, selectedBranch?.name || null, notes, req.user.username]
    );
    const session = await getOpenSession(req.tdb, userSessionContext(req.user));
    res.json({ ok: true, sessionId: row.id, activeSession: { ...session, totals: await getSessionTotals(req.tdb, row.id), expectedCash: openingAmount } });
  } catch (e) {
    next(e);
  }
});

router.post('/session/close', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user));
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
    const closed = await getLastClosedSession(req.tdb, userSessionContext(req.user));
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
    const session = await getOpenSession(req.tdb, userSessionContext(req.user));
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
    const session = await getOpenSession(req.tdb, userSessionContext(req.user));
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

      const requestedName = String(item.name || '').trim();
      const requestedPrice = Number(item.price);
      const hasCustomLine = Boolean(item.cartKey || item.variantId || item.modifiersLabel || Array.isArray(item.modifiers));

      const finalName = hasCustomLine
        ? (requestedName || product.name)
        : product.name;
      const finalPrice = hasCustomLine && Number.isFinite(requestedPrice) && requestedPrice >= 0
        ? n(requestedPrice)
        : n(product.price);

      return {
        id: product.id,
        name: finalName,
        price: finalPrice,
        qty,
        variantId: item.variantId ? Number(item.variantId) : null,
        variantName: item.variantName ? String(item.variantName).trim() : null,
        modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
        modifiersLabel: item.modifiersLabel ? String(item.modifiersLabel).trim() : '',
        modifiersExtraPrice: Number.isFinite(Number(item.modifiersExtraPrice)) ? n(item.modifiersExtraPrice) : 0,
        _cartKey: item.cartKey ? String(item.cartKey) : null,
      };
    });
    const subtotal = n(saleItems.reduce((sum, item) => sum + item.price * item.qty, 0));
    const isDelivery = Boolean(req.body?.isDelivery);
    const deliveryFee = isDelivery ? Math.max(0, n(req.body?.deliveryFee)) : 0;
    const deliveryType = isDelivery ? 'domicilio' : 'mostrador';
    const total = n(subtotal + deliveryFee);
    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const payment = normalizePayment(paymentMethod, req.body?.payments || {}, total, req.body?.cashReceived);
    const notes = String(req.body?.notes || '').trim().slice(0, 240);
    const row = await req.tdb.get(
      `INSERT INTO {s}.orders
       (customer_id, items, subtotal, total, status, channel, delivery, notes, payment_method, payment_breakdown, cash_received, cash_change, pos_session_id, delivery_fee, service_branch_id, service_branch_name)
       VALUES (NULL, $1, $2, $3, 'entregado', 'pos', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        JSON.stringify(saleItems),
        subtotal,
        total,
        deliveryType,
        notes,
        payment.method,
        JSON.stringify(payment.breakdown),
        payment.cashReceived || null,
        payment.cashChange || null,
        session.id,
        deliveryFee,
        session.branch_id || null,
        session.branch_name || null,
      ]
    );
    const totals = await getSessionTotals(req.tdb, session.id);
    res.json({
      ok: true,
      sale: {
        id: row.id,
        subtotal,
        deliveryFee,
        total,
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