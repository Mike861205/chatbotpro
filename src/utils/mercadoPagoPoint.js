const crypto = require('node:crypto');
const config = require('../config');

const API_BASE = 'https://api.mercadopago.com';
const FINAL_STATUSES = new Set(['processed', 'failed', 'canceled', 'expired', 'refunded']);
const SAFE_TERMINAL_ID = /^[A-Z0-9_-]{4,100}$/i;
const mockOrders = new Map();

function pointConfiguration(terminalId = '') {
  const sandboxTerminal = config.MERCADO_PAGO_POINT_TERMINAL_ID || 'NEWLAND_N950__SBX0000001';
  const resolvedTerminal = String(config.MERCADO_PAGO_POINT_MODE === 'sandbox'
    ? sandboxTerminal
    : terminalId || config.MERCADO_PAGO_POINT_TERMINAL_ID).trim();
  const testRuntime = config.NODE_ENV !== 'production';
  const mock = testRuntime && config.MERCADO_PAGO_POINT_MODE === 'sandbox' && config.MERCADO_PAGO_POINT_MOCK;
  return {
    configured: Boolean((mock || config.MERCADO_PAGO_ACCESS_TOKEN) && resolvedTerminal && SAFE_TERMINAL_ID.test(resolvedTerminal)),
    mode: config.MERCADO_PAGO_POINT_MODE,
    terminalId: resolvedTerminal,
    autoSimulate: mock || (testRuntime && config.MERCADO_PAGO_POINT_MODE === 'sandbox' && config.MERCADO_PAGO_POINT_AUTO_SIMULATE),
    mock,
  };
}

function publicPointConfiguration(terminalId = '') {
  const current = pointConfiguration(terminalId);
  return {
    configured: current.configured,
    mode: current.mode,
    autoSimulate: current.autoSimulate,
    mock: current.mock,
    terminalConfigured: Boolean(current.terminalId),
  };
}

function providerErrorMessage(payload, status) {
  const detail = payload?.message || payload?.error || payload?.code || '';
  if (status === 401) return 'Las credenciales de Mercado Pago no son validas para Point';
  if (status === 403) return 'La terminal Point no esta vinculada a esta cuenta de Mercado Pago';
  if (status === 409 && String(detail).includes('already_queued')) return 'La terminal tiene otro cobro pendiente';
  const detailSuffix = detail ? `: ${String(detail).slice(0, 140)}` : '';
  return `Mercado Pago no pudo procesar la solicitud${detailSuffix}`;
}

async function request(path, { method = 'GET', body, idempotencyKey, extraHeaders = {} } = {}) {
  if (!config.MERCADO_PAGO_ACCESS_TOKEN) {
    throw Object.assign(new Error('Mercado Pago Point no esta configurado en el servidor'), { statusCode: 503 });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.MERCADO_PAGO_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.MERCADO_PAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      throw Object.assign(new Error(providerErrorMessage(payload, response.status)), {
        statusCode: response.status >= 500 ? 502 : 409,
        providerStatus: response.status,
        providerPayload: payload,
      });
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error('Mercado Pago tardo demasiado en responder'), { statusCode: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function paymentData(order = {}) {
  const payment = order?.transactions?.payments?.[0] || {};
  return {
    providerOrderId: String(order.id || ''),
    externalReference: String(order.external_reference || ''),
    status: String(order.status || 'created').toLowerCase(),
    statusDetail: String(order.status_detail || payment.status_detail || ''),
    amount: Number(payment.paid_amount || payment.amount || order.total_paid_amount || 0),
    paymentMethodType: String(payment.payment_method?.type || ''),
    paymentMethodId: String(payment.payment_method?.id || ''),
    paymentReference: String(payment.reference?.id || payment.reference_id || payment.id || ''),
    raw: order,
  };
}

async function createPointOrder({ amount, externalReference, terminalId, cardType, description, idempotencyKey }) {
  const point = pointConfiguration(terminalId);
  if (!point.configured) throw Object.assign(new Error('Configura la terminal y el Access Token de Mercado Pago Point'), { statusCode: 503 });
  const paymentType = cardType === 'credit' ? 'credit_card' : 'debit_card';
  if (point.mock) {
    const id = `MOCK${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
    const order = {
      id,
      type: 'point',
      external_reference: String(externalReference).slice(0, 64),
      status: 'created',
      status_detail: '',
      transactions: { payments: [{ amount: Number(amount).toFixed(2), payment_method: { type: paymentType } }] },
      config: { point: { terminal_id: point.terminalId, print_on_terminal: 'no_ticket' } },
      description: String(description || '').slice(0, 150),
      idempotency_key: idempotencyKey,
    };
    mockOrders.set(id, order);
    return paymentData(order);
  }
  const order = await request('/v1/orders', {
    method: 'POST',
    idempotencyKey,
    body: {
      type: 'point',
      external_reference: String(externalReference).slice(0, 64),
      transactions: { payments: [{ amount: Number(amount).toFixed(2) }] },
      config: {
        point: { terminal_id: point.terminalId, print_on_terminal: 'no_ticket' },
        payment_method: { default_type: paymentType },
      },
      description: String(description || 'Pedido de autoservicio').slice(0, 150),
    },
  });
  return paymentData(order);
}

async function getPointOrder(providerOrderId) {
  const id = encodeURIComponent(String(providerOrderId || ''));
  if (!id) throw Object.assign(new Error('Referencia de cobro invalida'), { statusCode: 400 });
  if (mockOrders.has(String(providerOrderId))) return paymentData(mockOrders.get(String(providerOrderId)));
  return paymentData(await request(`/v1/orders/${id}`));
}

async function simulatePointOrder(providerOrderId, cardType = 'debit') {
  if (config.MERCADO_PAGO_POINT_MODE !== 'sandbox') {
    throw Object.assign(new Error('La simulacion solo esta disponible en sandbox'), { statusCode: 403 });
  }
  const credit = cardType === 'credit';
  if (mockOrders.has(String(providerOrderId))) {
    const order = mockOrders.get(String(providerOrderId));
    const amount = order.transactions.payments[0].amount;
    order.status = 'processed';
    order.status_detail = 'accredited';
    order.total_paid_amount = amount;
    order.transactions.payments[0] = {
      ...order.transactions.payments[0], paid_amount: amount, status: 'processed', status_detail: 'accredited',
      id: `PAY${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`,
      payment_method: { type: credit ? 'credit_card' : 'debit_card', id: credit ? 'visa' : 'debvisa', installments: 1 },
      reference: { id: String(Date.now()) },
    };
    return;
  }
  await request(`/v1/orders/${encodeURIComponent(providerOrderId)}/events`, {
    method: 'POST',
    body: {
      status: 'processed',
      payment_method_type: credit ? 'credit_card' : 'debit_card',
      ...(credit ? { installments: 1 } : {}),
      payment_method_id: credit ? 'visa' : 'debvisa',
      status_detail: 'accredited',
    },
  });
}

function isFinalPointStatus(status) {
  return FINAL_STATUSES.has(String(status || '').toLowerCase());
}

function validateWebhookSignature({ xSignature, xRequestId, dataId }) {
  const secret = config.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) return true;
  const parts = Object.fromEntries(String(xSignature || '').split(',').map((part) => part.trim().split('=')));
  if (!parts.ts || !parts.v1 || !xRequestId || !dataId) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${xRequestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
  } catch { return false; }
}

module.exports = {
  createPointOrder,
  getPointOrder,
  isFinalPointStatus,
  paymentData,
  pointConfiguration,
  publicPointConfiguration,
  simulatePointOrder,
  validateWebhookSignature,
};
