const express = require('express');
const multer = require('multer');
const config = require('../config');
const { q, tdb } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/security');
const { FacturamaClient, FacturamaError } = require('../services/facturama');
const {
  isMexicoIdentity,
  invoicingPortalUrl,
  validateFiscalProfile,
  validateReceiver,
  paymentFormFromSale,
  buildFacturamaItems,
  extractFacturamaIdentity,
  createRequestKey,
} = require('../utils/invoicing');

const router = express.Router();
const facturama = new FacturamaClient();
const publicLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30, message: 'Demasiados intentos de facturación. Espera unos minutos.' });
const csdUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 2, fields: 8 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    if ((file.fieldname === 'certificate' && name.endsWith('.cer')) || (file.fieldname === 'privateKey' && name.endsWith('.key'))) return cb(null, true);
    cb(Object.assign(new Error('Selecciona archivos .cer y .key válidos'), { status: 415 }));
  },
});

function parseJson(raw, fallback = {}) {
  try { return JSON.parse(String(raw || '')); } catch { return fallback; }
}

function compactInvoiceCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function invoiceAccessMatches(sale, value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^[0-9a-f-]{36}$/i.test(raw) && String(sale.invoice_token || '').toLowerCase() === raw.toLowerCase()) return true;
  return /^[A-Z0-9]{8}$/.test(compactInvoiceCode(raw))
    && compactInvoiceCode(sale.invoice_code) === compactInvoiceCode(raw);
}

function safeProfile(row) {
  if (!row) return null;
  return {
    ...row,
    enabled: Boolean(Number(row.enabled)),
    sandbox_shared: Boolean(Number(row.sandbox_shared)),
    prices_include_tax: Boolean(Number(row.prices_include_tax)),
    csd_uploaded: Boolean(Number(row.csd_uploaded)),
    default_iva_rate: Number(row.default_iva_rate || 0),
    next_folio: Number(row.next_folio || 1),
  };
}

async function getProfile(t) {
  return safeProfile(await t.get('SELECT * FROM {s}.fiscal_profiles WHERE id = 1'));
}

function sandboxIssuerDefaults() {
  return {
    rfc: config.FACTURAMA_SANDBOX_RFC,
    legalName: config.FACTURAMA_SANDBOX_NAME,
    fiscalRegime: config.FACTURAMA_SANDBOX_REGIME,
    postalCode: config.FACTURAMA_SANDBOX_POSTAL_CODE,
    series: 'TEST',
    defaultProductCode: '01010101',
    defaultUnitCode: 'E48',
    defaultUnitName: 'Unidad de servicio',
    defaultTaxObject: '02',
    defaultIvaRate: 0.16,
    defaultCardPaymentForm: '04',
  };
}

function profileCompleteness(profile) {
  if (!profile) return false;
  return Boolean(profile.rfc && profile.legal_name && profile.fiscal_regime && profile.postal_code && profile.default_product_code);
}

function profileReady(profile) {
  if (!profile?.enabled || !profileCompleteness(profile) || !facturama.isConfigured()) return false;
  if (profile.environment === 'sandbox' && profile.sandbox_shared) return true;
  return Boolean(profile.csd_uploaded);
}

function profileReadinessError(profile) {
  if (!profile?.enabled) return 'Activa la facturación electrónica en la configuración fiscal';
  if (!profileCompleteness(profile)) return 'Completa los datos fiscales y valores SAT predeterminados del negocio';
  if (!facturama.isConfigured()) return 'Configura las credenciales de Facturama en el servidor';
  if (profile.environment === 'sandbox' && profile.sandbox_shared) return '';
  if (!profile.csd_uploaded) return 'Carga los certificados de sello digital del emisor';
  return '';
}

async function requestMexicoEligibility(req) {
  if (isMexicoIdentity(req.tenant) || req.tenant?.slug === config.DEMO_TENANT_SLUG) return true;
  const leadId = Number(req.user?.demoLeadId || 0);
  if (!Number.isInteger(leadId) || leadId <= 0) return false;
  const lead = await q('SELECT phone_country, phone_calling_code FROM demo_leads WHERE id = $1 LIMIT 1', [leadId]);
  return isMexicoIdentity(lead.rows[0]);
}

async function requireMexico(req, res, next) {
  try {
    if (await requestMexicoEligibility(req)) return next();
    return res.status(403).json({ error: 'La facturación electrónica está disponible únicamente para cuentas registradas en México (+52)' });
  } catch (error) { next(error); }
}

async function findPublicTenant(slug) {
  const found = await q(
    `SELECT id, slug, business_name, phone_country, phone_calling_code, logo, primary_color, account_status, billing_status
     FROM tenants WHERE slug = $1 LIMIT 1`,
    [String(slug || '').trim().toLowerCase()]
  );
  const tenant = found.rows[0];
  if (!tenant || tenant.account_status !== 'active' || tenant.billing_status === 'suspended') return null;
  const isDemoTenant = tenant.slug === config.DEMO_TENANT_SLUG;
  if (!isMexicoIdentity(tenant) && !isDemoTenant) return null;
  return tenant;
}

function invoiceSummary(row, includeReceiver = true) {
  const receiver = includeReceiver ? parseJson(decrypt(row.receiver_data_enc), {}) : undefined;
  return {
    id: Number(row.id),
    orderId: Number(row.order_id),
    providerId: row.provider_id || '',
    uuid: row.uuid || '',
    series: row.series || '',
    folio: row.folio || '',
    status: row.status,
    receiver,
    total: Number(row.order_total || row.total || 0),
    error: row.error_message || '',
    cancellationStatus: row.cancellation_status || '',
    cancellationMessage: row.cancellation_message || '',
    issuedAt: row.issued_at || '',
    createdAt: row.created_at || '',
    hasXml: Boolean(row.xml_enc),
    hasPdf: Boolean(row.pdf_enc),
  };
}

async function loadInvoiceFiles(invoice, profile) {
  const files = {};
  if (!invoice.provider_id) return files;
  await Promise.all(['xml', 'pdf'].map(async (format) => {
    try {
      const result = await facturama.downloadCfdi(invoice.provider_id, format, profile.api_mode);
      if (result?.Content) files[format] = String(result.Content);
    } catch (error) {
      console.warn(`[invoicing] No se pudo descargar ${format} de ${invoice.provider_id}:`, error.message);
    }
  }));
  return files;
}

async function issueSaleInvoice({ tenant, tenantDb, orderId, receiverInput, requestedPaymentForm = '', actor = '', publicToken = '' }) {
  const profile = await getProfile(tenantDb);
  const readinessError = profileReadinessError(profile);
  if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });
  const receiver = validateReceiver(receiverInput, { issuerPostalCode: profile.postal_code });

  const sale = await tenantDb.get(
    `SELECT id, items, subtotal::float AS subtotal, total::float AS total, status, channel, payment_method, payment_breakdown,
            delivery_fee::float AS delivery_fee, service_branch_id, invoice_token, invoice_code, created_at
     FROM {s}.orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  if (!sale || sale.channel !== 'pos') throw Object.assign(new Error('Ticket de punto de venta no encontrado'), { status: 404 });
  if (publicToken && !invoiceAccessMatches(sale, publicToken)) throw Object.assign(new Error('El código de facturación no es válido'), { status: 404 });
  if (sale.status === 'cancelado') throw Object.assign(new Error('No se puede facturar un ticket cancelado'), { status: 409 });

  const current = await tenantDb.get(
    `SELECT * FROM {s}.invoices WHERE order_id = $1 AND status IN ('pending','unknown','active','cancel_pending') ORDER BY id DESC LIMIT 1`,
    [sale.id]
  );
  if (current) return { invoice: invoiceSummary({ ...current, order_total: sale.total }), reused: true };

  const rawItems = typeof sale.items === 'string' ? parseJson(sale.items, []) : sale.items;
  const productIds = [...new Set((rawItems || []).map((item) => Number(item.id || item.productId || 0)).filter((id) => id > 0))];
  const productRows = productIds.length
    ? await tenantDb.all(
      `SELECT id, name, sat_product_code, sat_unit_code, sat_unit_name, tax_object, iva_rate::float AS iva_rate
       FROM {s}.products WHERE id = ANY($1::int[])`, [productIds]
    )
    : [];
  const productsById = new Map(productRows.map((row) => [Number(row.id), row]));
  const items = buildFacturamaItems(sale, productsById, profile);
  const branch = sale.service_branch_id
    ? await tenantDb.get('SELECT fiscal_postal_code FROM {s}.branches WHERE id = $1 LIMIT 1', [sale.service_branch_id])
    : null;
  const expeditionPlace = /^\d{5}$/.test(String(branch?.fiscal_postal_code || '')) ? branch.fiscal_postal_code : profile.postal_code;
  const paymentForm = paymentFormFromSale(sale, profile.default_card_payment_form, requestedPaymentForm);

  const allocated = await tenantDb.tx(async (tx) => {
    const lockedProfile = await tx.get('SELECT * FROM {s}.fiscal_profiles WHERE id = 1 FOR UPDATE');
    const duplicate = await tx.get(
      `SELECT * FROM {s}.invoices WHERE order_id = $1 AND status IN ('pending','unknown','active','cancel_pending') ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [sale.id]
    );
    if (duplicate) return { duplicate };
    const folio = String(lockedProfile.next_folio || 1);
    const requestKey = createRequestKey();
    await tx.run('UPDATE {s}.fiscal_profiles SET next_folio = next_folio + 1, updated_at = now() WHERE id = 1');
    const snapshot = {
      issuer: { rfc: profile.rfc, legalName: profile.legal_name, fiscalRegime: profile.fiscal_regime, postalCode: expeditionPlace },
      receiver, paymentForm, items, total: Number(sale.total), orderId: Number(sale.id),
    };
    const row = await tx.get(
      `INSERT INTO {s}.invoices
       (order_id, request_key, environment, series, folio, status, receiver_data_enc, fiscal_snapshot_enc, issued_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8) RETURNING *`,
      [sale.id, requestKey, profile.environment, profile.series, folio, encrypt(JSON.stringify(receiver)), encrypt(JSON.stringify(snapshot)), actor]
    );
    await tx.run("INSERT INTO {s}.invoice_events (invoice_id, event_type, detail, actor) VALUES ($1,'created','Solicitud preparada',$2)", [row.id, actor]);
    return { row, folio, snapshot };
  });
  if (allocated.duplicate) return { invoice: invoiceSummary({ ...allocated.duplicate, order_total: sale.total }), reused: true };

  const payload = {
    NameId: 1,
    CfdiType: 'I',
    Currency: 'MXN',
    Exportation: '01',
    ExpeditionPlace: expeditionPlace,
    PaymentForm: paymentForm,
    PaymentMethod: 'PUE',
    Serie: profile.series,
    Folio: allocated.folio,
    Receiver: {
      Rfc: receiver.rfc,
      Name: receiver.name,
      FiscalRegime: receiver.fiscalRegime,
      TaxZipCode: receiver.postalCode,
      CfdiUse: receiver.cfdiUse,
    },
    Items: items,
    Observations: `Ticket POS #${sale.id}`,
  };
  if (profile.api_mode !== 'web') {
    payload.Issuer = { Rfc: profile.rfc, Name: profile.legal_name, FiscalRegime: profile.fiscal_regime };
  }

  try {
    let response = await facturama.createCfdi(payload, profile.api_mode);
    let identity = extractFacturamaIdentity(response);
    if (identity.providerId && !identity.uuid) {
      try {
        const detail = await facturama.getCfdi(identity.providerId, profile.api_mode);
        response = { ...response, Detail: detail };
        identity = extractFacturamaIdentity(response);
      } catch {}
    }
    if (!identity.providerId) throw new FacturamaError('Facturama no devolvió el identificador del CFDI', { status: 502, uncertain: true });
    const fileData = await loadInvoiceFiles({ provider_id: identity.providerId }, profile);
    const updated = await tenantDb.get(
      `UPDATE {s}.invoices SET provider_id=$1, uuid=$2, certificate_number=$3, status='active',
         provider_response_enc=$4, xml_enc=$5, pdf_enc=$6, issued_at=now(), updated_at=now(), error_message=''
       WHERE id=$7 RETURNING *`,
      [identity.providerId, identity.uuid || null, identity.certificateNumber || null, encrypt(JSON.stringify(response)),
        fileData.xml ? encrypt(fileData.xml) : null, fileData.pdf ? encrypt(fileData.pdf) : null, allocated.row.id]
    );
    await tenantDb.run("INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,'stamped',$2,$3)", [updated.id, identity.uuid || identity.providerId, actor]);
    await tenantDb.run(
      `INSERT INTO {s}.fiscal_customers (rfc_hash, fiscal_data_enc) VALUES ($1,$2)
       ON CONFLICT (rfc_hash) DO UPDATE SET fiscal_data_enc=EXCLUDED.fiscal_data_enc, updated_at=now()`,
      [lookupHash(receiver.rfc), encrypt(JSON.stringify(receiver))]
    );
    return { invoice: invoiceSummary({ ...updated, order_total: sale.total }), reused: false };
  } catch (error) {
    const uncertain = Boolean(error.uncertain);
    const status = uncertain ? 'unknown' : 'failed';
    await tenantDb.run(
      `UPDATE {s}.invoices SET status=$1, error_message=$2, provider_response_enc=$3, updated_at=now() WHERE id=$4`,
      [status, String(error.message || 'Error de timbrado').slice(0, 900), error.details ? encrypt(JSON.stringify(error.details)) : null, allocated.row.id]
    );
    await tenantDb.run("INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,$2,$3,$4)", [allocated.row.id, status, String(error.message || '').slice(0, 900), actor]);
    throw error;
  }
}

// Portal público de autofacturación
router.get('/public/:slug', publicLimiter, async (req, res, next) => {
  try {
    const tenant = await findPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Portal de facturación no disponible' });
    const tenantDb = tdb(tenant.slug);
    const [profile, settingsRows, branches] = await Promise.all([
      getProfile(tenantDb),
      tenantDb.all(
        `SELECT key,value FROM {s}.settings
         WHERE key = ANY($1::text[])`,
        [['business_name', 'address', 'whatsapp', 'hours']]
      ),
      tenantDb.all(
        `SELECT name,address FROM {s}.branches
         WHERE active=1 ORDER BY id LIMIT 3`
      ),
    ]);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, String(row.value || '').trim()]));
    res.json({
      business: {
        slug: tenant.slug,
        name: settings.business_name || tenant.business_name,
        logo: tenant.logo,
        primaryColor: tenant.primary_color,
        address: settings.address || branches[0]?.address || '',
        whatsapp: settings.whatsapp || '',
        hours: settings.hours || '',
        branches: branches.map((branch) => ({ name: branch.name || '', address: branch.address || '' })),
      },
      issuer: profileCompleteness(profile) ? {
        legalName: profile.legal_name,
        rfc: profile.rfc,
        fiscalRegime: profile.fiscal_regime,
        postalCode: profile.postal_code,
      } : null,
      available: profileReady(profile),
      unavailableReason: profileReadinessError(profile),
      environment: profile?.environment || config.FACTURAMA_ENVIRONMENT,
    });
  } catch (error) { next(error); }
});

router.post('/public/:slug/lookup', publicLimiter, async (req, res, next) => {
  try {
    const tenant = await findPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Portal de facturación no disponible' });
    const ticket = Number(req.body?.ticket || 0);
    const token = String(req.body?.code || req.body?.token || '').trim();
    if (!Number.isInteger(ticket) || ticket <= 0 || (!/^[0-9a-f-]{36}$/i.test(token) && !/^[A-Z0-9]{8}$/.test(compactInvoiceCode(token)))) {
      return res.status(400).json({ error: 'Captura el número de ticket y su código de facturación' });
    }
    const tenantDb = tdb(tenant.slug);
    const sale = await tenantDb.get(
      `SELECT id, items, total::float AS total, status, invoice_token, invoice_code,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM {s}.orders WHERE id=$1 AND channel='pos' LIMIT 1`,
      [ticket]
    );
    if (!sale || !invoiceAccessMatches(sale, token)) return res.status(404).json({ error: 'No encontramos el ticket con ese código de facturación' });
    if (sale.status === 'cancelado') return res.status(409).json({ error: 'El ticket está cancelado' });
    const invoice = await tenantDb.get('SELECT * FROM {s}.invoices WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [ticket]);
    res.json({
      ticket: { id: sale.id, items: parseJson(sale.items, []).map((item) => ({ name: item.name, qty: item.qty, price: item.price })), total: sale.total, createdAt: sale.created_at },
      invoice: invoice ? invoiceSummary({ ...invoice, order_total: sale.total }, false) : null,
    });
  } catch (error) { next(error); }
});

router.post('/public/:slug/issue', publicLimiter, async (req, res, next) => {
  try {
    const tenant = await findPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Portal de facturación no disponible' });
    const ticket = Number(req.body?.ticket || 0);
    const token = String(req.body?.code || req.body?.token || '').trim();
    const result = await issueSaleInvoice({
      tenant,
      tenantDb: tdb(tenant.slug),
      orderId: ticket,
      receiverInput: req.body?.receiver,
      requestedPaymentForm: req.body?.paymentForm,
      actor: 'autofacturación',
      publicToken: token,
    });
    res.json({ ok: true, ...result, token });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, uncertain: Boolean(error.uncertain) });
    next(error);
  }
});

router.get('/public/:slug/invoices/:id/:format', publicLimiter, async (req, res, next) => {
  try {
    const tenant = await findPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).end();
    const token = String(req.query.code || req.query.token || '').trim();
    const tenantDb = tdb(tenant.slug);
    const invoice = await tenantDb.get(
      `SELECT i.*, o.invoice_token, o.invoice_code FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id WHERE i.id=$1 LIMIT 1`,
      [req.params.id]
    );
    if (!invoice || !invoiceAccessMatches(invoice, token)) return res.status(404).end();
    if (!['xml', 'pdf'].includes(req.params.format)) return res.status(400).json({ error: 'Formato no válido' });
    const format = req.params.format;
    const content = decrypt(format === 'xml' ? invoice.xml_enc : invoice.pdf_enc);
    if (!content) return res.status(404).json({ error: 'El archivo todavía no está disponible' });
    res.type(format === 'xml' ? 'application/xml' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CFDI-${invoice.uuid || invoice.folio}.${format}"`);
    res.send(Buffer.from(content, 'base64'));
  } catch (error) { next(error); }
});

// Panel autenticado
router.use(requireAuth);
router.use(requireMexico);

router.get('/bootstrap', async (req, res, next) => {
  try {
    const [profile, branches, products, invoices] = await Promise.all([
      getProfile(req.tdb),
      req.tdb.all('SELECT id,name,address,fiscal_postal_code,active FROM {s}.branches ORDER BY active DESC,name'),
      req.tdb.all(`SELECT id,name,sat_product_code,sat_unit_code,sat_unit_name,tax_object,iva_rate::float AS iva_rate,active FROM {s}.products ORDER BY active DESC,name`),
      req.tdb.all(`SELECT i.*, o.total::float AS order_total FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id ORDER BY i.id DESC LIMIT 50`),
    ]);
    res.json({
      eligible: true,
      provider: { name: 'Facturama', configured: facturama.isConfigured(), environment: config.FACTURAMA_ENVIRONMENT },
      profile,
      ready: profileReady(profile),
      sandboxSharedAvailable: config.FACTURAMA_ENVIRONMENT === 'sandbox' && config.FACTURAMA_SANDBOX_SHARED_ISSUER,
      sandboxDefaults: sandboxIssuerDefaults(),
      portalUrl: invoicingPortalUrl(req, config.INVOICING_PORTAL_ORIGIN, req.tenant.slug),
      branches,
      products,
      invoices: invoices.map((row) => invoiceSummary(row)),
    });
  } catch (error) { next(error); }
});

router.put('/profile', requireOwner, async (req, res, next) => {
  try {
    const useSandboxShared = config.FACTURAMA_ENVIRONMENT === 'sandbox'
      && config.FACTURAMA_SANDBOX_SHARED_ISSUER
      && req.body?.sandboxShared !== false;
    const source = useSandboxShared ? { ...req.body, ...sandboxIssuerDefaults() } : req.body;
    const profile = validateFiscalProfile(source);
    const enabled = req.body?.enabled === false ? 0 : 1;
    const apiMode = useSandboxShared ? 'web' : 'multi';
    const row = await req.tdb.get(
      `INSERT INTO {s}.fiscal_profiles
       (id,enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,
        default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,
        delivery_product_code,prices_include_tax,default_card_payment_form,updated_at)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,$16,now())
       ON CONFLICT (id) DO UPDATE SET enabled=EXCLUDED.enabled,environment=EXCLUDED.environment,api_mode=EXCLUDED.api_mode,
        sandbox_shared=EXCLUDED.sandbox_shared,rfc=EXCLUDED.rfc,legal_name=EXCLUDED.legal_name,
        fiscal_regime=EXCLUDED.fiscal_regime,postal_code=EXCLUDED.postal_code,series=EXCLUDED.series,
        default_product_code=EXCLUDED.default_product_code,default_unit_code=EXCLUDED.default_unit_code,
        default_unit_name=EXCLUDED.default_unit_name,default_tax_object=EXCLUDED.default_tax_object,
        default_iva_rate=EXCLUDED.default_iva_rate,delivery_product_code=EXCLUDED.delivery_product_code,
        prices_include_tax=1,default_card_payment_form=EXCLUDED.default_card_payment_form,
        csd_uploaded=CASE WHEN fiscal_profiles.rfc=EXCLUDED.rfc THEN fiscal_profiles.csd_uploaded ELSE 0 END,
        updated_at=now()
       RETURNING *`,
      [enabled, config.FACTURAMA_ENVIRONMENT, apiMode, useSandboxShared ? 1 : 0, profile.rfc, profile.legalName,
        profile.fiscalRegime, profile.postalCode, profile.series, profile.defaultProductCode, profile.defaultUnitCode,
        profile.defaultUnitName, profile.defaultTaxObject, profile.defaultIvaRate,
        String(req.body?.deliveryProductCode || profile.defaultProductCode).trim(), profile.defaultCardPaymentForm]
    );
    res.json({ ok: true, profile: safeProfile(row), ready: profileReady(safeProfile(row)) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.post('/csd', requireOwner, csdUpload.fields([{ name: 'certificate', maxCount: 1 }, { name: 'privateKey', maxCount: 1 }]), async (req, res, next) => {
  try {
    const profile = await getProfile(req.tdb);
    if (!profile || profile.sandbox_shared) return res.status(409).json({ error: 'Guarda primero los datos fiscales del emisor multi-RFC' });
    const certificate = req.files?.certificate?.[0];
    const privateKey = req.files?.privateKey?.[0];
    const password = String(req.body?.privateKeyPassword || '');
    if (!certificate || !privateKey || !password) return res.status(400).json({ error: 'Carga .cer, .key y la contraseña de la llave privada' });
    await facturama.uploadCsd({
      rfc: profile.rfc,
      certificate: certificate.buffer.toString('base64'),
      privateKey: privateKey.buffer.toString('base64'),
      privateKeyPassword: password,
    });
    await req.tdb.run('UPDATE {s}.fiscal_profiles SET csd_uploaded=1,csd_updated_at=now(),updated_at=now() WHERE id=1');
    res.json({ ok: true });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.put('/products/:id', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const productCode = String(req.body?.productCode || '').trim();
    const unitCode = String(req.body?.unitCode || '').trim().toUpperCase();
    const unitName = String(req.body?.unitName || '').trim().slice(0, 40);
    const taxObject = String(req.body?.taxObject || '').trim();
    const ivaRate = Number(req.body?.ivaRate);
    if (!/^\d{8}$/.test(productCode) || !/^[A-Z0-9]{2,3}$/.test(unitCode) || !['01','02','03','04','05','06','07','08'].includes(taxObject) || !Number.isFinite(ivaRate) || ivaRate < 0 || ivaRate > 1) {
      return res.status(400).json({ error: 'Revisa clave de producto, unidad, objeto de impuesto y tasa' });
    }
    const result = await req.tdb.run(
      `UPDATE {s}.products SET sat_product_code=$1,sat_unit_code=$2,sat_unit_name=$3,tax_object=$4,iva_rate=$5 WHERE id=$6`,
      [productCode, unitCode, unitName || 'Unidad de servicio', taxObject, ivaRate, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.put('/branches/:id', requireOwner, async (req, res, next) => {
  try {
    const postalCode = String(req.body?.postalCode || '').trim();
    if (!/^\d{5}$/.test(postalCode)) return res.status(400).json({ error: 'El código postal de expedición debe tener 5 dígitos' });
    const result = await req.tdb.run('UPDATE {s}.branches SET fiscal_postal_code=$1 WHERE id=$2', [postalCode, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/sales/:id/issue', async (req, res, next) => {
  try {
    const result = await issueSaleInvoice({
      tenant: req.tenant,
      tenantDb: req.tdb,
      orderId: Number(req.params.id),
      receiverInput: req.body?.receiver,
      requestedPaymentForm: req.body?.paymentForm,
      actor: req.user.username,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, uncertain: Boolean(error.uncertain) });
    next(error);
  }
});

router.post('/invoices/:id/cancel', requireOwner, async (req, res, next) => {
  try {
    const motive = String(req.body?.motive || '02');
    const replacementUuid = String(req.body?.replacementUuid || '').trim().toUpperCase();
    if (!['01','02','03','04'].includes(motive)) return res.status(400).json({ error: 'Motivo de cancelación no válido' });
    if (motive === '01' && !/^[0-9A-F-]{36}$/.test(replacementUuid)) return res.status(400).json({ error: 'Captura el UUID que sustituye al CFDI' });
    const invoice = await req.tdb.get('SELECT * FROM {s}.invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    const profile = await getProfile(req.tdb);
    if (!invoice || !invoice.provider_id) return res.status(404).json({ error: 'CFDI no encontrado' });
    if (!['active','cancel_pending'].includes(invoice.status)) return res.status(409).json({ error: 'El CFDI no se puede cancelar en su estado actual' });
    const response = await facturama.cancelCfdi(invoice.provider_id, motive, replacementUuid, profile.api_mode);
    const providerStatus = String(response?.Status || response?.status || '').toLowerCase();
    const canceled = ['canceled','acepted','accepted','expired'].includes(providerStatus);
    const nextStatus = canceled ? 'canceled' : 'cancel_pending';
    const updated = await req.tdb.get(
      `UPDATE {s}.invoices SET status=$1,cancellation_motive=$2,replacement_uuid=$3,cancellation_status=$4,
       cancellation_message=$5,cancellation_receipt_enc=$6,cancel_requested_at=COALESCE(cancel_requested_at,now()),
       canceled_at=CASE WHEN $7 THEN now() ELSE canceled_at END,updated_at=now() WHERE id=$8 RETURNING *`,
      [nextStatus, motive, replacementUuid || null, providerStatus, String(response?.Message || ''),
        response?.AcuseXmlBase64 ? encrypt(String(response.AcuseXmlBase64)) : null, canceled, invoice.id]
    );
    await req.tdb.run("INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,'cancel_requested',$2,$3)", [invoice.id, providerStatus || 'solicitada', req.user.username]);
    res.json({ ok: true, invoice: invoiceSummary(updated) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/invoices/:id/:format', async (req, res, next) => {
  try {
    const invoice = await req.tdb.get('SELECT * FROM {s}.invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!invoice) return res.status(404).end();
    if (!['xml', 'pdf'].includes(req.params.format)) return res.status(400).json({ error: 'Formato no válido' });
    const format = req.params.format;
    let content = decrypt(format === 'xml' ? invoice.xml_enc : invoice.pdf_enc);
    if (!content && invoice.provider_id) {
      const profile = await getProfile(req.tdb);
      const result = await facturama.downloadCfdi(invoice.provider_id, format, profile.api_mode);
      content = String(result?.Content || '');
      if (content) await req.tdb.run(`UPDATE {s}.invoices SET ${format === 'xml' ? 'xml_enc' : 'pdf_enc'}=$1,updated_at=now() WHERE id=$2`, [encrypt(content), invoice.id]);
    }
    if (!content) return res.status(404).json({ error: 'El archivo todavía no está disponible' });
    res.type(format === 'xml' ? 'application/xml' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CFDI-${invoice.uuid || invoice.folio}.${format}"`);
    res.send(Buffer.from(content, 'base64'));
  } catch (error) { next(error); }
});

module.exports = router;
