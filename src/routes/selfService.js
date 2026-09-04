const express = require('express');
const crypto = require('node:crypto');
const { q, tdb, getSetting } = require('../db');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/security');
const { normalizeTimeZone } = require('../utils/regional');
const { encrypt, lookupHash } = require('../utils/crypto');
const { normalizeInternationalPhone } = require('../utils/phone');
const { emitNewOrder, emitSelfServiceOrder, emitSelfServiceStatus } = require('../notifications');
const {
  createPointOrder,
  getPointOrder,
  isFinalPointStatus,
  pointConfiguration,
  publicPointConfiguration,
  simulatePointOrder,
  validateWebhookSignature,
} = require('../utils/mercadoPagoPoint');
const { finalizeSelfServiceOrder, getOpenBranchSession } = require('../utils/selfServiceCheckout');
const { trialState } = require('../utils/trialAccess');
const { loadProductTaxConfig, effectiveProductPrice, productTaxLineSnapshot, applyProductTaxToCatalogProduct } = require('../utils/productTax');

const router = express.Router();
const publicLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'Demasiadas solicitudes de autoservicio. Espera un momento.',
});

const cleanSlug = (value) => String(value || '').trim().toLowerCase();
const money = (value) => Number((Number(value) || 0).toFixed(2));
const parseJson = (value, fallback = []) => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

function normalizeCustomer(reqBody = {}) {
  if (!reqBody || typeof reqBody !== 'object') reqBody = {};
  const name = String(reqBody.customerName || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name.length < 2) throw Object.assign(new Error('Escribe el nombre para tu pedido'), { status: 400 });
  const rawPhone = String(reqBody.customerPhone || '').trim();
  const normalizedPhone = rawPhone
    ? normalizeInternationalPhone(rawPhone, reqBody.phoneCountry || 'MX')
    : null;
  return { name, phone: normalizedPhone?.e164 || '', phoneHash: normalizedPhone ? lookupHash(normalizedPhone.digits) : null };
}

const SELF_SERVICE_PAYMENT_CONFIG = [
  { id: 'cash', method: 'cash', cardType: '', label: 'Efectivo', setting: 'self_service_payment_cash' },
  { id: 'debit', method: 'card', cardType: 'debit', label: 'Tarjeta de débito', setting: 'self_service_payment_debit' },
  { id: 'credit', method: 'card', cardType: 'credit', label: 'Tarjeta de crédito', setting: 'self_service_payment_credit' },
  { id: 'transfer', method: 'transfer', cardType: '', label: 'Transferencia', setting: 'self_service_payment_transfer' },
];

function enabledSelfServicePayments(settings = {}) {
  const configured = SELF_SERVICE_PAYMENT_CONFIG.filter((option) => String(settings[option.setting] || '0') === '1');
  return configured.length ? configured : [SELF_SERVICE_PAYMENT_CONFIG[0]];
}

function normalizeSelfServicePayment(reqBody, enabledOptions) {
  const requestedId = String(reqBody?.paymentChoice || '').trim().toLowerCase();
  const selected = enabledOptions.find((option) => option.id === requestedId);
  if (!selected) throw Object.assign(new Error('Selecciona una forma de pago disponible'), { status: 400 });
  return selected;
}

function deviceUrl(slug, token) {
  return `/autoservicio/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`;
}

async function resolveDevice(slug, token) {
  const found = await q(
    `SELECT id, slug, business_name, logo, primary_color, account_status, billing_status, timezone,
            customer_since, trial_status, trial_started_on, trial_ends_on
     FROM tenants WHERE slug=$1 LIMIT 1`,
    [cleanSlug(slug)]
  );
  const tenant = found.rows[0];
  if (!tenant || tenant.account_status !== 'active' || tenant.billing_status === 'suspended' || trialState(tenant).isExpired) return null;
  const tenantDb = tdb(tenant.slug);
  tenant.timezone = normalizeTimeZone(tenant.timezone);
  tenantDb.timezone = tenant.timezone;
  const device = await tenantDb.get(
    `SELECT d.id,d.name,d.branch_id,d.active,d.mercado_pago_terminal_id,b.name AS branch_name,b.address AS branch_address
     FROM {s}.self_service_devices d
     JOIN {s}.branches b ON b.id=d.branch_id AND b.active=1
     WHERE d.access_token=$1 AND d.active=1 LIMIT 1`,
    [String(token || '')]
  );
  if (!device) return null;
  const enabled = String(await getSetting(tenantDb, 'self_service_enabled', '0')) === '1';
  return { tenant, tenantDb, device, enabled };
}

function ensureSelfServiceEnabled(found, res) {
  if (found.enabled) return true;
  res.status(403).json({
    error: 'Autoservicio desactivado',
    detail: 'Actívalo y guarda la configuración en Mi negocio.',
    code: 'SELF_SERVICE_DISABLED',
  });
  return false;
}

function parseObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function pointAttemptPayload(row) {
  if (!row) return null;
  const status = String(row.status || 'creating');
  return {
    status,
    statusDetail: row.status_detail || '',
    final: isFinalPointStatus(status),
    paid: status === 'processed',
    paymentMethodType: row.payment_method_type || '',
  };
}

async function updatePointAttempt(tenantDb, attemptId, payment) {
  await tenantDb.run(
    `UPDATE {s}.self_service_payments
     SET provider_order_id=COALESCE(NULLIF($1,''),provider_order_id),status=$2,status_detail=$3,
         payment_method_type=$4,payment_method_id=$5,payment_reference=$6,raw_response=$7,updated_at=now()
     WHERE id=$8`,
    [payment.providerOrderId, payment.status, payment.statusDetail, payment.paymentMethodType,
      payment.paymentMethodId, payment.paymentReference, JSON.stringify(payment.raw || {}), Number(attemptId)]
  );
}

async function completeProcessedPointPayment(found, order, attempt, providerPayment) {
  if (providerPayment.statusDetail && providerPayment.statusDetail !== 'accredited') {
    throw Object.assign(new Error('Mercado Pago no reporto el pago como acreditado'), { statusCode: 409 });
  }
  if (Math.abs(Number(providerPayment.amount || 0) - Number(order.total || 0)) > 0.01) {
    throw Object.assign(new Error('El monto acreditado por Mercado Pago no coincide con el pedido'), { statusCode: 409 });
  }
  const paymentMethodType = providerPayment.paymentMethodType || attempt.payment_method_type || '';
  const cardType = paymentMethodType === 'credit_card' ? 'credit' : 'debit';
  const reference = providerPayment.paymentReference || attempt.payment_reference || providerPayment.providerOrderId;
  const completed = await finalizeSelfServiceOrder(found.tenantDb, {
    orderId: order.id,
    sessionId: attempt.pos_session_id,
    allowAlreadyPaid: true,
    actorUsername: 'mercado-pago-point',
    actorRole: 'integration',
    payment: {
      method: 'card',
      breakdown: {
        cash: 0,
        card: Number(order.total),
        transfer: 0,
        cardType,
        provider: 'mercado_pago_point',
        providerOrderId: providerPayment.providerOrderId,
        paymentReference: reference,
        paymentMethodId: providerPayment.paymentMethodId || '',
      },
      provider: 'mercado_pago_point',
      reference,
    },
  });
  if (!completed.alreadyPaid) {
    emitSelfServiceStatus(found.tenant.slug, { id: Number(order.id), folio: completed.sale.folio, status: 'confirmado' });
    emitNewOrder(found.tenant.slug, {
      id: Number(order.id), businessName: found.tenant.business_name, total: completed.sale.total,
      summary: `Autocobro ${completed.sale.folio} · Mercado Pago Point · Total ${completed.sale.total}`,
    }).catch((error) => console.error('[self-service][point][notify]', error?.message || error));
  }
  return completed.sale;
}

async function syncPointAttempt(found, order, attempt) {
  if (!attempt?.provider_order_id) return { attempt: pointAttemptPayload(attempt), sale: null };
  const payment = await getPointOrder(attempt.provider_order_id);
  if (payment.externalReference && payment.externalReference !== attempt.external_reference) {
    throw Object.assign(new Error('La referencia devuelta por Mercado Pago no coincide con el pedido'), { statusCode: 409 });
  }
  await updatePointAttempt(found.tenantDb, attempt.id, payment);
  let sale = null;
  if (payment.status === 'processed') sale = await completeProcessedPointPayment(found, order, attempt, payment);
  return { attempt: pointAttemptPayload({ ...attempt, ...payment, status_detail: payment.statusDetail, payment_method_type: payment.paymentMethodType }), sale };
}

async function productConfiguration(tenantDb, productIds) {
  const variants = await tenantDb.all(
    `SELECT id,product_id,name,price::float AS price
     FROM {s}.product_variants WHERE active=1 AND product_id=ANY($1::int[]) ORDER BY product_id,sort,id`,
    [productIds]
  );
  const groups = await tenantDb.all(
    `SELECT id,product_id,name,min_selections,max_selections
     FROM {s}.modifier_groups WHERE product_id=ANY($1::int[]) ORDER BY product_id,sort,id`,
    [productIds]
  );
  const groupIds = groups.map((row) => Number(row.id));
  const options = groupIds.length
    ? await tenantDb.all(
      `SELECT id,group_id,name,extra_price::float AS extra_price
       FROM {s}.modifier_options WHERE active=1 AND group_id=ANY($1::int[]) ORDER BY group_id,sort,id`,
      [groupIds]
    )
    : [];
  const variantsByProduct = new Map();
  variants.forEach((row) => {
    const key = Number(row.product_id);
    if (!variantsByProduct.has(key)) variantsByProduct.set(key, []);
    variantsByProduct.get(key).push(row);
  });
  const optionsByGroup = new Map();
  options.forEach((row) => {
    const key = Number(row.group_id);
    if (!optionsByGroup.has(key)) optionsByGroup.set(key, []);
    optionsByGroup.get(key).push(row);
  });
  const groupsByProduct = new Map();
  groups.forEach((row) => {
    const key = Number(row.product_id);
    if (!groupsByProduct.has(key)) groupsByProduct.set(key, []);
    groupsByProduct.get(key).push({ ...row, options: optionsByGroup.get(Number(row.id)) || [] });
  });
  return { variantsByProduct, groupsByProduct };
}

async function buildCatalog(tenantDb) {
  const [categories, products] = await Promise.all([
    tenantDb.all('SELECT id,name,sort FROM {s}.categories ORDER BY sort,name'),
    tenantDb.all(
      `SELECT p.id,p.category_id,p.name,p.description,p.price::float AS price,p.image,c.name AS category_name
       FROM {s}.products p LEFT JOIN {s}.categories c ON c.id=p.category_id
       WHERE p.active=1 ORDER BY COALESCE(c.sort,0),c.name NULLS LAST,p.name`
    ),
  ]);
  const ids = products.map((row) => Number(row.id));
  const { variantsByProduct, groupsByProduct } = ids.length
    ? await productConfiguration(tenantDb, ids)
    : { variantsByProduct: new Map(), groupsByProduct: new Map() };
  const taxConfig = await loadProductTaxConfig(tenantDb);
  return {
    categories,
    products: products.map((product) => applyProductTaxToCatalogProduct({
      ...product,
      variants: variantsByProduct.get(Number(product.id)) || [],
      modifierGroups: groupsByProduct.get(Number(product.id)) || [],
    }, taxConfig)),
    productTax: taxConfig,
  };
}

async function normalizeKioskItems(tenantDb, requestedItems) {
  const input = Array.isArray(requestedItems) ? requestedItems : [];
  if (!input.length || input.length > 50) throw Object.assign(new Error('Agrega productos válidos al pedido'), { status: 400 });
  const ids = [...new Set(input.map((item) => Number(item.productId || item.id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw Object.assign(new Error('Los productos seleccionados no son válidos'), { status: 400 });
  const products = await tenantDb.all(
    'SELECT id,name,price::float AS price,active FROM {s}.products WHERE id=ANY($1::int[])',
    [ids]
  );
  const productById = new Map(products.map((row) => [Number(row.id), row]));
  const { variantsByProduct, groupsByProduct } = await productConfiguration(tenantDb, ids);
  const taxConfig = await loadProductTaxConfig(tenantDb);

  return input.map((requested) => {
    const productId = Number(requested.productId || requested.id);
    const product = productById.get(productId);
    const qty = Number(requested.qty);
    if (!product || !Number(product.active)) throw Object.assign(new Error('Uno de los productos ya no está disponible'), { status: 409 });
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw Object.assign(new Error('La cantidad seleccionada no es válida'), { status: 400 });

    const variants = variantsByProduct.get(productId) || [];
    const requestedVariantId = Number(requested.variantId || 0);
    const variant = requestedVariantId ? variants.find((row) => Number(row.id) === requestedVariantId) : null;
    if (variants.length > 1 && !variant) throw Object.assign(new Error(`Selecciona una variante válida para ${product.name}`), { status: 400 });

    const selectedOptionIds = new Set(
      (Array.isArray(requested.modifierOptionIds) ? requested.modifierOptionIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0)
    );
    const selectedModifiers = [];
    let modifiersExtraPrice = 0;
    for (const group of groupsByProduct.get(productId) || []) {
      const selected = group.options.filter((option) => selectedOptionIds.has(Number(option.id)));
      const min = Math.max(0, Number(group.min_selections || 0));
      const max = Math.max(min, Number(group.max_selections || 0));
      if (selected.length < min || (max > 0 && selected.length > max)) {
        throw Object.assign(new Error(`Revisa las opciones de ${group.name} para ${product.name}`), { status: 400 });
      }
      selected.forEach((option) => {
        const optionPrice = effectiveProductPrice(option.extra_price, taxConfig);
        modifiersExtraPrice += optionPrice;
        selectedModifiers.push({
          groupId: Number(group.id), groupName: group.name,
          optionId: Number(option.id), optionName: option.name,
          extraPrice: optionPrice,
        });
      });
    }
    const allowedOptionIds = new Set((groupsByProduct.get(productId) || []).flatMap((group) => group.options.map((option) => Number(option.id))));
    if ([...selectedOptionIds].some((id) => !allowedOptionIds.has(id))) {
      throw Object.assign(new Error(`Una opción de ${product.name} ya no está disponible`), { status: 409 });
    }
    const basePrice = effectiveProductPrice(variant ? variant.price : product.price, taxConfig);
    const unitPrice = money(basePrice + modifiersExtraPrice);
    const modifiersLabel = selectedModifiers.map((item) => item.optionName).join(', ');
    return {
      id: productId,
      name: `${product.name}${variant ? ` · ${variant.name}` : ''}`,
      price: unitPrice,
      qty,
      ...productTaxLineSnapshot(unitPrice, taxConfig),
      variantId: variant ? Number(variant.id) : null,
      variantName: variant?.name || null,
      modifiers: selectedModifiers,
      modifiersLabel,
      modifiersExtraPrice: money(modifiersExtraPrice),
      _cartKey: crypto.randomUUID(),
    };
  });
}

router.post('/mercado-pago/webhook', async (req, res, next) => {
  try {
    const providerOrderId = String(req.query?.['data.id'] || req.body?.data?.id || '').trim();
    if (!providerOrderId) return res.sendStatus(200);
    if (!validateWebhookSignature({
      xSignature: req.get('x-signature'),
      xRequestId: req.get('x-request-id'),
      dataId: providerOrderId,
    })) return res.sendStatus(401);

    const tenants = await q("SELECT slug,business_name,logo,primary_color,timezone FROM tenants WHERE account_status='active' AND billing_status<>'suspended'");
    let match = null;
    for (const tenant of tenants.rows) {
      const tenantDb = tdb(tenant.slug);
      const attempt = await tenantDb.get(
        'SELECT * FROM {s}.self_service_payments WHERE provider_order_id=$1 LIMIT 1',
        [providerOrderId]
      ).catch(() => null);
      if (attempt) { match = { tenant, tenantDb, attempt }; break; }
    }
    if (!match) return res.sendStatus(200);
    const order = await match.tenantDb.get(
      'SELECT id,total::float AS total,status,service_branch_id,self_service_folio FROM {s}.orders WHERE id=$1 LIMIT 1',
      [match.attempt.order_id]
    );
    if (!order) return res.sendStatus(200);
    const found = { tenant: match.tenant, tenantDb: match.tenantDb };
    await syncPointAttempt(found, order, match.attempt);
    res.sendStatus(200);
  } catch (error) {
    console.error('[self-service][point][webhook]', error?.message || error);
    next(error);
  }
});

router.get('/public/:slug/:token', publicLimiter, async (req, res, next) => {
  try {
    const found = await resolveDevice(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Autoservicio no disponible' });
    if (!ensureSelfServiceEnabled(found, res)) return;
    const [catalog, settingsRows] = await Promise.all([
      buildCatalog(found.tenantDb),
      found.tenantDb.all("SELECT key,value FROM {s}.settings WHERE key=ANY($1::text[])", [[
        'business_name', 'currency', 'welcome_message', 'self_service_auto_print',
        ...SELF_SERVICE_PAYMENT_CONFIG.map((option) => option.setting),
      ]]),
    ]);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    res.json({
      business: {
        name: settings.business_name || found.tenant.business_name,
        logo: found.tenant.logo || '',
        primaryColor: found.tenant.primary_color || '#ff6b35',
        currency: settings.currency || 'MXN',
        welcomeMessage: settings.welcome_message || 'Elige tus productos y confirma tu pedido.',
        autoPrint: String(settings.self_service_auto_print || '0') === '1',
        paymentMethods: enabledSelfServicePayments(settings).map(({ id, method, cardType, label }) => ({ id, method, cardType, label })),
        point: publicPointConfiguration(found.device.mercado_pago_terminal_id),
      },
      device: { id: Number(found.device.id), name: found.device.name },
      branch: { id: Number(found.device.branch_id), name: found.device.branch_name, address: found.device.branch_address || '' },
      ...catalog,
    });
  } catch (error) { next(error); }
});

router.post('/public/:slug/:token/orders/:id/point', publicLimiter, async (req, res, next) => {
  try {
    const found = await resolveDevice(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Autoservicio no disponible' });
    if (!ensureSelfServiceEnabled(found, res)) return;
    const orderId = Number(req.params.id);
    const order = Number.isInteger(orderId) && orderId > 0
      ? await found.tenantDb.get(
        `SELECT id,self_service_folio,total::float AS total,status,payment_method,payment_breakdown,service_branch_id
         FROM {s}.orders WHERE id=$1 AND self_service_device_id=$2 LIMIT 1`,
        [orderId, found.device.id]
      )
      : null;
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.payment_method !== 'card') return res.status(400).json({ error: 'Este pedido no eligio pago con terminal' });
    if (order.status === 'cancelado') return res.status(409).json({ error: 'El pedido fue cancelado' });

    let attempt = await found.tenantDb.get(
      'SELECT * FROM {s}.self_service_payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1',
      [orderId]
    );
    if (attempt?.provider_order_id && (!isFinalPointStatus(attempt.status) || attempt.status === 'processed')) {
      const synced = await syncPointAttempt(found, order, attempt);
      return res.json({ ok: true, payment: synced.attempt, sale: synced.sale });
    }

    const resumableAttempt = attempt && !attempt.provider_order_id && !isFinalPointStatus(attempt.status) ? attempt : null;
    const session = resumableAttempt
      ? await found.tenantDb.get("SELECT id,branch_id FROM {s}.pos_sessions WHERE id=$1 AND status='open' LIMIT 1", [resumableAttempt.pos_session_id])
      : await getOpenBranchSession(found.tenantDb, order.service_branch_id);
    if (!session) return res.status(409).json({ error: 'La caja de esta sucursal debe estar abierta antes de pagar con terminal' });
    const point = pointConfiguration(found.device.mercado_pago_terminal_id);
    if (!point.configured) return res.status(503).json({ error: 'Mercado Pago Point aun no esta configurado para esta tableta' });
    const breakdown = parseObject(order.payment_breakdown);
    const cardType = breakdown.cardType === 'credit' ? 'credit' : 'debit';
    const nonce = crypto.randomBytes(5).toString('hex');
    const externalReference = resumableAttempt?.external_reference || `ss_${found.tenant.slug}_${orderId}_${nonce}`.slice(0, 64);
    const idempotencyKey = resumableAttempt?.idempotency_key || crypto.randomUUID();
    attempt = resumableAttempt || await found.tenantDb.get(
      `INSERT INTO {s}.self_service_payments
       (order_id,pos_session_id,external_reference,idempotency_key,amount,status,payment_method_type,terminal_id)
       VALUES($1,$2,$3,$4,$5,'creating',$6,$7) RETURNING *`,
      [orderId, session.id, externalReference, idempotencyKey, Number(order.total), cardType === 'credit' ? 'credit_card' : 'debit_card', point.terminalId]
    );
    try {
      const payment = await createPointOrder({
        amount: order.total,
        externalReference,
        terminalId: point.terminalId,
        cardType,
        description: `Autoservicio ${order.self_service_folio || orderId}`,
        idempotencyKey,
      });
      await updatePointAttempt(found.tenantDb, attempt.id, payment);
      attempt = { ...attempt, provider_order_id: payment.providerOrderId, status: payment.status, status_detail: payment.statusDetail };
      if (point.autoSimulate) await simulatePointOrder(payment.providerOrderId, cardType);
      return res.status(201).json({ ok: true, payment: pointAttemptPayload(attempt), simulated: point.autoSimulate });
    } catch (error) {
      const retryable = !attempt.provider_order_id && [502, 503, 504].includes(Number(error.statusCode));
      await found.tenantDb.run(
        "UPDATE {s}.self_service_payments SET status=$1,status_detail=$2,updated_at=now() WHERE id=$3",
        [retryable ? 'creating' : 'failed', String(error.message || 'No se pudo iniciar el cobro').slice(0, 180), attempt.id]
      );
      throw error;
    }
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'El cobro con terminal ya esta iniciando; espera un momento' });
    if ([400, 403, 404, 409, 503, 504].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.get('/public/:slug/:token/orders/:id/point', publicLimiter, async (req, res, next) => {
  try {
    const found = await resolveDevice(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Autoservicio no disponible' });
    if (!ensureSelfServiceEnabled(found, res)) return;
    const orderId = Number(req.params.id);
    const order = Number.isInteger(orderId) && orderId > 0
      ? await found.tenantDb.get(
        `SELECT id,self_service_folio,total::float AS total,status,payment_method,service_branch_id
         FROM {s}.orders WHERE id=$1 AND self_service_device_id=$2 LIMIT 1`,
        [orderId, found.device.id]
      )
      : null;
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    const attempt = await found.tenantDb.get(
      'SELECT * FROM {s}.self_service_payments WHERE order_id=$1 ORDER BY id DESC LIMIT 1',
      [orderId]
    );
    if (!attempt) return res.status(404).json({ error: 'El cobro con terminal aun no ha iniciado' });
    const synced = await syncPointAttempt(found, order, attempt);
    res.json({ ok: true, payment: synced.attempt, sale: synced.sale });
  } catch (error) {
    if ([400, 403, 404, 409, 503, 504].includes(error.statusCode)) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.post('/public/:slug/:token/orders', publicLimiter, async (req, res, next) => {
  try {
    const found = await resolveDevice(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Autoservicio no disponible' });
    if (!ensureSelfServiceEnabled(found, res)) return;
    const customerData = normalizeCustomer(req.body);
    const paymentSettingsRows = await found.tenantDb.all(
      'SELECT key,value FROM {s}.settings WHERE key=ANY($1::text[])',
      [SELF_SERVICE_PAYMENT_CONFIG.map((option) => option.setting)]
    );
    const paymentSettings = Object.fromEntries(paymentSettingsRows.map((row) => [row.key, row.value]));
    const selectedPayment = normalizeSelfServicePayment(req.body, enabledSelfServicePayments(paymentSettings));
    const items = await normalizeKioskItems(found.tenantDb, req.body?.items);
    const subtotal = money(items.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0));
    const note = String(req.body?.notes || '').trim().replace(/\s+/g, ' ').slice(0, 180);
    const order = await found.tenantDb.tx(async (tx) => {
      let customer = customerData.phoneHash
        ? await tx.get('SELECT id FROM {s}.customers WHERE phone_hash=$1 LIMIT 1', [customerData.phoneHash])
        : null;
      if (customer) {
        await tx.run('UPDATE {s}.customers SET name_enc=$1,phone_enc=$2 WHERE id=$3', [encrypt(customerData.name), encrypt(customerData.phone), customer.id]);
      } else {
        customer = await tx.get(
          'INSERT INTO {s}.customers(name_enc,phone_enc,phone_hash,address_enc) VALUES($1,$2,$3,NULL) RETURNING id',
          [encrypt(customerData.name), encrypt(customerData.phone), customerData.phoneHash]
        );
      }
      const row = await tx.get(
        `INSERT INTO {s}.orders
         (customer_id,items,subtotal,total,status,channel,source_channel,delivery,receiving_mode_label,receiving_mode_behavior,
          notes,order_notes,pickup_branch_id,pickup_branch_name,service_branch_id,service_branch_name,self_service_device_id,
          payment_method,payment_breakdown)
         VALUES($7,$1,$2,$2,'pendiente_cobro','kiosk','kiosk','mostrador','Autoservicio','branch',$3,$3,$4,$5,$4,$5,$6,$8,$9)
         RETURNING id,created_at`,
        [JSON.stringify(items), subtotal, note, found.device.branch_id, found.device.branch_name, found.device.id, customer.id,
          selectedPayment.method, JSON.stringify(selectedPayment.cardType ? { cardType: selectedPayment.cardType } : {})]
      );
      const folio = `A-${String(row.id).padStart(4, '0')}`;
      await tx.run('UPDATE {s}.orders SET self_service_folio=$1 WHERE id=$2', [folio, row.id]);
      return { id: Number(row.id), folio, createdAt: row.created_at };
    });
    const payload = {
      ...order,
      status: 'pendiente_cobro',
      total: subtotal,
      items,
      notes: note,
      branchId: Number(found.device.branch_id),
      branchName: found.device.branch_name,
      deviceName: found.device.name,
      customerName: customerData.name,
      customerPhone: customerData.phone,
      paymentChoice: selectedPayment.id,
      paymentMethod: selectedPayment.method,
      cardType: selectedPayment.cardType,
      paymentLabel: selectedPayment.label,
    };
    emitSelfServiceOrder(found.tenant.slug, payload);
    res.status(201).json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/public/:slug/:token/orders/:id', publicLimiter, async (req, res, next) => {
  try {
    const found = await resolveDevice(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Autoservicio no disponible' });
    if (!ensureSelfServiceEnabled(found, res)) return;
    const id = Number(req.params.id);
    const order = Number.isInteger(id) && id > 0
      ? await found.tenantDb.get(
        `SELECT id,self_service_folio,status,total::float AS total
         FROM {s}.orders WHERE id=$1 AND self_service_device_id=$2 LIMIT 1`,
        [id, found.device.id]
      )
      : null;
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ id: Number(order.id), folio: order.self_service_folio, status: order.status, total: Number(order.total) });
  } catch (error) { next(error); }
});

router.use(requireAuth);
router.use(requireModules('config', 'pos'));
router.use(requireOwner);

router.get('/devices', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT d.id,d.name,d.branch_id,d.access_token,d.active,d.mercado_pago_terminal_id,d.created_at,b.name AS branch_name
       FROM {s}.self_service_devices d LEFT JOIN {s}.branches b ON b.id=d.branch_id
       ORDER BY d.active DESC,b.name,d.name`
    );
    res.json(rows.map((row) => ({
      id: Number(row.id), name: row.name, branchId: Number(row.branch_id), branchName: row.branch_name || '',
      active: Boolean(Number(row.active)), terminalId: row.mercado_pago_terminal_id || '',
      point: publicPointConfiguration(row.mercado_pago_terminal_id),
      url: deviceUrl(req.tenant.slug, row.access_token), createdAt: row.created_at,
    })));
  } catch (error) { next(error); }
});

router.post('/devices', async (req, res, next) => {
  try {
    const branchId = Number(req.body?.branchId);
    const branch = Number.isInteger(branchId) && branchId > 0
      ? await req.tdb.get('SELECT id,name FROM {s}.branches WHERE id=$1 AND active=1 LIMIT 1', [branchId])
      : null;
    if (!branch) return res.status(400).json({ error: 'Selecciona una sucursal activa' });
    const name = String(req.body?.name || `Tableta ${branch.name}`).trim().replace(/\s+/g, ' ').slice(0, 80);
    const token = crypto.randomBytes(24).toString('base64url');
    const row = await req.tdb.get(
      `INSERT INTO {s}.self_service_devices(name,branch_id,access_token,active)
       VALUES($1,$2,$3,1) RETURNING id,name,branch_id,active`,
      [name || `Tableta ${branch.name}`, branch.id, token]
    );
    res.status(201).json({ id: Number(row.id), name: row.name, branchId: Number(row.branch_id), branchName: branch.name, active: true, url: deviceUrl(req.tenant.slug, token) });
  } catch (error) { next(error); }
});

router.patch('/devices/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Dispositivo inválido' });
    const active = req.body?.active === false ? 0 : 1;
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const terminalId = req.body?.terminalId === undefined
      ? null
      : String(req.body.terminalId || '').trim().slice(0, 100);
    if (terminalId && !/^[A-Z0-9_-]{4,100}$/i.test(terminalId)) {
      return res.status(400).json({ error: 'El ID de la terminal Mercado Pago no es valido' });
    }
    const result = await req.tdb.run(
      `UPDATE {s}.self_service_devices
       SET active=$1,name=CASE WHEN $2='' THEN name ELSE $2 END,
           mercado_pago_terminal_id=CASE WHEN $3::text IS NULL THEN mercado_pago_terminal_id ELSE $3 END,
           updated_at=now() WHERE id=$4`,
      [active, name, terminalId, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/devices/:id/rotate-token', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const token = crypto.randomBytes(24).toString('base64url');
    const row = Number.isInteger(id) && id > 0
      ? await req.tdb.get('UPDATE {s}.self_service_devices SET access_token=$1,updated_at=now() WHERE id=$2 RETURNING id', [token, id])
      : null;
    if (!row) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ ok: true, url: deviceUrl(req.tenant.slug, token) });
  } catch (error) { next(error); }
});

module.exports = router;
