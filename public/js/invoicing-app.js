const $ = (selector) => document.querySelector(selector);
let ME = null;
let INVOICING = null;

function toast(message, error = false) {
  const element = $('#toast');
  element.innerHTML = `<i class="ph-bold ${error ? 'ph-warning-circle' : 'ph-check-circle'}"></i><span>${escapeHtml(message)}</span>`;
  element.className = `iv-toast${error ? ' error' : ''}`;
  element.hidden = false;
  clearTimeout(element._timer);
  element._timer = setTimeout(() => { element.hidden = true; }, 3500);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function api(path, options = {}) {
  const headers = { 'x-cbp-auth-scope': 'owner', ...(options.headers || {}) };
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    location.replace('/facturacion/login');
    throw new Error('Tu sesión terminó');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la operación');
  return data;
}

function statusLabel(status) {
  return { active: 'Activa', canceled: 'Cancelada', cancel_pending: 'Cancelación pendiente', failed: 'Error', pending: 'Procesando', unknown: 'Por revisar' }[status] || status || '—';
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
}

function routeForPortal(url) {
  if (location.hostname.startsWith('facturacion.')) return url;
  return `/facturacion/${encodeURIComponent(ME.tenant.slug)}`;
}

function renderPortal() {
  const portalUrl = routeForPortal(INVOICING.portalUrl);
  const color = ME.tenant.primaryColor || '#123c37';
  ['#portalBrand', '#portalBrandLarge'].forEach((selector) => $(selector).style.setProperty('--tenant-color', color));
  ['#portalBusiness', '#portalBusinessLarge'].forEach((selector) => $(selector).textContent = ME.tenant.businessName);
  ['#portalLogo', '#portalLogoLarge'].forEach((selector) => { $(selector).src = ME.tenant.logo || '/static/chatbotpro100.png'; });
  $('#portalUrlShort').textContent = portalUrl;
  $('#portalUrlLarge').textContent = portalUrl;
  $('#openPortal').onclick = () => window.open(portalUrl, '_blank', 'noopener');
  $('#copyPortal').onclick = async () => { await navigator.clipboard.writeText(new URL(portalUrl, location.origin).href); toast('Liga del portal copiada'); };
}

function fillIdentity() {
  $('#identityBusinessName').value = ME.tenant.businessName || '';
  $('#identityColor').value = /^#[0-9a-f]{6}$/i.test(ME.tenant.primaryColor || '') ? ME.tenant.primaryColor : '#123c37';
}

function renderSummary() {
  const profile = INVOICING.profile;
  const activated = Boolean(ME.tenant.invoicingActivated);
  const profileComplete = Boolean(profile?.rfc && profile?.legal_name && profile?.fiscal_regime && profile?.postal_code);
  const csdComplete = Boolean(profile?.csd_uploaded || profile?.api_mode === 'web' || profile?.sandbox_shared);
  const completed = [true, profileComplete, csdComplete, activated].filter(Boolean).length;
  $('#metricInvoices').textContent = String(INVOICING.invoices.length);
  $('#metricStamps').textContent = INVOICING.stampWallet?.unlimited ? 'Ilimitados' : String(INVOICING.stampWallet?.available ?? 0);
  $('#metricEmitters').textContent = String(INVOICING.emitters.length);
  $('#metricEnvironment').textContent = INVOICING.provider.environment === 'production' ? 'Producción' : 'Sandbox';
  $('#progressText').textContent = `${completed} de 4`;
  if (profileComplete) $('#checkProfile').classList.add('done');
  if (csdComplete) $('#checkCsd').classList.add('done');
  if (activated) $('#checkActivation').classList.add('done');
  const status = $('#activationStatus');
  status.classList.toggle('warning', !activated || !INVOICING.ready);
  status.innerHTML = activated && INVOICING.ready ? '<i class="ph-bold ph-check-circle"></i> Portal activo' : '<i class="ph-bold ph-clock"></i> Configuración pendiente';
}

async function loadDocuments() {
  const data = await api('/api/invoicing/documents?limit=20');
  $('#metricInvoices').textContent = String(data.pagination?.total ?? data.rows.length);
  if (!data.rows.length) {
    $('#documentsTable').innerHTML = '<div class="iv-empty"><i class="ph-bold ph-file-dashed"></i>Aún no hay CFDI emitidos en esta cuenta.</div>';
    return;
  }
  $('#documentsTable').innerHTML = `<table class="iv-table"><thead><tr><th>Comprobante</th><th>Fecha</th><th>RFC emisor</th><th>Total</th><th>Estado</th><th>Archivos</th></tr></thead><tbody>${data.rows.map((document) => {
    const base = document.type === 'global' ? `/api/invoicing/global-invoices/${document.id}` : document.type === 'direct' ? `/api/invoicing/direct-invoices/${document.id}` : `/api/invoicing/invoices/${document.id}`;
    const typeLabel = document.type === 'direct' ? 'Venta externa' : document.type === 'global' ? 'Global' : 'Ticket';
    return `<tr><td><span class="iv-doc-type">${typeLabel}</span><b>${escapeHtml(document.series || '')}-${escapeHtml(document.folio || '')}</b><br><small>${escapeHtml(document.uuid || 'Sin UUID')}</small></td><td>${formatDate(document.issuedAt || document.createdAt)}</td><td>${escapeHtml(document.receiver?.rfc || '—')}</td><td>${formatMoney(document.total)}</td><td><span class="iv-doc-status ${escapeHtml(document.status)}">${escapeHtml(statusLabel(document.status))}</span></td><td><div class="iv-doc-actions"><a class="iv-btn iv-btn-secondary" href="${base}/pdf" target="_blank"><i class="ph-bold ph-file-pdf"></i> PDF</a><a class="iv-btn iv-btn-secondary" href="${base}/xml" target="_blank"><i class="ph-bold ph-file-code"></i> XML</a></div></td></tr>`;
  }).join('')}</tbody></table>`;
}

function fillProfile() {
  const profile = INVOICING.profile;
  if (!profile) return;
  $('#rfc').value = profile.rfc || '';
  $('#legalName').value = profile.legal_name || '';
  $('#fiscalRegime').value = profile.fiscal_regime || '';
  $('#postalCode').value = profile.postal_code || '';
  $('#series').value = ['A', 'TEST'].includes(profile.series) ? 'FAC' : (profile.series || 'FAC');
  $('#ivaRate').value = String(Number(profile.default_iva_rate ?? .16));
}

const viewMetadata = {
  summary: ['Resumen fiscal', 'Estado de tu cuenta y portal de facturación.'],
  'new-invoice': ['Nueva factura', 'Emite un CFDI a partir de una venta de tu propio punto de venta.'],
  documents: ['CFDI emitidos', 'Consulta el expediente fiscal de tu negocio.'],
  portal: ['Mi portal', 'La experiencia pública con la identidad de tu negocio.'],
  settings: ['Configuración fiscal', 'Datos del emisor y Certificado de Sello Digital.'],
};

function setView(view) {
  const safeView = viewMetadata[view] ? view : 'summary';
  document.querySelectorAll('.iv-view').forEach((section) => section.classList.toggle('active', section.id === `view-${safeView}`));
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === safeView));
  [$('#viewTitle').textContent, $('#viewSubtitle').textContent] = viewMetadata[safeView];
  history.replaceState(null, '', `#${safeView}`);
  $('#sidebar').classList.remove('open');
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#reloadDocuments').addEventListener('click', () => loadDocuments().then(() => toast('Documentos actualizados')).catch((error) => toast(error.message, true)));
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.replace('/facturacion/login'); });

function updateDirectReceiverMode() {
  const publicGeneral = document.querySelector('input[name="directReceiverMode"]:checked')?.value === 'public';
  $('#directReceiverFields').hidden = publicGeneral;
  $('#directPublicSummary').hidden = !publicGeneral;
  ['#directReceiverRfc','#directReceiverName','#directReceiverRegime','#directReceiverPostal','#directReceiverUse'].forEach((selector) => { $(selector).required = !publicGeneral; });
}

document.querySelectorAll('input[name="directReceiverMode"]').forEach((input) => input.addEventListener('change', updateDirectReceiverMode));
$('#directSaleDate').value = new Date().toISOString().slice(0, 10);
updateDirectReceiverMode();
$('#directSuccessClose').addEventListener('click', () => { $('#directInvoiceSuccess').hidden = true; });
$('#directInvoiceSuccess').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.hidden = true; });

$('#directInvoiceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const publicGeneral = document.querySelector('input[name="directReceiverMode"]:checked')?.value === 'public';
  button.disabled = true;
  try {
    const result = await api('/api/invoicing/direct-invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        externalReference: $('#directReference').value, saleDate: $('#directSaleDate').value,
        description: $('#directDescription').value, total: Number($('#directTotal').value), paymentForm: $('#directPaymentForm').value,
        publicGeneral, receiver: publicGeneral ? null : { rfc: $('#directReceiverRfc').value, name: $('#directReceiverName').value,
          fiscalRegime: $('#directReceiverRegime').value, postalCode: $('#directReceiverPostal').value,
          cfdiUse: $('#directReceiverUse').value, email: $('#directReceiverEmail').value },
      }),
    });
    const document = result.invoice;
    const base = `/api/invoicing/direct-invoices/${document.id}`;
    $('#directSuccessUuid').textContent = document.uuid || `${document.series}-${document.folio}`;
    $('#directSuccessPdf').href = `${base}/pdf`; $('#directSuccessXml').href = `${base}/xml`;
    $('#directInvoiceSuccess').hidden = false;
    toast(result.message || 'Factura timbrada correctamente');
    event.currentTarget.reset(); $('#directSaleDate').value = new Date().toISOString().slice(0, 10); updateDirectReceiverMode();
    await initialize();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

$('#fiscalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/invoicing/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, rfc: $('#rfc').value, legalName: $('#legalName').value, fiscalRegime: $('#fiscalRegime').value, postalCode: $('#postalCode').value, series: $('#series').value, defaultProductCode: '01010101', defaultUnitCode: 'E48', defaultUnitName: 'Unidad de servicio', defaultTaxObject: '02', defaultIvaRate: Number($('#ivaRate').value), defaultIsrRate: 0, deliveryProductCode: '78101800', defaultCardPaymentForm: '04' }) });
    toast('Datos fiscales guardados'); await initialize(); setView('settings');
  } catch (error) { toast(error.message, true); }
});

$('#csdForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/invoicing/csd', { method: 'POST', body: new FormData(event.currentTarget) });
    event.currentTarget.reset(); toast('Certificado de Sello Digital cargado'); await initialize(); setView('settings');
  } catch (error) { toast(error.message, true); }
});

$('#identityForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: new FormData(event.currentTarget) });
    toast('Identidad del portal actualizada'); await initialize(); setView('portal');
  } catch (error) { toast(error.message, true); }
});

async function initialize() {
  ME = await api('/api/auth/me');
  if (ME.tenant?.productCode !== 'invoicing') {
    location.replace('/app#facturacion');
    return;
  }
  INVOICING = await api('/api/invoicing/bootstrap');
  $('#accountBusiness').textContent = ME.tenant.businessName;
  $('#accountUser').textContent = ME.displayName || ME.username;
  $('#directStampBalance').textContent = INVOICING.stampWallet?.unlimited ? '∞' : String(INVOICING.stampWallet?.available ?? 0);
  renderSummary(); renderPortal(); fillProfile(); fillIdentity(); await loadDocuments();
  $('#loading').hidden = true;
  setView(location.hash.slice(1) || 'summary');
}

initialize().catch((error) => { $('#loading').innerHTML = `<span>${escapeHtml(error.message)}</span>`; toast(error.message, true); });