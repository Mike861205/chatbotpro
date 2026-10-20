const $ = (selector) => document.querySelector(selector);
let ME = null;
let INVOICING = null;
let DOCUMENTS = [];
let RECEIVABLES = [];
let DOCUMENT_QUERY = { page: 1, limit: 20, type: 'all', status: 'all', dateFrom: '', dateTo: '', search: '' };

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
  const absolutePortalUrl = new URL(portalUrl, location.origin).href;
  const color = /^#[0-9a-f]{6}$/i.test(ME.tenant.primaryColor || '') ? ME.tenant.primaryColor : '#123c37';
  document.documentElement.style.setProperty('--tenant-color', color);
  ['#portalBrand', '.iv-portal-share-card'].forEach((selector) => $(selector).style.setProperty('--tenant-color', color));
  ['#portalBusiness', '#portalBusinessLarge'].forEach((selector) => $(selector).textContent = ME.tenant.businessName);
  ['#portalLogo', '#portalLogoLarge', '#accountLogo'].forEach((selector) => { $(selector).src = ME.tenant.logo || '/static/chatbotpro100.png'; });
  $('#portalUrlShort').textContent = portalUrl;
  $('#portalShareUrl').value = absolutePortalUrl;
  $('#portalOpenButton').href = absolutePortalUrl;
  const qrUrl = new URL('https://api.qrserver.com/v1/create-qr-code/');
  qrUrl.searchParams.set('size', '360x360');
  qrUrl.searchParams.set('margin', '12');
  qrUrl.searchParams.set('data', absolutePortalUrl);
  $('#portalQrCode').src = qrUrl.href;
  $('#portalQrOpen').href = qrUrl.href;
  const isLocalPreview = ['localhost', '127.0.0.1'].includes(location.hostname);
  $('#portalQrEnvironmentHint').classList.toggle('warning', isLocalPreview);
  $('#portalQrEnvironmentHint').innerHTML = isLocalPreview
    ? '<i class="ph-bold ph-warning-circle"></i><span>Estás en localhost: este QR solo abre en este equipo. Comparte el QR cuando uses el dominio público.</span>'
    : '<i class="ph-bold ph-lightbulb"></i><span>El código QR siempre abre la liga pública de este negocio.</span>';
  $('#openPortal').onclick = () => window.open(portalUrl, '_blank', 'noopener');
  const copyPortalLink = async () => {
    try { await navigator.clipboard.writeText(absolutePortalUrl); toast('Liga del portal copiada'); }
    catch { $('#portalShareUrl').focus(); $('#portalShareUrl').select(); toast('Selecciona y copia la liga del portal', true); }
  };
  $('#copyPortal').onclick = copyPortalLink;
  $('#portalCopyButton').onclick = copyPortalLink;
}

$('#identityBusinessName').addEventListener('input', (event) => {
  const name = event.target.value.trim() || 'Tu negocio';
  ['#portalBusiness', '#portalBusinessLarge'].forEach((selector) => $(selector).textContent = name);
});

$('#identityColor').addEventListener('input', (event) => {
  const color = event.target.value;
  document.documentElement.style.setProperty('--tenant-color', color);
  ['#portalBrand', '.iv-portal-share-card'].forEach((selector) => $(selector).style.setProperty('--tenant-color', color));
});

$('#identityLogo').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  $('#identityLogoName').textContent = file?.name || 'Seleccionar una nueva imagen';
  if (!file) return;
  const previewUrl = URL.createObjectURL(file);
  ['#portalLogo', '#portalLogoLarge'].forEach((selector) => { $(selector).src = previewUrl; });
});

function fillIdentity() {
  $('#identityBusinessName').value = ME.tenant.businessName || '';
  $('#identityColor').value = /^#[0-9a-f]{6}$/i.test(ME.tenant.primaryColor || '') ? ME.tenant.primaryColor : '#123c37';
}

function fiscalDraftCount(profile = {}) {
  return ['rfc', 'legal_name', 'fiscal_regime', 'postal_code'].filter((key) => String(profile?.[key] || '').trim()).length;
}

function fillInvoicingSetup() {
  const profile = INVOICING?.profile || {};
  $('#setupBusinessName').value = ME?.tenant?.businessName || '';
  $('#setupColor').value = /^#[0-9a-f]{6}$/i.test(ME?.tenant?.primaryColor || '') ? ME.tenant.primaryColor : '#123c37';
  $('#setupRfc').value = profile.rfc || '';
  $('#setupLegalName').value = profile.legal_name || '';
  $('#setupFiscalRegime').value = profile.fiscal_regime || '';
  $('#setupPostalCode').value = profile.postal_code || '';
  const logo = String(ME?.tenant?.logo || '').trim();
  $('#setupLogoPreview').innerHTML = logo ? `<img src="${escapeHtml(logo)}" alt="Logo actual" />` : '<i class="ph-bold ph-image-square"></i>';
}

function showInvoicingSetup() {
  fillInvoicingSetup();
  $('#invoicingSetupError').hidden = true;
  $('#invoicingSetupModal').hidden = false;
  document.body.classList.add('iv-journey-open');
  setTimeout(() => $('#setupBusinessName').focus(), 80);
}

function showInvoicingWelcome() {
  const ownerName = String(ME?.tenant?.ownerName || ME?.displayName || '').trim();
  const businessName = String(ME?.tenant?.businessName || 'Tu negocio').trim();
  const logo = String(ME?.tenant?.logo || '').trim();
  const completed = fiscalDraftCount(INVOICING?.profile);
  $('#invoicingWelcomeEyebrow').textContent = ownerName ? `¡Felicidades por tu registro, ${ownerName}!` : '¡Felicidades por tu registro!';
  $('#invoicingWelcomeTitle').textContent = `${businessName}, es hora de facturar fácil`;
  $('#invoicingWelcomeText').textContent = `Tu espacio de facturación ya tiene la identidad de ${businessName}. Completa tu expediente cuando estés listo y expide facturas de manera sencilla para ti y tus clientes.`;
  $('#invoicingWelcomeBusiness').textContent = businessName;
  $('#invoicingWelcomePortal').textContent = routeForPortal(INVOICING.portalUrl);
  $('#invoicingWelcomeFiscal').textContent = completed === 4 ? 'Datos capturados' : `${completed} de 4 capturados`;
  $('#invoicingWelcomeLogo').innerHTML = logo ? `<img src="${escapeHtml(logo)}" alt="Logo de ${escapeHtml(businessName)}" />` : '<i class="ph-bold ph-buildings"></i>';
  $('#invoicingWelcomeModal').hidden = false;
  document.body.classList.add('iv-journey-open');
}

function presentInvoicingStartup() {
  if (ME?.identityRequired) return showInvoicingSetup();
  if (ME?.onboardingRequired) showInvoicingWelcome();
}

async function completeInvoicingWelcome(view) {
  await api('/api/auth/onboarding/complete', { method: 'POST' });
  ME.onboardingCompleted = true;
  ME.onboardingRequired = false;
  $('#invoicingWelcomeModal').hidden = true;
  document.body.classList.remove('iv-journey-open');
  setView(view);
}

function renderSummary() {
  const profile = INVOICING.profile;
  const activated = Boolean(ME.tenant.invoicingActivated);
  const profiles = INVOICING.emitters || [];
  const profileComplete = profiles.some((item) => item.enabled && item.rfc && item.legal_name && item.fiscal_regime && item.postal_code);
  const csdComplete = profiles.some((item) => item.enabled && (item.csd_uploaded || item.api_mode === 'web' || item.sandbox_shared));
  const completed = [true, profileComplete, csdComplete, activated].filter(Boolean).length;
  $('#metricInvoices').textContent = String(INVOICING.invoices.length);
  $('#metricStamps').textContent = INVOICING.stampWallet?.unlimited ? 'Ilimitados' : String(INVOICING.stampWallet?.available ?? 0);
  $('#metricEmitters').textContent = String(profiles.filter((item) => item.enabled).length);
  $('#metricEnvironment').textContent = INVOICING.provider.environment === 'production' ? 'Producción' : 'Sandbox';
  $('#progressText').textContent = `${completed} de 4`;
  $('#checkProfile').classList.toggle('done', profileComplete);
  $('#checkCsd').classList.toggle('done', csdComplete);
  $('#checkActivation').classList.toggle('done', activated);
  $('#checkProfile').disabled = profileComplete;
  $('#checkCsd').disabled = csdComplete;
  $('#checkActivation').disabled = activated;
  const status = $('#activationStatus');
  const ready = profiles.some((item) => item.enabled && item.rfc && item.legal_name && item.fiscal_regime && item.postal_code && (item.csd_uploaded || item.api_mode === 'web' || item.sandbox_shared));
  status.classList.toggle('warning', !activated || !ready || !INVOICING.provider.configured);
  status.innerHTML = activated && ready && INVOICING.provider.configured ? '<i class="ph-bold ph-check-circle"></i> Facturación lista' : '<i class="ph-bold ph-clock"></i> Configuración pendiente';
}

async function loadDocuments() {
  const query = new URLSearchParams(Object.entries(DOCUMENT_QUERY).filter(([, value]) => value !== ''));
  const data = await api(`/api/invoicing/documents?${query}`);
  DOCUMENTS = data.rows || [];
  const pagination = data.pagination || { page: 1, pages: 1, total: DOCUMENTS.length, limit: 20 };
  if (DOCUMENT_QUERY.type === 'all' && DOCUMENT_QUERY.status === 'all' && !DOCUMENT_QUERY.search && !DOCUMENT_QUERY.dateFrom && !DOCUMENT_QUERY.dateTo) {
    $('#metricInvoices').textContent = String(pagination.total);
  }
  $('#documentsCount').textContent = `${pagination.total} CFDI encontrados`;
  $('#documentPagination').innerHTML = `<label>Mostrar <select id="documentPageSize"><option value="10" ${pagination.limit === 10 ? 'selected' : ''}>10</option><option value="20" ${pagination.limit === 20 ? 'selected' : ''}>20</option><option value="50" ${pagination.limit === 50 ? 'selected' : ''}>50</option></select></label><span>Página ${pagination.page} de ${pagination.pages}</span><button class="iv-btn iv-btn-secondary" type="button" data-document-page="${pagination.page - 1}" ${pagination.page <= 1 ? 'disabled' : ''}>Anterior</button><button class="iv-btn iv-btn-secondary" type="button" data-document-page="${pagination.page + 1}" ${pagination.page >= pagination.pages ? 'disabled' : ''}>Siguiente</button>`;
  $('#documentPageSize').onchange = (event) => { DOCUMENT_QUERY.limit = Number(event.target.value); DOCUMENT_QUERY.page = 1; loadDocuments().catch((error) => toast(error.message, true)); };
  document.querySelectorAll('[data-document-page]').forEach((button) => button.onclick = () => { if (button.disabled) return; DOCUMENT_QUERY.page = Number(button.dataset.documentPage); loadDocuments().catch((error) => toast(error.message, true)); });
  if (!data.rows.length) {
    $('#documentsTable').innerHTML = '<div class="iv-empty"><i class="ph-bold ph-file-dashed"></i>No hay CFDI para este filtro.</div>';
    return;
  }
  $('#documentsTable').innerHTML = `<table class="iv-table"><thead><tr><th>Comprobante</th><th>Fecha</th><th>Emisor</th><th>Receptor</th><th>Total</th><th>Pago</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${data.rows.map((document) => {
    const base = document.type === 'global' ? `/api/invoicing/global-invoices/${document.id}` : document.type === 'payment' ? `/api/invoicing/payment-complements/${document.id}` : ['direct','manual_global','credit_note'].includes(document.type) ? `/api/invoicing/direct-invoices/${document.id}` : `/api/invoicing/invoices/${document.id}`;
    const typeLabel = ({direct:'Venta externa',global:'Global POS',manual_global:'Global manual',credit_note:'Nota de crédito',payment:'Complemento de pago',individual:'Ticket'})[document.type] || document.type;
    const files = document.providerId ? `<a class="iv-btn iv-btn-secondary" href="${base}/pdf" target="_blank">PDF</a><a class="iv-btn iv-btn-secondary" href="${base}/xml" target="_blank">XML</a>` : '';
    const noteAction = document.status === 'active' && ['individual','global','direct'].includes(document.type) ? `<button class="iv-btn iv-btn-secondary" data-credit-document="${document.type}:${document.id}">Nota</button>` : '';
    const paymentAction = document.status === 'active' && document.paymentMethod === 'PPD' && ['individual','global','direct'].includes(document.type) ? `<button class="iv-btn iv-btn-primary" data-payment-document="${document.type}:${document.id}">Registrar pago</button>` : '';
    const actions = `${files}${document.status === 'active' ? `<button class="iv-btn iv-btn-secondary" data-email-document="${document.type}:${document.id}">Correo</button>${paymentAction}${noteAction}<button class="iv-btn iv-btn-secondary" data-cancel-document="${document.type}:${document.id}">Cancelar</button>` : ''}${document.status === 'cancel_pending' ? `<button class="iv-btn iv-btn-secondary" data-refresh-document="${document.type}:${document.id}">Actualizar</button>` : ''}${document.status === 'unknown' ? `<button class="iv-btn iv-btn-secondary" data-reconcile-document="${document.type}:${document.id}">Conciliar</button>` : ''}${document.hasCancellationReceipt ? `<a class="iv-btn iv-btn-secondary" href="/api/invoicing/documents/${document.type}/${document.id}/cancellation-receipt" target="_blank">Acuse</a>` : ''}`;
    return `<tr><td data-label="Comprobante"><span class="iv-doc-type">${typeLabel}</span><b>${escapeHtml(document.series || '')}-${escapeHtml(document.folio || '')}</b><br><small>${escapeHtml(document.uuid || 'Sin UUID')}</small></td><td data-label="Fecha">${formatDate(document.issuedAt || document.createdAt)}</td><td data-label="Emisor">${escapeHtml(document.issuerRfc || '—')}</td><td data-label="Receptor">${escapeHtml(document.receiver?.rfc || '—')}<br><small>${escapeHtml(document.receiver?.name || '')}</small></td><td data-label="Total">${formatMoney(document.total)}</td><td data-label="Pago">${escapeHtml(document.paymentMethod || (document.type === 'payment' ? 'REP 2.0' : 'PUE'))}</td><td data-label="Estado"><span class="iv-doc-status ${escapeHtml(document.status)}">${escapeHtml(statusLabel(document.status))}</span>${document.error ? `<small class="iv-document-error">${escapeHtml(document.error)}</small>` : ''}${document.cancellationMessage ? `<small>${escapeHtml(document.cancellationMessage)}</small>` : ''}</td><td data-label="Acciones"><div class="iv-doc-actions">${actions}</div></td></tr>`;
  }).join('')}</tbody></table>`;
  bindDocumentActions();
}

function splitDocumentKey(value) { const [type,id] = String(value || '').split(':'); return { type,id:Number(id) }; }

async function loadCreditSources(selected = '') {
  const search = $('#creditSourceSearch').value.trim();
  const query = new URLSearchParams({ type: 'direct', status: 'active', search, limit: '50', page: '1' });
  const data = await api(`/api/invoicing/documents?${query}`);
  const rows = data.rows || [];
  const current = DOCUMENTS.find((row) => `${row.type}:${row.id}` === selected && row.status === 'active');
  if (current && !rows.some((row) => `${row.type}:${row.id}` === selected)) rows.unshift(current);
  $('#creditSource').innerHTML = `<option value="">${rows.length ? 'Selecciona una factura' : 'No hay coincidencias; busca por folio o UUID'}</option>${rows.map((row) => `<option value="${row.type}:${row.id}">${escapeHtml(row.series)}-${escapeHtml(row.folio)} · ${escapeHtml(row.receiver?.rfc || '')} · ${formatMoney(row.total)}</option>`).join('')}`;
  if (selected) $('#creditSource').value = selected;
}

async function loadReceivables(selected = '') {
  const data = await api('/api/invoicing/receivables'); RECEIVABLES = data.rows || [];
  const select = $('#paymentSource');
  select.innerHTML = `<option value="">${RECEIVABLES.length ? 'Selecciona una factura PPD' : 'No hay facturas PPD con saldo'}</option>${RECEIVABLES.map((row) => `<option value="${row.type}:${row.id}">${escapeHtml(row.series)}-${escapeHtml(row.folio)} · ${escapeHtml(row.receiver?.rfc || '')} · saldo ${formatMoney(row.balance)}</option>`).join('')}`;
  if (selected) select.value = selected;
}

function bindDocumentActions() {
  document.querySelectorAll('[data-email-document]').forEach((button) => button.onclick = async () => { const email = prompt('Correo al que se enviará el CFDI'); if (!email) return; const {type,id}=splitDocumentKey(button.dataset.emailDocument); try { await api(`/api/invoicing/documents/${type}/${id}/email`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});toast('CFDI enviado por correo'); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-cancel-document]').forEach((button) => button.onclick = async () => {
    const motive = prompt('Motivo SAT: 01 con relación, 02 errores sin relación, 03 operación no realizada, 04 operación nominativa de global', '02');
    if (!motive) return;
    const replacementUuid = motive === '01' ? prompt('UUID del CFDI sustituto (debe tener relación 04)', '') : '';
    if (motive === '01' && !replacementUuid) return;
    if (!confirm('Se enviará la solicitud de cancelación al SAT mediante Facturama. ¿Continuar?')) return;
    const { type, id } = splitDocumentKey(button.dataset.cancelDocument);
    try {
      const result = await api(`/api/invoicing/documents/${type}/${id}/cancel`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ motive, replacementUuid }) });
      const status = result.document?.status;
      toast(status === 'canceled' ? 'CFDI cancelado y conservado en el historial'
        : status === 'active' ? 'La cancelación no procedió; el CFDI continúa vigente'
        : 'Solicitud enviada; espera la respuesta del receptor');
      await loadDocuments();
    } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll('[data-refresh-document]').forEach((button) => button.onclick = async () => { const {type,id}=splitDocumentKey(button.dataset.refreshDocument); try { await api(`/api/invoicing/documents/${type}/${id}/refresh-cancellation`,{method:'POST'});toast('Estado actualizado');await loadDocuments(); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-reconcile-document]').forEach((button) => button.onclick = async () => { const {type,id}=splitDocumentKey(button.dataset.reconcileDocument); try { const result=await api(`/api/invoicing/documents/${type}/${id}/reconcile`,{method:'POST'});toast(result.message || (result.found ? 'CFDI conciliado' : 'Aún sin confirmación'));await loadDocuments(); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-credit-document]').forEach((button) => button.onclick = () => setView('payments', { credit: button.dataset.creditDocument }));
  document.querySelectorAll('[data-payment-document]').forEach((button) => button.onclick = () => setView('payments', { receivable: button.dataset.paymentDocument }));
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
  $('#fiscalProductCode').value = profile.default_product_code || '01010101';
  $('#fiscalUnitCode').value = profile.default_unit_code || 'E48';
  $('#fiscalUnitName').value = profile.default_unit_name || 'Unidad de servicio';
  $('#fiscalTaxObject').value = profile.default_tax_object || '02';
  $('#fiscalIsrRate').value = String(Number(profile.default_isr_rate ?? 0));
}

function fiscalEmitterReady(emitter) {
  return Boolean(emitter?.enabled && emitter.rfc && emitter.legal_name && emitter.fiscal_regime && emitter.postal_code
    && (emitter.csd_uploaded || emitter.api_mode === 'web' || emitter.sandbox_shared));
}

function updateCsdFormState() {
  const emitters = INVOICING?.emitters || [];
  const selected = emitters.find((item) => String(item.id) === $('#csdEmitter').value);
  const canUpload = Boolean(selected && selected.enabled && selected.rfc && selected.api_mode !== 'web' && !selected.sandbox_shared);
  const webIssuer = emitters.some((item) => item.enabled && item.api_mode === 'web');
  const sharedIssuer = emitters.some((item) => item.enabled && item.sandbox_shared);
  const message = canUpload
    ? selected.csd_uploaded
      ? `El CSD de ${selected.rfc} ya está cargado. Puedes reemplazarlo con un nuevo .cer, .key y contraseña.`
      : `Carga el .cer, el .key y la contraseña del RFC ${selected.rfc}. Se validarán para preparar el timbrado.`
    : webIssuer
      ? 'Este RFC usa la API Web de Facturama. Sus sellos digitales se administran en el perfil de Facturama; aquí no se requiere cargarlos.'
      : sharedIssuer
        ? 'El emisor compartido de pruebas no requiere cargar sellos digitales.'
        : 'Primero completa y guarda los datos fiscales del emisor principal. Después podrás seleccionar su CSD aquí.';
  $('#csdGuidance').textContent = message;
  $('#csdGuidance').classList.toggle('ready', canUpload);
  $('#csdState').innerHTML = canUpload
    ? selected.csd_uploaded ? '<i class="ph-bold ph-check-circle"></i> CSD cargado' : '<i class="ph-bold ph-upload-simple"></i> Listo para cargar'
    : webIssuer ? '<i class="ph-bold ph-cloud-check"></i> Gestionado en Facturama'
      : sharedIssuer ? '<i class="ph-bold ph-check-circle"></i> No requerido'
        : '<i class="ph-bold ph-clock"></i> Pendiente';
  $('#csdForm').querySelectorAll('input, select, button[type="submit"]').forEach((control) => { control.disabled = !canUpload; });
}

function renderEmitterOptions() {
  const emitters = INVOICING.emitters || [];
  for (const selector of ['#directEmitter', '#manualGlobalEmitter']) {
    const select = $(selector);
    const previous = select.value;
    select.innerHTML = `<option value="">Selecciona un emisor listo</option>${emitters.map((emitter) => `<option value="${Number(emitter.id)}" ${fiscalEmitterReady(emitter) ? '' : 'disabled'}>${escapeHtml(emitter.label || emitter.legal_name || emitter.rfc || `Emisor ${emitter.id}`)} · ${escapeHtml(emitter.rfc || 'Sin RFC')}${fiscalEmitterReady(emitter) ? '' : ' · pendiente'}</option>`).join('')}`;
    const preferred = emitters.find((item) => Number(item.id) === Number(previous) && fiscalEmitterReady(item))
      || emitters.find((item) => fiscalEmitterReady(item));
    select.value = preferred ? String(preferred.id) : '';
  }
  const csdSelect = $('#csdEmitter');
  const previousCsd = csdSelect.value;
  const uploadable = emitters.filter((item) => item.enabled && item.rfc && item.api_mode !== 'web' && !item.sandbox_shared);
  csdSelect.innerHTML = `<option value="">Selecciona un emisor</option>${uploadable.map((item) => `<option value="${Number(item.id)}">${escapeHtml(item.label || item.legal_name || item.rfc)} · ${escapeHtml(item.rfc)}</option>`).join('')}`;
  csdSelect.value = uploadable.some((item) => String(item.id) === previousCsd) ? previousCsd : uploadable.length ? String(uploadable[0].id) : '';
  $('#directEmitterStatus').textContent = emitters.some(fiscalEmitterReady) ? '' : 'Completa un emisor y carga su CSD en Configuración fiscal antes de timbrar.';
  updateCsdFormState();
}

$('#csdEmitter').addEventListener('change', updateCsdFormState);

function resetFiscalEmitterForm() {
  $('#fiscalEmitterForm').reset();
  $('#fiscalEmitterId').value = '';
  $('#fiscalEmitterSeries').value = INVOICING?.profile?.series || 'FAC';
  $('#fiscalEmitterProductCode').value = INVOICING?.profile?.default_product_code || '01010101';
  $('#fiscalEmitterUnitCode').value = INVOICING?.profile?.default_unit_code || 'E48';
  $('#fiscalEmitterUnitName').value = INVOICING?.profile?.default_unit_name || 'Unidad de servicio';
  $('#fiscalEmitterTaxObject').value = INVOICING?.profile?.default_tax_object || '02';
  $('#fiscalEmitterIvaRate').value = String(Number(INVOICING?.profile?.default_iva_rate ?? .16));
  $('#fiscalEmitterIsrRate').value = String(Number(INVOICING?.profile?.default_isr_rate ?? 0));
}

function renderFiscalEmitters() {
  const emitters = (INVOICING.emitters || []).filter((item) => Number(item.id) !== 1);
  $('#fiscalEmittersList').innerHTML = emitters.length ? emitters.map((item) => `<div class="iv-emitter-row"><div><b>${escapeHtml(item.label || item.legal_name)}</b><small>${escapeHtml(item.rfc)} · ${item.enabled ? 'Activo' : 'Inactivo'} · ${fiscalEmitterReady(item) ? 'Listo para timbrar' : 'Falta CSD o configuración'}</small></div><div><button class="iv-btn iv-btn-secondary" type="button" data-edit-emitter="${Number(item.id)}">Editar</button><button class="iv-btn iv-btn-secondary" type="button" data-delete-emitter="${Number(item.id)}">Eliminar</button></div></div>`).join('') : '<p class="iv-hint">Por ahora solo tienes el emisor principal.</p>';
  document.querySelectorAll('[data-edit-emitter]').forEach((button) => button.onclick = () => {
    const item = emitters.find((row) => Number(row.id) === Number(button.dataset.editEmitter));
    if (!item) return;
    const values = { Id: item.id, Label: item.label, Rfc: item.rfc, LegalName: item.legal_name,
      Regime: item.fiscal_regime, Postal: item.postal_code, Series: item.series,
      ProductCode: item.default_product_code, UnitCode: item.default_unit_code,
      UnitName: item.default_unit_name, TaxObject: item.default_tax_object,
      IvaRate: Number(item.default_iva_rate ?? .16), IsrRate: Number(item.default_isr_rate ?? 0) };
    for (const [key, value] of Object.entries(values)) $(`#fiscalEmitter${key}`).value = value ?? '';
    $('#fiscalEmitterEnabled').checked = Boolean(item.enabled);
    $('#fiscalEmitterForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.querySelectorAll('[data-delete-emitter]').forEach((button) => button.onclick = async () => {
    if (!confirm('¿Eliminar este emisor fiscal? Los emisores con CFDI emitidos no se pueden borrar.')) return;
    try { await api(`/api/invoicing/emitters/${button.dataset.deleteEmitter}`, { method: 'DELETE' });
      toast('Emisor eliminado'); await initialize(); } catch (error) { toast(error.message, true); }
  });
}

$('#resetFiscalEmitter').addEventListener('click', resetFiscalEmitterForm);
$('#fiscalEmitterForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = Number($('#fiscalEmitterId').value || 0);
  const body = { label: $('#fiscalEmitterLabel').value.trim(), enabled: $('#fiscalEmitterEnabled').checked,
    rfc: $('#fiscalEmitterRfc').value.trim(), legalName: $('#fiscalEmitterLegalName').value.trim(),
    fiscalRegime: $('#fiscalEmitterRegime').value.trim(), postalCode: $('#fiscalEmitterPostal').value.trim(),
    series: $('#fiscalEmitterSeries').value.trim(), defaultProductCode: $('#fiscalEmitterProductCode').value.trim(),
    defaultUnitCode: $('#fiscalEmitterUnitCode').value.trim(), defaultUnitName: $('#fiscalEmitterUnitName').value.trim(),
    defaultTaxObject: $('#fiscalEmitterTaxObject').value, defaultIvaRate: Number($('#fiscalEmitterIvaRate').value),
    defaultIsrRate: Number($('#fiscalEmitterIsrRate').value), defaultCardPaymentForm: '04' };
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try { await api(id ? `/api/invoicing/emitters/${id}` : '/api/invoicing/emitters', {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }); toast(id ? 'Emisor actualizado' : 'Emisor agregado'); await initialize(); resetFiscalEmitterForm(); }
  catch (error) { toast(error.message, true); } finally { button.disabled = false; }
});

const viewMetadata = {
  summary: ['Resumen fiscal', 'Estado de tu cuenta y portal de facturación.'],
  'new-invoice': ['Nueva factura', 'Emite un CFDI a partir de una venta de tu propio punto de venta.'],
  'manual-global': ['Factura global manual', 'Concentra ventas de público en general de tu sistema externo.'],
  payments: ['Cobranza y REP', 'Complementos de pago 2.0 y notas de crédito relacionadas.'],
  documents: ['CFDI emitidos', 'Consulta el expediente fiscal de tu negocio.'],
  portal: ['Mi portal', 'La experiencia pública con la identidad de tu negocio.'],
  settings: ['Configuración fiscal', 'Datos del emisor y Certificado de Sello Digital.'],
};

function setView(view, options = {}) {
  const safeView = viewMetadata[view] ? view : 'summary';
  document.querySelectorAll('.iv-view').forEach((section) => section.classList.toggle('active', section.id === `view-${safeView}`));
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === safeView));
  [$('#viewTitle').textContent, $('#viewSubtitle').textContent] = viewMetadata[safeView];
  history.replaceState(null, '', `#${safeView}`);
  setMobileMenu(false);
  if (safeView === 'payments') {
    loadReceivables(options.receivable || '').catch((error) => toast(error.message, true));
    loadCreditSources(options.credit || '').catch((error) => toast(error.message, true));
  }
}

function setMobileMenu(open) {
  const sidebar = $('#sidebar');
  const button = $('#menuButton');
  sidebar.classList.toggle('open', Boolean(open));
  document.body.classList.toggle('iv-menu-open', Boolean(open));
  button.setAttribute('aria-expanded', String(Boolean(open)));
}

function focusMissingFiscalField() {
  const requiredFields = ['#rfc', '#legalName', '#fiscalRegime', '#postalCode'];
  const missing = requiredFields.map((selector) => $(selector)).find((field) => !String(field.value || '').trim());
  const target = missing || $('#fiscalForm');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  missing?.focus({ preventScroll: true });
}

function openFiscalChecklistStep(step) {
  setView('settings');
  requestAnimationFrame(() => {
    if (step === 'profile' || !$('#checkProfile').classList.contains('done')) {
      focusMissingFiscalField();
      return;
    }
    if (step === 'csd' || (step === 'activation' && !$('#checkCsd').classList.contains('done'))) {
      const target = $('#csdForm');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!$('#certificate').disabled) $('#certificate').focus({ preventScroll: true });
      return;
    }
    $('#activationStatus').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('Tu expediente está completo. El equipo de soporte debe activar el servicio y la bolsa de timbres.');
  });
}

document.querySelectorAll('[data-setup-step]').forEach((button) => {
  button.addEventListener('click', () => openFiscalChecklistStep(button.dataset.setupStep));
});

let creditSourceSearchTimer = null;
$('#creditSourceSearch').addEventListener('input', () => {
  clearTimeout(creditSourceSearchTimer);
  creditSourceSearchTimer = setTimeout(() => loadCreditSources().catch((error) => toast(error.message, true)), 250);
});

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$('#menuButton').addEventListener('click', () => setMobileMenu(!$('#sidebar').classList.contains('open')));
document.addEventListener('click', (event) => {
  if ($('#sidebar').classList.contains('open') && !$('#sidebar').contains(event.target) && !$('#menuButton').contains(event.target)) setMobileMenu(false);
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('#sidebar').classList.contains('open')) setMobileMenu(false); });
$('#reloadDocuments').addEventListener('click', () => loadDocuments().then(() => toast('Documentos actualizados')).catch((error) => toast(error.message, true)));
$('#documentFilters').addEventListener('submit', (event) => {
  event.preventDefault();
  DOCUMENT_QUERY = { ...DOCUMENT_QUERY, page: 1, search: $('#documentSearch').value.trim(), type: $('#documentType').value,
    status: $('#documentStatus').value, dateFrom: $('#documentDateFrom').value, dateTo: $('#documentDateTo').value };
  loadDocuments().catch((error) => toast(error.message, true));
});
$('#clearDocumentFilters').addEventListener('click', () => {
  $('#documentFilters').reset();
  DOCUMENT_QUERY = { ...DOCUMENT_QUERY, page: 1, type: 'all', status: 'all', dateFrom: '', dateTo: '', search: '' };
  loadDocuments().catch((error) => toast(error.message, true));
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.replace('/facturacion/login'); });

function updateDirectReceiverMode() {
  const publicGeneral = document.querySelector('input[name="directReceiverMode"]:checked')?.value === 'public';
  $('#directReceiverFields').hidden = publicGeneral;
  $('#directPublicSummary').hidden = !publicGeneral;
  ['#directReceiverRfc','#directReceiverName','#directReceiverRegime','#directReceiverPostal','#directReceiverUse'].forEach((selector) => { $(selector).required = !publicGeneral; });
  const ppdOption = $('#directPaymentMethod')?.querySelector('option[value="PPD"]');
  if (ppdOption) ppdOption.disabled = publicGeneral;
  if (publicGeneral && $('#directPaymentMethod')) { $('#directPaymentMethod').value = 'PUE'; $('#directPaymentMethod').dispatchEvent(new Event('change')); }
}

function localDateForInput(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function installDirectFiscalControls() {
  const paymentForm = $('#directPaymentForm');
  paymentForm.innerHTML = `<option value="01">01 · Efectivo</option><option value="02">02 · Cheque nominativo</option><option value="03">03 · Transferencia electrónica</option><option value="04">04 · Tarjeta de crédito</option><option value="05">05 · Monedero electrónico</option><option value="06">06 · Dinero electrónico</option><option value="08">08 · Vales de despensa</option><option value="12">12 · Dación en pago</option><option value="13">13 · Pago por subrogación</option><option value="14">14 · Pago por consignación</option><option value="15">15 · Condonación</option><option value="17">17 · Compensación</option><option value="23">23 · Novación</option><option value="24">24 · Confusión</option><option value="25">25 · Remisión de deuda</option><option value="26">26 · Prescripción o caducidad</option><option value="27">27 · A satisfacción del acreedor</option><option value="28">28 · Tarjeta de débito</option><option value="29">29 · Tarjeta de servicios</option><option value="30">30 · Aplicación de anticipos</option><option value="31">31 · Intermediario de pagos</option>`;
  const paymentWrap = paymentForm.closest('.iv-field');
  paymentWrap.insertAdjacentHTML('beforebegin', `<div class="iv-field"><label for="directPaymentMethod">Método de pago *</label><div class="iv-input"><i class="ph-bold ph-calendar-check"></i><select id="directPaymentMethod"><option value="PUE">PUE · Pagado al emitir</option><option value="PPD">PPD · Pago diferido o parcialidades</option></select></div></div>`);
  paymentWrap.id = 'directPaymentFormWrap';
  paymentWrap.closest('.iv-form-grid').insertAdjacentHTML('beforeend', `<div class="iv-field iv-span-2"><details><summary>Relacionar o sustituir otro CFDI</summary><div class="iv-form-grid" style="margin-top:12px"><div class="iv-field"><label>Tipo de relación</label><select id="directRelationType"><option value="">Sin relación</option><option value="04">04 · Sustitución de CFDI previos</option><option value="07">07 · Aplicación de anticipo</option></select></div><div class="iv-field"><label>UUID relacionado</label><input id="directRelatedUuid" maxlength="36" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" /></div></div></details></div>`);
  $('#directRelationType').addEventListener('change', () => { $('#directRelatedUuid').required = Boolean($('#directRelationType').value); });
  const receiverRegime = $('#directReceiverRegime');
  if (receiverRegime?.tagName === 'SELECT') {
    const replacement = document.createElement('input');
    replacement.id = receiverRegime.id;
    replacement.maxLength = 3;
    replacement.inputMode = 'numeric';
    replacement.placeholder = 'Ej. 612';
    receiverRegime.replaceWith(replacement);
  }
  const receiverUse = $('#directReceiverUse');
  receiverUse.innerHTML = `<optgroup label="Usos generales"><option value="G01">G01 · Adquisición de mercancías</option><option value="G02">G02 · Devoluciones, descuentos o bonificaciones</option><option value="G03" selected>G03 · Gastos en general</option></optgroup><optgroup label="Inversiones"><option value="I01">I01 · Construcciones</option><option value="I02">I02 · Mobiliario y equipo de oficina</option><option value="I03">I03 · Equipo de transporte</option><option value="I04">I04 · Equipo de cómputo y accesorios</option><option value="I05">I05 · Dados, troqueles, moldes y herramental</option><option value="I06">I06 · Comunicaciones telefónicas</option><option value="I07">I07 · Comunicaciones satelitales</option><option value="I08">I08 · Otra maquinaria y equipo</option></optgroup><optgroup label="Deducciones personales"><option value="D01">D01 · Honorarios médicos y gastos hospitalarios</option><option value="D02">D02 · Gastos médicos por incapacidad o discapacidad</option><option value="D03">D03 · Gastos funerales</option><option value="D04">D04 · Donativos</option><option value="D05">D05 · Intereses reales por créditos hipotecarios</option><option value="D06">D06 · Aportaciones voluntarias al SAR</option><option value="D07">D07 · Primas de seguros de gastos médicos</option><option value="D08">D08 · Transportación escolar obligatoria</option><option value="D09">D09 · Depósitos para ahorro y pensiones</option><option value="D10">D10 · Pagos por servicios educativos</option></optgroup><optgroup label="Otros"><option value="S01">S01 · Sin efectos fiscales</option></optgroup>`;
  $('#directPaymentMethod').addEventListener('change', () => {
    const ppd = $('#directPaymentMethod').value === 'PPD'; paymentWrap.hidden = ppd; paymentForm.required = !ppd;
  });
}

function directConceptMode() {
  return document.querySelector('input[name="directConceptMode"]:checked')?.value === 'detailed' ? 'detailed' : 'total';
}

function addDirectConcept(name = '', quantity = '1', unitPrice = '') {
  const list = $('#directItems');
  if (list.children.length >= 50) return toast('Puedes agregar hasta 50 conceptos.', true);
  const row = document.createElement('div');
  row.className = 'iv-direct-item';
  row.innerHTML = `<label><span>Producto o servicio</span><input class="direct-item-name" maxlength="240" required placeholder="Ej. Platillo o servicio" /></label><label><span>Cantidad</span><input class="direct-item-qty" type="number" min="0.001" max="100000" step="0.001" required value="1" /></label><label><span>Precio unitario con impuestos</span><input class="direct-item-price" type="number" min="0.01" max="9999999999.99" step="0.01" required placeholder="0.00" /></label><button class="iv-direct-item-remove" type="button" aria-label="Quitar concepto"><i class="ph-bold ph-trash"></i></button>`;
  row.querySelector('.direct-item-name').value = name;
  row.querySelector('.direct-item-qty').value = quantity;
  row.querySelector('.direct-item-price').value = unitPrice;
  row.querySelectorAll('input').forEach((input) => input.addEventListener('input', updateDirectConceptTotal));
  row.querySelector('.iv-direct-item-remove').addEventListener('click', () => { row.remove(); updateDirectConceptTotal(); });
  list.append(row);
  updateDirectConceptTotal();
}

function updateDirectConceptTotal() {
  const amount = [...document.querySelectorAll('.iv-direct-item')].reduce((sum, row) => {
    const qty = Number(row.querySelector('.direct-item-qty').value || 0);
    const price = Number(row.querySelector('.direct-item-price').value || 0);
    return sum + Math.round(qty * price * 100) / 100;
  }, 0);
  $('#directItemsTotal').value = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(amount);
}

function updateDirectConceptMode() {
  const detailed = directConceptMode() === 'detailed';
  $('#directSingleConcept').hidden = detailed;
  $('#directSingleTotal').hidden = detailed;
  $('#directDescription').required = !detailed;
  $('#directTotal').required = !detailed;
  $('#directItemsField').hidden = !detailed;
  $('#directCalculatedTotal').hidden = !detailed;
  $('#directItems').querySelectorAll('input').forEach((input) => { input.required = detailed; });
  if (detailed && !$('#directItems').children.length) addDirectConcept();
}

document.querySelectorAll('input[name="directConceptMode"]').forEach((input) => input.addEventListener('change', updateDirectConceptMode));
$('#addDirectItem').addEventListener('click', () => addDirectConcept());
updateDirectConceptMode();

document.querySelectorAll('input[name="directReceiverMode"]').forEach((input) => input.addEventListener('change', updateDirectReceiverMode));
$('#directSaleDate').value = localDateForInput();
installDirectFiscalControls();
[['607','Enajenación o adquisición de bienes'],['608','Demás ingresos'],['610','Residentes en el extranjero'],['611','Ingresos por dividendos'],['614','Ingresos por intereses'],['615','Obtención de premios'],['620','Sociedades cooperativas de producción'],['622','Actividades agrícolas, ganaderas, silvícolas y pesqueras'],['623','Opcional para grupos de sociedades'],['624','Coordinados']].forEach(([value,label]) => { if (!$('#fiscalRegime').querySelector(`option[value="${value}"]`)) $('#fiscalRegime').add(new Option(`${value} · ${label}`, value)); });
updateDirectReceiverMode();
$('#directSuccessClose').addEventListener('click', () => { $('#directInvoiceSuccess').hidden = true; });
$('#directInvoiceSuccess').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.hidden = true; });
$('#directSuccessEmailForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = Number(event.currentTarget.dataset.invoiceId);
  if (!id) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/invoicing/documents/direct/${id}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#directSuccessEmail').value.trim() }) });
    $('#directSuccessEmailStatus').textContent = 'Factura enviada al correo indicado.';
  } catch (error) { $('#directSuccessEmailStatus').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#directInvoiceForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const publicGeneral = document.querySelector('input[name="directReceiverMode"]:checked')?.value === 'public';
  button.disabled = true;
  try {
    if (!form.dataset.requestKey) form.dataset.requestKey = crypto.randomUUID();
    const conceptMode = directConceptMode();
    const items = conceptMode === 'detailed' ? [...form.querySelectorAll('.iv-direct-item')].map((row) => ({
      name: row.querySelector('.direct-item-name').value.trim(), qty: Number(row.querySelector('.direct-item-qty').value),
      price: Number(row.querySelector('.direct-item-price').value),
    })) : [];
    const result = await api('/api/invoicing/direct-invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requestKey: form.dataset.requestKey, emitterId: Number($('#directEmitter').value), externalReference: $('#directReference').value, saleDate: $('#directSaleDate').value,
        conceptMode, items, description: $('#directDescription').value, total: conceptMode === 'detailed'
          ? items.reduce((sum, item) => sum + Math.round(item.qty * item.price * 100) / 100, 0) : Number($('#directTotal').value), paymentMethod: $('#directPaymentMethod').value,
        paymentForm: $('#directPaymentForm').value, relationType: $('#directRelationType').value, relatedUuid: $('#directRelatedUuid').value,
        publicGeneral, receiver: publicGeneral ? null : { rfc: $('#directReceiverRfc').value, name: $('#directReceiverName').value,
          fiscalRegime: $('#directReceiverRegime').value, postalCode: $('#directReceiverPostal').value,
          cfdiUse: $('#directReceiverUse').value, email: $('#directReceiverEmail').value },
      }),
    });
    const document = result.invoice;
    if (document.status !== 'active' || !document.providerId) {
      toast('La emisión sigue por verificar. Consulta el estado en CFDI emitidos antes de volver a intentarlo.', true);
      await loadDocuments(); setView('documents');
      return;
    }
    const base = `/api/invoicing/direct-invoices/${document.id}`;
    $('#directSuccessUuid').textContent = document.uuid || `${document.series}-${document.folio}`;
    $('#directSuccessPdf').href = `${base}/pdf`; $('#directSuccessXml').href = `${base}/xml`;
    $('#directSuccessEmailForm').dataset.invoiceId = String(document.id);
    $('#directSuccessEmail').value = publicGeneral ? '' : $('#directReceiverEmail').value.trim();
    $('#directSuccessEmailStatus').textContent = '';
    $('#directInvoiceSuccess').hidden = false;
    toast(result.message || 'Factura timbrada correctamente');
    form.reset(); form.dataset.requestKey = ''; $('#directItems').replaceChildren(); $('#directSaleDate').value = localDateForInput(); $('#directPaymentMethod').dispatchEvent(new Event('change')); $('#directRelationType').dispatchEvent(new Event('change')); updateDirectReceiverMode(); updateDirectConceptMode();
    await initialize();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

const today = new Date();
$('#manualGlobalDate').value = today.toISOString().slice(0,10);
$('#manualGlobalYear').value = String(today.getFullYear());
$('#paymentDate').value = new Date(today.getTime()-today.getTimezoneOffset()*60000).toISOString().slice(0,16);

function syncManualGlobalMonths() {
  const month = $('#manualGlobalMonth');
  const bimonthly = $('#manualGlobalPeriodicity').value === '05';
  const referenceDate = new Date();
  const choices = bimonthly
    ? [['13','Enero-Febrero'],['14','Marzo-Abril'],['15','Mayo-Junio'],['16','Julio-Agosto'],['17','Septiembre-Octubre'],['18','Noviembre-Diciembre']]
    : [['01','Enero'],['02','Febrero'],['03','Marzo'],['04','Abril'],['05','Mayo'],['06','Junio'],['07','Julio'],['08','Agosto'],['09','Septiembre'],['10','Octubre'],['11','Noviembre'],['12','Diciembre']];
  month.innerHTML = choices.map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
  month.value = bimonthly ? String(13 + Math.floor(referenceDate.getMonth() / 2)) : String(referenceDate.getMonth()+1).padStart(2,'0');
}

$('#manualGlobalPeriodicity').addEventListener('change', syncManualGlobalMonths);
syncManualGlobalMonths();

$('#manualGlobalForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');button.disabled=true;
  try{const result=await api('/api/invoicing/manual-global-invoices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({emitterId:Number($('#manualGlobalEmitter').value),externalReference:$('#manualGlobalReference').value,businessDate:$('#manualGlobalDate').value,description:$('#manualGlobalDescription').value,total:Number($('#manualGlobalTotal').value),paymentForm:$('#manualGlobalPaymentForm').value,periodicity:$('#manualGlobalPeriodicity').value,months:$('#manualGlobalMonth').value,year:Number($('#manualGlobalYear').value)})});toast(result.message);form.reset();renderEmitterOptions();const resetDate=new Date();$('#manualGlobalDate').value=resetDate.toISOString().slice(0,10);syncManualGlobalMonths();$('#manualGlobalYear').value=String(resetDate.getFullYear());$('#manualGlobalDescription').value='Ventas del día al público en general';await loadDocuments();setView('documents');}catch(error){toast(error.message,true);}finally{button.disabled=false;}
});

$('#paymentSource').addEventListener('change',()=>{const selected=RECEIVABLES.find((row)=>`${row.type}:${row.id}`===$('#paymentSource').value);if(selected)$('#paymentAmount').value=selected.balance.toFixed(2);});
$('#paymentComplementForm').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');button.disabled=true;try{const source=splitDocumentKey($('#paymentSource').value);const result=await api('/api/invoicing/payment-complements',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceType:source.type,sourceId:source.id,amount:Number($('#paymentAmount').value),paymentDate:new Date($('#paymentDate').value).toISOString(),paymentForm:$('#paymentForm').value,operationNumber:$('#paymentOperation').value})});toast(result.message);form.reset();const resetDate=new Date();$('#paymentDate').value=new Date(resetDate.getTime()-resetDate.getTimezoneOffset()*60000).toISOString().slice(0,16);await loadDocuments();await loadReceivables();setView('documents');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});

$('#creditNoteForm').addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');button.disabled=true;try{const source=splitDocumentKey($('#creditSource').value);const result=await api('/api/invoicing/credit-notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceType:source.type,sourceId:source.id,total:Number($('#creditTotal').value),description:$('#creditDescription').value,paymentForm:$('#creditPaymentForm').value})});toast(result.message);form.reset();await loadDocuments();setView('documents');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});

$('#fiscalForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/invoicing/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, rfc: $('#rfc').value, legalName: $('#legalName').value, fiscalRegime: $('#fiscalRegime').value, postalCode: $('#postalCode').value, series: $('#series').value, defaultProductCode: $('#fiscalProductCode').value, defaultUnitCode: $('#fiscalUnitCode').value, defaultUnitName: $('#fiscalUnitName').value, defaultTaxObject: $('#fiscalTaxObject').value, defaultIvaRate: Number($('#ivaRate').value), defaultIsrRate: Number($('#fiscalIsrRate').value), deliveryProductCode: $('#fiscalProductCode').value, defaultCardPaymentForm: '04' }) });
    toast('Datos fiscales guardados'); await initialize(); setView('settings');
  } catch (error) { toast(error.message, true); }
});

$('#csdForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/invoicing/csd', { method: 'POST', body: new FormData(form) });
    form.reset(); toast('Certificado de Sello Digital cargado'); await initialize(); setView('settings');
  } catch (error) { toast(error.message, true); }
});

$('#identityForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/settings', { method: 'PUT', body: new FormData(event.currentTarget) });
    toast('Identidad del portal actualizada'); await initialize(); setView('portal');
  } catch (error) { toast(error.message, true); }
});

$('#setupLogo').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    event.target.value = '';
    return toast('El logotipo no puede superar 8 MB', true);
  }
  $('#setupLogoPreview').innerHTML = `<img src="${URL.createObjectURL(file)}" alt="Vista previa del logotipo" />`;
});

$('#invoicingSetupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#invoicingSetupSubmit');
  const errorBox = $('#invoicingSetupError');
  const identity = new FormData();
  const businessName = $('#setupBusinessName').value.trim();
  if (businessName.length >= 2) identity.append('business_name', businessName);
  identity.append('primary_color', $('#setupColor').value);
  const logo = $('#setupLogo').files?.[0];
  if (logo) identity.append('logo', logo);
  button.disabled = true;
  button.innerHTML = '<i class="ph-bold ph-spinner-gap"></i> Preparando tu espacio fiscal…';
  errorBox.hidden = true;
  try {
    await api('/api/settings', { method: 'PUT', body: identity });
    await api('/api/invoicing/profile-draft', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        rfc: $('#setupRfc').value, legalName: $('#setupLegalName').value,
        fiscalRegime: $('#setupFiscalRegime').value, postalCode: $('#setupPostalCode').value,
      }),
    });
    await api('/api/auth/identity/complete', { method: 'POST' });
    $('#invoicingSetupModal').hidden = true;
    document.body.classList.remove('iv-journey-open');
    await initialize();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.innerHTML = '<i class="ph-bold ph-arrow-right"></i> Guardar lo que tengo y continuar';
  }
});

$('#invoicingWelcomeExplore').addEventListener('click', () => completeInvoicingWelcome('summary').catch((error) => toast(error.message, true)));
$('#invoicingWelcomeConfigure').addEventListener('click', () => completeInvoicingWelcome('settings').catch((error) => toast(error.message, true)));

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
  renderSummary(); renderPortal(); fillProfile(); fillIdentity(); renderEmitterOptions(); renderFiscalEmitters(); await loadDocuments();
  $('#loading').hidden = true;
  setView(location.hash.slice(1) || 'summary');
  presentInvoicingStartup();
}

initialize().catch((error) => { $('#loading').innerHTML = `<span>${escapeHtml(error.message)}</span>`; toast(error.message, true); });
