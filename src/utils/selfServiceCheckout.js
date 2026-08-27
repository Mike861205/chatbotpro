const { decrypt } = require('./crypto');
const { itemsCost, preciseCost } = require('./costing');
const { applyBranchSaleStock } = require('./branchStock');

function parseItems(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function getOpenBranchSession(t, branchId) {
  return t.get(
    `SELECT id,status,branch_id,branch_name,opened_by
     FROM {s}.pos_sessions
     WHERE status='open' AND branch_id=$1
     ORDER BY opened_at DESC LIMIT 1`,
    [Number(branchId)]
  );
}

async function attachCosts(t, inputItems) {
  const items = parseItems(inputItems);
  const ids = [...new Set(items.map((item) => Number(item?.id || item?.product_id || 0)).filter((id) => id > 0))];
  if (!ids.length) return items;
  const rows = await t.all('SELECT id,COALESCE(unit_cost,0)::float AS unit_cost FROM {s}.products WHERE id=ANY($1::int[])', [ids]);
  const costs = new Map(rows.map((row) => [Number(row.id), preciseCost(row.unit_cost)]));
  return items.map((item) => {
    const qty = Math.max(0, Number(item?.qty || item?.quantity || 0));
    const existing = Number(item?.unitCost ?? item?.unit_cost);
    const unitCost = Number.isFinite(existing) && existing >= 0
      ? preciseCost(existing)
      : (costs.get(Number(item?.id || item?.product_id || 0)) || 0);
    return { ...item, unitCost, lineCost: preciseCost(unitCost * qty) };
  });
}

function saleFromResult(result) {
  return {
    id: Number(result.updated.id),
    folio: result.updated.self_service_folio,
    subtotal: Number(result.updated.total),
    total: Number(result.updated.total),
    deliveryFee: 0,
    items: result.items,
    notes: result.order.notes || '',
    delivery: 'mostrador',
    paymentMethod: result.payment.method,
    paymentBreakdown: result.payment.breakdown,
    cashReceived: result.payment.cashReceived || 0,
    cashChange: result.payment.cashChange || 0,
    paymentProvider: result.payment.provider || '',
    paymentReference: result.payment.reference || '',
    serviceBranchId: Number(result.order.service_branch_id),
    serviceBranchName: result.order.service_branch_name,
    invoiceCode: result.updated.invoice_code,
    invoiceToken: result.updated.invoice_token,
    customerName: decrypt(result.order.name_enc) || 'Cliente',
    customerPhone: decrypt(result.order.phone_enc) || '',
  };
}

function parseObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

async function finalizeSelfServiceOrder(t, {
  orderId,
  sessionId,
  payment,
  actorUsername = 'autoservicio',
  actorRole = 'system',
  allowAlreadyPaid = false,
}) {
  return t.tx(async (tx) => {
    const order = await tx.get(
      `SELECT o.id,o.self_service_folio,o.items,o.total::float AS total,o.notes,o.status,o.channel,o.service_branch_id,o.service_branch_name,
              o.payment_method,o.payment_breakdown,o.payment_provider,o.payment_reference,o.pos_session_id,
              o.invoice_code,o.invoice_token,c.name_enc,c.phone_enc
       FROM {s}.orders o LEFT JOIN {s}.customers c ON c.id=o.customer_id
       WHERE o.id=$1 FOR UPDATE OF o`,
      [Number(orderId)]
    );
    if (!order || (!['kiosk', 'pos'].includes(order.channel))) {
      throw Object.assign(new Error('Pedido de autoservicio no encontrado'), { statusCode: 404 });
    }
    if (order.status !== 'pendiente_cobro') {
      if (!allowAlreadyPaid || order.status === 'cancelado') {
        throw Object.assign(new Error('Este pedido ya fue cobrado o cancelado'), { statusCode: 409 });
      }
      const existingItems = parseItems(order.items);
      const existingPayment = {
        method: order.payment_method,
        breakdown: parseObject(order.payment_breakdown),
        provider: order.payment_provider,
        reference: order.payment_reference,
      };
      return { sale: saleFromResult({ order, updated: order, items: existingItems, payment: existingPayment }), alreadyPaid: true };
    }
    const session = await tx.get('SELECT id,branch_id FROM {s}.pos_sessions WHERE id=$1 AND status=\'open\' LIMIT 1', [Number(sessionId)]);
    if (!session || Number(session.branch_id) !== Number(order.service_branch_id)) {
      throw Object.assign(new Error('La caja de esta sucursal debe permanecer abierta para completar el autocobro'), { statusCode: 409 });
    }
    const items = await attachCosts(tx, order.items);
    const cogsTotal = itemsCost(items);
    const breakdown = { ...(payment.breakdown || {}) };
    const updated = await tx.get(
      `UPDATE {s}.orders
       SET channel='pos',status='confirmado',items=$1,payment_method=$2,payment_breakdown=$3,
           cash_received=$4,cash_change=$5,pos_session_id=$6,cogs_total=$7,
           payment_provider=$8,payment_reference=$9
       WHERE id=$10
       RETURNING id,invoice_code,invoice_token,self_service_folio,total::float AS total`,
      [JSON.stringify(items), payment.method, JSON.stringify(breakdown), payment.cashReceived || null,
        payment.cashChange || null, session.id, cogsTotal, payment.provider || '', payment.reference || '', Number(orderId)]
    );
    const stockApplied = await applyBranchSaleStock(tx, session.branch_id, items);
    if (stockApplied) await tx.run('UPDATE {s}.orders SET branch_stock_applied=1 WHERE id=$1', [Number(orderId)]);
    await tx.run(
      `INSERT INTO {s}.sales_audit_log
       (event_type,order_id,session_id,branch_id,amount,reason,actor_username,actor_role,before_data,after_data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      ['self_service_paid', Number(orderId), session.id, session.branch_id, Number(order.total),
        `Cobro de autoservicio ${order.self_service_folio || orderId}`, actorUsername, actorRole,
        JSON.stringify({ status: 'pendiente_cobro', channel: 'kiosk' }),
        JSON.stringify({ status: 'confirmado', channel: 'pos', paymentMethod: payment.method, provider: payment.provider || '' })]
    );
    const sale = saleFromResult({ order, updated, items, payment });
    return { sale, alreadyPaid: false };
  });
}

module.exports = { finalizeSelfServiceOrder, getOpenBranchSession };
