const express = require('express');
const multer = require('multer');
const { X509Certificate, createPrivateKey, createPublicKey } = require('node:crypto');
const config = require('../config');
const { q, tdb, ensureTenantCourtesyStamps } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/security');
const { FacturamaError, createConfiguredFacturamaClients } = require('../services/facturama');
const {
  PAYMENT_FORMS,
  isMexicoIdentity,
  invoicingPortalUrl,
  validateFiscalProfile,
  validateReceiver,
  validateInvoiceEmail,
  maskInvoiceEmail,
  globalInformationForReceiver,
  resolveExpeditionPostalCode,
  paymentFormFromSale, paymentFormFromSales,
  buildFacturamaItems,
  buildGlobalFacturamaItems,
  extractFacturamaIdentity,
  createRequestKey,
} = require('../utils/invoicing');
const { trialState } = require('../utils/trialAccess');

const router = express.Router();
const facturamaClients = createConfiguredFacturamaClients();

function normalizeEnvironment(value) {
  return String(value || '').toLowerCase() === 'production' ? 'production' : 'sandbox';
}

function tenantEnvironment(tenant) {
  if (tenant?.slug === config.DEMO_TENANT_SLUG) return 'sandbox';
  return normalizeEnvironment(tenant?.invoicing_environment);
}

function facturamaFor(source) {
  return facturamaClients[normalizeEnvironment(source?.environment || source)] || facturamaClients.sandbox;
}

function issuerApiMode(environment, rfc, sandboxShared = false) {
  const normalizedEnvironment = normalizeEnvironment(environment);
  if (normalizedEnvironment === 'sandbox') return sandboxShared ? 'web' : 'multi';
  const normalizedRfc = String(rfc || '').trim().toUpperCase();
  return config.FACTURAMA_PRODUCTION_RFC && normalizedRfc === config.FACTURAMA_PRODUCTION_RFC ? 'web' : 'multi';
}

function apiModeFor(document, profile) {
  return ['web', 'multi'].includes(document?.api_mode) ? document.api_mode : (profile?.api_mode || 'multi');
}
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

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const INCOME_CFDI_USES = new Set(['G01','G02','G03','I01','I02','I03','I04','I05','I06','I07','I08','D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','S01']);
const DOCUMENT_TABLES = Object.freeze({
  individual: 'invoices',
  global: 'global_invoices',
  direct: 'direct_invoices',
  manual_global: 'direct_invoices',
  credit_note: 'direct_invoices',
  payment: 'payment_complements',
});

function documentTable(type) {
  return DOCUMENT_TABLES[String(type || '')] || '';
}

function normalizeUuid(value, field = 'UUID') {
  const uuid = String(value || '').trim().toUpperCase();
  if (!UUID_RE.test(uuid)) throw Object.assign(new Error(`${field} no es válido`), { status: 400 });
  return uuid;
}

function normalizePaymentMethod(value = 'PUE') {
  const paymentMethod = String(value || 'PUE').trim().toUpperCase();
  if (!['PUE','PPD'].includes(paymentMethod)) throw Object.assign(new Error('Selecciona un método de pago SAT válido'), { status: 400 });
  return paymentMethod;
}

function validateIncomeReceiver(input, options = {}) {
  const receiver = validateReceiver(input, options);
  if (!INCOME_CFDI_USES.has(receiver.cfdiUse)) {
    throw Object.assign(new Error('El uso CP01 corresponde a complementos de pago y CN01 a nómina; selecciona un uso válido para una factura de ingreso'), { status: 400 });
  }
  return receiver;
}

async function validateReceiverWithFacturama(facturama, receiver) {
  if (['XAXX010101000', 'XEXX010101000'].includes(receiver.rfc)) return;
  const result = await facturama.validateReceiver({
    rfc: receiver.rfc,
    name: receiver.name,
    postalCode: receiver.postalCode,
    fiscalRegime: receiver.fiscalRegime,
  });
  const checks = [
    ['ExistRfc', 'El RFC no está activo o no fue localizado por el SAT'],
    ['MatchName', 'El nombre o razón social no coincide con el RFC ante el SAT'],
    ['MatchZipCode', 'El código postal fiscal no coincide con el RFC ante el SAT'],
    ['MatchFiscalRegime', 'El régimen fiscal no coincide con el RFC ante el SAT'],
  ];
  const failed = checks.find(([key]) => result?.[key] === false || result?.[key[0].toLowerCase() + key.slice(1)] === false);
  if (failed) throw Object.assign(new Error(failed[1]), { status: 422 });
}

function relationFromInput(input = {}, defaultType = '') {
  const relationType = String(input.relationType || defaultType || '').trim();
  const raw = Array.isArray(input.relatedUuids) ? input.relatedUuids : (input.relatedUuid ? [input.relatedUuid] : []);
  const uuids = [...new Set(raw.filter(Boolean).map((uuid) => normalizeUuid(uuid, 'El UUID relacionado')))];
  if (!uuids.length && relationType) throw Object.assign(new Error('Captura al menos un UUID para la relación CFDI'), { status: 400 });
  if (!uuids.length) return { relationType: '', uuids: [], payload: null };
  if (!['01','02','03','04','05','06','07'].includes(relationType)) {
    throw Object.assign(new Error('Selecciona un tipo de relación CFDI válido'), { status: 400 });
  }
  return { relationType, uuids, payload: { Type: relationType, Cfdis: uuids.map((Uuid) => ({ Uuid })) } };
}

function csdCertificateIdentity(buffer) {
  try {
    const certificate = new X509Certificate(buffer);
    const attributes = {};
    String(certificate.subject || '').split(/\r?\n/).forEach((line) => {
      const separator = line.indexOf('=');
      if (separator > 0) attributes[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    });
    const uniqueIdentifier = String(attributes.x500uniqueidentifier || '').trim().toUpperCase();
    const rfc = uniqueIdentifier.match(/[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}/)?.[0] || '';
    const legalName = String(attributes.cn || attributes.name || attributes.o || '').trim().toUpperCase();
    if (!rfc || !legalName) throw new Error('El certificado no contiene RFC y nombre fiscal identificables');
    const validTo = new Date(certificate.validTo);
    if (!Number.isNaN(validTo.getTime()) && validTo.getTime() < Date.now()) throw new Error('El certificado CSD está vencido');
    return { rfc, legalName, validTo: certificate.validTo };
  } catch (error) {
    throw Object.assign(new Error(`No se pudo validar el certificado .cer: ${error.message}`), { status: 422 });
  }
}

function validateCsdPrivateKey(certificateBuffer, privateKeyBuffer, password) {
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: privateKeyBuffer, format: 'der', type: 'pkcs8', passphrase: password });
  } catch {
    throw Object.assign(new Error('No se pudo abrir la llave .key. Verifica que sea una llave CSD en formato DER y que la contraseña sea correcta.'), { status: 422 });
  }
  try {
    const certificateKey = new X509Certificate(certificateBuffer).publicKey.export({ format: 'der', type: 'spki' });
    const privatePublicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    if (!certificateKey.equals(privatePublicKey)) {
      throw Object.assign(new Error('El certificado .cer y la llave .key no pertenecen al mismo CSD.'), { status: 422 });
    }
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('No se pudo comprobar la correspondencia entre el certificado .cer y la llave .key.'), { status: 422 });
  }
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
    default_isr_rate: Number(row.default_isr_rate || 0),
    next_folio: Number(row.next_folio || 1),
  };
}

async function getProfile(t) {
  const emitter = await t.get('SELECT * FROM {s}.fiscal_emitters WHERE id=1 LIMIT 1').catch(() => null);
  return safeProfile(emitter || await t.get('SELECT * FROM {s}.fiscal_profiles WHERE id = 1'));
}

async function getEmitter(t, emitterId = 0, branchId = 0) {
  let row = null;
  if (Number(branchId) > 0) {
    row = await t.get(
      `SELECT e.* FROM {s}.branches b JOIN {s}.fiscal_emitters e ON e.id=b.fiscal_emitter_id
       WHERE b.id=$1 LIMIT 1`, [Number(branchId)]
    );
  }
  if (!row && Number(emitterId) > 0) row = await t.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 LIMIT 1', [Number(emitterId)]);
  return safeProfile(row || await getProfile(t));
}

async function reserveStamp(tx, invoiceType, invoiceId, emitterId, actor) {
  const wallet = await tx.get('SELECT * FROM {s}.stamp_wallet WHERE id=1 FOR UPDATE');
  if (!wallet) throw Object.assign(new Error('El monedero de timbres no está configurado'), { status: 409 });
  if (!Number(wallet.unlimited) && Number(wallet.balance) - Number(wallet.reserved) < 1) {
    throw Object.assign(new Error('No tienes timbres disponibles. Solicita una recarga para continuar.'), { status: 402 });
  }
  await tx.run('UPDATE {s}.stamp_wallet SET reserved=reserved+1,updated_at=now() WHERE id=1');
  await tx.run(
    `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,invoice_type,invoice_id,fiscal_emitter_id,detail,actor)
     VALUES('reserved',0,$1,$2,$3,$4,'Timbre reservado para timbrado',$5)`,
    [Number(wallet.balance), invoiceType, invoiceId, emitterId || null, actor]
  );
}

async function finalizeStamp(t, invoiceType, invoiceId, outcome, emitterId, actor) {
  await t.tx(async (tx) => {
    const reservation = await tx.get(
      `SELECT id FROM {s}.stamp_ledger WHERE invoice_type=$1 AND invoice_id=$2 AND movement_type='reserved' LIMIT 1 FOR UPDATE`,
      [invoiceType, invoiceId]
    );
    if (!reservation) return;
    const wallet = await tx.get('SELECT * FROM {s}.stamp_wallet WHERE id=1 FOR UPDATE');
    if (outcome === 'consumed') {
      const nextBalance = Number(wallet.unlimited) ? Number(wallet.balance) : Math.max(0, Number(wallet.balance) - 1);
      await tx.run('UPDATE {s}.stamp_wallet SET balance=$1,reserved=GREATEST(0,reserved-1),updated_at=now() WHERE id=1', [nextBalance]);
      await tx.run("UPDATE {s}.stamp_ledger SET movement_type='consumed',quantity=-1,balance_after=$1,detail='CFDI timbrado' WHERE id=$2", [nextBalance, reservation.id]);
    } else {
      await tx.run('UPDATE {s}.stamp_wallet SET reserved=GREATEST(0,reserved-1),updated_at=now() WHERE id=1');
      await tx.run("UPDATE {s}.stamp_ledger SET movement_type='released',detail='Reserva liberada por timbrado no realizado' WHERE id=$1", [reservation.id]);
    }
  });
}

function sandboxIssuerDefaults() {
  return {
    rfc: config.FACTURAMA_SANDBOX_RFC,
    legalName: config.FACTURAMA_SANDBOX_NAME,
    fiscalRegime: config.FACTURAMA_SANDBOX_REGIME,
    postalCode: config.FACTURAMA_SANDBOX_POSTAL_CODE,
    series: 'FAC',
    defaultProductCode: '01010101',
    defaultUnitCode: 'E48',
    defaultUnitName: 'Unidad de servicio',
    defaultTaxObject: '02',
    defaultIvaRate: 0.16,
    defaultIsrRate: 0,
    defaultCardPaymentForm: '04',
  };
}

function profileCompleteness(profile) {
  if (!profile) return false;
  return Boolean(profile.rfc && profile.legal_name && profile.fiscal_regime && profile.postal_code && profile.default_product_code);
}

function profileReady(profile) {
  if (!profile?.enabled || !profileCompleteness(profile) || !facturamaFor(profile).isConfigured()) return false;
  if (profile.environment === 'sandbox' && profile.sandbox_shared) return true;
  if (profile.api_mode === 'web') return true;
  return Boolean(profile.csd_uploaded);
}

function profileReadinessError(profile) {
  if (!profile?.enabled) return 'Activa la facturación electrónica en la configuración fiscal';
  if (!profileCompleteness(profile)) return 'Completa los datos fiscales y valores SAT predeterminados del negocio';
  if (!facturamaFor(profile).isConfigured()) return `Facturación en preparación: faltan las credenciales de Facturama ${normalizeEnvironment(profile?.environment) === 'sandbox' ? 'Sandbox' : 'Producción'} en el servidor. Comunícate con soporte.`;
  if (profile.environment === 'sandbox' && profile.sandbox_shared) return '';
  if (profile.api_mode === 'web') return '';
  if (!profile.csd_uploaded) return 'Carga los certificados de sello digital del emisor';
  return '';
}

async function requestMexicoEligibility(req) {
  if (req.tenant?.slug === config.DEMO_TENANT_SLUG) return true;
  if (Number(req.tenant?.invoicing_enabled)) return true;
  if (isMexicoIdentity(req.tenant)) return true;
  const leadId = Number(req.user?.demoLeadId || 0);
  if (!Number.isInteger(leadId) || leadId <= 0) return false;
  const lead = await q('SELECT phone_country, phone_calling_code FROM demo_leads WHERE id = $1 LIMIT 1', [leadId]);
  return isMexicoIdentity(lead.rows[0]);
}

function requireInvoicingActivated(req, res, next) {
  if (req.tenant?.slug === config.DEMO_TENANT_SLUG || Number(req.tenant?.invoicing_enabled)) return next();
  return res.status(403).json({ error: 'La facturación electrónica está disponible para configurar, pero el timbrado todavía no ha sido activado para este negocio.' });
}

async function requireMexico(req, res, next) {
  try {
    if (await requestMexicoEligibility(req)) return next();
    if (isMexicoIdentity(req.tenant)) return res.status(403).json({ error: 'La facturación electrónica todavía no ha sido activada para este negocio. Solicítala al administrador.' });
    return res.status(403).json({ error: 'La facturación electrónica está disponible únicamente para cuentas registradas en México (+52)' });
  } catch (error) { next(error); }
}

async function findPublicTenant(slug) {
  const found = await q(
    `SELECT id, slug, business_name, phone_country, phone_calling_code, logo, primary_color, account_status, billing_status, invoicing_enabled, invoicing_environment,
            timezone, customer_since, trial_status, trial_started_on, trial_ends_on
     FROM tenants WHERE slug = $1 LIMIT 1`,
    [String(slug || '').trim().toLowerCase()]
  );
  const tenant = found.rows[0];
  if (!tenant || tenant.account_status !== 'active' || tenant.billing_status === 'suspended' || trialState(tenant).isExpired) return null;
  const isDemoTenant = tenant.slug === config.DEMO_TENANT_SLUG;
  if (!isMexicoIdentity(tenant) && !isDemoTenant && !Number(tenant.invoicing_enabled)) return null;
  if (!isDemoTenant && !Number(tenant.invoicing_enabled)) return null;
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
    emitterId: row.fiscal_emitter_id ? Number(row.fiscal_emitter_id) : null,
    issuerRfc: row.issuer_rfc || '',
    environment: normalizeEnvironment(row.environment),
    apiMode: row.api_mode || 'multi',
    receiver,
    total: Number(row.order_total || row.total || 0),
    error: row.error_message || '',
    cancellationStatus: row.cancellation_status || '',
    cancellationMessage: row.cancellation_message || '',
    paymentMethod: row.payment_method || 'PUE',
    paymentForm: row.payment_form || '',
    issuedAt: row.issued_at || '',
    createdAt: row.created_at || '',
    hasXml: Boolean(row.xml_enc),
    hasPdf: Boolean(row.pdf_enc),
  };
}

function globalInvoiceSummary(row) {
  return {
    id: Number(row.id),
    providerId: row.provider_id || '',
    uuid: row.uuid || '',
    series: row.series || '',
    folio: row.folio || '',
    status: row.status,
    emitterId: row.fiscal_emitter_id ? Number(row.fiscal_emitter_id) : null,
    issuerRfc: row.issuer_rfc || '',
    businessDate: row.business_date || '',
    branchId: row.service_branch_id ? Number(row.service_branch_id) : null,
    orderCount: Number(row.order_count || 0),
    conceptMode: row.concept_mode || 'detailed',
    total: Number(row.total || 0),
    paymentForm: row.payment_form || '',
    paymentMethod: row.payment_method || 'PUE',
    error: row.error_message || '',
    cancellationStatus: row.cancellation_status || '',
    cancellationMessage: row.cancellation_message || '',
    cancellationMotive: row.cancellation_motive || '',
    hasCancellationReceipt: Boolean(row.cancellation_receipt_enc),
    issuedAt: row.issued_at || '',
  };
}

function cancellationResult(response = {}, currentStatus = 'active') {
  const nested = response?.Cancellation || response?.Cancelation || response?.Cfdi || response?.Result || {};
  const raw = String(
    response?.CancellationStatus || response?.CancelationStatus || nested?.CancellationStatus || nested?.CancelationStatus
    || response?.Status || response?.status || nested?.Status || nested?.status || ''
  ).trim().toLowerCase();
  const canceled = ['canceled', 'cancelled', 'cancelado', 'acepted', 'accepted', 'expired'].includes(raw);
  const pending = ['pending', 'requested', 'solicitada', 'en proceso'].includes(raw);
  const rejected = ['rejected', 'rechazada'].includes(raw) || (raw === 'active' && currentStatus !== 'cancel_pending');
  return {
    raw: raw || String(currentStatus || ''),
    status: canceled ? 'canceled' : pending ? 'cancel_pending' : rejected ? 'active' : currentStatus,
    message: String(response?.Message || response?.message || nested?.Message || nested?.message || '').slice(0, 700),
    receipt: String(response?.AcuseXmlBase64 || nested?.AcuseXmlBase64 || ''),
    canceled,
  };
}

async function loadTypedDocument(t, type, id) {
  const table = documentTable(type);
  if (!table) return null;
  const row = await t.get(`SELECT * FROM {s}.${table} WHERE id=$1 LIMIT 1`, [id]);
  if (!row) return null;
  if (table === 'direct_invoices') {
    const expected = type === 'direct' ? 'invoice' : type;
    if (String(row.document_kind || 'invoice') !== expected) return null;
  }
  return { row,table };
}

async function cancelTypedDocument({ tenantDb,type,id,motive,replacementUuid,actor }) {
  const found = await loadTypedDocument(tenantDb,type,id);
  if (!found || !found.row.provider_id) throw Object.assign(new Error('CFDI no encontrado'), { status:404 });
  const invoice=found.row;
  if(motive==='01'&&String(invoice.uuid||'').toUpperCase()===String(replacementUuid||'').toUpperCase())throw Object.assign(new Error('El UUID sustituto debe ser distinto al CFDI que se cancela'),{status:400});
  if(!['active','cancel_pending'].includes(invoice.status))throw Object.assign(new Error('El CFDI no se puede cancelar en su estado actual'),{status:409});
  const profile=await getEmitter(tenantDb,invoice.fiscal_emitter_id);
  const response=await facturamaFor(invoice.environment||profile).cancelCfdi(invoice.provider_id,motive,replacementUuid,apiModeFor(invoice,profile));
  const cancellation=cancellationResult(response,'cancel_pending');
  const nextStatus=cancellation.status==='active'?'active':cancellation.status;
  const updated=await tenantDb.get(
    `UPDATE {s}.${found.table} SET status=$1,cancellation_motive=$2,replacement_uuid=$3,cancellation_status=$4,
     cancellation_message=$5,cancellation_receipt_enc=$6,cancel_requested_at=COALESCE(cancel_requested_at,now()),
     canceled_at=CASE WHEN $7 THEN now() ELSE canceled_at END,updated_at=now() WHERE id=$8 RETURNING *`,
    [nextStatus,motive,replacementUuid||null,cancellation.raw,cancellation.message,cancellation.receipt?encrypt(cancellation.receipt):null,cancellation.canceled,invoice.id]
  );
  if(cancellation.canceled&&type==='global')await tenantDb.run('UPDATE {s}.global_invoice_orders SET active=0 WHERE global_invoice_id=$1',[invoice.id]);
  if(cancellation.canceled&&type==='payment')await tenantDb.run('UPDATE {s}.payment_complement_documents SET active=0 WHERE payment_complement_id=$1',[invoice.id]);
  await tenantDb.run(`INSERT INTO {s}.fiscal_document_events(document_type,document_id,event_type,detail,actor) VALUES($1,$2,'cancel_requested',$3,$4)`,[type,invoice.id,cancellation.raw||'solicitada',actor]);
  return { updated,cancellation };
}

function findCfdiInProviderResponse(payload, invoice) {
  const objects=[];
  const visit=(value)=>{if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return;}objects.push(value);Object.values(value).forEach(visit);};
  visit(payload);
  return objects.find((item)=>String(item.Folio??item.folio??'')===String(invoice.folio||'')
    && (!invoice.series||!String(item.Serie??item.serie??'')||String(item.Serie??item.serie??'').toUpperCase()===String(invoice.series).toUpperCase())) || null;
}

function cfdiDocumentSummary(row) {
  const receiver = parseJson(decrypt(row.receiver_data_enc), {});
  return {
    id: Number(row.id), type: row.document_type, orderId: row.order_id ? Number(row.order_id) : null,
    providerId: row.provider_id || '', uuid: row.uuid || '', series: row.series || '', folio: row.folio || '',
    status: row.status || '', issuerRfc: row.issuer_rfc || '', receiver, total: Number(row.total || 0),
    environment: normalizeEnvironment(row.environment), apiMode: row.api_mode || 'multi',
    branchId: row.service_branch_id ? Number(row.service_branch_id) : null,
    orderCount: Number(row.order_count || (row.order_id ? 1 : 0)),
    cancellationMotive: row.cancellation_motive || '', cancellationStatus: row.cancellation_status || '',
    cancellationMessage: row.cancellation_message || '', hasCancellationReceipt: Boolean(row.cancellation_receipt_enc),
    cancelRequestedAt: row.cancel_requested_at || '', canceledAt: row.canceled_at || '',
    issuedAt: row.issued_at || '', createdAt: row.created_at || '', error: row.error_message || '',
    paymentMethod: row.payment_method || (row.document_type === 'payment' ? '' : 'PUE'),
    paymentForm: row.payment_form || '',
    relationType: row.relation_type || '',
    sourceType: row.source_document_type || '', sourceId: row.source_document_id ? Number(row.source_document_id) : null,
  };
}

async function loadInvoiceFiles(invoice, profile) {
  const files = {};
  if (!invoice.provider_id) return files;
  const facturama = facturamaFor(invoice.environment || profile);
  await Promise.all(['xml', 'pdf'].map(async (format) => {
    try {
      const result = await facturama.downloadCfdi(invoice.provider_id, format, apiModeFor(invoice, profile));
      if (result?.Content) files[format] = String(result.Content);
    } catch (error) {
      console.warn(`[invoicing] No se pudo descargar ${format} de ${invoice.provider_id}:`, error.message);
    }
  }));
  return files;
}

async function sendInvoiceEmail({ tenant, tenantDb, invoiceId, emailInput, actor, publicToken = null }) {
  const email = validateInvoiceEmail(emailInput);
  const invoice = await tenantDb.get(
    `SELECT i.*, o.invoice_token, o.invoice_code
     FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id
     WHERE i.id=$1 LIMIT 1`,
    [invoiceId]
  );
  if (!invoice || (publicToken !== null && !invoiceAccessMatches(invoice, publicToken))) {
    throw Object.assign(new Error('CFDI no encontrado'), { status: 404 });
  }
  if (invoice.status !== 'active') {
    throw Object.assign(new Error('Sólo se pueden enviar CFDI timbrados y activos'), { status: 409 });
  }
  if (!invoice.provider_id) {
    throw Object.assign(new Error('El CFDI todavía no está disponible en Facturama'), { status: 409 });
  }
  const profile = await getEmitter(tenantDb, invoice.fiscal_emitter_id);
  const facturama = facturamaFor(invoice.environment || profile);
  const maskedEmail = maskInvoiceEmail(email);
  const identity = [invoice.series, invoice.folio].filter(Boolean).join('-') || invoice.uuid || invoice.id;
  try {
    const response = await facturama.sendCfdiEmail(invoice.provider_id, email, apiModeFor(invoice, profile), {
      subject: `Factura ${identity} · ${tenant?.business_name || 'ChatBotPro'}`,
      comments: 'Adjuntamos la representación PDF y el archivo XML de tu CFDI.',
    });
    await tenantDb.run(
      "INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,'email_sent',$2,$3)",
      [invoice.id, `Enviado mediante Facturama a ${maskedEmail}`, actor]
    );
    return { invoice: invoiceSummary(invoice, false), providerMessage: String(response?.msj || response?.Message || '') };
  } catch (error) {
    await tenantDb.run(
      "INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,'email_failed',$2,$3)",
      [invoice.id, `No enviado a ${maskedEmail}: ${String(error.message || 'Error de Facturama').slice(0, 700)}`, actor]
    ).catch(() => {});
    throw error;
  }
}

async function issueGlobalInvoice({ tenant, tenantDb, orderIds, conceptMode = 'total', actor = '', allowedBranchId = null }) {
  const ids = [...new Set((orderIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw Object.assign(new Error('Selecciona al menos una venta sin facturar'), { status: 400 });
  if (ids.length > 500) throw Object.assign(new Error('Puedes incluir hasta 500 tickets por factura global'), { status: 400 });
  const normalizedConceptMode = conceptMode === 'detailed' ? 'detailed' : 'total';
  const timezone = String(tenantDb.timezone || 'America/Mexico_City').replace(/'/g, '');
  const previewSales = await tenantDb.all(
    `SELECT id, items, total::float AS total, status, channel, payment_status, payment_method, payment_breakdown,
            delivery_fee::float AS delivery_fee, service_branch_id,
            to_char(created_at AT TIME ZONE '${timezone}', 'YYYY-MM-DD') AS business_date
     FROM {s}.orders WHERE id=ANY($1::int[]) AND channel='pos' ORDER BY id`,
    [ids]
  );
  if (previewSales.length !== ids.length) throw Object.assign(new Error('Una o más ventas seleccionadas ya no están disponibles'), { status: 409 });
  if (previewSales.some((sale) => sale.status === 'cancelado')) throw Object.assign(new Error('No se pueden incluir tickets cancelados'), { status: 409 });
  if (previewSales.some((sale) => sale.payment_status === 'pending')) throw Object.assign(new Error('Liquida las ventas a crédito antes de facturarlas'), { status: 409 });
  const businessDates = new Set(previewSales.map((sale) => sale.business_date));
  if (businessDates.size !== 1) throw Object.assign(new Error('La factura global diaria sólo puede incluir ventas de una misma fecha'), { status: 409 });
  const branchKeys = new Set(previewSales.map((sale) => Number(sale.service_branch_id || 0)));
  if (branchKeys.size !== 1) throw Object.assign(new Error('Selecciona ventas de una sola sucursal por factura global'), { status: 409 });
  const branchId = Number(previewSales[0].service_branch_id || 0);
  if (allowedBranchId !== null && branchId !== Number(allowedBranchId)) {
    throw Object.assign(new Error('Sólo puedes facturar ventas de tu sucursal asignada'), { status: 403 });
  }
  const branch = branchId ? await tenantDb.get('SELECT fiscal_postal_code,fiscal_emitter_id FROM {s}.branches WHERE id=$1 LIMIT 1', [branchId]) : null;
  const profile = await getEmitter(tenantDb, branch?.fiscal_emitter_id, branchId);
  profile.environment = tenantEnvironment(tenant);
  const facturama = facturamaFor(profile);
  const readinessError = profileReadinessError(profile);
  if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });
  let expeditionPlace = resolveExpeditionPostalCode(profile, branch?.fiscal_postal_code);
  let invoiceSeries = profile.series;
  if (profile.api_mode === 'web') {
    const issuanceContext = await facturama.ensureWebIssuanceContext(expeditionPlace, profile.series);
    expeditionPlace = issuanceContext.postalCode;
    invoiceSeries = issuanceContext.series;
  }
  const receiver = validateIncomeReceiver({
    rfc: 'XAXX010101000', name: 'PUBLICO EN GENERAL', fiscalRegime: '616',
    postalCode: expeditionPlace, cfdiUse: 'S01',
  }, { expeditionPostalCode: expeditionPlace });

  const rawItems = previewSales.flatMap((sale) => parseJson(sale.items, []));
  const productIds = [...new Set(rawItems.map((item) => Number(item.id || item.productId || 0)).filter((id) => id > 0))];
  const productRows = productIds.length ? await tenantDb.all(
    `SELECT id,name,sat_product_code,sat_unit_code,sat_unit_name,tax_object,
            iva_rate::float AS iva_rate,isr_rate::float AS isr_rate
     FROM {s}.products WHERE id=ANY($1::int[])`, [productIds]
  ) : [];
  const productsById = new Map(productRows.map((row) => [Number(row.id), row]));

  const allocated = await tenantDb.tx(async (tx) => {
    const sales = await tx.all(
      `SELECT id,items,total::float AS total,status,channel,payment_status,payment_method,payment_breakdown,
              delivery_fee::float AS delivery_fee,service_branch_id,
              to_char(created_at AT TIME ZONE '${timezone}', 'YYYY-MM-DD') AS business_date
       FROM {s}.orders WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids]
    );
    if (sales.length !== ids.length || sales.some((sale) => sale.channel !== 'pos' || sale.status === 'cancelado' || sale.payment_status === 'pending')) {
      throw Object.assign(new Error('Una o más ventas dejaron de ser elegibles'), { status: 409 });
    }
    if (new Set(sales.map((sale) => sale.business_date)).size !== 1 || new Set(sales.map((sale) => Number(sale.service_branch_id || 0))).size !== 1) {
      throw Object.assign(new Error('Las ventas deben pertenecer al mismo día y sucursal'), { status: 409 });
    }
    if (allowedBranchId !== null && Number(sales[0].service_branch_id || 0) !== Number(allowedBranchId)) {
      throw Object.assign(new Error('Sólo puedes facturar ventas de tu sucursal asignada'), { status: 403 });
    }
    const individual = await tx.get(
      `SELECT order_id FROM {s}.invoices WHERE order_id=ANY($1::int[])
       AND status IN ('pending','unknown','active','cancel_pending') LIMIT 1`, [ids]
    );
    if (individual) throw Object.assign(new Error(`El ticket #${individual.order_id} ya tiene una factura individual`), { status: 409 });
    const global = await tx.get(
      `SELECT gio.order_id FROM {s}.global_invoice_orders gio
       JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id
       WHERE gio.order_id=ANY($1::int[]) AND gio.active=1
         AND gi.status IN ('pending','unknown','active') LIMIT 1`, [ids]
    );
    if (global) throw Object.assign(new Error(`El ticket #${global.order_id} ya pertenece a una factura global`), { status: 409 });

    const items = buildGlobalFacturamaItems(sales, productsById, profile, { conceptMode: normalizedConceptMode });
    const paymentForm = paymentFormFromSales(sales, profile.default_card_payment_form);
    const total = Math.round(sales.reduce((sum, sale) => sum + Number(sale.total || 0), 0) * 100) / 100;
    const lockedProfile = await tx.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 FOR UPDATE', [profile.id || 1]);
    const folio = String(lockedProfile.next_folio || 1);
    await tx.run('UPDATE {s}.fiscal_emitters SET next_folio=next_folio+1,updated_at=now() WHERE id=$1', [lockedProfile.id]);
    const snapshot = {
      issuer: { rfc: profile.rfc, legalName: profile.legal_name, fiscalRegime: profile.fiscal_regime, postalCode: expeditionPlace },
      receiver, paymentForm, periodicity: '01', conceptMode: normalizedConceptMode, businessDate: sales[0].business_date,
      orderIds: sales.map((sale) => Number(sale.id)), items, total,
    };
    const row = await tx.get(
      `INSERT INTO {s}.global_invoices
       (request_key,environment,api_mode,series,folio,status,service_branch_id,business_date,periodicity,concept_mode,order_count,total,payment_form,receiver_data_enc,fiscal_snapshot_enc,issued_by,fiscal_emitter_id,issuer_rfc)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,'01',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [createRequestKey(), profile.environment, profile.api_mode, invoiceSeries, folio, branchId || null, sales[0].business_date,
        normalizedConceptMode, sales.length, total, paymentForm, encrypt(JSON.stringify(receiver)), encrypt(JSON.stringify(snapshot)), actor,
        lockedProfile.id, profile.rfc]
    );
    await reserveStamp(tx, 'global', row.id, lockedProfile.id, actor);
    for (const sale of sales) {
      await tx.run(
        'INSERT INTO {s}.global_invoice_orders (global_invoice_id,order_id,amount,active) VALUES ($1,$2,$3,1)',
        [row.id, sale.id, sale.total]
      );
    }
    await tx.run(
      "INSERT INTO {s}.global_invoice_events (global_invoice_id,event_type,detail,actor) VALUES ($1,'created',$2,$3)",
      [row.id, `${sales.length} tickets · ${sales[0].business_date}`, actor]
    );
    return { row, snapshot };
  });

  const payload = {
    NameId: 1, CfdiType: 'I', Currency: 'MXN', Exportation: '01', ExpeditionPlace: expeditionPlace,
    PaymentForm: allocated.snapshot.paymentForm, PaymentMethod: 'PUE', Serie: invoiceSeries, Folio: allocated.row.folio,
    Receiver: { Rfc: receiver.rfc, Name: receiver.name, FiscalRegime: receiver.fiscalRegime, TaxZipCode: receiver.postalCode, CfdiUse: receiver.cfdiUse },
    Items: allocated.snapshot.items,
    GlobalInformation: globalInformationForReceiver(receiver, `${allocated.snapshot.businessDate}T12:00:00`),
    Observations: `Factura global diaria · ${allocated.snapshot.businessDate} · ${allocated.snapshot.orderIds.length} tickets`,
  };
  if (profile.api_mode !== 'web') payload.Issuer = { Rfc: profile.rfc, Name: profile.legal_name, FiscalRegime: profile.fiscal_regime };

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
    if (!identity.providerId) throw new FacturamaError('Facturama no devolvió el identificador del CFDI global', { status: 502, uncertain: true });
    const fileData = await loadInvoiceFiles({ provider_id: identity.providerId, environment: profile.environment, api_mode: profile.api_mode }, profile);
    const updated = await tenantDb.get(
      `UPDATE {s}.global_invoices SET provider_id=$1,uuid=$2,certificate_number=$3,status='active',provider_response_enc=$4,
       xml_enc=$5,pdf_enc=$6,issued_at=now(),updated_at=now(),error_message='' WHERE id=$7 RETURNING *`,
      [identity.providerId, identity.uuid || null, identity.certificateNumber || null, encrypt(JSON.stringify(response)),
        fileData.xml ? encrypt(fileData.xml) : null, fileData.pdf ? encrypt(fileData.pdf) : null, allocated.row.id]
    );
    await tenantDb.run(
      "INSERT INTO {s}.global_invoice_events (global_invoice_id,event_type,detail,actor) VALUES ($1,'stamped',$2,$3)",
      [updated.id, identity.uuid || identity.providerId, actor]
    );
    await finalizeStamp(tenantDb, 'global', updated.id, 'consumed', profile.id, actor);
    return { invoice: globalInvoiceSummary(updated) };
  } catch (error) {
    const uncertain = Boolean(error.uncertain);
    const status = uncertain ? 'unknown' : 'failed';
    await tenantDb.tx(async (tx) => {
      await tx.run(
        'UPDATE {s}.global_invoices SET status=$1,error_message=$2,provider_response_enc=$3,updated_at=now() WHERE id=$4',
        [status, String(error.message || 'Error de timbrado').slice(0, 900), error.details ? encrypt(JSON.stringify(error.details)) : null, allocated.row.id]
      );
      if (!uncertain) await tx.run('UPDATE {s}.global_invoice_orders SET active=0 WHERE global_invoice_id=$1', [allocated.row.id]);
      await tx.run(
        'INSERT INTO {s}.global_invoice_events (global_invoice_id,event_type,detail,actor) VALUES ($1,$2,$3,$4)',
        [allocated.row.id, status, String(error.message || '').slice(0, 900), actor]
      );
    });
    if (!uncertain) await finalizeStamp(tenantDb, 'global', allocated.row.id, 'released', profile.id, actor);
    throw error;
  }
}

async function issueSaleInvoice({ tenant, tenantDb, orderId, receiverInput, requestedPaymentForm = '', requestedPaymentMethod = 'PUE', relationInput = {}, conceptMode = 'detailed', actor = '', publicToken = '' }) {
  const paymentMethod = normalizePaymentMethod(requestedPaymentMethod);
  const sale = await tenantDb.get(
    `SELECT id, items, subtotal::float AS subtotal, total::float AS total, status, channel, payment_status, payment_method, payment_breakdown,
            delivery_fee::float AS delivery_fee, service_branch_id, invoice_token, invoice_code, created_at
     FROM {s}.orders WHERE id = $1 LIMIT 1`,
    [orderId]
  );
  if (!sale || sale.channel !== 'pos') throw Object.assign(new Error('Ticket de punto de venta no encontrado'), { status: 404 });
  if (publicToken && !invoiceAccessMatches(sale, publicToken)) throw Object.assign(new Error('El código de facturación no es válido'), { status: 404 });
  if (sale.status === 'cancelado') throw Object.assign(new Error('No se puede facturar un ticket cancelado'), { status: 409 });
  if (sale.payment_status === 'pending' && paymentMethod !== 'PPD') throw Object.assign(new Error('La venta a crédito debe emitirse como PPD o liquidarse antes de facturar'), { status: 409 });
  const profile = await getEmitter(tenantDb, 0, sale.service_branch_id);
  profile.environment = tenantEnvironment(tenant);
  const facturama = facturamaFor(profile);
  const readinessError = profileReadinessError(profile);
  if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });

  const globalInvoice = await tenantDb.get(
    `SELECT gi.id,gi.uuid,gi.status FROM {s}.global_invoice_orders gio
     JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id
     WHERE gio.order_id=$1 AND gio.active=1 AND gi.status IN ('pending','unknown','active') LIMIT 1`,
    [sale.id]
  );
  if (globalInvoice) {
    throw Object.assign(new Error(`Este ticket ya está incluido en la factura global ${globalInvoice.uuid || `#${globalInvoice.id}`}`), { status: 409 });
  }

  const current = await tenantDb.get(
    `SELECT * FROM {s}.invoices WHERE order_id = $1 AND status IN ('pending','unknown','active','cancel_pending') ORDER BY id DESC LIMIT 1`,
    [sale.id]
  );
  if (current) return { invoice: invoiceSummary({ ...current, order_total: sale.total }), reused: true };

  const rawItems = typeof sale.items === 'string' ? parseJson(sale.items, []) : sale.items;
  const productIds = [...new Set((rawItems || []).map((item) => Number(item.id || item.productId || 0)).filter((id) => id > 0))];
  const productRows = productIds.length
    ? await tenantDb.all(
      `SELECT id, name, sat_product_code, sat_unit_code, sat_unit_name, tax_object,
              iva_rate::float AS iva_rate, isr_rate::float AS isr_rate
       FROM {s}.products WHERE id = ANY($1::int[])`, [productIds]
    )
    : [];
  const productsById = new Map(productRows.map((row) => [Number(row.id), row]));
  const normalizedConceptMode = conceptMode === 'total' ? 'total' : 'detailed';
  const items = buildFacturamaItems(sale, productsById, profile, { conceptMode: normalizedConceptMode });
  const branch = sale.service_branch_id
    ? await tenantDb.get('SELECT fiscal_postal_code,fiscal_emitter_id FROM {s}.branches WHERE id = $1 LIMIT 1', [sale.service_branch_id])
    : null;
  let expeditionPlace = resolveExpeditionPostalCode(profile, branch?.fiscal_postal_code);
  let invoiceSeries = profile.series;
  if (profile.api_mode === 'web') {
    const issuanceContext = await facturama.ensureWebIssuanceContext(expeditionPlace, profile.series);
    expeditionPlace = issuanceContext.postalCode;
    invoiceSeries = issuanceContext.series;
  }
  const receiver = validateIncomeReceiver(receiverInput, { expeditionPostalCode: expeditionPlace });
  await validateReceiverWithFacturama(facturama, receiver);
  if (receiver.rfc === 'XAXX010101000' && paymentMethod === 'PPD') {
    throw Object.assign(new Error('Las facturas a público en general deben emitirse como PUE'), { status: 400 });
  }
  const salePaymentBreakdown = parseJson(sale.payment_breakdown, {});
  const storedCardType = String(salePaymentBreakdown.cardType || salePaymentBreakdown.card_type || '').toLowerCase();
  if (paymentMethod === 'PUE' && sale.payment_method === 'card' && !['debit','credit'].includes(storedCardType) && !['04','28'].includes(String(requestedPaymentForm || ''))) {
    throw Object.assign(new Error('Selecciona si el ticket se pagó con tarjeta de débito o crédito'), { status: 400 });
  }
  const paymentForm = paymentMethod === 'PPD' ? '99' : paymentFormFromSale(sale, profile.default_card_payment_form, requestedPaymentForm);
  const relation = relationFromInput(relationInput);

  const allocated = await tenantDb.tx(async (tx) => {
    const lockedProfile = await tx.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 FOR UPDATE', [profile.id || 1]);
    const duplicate = await tx.get(
      `SELECT * FROM {s}.invoices WHERE order_id = $1 AND status IN ('pending','unknown','active','cancel_pending') ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [sale.id]
    );
    if (duplicate) return { duplicate };
    const folio = String(lockedProfile.next_folio || 1);
    const requestKey = createRequestKey();
    await tx.run('UPDATE {s}.fiscal_emitters SET next_folio=next_folio+1,updated_at=now() WHERE id=$1', [lockedProfile.id]);
    const snapshot = {
      issuer: { rfc: profile.rfc, legalName: profile.legal_name, fiscalRegime: profile.fiscal_regime, postalCode: expeditionPlace },
      receiver, paymentForm, paymentMethod, relationType: relation.relationType, relatedUuids: relation.uuids,
      conceptMode: normalizedConceptMode, items, total: Number(sale.total), orderId: Number(sale.id),
    };
    const row = await tx.get(
      `INSERT INTO {s}.invoices
       (order_id,request_key,environment,api_mode,series,folio,status,receiver_data_enc,fiscal_snapshot_enc,issued_by,
        fiscal_emitter_id,issuer_rfc,payment_method,payment_form,relation_type,related_uuids_enc)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [sale.id,requestKey,profile.environment,profile.api_mode,invoiceSeries,folio,encrypt(JSON.stringify(receiver)),encrypt(JSON.stringify(snapshot)),actor,
        lockedProfile.id,profile.rfc,paymentMethod,paymentForm,relation.relationType || null,relation.uuids.length ? encrypt(JSON.stringify(relation.uuids)) : null]
    );
    await reserveStamp(tx, 'individual', row.id, lockedProfile.id, actor);
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
    PaymentMethod: paymentMethod,
    Serie: invoiceSeries,
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
  if (relation.payload) payload.Relations = relation.payload;
  const globalInformation = globalInformationForReceiver(receiver, sale.created_at);
  if (globalInformation) payload.GlobalInformation = globalInformation;
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
    const fileData = await loadInvoiceFiles({ provider_id: identity.providerId, environment: profile.environment, api_mode: profile.api_mode }, profile);
    const updated = await tenantDb.get(
      `UPDATE {s}.invoices SET provider_id=$1, uuid=$2, certificate_number=$3, status='active',
         provider_response_enc=$4, xml_enc=$5, pdf_enc=$6, issued_at=now(), updated_at=now(), error_message=''
       WHERE id=$7 RETURNING *`,
      [identity.providerId, identity.uuid || null, identity.certificateNumber || null, encrypt(JSON.stringify(response)),
        fileData.xml ? encrypt(fileData.xml) : null, fileData.pdf ? encrypt(fileData.pdf) : null, allocated.row.id]
    );
    await tenantDb.run("INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,'stamped',$2,$3)", [updated.id, identity.uuid || identity.providerId, actor]);
    await finalizeStamp(tenantDb, 'individual', updated.id, 'consumed', profile.id, actor);
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
    if (!uncertain) await finalizeStamp(tenantDb, 'individual', allocated.row.id, 'released', profile.id, actor);
    throw error;
  }
}

async function issueDirectInvoice({ tenant, tenantDb, input = {}, actor = '' }) {
  const profile = await getEmitter(tenantDb, Number(input.emitterId || 1));
  profile.environment = tenantEnvironment(tenant);
  const facturama = facturamaFor(profile);
  const readinessError = profileReadinessError(profile);
  if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });

  const externalReference = String(input.externalReference || '').trim().slice(0, 80);
  const description = String(input.description || '').trim().replace(/\s+/g, ' ').slice(0, 1000);
  const total = Math.round(Number(input.total || 0) * 100) / 100;
  const saleDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.saleDate || '')) ? String(input.saleDate) : new Date().toISOString().slice(0, 10);
  const paymentMethod = normalizePaymentMethod(input.paymentMethod);
  const paymentForm = paymentMethod === 'PPD' ? '99' : String(input.paymentForm || '01').trim();
  if (!externalReference) throw Object.assign(new Error('Captura el folio o referencia de la venta'), { status: 400 });
  if (!description) throw Object.assign(new Error('Captura el concepto de la venta'), { status: 400 });
  if (!Number.isFinite(total) || total <= 0 || total > 9999999999.99) throw Object.assign(new Error('Captura un total válido mayor a cero'), { status: 400 });
  if (!PAYMENT_FORMS.has(paymentForm) || (paymentMethod === 'PUE' && paymentForm === '99')) throw Object.assign(new Error('Selecciona una forma de pago válida'), { status: 400 });
  if (saleDate > new Date().toISOString().slice(0,10)) throw Object.assign(new Error('La fecha de venta no puede ser futura'), { status: 400 });

  let expeditionPlace = resolveExpeditionPostalCode(profile);
  let invoiceSeries = profile.series;
  if (profile.api_mode === 'web') {
    const issuanceContext = await facturama.ensureWebIssuanceContext(expeditionPlace, profile.series);
    expeditionPlace = issuanceContext.postalCode;
    invoiceSeries = issuanceContext.series;
  }
  const receiverInput = input.publicGeneral ? {
    rfc: 'XAXX010101000', name: 'PUBLICO EN GENERAL', fiscalRegime: '616',
    postalCode: expeditionPlace, cfdiUse: 'S01',
  } : input.receiver;
  const receiver = validateIncomeReceiver(receiverInput, { expeditionPostalCode: expeditionPlace });
  await validateReceiverWithFacturama(facturama, receiver);
  if (receiver.rfc === 'XAXX010101000' && paymentMethod === 'PPD') {
    throw Object.assign(new Error('Las facturas a público en general deben emitirse como PUE'), { status: 400 });
  }
  const relation = relationFromInput(input);
  const items = buildFacturamaItems({
    items: [{ name: description, qty: 1, price: total }], total, delivery_fee: 0,
  }, new Map(), profile, { conceptMode: 'detailed' });

  const allocated = await tenantDb.tx(async (tx) => {
    const lockedProfile = await tx.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 FOR UPDATE', [profile.id || 1]);
    const duplicate = await tx.get(
      `SELECT * FROM {s}.direct_invoices WHERE fiscal_emitter_id=$1 AND document_kind='invoice'
       AND external_reference=$2 AND sale_date=$3::date AND status IN ('pending','unknown','active','cancel_pending')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,[lockedProfile.id,externalReference,saleDate]
    );
    if (duplicate) return { duplicate };
    const folio = String(lockedProfile.next_folio || 1);
    await tx.run('UPDATE {s}.fiscal_emitters SET next_folio=next_folio+1,updated_at=now() WHERE id=$1', [lockedProfile.id]);
    const snapshot = {
      issuer: { rfc: profile.rfc, legalName: profile.legal_name, fiscalRegime: profile.fiscal_regime, postalCode: expeditionPlace },
      receiver, externalReference, saleDate, description, paymentForm, paymentMethod,
      relationType: relation.relationType, relatedUuids: relation.uuids, items, total,
    };
    const row = await tx.get(
      `INSERT INTO {s}.direct_invoices
       (external_reference,sale_date,description,total,payment_form,payment_method,document_kind,request_key,environment,api_mode,series,folio,status,
         receiver_data_enc,fiscal_snapshot_enc,issued_by,fiscal_emitter_id,issuer_rfc,relation_type,related_uuids_enc)
        VALUES($1,$2,$3,$4,$5,$6,'invoice',$7,$8,$9,$10,$11,'pending',$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [externalReference,saleDate,description,total,paymentForm,paymentMethod,createRequestKey(),profile.environment,profile.api_mode,
        invoiceSeries,folio,encrypt(JSON.stringify(receiver)),encrypt(JSON.stringify(snapshot)),actor,lockedProfile.id,profile.rfc,
        relation.relationType || null,relation.uuids.length ? encrypt(JSON.stringify(relation.uuids)) : null]
    );
    await reserveStamp(tx, 'direct', row.id, lockedProfile.id, actor);
    return { row, folio, snapshot };
  });
  if (allocated.duplicate) return { invoice: cfdiDocumentSummary({ ...allocated.duplicate,document_type:'direct' }),reused:true };

  const payload = {
    NameId: 1, CfdiType: 'I', Currency: 'MXN', Exportation: '01', ExpeditionPlace: expeditionPlace,
    PaymentForm: paymentForm, PaymentMethod: paymentMethod, Serie: invoiceSeries, Folio: allocated.folio,
    Receiver: { Rfc: receiver.rfc, Name: receiver.name, FiscalRegime: receiver.fiscalRegime, TaxZipCode: receiver.postalCode, CfdiUse: receiver.cfdiUse },
    Items: items, Observations: `Venta externa ${externalReference}`,
  };
  if (relation.payload) payload.Relations = relation.payload;
  const globalInformation = globalInformationForReceiver(receiver, `${saleDate}T12:00:00`);
  if (globalInformation) payload.GlobalInformation = globalInformation;
  if (profile.api_mode !== 'web') payload.Issuer = { Rfc: profile.rfc, Name: profile.legal_name, FiscalRegime: profile.fiscal_regime };

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
    const fileData = await loadInvoiceFiles({ provider_id: identity.providerId, environment: profile.environment, api_mode: profile.api_mode }, profile);
    const updated = await tenantDb.get(
      `UPDATE {s}.direct_invoices SET provider_id=$1,uuid=$2,certificate_number=$3,status='active',provider_response_enc=$4,
       xml_enc=$5,pdf_enc=$6,issued_at=now(),updated_at=now(),error_message='' WHERE id=$7 RETURNING *`,
      [identity.providerId,identity.uuid || null,identity.certificateNumber || null,encrypt(JSON.stringify(response)),
        fileData.xml ? encrypt(fileData.xml) : null,fileData.pdf ? encrypt(fileData.pdf) : null,allocated.row.id]
    );
    await finalizeStamp(tenantDb, 'direct', updated.id, 'consumed', profile.id, actor);
    return { invoice: cfdiDocumentSummary({ ...updated, document_type: 'direct' }) };
  } catch (error) {
    const uncertain = Boolean(error.uncertain);
    await tenantDb.run(
      `UPDATE {s}.direct_invoices SET status=$1,error_message=$2,provider_response_enc=$3,updated_at=now() WHERE id=$4`,
      [uncertain ? 'unknown' : 'failed',String(error.message || 'Error de timbrado').slice(0,900),error.details ? encrypt(JSON.stringify(error.details)) : null,allocated.row.id]
    );
    if (!uncertain) await finalizeStamp(tenantDb, 'direct', allocated.row.id, 'released', profile.id, actor);
    throw error;
  }
}

async function stampStandardDocument({ tenantDb, table, stampType, row, profile, payload, actor }) {
  const facturama = facturamaFor(profile);
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
    const files = await loadInvoiceFiles({ provider_id: identity.providerId, environment: profile.environment, api_mode: profile.api_mode }, profile);
    const updated = await tenantDb.get(
      `UPDATE {s}.${table} SET provider_id=$1,uuid=$2,certificate_number=$3,status='active',provider_response_enc=$4,
       xml_enc=$5,pdf_enc=$6,issued_at=now(),updated_at=now(),error_message='' WHERE id=$7 RETURNING *`,
      [identity.providerId,identity.uuid || null,identity.certificateNumber || null,encrypt(JSON.stringify(response)),
        files.xml ? encrypt(files.xml) : null,files.pdf ? encrypt(files.pdf) : null,row.id]
    );
    await finalizeStamp(tenantDb, stampType, row.id, 'consumed', profile.id, actor);
    await tenantDb.run(
      `INSERT INTO {s}.fiscal_document_events(document_type,document_id,event_type,detail,actor)
       VALUES($1,$2,'stamped',$3,$4)`,
      [stampType,row.id,identity.uuid || identity.providerId,actor]
    );
    return updated;
  } catch (error) {
    const uncertain = Boolean(error.uncertain);
    await tenantDb.run(
      `UPDATE {s}.${table} SET status=$1,error_message=$2,provider_response_enc=$3,updated_at=now() WHERE id=$4`,
      [uncertain ? 'unknown' : 'failed',String(error.message || 'Error de timbrado').slice(0,900),error.details ? encrypt(JSON.stringify(error.details)) : null,row.id]
    );
    if (!uncertain) await finalizeStamp(tenantDb, stampType, row.id, 'released', profile.id, actor);
    throw error;
  }
}

async function issueManualGlobalInvoice({ tenant, tenantDb, input = {}, actor = '' }) {
  const profile = await getEmitter(tenantDb, Number(input.emitterId || 1));
  profile.environment = tenantEnvironment(tenant);
  const facturama = facturamaFor(profile);
  const readinessError = profileReadinessError(profile);
  if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });
  const total = roundCurrency(input.total);
  const description = String(input.description || 'Venta global al público en general').trim().replace(/\s+/g, ' ').slice(0,1000);
  const reference = String(input.externalReference || `GLOBAL-${Date.now()}`).trim().slice(0,80);
  const paymentForm = String(input.paymentForm || '01').trim();
  const businessDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.businessDate || '')) ? String(input.businessDate) : new Date().toISOString().slice(0,10);
  const periodicity = ['01','02','03','04','05'].includes(String(input.periodicity || '')) ? String(input.periodicity) : '01';
  const months = /^(0[1-9]|1[0-2]|1[3-8])$/.test(String(input.months || '')) ? String(input.months) : businessDate.slice(5,7);
  const year = Number(input.year || businessDate.slice(0,4));
  if (!(total > 0) || total > 9999999999.99) throw Object.assign(new Error('Captura un total válido para la factura global'), { status: 400 });
  if (!PAYMENT_FORMS.has(paymentForm) || paymentForm === '99') throw Object.assign(new Error('Selecciona la forma en que se cobraron las operaciones globales'), { status: 400 });
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw Object.assign(new Error('El año de la factura global no es válido'), { status: 400 });
  if (businessDate > new Date().toISOString().slice(0,10)) throw Object.assign(new Error('La fecha de operaciones no puede ser futura'), { status: 400 });
  if ((periodicity === '05' && !/^1[3-8]$/.test(months)) || (periodicity !== '05' && !/^(0[1-9]|1[0-2])$/.test(months))) {
    throw Object.assign(new Error('El mes no corresponde a la periodicidad seleccionada'), { status: 400 });
  }
  let expeditionPlace = resolveExpeditionPostalCode(profile);
  let series = profile.series;
  if (profile.api_mode === 'web') {
    const context = await facturama.ensureWebIssuanceContext(expeditionPlace, profile.series);
    expeditionPlace = context.postalCode; series = context.series;
  }
  const receiver = validateIncomeReceiver({ rfc:'XAXX010101000',name:'PUBLICO EN GENERAL',fiscalRegime:'616',postalCode:expeditionPlace,cfdiUse:'S01' }, { expeditionPostalCode: expeditionPlace });
  const items = buildFacturamaItems({ items:[{ name:description,qty:1,price:total }],total,delivery_fee:0 }, new Map(), profile, { conceptMode:'detailed' });
  const allocated = await tenantDb.tx(async (tx) => {
    const emitter = await tx.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 FOR UPDATE', [profile.id || 1]);
    const duplicate = await tx.get(
      `SELECT * FROM {s}.direct_invoices WHERE fiscal_emitter_id=$1 AND document_kind='manual_global'
       AND external_reference=$2 AND sale_date=$3::date AND status IN ('pending','unknown','active','cancel_pending')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,[emitter.id,reference,businessDate]
    );
    if (duplicate) return { duplicate };
    const folio = String(emitter.next_folio || 1);
    await tx.run('UPDATE {s}.fiscal_emitters SET next_folio=next_folio+1,updated_at=now() WHERE id=$1', [emitter.id]);
    const snapshot = { issuer:{rfc:profile.rfc,legalName:profile.legal_name,fiscalRegime:profile.fiscal_regime,postalCode:expeditionPlace},receiver,
      externalReference:reference,businessDate,periodicity,months,year,description,paymentForm,paymentMethod:'PUE',items,total };
    const row = await tx.get(
      `INSERT INTO {s}.direct_invoices(external_reference,sale_date,description,total,payment_form,payment_method,document_kind,request_key,
       environment,api_mode,series,folio,status,receiver_data_enc,fiscal_snapshot_enc,issued_by,fiscal_emitter_id,issuer_rfc)
       VALUES($1,$2,$3,$4,$5,'PUE','manual_global',$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15) RETURNING *`,
      [reference,businessDate,description,total,paymentForm,createRequestKey(),profile.environment,profile.api_mode,series,folio,
        encrypt(JSON.stringify(receiver)),encrypt(JSON.stringify(snapshot)),actor,emitter.id,profile.rfc]
    );
    await reserveStamp(tx,'manual_global',row.id,emitter.id,actor);
    return { row };
  });
  if (allocated.duplicate) return { invoice: cfdiDocumentSummary({ ...allocated.duplicate,document_type:'manual_global' }),reused:true };
  const payload = { NameId:1,CfdiType:'I',Currency:'MXN',Exportation:'01',ExpeditionPlace:expeditionPlace,PaymentForm:paymentForm,
    PaymentMethod:'PUE',Serie:series,Folio:allocated.row.folio,Receiver:{Rfc:receiver.rfc,Name:receiver.name,FiscalRegime:receiver.fiscalRegime,TaxZipCode:receiver.postalCode,CfdiUse:'S01'},
    Items:items,GlobalInformation:{Periodicity:periodicity,Months:months,Year:year},Observations:`Factura global manual · ${reference}` };
  if (profile.api_mode !== 'web') payload.Issuer = { Rfc:profile.rfc,Name:profile.legal_name,FiscalRegime:profile.fiscal_regime };
  const updated = await stampStandardDocument({ tenantDb,table:'direct_invoices',stampType:'manual_global',row:allocated.row,profile,payload,actor });
  return { invoice: cfdiDocumentSummary({ ...updated,document_type:'manual_global' }) };
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

async function loadSourceDocument(t, type, id, forUpdate = false) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  if (type === 'individual') return t.get(`SELECT i.*,o.total::float AS total FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id WHERE i.id=$1${lock}`, [id]);
  if (type === 'global') return t.get(`SELECT * FROM {s}.global_invoices WHERE id=$1${lock}`, [id]);
  if (type === 'direct') return t.get(`SELECT * FROM {s}.direct_invoices WHERE id=$1 AND document_kind='invoice'${lock}`, [id]);
  return null;
}

function proportionalPaymentTaxes(snapshot, amount, total) {
  const groups = new Map();
  let taxable = false;
  for (const item of snapshot?.items || []) {
    if (String(item.TaxObject || '') === '02') taxable = true;
    for (const tax of item.Taxes || []) {
      const key = `${tax.Name}|${Number(tax.Rate || 0)}|${Boolean(tax.IsRetention)}`;
      const current = groups.get(key) || { Name:tax.Name,Rate:Number(tax.Rate || 0),IsRetention:Boolean(tax.IsRetention),Base:0,Total:0 };
      current.Base += Number(tax.Base || 0); current.Total += Number(tax.Total || 0); groups.set(key,current);
    }
  }
  const ratio = total > 0 ? amount / total : 0;
  return {
    taxObject: taxable ? '02' : '01',
    taxes: [...groups.values()].map((tax) => ({ ...tax,Base:Math.round(tax.Base * ratio * 1e6) / 1e6,Total:Math.round(tax.Total * ratio * 1e6) / 1e6 })),
  };
}

async function issuePaymentComplement({ tenant, tenantDb, input = {}, actor = '' }) {
  const requestedDocuments = Array.isArray(input.documents) && input.documents.length
    ? input.documents
    : [{ type:input.sourceType,id:input.sourceId,amount:input.amount }];
  requestedDocuments.sort((a,b) => `${a.type}:${String(a.id).padStart(20,'0')}`.localeCompare(`${b.type}:${String(b.id).padStart(20,'0')}`));
  if (!requestedDocuments.length || requestedDocuments.length > 50) throw Object.assign(new Error('Selecciona entre 1 y 50 facturas PPD para aplicar el pago'), { status: 400 });
  const paymentForm = String(input.paymentForm || '').trim();
  if (!PAYMENT_FORMS.has(paymentForm) || paymentForm === '99') throw Object.assign(new Error('Selecciona la forma real en que se recibió el pago'), { status: 400 });
  const paymentDate = new Date(input.paymentDate || '');
  if (Number.isNaN(paymentDate.getTime()) || paymentDate.getTime() > Date.now() + 300000) throw Object.assign(new Error('La fecha del pago no es válida'), { status: 400 });
  const operationNumber = String(input.operationNumber || '').trim().slice(0,100);
  const allocated = await tenantDb.tx(async (tx) => {
    const prepared = [];
    const sourceKeys = new Set();
    let common = null;
    for (const requested of requestedDocuments) {
      const type = ['individual','global','direct'].includes(String(requested.type || '')) ? String(requested.type) : '';
      const id = Number(requested.id || 0);
      const sourceKey = `${type}:${id}`;
      if (sourceKeys.has(sourceKey)) throw Object.assign(new Error('Una factura sólo puede aparecer una vez en el mismo complemento de pago'), { status: 400 });
      sourceKeys.add(sourceKey);
      const source = type && id > 0 ? await loadSourceDocument(tx,type,id,true) : null;
      if (!source || source.status !== 'active' || !source.uuid) throw Object.assign(new Error('La factura relacionada no está vigente o no tiene UUID'), { status: 409 });
      if (String(source.payment_method || 'PUE') !== 'PPD') throw Object.assign(new Error(`La factura ${source.uuid} no fue emitida como PPD`), { status: 409 });
      const receiver = parseJson(decrypt(source.receiver_data_enc),{});
      const identity = `${source.environment}|${source.api_mode}|${source.fiscal_emitter_id}|${source.issuer_rfc}|${receiver.rfc}`;
      if (common && common.identity !== identity) throw Object.assign(new Error('Todos los CFDI de un complemento deben pertenecer al mismo emisor, ambiente y receptor'), { status: 409 });
      if (!common) common = { identity,source,receiver };
      const payments = await tx.get(
        `SELECT COALESCE(sum(pcd.amount_paid),0)::float AS paid,count(*)::int AS partialities
         FROM {s}.payment_complement_documents pcd JOIN {s}.payment_complements pc ON pc.id=pcd.payment_complement_id
         WHERE pcd.source_type=$1 AND pcd.source_id=$2 AND pcd.active=1 AND pc.status IN ('pending','unknown','active','cancel_pending')`, [type,id]
      );
      const credits = await tx.get(
        `SELECT COALESCE(sum(total),0)::float AS credited FROM {s}.direct_invoices
         WHERE document_kind='credit_note' AND source_document_type=$1 AND source_document_id=$2 AND status IN ('pending','unknown','active','cancel_pending')`, [type,id]
      );
      const previousBalance = roundCurrency(Number(source.total) - Number(payments?.paid || 0) - Number(credits?.credited || 0));
      const amountPaid = roundCurrency(requested.amount);
      if (!(amountPaid > 0) || amountPaid > previousBalance) throw Object.assign(new Error(`El pago excede el saldo pendiente de ${source.uuid} (${previousBalance.toFixed(2)})`), { status: 409 });
      const snapshot = parseJson(decrypt(source.fiscal_snapshot_enc),{});
      const tax = proportionalPaymentTaxes(snapshot,amountPaid,Number(source.total));
      prepared.push({ type,id,source,amountPaid,previousBalance,outstandingBalance:roundCurrency(previousBalance-amountPaid),partialityNumber:Number(payments?.partialities || 0)+1,...tax });
    }
    const profile = await getEmitter(tx, common.source.fiscal_emitter_id);
    profile.environment = normalizeEnvironment(common.source.environment);
    const readinessError = profileReadinessError(profile);
    if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });
    let expeditionPlace = resolveExpeditionPostalCode(profile);
    let series = profile.series;
    if (profile.api_mode === 'web') {
      const context = await facturamaFor(profile).ensureWebIssuanceContext(expeditionPlace,profile.series);
      expeditionPlace=context.postalCode; series=context.series;
    }
    const emitter = await tx.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 FOR UPDATE',[profile.id]);
    const folio = String(emitter.next_folio || 1);
    await tx.run('UPDATE {s}.fiscal_emitters SET next_folio=next_folio+1,updated_at=now() WHERE id=$1',[emitter.id]);
    const totalAmount = roundCurrency(prepared.reduce((sum,item)=>sum+item.amountPaid,0));
    const receiver = { ...common.receiver,cfdiUse:'CP01' };
    const snapshot = { issuer:{rfc:profile.rfc,legalName:profile.legal_name,fiscalRegime:profile.fiscal_regime,postalCode:expeditionPlace},receiver,paymentDate:paymentDate.toISOString(),paymentForm,operationNumber,documents:prepared,totalAmount };
    const row = await tx.get(
      `INSERT INTO {s}.payment_complements(request_key,environment,api_mode,series,folio,status,payment_date,payment_form,amount,
       receiver_data_enc,fiscal_snapshot_enc,issued_by,fiscal_emitter_id,issuer_rfc)
       VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [createRequestKey(),profile.environment,profile.api_mode,series,folio,paymentDate.toISOString(),paymentForm,totalAmount,
        encrypt(JSON.stringify(receiver)),encrypt(JSON.stringify(snapshot)),actor,emitter.id,profile.rfc]
    );
    for (const item of prepared) {
      await tx.run(
        `INSERT INTO {s}.payment_complement_documents(payment_complement_id,source_type,source_id,source_uuid,partiality_number,
         previous_balance,amount_paid,outstanding_balance,tax_object,taxes_enc)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.id,item.type,item.id,item.source.uuid,item.partialityNumber,item.previousBalance,item.amountPaid,item.outstandingBalance,item.taxObject,encrypt(JSON.stringify(item.taxes))]
      );
    }
    await reserveStamp(tx,'payment',row.id,emitter.id,actor);
    return { row,profile,prepared,receiver,expeditionPlace,series,totalAmount };
  });
  const relatedDocuments = allocated.prepared.map((item) => ({
    TaxObject:item.taxObject,Uuid:item.source.uuid,Serie:item.source.series || undefined,Folio:item.source.folio || undefined,Currency:'MXN',
    PaymentMethod:'PPD',PartialityNumber:item.partialityNumber,PreviousBalanceAmount:item.previousBalance,AmountPaid:item.amountPaid,
    ImpSaldoInsoluto:item.outstandingBalance,...(item.taxes.length ? { Taxes:item.taxes } : {}),
  }));
  const payment = { Date:paymentDate.toISOString(),PaymentForm:paymentForm,Currency:'MXN',Amount:allocated.totalAmount,RelatedDocuments:relatedDocuments };
  if (operationNumber) payment.OperationNumber = operationNumber;
  const payload = { NameId:14,CfdiType:'P',ExpeditionPlace:allocated.expeditionPlace,Serie:allocated.series,Folio:allocated.row.folio,
    Receiver:{Rfc:allocated.receiver.rfc,Name:allocated.receiver.name,FiscalRegime:allocated.receiver.fiscalRegime,TaxZipCode:allocated.receiver.postalCode,CfdiUse:'CP01'},
    Complemento:{Payments:[payment]},Observations:'Recibo electrónico de pago 2.0' };
  if (allocated.profile.api_mode !== 'web') payload.Issuer = { Rfc:allocated.profile.rfc,Name:allocated.profile.legal_name,FiscalRegime:allocated.profile.fiscal_regime };
  const updated = await stampStandardDocument({ tenantDb,table:'payment_complements',stampType:'payment',row:allocated.row,profile:allocated.profile,payload,actor });
  return { invoice: cfdiDocumentSummary({ ...updated,document_type:'payment',total:updated.amount }) };
}

async function issueCreditNote({ tenant, tenantDb, input = {}, actor = '' }) {
  const sourceType = ['individual','global','direct'].includes(String(input.sourceType || '')) ? String(input.sourceType) : '';
  const sourceId = Number(input.sourceId || 0);
  const source = sourceType && sourceId > 0 ? await loadSourceDocument(tenantDb,sourceType,sourceId) : null;
  if (!source || source.status !== 'active' || !source.uuid) throw Object.assign(new Error('Selecciona una factura vigente para relacionar la nota de crédito'), { status: 409 });
  const total = roundCurrency(input.total);
  if (!(total > 0) || total > Number(source.total)) throw Object.assign(new Error('El importe de la nota debe ser mayor a cero y no exceder el total de la factura'), { status: 400 });
  const description = String(input.description || 'Devolución, descuento o bonificación').trim().replace(/\s+/g,' ').slice(0,1000);
  const paymentForm = String(input.paymentForm || source.payment_form || '01').trim();
  if (!PAYMENT_FORMS.has(paymentForm) || paymentForm === '99') throw Object.assign(new Error('Selecciona una forma de pago válida para la nota de crédito'), { status: 400 });
  const profile = await getEmitter(tenantDb,source.fiscal_emitter_id);
  profile.environment = normalizeEnvironment(source.environment || tenantEnvironment(tenant));
  const facturama = facturamaFor(profile);
  const readinessError = profileReadinessError(profile);
  if (readinessError) throw Object.assign(new Error(readinessError), { status: 409 });
  let expeditionPlace=resolveExpeditionPostalCode(profile),series=profile.series;
  if (profile.api_mode === 'web') { const context=await facturama.ensureWebIssuanceContext(expeditionPlace,profile.series); expeditionPlace=context.postalCode;series=context.series; }
  const originalReceiver=parseJson(decrypt(source.receiver_data_enc),{});
  const receiver=validateReceiver({ ...originalReceiver,cfdiUse:'G02' },{expeditionPostalCode:expeditionPlace});
  const items=buildFacturamaItems({items:[{name:description,qty:1,price:total}],total,delivery_fee:0},new Map(),profile,{conceptMode:'detailed'});
  const allocated=await tenantDb.tx(async(tx)=>{
    const emitter=await tx.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 FOR UPDATE',[profile.id]);
    const priorCredits=await tx.get(
      `SELECT COALESCE(sum(total),0)::float AS total FROM {s}.direct_invoices
       WHERE document_kind='credit_note' AND source_document_type=$1 AND source_document_id=$2
         AND status IN ('pending','unknown','active','cancel_pending')`,[sourceType,sourceId]
    );
    const creditAvailable=roundCurrency(Number(source.total)-Number(priorCredits?.total||0));
    if(total>creditAvailable)throw Object.assign(new Error(`El importe excede el saldo disponible para notas de crédito (${creditAvailable.toFixed(2)})`),{status:409});
    const folio=String(emitter.next_folio||1);await tx.run('UPDATE {s}.fiscal_emitters SET next_folio=next_folio+1,updated_at=now() WHERE id=$1',[emitter.id]);
    const snapshot={issuer:{rfc:profile.rfc,legalName:profile.legal_name,fiscalRegime:profile.fiscal_regime,postalCode:expeditionPlace},receiver,sourceType,sourceId,sourceUuid:source.uuid,description,total,paymentForm,items};
    const row=await tx.get(
      `INSERT INTO {s}.direct_invoices(external_reference,sale_date,description,total,payment_form,payment_method,document_kind,request_key,environment,api_mode,series,folio,status,
       receiver_data_enc,fiscal_snapshot_enc,issued_by,fiscal_emitter_id,issuer_rfc,relation_type,related_uuids_enc,source_document_type,source_document_id)
       VALUES($1,CURRENT_DATE,$2,$3,$4,'PUE','credit_note',$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,'01',$15,$16,$17) RETURNING *`,
      [`NC-${source.uuid.slice(0,8)}`,description,total,paymentForm,createRequestKey(),profile.environment,profile.api_mode,series,folio,encrypt(JSON.stringify(receiver)),
        encrypt(JSON.stringify(snapshot)),actor,emitter.id,profile.rfc,encrypt(JSON.stringify([source.uuid])),sourceType,sourceId]
    );await reserveStamp(tx,'credit_note',row.id,emitter.id,actor);return row;
  });
  const payload={NameId:2,CfdiType:'E',Currency:'MXN',Exportation:'01',ExpeditionPlace:expeditionPlace,PaymentForm:paymentForm,PaymentMethod:'PUE',Serie:series,Folio:allocated.folio,
    Receiver:{Rfc:receiver.rfc,Name:receiver.name,FiscalRegime:receiver.fiscalRegime,TaxZipCode:receiver.postalCode,CfdiUse:'G02'},Relations:{Type:'01',Cfdis:[{Uuid:source.uuid}]},Items:items,Observations:`Nota de crédito relacionada con ${source.uuid}`};
  if(profile.api_mode!=='web')payload.Issuer={Rfc:profile.rfc,Name:profile.legal_name,FiscalRegime:profile.fiscal_regime};
  const updated=await stampStandardDocument({tenantDb,table:'direct_invoices',stampType:'credit_note',row:allocated,profile,payload,actor});
  return {invoice:cfdiDocumentSummary({...updated,document_type:'credit_note'})};
}

// Portal público de autofacturación
router.get('/public/:slug', publicLimiter, async (req, res, next) => {
  try {
    const tenant = await findPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Portal de facturación no disponible' });
    const tenantDb = tdb(tenant.slug);
    const [profile, emitters, settingsRows, branches] = await Promise.all([
      getProfile(tenantDb),
      tenantDb.all('SELECT * FROM {s}.fiscal_emitters WHERE enabled=1 ORDER BY id'),
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
    const environment = tenantEnvironment(tenant);
    if (profile) profile.environment = environment;
    emitters.forEach((emitter) => { emitter.environment = environment; });
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
      available: emitters.some((emitter) => profileReady(safeProfile(emitter))) || profileReady(profile),
      unavailableReason: emitters.length ? 'Ningún emisor fiscal está listo para timbrar' : profileReadinessError(profile),
      environment,
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
      `SELECT id, items, total::float AS total, status, payment_status, invoice_token, invoice_code, service_branch_id,payment_method,payment_breakdown,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM {s}.orders WHERE id=$1 AND channel='pos' LIMIT 1`,
      [ticket]
    );
    if (!sale || !invoiceAccessMatches(sale, token)) return res.status(404).json({ error: 'No encontramos el ticket con ese código de facturación' });
    if (sale.status === 'cancelado') return res.status(409).json({ error: 'El ticket está cancelado' });
    if (sale.payment_status === 'pending') return res.status(409).json({ error: 'La venta a crédito debe liquidarse antes de facturar' });
    const [invoice, globalInvoice, branch] = await Promise.all([
      tenantDb.get('SELECT * FROM {s}.invoices WHERE order_id=$1 ORDER BY id DESC LIMIT 1', [ticket]),
      tenantDb.get(
        `SELECT gi.id,gi.uuid,gi.status,gi.series,gi.folio
         FROM {s}.global_invoice_orders gio JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id
         WHERE gio.order_id=$1 AND gio.active=1 AND gi.status IN ('pending','unknown','active') LIMIT 1`,
        [ticket]
      ),
      sale.service_branch_id
        ? tenantDb.get('SELECT fiscal_postal_code,fiscal_emitter_id FROM {s}.branches WHERE id=$1 LIMIT 1', [sale.service_branch_id])
        : null,
    ]);
    const profile = await getEmitter(tenantDb, branch?.fiscal_emitter_id, sale.service_branch_id);
    profile.environment = tenantEnvironment(tenant);
    const facturama = facturamaFor(profile);
    let expeditionPostalCode = resolveExpeditionPostalCode(profile, branch?.fiscal_postal_code);
    if (profile?.api_mode === 'web') {
      try { expeditionPostalCode = await facturama.webExpeditionPostalCode(expeditionPostalCode); } catch {}
    }
    res.json({
      ticket: {
        id: sale.id, items: parseJson(sale.items, []).map((item) => ({ name: item.name, qty: item.qty, price: item.price })),
        total: sale.total, createdAt: sale.created_at, expeditionPostalCode,
        paymentMethod: sale.payment_method || '', paymentBreakdown: parseJson(sale.payment_breakdown, {}),
        paymentForm: paymentFormFromSale(sale, profile.default_card_payment_form),
      },
      issuer: profileCompleteness(profile) ? { legalName: profile.legal_name, rfc: profile.rfc, postalCode: profile.postal_code } : null,
      invoice: globalInvoice ? {
        id: Number(globalInvoice.id), uuid: globalInvoice.uuid || '', series: globalInvoice.series || '', folio: globalInvoice.folio || '',
        status: globalInvoice.status === 'active' ? 'global_active' : 'global_pending', total: Number(sale.total || 0),
      } : (invoice ? invoiceSummary({ ...invoice, order_total: sale.total }, false) : null),
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
      conceptMode: req.body?.conceptMode,
      actor: 'autofacturación',
      publicToken: token,
    });
    res.json({ ok: true, ...result, token });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, uncertain: Boolean(error.uncertain) });
    next(error);
  }
});

router.post('/public/:slug/invoices/:id/email', publicLimiter, async (req, res, next) => {
  try {
    const tenant = await findPublicTenant(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Portal de facturación no disponible' });
    const result = await sendInvoiceEmail({
      tenant,
      tenantDb: tdb(tenant.slug),
      invoiceId: Number(req.params.id),
      emailInput: req.body?.email,
      actor: 'autofacturación',
      publicToken: String(req.body?.code || req.body?.token || '').trim(),
    });
    res.json({ ok: true, message: 'Factura enviada por correo mediante Facturama', ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
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
router.use(requireModules('facturacion', 'cfdi', 'pos'));
router.use(requireMexico);

router.get('/bootstrap', async (req, res, next) => {
  try {
    const [profile, emitters, branches, invoices, wallet, stampMovements] = await Promise.all([
      getProfile(req.tdb),
      req.tdb.all('SELECT * FROM {s}.fiscal_emitters ORDER BY id'),
      req.tdb.all('SELECT id,name,address,fiscal_postal_code,fiscal_emitter_id,active FROM {s}.branches ORDER BY active DESC,name'),
      req.tdb.all(`SELECT i.*, o.total::float AS order_total FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id ORDER BY i.id DESC LIMIT 50`),
      req.tdb.get('SELECT * FROM {s}.stamp_wallet WHERE id=1'),
      req.tdb.all('SELECT * FROM {s}.stamp_ledger ORDER BY id DESC LIMIT 20'),
    ]);
    if (profile) profile.environment = tenantEnvironment(req.tenant);
    const facturama = facturamaFor(profile?.environment || tenantEnvironment(req.tenant));
    let expeditionPostalCode = profile?.postal_code || '';
    if (profile?.api_mode === 'web' && facturama.isConfigured()) {
      try { expeditionPostalCode = await facturama.webExpeditionPostalCode(expeditionPostalCode); } catch {}
    }
    res.json({
      eligible: true,
      provider: { name: 'Facturama', configured: facturama.isConfigured(), environment: profile?.environment || tenantEnvironment(req.tenant), expeditionPostalCode },
      profile,
      emitters: emitters.map(safeProfile),
      ready: profileReady(profile),
      sandboxSharedAvailable: tenantEnvironment(req.tenant) === 'sandbox' && config.FACTURAMA_SANDBOX_SHARED_ISSUER,
      sandboxDefaults: sandboxIssuerDefaults(),
      portalUrl: invoicingPortalUrl(req, config.INVOICING_PORTAL_ORIGIN, req.tenant.slug),
      branches,
      invoices: invoices.map((row) => invoiceSummary(row)),
      stampWallet: wallet ? { unlimited: Boolean(Number(wallet.unlimited)), balance: Number(wallet.balance), reserved: Number(wallet.reserved), available: Boolean(Number(wallet.unlimited)) ? null : Math.max(0, Number(wallet.balance)-Number(wallet.reserved)), lowBalanceThreshold: Number(wallet.low_balance_threshold || 20) } : null,
      stampMovements,
    });
  } catch (error) { next(error); }
});

router.get('/documents', async (req, res, next) => {
  try {
    const type = ['individual','global','direct','manual_global','credit_note','payment'].includes(String(req.query.type || '')) ? String(req.query.type) : 'all';
    const status = ['active', 'cancel_pending', 'canceled', 'failed', 'unknown', 'pending'].includes(String(req.query.status || '')) ? String(req.query.status) : 'all';
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = [10, 20, 50].includes(Number(req.query.limit)) ? Number(req.query.limit) : 10;
    const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateFrom || '')) ? String(req.query.dateFrom) : '';
    const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dateTo || '')) ? String(req.query.dateTo) : '';
    const search = String(req.query.search || '').trim().slice(0, 80);
    const params = [];
    const where = [];
    const bind = (value) => { params.push(value); return `$${params.length}`; };
    if (type !== 'all') where.push(`document_type=${bind(type)}`);
    if (status !== 'all') where.push(`status=${bind(status)}`);
    if (dateFrom) where.push(`COALESCE(issued_at,created_at) >= ${bind(dateFrom)}::date`);
    if (dateTo) where.push(`COALESCE(issued_at,created_at) < (${bind(dateTo)}::date + interval '1 day')`);
    if (search) {
      const term = `%${search}%`;
      where.push(`(COALESCE(uuid,'') ILIKE ${bind(term)} OR COALESCE(series,'') ILIKE ${bind(term)} OR COALESCE(folio,'') ILIKE ${bind(term)} OR COALESCE(issuer_rfc,'') ILIKE ${bind(term)} OR COALESCE(order_id::text,'') ILIKE ${bind(term)})`);
    }
    params.push(limit, (page - 1) * limit);
    const rows = await req.tdb.all(
      `WITH documents AS (
         SELECT 'individual'::text AS document_type,i.id,i.order_id,i.provider_id,i.uuid,i.series,i.folio,i.status,i.environment,i.api_mode,
           i.receiver_data_enc,o.total::float AS total,o.service_branch_id,1::int AS order_count,COALESCE(i.issuer_rfc,(SELECT rfc FROM {s}.fiscal_emitters WHERE id=1)) AS issuer_rfc,
           i.cancellation_motive,i.replacement_uuid,i.cancellation_status,i.cancellation_message,i.cancellation_receipt_enc,
           i.cancel_requested_at,i.canceled_at,i.issued_at,i.created_at,i.error_message,i.payment_method,i.payment_form,i.relation_type,
           NULL::text AS source_document_type,NULL::bigint AS source_document_id
         FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id
         UNION ALL
         SELECT 'global'::text,gi.id,NULL::integer,gi.provider_id,gi.uuid,gi.series,gi.folio,gi.status,gi.environment,gi.api_mode,
           gi.receiver_data_enc,gi.total::float,gi.service_branch_id,gi.order_count,COALESCE(gi.issuer_rfc,(SELECT rfc FROM {s}.fiscal_emitters WHERE id=1)),
           gi.cancellation_motive,gi.replacement_uuid,gi.cancellation_status,gi.cancellation_message,gi.cancellation_receipt_enc,
           gi.cancel_requested_at,gi.canceled_at,gi.issued_at,gi.created_at,gi.error_message,gi.payment_method,gi.payment_form,gi.relation_type,
           NULL::text,NULL::bigint
         FROM {s}.global_invoices gi
         UNION ALL
         SELECT CASE WHEN di.document_kind IN ('manual_global','credit_note') THEN di.document_kind ELSE 'direct' END,di.id,NULL::integer,di.provider_id,di.uuid,di.series,di.folio,di.status,di.environment,di.api_mode,
           di.receiver_data_enc,di.total::float,NULL::integer,1::int,COALESCE(di.issuer_rfc,(SELECT rfc FROM {s}.fiscal_emitters WHERE id=1)),
           di.cancellation_motive,di.replacement_uuid,di.cancellation_status,di.cancellation_message,di.cancellation_receipt_enc,
           di.cancel_requested_at,di.canceled_at,di.issued_at,di.created_at,di.error_message,di.payment_method,di.payment_form,di.relation_type,
           di.source_document_type,di.source_document_id
         FROM {s}.direct_invoices di
         UNION ALL
         SELECT 'payment'::text,pc.id,NULL::integer,pc.provider_id,pc.uuid,pc.series,pc.folio,pc.status,pc.environment,pc.api_mode,
           pc.receiver_data_enc,pc.amount::float,NULL::integer,1::int,COALESCE(pc.issuer_rfc,(SELECT rfc FROM {s}.fiscal_emitters WHERE id=1)),
           pc.cancellation_motive,pc.replacement_uuid,pc.cancellation_status,pc.cancellation_message,pc.cancellation_receipt_enc,
           pc.cancel_requested_at,pc.canceled_at,pc.issued_at,pc.created_at,pc.error_message,NULL::text,pc.payment_form,NULL::text,
           NULL::text,NULL::bigint
         FROM {s}.payment_complements pc
       )
       SELECT *,count(*) OVER()::int AS total_rows FROM documents
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(issued_at,created_at) DESC,id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const total = Number(rows[0]?.total_rows || 0);
    res.json({ rows: rows.map(cfdiDocumentSummary), pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) { next(error); }
});

router.put('/profile', requireOwner, async (req, res, next) => {
  try {
    const environment = tenantEnvironment(req.tenant);
    const useSandboxShared = environment === 'sandbox'
      && config.FACTURAMA_SANDBOX_SHARED_ISSUER
      && req.tenant?.slug === config.DEMO_TENANT_SLUG
      && req.body?.sandboxShared !== false;
    const sandboxDefaults = sandboxIssuerDefaults();
    const source = useSandboxShared ? {
      ...req.body,
      rfc: sandboxDefaults.rfc,
      legalName: sandboxDefaults.legalName,
      fiscalRegime: sandboxDefaults.fiscalRegime,
      postalCode: sandboxDefaults.postalCode,
      series: sandboxDefaults.series,
    } : req.body;
    const profile = validateFiscalProfile(source);
    const enabled = req.body?.enabled === false ? 0 : 1;
    const apiMode = issuerApiMode(environment, profile.rfc, useSandboxShared);
    const row = await req.tdb.get(
      `INSERT INTO {s}.fiscal_profiles
       (id,enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,
        default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,default_isr_rate,
        delivery_product_code,prices_include_tax,default_card_payment_form,updated_at)
       VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17,now())
       ON CONFLICT (id) DO UPDATE SET enabled=EXCLUDED.enabled,environment=EXCLUDED.environment,api_mode=EXCLUDED.api_mode,
        sandbox_shared=EXCLUDED.sandbox_shared,rfc=EXCLUDED.rfc,legal_name=EXCLUDED.legal_name,
        fiscal_regime=EXCLUDED.fiscal_regime,postal_code=EXCLUDED.postal_code,series=EXCLUDED.series,
        default_product_code=EXCLUDED.default_product_code,default_unit_code=EXCLUDED.default_unit_code,
        default_unit_name=EXCLUDED.default_unit_name,default_tax_object=EXCLUDED.default_tax_object,
        default_iva_rate=EXCLUDED.default_iva_rate,default_isr_rate=EXCLUDED.default_isr_rate,
        delivery_product_code=EXCLUDED.delivery_product_code,
        prices_include_tax=1,default_card_payment_form=EXCLUDED.default_card_payment_form,
        csd_uploaded=CASE WHEN fiscal_profiles.rfc=EXCLUDED.rfc THEN fiscal_profiles.csd_uploaded ELSE 0 END,
        updated_at=now()
       RETURNING *`,
      [enabled, environment, apiMode, useSandboxShared ? 1 : 0, profile.rfc, profile.legalName,
        profile.fiscalRegime, profile.postalCode, profile.series, profile.defaultProductCode, profile.defaultUnitCode,
        profile.defaultUnitName, profile.defaultTaxObject, profile.defaultIvaRate, profile.defaultIsrRate,
        String(req.body?.deliveryProductCode || profile.defaultProductCode).trim(), profile.defaultCardPaymentForm]
    );
    await req.tdb.run(
      `INSERT INTO {s}.fiscal_emitters
       (id,label,enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,next_folio,
        default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,default_isr_rate,
        delivery_product_code,prices_include_tax,default_card_payment_form,csd_uploaded,csd_updated_at,updated_at)
       SELECT 1,'Emisor principal',enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,next_folio,
        default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,default_isr_rate,
        delivery_product_code,prices_include_tax,default_card_payment_form,csd_uploaded,csd_updated_at,now()
       FROM {s}.fiscal_profiles WHERE id=1
       ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,environment=EXCLUDED.environment,api_mode=EXCLUDED.api_mode,
        sandbox_shared=EXCLUDED.sandbox_shared,rfc=EXCLUDED.rfc,legal_name=EXCLUDED.legal_name,fiscal_regime=EXCLUDED.fiscal_regime,
        postal_code=EXCLUDED.postal_code,series=EXCLUDED.series,default_product_code=EXCLUDED.default_product_code,
        default_unit_code=EXCLUDED.default_unit_code,default_unit_name=EXCLUDED.default_unit_name,default_tax_object=EXCLUDED.default_tax_object,
        default_iva_rate=EXCLUDED.default_iva_rate,default_isr_rate=EXCLUDED.default_isr_rate,delivery_product_code=EXCLUDED.delivery_product_code,
        default_card_payment_form=EXCLUDED.default_card_payment_form,
        csd_uploaded=CASE WHEN fiscal_emitters.rfc=EXCLUDED.rfc THEN fiscal_emitters.csd_uploaded ELSE 0 END,updated_at=now()`
    );
    await req.tdb.run('UPDATE {s}.branches SET fiscal_emitter_id=1 WHERE fiscal_emitter_id IS NULL');
    await ensureTenantCourtesyStamps(req.tenant.slug, req.tenant.id, req.user?.username || 'tenant:emitter');
    res.json({ ok: true, profile: safeProfile(row), ready: profileReady(safeProfile(row)) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.post('/emitters', requireOwner, async (req, res, next) => {
  try {
    const environment = tenantEnvironment(req.tenant);
    const profile = validateFiscalProfile(req.body || {});
    const label = String(req.body?.label || profile.legalName).trim().slice(0, 80);
    const row = await req.tdb.get(
      `INSERT INTO {s}.fiscal_emitters
       (label,enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,
        default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,default_isr_rate,
        delivery_product_code,prices_include_tax,default_card_payment_form)
       VALUES($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,1,$17) RETURNING *`,
      [label, req.body?.enabled === false ? 0 : 1, environment, issuerApiMode(environment, profile.rfc), profile.rfc, profile.legalName,
        profile.fiscalRegime, profile.postalCode, profile.series, profile.defaultProductCode, profile.defaultUnitCode,
        profile.defaultUnitName, profile.defaultTaxObject, profile.defaultIvaRate, profile.defaultIsrRate,
        String(req.body?.deliveryProductCode || profile.defaultProductCode).trim(), profile.defaultCardPaymentForm]
    );
    await ensureTenantCourtesyStamps(req.tenant.slug, req.tenant.id, req.user?.username || 'tenant:emitter');
    res.status(201).json({ ok: true, emitter: safeProfile(row) });
  } catch (error) {
    if (String(error?.message || '').includes('fiscal_emitters_rfc')) return res.status(409).json({ error: 'Ese RFC ya está registrado como emisor' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.put('/emitters/:id', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === 1) return res.status(409).json({ error: 'Edita el emisor principal desde Datos fiscales del emisor' });
    const profile = validateFiscalProfile(req.body || {});
    const current = await req.tdb.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1', [id]);
    if (!current) return res.status(404).json({ error: 'Emisor no encontrado' });
    if (Number(current.csd_uploaded) && current.rfc === profile.rfc && current.legal_name !== profile.legalName) {
      return res.status(409).json({ error: `El nombre fiscal debe permanecer como ${current.legal_name}, que es el identificado al cargar el CSD. Si cambió el RFC, carga primero sus sellos correctos.` });
    }
    const row = await req.tdb.get(
      `UPDATE {s}.fiscal_emitters SET label=$1,enabled=$2,rfc=$3,legal_name=$4,fiscal_regime=$5,postal_code=$6,series=$7,
       default_product_code=$8,default_unit_code=$9,default_unit_name=$10,default_tax_object=$11,default_iva_rate=$12,
       default_isr_rate=$13,delivery_product_code=$14,default_card_payment_form=$15,
       api_mode=$16,csd_uploaded=CASE WHEN rfc=$3 THEN csd_uploaded ELSE 0 END,updated_at=now() WHERE id=$17 RETURNING *`,
      [String(req.body?.label || profile.legalName).trim().slice(0,80), req.body?.enabled === false ? 0 : 1, profile.rfc,
        profile.legalName, profile.fiscalRegime, profile.postalCode, profile.series, profile.defaultProductCode,
        profile.defaultUnitCode, profile.defaultUnitName, profile.defaultTaxObject, profile.defaultIvaRate,
        profile.defaultIsrRate, String(req.body?.deliveryProductCode || profile.defaultProductCode).trim(),
        profile.defaultCardPaymentForm, issuerApiMode(tenantEnvironment(req.tenant), profile.rfc), id]
    );
    res.json({ ok: true, emitter: safeProfile(row) });
  } catch (error) {
    if (String(error?.message || '').includes('fiscal_emitters_rfc')) return res.status(409).json({ error: 'Ese RFC ya está registrado como emisor' });
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.delete('/emitters/:id', requireOwner, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === 1) return res.status(409).json({ error: 'El emisor principal no se puede eliminar' });
    const used = await req.tdb.get(
      `SELECT (SELECT count(*) FROM {s}.branches WHERE fiscal_emitter_id=$1)::int AS branches,
              ((SELECT count(*) FROM {s}.invoices WHERE fiscal_emitter_id=$1)+(SELECT count(*) FROM {s}.global_invoices WHERE fiscal_emitter_id=$1))::int AS invoices`, [id]
    );
    if (Number(used?.branches) || Number(used?.invoices)) return res.status(409).json({ error: 'No puedes eliminar un emisor asignado a sucursales o con CFDI emitidos' });
    const result = await req.tdb.run('DELETE FROM {s}.fiscal_emitters WHERE id=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Emisor no encontrado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/csd', requireOwner, csdUpload.fields([{ name: 'certificate', maxCount: 1 }, { name: 'privateKey', maxCount: 1 }]), async (req, res, next) => {
  try {
    const emitterId = Number(req.body?.emitterId || 1);
    const profile = safeProfile(await req.tdb.get('SELECT * FROM {s}.fiscal_emitters WHERE id=$1 LIMIT 1', [emitterId]));
    if (!profile || profile.sandbox_shared) return res.status(409).json({ error: 'Guarda primero los datos fiscales del emisor multi-RFC' });
    if (profile.api_mode === 'web') return res.status(409).json({ error: 'El RFC principal usa API Web; sus CSD se administran directamente en el perfil de Facturama' });
    const certificate = req.files?.certificate?.[0];
    const privateKey = req.files?.privateKey?.[0];
    const password = String(req.body?.privateKeyPassword || '');
    if (!certificate || !privateKey || !password) return res.status(400).json({ error: 'Carga .cer, .key y la contraseña de la llave privada' });
    const certificateIdentity = csdCertificateIdentity(certificate.buffer);
    if (certificateIdentity.rfc !== profile.rfc) {
      return res.status(422).json({ error: `El CSD pertenece al RFC ${certificateIdentity.rfc}, pero el emisor está registrado como ${profile.rfc}. Corrige el RFC o carga los archivos correspondientes.` });
    }
    validateCsdPrivateKey(certificate.buffer, privateKey.buffer, password);
    profile.environment = tenantEnvironment(req.tenant);
    await facturamaFor(profile).uploadCsd({
      rfc: profile.rfc,
      certificate: certificate.buffer.toString('base64'),
      privateKey: privateKey.buffer.toString('base64'),
      privateKeyPassword: password,
    });
    await req.tdb.run('UPDATE {s}.fiscal_emitters SET legal_name=$1,csd_uploaded=1,csd_updated_at=now(),updated_at=now() WHERE id=$2', [certificateIdentity.legalName, emitterId]);
    if (emitterId === 1) await req.tdb.run('UPDATE {s}.fiscal_profiles SET legal_name=$1,csd_uploaded=1,csd_updated_at=now(),updated_at=now() WHERE id=1', [certificateIdentity.legalName]);
    res.json({ ok: true, rfc: certificateIdentity.rfc, legalName: certificateIdentity.legalName, validTo: certificateIdentity.validTo });
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
    const emitterId = Number(req.body?.emitterId || 0);
    if (!emitterId || !(await req.tdb.get('SELECT id FROM {s}.fiscal_emitters WHERE id=$1 AND enabled=1', [emitterId]))) return res.status(400).json({ error: 'Selecciona un emisor fiscal activo' });
    const result = await req.tdb.run('UPDATE {s}.branches SET fiscal_postal_code=$1,fiscal_emitter_id=$2 WHERE id=$3', [postalCode, emitterId, req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/sales/:id/issue', requireInvoicingActivated, async (req, res, next) => {
  try {
    const result = await issueSaleInvoice({
      tenant: req.tenant,
      tenantDb: req.tdb,
      orderId: Number(req.params.id),
      receiverInput: req.body?.receiver,
      requestedPaymentForm: req.body?.paymentForm,
      requestedPaymentMethod: req.body?.paymentMethod,
      relationInput: req.body || {},
      actor: req.user.username,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, uncertain: Boolean(error.uncertain) });
    next(error);
  }
});

router.post('/direct-invoices', requireOwner, requireInvoicingActivated, async (req, res, next) => {
  try {
    const result = await issueDirectInvoice({ tenant: req.tenant, tenantDb: req.tdb, input: req.body || {}, actor: req.user.username });
    res.json({ ok: true, message: result.reused ? 'La venta ya tenía un CFDI registrado; se devolvió el comprobante existente' : 'Factura timbrada correctamente', ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, uncertain: Boolean(error.uncertain) });
    next(error);
  }
});

router.post('/manual-global-invoices', requireOwner, requireInvoicingActivated, async (req, res, next) => {
  try {
    const result = await issueManualGlobalInvoice({ tenant:req.tenant,tenantDb:req.tdb,input:req.body || {},actor:req.user.username });
    res.json({ ok:true,message:result.reused?'La referencia global ya tenía un CFDI registrado':'Factura global a público en general timbrada correctamente',...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error:error.message,uncertain:Boolean(error.uncertain) });
    next(error);
  }
});

router.post('/payment-complements', requireOwner, requireInvoicingActivated, async (req, res, next) => {
  try {
    const result = await issuePaymentComplement({ tenant:req.tenant,tenantDb:req.tdb,input:req.body || {},actor:req.user.username });
    res.json({ ok:true,message:'Complemento de pago 2.0 timbrado correctamente',...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error:error.message,uncertain:Boolean(error.uncertain) });
    next(error);
  }
});

router.post('/credit-notes', requireOwner, requireInvoicingActivated, async (req, res, next) => {
  try {
    const result = await issueCreditNote({ tenant:req.tenant,tenantDb:req.tdb,input:req.body || {},actor:req.user.username });
    res.json({ ok:true,message:'Nota de crédito timbrada correctamente',...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error:error.message,uncertain:Boolean(error.uncertain) });
    next(error);
  }
});

router.get('/receivables', requireOwner, async (req, res, next) => {
  try {
    const candidates = await req.tdb.all(
      `SELECT 'individual'::text AS type,i.id,i.uuid,i.series,i.folio,o.total::float AS total,i.receiver_data_enc,i.issued_at,i.fiscal_emitter_id
       FROM {s}.invoices i JOIN {s}.orders o ON o.id=i.order_id WHERE i.status='active' AND i.payment_method='PPD'
       UNION ALL
       SELECT 'global',gi.id,gi.uuid,gi.series,gi.folio,gi.total::float,gi.receiver_data_enc,gi.issued_at,gi.fiscal_emitter_id
       FROM {s}.global_invoices gi WHERE gi.status='active' AND gi.payment_method='PPD'
       UNION ALL
       SELECT 'direct',di.id,di.uuid,di.series,di.folio,di.total::float,di.receiver_data_enc,di.issued_at,di.fiscal_emitter_id
       FROM {s}.direct_invoices di WHERE di.status='active' AND di.payment_method='PPD' AND di.document_kind='invoice'
       ORDER BY issued_at DESC,id DESC LIMIT 200`
    );
    const rows=[];
    for(const row of candidates){
      const payments=await req.tdb.get(
        `SELECT COALESCE(sum(pcd.amount_paid),0)::float AS paid,count(*)::int AS partialities
         FROM {s}.payment_complement_documents pcd JOIN {s}.payment_complements pc ON pc.id=pcd.payment_complement_id
         WHERE pcd.source_type=$1 AND pcd.source_id=$2 AND pcd.active=1 AND pc.status IN ('pending','unknown','active','cancel_pending')`,[row.type,row.id]
      );
      const credits=await req.tdb.get(
        `SELECT COALESCE(sum(total),0)::float AS credited FROM {s}.direct_invoices
         WHERE document_kind='credit_note' AND source_document_type=$1 AND source_document_id=$2 AND status IN ('pending','unknown','active','cancel_pending')`,[row.type,row.id]
      );
      const balance=roundCurrency(Number(row.total)-Number(payments?.paid||0)-Number(credits?.credited||0));
      if(balance>0) rows.push({type:row.type,id:Number(row.id),uuid:row.uuid,series:row.series,folio:row.folio,total:Number(row.total),
        paid:roundCurrency(payments?.paid),credited:roundCurrency(credits?.credited),balance,partialities:Number(payments?.partialities||0),
        receiver:parseJson(decrypt(row.receiver_data_enc),{}),issuedAt:row.issued_at,emitterId:Number(row.fiscal_emitter_id||0)});
    }
    res.json({ rows });
  } catch(error){ next(error); }
});

router.get('/direct-invoices/:id/:format', async (req, res, next) => {
  try {
    const invoice = await req.tdb.get('SELECT * FROM {s}.direct_invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!invoice) return res.status(404).end();
    if (!['xml','pdf'].includes(req.params.format)) return res.status(400).json({ error: 'Formato no válido' });
    const format = req.params.format;
    let content = decrypt(format === 'xml' ? invoice.xml_enc : invoice.pdf_enc);
    if (!content && invoice.provider_id) {
      const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
      const result = await facturamaFor(invoice.environment || profile).downloadCfdi(invoice.provider_id, format, apiModeFor(invoice, profile));
      content = String(result?.Content || '');
      if (content) await req.tdb.run(`UPDATE {s}.direct_invoices SET ${format === 'xml' ? 'xml_enc' : 'pdf_enc'}=$1,updated_at=now() WHERE id=$2`, [encrypt(content),invoice.id]);
    }
    if (!content) return res.status(404).json({ error: 'El archivo todavía no está disponible' });
    res.type(format === 'xml' ? 'application/xml' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CFDI-${invoice.uuid || invoice.folio}.${format}"`);
    res.send(Buffer.from(content, 'base64'));
  } catch (error) { next(error); }
});

router.get('/payment-complements/:id/:format', async (req, res, next) => {
  try {
    const invoice=await req.tdb.get('SELECT * FROM {s}.payment_complements WHERE id=$1 LIMIT 1',[req.params.id]);
    if(!invoice)return res.status(404).end();
    if(!['xml','pdf'].includes(req.params.format))return res.status(400).json({error:'Formato no válido'});
    const format=req.params.format;
    let content=decrypt(format==='xml'?invoice.xml_enc:invoice.pdf_enc);
    if(!content&&invoice.provider_id){const profile=await getEmitter(req.tdb,invoice.fiscal_emitter_id);const result=await facturamaFor(invoice.environment||profile).downloadCfdi(invoice.provider_id,format,apiModeFor(invoice,profile));content=String(result?.Content||'');if(content)await req.tdb.run(`UPDATE {s}.payment_complements SET ${format==='xml'?'xml_enc':'pdf_enc'}=$1,updated_at=now() WHERE id=$2`,[encrypt(content),invoice.id]);}
    if(!content)return res.status(404).json({error:'El archivo todavía no está disponible'});
    res.type(format==='xml'?'application/xml':'application/pdf');res.setHeader('Content-Disposition',`attachment; filename="REP-${invoice.uuid||invoice.folio}.${format}"`);res.send(Buffer.from(content,'base64'));
  }catch(error){next(error);}
});

router.post('/documents/:type/:id/email', requireOwner, async (req,res,next)=>{
  try{
    const type=String(req.params.type||'');const found=await loadTypedDocument(req.tdb,type,Number(req.params.id));
    const invoice=found?.row;
    if(!invoice||!invoice.provider_id)return res.status(404).json({error:'CFDI no encontrado'});
    if(invoice.status!=='active')return res.status(409).json({error:'Sólo se pueden enviar CFDI timbrados y vigentes'});
    const email=validateInvoiceEmail(req.body?.email);const profile=await getEmitter(req.tdb,invoice.fiscal_emitter_id);
    await facturamaFor(invoice.environment||profile).sendCfdiEmail(invoice.provider_id,email,apiModeFor(invoice,profile),{subject:`CFDI ${invoice.series||''}-${invoice.folio||''} · ${req.tenant.business_name}`,comments:'Adjuntamos la representación PDF y el archivo XML de tu CFDI.'});
    await req.tdb.run(`INSERT INTO {s}.fiscal_document_events(document_type,document_id,event_type,detail,actor) VALUES($1,$2,'email_sent',$3,$4)`,[type,invoice.id,`Enviado a ${maskInvoiceEmail(email)}`,req.user.username]);
    res.json({ok:true,message:'CFDI enviado por correo mediante Facturama'});
  }catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}
});

router.post('/invoices/:id/email', async (req, res, next) => {
  try {
    const result = await sendInvoiceEmail({
      tenant: req.tenant,
      tenantDb: req.tdb,
      invoiceId: Number(req.params.id),
      emailInput: req.body?.email,
      actor: req.user.username,
    });
    res.json({ ok: true, message: 'Factura enviada por correo mediante Facturama', ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/global/eligible', async (req, res, next) => {
  try {
    const date = String(req.query.date || '').trim();
    const requestedBranchId = Number(req.query.branchId || 0);
    const cashierBranchId = req.user.role === 'cashier' ? Number(req.user.branchId || 0) : null;
    if (req.user.role === 'cashier' && !cashierBranchId) {
      return res.status(403).json({ error: 'Tu usuario de caja no tiene una sucursal asignada' });
    }
    const branchId = cashierBranchId || requestedBranchId;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Selecciona una fecha válida' });
    const timezone = String(req.tdb.timezone || 'America/Mexico_City').replace(/'/g, '');
    const params = [date];
    let branchClause = '';
    if (Number.isInteger(branchId) && branchId > 0) {
      params.push(branchId);
      branchClause = `AND o.service_branch_id=$${params.length}`;
    }
    const rows = await req.tdb.all(
      `SELECT o.id,o.total::float AS total,o.service_branch_id,o.service_branch_name,o.payment_method,
              to_char(o.created_at AT TIME ZONE '${timezone}', 'YYYY-MM-DD') AS business_date
       FROM {s}.orders o
      WHERE o.channel='pos' AND o.status!='cancelado' AND COALESCE(o.payment_status, 'paid')='paid'
         AND (o.created_at AT TIME ZONE '${timezone}')::date=$1::date ${branchClause}
         AND NOT EXISTS (
           SELECT 1 FROM {s}.invoices i WHERE i.order_id=o.id
             AND i.status IN ('pending','unknown','active','cancel_pending')
         )
         AND NOT EXISTS (
           SELECT 1 FROM {s}.global_invoice_orders gio
           JOIN {s}.global_invoices gi ON gi.id=gio.global_invoice_id
           WHERE gio.order_id=o.id AND gio.active=1 AND gi.status IN ('pending','unknown','active')
         )
       ORDER BY o.id`, params
    );
    res.json({
      date,
      rows,
      count: rows.length,
      total: Math.round(rows.reduce((sum, row) => sum + Number(row.total || 0), 0) * 100) / 100,
    });
  } catch (error) { next(error); }
});

router.post('/global/issue', requireInvoicingActivated, async (req, res, next) => {
  try {
    const result = await issueGlobalInvoice({
      tenant: req.tenant,
      tenantDb: req.tdb,
      orderIds: req.body?.orderIds,
      conceptMode: req.body?.conceptMode,
      actor: req.user.username,
      allowedBranchId: req.user.role === 'cashier' ? Number(req.user.branchId || 0) : null,
    });
    res.json({ ok: true, message: 'Factura global timbrada correctamente', ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message, uncertain: Boolean(error.uncertain) });
    next(error);
  }
});

router.get('/global-invoices/:id/:format', async (req, res, next) => {
  try {
    const invoice = await req.tdb.get('SELECT * FROM {s}.global_invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!invoice) return res.status(404).end();
    if (!['xml', 'pdf'].includes(req.params.format)) return res.status(400).json({ error: 'Formato no válido' });
    const format = req.params.format;
    let content = decrypt(format === 'xml' ? invoice.xml_enc : invoice.pdf_enc);
    if (!content && invoice.provider_id) {
      const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
      const facturama = facturamaFor(invoice.environment || profile);
      const result = await facturama.downloadCfdi(invoice.provider_id, format, apiModeFor(invoice, profile));
      content = String(result?.Content || '');
      if (content) await req.tdb.run(
        `UPDATE {s}.global_invoices SET ${format === 'xml' ? 'xml_enc' : 'pdf_enc'}=$1,updated_at=now() WHERE id=$2`,
        [encrypt(content), invoice.id]
      );
    }
    if (!content) return res.status(404).json({ error: 'El archivo todavía no está disponible' });
    res.type(format === 'xml' ? 'application/xml' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="CFDI-Global-${invoice.uuid || invoice.folio}.${format}"`);
    res.send(Buffer.from(content, 'base64'));
  } catch (error) { next(error); }
});

router.post('/documents/:type/:id/reconcile', requireOwner, async(req,res,next)=>{
  try{
    const type=String(req.params.type||'');const found=await loadTypedDocument(req.tdb,type,Number(req.params.id));
    if(!found)return res.status(404).json({error:'CFDI no encontrado'});
    const invoice=found.row;if(invoice.status!=='unknown')return res.status(409).json({error:'Sólo los CFDI con estado por verificar requieren conciliación'});
    const profile=await getEmitter(req.tdb,invoice.fiscal_emitter_id);const facturama=facturamaFor(invoice.environment||profile);
    let providerRecord=null;
    if(invoice.provider_id){try{providerRecord=await facturama.getCfdi(invoice.provider_id,apiModeFor(invoice,profile));}catch{}}
    if(!providerRecord){const listing=await facturama.listIssuedCfdis({folio:invoice.folio,series:invoice.series,rfcIssuer:invoice.issuer_rfc,apiMode:apiModeFor(invoice,profile)});providerRecord=findCfdiInProviderResponse(listing,invoice);}
    if(!providerRecord)return res.status(202).json({ok:true,found:false,message:'Facturama todavía no reporta un CFDI con ese folio. El timbre continúa reservado para evitar duplicados.'});
    const identity=extractFacturamaIdentity(providerRecord);if(!identity.providerId)return res.status(202).json({ok:true,found:false,message:'Se encontró una coincidencia sin identificador confirmado; vuelve a consultar más tarde.'});
    const files=await loadInvoiceFiles({provider_id:identity.providerId,environment:invoice.environment,api_mode:invoice.api_mode},profile);
    const updated=await req.tdb.get(`UPDATE {s}.${found.table} SET provider_id=$1,uuid=$2,certificate_number=$3,status='active',provider_response_enc=$4,
      xml_enc=COALESCE($5,xml_enc),pdf_enc=COALESCE($6,pdf_enc),issued_at=COALESCE(issued_at,now()),error_message='',updated_at=now() WHERE id=$7 RETURNING *`,
      [identity.providerId,identity.uuid||invoice.uuid||null,identity.certificateNumber||null,encrypt(JSON.stringify(providerRecord)),files.xml?encrypt(files.xml):null,files.pdf?encrypt(files.pdf):null,invoice.id]);
    await finalizeStamp(req.tdb,type,invoice.id,'consumed',profile.id,req.user.username);
    await req.tdb.run(`INSERT INTO {s}.fiscal_document_events(document_type,document_id,event_type,detail,actor) VALUES($1,$2,'reconciled',$3,$4)`,[type,invoice.id,identity.uuid||identity.providerId,req.user.username]);
    res.json({ok:true,found:true,document:cfdiDocumentSummary({...updated,document_type:type,total:updated.total||updated.amount||0})});
  }catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}
});

router.post('/documents/:type/:id/cancel', requireOwner, async (req,res,next)=>{
  try{
    const motive=String(req.body?.motive||'02');
    const replacementUuid=String(req.body?.replacementUuid||'').trim().toUpperCase();
    if(!['01','02','03','04'].includes(motive))return res.status(400).json({error:'Motivo de cancelación no válido'});
    if(motive==='01'&&!UUID_RE.test(replacementUuid))return res.status(400).json({error:'Captura el UUID que sustituye al CFDI'});
    const result=await cancelTypedDocument({tenantDb:req.tdb,type:req.params.type,id:Number(req.params.id),motive,replacementUuid,actor:req.user.username});
    res.json({ok:true,document:cfdiDocumentSummary({...result.updated,document_type:req.params.type,total:result.updated.total||result.updated.amount||0})});
  }catch(error){if(error.status)return res.status(error.status).json({error:error.message});next(error);}
});

router.post('/invoices/:id/cancel', requireOwner, async (req, res, next) => {
  try {
    const motive = String(req.body?.motive || '02');
    const replacementUuid = String(req.body?.replacementUuid || '').trim().toUpperCase();
    if (!['01','02','03','04'].includes(motive)) return res.status(400).json({ error: 'Motivo de cancelación no válido' });
    if (motive === '01' && !/^[0-9A-F-]{36}$/.test(replacementUuid)) return res.status(400).json({ error: 'Captura el UUID que sustituye al CFDI' });
    const invoice = await req.tdb.get('SELECT * FROM {s}.invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!invoice || !invoice.provider_id) return res.status(404).json({ error: 'CFDI no encontrado' });
    const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
    if (!['active','cancel_pending'].includes(invoice.status)) return res.status(409).json({ error: 'El CFDI no se puede cancelar en su estado actual' });
    const response = await facturamaFor(invoice.environment || profile).cancelCfdi(invoice.provider_id, motive, replacementUuid, apiModeFor(invoice, profile));
    const cancellation = cancellationResult(response, 'cancel_pending');
    const nextStatus = cancellation.status === 'active' ? 'active' : cancellation.status;
    const updated = await req.tdb.get(
      `UPDATE {s}.invoices SET status=$1,cancellation_motive=$2,replacement_uuid=$3,cancellation_status=$4,
       cancellation_message=$5,cancellation_receipt_enc=$6,cancel_requested_at=COALESCE(cancel_requested_at,now()),
       canceled_at=CASE WHEN $7 THEN now() ELSE canceled_at END,updated_at=now() WHERE id=$8 RETURNING *`,
      [nextStatus, motive, replacementUuid || null, cancellation.raw, cancellation.message,
        cancellation.receipt ? encrypt(cancellation.receipt) : null, cancellation.canceled, invoice.id]
    );
    await req.tdb.run("INSERT INTO {s}.invoice_events (invoice_id,event_type,detail,actor) VALUES ($1,'cancel_requested',$2,$3)", [invoice.id, cancellation.raw || 'solicitada', req.user.username]);
    res.json({ ok: true, invoice: invoiceSummary(updated) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.post('/global-invoices/:id/cancel', requireOwner, async (req, res, next) => {
  try {
    const motive = String(req.body?.motive || '02');
    const replacementUuid = String(req.body?.replacementUuid || '').trim().toUpperCase();
    if (!['01','02','03','04'].includes(motive)) return res.status(400).json({ error: 'Motivo de cancelación no válido' });
    if (motive === '01' && !/^[0-9A-F-]{36}$/.test(replacementUuid)) return res.status(400).json({ error: 'Captura el UUID que sustituye al CFDI' });
    const invoice = await req.tdb.get('SELECT * FROM {s}.global_invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!invoice || !invoice.provider_id) return res.status(404).json({ error: 'CFDI global no encontrado' });
    if (!['active','cancel_pending'].includes(invoice.status)) return res.status(409).json({ error: 'El CFDI no se puede cancelar en su estado actual' });
    const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
    const response = await facturamaFor(invoice.environment || profile).cancelCfdi(invoice.provider_id, motive, replacementUuid, apiModeFor(invoice, profile));
    const cancellation = cancellationResult(response, 'cancel_pending');
    const nextStatus = cancellation.status === 'active' ? 'active' : cancellation.status;
    const updated = await req.tdb.get(
      `UPDATE {s}.global_invoices SET status=$1,cancellation_motive=$2,replacement_uuid=$3,cancellation_status=$4,
       cancellation_message=$5,cancellation_receipt_enc=$6,cancel_requested_at=COALESCE(cancel_requested_at,now()),
       canceled_at=CASE WHEN $7 THEN now() ELSE canceled_at END,updated_at=now() WHERE id=$8 RETURNING *`,
      [nextStatus,motive,replacementUuid || null,cancellation.raw,cancellation.message,
        cancellation.receipt ? encrypt(cancellation.receipt) : null,cancellation.canceled,invoice.id]
    );
    if (cancellation.canceled) await req.tdb.run('UPDATE {s}.global_invoice_orders SET active=0 WHERE global_invoice_id=$1', [invoice.id]);
    await req.tdb.run("INSERT INTO {s}.global_invoice_events (global_invoice_id,event_type,detail,actor) VALUES ($1,'cancel_requested',$2,$3)", [invoice.id,cancellation.raw || 'solicitada',req.user.username]);
    res.json({ ok: true, invoice: globalInvoiceSummary(updated) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.post('/documents/:type/:id/refresh-cancellation', requireOwner, async (req, res, next) => {
  try {
    const found = await loadTypedDocument(req.tdb, req.params.type, Number(req.params.id));
    if (!found) return res.status(400).json({ error: 'Tipo de CFDI no válido' });
    const invoice = found.row;
    if (!invoice || !invoice.provider_id) return res.status(404).json({ error: 'CFDI no encontrado' });
    if (!['cancel_pending','canceled'].includes(invoice.status)) return res.status(409).json({ error: 'Este CFDI no tiene una cancelación pendiente' });
    const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
    const response = await facturamaFor(invoice.environment || profile).getCfdi(invoice.provider_id, apiModeFor(invoice, profile));
    const cancellation = cancellationResult(response, invoice.status);
    const nextStatus = cancellation.canceled ? 'canceled' : invoice.status;
    const updated = await req.tdb.get(
      `UPDATE {s}.${found.table} SET status=$1,cancellation_status=$2,
       cancellation_message=CASE WHEN $3<>'' THEN $3 ELSE cancellation_message END,
       cancellation_receipt_enc=CASE WHEN $4 IS NOT NULL THEN $4 ELSE cancellation_receipt_enc END,
       canceled_at=CASE WHEN $5 THEN COALESCE(canceled_at,now()) ELSE canceled_at END,updated_at=now() WHERE id=$6 RETURNING *`,
      [nextStatus,cancellation.raw,cancellation.message,cancellation.receipt ? encrypt(cancellation.receipt) : null,cancellation.canceled,invoice.id]
    );
    if (req.params.type === 'global' && cancellation.canceled) await req.tdb.run('UPDATE {s}.global_invoice_orders SET active=0 WHERE global_invoice_id=$1', [invoice.id]);
    if (req.params.type === 'payment' && cancellation.canceled) await req.tdb.run('UPDATE {s}.payment_complement_documents SET active=0 WHERE payment_complement_id=$1', [invoice.id]);
    await req.tdb.run(`INSERT INTO {s}.fiscal_document_events(document_type,document_id,event_type,detail,actor) VALUES($1,$2,'cancel_status_checked',$3,$4)`, [req.params.type,invoice.id,cancellation.raw,req.user.username]);
    res.json({ ok: true, document: cfdiDocumentSummary({ ...updated, document_type: req.params.type, total: updated.total || updated.amount || 0 }) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

router.get('/documents/:type/:id/cancellation-receipt', async (req, res, next) => {
  try {
    const found = await loadTypedDocument(req.tdb, req.params.type, Number(req.params.id));
    if (!found) return res.status(400).json({ error: 'Tipo de CFDI no válido' });
    const invoice = found.row;
    let content = decrypt(invoice.cancellation_receipt_enc);
    let format = 'xml';
    if (!content && invoice.provider_id && invoice.status === 'canceled') {
      const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
      const response = await facturamaFor(invoice.environment || profile).downloadCancellationReceipt(invoice.provider_id, 'pdf', apiModeFor(invoice, profile));
      content = String(response?.Content || '');
      format = 'pdf';
    }
    if (!content) return res.status(404).json({ error: 'El acuse de cancelación todavía no está disponible' });
    res.type(format === 'xml' ? 'application/xml' : 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Acuse-Cancelacion-${invoice.uuid || invoice.folio}.${format}"`);
    res.send(Buffer.from(content, 'base64'));
  } catch (error) { next(error); }
});

router.get('/invoices/:id/:format', async (req, res, next) => {
  try {
    const invoice = await req.tdb.get('SELECT * FROM {s}.invoices WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!invoice) return res.status(404).end();
    if (!['xml', 'pdf'].includes(req.params.format)) return res.status(400).json({ error: 'Formato no válido' });
    const format = req.params.format;
    let content = decrypt(format === 'xml' ? invoice.xml_enc : invoice.pdf_enc);
    if (!content && invoice.provider_id) {
      const profile = await getEmitter(req.tdb, invoice.fiscal_emitter_id);
      const facturama = facturamaFor(invoice.environment || profile);
      const result = await facturama.downloadCfdi(invoice.provider_id, format, apiModeFor(invoice, profile));
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
