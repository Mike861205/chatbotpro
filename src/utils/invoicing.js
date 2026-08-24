const crypto = require('node:crypto');

const RFC_RE = /^(?:[A-ZÑ&]{3,4})\d{6}[A-Z0-9]{3}$/;
const POSTAL_RE = /^\d{5}$/;
const SAT_PRODUCT_RE = /^\d{8}$/;
const SAT_UNIT_RE = /^[A-Z0-9]{2,3}$/;
const FISCAL_REGIMES = new Set(['601','603','605','606','607','608','610','611','612','614','615','616','620','621','622','623','624','625','626']);
const CFDI_USES = new Set(['G01','G02','G03','I01','I02','I03','I04','I05','I06','I07','I08','D01','D02','D03','D04','D05','D06','D07','D08','D09','D10','S01','CP01','CN01']);
const PAYMENT_FORMS = new Set(['01','02','03','04','05','06','08','12','13','14','15','17','23','24','25','26','27','28','29','30','31','99']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanUpper(value, max = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, max);
}

function isMexicoIdentity(identity = {}) {
  const country = String(identity.phone_country || identity.phoneCountry || '').trim().toUpperCase();
  const calling = String(identity.phone_calling_code || identity.phoneCallingCode || '').replace(/\s/g, '');
  return country === 'MX' || calling === '+52' || calling === '52';
}

function invoicingPortalUrl(req, configuredOrigin, slug) {
  const host = String(req?.get?.('host') || '').trim();
  const hostname = String(req?.hostname || host.split(':')[0] || '').trim().toLowerCase();
  const safeSlug = encodeURIComponent(String(slug || '').trim().toLowerCase());
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  if (isLocal && host) {
    return `${req.protocol || 'http'}://${host}/facturacion/${safeSlug}`;
  }
  return `${String(configuredOrigin || '').replace(/\/+$/, '')}/${safeSlug}`;
}

function validateFiscalProfile(input = {}) {
  const profile = {
    rfc: cleanUpper(input.rfc, 13),
    legalName: cleanUpper(input.legalName ?? input.legal_name, 300),
    fiscalRegime: String(input.fiscalRegime ?? input.fiscal_regime ?? '').trim(),
    postalCode: String(input.postalCode ?? input.postal_code ?? '').trim(),
    series: cleanUpper(input.series || 'POS', 25).replace(/[^A-Z0-9]/g, ''),
    defaultProductCode: String(input.defaultProductCode ?? input.default_product_code ?? '').trim(),
    defaultUnitCode: cleanUpper(input.defaultUnitCode ?? input.default_unit_code ?? 'E48', 3),
    defaultUnitName: String(input.defaultUnitName ?? input.default_unit_name ?? 'Unidad de servicio').trim().slice(0, 40),
    defaultTaxObject: String(input.defaultTaxObject ?? input.default_tax_object ?? '02').trim(),
    defaultIvaRate: Number(input.defaultIvaRate ?? input.default_iva_rate ?? 0.16),
    defaultIsrRate: Number(input.defaultIsrRate ?? input.default_isr_rate ?? 0),
    defaultCardPaymentForm: String(input.defaultCardPaymentForm ?? input.default_card_payment_form ?? '04').trim(),
  };
  if (!RFC_RE.test(profile.rfc)) throw Object.assign(new Error('El RFC del emisor no tiene un formato válido'), { status: 400 });
  if (profile.legalName.length < 3) throw Object.assign(new Error('Captura la razón social exactamente como aparece en el SAT'), { status: 400 });
  if (!FISCAL_REGIMES.has(profile.fiscalRegime)) throw Object.assign(new Error('Selecciona un régimen fiscal válido'), { status: 400 });
  if (!POSTAL_RE.test(profile.postalCode)) throw Object.assign(new Error('El código postal fiscal debe tener 5 dígitos'), { status: 400 });
  if (!profile.series) throw Object.assign(new Error('La serie fiscal es obligatoria'), { status: 400 });
  if (!SAT_PRODUCT_RE.test(profile.defaultProductCode)) throw Object.assign(new Error('La clave SAT predeterminada debe tener 8 dígitos'), { status: 400 });
  if (!SAT_UNIT_RE.test(profile.defaultUnitCode)) throw Object.assign(new Error('La clave de unidad SAT no es válida'), { status: 400 });
  if (!['01', '02', '03', '04', '05', '06', '07', '08'].includes(profile.defaultTaxObject)) throw Object.assign(new Error('El objeto de impuesto no es válido'), { status: 400 });
  if (!Number.isFinite(profile.defaultIvaRate) || profile.defaultIvaRate < 0 || profile.defaultIvaRate > 1) throw Object.assign(new Error('La tasa de IVA no es válida'), { status: 400 });
  if (!Number.isFinite(profile.defaultIsrRate) || profile.defaultIsrRate < 0 || profile.defaultIsrRate > 1) throw Object.assign(new Error('La tasa de ISR no es válida'), { status: 400 });
  if (1 + profile.defaultIvaRate - profile.defaultIsrRate <= 0) throw Object.assign(new Error('La combinación de IVA e ISR no es válida'), { status: 400 });
  if (!PAYMENT_FORMS.has(profile.defaultCardPaymentForm)) throw Object.assign(new Error('La forma de pago de tarjeta no es válida'), { status: 400 });
  return profile;
}

function validateReceiver(input = {}, options = {}) {
  const receiver = {
    rfc: cleanUpper(input.rfc, 13),
    name: cleanUpper(input.name ?? input.legalName, 300),
    fiscalRegime: String(input.fiscalRegime ?? input.fiscal_regime ?? '').trim(),
    postalCode: String(input.postalCode ?? input.postal_code ?? '').trim(),
    cfdiUse: cleanUpper(input.cfdiUse ?? input.cfdi_use ?? 'G03', 4),
    email: String(input.email || '').trim().toLowerCase().slice(0, 254),
  };
  // El RFC genérico nacional tiene valores obligatorios en CFDI 4.0. Los
  // normalizamos para que una prueba de público general no sea rechazada por
  // una combinación incompatible de régimen, uso o domicilio fiscal.
  const expeditionPostalCode = String(options.expeditionPostalCode || options.issuerPostalCode || '').trim();
  if (receiver.rfc === 'XAXX010101000') {
    receiver.name = 'PUBLICO EN GENERAL';
    receiver.fiscalRegime = '616';
    receiver.cfdiUse = 'S01';
  }
  // Los RFC genéricos nacional y extranjero deben usar como domicilio fiscal
  // el mismo código postal declarado como lugar de expedición del CFDI.
  if (['XAXX010101000', 'XEXX010101000'].includes(receiver.rfc) && POSTAL_RE.test(expeditionPostalCode)) {
    receiver.postalCode = expeditionPostalCode;
  }
  if (!RFC_RE.test(receiver.rfc)) throw Object.assign(new Error('El RFC del receptor no tiene un formato válido'), { status: 400 });
  if (receiver.name.length < 3) throw Object.assign(new Error('Captura el nombre fiscal del receptor'), { status: 400 });
  if (!FISCAL_REGIMES.has(receiver.fiscalRegime)) throw Object.assign(new Error('El régimen fiscal del receptor no es válido'), { status: 400 });
  if (!POSTAL_RE.test(receiver.postalCode)) throw Object.assign(new Error('El código postal fiscal del receptor debe tener 5 dígitos'), { status: 400 });
  if (!CFDI_USES.has(receiver.cfdiUse)) throw Object.assign(new Error('El uso de CFDI no es válido'), { status: 400 });
  if (receiver.email && !EMAIL_RE.test(receiver.email)) throw Object.assign(new Error('El correo electrónico no es válido'), { status: 400 });
  return receiver;
}

function validateInvoiceEmail(value) {
  const email = String(value || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) throw Object.assign(new Error('Captura un correo electrónico válido'), { status: 400 });
  return email;
}

function maskInvoiceEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  const [local = '', domain = ''] = email.split('@');
  if (!local || !domain) return 'correo no disponible';
  return `${local.slice(0, 1)}***@${domain}`;
}

function globalInformationForReceiver(receiver = {}, issuedAt = new Date()) {
  if (String(receiver.rfc || '').toUpperCase() !== 'XAXX010101000') return null;
  const date = issuedAt instanceof Date ? issuedAt : new Date(issuedAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    Periodicity: '01',
    Months: String(safeDate.getMonth() + 1).padStart(2, '0'),
    Year: safeDate.getFullYear(),
  };
}

function resolveExpeditionPostalCode(profile = {}, branchPostalCode = '') {
  const profilePostalCode = String(profile.postal_code ?? profile.postalCode ?? '').trim();
  const branchCode = String(branchPostalCode || '').trim();
  const sharedSandbox = String(profile.environment || '').toLowerCase() === 'sandbox'
    && Boolean(profile.sandbox_shared === true || Number(profile.sandbox_shared) === 1);
  if (!sharedSandbox && POSTAL_RE.test(branchCode)) return branchCode;
  return POSTAL_RE.test(profilePostalCode) ? profilePostalCode : branchCode;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function roundSix(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

function paymentFormFromSale(sale, defaultCard = '04', requested = '') {
  const method = String(sale?.payment_method || '').toLowerCase();
  if (!method && PAYMENT_FORMS.has(String(requested || ''))) return String(requested);
  const breakdown = typeof sale?.payment_breakdown === 'string'
    ? JSON.parse(sale.payment_breakdown || '{}')
    : (sale?.payment_breakdown || {});
  const cardPaymentForm = String(breakdown.cardType || breakdown.card_type || '').toLowerCase() === 'debit'
    ? '28'
    : String(breakdown.cardType || breakdown.card_type || '').toLowerCase() === 'credit'
      ? '04'
      : (PAYMENT_FORMS.has(defaultCard) ? defaultCard : '04');
  if (method === 'cash') return '01';
  if (method === 'transfer') return '03';
  if (method === 'card') return ['04', '28'].includes(String(requested || '')) ? String(requested) : cardPaymentForm;
  const options = [
    ['01', Number(breakdown.cash || 0)],
    [cardPaymentForm, Number(breakdown.card || 0)],
    ['03', Number(breakdown.transfer || 0)],
  ];
  options.sort((a, b) => b[1] - a[1]);
  return options[0][1] > 0 ? options[0][0] : '01';
}

function paymentFormFromSales(sales = [], defaultCard = '04') {
  const totals = new Map();
  const add = (form, amount) => totals.set(form, roundMoney((totals.get(form) || 0) + Number(amount || 0)));
  for (const sale of sales) {
    const method = String(sale?.payment_method || '').toLowerCase();
    const breakdown = typeof sale?.payment_breakdown === 'string'
      ? JSON.parse(sale.payment_breakdown || '{}')
      : (sale?.payment_breakdown || {});
    if (method === 'cash') add('01', sale.total);
    else if (method === 'transfer') add('03', sale.total);
    else if (method === 'card') add(paymentFormFromSale(sale, defaultCard), sale.total);
    else {
      add('01', breakdown.cash);
      add(paymentFormFromSale({ payment_method: 'card', payment_breakdown: breakdown }, defaultCard), breakdown.card);
      add('03', breakdown.transfer);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '01';
}

function fiscalItem({ description, quantity, grossTotal, productCode, unitCode, unitName, taxObject, ivaRate, isrRate }) {
  const qty = Math.max(1, Number(quantity || 1));
  const gross = roundMoney(grossTotal);
  const rate = taxObject === '02' ? Number(ivaRate || 0) : 0;
  const retentionRate = taxObject === '02' ? Number(isrRate || 0) : 0;
  const divisor = 1 + rate - retentionRate;
  if (divisor <= 0) throw Object.assign(new Error('La combinación de IVA e ISR no es válida'), { status: 400 });
  // Facturama valida Total = Subtotal + traslados - retenciones. Conservamos
  // hasta seis decimales (permitidos por CFDI 4.0) para evitar diferencias de
  // un centavo al extraer IVA de precios que ya lo incluyen.
  const rawBase = (rate > 0 || retentionRate > 0) ? gross / divisor : gross;
  const unitPrice = roundSix(rawBase / qty);
  const base = roundSix(unitPrice * qty);
  const tax = rate > 0 ? roundSix(base * rate) : 0;
  const retention = retentionRate > 0 ? roundSix(base * retentionRate) : 0;
  const fiscalTotal = roundSix(base + tax - retention);
  const item = {
    ProductCode: productCode,
    Description: String(description || 'Venta').trim().slice(0, 1000),
    UnitCode: unitCode,
    Unit: unitName,
    Quantity: qty,
    UnitPrice: unitPrice,
    Subtotal: base,
    TaxObject: taxObject,
    Total: fiscalTotal,
  };
  if (taxObject === '02' && rate >= 0) {
    item.Taxes = [{ Total: tax, Name: 'IVA', Base: base, Rate: rate, IsRetention: false }];
    if (retentionRate > 0) item.Taxes.push({ Total: retention, Name: 'ISR', Base: base, Rate: retentionRate, IsRetention: true });
  }
  return item;
}

function buildFacturamaItems(sale, productsById, profile, options = {}) {
  const rawItems = typeof sale.items === 'string' ? JSON.parse(sale.items || '[]') : (sale.items || []);
  const conceptMode = options.conceptMode === 'total' ? 'total' : 'detailed';
  const items = conceptMode === 'total' ? [fiscalItem({
    description: 'Consumo',
    quantity: 1,
    grossTotal: Number(sale.total || 0),
    productCode: profile.default_product_code,
    unitCode: profile.default_unit_code,
    unitName: profile.default_unit_name,
    taxObject: profile.default_tax_object,
    ivaRate: Number(profile.default_iva_rate),
    isrRate: Number(profile.default_isr_rate || 0),
  })] : rawItems.map((line) => {
    const product = productsById.get(Number(line.id || line.productId || 0)) || {};
    const qty = Math.max(1, Number(line.qty || 1));
    const gross = roundMoney(Number(line.price || 0) * qty);
    return fiscalItem({
      description: line.name || product.name || 'Venta',
      quantity: qty,
      grossTotal: gross,
      productCode: product.sat_product_code || profile.default_product_code,
      unitCode: product.sat_unit_code || profile.default_unit_code,
      unitName: product.sat_unit_name || profile.default_unit_name,
      taxObject: product.tax_object || profile.default_tax_object,
      ivaRate: product.iva_rate === null || product.iva_rate === undefined ? profile.default_iva_rate : Number(product.iva_rate),
      isrRate: product.isr_rate === null || product.isr_rate === undefined ? profile.default_isr_rate : Number(product.isr_rate),
    });
  });
  const deliveryFee = roundMoney(sale.delivery_fee || 0);
  if (conceptMode === 'detailed' && deliveryFee > 0) {
    items.push(fiscalItem({
      description: 'Servicio de entrega', quantity: 1, grossTotal: deliveryFee,
      productCode: profile.delivery_product_code || profile.default_product_code,
      unitCode: profile.default_unit_code, unitName: profile.default_unit_name,
      taxObject: profile.default_tax_object, ivaRate: Number(profile.default_iva_rate),
      isrRate: Number(profile.default_isr_rate || 0),
    }));
  }
  if (!items.length) throw Object.assign(new Error('La venta no contiene conceptos facturables'), { status: 400 });
  for (const item of items) {
    if (!SAT_PRODUCT_RE.test(String(item.ProductCode || ''))) throw Object.assign(new Error(`Falta la clave SAT para ${item.Description}`), { status: 400 });
    if (!SAT_UNIT_RE.test(String(item.UnitCode || ''))) throw Object.assign(new Error(`Falta la unidad SAT para ${item.Description}`), { status: 400 });
  }
  const calculated = roundMoney(items.reduce((sum, item) => sum + Number(item.Total || 0), 0));
  if (Math.abs(calculated - roundMoney(sale.total)) > 0.01) throw Object.assign(new Error('El total fiscal no coincide con el total del ticket'), { status: 409 });
  return items;
}

function buildGlobalFacturamaItems(sales, productsById, profile, options = {}) {
  const conceptMode = options.conceptMode === 'total' ? 'total' : 'detailed';
  const expected = roundMoney((sales || []).reduce((sum, sale) => sum + Number(sale.total || 0), 0));
  if (conceptMode === 'total') {
    if (!(sales || []).length) throw Object.assign(new Error('No hay ventas elegibles para la factura global'), { status: 400 });
    return buildFacturamaItems({ items: [], delivery_fee: 0, total: expected }, productsById, profile, { conceptMode: 'total' });
  }
  const concepts = [];
  for (const sale of sales || []) {
    const ticketItems = buildFacturamaItems(sale, productsById, profile, { conceptMode: 'detailed' });
    for (const item of ticketItems) {
      concepts.push({
        ...item,
        Description: `Ticket #${sale.id} · ${item.Description}`.slice(0, 1000),
      });
    }
  }
  if (!concepts.length) throw Object.assign(new Error('No hay ventas elegibles para la factura global'), { status: 400 });
  const calculated = roundMoney(concepts.reduce((sum, item) => sum + Number(item.Total || 0), 0));
  if (Math.abs(calculated - expected) > 0.01) {
    throw Object.assign(new Error('El total fiscal global no coincide con las ventas seleccionadas'), { status: 409 });
  }
  return concepts;
}

function deepValue(value, wantedKeys) {
  if (!value || typeof value !== 'object') return '';
  for (const [key, nested] of Object.entries(value)) {
    if (wantedKeys.has(key.toLowerCase()) && nested !== null && nested !== undefined && typeof nested !== 'object') return String(nested);
  }
  for (const nested of Object.values(value)) {
    const found = deepValue(nested, wantedKeys);
    if (found) return found;
  }
  return '';
}

function extractFacturamaIdentity(response = {}) {
  return {
    providerId: String(response.Id || response.id || ''),
    uuid: deepValue(response, new Set(['uuid', 'foliofiscal'])).toUpperCase(),
    certificateNumber: deepValue(response, new Set(['certnumber', 'nocertificado'])),
  };
}

function createRequestKey() {
  return crypto.randomUUID();
}

module.exports = {
  RFC_RE, POSTAL_RE, FISCAL_REGIMES, CFDI_USES, PAYMENT_FORMS,
  isMexicoIdentity, invoicingPortalUrl, validateFiscalProfile, validateReceiver, validateInvoiceEmail, maskInvoiceEmail, globalInformationForReceiver, resolveExpeditionPostalCode, roundMoney,
  paymentFormFromSale, paymentFormFromSales, buildFacturamaItems, buildGlobalFacturamaItems, extractFacturamaIdentity, createRequestKey,
};
