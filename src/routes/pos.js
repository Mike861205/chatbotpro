const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { getSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const { operationalOrderNote } = require('../utils/orderNotes');
const { ensureCostingSchema, itemsCost, preciseCost } = require('../utils/costing');
const { ensurePurchasingSchema } = require('../utils/purchasing');
const { ensureBranchStockSchema, initializeBranchStock, applyBranchSaleStock, restoreBranchSaleStock } = require('../utils/branchStock');
const { emitNewOrder, emitSelfServiceStatus } = require('../notifications');
const { parseCustomPaymentMethods, isCustomPaymentMethod } = require('../utils/paymentMethods');

const router = express.Router();
router.use(requireAuth);
router.use(requireModules('pos', 'cortes', 'cancelaciones'));
router.use(async (req, res, next) => {
  try {
    await ensureCostingSchema(req.tdb);
    await ensurePurchasingSchema(req.tdb);
    await ensureBranchStockSchema(req.tdb);
    await initializeBranchStock(req.tdb, req.user?.username || 'system');
    next();
  } catch (error) {
    next(error);
  }
});

const PAYMENT_METHODS = new Set(['cash', 'card', 'transfer', 'mixed']);
const MOVEMENT_KINDS = new Set(['income', 'withdrawal', 'expense']);
const tenantTimeZone = (tenantDb) => tenantDb?.timezone || 'America/Mexico_City';
const SALES_HISTORY_FILTERS = new Set(['today', 'week', 'month', 'custom']);
const CHATBOT_IMPORTABLE_STATUSES = new Set(['pendiente', 'confirmado', 'preparando', 'enviado']);

async function getPosPolicy(t) {
  const keys = ['pos_round_edit_enabled', 'pos_round_edit_require_pin', 'pos_same_day_cancel_enabled', 'pos_cancel_require_pin', 'pos_authorization_pin_hash'];
  const rows = await t.all('SELECT key, value FROM {s}.settings WHERE key = ANY($1::text[])', [keys]);
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return {
    roundEditEnabled: values.pos_round_edit_enabled === '1',
    roundEditRequirePin: values.pos_round_edit_require_pin === '1',
    sameDayCancelEnabled: values.pos_same_day_cancel_enabled !== '0',
    cancelRequirePin: values.pos_cancel_require_pin === '1',
    pinHash: values.pos_authorization_pin_hash || '',
  };
}

async function authorizePosAction(t, pin, required) {
  if (!required) return '';
  const policy = await getPosPolicy(t);
  if (!policy.pinHash) throw Object.assign(new Error('Configura primero el NIP de autorización en Mi negocio'), { statusCode: 409 });
  if (!(await bcrypt.compare(String(pin || ''), policy.pinHash))) {
    throw Object.assign(new Error('NIP de autorización incorrecto'), { statusCode: 403 });
  }
  return 'NIP del negocio';
}

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

async function insertSalesAudit(t, req, event) {
  await t.run(
    `INSERT INTO {s}.sales_audit_log
     (event_type, order_id, table_account_id, table_round_id, session_id, branch_id, amount, reason,
      actor_username, actor_role, authorized_by, before_data, after_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [event.eventType, event.orderId || null, event.tableAccountId || null, event.tableRoundId || null,
      event.sessionId || null, event.branchId || null, n(event.amount), event.reason || '',
      req.user.username, req.user.role || '', event.authorizedBy || '',
      JSON.stringify(event.before || {}), JSON.stringify(event.after || {})]
  );
}

function normalizePublicMediaPath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value;
  return value.startsWith('/') ? value : `/${value.replace(/^\/+/, '')}`;
}

async function resolveExistingPublicMediaPath(raw) {
  const normalized = normalizePublicMediaPath(raw);
  if (!normalized || !normalized.startsWith('/uploads/')) return normalized;
  const relativePath = normalized.slice('/uploads/'.length);
  if (!relativePath || relativePath.includes('..')) return '';
  try {
    await fs.access(path.join(config.UPLOADS_DIR, relativePath.replaceAll('/', path.sep)));
    return normalized;
  } catch {
    return '';
  }
}

function sameMoney(a, b) {
  return Math.abs(n(a) - n(b)) < 0.01;
}

function parseJsonArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function tableItemsTotal(items) {
  return n(parseJsonArray(items).reduce((sum, item) => sum + n(item?.price) * Math.max(0, Number(item?.qty) || 0), 0));
}

function serializeTableAccount(row) {
  if (!row) return null;
  const items = parseJsonArray(row.items);
  return {
    ...row,
    items,
    subtotal: n(row.subtotal ?? tableItemsTotal(items)),
    total: n(row.total ?? tableItemsTotal(items)),
  };
}

function serializeTableRound(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    roundNumber: Number(row.round_number),
    items: parseJsonArray(row.items),
    subtotal: n(row.subtotal),
    notes: row.notes || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at || '',
  };
}

async function listTableRounds(t, accountIds = []) {
  const ids = [...new Set(accountIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  const rows = await t.all(
    `SELECT id, account_id, round_number, items, subtotal::float AS subtotal, notes, created_by,
            to_char(created_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.table_rounds
     WHERE account_id = ANY($1::int[])
     ORDER BY account_id, round_number`,
    [ids]
  );
  return rows.map(serializeTableRound);
}

async function getTableAccountWithRounds(t, accountId) {
  const row = await t.get(
    `SELECT id, table_id, table_number, table_label, branch_id, waiter_name, customer_name, customer_phone, source_channel, items,
            subtotal::float AS subtotal, total::float AS total, status, opened_session_id,
            closed_session_id, order_id, opened_by, closed_by,
            to_char(opened_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS closed_at
     FROM {s}.table_accounts WHERE id = $1 LIMIT 1`,
    [accountId]
  );
  if (!row) return null;
  return { ...serializeTableAccount(row), rounds: await listTableRounds(t, [accountId]) };
}

async function getSessionTableSummary(t, sessionId) {
  const session = await t.get('SELECT branch_id FROM {s}.pos_sessions WHERE id = $1 LIMIT 1', [sessionId]);
  const branchId = Number(session?.branch_id || 0);
  const closedRows = await t.all(
    `SELECT id, table_number, table_label, waiter_name, total::float AS total, order_id,
            to_char(opened_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS closed_at
     FROM {s}.table_accounts
     WHERE closed_session_id = $1 AND status = 'closed'
     ORDER BY closed_at, table_number`,
    [sessionId]
  );
  const openRows = await t.all(
    `SELECT id, table_number, table_label, waiter_name, customer_name, customer_phone, source_channel, items, subtotal::float AS subtotal, total::float AS total,
            to_char(opened_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS opened_at
     FROM {s}.table_accounts
     WHERE status = 'open' AND branch_id = $1
     ORDER BY table_number`,
    [branchId]
  );
  return {
    closedCount: closedRows.length,
    closedTotal: n(closedRows.reduce((sum, row) => sum + n(row.total), 0)),
    closed: closedRows.map(serializeTableAccount),
    openCount: openRows.length,
    openTotal: n(openRows.reduce((sum, row) => sum + tableItemsTotal(row.items), 0)),
    open: openRows.map(serializeTableAccount),
  };
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
            to_char(opened_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS closed_at
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
            to_char(opened_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS opened_at,
            to_char(closed_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS closed_at
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
            COALESCE(SUM(CASE WHEN payment_method NOT IN ('cash','card','transfer','mixed','multiple') THEN total ELSE 0 END), 0)::float AS sales_other_only,
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
  const configuredCustomMethods = parseCustomPaymentMethods(await getSetting(t, 'custom_payment_methods_json', '[]'));
  const customRows = await t.all(
    `SELECT payment_method AS id, COUNT(*)::int AS tickets, COALESCE(SUM(total), 0)::float AS total,
            MAX(CASE WHEN payment_breakdown ~ '^\\s*\\{.*\\}\\s*$'
              THEN NULLIF(payment_breakdown::jsonb ->> 'customLabel', '') ELSE NULL END) AS stored_label
     FROM {s}.orders
     WHERE channel = 'pos' AND pos_session_id = $1 AND status != 'cancelado'
       AND payment_method LIKE 'custom\\_%' ESCAPE '\\'
     GROUP BY payment_method
     ORDER BY payment_method`,
    [sessionId]
  );
  const customRowsById = new Map(customRows.map((row) => [row.id, row]));
  const customIds = [...new Set([
    ...configuredCustomMethods.filter((method) => method.active).map((method) => method.id),
    ...customRows.map((row) => row.id),
  ])];
  const customPayments = customIds.map((id) => {
    const configured = configuredCustomMethods.find((method) => method.id === id);
    const row = customRowsById.get(id);
    return {
      id,
      label: configured?.label || row?.stored_label || 'Medio personalizado',
      total: n(row?.total),
      tickets: Number(row?.tickets || 0),
      active: configured?.active !== false,
    };
  });
  const tables = await getSessionTableSummary(t, sessionId);
  return {
    tickets: Number(sales?.tickets || 0),
    totalSales: n(sales?.total_sales),
    salesByMethod: {
      cash: n(sales?.sales_cash_only),
      card: n(sales?.sales_card_only),
      transfer: n(sales?.sales_transfer_only),
      mixed: n(sales?.sales_mixed),
      other: n(sales?.sales_other_only),
    },
    customPayments,
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
    tables,
  };
}

function expectedCashForSession(session, totals) {
  return n(session.opening_amount) + totals.collected.cash + totals.movements.income - totals.movements.withdrawal - totals.movements.expense;
}

async function isChatbotPosIntegrationEnabled(t) {
  const value = await getSetting(t, 'chatbot_pos_integration_enabled', '0');
  return String(value || '0') === '1';
}

async function areGlobalChatbotPosOrdersEnabled(t) {
  const value = await getSetting(t, 'chatbot_pos_global_orders_enabled', '0');
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
  if (isCustomPaymentMethod(method)) return { cash: 0, card: 0, transfer: 0, [method]: amount };
  return { cash: amount, card: 0, transfer: 0 };
}

async function loadChatbotOrderForImport(t, orderId) {
  return t.get(
    `SELECT o.id, o.customer_id, o.items, o.subtotal::float AS subtotal, o.total::float AS total, o.status, o.channel, o.delivery, o.notes, o.order_notes,
            o.payment_method, o.pickup_branch_id, o.pickup_branch_name, o.payment_breakdown, o.customer_location_text, o.customer_location_resolved,
            o.receiving_mode_label, o.receiving_mode_behavior, o.delivery_address, o.delivery_neighborhood, o.delivery_reference,
            o.delivery_fee::float AS delivery_fee, o.delivery_zone_name, o.service_branch_id, o.service_branch_name,o.branch_stock_applied,
            to_char(o.created_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS created_at,
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
  const address = String(order?.delivery_address || decrypt(order?.address_enc) || '');
  const parts = [];
  parts.push(`Pedido chatbot #${order.id}`);
  parts.push(`Cliente: ${name}${phone ? ` (${phone})` : ''}`);
  const receivingLabel = order.receiving_mode_label || (order.delivery === 'domicilio' ? 'Domicilio' : (order.delivery === 'comer_sucursal' ? 'Comer en sucursal' : 'Recoger'));
  parts.push(`Modalidad: ${receivingLabel}${order.pickup_branch_name ? ` · ${order.pickup_branch_name}` : ''}`);
  if (order.service_branch_name) parts.push(`Sucursal gestora: ${order.service_branch_name}`);
  if (address) parts.push(`Dirección: ${address}`);
  if (order.delivery_neighborhood) parts.push(`Colonia / barrio: ${order.delivery_neighborhood}`);
  if (order.delivery_reference) parts.push(`Referencia: ${order.delivery_reference}`);
  if (order.customer_location_text) parts.push(`Ubicación: ${order.customer_location_text}`);
  if (order.customer_location_resolved) parts.push(`Referencia mapa: ${order.customer_location_resolved}`);
  if ((order.receiving_mode_behavior === 'delivery' || order.delivery === 'domicilio') && Number(order.delivery_fee || 0) > 0) {
    parts.push(`Envío: ${n(order.delivery_fee)}${order.delivery_zone_name ? ` (${order.delivery_zone_name})` : ''}`);
  }
  const orderNote = operationalOrderNote(order);
  if (orderNote) parts.push(`Nota del pedido: ${orderNote}`);
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
    `SELECT id, invoice_code, invoice_token, total::float AS total, status, payment_method, payment_breakdown, cash_received::float AS cash_received,
            cash_change::float AS cash_change, COALESCE(NULLIF(order_notes, ''), notes) AS notes, items, table_account_id, table_number, waiter_name,
            service_branch_id, service_branch_name,
            delivery, delivery_fee::float AS delivery_fee, receiving_mode_label, receiving_mode_behavior, delivery_address, delivery_neighborhood, delivery_reference,
            to_char(created_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.orders
     ${where}
     ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  const rounds = await listTableRounds(t, rows.map((row) => row.table_account_id).filter(Boolean));
  return rows.map((row) => ({
    ...row,
    items: JSON.parse(row.items || '[]'),
    payment_breakdown: row.payment_breakdown ? JSON.parse(row.payment_breakdown) : null,
    rounds: rounds.filter((round) => Number(round.accountId) === Number(row.table_account_id)),
  }));
}

async function listPendingSelfServiceOrders(t, branchId) {
  const normalizedBranchId = Number(branchId || 0);
  if (!Number.isInteger(normalizedBranchId) || normalizedBranchId <= 0) return [];
  const rows = await t.all(
    `SELECT o.id,o.self_service_folio,o.self_service_device_id,o.items,o.total::float AS total,o.notes,o.service_branch_id,o.service_branch_name,
            o.payment_method,o.payment_breakdown,
            c.name_enc,c.phone_enc,to_char(o.created_at AT TIME ZONE '${tenantTimeZone(t)}','DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.orders o
     LEFT JOIN {s}.customers c ON c.id=o.customer_id
     WHERE o.channel='kiosk' AND o.status='pendiente_cobro' AND o.service_branch_id=$1
     ORDER BY o.created_at ASC LIMIT 100`,
    [normalizedBranchId]
  );
  return rows.map((row) => ({
    ...row,
    items: parseJsonArray(row.items),
    customerName: decrypt(row.name_enc) || 'Cliente',
    customerPhone: decrypt(row.phone_enc) || '',
    payment_breakdown: parseJsonObject(row.payment_breakdown),
    name_enc: undefined,
    phone_enc: undefined,
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
  const localCreatedAt = `(created_at AT TIME ZONE '${tenantTimeZone(t)}')`;

  const params = [];
  const where = [`channel = 'pos'`];

  if (Number.isInteger(Number(branchId)) && Number(branchId) > 0) {
    params.push(Number(branchId));
    where.push(`service_branch_id = $${params.length}`);
  }

  if (safeFilter === 'today') {
    where.push(`${localCreatedAt}::date = (now() AT TIME ZONE '${tenantTimeZone(t)}')::date`);
  }

  if (safeFilter === 'week') {
    where.push(
      `${localCreatedAt} >= date_trunc('week', now() AT TIME ZONE '${tenantTimeZone(t)}')`,
      `${localCreatedAt} < date_trunc('week', now() AT TIME ZONE '${tenantTimeZone(t)}') + INTERVAL '1 week'`
    );
  }

  if (safeFilter === 'month') {
    where.push(
      `${localCreatedAt} >= date_trunc('month', now() AT TIME ZONE '${tenantTimeZone(t)}')`,
      `${localCreatedAt} < date_trunc('month', now() AT TIME ZONE '${tenantTimeZone(t)}') + INTERVAL '1 month'`
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
    `SELECT id, invoice_code, invoice_token, total::float AS total, status, payment_method, payment_breakdown, cash_received::float AS cash_received,
            cash_change::float AS cash_change, COALESCE(NULLIF(order_notes, ''), notes) AS notes, items, table_account_id, table_number, waiter_name,
            service_branch_id, service_branch_name,
            delivery, delivery_fee::float AS delivery_fee, receiving_mode_label, receiving_mode_behavior, delivery_address, delivery_neighborhood, delivery_reference,
            to_char(created_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS created_at,
            to_char(created_at AT TIME ZONE '${tenantTimeZone(t)}', 'YYYY-MM-DD') AS business_date,
            (SELECT i.id FROM {s}.invoices i WHERE i.order_id=o.id ORDER BY i.id DESC LIMIT 1) AS fiscal_invoice_id,
            (SELECT i.status FROM {s}.invoices i WHERE i.order_id=o.id ORDER BY i.id DESC LIMIT 1) AS fiscal_invoice_status,
            (SELECT i.uuid FROM {s}.invoices i WHERE i.order_id=o.id ORDER BY i.id DESC LIMIT 1) AS fiscal_invoice_uuid,
            (SELECT gi.id FROM {s}.global_invoice_orders gio JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id WHERE gio.order_id=o.id AND gio.active=1 ORDER BY gi.id DESC LIMIT 1) AS global_invoice_id,
            (SELECT gi.status FROM {s}.global_invoice_orders gio JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id WHERE gio.order_id=o.id AND gio.active=1 ORDER BY gi.id DESC LIMIT 1) AS global_invoice_status,
            (SELECT gi.uuid FROM {s}.global_invoice_orders gio JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id WHERE gio.order_id=o.id AND gio.active=1 ORDER BY gi.id DESC LIMIT 1) AS global_invoice_uuid
     FROM {s}.orders o
     ${whereSql}
     ORDER BY id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeSize, offset]
  );

  const rounds = await listTableRounds(t, rows.map((row) => row.table_account_id).filter(Boolean));
  return {
    rows: rows.map((row) => ({
      ...row,
      items: JSON.parse(row.items || '[]'),
      payment_breakdown: row.payment_breakdown ? JSON.parse(row.payment_breakdown) : null,
      rounds: rounds.filter((round) => Number(round.accountId) === Number(row.table_account_id)),
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
            to_char(created_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS created_at
     FROM {s}.pos_cash_movements
     WHERE session_id = $1
     ORDER BY id DESC LIMIT 20`,
    [sessionId]
  );
}

async function listSoldQtyByProduct(t) {
  const rows = await t.all(
    `SELECT product_id, SUM(qty)::int AS sold_qty
     FROM (
       SELECT
         CASE
           WHEN (it.item->>'productId') ~ '^[0-9]+$' THEN (it.item->>'productId')::int
           WHEN (it.item->>'id') ~ '^[0-9]+$' THEN (it.item->>'id')::int
           ELSE NULL
         END AS product_id,
         CASE
           WHEN (it.item->>'qty') ~ '^[0-9]+$' THEN GREATEST((it.item->>'qty')::int, 1)
           ELSE 1
         END AS qty
       FROM {s}.orders o
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.items::jsonb, '[]'::jsonb)) AS it(item)
       WHERE o.status <> 'cancelado' AND o.channel IN ('pos', 'chatbot')
     ) sold
     WHERE product_id IS NOT NULL
     GROUP BY product_id`,
    []
  );
  return new Map(rows.map((row) => [Number(row.product_id), Number(row.sold_qty || 0)]));
}

function normalizePayment(method, paymentInput, total, cashReceivedInput, customMethods = []) {
  const breakdown = {
    cash: 0,
    card: 0,
    transfer: 0,
  };
  let cashReceived = 0;
  let cashChange = 0;
  const cardType = String(paymentInput?.cardType || paymentInput?.card_type || '').trim().toLowerCase();

  const customMethod = customMethods.find((item) => item.id === method);
  if (!PAYMENT_METHODS.has(method) && !customMethod) throw badRequest('Método de pago inválido');

  if (isCustomPaymentMethod(method)) {
    breakdown[method] = n(total);
    breakdown.customLabel = customMethod.label;
    return { method, breakdown, cashReceived: 0, cashChange: 0 };
  }

  if (method === 'cash') {
    breakdown.cash = n(total);
    cashReceived = Math.max(n(cashReceivedInput), n(total));
    if (cashReceived < n(total)) throw badRequest('El efectivo recibido no cubre el total');
    cashChange = n(cashReceived - total);
    return { method, breakdown, cashReceived, cashChange };
  }

  if (method === 'card') {
    if (!['debit', 'credit'].includes(cardType)) throw badRequest('Selecciona si la tarjeta es de débito o crédito');
    breakdown.card = n(total);
    breakdown.cardType = cardType;
    return { method, breakdown, cashReceived: 0, cashChange: 0 };
  }

  if (method === 'transfer') {
    breakdown.transfer = n(total);
    return { method, breakdown, cashReceived: 0, cashChange: 0 };
  }

  breakdown.cash = n(paymentInput?.cash);
  breakdown.card = n(paymentInput?.card);
  breakdown.transfer = n(paymentInput?.transfer);
  if (breakdown.card > 0) {
    if (!['debit', 'credit'].includes(cardType)) throw badRequest('Selecciona si la tarjeta es de débito o crédito');
    breakdown.cardType = cardType;
  }
  const used = [breakdown.cash, breakdown.card, breakdown.transfer].filter((value) => value > 0).length;
  const paid = n(breakdown.cash + breakdown.card + breakdown.transfer);
  if (used < 2) throw badRequest('El pago mixto debe usar al menos dos medios de pago');
  if (!sameMoney(paid, total)) throw badRequest('La suma de pagos no coincide con el total de la venta');
  if (breakdown.cash > 0) {
    cashReceived = Math.max(n(cashReceivedInput), breakdown.cash);
    if (cashReceived < breakdown.cash) throw badRequest('El efectivo recibido no cubre la parte en efectivo');
    cashChange = n(cashReceived - breakdown.cash);
  }
  return { method, breakdown, cashReceived, cashChange };
}

async function normalizeTenantPayment(t, method, paymentInput, total, cashReceivedInput) {
  const customMethods = parseCustomPaymentMethods(await getSetting(t, 'custom_payment_methods_json', '[]'));
  return normalizePayment(method, paymentInput, total, cashReceivedInput, customMethods);
}

async function normalizePosItems(t, inputItems) {
  const items = Array.isArray(inputItems) ? inputItems : [];
  if (!items.length) throw badRequest('Agrega al menos un producto al ticket');
  const ids = [...new Set(items.map((item) => Number(item.productId ?? item.id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw badRequest('Los productos del ticket no son válidos');
  const rows = await t.all(
    `SELECT id, name, price::float AS price, COALESCE(unit_cost, 0)::float AS unit_cost, active, category_id
     FROM {s}.products
     WHERE id = ANY($1::int[])`,
    [ids]
  );
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  return items.map((item) => {
    const product = byId.get(Number(item.productId ?? item.id));
    const qty = Number(item.qty);
    if (!product || !product.active) throw badRequest('Uno de los productos ya no está disponible');
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('La cantidad de un producto es inválida');

    const requestedName = String(item.name || '').trim();
    const requestedPrice = Number(item.price);
    const hasCustomLine = Boolean(item.cartKey || item._cartKey || item.variantId || item.modifiersLabel || Array.isArray(item.modifiers));
    const unitCost = preciseCost(product.unit_cost);
    return {
      id: product.id,
      name: hasCustomLine ? (requestedName || product.name) : product.name,
      price: hasCustomLine && Number.isFinite(requestedPrice) && requestedPrice >= 0 ? n(requestedPrice) : n(product.price),
      qty,
      unitCost,
      lineCost: preciseCost(unitCost * qty),
      variantId: item.variantId ? Number(item.variantId) : null,
      variantName: item.variantName ? String(item.variantName).trim() : null,
      modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
      modifiersLabel: item.modifiersLabel ? String(item.modifiersLabel).trim() : '',
      modifiersExtraPrice: Number.isFinite(Number(item.modifiersExtraPrice)) ? n(item.modifiersExtraPrice) : 0,
      _cartKey: item.cartKey || item._cartKey ? String(item.cartKey || item._cartKey) : null,
    };
  });
}

async function attachCostsToExistingItems(t, inputItems) {
  const items = parseJsonArray(inputItems);
  const ids = [...new Set(items.map((item) => Number(item?.id || item?.product_id || 0)).filter((id) => id > 0))];
  if (!ids.length) return items;
  const rows = await t.all(
    'SELECT id, COALESCE(unit_cost, 0)::float AS unit_cost FROM {s}.products WHERE id = ANY($1::int[])',
    [ids]
  );
  const costs = new Map(rows.map((row) => [Number(row.id), preciseCost(row.unit_cost)]));
  return items.map((item) => {
    const qty = Math.max(0, Number(item?.qty || item?.quantity || 0));
    const existingCost = Number(item?.unitCost ?? item?.unit_cost);
    const unitCost = Number.isFinite(existingCost) && existingCost >= 0
      ? preciseCost(existingCost)
      : (costs.get(Number(item?.id || item?.product_id || 0)) || 0);
    return { ...item, unitCost, lineCost: preciseCost(unitCost * qty) };
  });
}

async function decrementBranchStockForSale(t, branchId, inputItems) {
  return applyBranchSaleStock(t, branchId, inputItems);
}

async function restoreBranchStockForCancelledSale(t, branchId, inputItems) {
  return restoreBranchSaleStock(t, branchId, inputItems);
}

function selectedOwnerPosBranchId(req) {
  if (!req || req.user?.role === 'cashier') return null;
  const raw = req.get('x-cbp-pos-branch-id') || req.query?.posBranchId || req.body?.posBranchId;
  const branchId = Number(raw);
  return Number.isInteger(branchId) && branchId > 0 ? branchId : null;
}

function userSessionContext(user, req = null) {
  const cashierBranchId = user?.role === 'cashier' ? Number(user?.branchId || 0) : null;
  const selectedBranchId = selectedOwnerPosBranchId(req);
  return {
    forUsername: cashierBranchId || selectedBranchId ? null : (user?.username || null),
    forBranchId: cashierBranchId || selectedBranchId || null,
  };
}

async function listRestaurantTables(t, session = null, includeDisabled = false) {
  const branchId = Number(session?.branch_id || 0);
  const params = [];
  const where = [];
  let accountJoin = `LEFT JOIN {s}.table_accounts ta ON ta.table_id = rt.id AND ta.status = 'open' AND 1 = 0`;
  if (!includeDisabled) where.push('rt.enabled = 1');
  if (session) {
    params.push(branchId);
    where.push(`rt.branch_id IN (0, $${params.length})`);
    accountJoin = `LEFT JOIN {s}.table_accounts ta ON ta.table_id = rt.id AND ta.status = 'open' AND ta.branch_id = $${params.length}`;
  }
  const rows = await t.all(
    `SELECT rt.id, rt.table_number, rt.label, rt.branch_id, rt.position_x, rt.position_y, rt.shape, rt.enabled,
            ta.id AS account_id, ta.waiter_name, ta.customer_name, ta.customer_phone, ta.source_channel, ta.items, ta.subtotal::float AS account_subtotal,
            ta.total::float AS account_total,
            to_char(ta.opened_at AT TIME ZONE '${tenantTimeZone(t)}', 'DD Mon YYYY, HH24:MI') AS account_opened_at
     FROM {s}.restaurant_tables rt
     ${accountJoin}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY rt.branch_id, rt.table_number`,
    params
  );
  const tables = rows.map((row) => ({
    id: Number(row.id),
    tableNumber: Number(row.table_number),
    label: row.label || '',
    branchId: Number(row.branch_id || 0),
    positionX: Number(row.position_x || 50),
    positionY: Number(row.position_y || 50),
    shape: row.shape || 'round',
    enabled: Boolean(Number(row.enabled)),
    account: row.account_id ? { ...serializeTableAccount({
      id: Number(row.account_id),
      table_id: Number(row.id),
      table_number: Number(row.table_number),
      table_label: row.label || '',
      waiter_name: row.waiter_name,
      customer_name: row.customer_name || '',
      customer_phone: row.customer_phone || '',
      source_channel: row.source_channel || '',
      items: row.items,
      subtotal: row.account_subtotal,
      total: row.account_total,
      opened_at: row.account_opened_at,
    }), rounds: [] } : null,
  }));
  const rounds = await listTableRounds(t, tables.map((table) => table.account?.id).filter(Boolean));
  const roundsByAccount = new Map();
  for (const round of rounds) {
    if (!roundsByAccount.has(round.accountId)) roundsByAccount.set(round.accountId, []);
    roundsByAccount.get(round.accountId).push(round);
  }
  for (const table of tables) {
    if (table.account) table.account.rounds = roundsByAccount.get(Number(table.account.id)) || [];
  }
  return tables;
}

router.get('/tables/config', requireOwner, async (req, res, next) => {
  try {
    res.json({
      tables: await listRestaurantTables(req.tdb, null, true),
      branches: await req.tdb.all('SELECT id, name FROM {s}.branches WHERE active = 1 ORDER BY name'),
    });
  } catch (e) {
    next(e);
  }
});

router.put('/tables/config', requireOwner, async (req, res, next) => {
  try {
    const input = Array.isArray(req.body?.tables) ? req.body.tables : [];
    if (input.length > 200) return res.status(400).json({ error: 'Puedes configurar hasta 200 mesas' });
    const validBranches = new Set((await req.tdb.all('SELECT id FROM {s}.branches WHERE active = 1')).map((row) => Number(row.id)));
    const seen = new Set();
    await req.tdb.tx(async (tx) => {
      for (const item of input) {
        const id = Number(item.id || 0);
        const tableNumber = Number(item.tableNumber);
        const branchId = Number(item.branchId || 0);
        if (!Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 999) throw badRequest('Cada mesa debe tener un número entre 1 y 999');
        if (branchId && !validBranches.has(branchId)) throw badRequest(`La sucursal de la mesa ${tableNumber} no es válida`);
        const uniqueKey = `${branchId}:${tableNumber}`;
        if (seen.has(uniqueKey)) throw badRequest(`La mesa ${tableNumber} está repetida en la misma sucursal`);
        seen.add(uniqueKey);
        const label = String(item.label || '').trim().slice(0, 40);
        const positionX = Math.max(5, Math.min(95, Math.round(Number(item.positionX) || 50)));
        const positionY = Math.max(7, Math.min(93, Math.round(Number(item.positionY) || 50)));
        const shape = ['round', 'square', 'rectangle'].includes(item.shape) ? item.shape : 'round';
        const enabled = item.enabled === false || item.enabled === 0 ? 0 : 1;
        if (id > 0) {
          const updated = await tx.run(
            `UPDATE {s}.restaurant_tables
             SET table_number = $1, label = $2, branch_id = $3, position_x = $4, position_y = $5,
                 shape = $6, enabled = $7, updated_at = now()
             WHERE id = $8`,
            [tableNumber, label, branchId, positionX, positionY, shape, enabled, id]
          );
          if (!updated.rowCount) throw badRequest(`No se encontró la mesa ${tableNumber}`);
        } else {
          await tx.run(
            `INSERT INTO {s}.restaurant_tables
             (table_number, label, branch_id, position_x, position_y, shape, enabled)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tableNumber, label, branchId, positionX, positionY, shape, enabled]
          );
        }
      }
    });
    res.json({ ok: true, tables: await listRestaurantTables(req.tdb, null, true) });
  } catch (e) {
    if (e.statusCode === 400 || e.code === '23505') return res.status(400).json({ error: e.code === '23505' ? 'No puede repetirse un número de mesa en la misma sucursal' : e.message });
    next(e);
  }
});

router.delete('/tables/config/:id', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const open = await req.tdb.get(`SELECT 1 AS ok FROM {s}.table_accounts WHERE table_id = $1 AND status = 'open' LIMIT 1`, [id]);
    if (open) return res.status(409).json({ error: 'No puedes eliminar una mesa con cuenta abierta; ciérrala o deshabilítala' });
    const result = await req.tdb.run('DELETE FROM {s}.restaurant_tables WHERE id = $1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Mesa no encontrada' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/tables/:id/open', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre una caja antes de abrir una mesa' });
    const tableId = Number(req.params.id);
    const table = await req.tdb.get('SELECT * FROM {s}.restaurant_tables WHERE id = $1 AND enabled = 1 LIMIT 1', [tableId]);
    if (!table) return res.status(404).json({ error: 'Mesa no disponible' });
    const sessionBranchId = Number(session.branch_id || 0);
    if (Number(table.branch_id || 0) !== 0 && Number(table.branch_id) !== sessionBranchId) {
      return res.status(409).json({ error: 'Esta mesa pertenece a otra sucursal' });
    }
    const waiterName = String(req.body?.waiterName || '').trim().slice(0, 80);
    if (!waiterName) return res.status(400).json({ error: 'Escribe el nombre del mesero' });
    const row = await req.tdb.get(
      `INSERT INTO {s}.table_accounts
       (table_id, table_number, table_label, branch_id, waiter_name, source_channel, items, opened_session_id, opened_by)
       VALUES ($1, $2, $3, $4, $5, 'pos', '[]', $6, $7)
       RETURNING *`,
      [table.id, table.table_number, table.label || '', sessionBranchId, waiterName, session.id, req.user.username]
    );
    res.json({ ok: true, account: { ...serializeTableAccount(row), rounds: [] } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'La mesa ya tiene una cuenta abierta' });
    next(e);
  }
});

router.put('/table-accounts/:id', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre una caja para guardar la cuenta' });
    const id = Number(req.params.id);
    const account = await req.tdb.get('SELECT * FROM {s}.table_accounts WHERE id = $1 AND status = $2 LIMIT 1', [id, 'open']);
    if (!account) return res.status(404).json({ error: 'La cuenta de mesa ya no está abierta' });
    if (Number(account.branch_id || 0) !== Number(session.branch_id || 0)) return res.status(409).json({ error: 'La cuenta pertenece a otra sucursal' });
    const items = await normalizePosItems(req.tdb, req.body?.items);
    const subtotal = n(items.reduce((sum, item) => sum + item.price * item.qty, 0));
    const waiterName = String(req.body?.waiterName || account.waiter_name || '').trim().slice(0, 80);
    const row = await req.tdb.get(
      `UPDATE {s}.table_accounts
       SET items = $1, subtotal = $2, total = $2, waiter_name = $3, updated_at = now()
       WHERE id = $4 AND status = 'open'
       RETURNING *`,
      [JSON.stringify(items), subtotal, waiterName, id]
    );
    res.json({ ok: true, account: await getTableAccountWithRounds(req.tdb, row.id) });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.post('/table-accounts/:id/rounds', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre una caja para enviar la ronda' });
    const accountId = Number(req.params.id);
    const result = await req.tdb.tx(async (tx) => {
      const account = await tx.get(
        `SELECT * FROM {s}.table_accounts WHERE id = $1 AND status = 'open' FOR UPDATE`,
        [accountId]
      );
      if (!account) throw Object.assign(new Error('La cuenta de mesa ya no está abierta'), { statusCode: 409 });
      if (Number(account.branch_id || 0) !== Number(session.branch_id || 0)) {
        throw Object.assign(new Error('La cuenta pertenece a otra sucursal'), { statusCode: 409 });
      }
      const roundItems = await normalizePosItems(tx, req.body?.items);
      const roundSubtotal = n(roundItems.reduce((sum, item) => sum + item.price * item.qty, 0));
      const currentItems = parseJsonArray(account.items);
      const latest = await tx.get(
        'SELECT COALESCE(MAX(round_number), 0)::int AS n FROM {s}.table_rounds WHERE account_id = $1',
        [accountId]
      );
      let roundNumber = Number(latest?.n || 0) + 1;
      if (roundNumber === 1 && currentItems.length) {
        await tx.run(
          `INSERT INTO {s}.table_rounds (account_id, round_number, items, subtotal, notes, created_by, created_at)
           VALUES ($1, 1, $2, $3, 'Ronda inicial migrada', $4, COALESCE($5::timestamptz, now()))`,
          [accountId, JSON.stringify(currentItems), tableItemsTotal(currentItems), account.opened_by || req.user.username, account.updated_at]
        );
        roundNumber = 2;
      }
      const notes = String(req.body?.notes || '').trim().slice(0, 180);
      const round = await tx.get(
        `INSERT INTO {s}.table_rounds (account_id, round_number, items, subtotal, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [accountId, roundNumber, JSON.stringify(roundItems), roundSubtotal, notes, req.user.username]
      );
      const accumulatedItems = [...currentItems, ...roundItems];
      const accumulatedTotal = n(tableItemsTotal(accumulatedItems));
      await tx.run(
        `UPDATE {s}.table_accounts
         SET items = $1, subtotal = $2, total = $2, updated_at = now()
         WHERE id = $3`,
        [JSON.stringify(accumulatedItems), accumulatedTotal, accountId]
      );
      if (account.source_channel === 'chatbot') {
        await decrementBranchStockForSale(tx, session.branch_id, roundItems);
      }
      return { roundId: round.id, roundNumber, roundSubtotal, accumulatedTotal };
    });
    const account = await getTableAccountWithRounds(req.tdb, accountId);
    const round = account?.rounds?.find((item) => Number(item.id) === Number(result.roundId));
    res.json({ ok: true, account, round: round || { id: result.roundId, roundNumber: result.roundNumber, subtotal: result.roundSubtotal, items: [] }, accumulatedTotal: result.accumulatedTotal });
  } catch (e) {
    if (e.statusCode === 400 || e.statusCode === 409) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

router.put('/table-accounts/:accountId/rounds/:roundId', async (req, res, next) => {
  try {
    const policy = await getPosPolicy(req.tdb);
    if (!policy.roundEditEnabled) return res.status(403).json({ error: 'La edición de rondas está deshabilitada por el negocio' });
    const accountId = Number(req.params.accountId);
    const roundId = Number(req.params.roundId);
    const reason = String(req.body?.reason || '').trim().slice(0, 180);
    if (!reason) return res.status(400).json({ error: 'Escribe el motivo de la edición' });
    const authorizedBy = await authorizePosAction(req.tdb, req.body?.pin, policy.roundEditRequirePin);
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre una caja para editar la ronda' });

    await req.tdb.tx(async (tx) => {
      const account = await tx.get("SELECT * FROM {s}.table_accounts WHERE id=$1 AND status='open' FOR UPDATE", [accountId]);
      if (!account) throw Object.assign(new Error('La cuenta de mesa ya no está abierta'), { statusCode: 409 });
      if (Number(account.branch_id || 0) !== Number(session.branch_id || 0)) throw Object.assign(new Error('La cuenta pertenece a otra sucursal'), { statusCode: 409 });
      const round = await tx.get('SELECT * FROM {s}.table_rounds WHERE id=$1 AND account_id=$2 FOR UPDATE', [roundId, accountId]);
      if (!round) throw Object.assign(new Error('No se encontró la ronda'), { statusCode: 404 });
      const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const nextItems = requestedItems.length ? await normalizePosItems(tx, requestedItems) : [];
      const nextSubtotal = tableItemsTotal(nextItems);
      const previousItems = parseJsonArray(round.items);

      if (account.source_channel === 'chatbot') {
        await restoreBranchStockForCancelledSale(tx, session.branch_id, previousItems);
        if (nextItems.length) await decrementBranchStockForSale(tx, session.branch_id, nextItems);
      }
      if (nextItems.length) {
        await tx.run('UPDATE {s}.table_rounds SET items=$1, subtotal=$2, notes=$3 WHERE id=$4', [JSON.stringify(nextItems), nextSubtotal, reason, roundId]);
      } else {
        await tx.run('DELETE FROM {s}.table_rounds WHERE id=$1', [roundId]);
      }
      const remainingRounds = await tx.all('SELECT items FROM {s}.table_rounds WHERE account_id=$1 ORDER BY round_number', [accountId]);
      const accumulatedItems = remainingRounds.flatMap((item) => parseJsonArray(item.items));
      const accumulatedTotal = tableItemsTotal(accumulatedItems);
      await tx.run('UPDATE {s}.table_accounts SET items=$1, subtotal=$2, total=$2, updated_at=now() WHERE id=$3', [JSON.stringify(accumulatedItems), accumulatedTotal, accountId]);
      await insertSalesAudit(tx, req, {
        eventType: nextItems.length ? 'table_round_edited' : 'table_round_deleted',
        tableAccountId: accountId, tableRoundId: roundId, sessionId: session.id, branchId: session.branch_id,
        amount: n(Number(round.subtotal || 0) - nextSubtotal), reason, authorizedBy,
        before: { roundNumber: round.round_number, items: previousItems, subtotal: n(round.subtotal) },
        after: { roundNumber: round.round_number, items: nextItems, subtotal: nextSubtotal },
      });
    });
    res.json({ ok: true, account: await getTableAccountWithRounds(req.tdb, accountId) });
  } catch (e) {
    if ([400, 403, 404, 409].includes(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

router.post('/table-accounts/:id/checkout', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre una caja para cerrar la cuenta' });
    const accountId = Number(req.params.id);
    const result = await req.tdb.tx(async (tx) => {
      const account = await tx.get(
        `SELECT * FROM {s}.table_accounts WHERE id = $1 AND status = 'open' FOR UPDATE`,
        [accountId]
      );
      if (!account) throw Object.assign(new Error('La cuenta de mesa ya no está abierta'), { statusCode: 409 });
      if (Number(account.branch_id || 0) !== Number(session.branch_id || 0)) throw Object.assign(new Error('La cuenta pertenece a otra sucursal'), { statusCode: 409 });
      const items = await attachCostsToExistingItems(tx, account.items);
      if (!items.length) throw badRequest('La mesa no tiene productos para cobrar');
      const subtotal = n(items.reduce((sum, item) => sum + n(item.price) * Number(item.qty), 0));
      const paymentMethod = String(req.body?.paymentMethod || '').trim();
      const payment = await normalizeTenantPayment(tx, paymentMethod, req.body?.payments || {}, subtotal, req.body?.cashReceived);
      const waiterName = String(account.waiter_name || '').trim();
      const userNote = String(req.body?.notes || '').trim().slice(0, 180);
      const notes = [`Mesa ${account.table_number}`, `Mesero: ${waiterName}`, userNote].filter(Boolean).join(' · ');
      const cogsTotal = itemsCost(items);
      const linkedOrder = Number(account.order_id || 0) > 0
        ? await tx.get('SELECT id, channel, branch_stock_applied FROM {s}.orders WHERE id = $1 FOR UPDATE', [account.order_id])
        : null;
      let saleRow;
      if (linkedOrder?.channel === 'table_account') {
        saleRow = await tx.get(
          `UPDATE {s}.orders
           SET items=$1, subtotal=$2, total=$2, status='entregado', channel='pos', notes=$3,
               payment_method=$4, payment_breakdown=$5, cash_received=$6, cash_change=$7,
               pos_session_id=$8, delivery_fee=0, service_branch_id=$9, service_branch_name=$10,
               table_account_id=$11, table_number=$12, waiter_name=$13, cogs_total=$14,
               order_notes=CASE WHEN $15 <> '' THEN $15 ELSE order_notes END
           WHERE id=$16 RETURNING id, invoice_code, invoice_token`,
          [JSON.stringify(items), subtotal, notes, payment.method, JSON.stringify(payment.breakdown), payment.cashReceived || null,
            payment.cashChange || null, session.id, session.branch_id || null, session.branch_name || null,
            account.id, account.table_number, waiterName, cogsTotal, userNote, linkedOrder.id]
        );
      } else {
        saleRow = await tx.get(
          `INSERT INTO {s}.orders
           (customer_id, items, subtotal, total, status, channel, source_channel, delivery, notes, payment_method, payment_breakdown,
            cash_received, cash_change, pos_session_id, delivery_fee, service_branch_id, service_branch_name,
            table_account_id, table_number, waiter_name, cogs_total, order_notes)
           VALUES (NULL, $1, $2, $2, 'entregado', 'pos', 'pos', 'mesa', $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13, $14, $15)
           RETURNING id, invoice_code, invoice_token`,
          [JSON.stringify(items), subtotal, notes, payment.method, JSON.stringify(payment.breakdown), payment.cashReceived || null,
            payment.cashChange || null, session.id, session.branch_id || null, session.branch_name || null,
            account.id, account.table_number, waiterName, cogsTotal, userNote]
        );
      }
      if (!Number(linkedOrder?.branch_stock_applied) && await decrementBranchStockForSale(tx, session.branch_id, items)) {
        await tx.run('UPDATE {s}.orders SET branch_stock_applied=1 WHERE id=$1', [saleRow.id]);
      }
      await tx.run(
        `UPDATE {s}.table_accounts
         SET items = $1, subtotal = $2, total = $2, status = 'closed', closed_session_id = $3,
             order_id = $4, closed_by = $5, closed_at = now(), updated_at = now()
         WHERE id = $6`,
        [JSON.stringify(items), subtotal, session.id, saleRow.id, req.user.username, account.id]
      );
      return { account, items, subtotal, payment, notes, orderNote: userNote, saleId: saleRow.id, invoiceCode: saleRow.invoice_code, invoiceToken: saleRow.invoice_token };
    });
    const totals = await getSessionTotals(req.tdb, session.id);
    const rounds = await listTableRounds(req.tdb, [accountId]);
    res.json({
      ok: true,
      sale: {
        id: result.saleId,
        subtotal: result.subtotal,
        deliveryFee: 0,
        total: result.subtotal,
        items: result.items,
        paymentMethod: result.payment.method,
        paymentBreakdown: result.payment.breakdown,
        cashReceived: result.payment.cashReceived,
        cashChange: result.payment.cashChange,
        notes: result.orderNote,
        tableNumber: result.account.table_number,
        waiterName: result.account.waiter_name,
        rounds,
        invoiceCode: result.invoiceCode,
        invoiceToken: result.invoiceToken,
      },
      totals,
      expectedCash: expectedCashForSession(session, totals),
    });
  } catch (e) {
    if (e.statusCode === 400 || e.statusCode === 409 || e.message) return res.status(e.statusCode || 400).json({ error: e.message });
    next(e);
  }
});

router.get('/overview', async (req, res, next) => {
  try {
    const categories = await req.tdb.all('SELECT id, name, sort FROM {s}.categories ORDER BY sort, name');
    const branches = await req.tdb.all('SELECT id, name, address, reference, active FROM {s}.branches WHERE active = 1 ORDER BY name');
    // Sessiones activas de otras sucursales (para bloquear selección en admin)
    const allOpenSessions = await req.tdb.all(
      `SELECT id, branch_id, branch_name, opened_by,
              opening_amount::float AS opening_amount,
              to_char(opened_at AT TIME ZONE '${tenantTimeZone(req.tdb)}', 'DD Mon YYYY, HH24:MI') AS opened_at
       FROM {s}.pos_sessions
       WHERE status = 'open'
       ORDER BY opened_at DESC`
    );
    const products = await req.tdb.all(
      `SELECT p.id, p.category_id, p.name, p.description, p.price::float AS price, p.image, c.name AS category_name
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id = p.category_id
       WHERE p.active = 1
       ORDER BY COALESCE(c.sort, 0), c.name NULLS FIRST, p.name`
    );
    const { variantsMap, groupsMap } = await getProductExtrasMaps(req.tdb, products.map((p) => p.id));
    const soldQtyByProduct = await listSoldQtyByProduct(req.tdb);
    const productsWithExtras = await Promise.all(products.map(async (p) => ({
      ...p,
      image: await resolveExistingPublicMediaPath(p.image),
      soldQty: Number(soldQtyByProduct.get(Number(p.id)) || 0),
      variants: variantsMap.get(p.id) || [],
      modifierGroups: groupsMap.get(p.id) || [],
    })));
    const ctx = userSessionContext(req.user, req);
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
    const policy = await getPosPolicy(req.tdb);

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
      policy: {
        roundEditEnabled: policy.roundEditEnabled,
        roundEditRequirePin: policy.roundEditRequirePin,
        sameDayCancelEnabled: policy.sameDayCancelEnabled,
        cancelRequirePin: policy.cancelRequirePin,
      },
      openSessions: allOpenSessions,
      tables: await listRestaurantTables(req.tdb, activeSession, false),
      blockedBranchIds,
      selfServiceOrders: await listPendingSelfServiceOrders(req.tdb, activeSession?.branch_id),
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
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    const globalOrdersEnabled = await areGlobalChatbotPosOrdersEnabled(req.tdb);
    const restrictToSessionBranch = !globalOrdersEnabled && Boolean(session?.branch_id);

    const pageSize = 10;
    const safePage = Math.max(1, Number(req.query.page || 1) || 1);
    const countParams = [Array.from(CHATBOT_IMPORTABLE_STATUSES)];
    const branchFilter = restrictToSessionBranch
      ? ` AND COALESCE(o.service_branch_id, o.pickup_branch_id) = $2`
      : '';
    if (restrictToSessionBranch) countParams.push(Number(session.branch_id));

    const totalRow = await req.tdb.get(
      `SELECT COUNT(*)::int AS c
       FROM {s}.orders o
       WHERE o.channel = 'chatbot'
         AND o.status = ANY($1::text[])
         ${branchFilter}
         AND (o.created_at AT TIME ZONE '${req.timezone}')::date = (now() AT TIME ZONE '${req.timezone}')::date`,
      countParams
    );
    const total = Number(totalRow?.c || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const boundedPage = Math.min(safePage, totalPages);
    const offset = (boundedPage - 1) * pageSize;

    const rowParams = [Array.from(CHATBOT_IMPORTABLE_STATUSES)];
    let limitIndex = 2;
    let offsetIndex = 3;
    if (restrictToSessionBranch) {
      rowParams.push(Number(session.branch_id));
      limitIndex = 3;
      offsetIndex = 4;
    }
    rowParams.push(pageSize, offset);

    const rows = await req.tdb.all(
      `SELECT o.id, o.items, o.total::float AS total, o.status, o.delivery, o.notes, o.order_notes, o.payment_method,
              o.pickup_branch_name, o.customer_location_text, o.customer_location_resolved,
              o.receiving_mode_label, o.receiving_mode_behavior, o.delivery_address, o.delivery_neighborhood, o.delivery_reference,
              o.service_branch_id, o.service_branch_name,
              to_char(o.created_at AT TIME ZONE '${req.timezone}', 'DD Mon YYYY, HH24:MI') AS created_at,
              c.name_enc, c.phone_enc, c.address_enc
       FROM {s}.orders o
       LEFT JOIN {s}.customers c ON c.id = o.customer_id
       WHERE o.channel = 'chatbot'
         AND o.status = ANY($1::text[])
         ${branchFilter}
         AND (o.created_at AT TIME ZONE '${req.timezone}')::date = (now() AT TIME ZONE '${req.timezone}')::date
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
      notes: row.order_notes || '',
      pickup_branch_name: row.pickup_branch_name,
      service_branch_id: row.service_branch_id,
      service_branch_name: row.service_branch_name,
      receiving_mode_label: row.receiving_mode_label || '',
      receiving_mode_behavior: row.receiving_mode_behavior || (row.delivery === 'domicilio' ? 'delivery' : 'branch'),
      customer_location_text: row.customer_location_text,
      customer_location_resolved: row.customer_location_resolved,
      delivery_address: row.delivery_address || decrypt(row.address_enc) || '',
      delivery_neighborhood: row.delivery_neighborhood || '',
      delivery_reference: row.delivery_reference || ((row.receiving_mode_behavior === 'delivery' || row.delivery === 'domicilio') ? row.notes : '') || '',
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

    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre una caja antes de importar pedidos chatbot al POS' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Pedido de chatbot inválido' });

    const sourceOrder = await loadChatbotOrderForImport(req.tdb, id);
    if (!sourceOrder) return res.status(404).json({ error: 'No se encontró el pedido de chatbot' });
    if (sourceOrder.channel !== 'chatbot') return res.status(409).json({ error: 'Este pedido ya fue integrado al POS' });
    const globalOrdersEnabled = await areGlobalChatbotPosOrdersEnabled(req.tdb);
    const assignedBranchId = Number(sourceOrder.service_branch_id || sourceOrder.pickup_branch_id || 0);
    if (!globalOrdersEnabled && session.branch_id && assignedBranchId > 0 && assignedBranchId !== Number(session.branch_id)) {
      return res.status(409).json({ error: `Este pedido corresponde a la sucursal ${sourceOrder.service_branch_name || 'asignada'} y no a la caja abierta.` });
    }
    if (!CHATBOT_IMPORTABLE_STATUSES.has(sourceOrder.status)) {
      return res.status(409).json({ error: 'Solo puedes integrar pedidos chatbot activos (no cancelados ni entregados)' });
    }

    const isToday = await req.tdb.get(
      `SELECT 1 AS ok
       FROM {s}.orders
       WHERE id = $1
         AND (created_at AT TIME ZONE '${req.timezone}')::date = (now() AT TIME ZONE '${req.timezone}')::date
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

    const costedSourceItems = await attachCostsToExistingItems(req.tdb, sourceItems);
    const cogsTotal = itemsCost(costedSourceItems);
    const isDineInOrder = sourceOrder.delivery === 'comer_sucursal';

    if (isDineInOrder) {
      const tableId = Number(req.body?.tableId || 0);
      const waiterName = String(req.body?.waiterName || req.user?.displayName || req.user?.username || '').trim().slice(0, 80);
      if (!Number.isInteger(tableId) || tableId <= 0) {
        return res.status(400).json({ error: 'Selecciona una mesa disponible para abrir la cuenta', requiresTable: true });
      }
      if (!waiterName) return res.status(400).json({ error: 'Escribe el nombre del mesero' });

      const customerName = (decrypt(sourceOrder.name_enc) || 'Cliente').trim().slice(0, 100);
      const customerPhone = (decrypt(sourceOrder.phone_enc) || '').trim().slice(0, 40);
      const subtotal = n(costedSourceItems.reduce((sum, item) => sum + n(item.price) * Number(item.qty || 0), 0));
      const tableResult = await req.tdb.tx(async (tx) => {
        const table = await tx.get(
          'SELECT * FROM {s}.restaurant_tables WHERE id = $1 AND enabled = 1 FOR UPDATE',
          [tableId]
        );
        if (!table) throw Object.assign(new Error('La mesa seleccionada no está disponible'), { statusCode: 404 });
        const sessionBranchId = Number(session.branch_id || 0);
        if (Number(table.branch_id || 0) !== 0 && Number(table.branch_id) !== sessionBranchId) {
          throw Object.assign(new Error('La mesa seleccionada pertenece a otra sucursal'), { statusCode: 409 });
        }
        const occupied = await tx.get(
          `SELECT id FROM {s}.table_accounts WHERE table_id = $1 AND branch_id = $2 AND status = 'open' LIMIT 1`,
          [tableId, sessionBranchId]
        );
        if (occupied) throw Object.assign(new Error('La mesa ya tiene una cuenta abierta'), { statusCode: 409 });

        const account = await tx.get(
          `INSERT INTO {s}.table_accounts
           (table_id, table_number, table_label, branch_id, waiter_name, customer_name, customer_phone,
            source_channel, items, subtotal, total, opened_session_id, order_id, opened_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'chatbot',$8,$9,$9,$10,$11,$12)
           RETURNING *`,
          [table.id, table.table_number, table.label || '', sessionBranchId, waiterName, customerName, customerPhone,
            JSON.stringify(costedSourceItems), subtotal, session.id, id, req.user.username]
        );
        const roundNote = String(sourceOrder.order_notes || '').trim().slice(0, 180);
        const round = await tx.get(
          `INSERT INTO {s}.table_rounds (account_id, round_number, items, subtotal, notes, created_by)
           VALUES ($1,1,$2,$3,$4,$5) RETURNING id`,
          [account.id, JSON.stringify(costedSourceItems), subtotal, roundNote, req.user.username]
        );
        const moved = await tx.run(
          `UPDATE {s}.orders
           SET channel = 'table_account', source_channel = 'chatbot', status = 'preparando', service_branch_id = $1, service_branch_name = $2,
               items = $3, cogs_total = $4, table_account_id = $5, table_number = $6, waiter_name = $7
           WHERE id = $8 AND channel = 'chatbot' AND status = ANY($9::text[])
           RETURNING id`,
          [session.branch_id || null, session.branch_name || null, JSON.stringify(costedSourceItems), cogsTotal,
            account.id, table.table_number, waiterName, id, Array.from(CHATBOT_IMPORTABLE_STATUSES)]
        );
        if (!moved.rowCount) throw Object.assign(new Error('El pedido ya no está disponible para abrirlo en mesa'), { statusCode: 409 });
        if (!Number(sourceOrder.branch_stock_applied) && await decrementBranchStockForSale(tx, session.branch_id, costedSourceItems)) {
          await tx.run('UPDATE {s}.orders SET branch_stock_applied=1 WHERE id=$1', [id]);
        }
        return { accountId: account.id, roundId: round.id, tableNumber: table.table_number };
      });

      const account = await getTableAccountWithRounds(req.tdb, tableResult.accountId);
      return res.json({
        ok: true,
        openedInTable: true,
        orderId: id,
        account,
        round: account?.rounds?.find((round) => Number(round.id) === Number(tableResult.roundId)) || null,
        totals: await getSessionTotals(req.tdb, session.id),
      });
    }

    const customPaymentMethods = parseCustomPaymentMethods(await getSetting(req.tdb, 'custom_payment_methods_json', '[]'));
    const customPaymentMethod = customPaymentMethods.find((item) => item.id === sourceOrder.payment_method);
    const paymentMethod = PAYMENT_METHODS.has(sourceOrder.payment_method) || isCustomPaymentMethod(sourceOrder.payment_method)
      ? sourceOrder.payment_method
      : 'cash';
    const paymentBreakdown = paymentBreakdownForMethod(paymentMethod, sourceOrder.total);
    if (isCustomPaymentMethod(paymentMethod)) {
      paymentBreakdown.customLabel = customPaymentMethod?.label || parseJsonObject(sourceOrder.payment_breakdown).customLabel || 'Medio personalizado';
    }
    const mergedNote = chatbotSummaryNote(sourceOrder);
    const deliveryAddress = String(sourceOrder.delivery_address || decrypt(sourceOrder.address_enc) || '').trim().slice(0, 300);
    const deliveryNeighborhood = String(sourceOrder.delivery_neighborhood || '').trim().slice(0, 160);
    const deliveryReference = String(sourceOrder.delivery_reference || ((sourceOrder.receiving_mode_behavior === 'delivery' || sourceOrder.delivery === 'domicilio') ? sourceOrder.notes : '') || '').trim().slice(0, 240);

    const update = await req.tdb.tx(async (tx) => {
      const claimed = await tx.run(
        `UPDATE {s}.orders
         SET channel = 'pos',
             source_channel = 'chatbot',
             status = 'entregado',
             pos_session_id = $1,
             payment_method = $2,
             payment_breakdown = $3,
             service_branch_id = $7,
             service_branch_name = $8,
             items = $9,
             cogs_total = $10,
             delivery_address = $11,
             delivery_neighborhood = $12,
             delivery_reference = $13,
             cash_received = CASE WHEN $2 = 'cash' THEN total ELSE NULL END,
             cash_change = 0,
             notes = CASE
               WHEN COALESCE(notes, '') = '' THEN $4
               ELSE notes || E'\n\n' || $4
             END
         WHERE id = $5
           AND channel = 'chatbot'
           AND status = ANY($6::text[])
           AND (created_at AT TIME ZONE '${req.timezone}')::date = (now() AT TIME ZONE '${req.timezone}')::date
         RETURNING id, total::float AS total, payment_method, payment_breakdown, cash_received::float AS cash_received,
                   cash_change::float AS cash_change, notes, order_notes, items,
                   to_char(created_at AT TIME ZONE '${req.timezone}', 'DD Mon YYYY, HH24:MI') AS created_at`,
        [session.id, paymentMethod, JSON.stringify(paymentBreakdown), mergedNote, id, Array.from(CHATBOT_IMPORTABLE_STATUSES), session.branch_id || null, session.branch_name || null, JSON.stringify(costedSourceItems), cogsTotal, deliveryAddress, deliveryNeighborhood, deliveryReference]
      );
      if (!claimed.rowCount) {
        throw Object.assign(new Error('El pedido ya no está disponible para integrarse al POS'), { statusCode: 409 });
      }
      if (!Number(sourceOrder.branch_stock_applied) && await decrementBranchStockForSale(tx, session.branch_id, costedSourceItems)) {
        await tx.run('UPDATE {s}.orders SET branch_stock_applied=1 WHERE id=$1', [id]);
      }
      return claimed;
    });

    const saleRow = await req.tdb.get(
      `SELECT id, invoice_code, invoice_token, subtotal::float AS subtotal, total::float AS total, delivery_fee::float AS delivery_fee,
              status, payment_method, payment_breakdown, cash_received::float AS cash_received,
              cash_change::float AS cash_change, notes, order_notes, items, delivery, receiving_mode_label, receiving_mode_behavior,
              delivery_address, delivery_neighborhood, delivery_reference,
              to_char(created_at AT TIME ZONE '${req.timezone}', 'DD Mon YYYY, HH24:MI') AS created_at
       FROM {s}.orders
       WHERE id = $1`,
      [id]
    );

    const totals = await getSessionTotals(req.tdb, session.id);
    res.json({
      ok: true,
      sale: {
        ...saleRow,
        notes: saleRow.order_notes || '',
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
    if (e?.statusCode) return res.status(e.statusCode).json({ error: e.message });
    if (e?.code === '23505') return res.status(409).json({ error: 'La mesa ya tiene una cuenta abierta' });
    return res.status(500).json({ error: e?.message || 'No se pudo pasar el pedido a caja' });
  }
});

router.get('/sales-history', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
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
    const myExisting = await getOpenSession(req.tdb, req.user.role === 'cashier'
      ? { forBranchId: req.user.branchId || null }
      : { forUsername: req.user.username || null });
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
    const session = await getOpenSession(req.tdb, selectedBranch
      ? { forBranchId: selectedBranch.id }
      : userSessionContext(req.user, req));
    res.json({ ok: true, sessionId: row.id, activeSession: { ...session, totals: await getSessionTotals(req.tdb, row.id), expectedCash: openingAmount } });
  } catch (e) {
    next(e);
  }
});

router.post('/session/close', async (req, res, next) => {
  try {
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'No hay una caja abierta' });
    const pendingPointPayment = await req.tdb.get(
      `SELECT p.id,o.self_service_folio
       FROM {s}.self_service_payments p JOIN {s}.orders o ON o.id=p.order_id
       WHERE p.pos_session_id=$1 AND p.status IN ('creating','created','at_terminal','action_required')
       ORDER BY p.id DESC LIMIT 1`,
      [session.id]
    );
    if (pendingPointPayment) {
      return res.status(409).json({
        error: `Hay un autocobro Mercado Pago en proceso (${pendingPointPayment.self_service_folio || pendingPointPayment.id}). Espera a que termine antes de cerrar caja.`,
      });
    }
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
    const closed = await getLastClosedSession(req.tdb, userSessionContext(req.user, req));
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
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
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

async function findPosSaleByIdempotency(t, key) {
  if (!key) return null;
  return t.get(
    `SELECT id, items, subtotal::float AS subtotal, total::float AS total, delivery_fee::float AS delivery_fee,
            payment_method, payment_breakdown, cash_received::float AS cash_received, cash_change::float AS cash_change,
            notes, delivery, delivery_address, delivery_neighborhood, delivery_reference, invoice_code, invoice_token
     FROM {s}.orders
     WHERE channel = 'pos' AND pos_idempotency_key = $1
     LIMIT 1`,
    [key]
  );
}

function posSaleResponse(row) {
  return {
    id: Number(row.id),
    subtotal: n(row.subtotal),
    deliveryFee: n(row.delivery_fee),
    total: n(row.total),
    items: parseJsonArray(row.items),
    paymentMethod: row.payment_method,
    paymentBreakdown: parseJsonObject(row.payment_breakdown),
    cashReceived: n(row.cash_received),
    cashChange: n(row.cash_change),
    notes: row.notes || '',
    delivery: row.delivery || 'mostrador',
    deliveryAddress: row.delivery_address || '',
    deliveryNeighborhood: row.delivery_neighborhood || '',
    deliveryReference: row.delivery_reference || '',
    invoiceCode: row.invoice_code,
    invoiceToken: row.invoice_token,
  };
}

async function createPosSale(req, res, next) {
  const idempotencyKey = String(req.body?.idempotencyKey || req.get('x-idempotency-key') || '').trim();
  try {
    if (idempotencyKey && !/^[a-zA-Z0-9_-]{12,80}$/.test(idempotencyKey)) {
      throw badRequest('La clave de seguridad de la venta no es válida');
    }
    const existingSale = await findPosSaleByIdempotency(req.tdb, idempotencyKey);
    if (existingSale) return res.json({ ok: true, duplicate: true, sale: posSaleResponse(existingSale) });
    const isDelivery = Boolean(req.body?.isDelivery);
    const deliveryFee = isDelivery ? Math.max(0, n(req.body?.deliveryFee)) : 0;
    const deliveryType = isDelivery ? 'domicilio' : 'mostrador';
    const notes = String(req.body?.notes || '').trim().slice(0, 240);
    const deliveryAddress = isDelivery ? String(req.body?.deliveryAddress || '').trim().replace(/\s+/g, ' ').slice(0, 300) : '';
    const deliveryNeighborhood = isDelivery ? String(req.body?.deliveryNeighborhood || '').trim().replace(/\s+/g, ' ').slice(0, 160) : '';
    const deliveryReference = isDelivery ? String(req.body?.deliveryReference || '').trim().replace(/\s+/g, ' ').slice(0, 240) : '';
    if (isDelivery && (!deliveryAddress || !deliveryNeighborhood)) {
      throw badRequest('Captura el domicilio y la colonia o barrio para la entrega');
    }
    const result = await req.tdb.tx(async (tx) => {
      const session = await getOpenSession(tx, userSessionContext(req.user, req));
      if (!session) throw badRequest('Abre una caja antes de registrar una venta');

      const saleItems = await normalizePosItems(tx, req.body?.items);
      const subtotal = n(saleItems.reduce((sum, item) => sum + item.price * item.qty, 0));
      const total = n(subtotal + deliveryFee);
      const paymentMethod = String(req.body?.paymentMethod || '').trim();
      const payment = await normalizeTenantPayment(tx, paymentMethod, req.body?.payments || {}, total, req.body?.cashReceived);
      const cogsTotal = itemsCost(saleItems);
      const row = await tx.get(
        `INSERT INTO {s}.orders
         (customer_id, items, subtotal, total, status, channel, source_channel, delivery, notes, payment_method, payment_breakdown, cash_received, cash_change, pos_session_id, delivery_fee, service_branch_id, service_branch_name, cogs_total, order_notes, delivery_address, delivery_neighborhood, delivery_reference, pos_idempotency_key)
         VALUES (NULL, $1, $2, $3, 'confirmado', 'pos', 'pos', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING id, invoice_code, invoice_token`,
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
          cogsTotal,
          notes,
          deliveryAddress,
          deliveryNeighborhood,
          deliveryReference,
          idempotencyKey,
        ]
      );
      if (await decrementBranchStockForSale(tx, session.branch_id, saleItems)) {
        await tx.run('UPDATE {s}.orders SET branch_stock_applied=1 WHERE id=$1', [row.id]);
      }
      return {
        row,
        session,
        saleItems,
        subtotal,
        total,
        payment,
      };
    });

    res.json({
      ok: true,
      sale: {
        id: result.row.id,
        subtotal: result.subtotal,
        deliveryFee,
        total: result.total,
        items: result.saleItems,
        paymentMethod: result.payment.method,
        paymentBreakdown: result.payment.breakdown,
        cashReceived: result.payment.cashReceived,
        cashChange: result.payment.cashChange,
        notes,
        delivery: deliveryType,
        deliveryAddress,
        deliveryNeighborhood,
        deliveryReference,
        invoiceCode: result.row.invoice_code,
        invoiceToken: result.row.invoice_token,
      },
    });
  } catch (e) {
    if (e.code === '23505' && idempotencyKey) {
      const existingSale = await findPosSaleByIdempotency(req.tdb, idempotencyKey);
      if (existingSale) return res.json({ ok: true, duplicate: true, sale: posSaleResponse(existingSale) });
    }
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    console.error('[pos][sale] error:', e?.message || e);
    next(e);
  }
}

router.post('/self-service/:id/checkout', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Pedido de autoservicio inválido' });
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre la caja de esta sucursal antes de cobrar el pedido' });

    const result = await req.tdb.tx(async (tx) => {
      const order = await tx.get(
        `SELECT o.id,o.self_service_folio,o.items,o.total::float AS total,o.notes,o.status,o.channel,o.service_branch_id,o.service_branch_name,
                c.name_enc,c.phone_enc
         FROM {s}.orders o LEFT JOIN {s}.customers c ON c.id=o.customer_id WHERE o.id=$1 FOR UPDATE OF o`,
        [orderId]
      );
      if (!order || order.channel !== 'kiosk') throw Object.assign(new Error('Pedido de autoservicio no encontrado'), { statusCode: 404 });
      if (order.status !== 'pendiente_cobro') throw Object.assign(new Error('Este pedido ya fue cobrado o cancelado'), { statusCode: 409 });
      if (Number(order.service_branch_id || 0) !== Number(session.branch_id || 0)) {
        throw Object.assign(new Error('El pedido pertenece a otra sucursal'), { statusCode: 403 });
      }
      const payment = await normalizeTenantPayment(
        tx,
        String(req.body?.paymentMethod || '').trim(),
        req.body?.payments || {},
        Number(order.total || 0),
        req.body?.cashReceived
      );
      const items = await attachCostsToExistingItems(tx, order.items);
      const cogsTotal = itemsCost(items);
      const updated = await tx.get(
        `UPDATE {s}.orders
         SET channel='pos',status='confirmado',items=$1,payment_method=$2,payment_breakdown=$3,
             cash_received=$4,cash_change=$5,pos_session_id=$6,cogs_total=$7
         WHERE id=$8
         RETURNING id,invoice_code,invoice_token,self_service_folio,total::float AS total`,
        [JSON.stringify(items), payment.method, JSON.stringify(payment.breakdown), payment.cashReceived || null,
          payment.cashChange || null, session.id, cogsTotal, orderId]
      );
      const stockApplied = await decrementBranchStockForSale(tx, session.branch_id, items);
      if (stockApplied) await tx.run('UPDATE {s}.orders SET branch_stock_applied=1 WHERE id=$1', [orderId]);
      await insertSalesAudit(tx, req, {
        eventType: 'self_service_paid', orderId, sessionId: session.id, branchId: session.branch_id,
        amount: order.total, reason: `Cobro de autoservicio ${order.self_service_folio || orderId}`,
        before: { status: 'pendiente_cobro', channel: 'kiosk' },
        after: { status: 'confirmado', channel: 'pos', paymentMethod: payment.method },
      });
      return { order, updated, items, payment };
    });

    const sale = {
      id: result.updated.id,
      folio: result.updated.self_service_folio,
      subtotal: Number(result.updated.total), total: Number(result.updated.total), deliveryFee: 0,
      items: result.items, notes: result.order.notes || '', delivery: 'mostrador',
      paymentMethod: result.payment.method, paymentBreakdown: result.payment.breakdown,
      cashReceived: result.payment.cashReceived, cashChange: result.payment.cashChange,
      serviceBranchId: Number(result.order.service_branch_id), serviceBranchName: result.order.service_branch_name,
      invoiceCode: result.updated.invoice_code, invoiceToken: result.updated.invoice_token,
      customerName: decrypt(result.order.name_enc) || 'Cliente',
      customerPhone: decrypt(result.order.phone_enc) || '',
    };
    emitSelfServiceStatus(req.tenant.slug, { id: orderId, folio: sale.folio, status: 'confirmado' });
    emitNewOrder(req.tenant.slug, {
      id: orderId, businessName: req.tenant.business_name, total: sale.total,
      summary: `Autoservicio ${sale.folio} · ${result.items.length} producto(s) · Total ${sale.total}`,
    }).catch(error => console.error('[pos][self-service][notify] error:', error?.message || error));
    const totals = await getSessionTotals(req.tdb, session.id);
    res.json({ ok: true, sale, totals, expectedCash: expectedCashForSession(session, totals) });
  } catch (error) {
    if ([400, 403, 404, 409].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.post('/self-service/:id/cancel', async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({ error: 'Pedido inválido' });
    const session = await getOpenSession(req.tdb, userSessionContext(req.user, req));
    if (!session) return res.status(400).json({ error: 'Abre la caja de esta sucursal antes de cancelar el pedido' });
    const row = await req.tdb.get(
      `UPDATE {s}.orders SET status='cancelado',cancel_note=$1
       WHERE id=$2 AND channel='kiosk' AND status='pendiente_cobro' AND service_branch_id=$3
       RETURNING id,self_service_folio,service_branch_id`,
      [String(req.body?.reason || 'Cancelado en caja').trim().slice(0, 180), orderId, session.branch_id]
    );
    if (!row) return res.status(409).json({ error: 'El pedido ya fue cobrado, cancelado, no existe o pertenece a otra sucursal' });
    emitSelfServiceStatus(req.tenant.slug, { id: orderId, folio: row.self_service_folio, status: 'cancelado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/sales/:id/cancel', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Venta inválida' });
    const policy = await getPosPolicy(req.tdb);
    if (!policy.sameDayCancelEnabled) return res.status(403).json({ error: 'La cancelación de ventas está deshabilitada por el negocio' });
    const reason = String(req.body?.reason || '').trim().slice(0, 180);
    if (!reason) return res.status(400).json({ error: 'Escribe el motivo de la cancelación' });
    const authorizedBy = await authorizePosAction(req.tdb, req.body?.pin, policy.cancelRequirePin);
    const stamp = new Date().toLocaleString('es-MX', { timeZone: req.timezone });
    const cancelText = `[CANCELADO ${stamp}] ${reason}`;
    const sale = await req.tdb.tx(async (tx) => {
      const row = await tx.get(
        `SELECT id, status, notes, pos_session_id, items, total::float AS total, payment_method,
                service_branch_id, pickup_branch_id, branch_stock_applied, table_account_id,
                ((created_at AT TIME ZONE '${tenantTimeZone(tx)}')::date = (now() AT TIME ZONE '${tenantTimeZone(tx)}')::date) AS is_today
         FROM {s}.orders WHERE id=$1 AND channel='pos' FOR UPDATE`,
        [id]
      );
      if (!row) throw Object.assign(new Error('No se encontró la venta POS'), { statusCode: 404 });
      if (row.status === 'cancelado') throw Object.assign(new Error('La venta ya está cancelada'), { statusCode: 409 });
      if (!row.is_today) throw Object.assign(new Error('Sólo se pueden cancelar ventas del mismo día'), { statusCode: 409 });
      const fiscalInvoice = await tx.get(
        `SELECT status FROM {s}.invoices WHERE order_id=$1 AND status IN ('pending','unknown','active','cancel_pending') ORDER BY id DESC LIMIT 1`,
        [id]
      );
      if (fiscalInvoice) {
        throw Object.assign(new Error('Cancela primero el CFDI de esta venta desde Facturación MX'), { statusCode: 409 });
      }
      const globalInvoice = await tx.get(
        `SELECT gi.status FROM {s}.global_invoice_orders gio JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id
         WHERE gio.order_id=$1 AND gio.active=1 AND gi.status IN ('pending','unknown','active') LIMIT 1`, [id]
      );
      if (globalInvoice) {
        throw Object.assign(new Error('Esta venta pertenece a una factura global; cancela y regenera primero el CFDI global'), { statusCode: 409 });
      }
      await tx.run(
        `UPDATE {s}.orders SET status='cancelado', branch_stock_applied=0,
         notes=CASE WHEN COALESCE(notes,'')='' THEN $1 ELSE notes || E'\n' || $1 END WHERE id=$2`,
        [cancelText, id]
      );
      if (Number(row.branch_stock_applied)) await restoreBranchStockForCancelledSale(tx, row.service_branch_id || row.pickup_branch_id, row.items);
      await insertSalesAudit(tx, req, {
        eventType: 'sale_cancelled', orderId: id, tableAccountId: row.table_account_id,
        sessionId: row.pos_session_id, branchId: row.service_branch_id || row.pickup_branch_id,
        amount: row.total, reason, authorizedBy,
        before: { status: row.status, total: n(row.total), paymentMethod: row.payment_method, items: parseJsonArray(row.items) },
        after: { status: 'cancelado' },
      });
      return row;
    });

    const totals = sale.pos_session_id ? await getSessionTotals(req.tdb, sale.pos_session_id) : null;
    res.json({ ok: true, saleId: id, totals });
  } catch (e) {
    if ([400, 403, 404, 409].includes(e.statusCode)) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

router.put('/sales/:id/payment', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Venta inválida' });
    const sale = await req.tdb.get(
      `SELECT id, total::float AS total, status, pos_session_id, payment_method, payment_breakdown,
              cash_received::float AS cash_received, cash_change::float AS cash_change, service_branch_id
       FROM {s}.orders
       WHERE id = $1 AND channel = 'pos'
       LIMIT 1`,
      [id]
    );
    if (!sale) return res.status(404).json({ error: 'No se encontró la venta POS' });
    if (sale.status === 'cancelado') return res.status(409).json({ error: 'No se puede cambiar pago de una venta cancelada' });
    const fiscalInvoice = await req.tdb.get(
      `SELECT status FROM {s}.invoices WHERE order_id=$1 AND status IN ('pending','unknown','active','cancel_pending') ORDER BY id DESC LIMIT 1`,
      [id]
    );
    if (fiscalInvoice) return res.status(409).json({ error: 'No puedes cambiar el pago después de timbrar; cancela primero el CFDI' });
    const globalInvoice = await req.tdb.get(
      `SELECT gi.status FROM {s}.global_invoice_orders gio JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id
       WHERE gio.order_id=$1 AND gio.active=1 AND gi.status IN ('pending','unknown','active') LIMIT 1`, [id]
    );
    if (globalInvoice) return res.status(409).json({ error: 'No puedes cambiar el pago de una venta incluida en una factura global' });

    const paymentMethod = String(req.body?.paymentMethod || '').trim();
    const payment = await normalizeTenantPayment(req.tdb, paymentMethod, req.body?.payments || {}, n(sale.total), req.body?.cashReceived);
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
    await insertSalesAudit(req.tdb, req, {
      eventType: 'sale_payment_edited', orderId: id, sessionId: sale.pos_session_id,
      branchId: sale.service_branch_id, amount: sale.total, reason: 'Cambio de forma de pago',
      before: { paymentMethod: sale.payment_method, paymentBreakdown: sale.payment_breakdown, cashReceived: sale.cash_received, cashChange: sale.cash_change },
      after: { paymentMethod: payment.method, paymentBreakdown: payment.breakdown, cashReceived: payment.cashReceived, cashChange: payment.cashChange },
    });

    const updated = await req.tdb.get(
      `SELECT id, total::float AS total, status, payment_method, payment_breakdown,
              cash_received::float AS cash_received, cash_change::float AS cash_change,
              notes, items,
              to_char(created_at AT TIME ZONE '${req.timezone}', 'DD Mon YYYY, HH24:MI') AS created_at
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

router.get('/audit-log', async (req, res, next) => {
  try {
    const isCashier = req.user?.role === 'cashier';
    const requestedPage = Math.max(1, Number(req.query.page) || 1);
    const requestedPageSize = Number(req.query.pageSize) || 10;
    const pageSize = [10, 20, 50].includes(requestedPageSize) ? requestedPageSize : 10;
    const filter = SALES_HISTORY_FILTERS.has(req.query.filter) ? req.query.filter : 'month';
    const search = String(req.query.search || '').trim().slice(0, 80);
    const branchId = isCashier
      ? (req.user?.branchId ? String(req.user.branchId) : 'general')
      : String(req.query.branchId || 'all').trim();
    const startDate = normalizeIsoDate(req.query.startDate);
    const endDate = normalizeIsoDate(req.query.endDate);
    if (req.query.startDate && !startDate) throw badRequest('La fecha inicial no es válida');
    if (req.query.endDate && !endDate) throw badRequest('La fecha final no es válida');
    const params = [];
    const where = [];
    const localCreatedAt = `(sal.created_at AT TIME ZONE '${tenantTimeZone(req.tdb)}')`;
    if (search) {
      params.push(`%${search}%`);
      where.push(`(CAST(sal.id AS TEXT) ILIKE $${params.length} OR CAST(sal.order_id AS TEXT) ILIKE $${params.length} OR CAST(sal.table_account_id AS TEXT) ILIKE $${params.length} OR sal.actor_username ILIKE $${params.length} OR sal.reason ILIKE $${params.length} OR sal.event_type ILIKE $${params.length})`);
    }
    if (branchId === 'general') {
      where.push('sal.branch_id IS NULL');
    } else if (Number.isInteger(Number(branchId)) && Number(branchId) > 0) {
      params.push(Number(branchId));
      where.push(`sal.branch_id = $${params.length}`);
    }
    if (filter === 'today') where.push(`${localCreatedAt}::date = (now() AT TIME ZONE '${tenantTimeZone(req.tdb)}')::date`);
    if (filter === 'week') where.push(`${localCreatedAt} >= date_trunc('week', now() AT TIME ZONE '${tenantTimeZone(req.tdb)}')`);
    if (filter === 'month') where.push(`${localCreatedAt} >= date_trunc('month', now() AT TIME ZONE '${tenantTimeZone(req.tdb)}')`);
    if (filter === 'custom') {
      if (!startDate || !endDate) throw badRequest('Selecciona fecha inicial y fecha final');
      if (startDate > endDate) throw badRequest('La fecha inicial no puede ser mayor que la fecha final');
      params.push(startDate);
      where.push(`${localCreatedAt}::date >= $${params.length}::date`);
      params.push(endDate);
      where.push(`${localCreatedAt}::date <= $${params.length}::date`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const summary = await req.tdb.get(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE sal.event_type='sale_cancelled')::int AS cancellations,
              COUNT(*) FILTER (WHERE sal.event_type IN ('table_round_edited','table_round_deleted'))::int AS round_edits,
              COUNT(*) FILTER (WHERE sal.event_type='sale_payment_edited')::int AS payment_edits,
              COALESCE(SUM(sal.amount) FILTER (WHERE sal.event_type='sale_cancelled'),0)::float AS cancelled_amount,
              COALESCE(SUM(ABS(sal.amount)) FILTER (WHERE sal.event_type IN ('table_round_edited','table_round_deleted')),0)::float AS corrected_amount
       FROM {s}.sales_audit_log sal ${whereSql}`,
      params
    );
    const total = Number(summary?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await req.tdb.all(
      `SELECT sal.id, sal.event_type, sal.order_id, sal.table_account_id, sal.table_round_id, sal.session_id, sal.branch_id,
              sal.amount::float AS amount, sal.reason, sal.actor_username, sal.actor_role, sal.authorized_by,
              sal.before_data, sal.after_data, COALESCE(b.name, 'General') AS branch_name,
              to_char(sal.created_at AT TIME ZONE '${tenantTimeZone(req.tdb)}', 'DD Mon YYYY, HH24:MI') AS created_at
       FROM {s}.sales_audit_log sal
       LEFT JOIN {s}.branches b ON b.id=sal.branch_id
       ${whereSql} ORDER BY sal.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const branches = isCashier
      ? (req.user?.branchId ? [{ id: Number(req.user.branchId), name: req.user.branchName || 'Mi sucursal' }] : [{ id: 'general', name: 'General' }])
      : await req.tdb.all('SELECT id, name FROM {s}.branches ORDER BY active DESC, name');
    res.json({ rows, branches, summary, page, pageSize, total, totalPages, filter, startDate, endDate, search, branchId });
  } catch (e) {
    if (e.statusCode === 400) return res.status(400).json({ error: e.message });
    next(e);
  }
});

router.get('/cuts', async (req, res, next) => {
  try {
    const isCashier = req.user?.role === 'cashier';
    const requestedPage = Math.max(1, Number(req.query.page) || 1);
    const requestedPageSize = Number(req.query.pageSize) || 10;
    const pageSize = [10, 20, 40, 60].includes(requestedPageSize) ? requestedPageSize : 10;
    const search = String(req.query.search || '').trim().slice(0, 80);
    const branchId = isCashier
      ? (req.user?.branchId ? String(req.user.branchId) : 'general')
      : String(req.query.branchId || 'all').trim();
    const params = [];
    const where = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(CAST(id AS TEXT) ILIKE $${params.length} OR opened_by ILIKE $${params.length} OR closed_by ILIKE $${params.length} OR COALESCE(branch_name, 'General') ILIKE $${params.length})`);
    }
    if (branchId === 'general') {
      where.push('branch_id IS NULL');
    } else if (Number.isInteger(Number(branchId)) && Number(branchId) > 0) {
      params.push(Number(branchId));
      where.push(`branch_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = await req.tdb.get(`SELECT COUNT(*)::int AS total FROM {s}.pos_sessions ${whereSql}`, params);
    const total = Number(totalRow?.total || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await req.tdb.all(
      `SELECT id, status, opening_amount::float AS opening_amount, closing_amount::float AS closing_amount,
              expected_amount::float AS expected_amount, difference_amount::float AS difference_amount,
              branch_id, branch_name, notes, opened_by, closed_by,
              to_char(opened_at AT TIME ZONE '${tenantTimeZone(req.tdb)}', 'DD Mon YYYY, HH24:MI') AS opened_at,
              to_char(closed_at AT TIME ZONE '${tenantTimeZone(req.tdb)}', 'DD Mon YYYY, HH24:MI') AS closed_at
       FROM {s}.pos_sessions ${whereSql} ORDER BY opened_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const enriched = await Promise.all(rows.map(async (row) => {
      const totals = await getSessionTotals(req.tdb, row.id);
      return {
        ...row,
        expected_cash: row.status === 'closed' ? n(row.expected_amount) : expectedCashForSession(row, totals),
        totals,
      };
    }));
    const branches = isCashier
      ? (req.user?.branchId ? [{ id: Number(req.user.branchId), name: req.user.branchName || 'Mi sucursal' }] : [{ id: 'general', name: 'General' }])
      : await req.tdb.all('SELECT id, name FROM {s}.branches ORDER BY active DESC, name');
    res.json({ rows: enriched, branches, page, pageSize, total, totalPages, search, branchId });
  } catch (e) { next(e); }
});

module.exports = router;
