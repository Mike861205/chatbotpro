const $ = (selector) => document.querySelector(selector);
let ME = null;
let INVOICING = null;
let DOCUMENTS = [];
let RECEIVABLES = [];

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
  DOCUMENTS = data.rows || [];
  $('#metricInvoices').textContent = String(data.pagination?.total ?? data.rows.length);
  if (!data.rows.length) {
    $('#documentsTable').innerHTML = '<div class="iv-empty"><i class="ph-bold ph-file-dashed"></i>Aún no hay CFDI emitidos en esta cuenta.</div>';
    return;
  }
  $('#documentsTable').innerHTML = `<table class="iv-table"><thead><tr><th>Comprobante</th><th>Fecha</th><th>Receptor</th><th>Total</th><th>Pago</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${data.rows.map((document) => {
    const base = document.type === 'global' ? `/api/invoicing/global-invoices/${document.id}` : document.type === 'payment' ? `/api/invoicing/payment-complements/${document.id}` : ['direct','manual_global','credit_note'].includes(document.type) ? `/api/invoicing/direct-invoices/${document.id}` : `/api/invoicing/invoices/${document.id}`;
    const typeLabel = ({direct:'Venta externa',global:'Global POS',manual_global:'Global manual',credit_note:'Nota de crédito',payment:'Complemento de pago',individual:'Ticket'})[document.type] || document.type;
    const files = document.providerId ? `<a class="iv-btn iv-btn-secondary" href="${base}/pdf" target="_blank">PDF</a><a class="iv-btn iv-btn-secondary" href="${base}/xml" target="_blank">XML</a>` : '';
    const noteAction = document.status === 'active' && ['individual','global','direct'].includes(document.type) ? `<button class="iv-btn iv-btn-secondary" data-credit-document="${document.type}:${document.id}">Nota</button>` : '';
    const paymentAction = document.status === 'active' && document.paymentMethod === 'PPD' && ['individual','global','direct'].includes(document.type) ? `<button class="iv-btn iv-btn-primary" data-payment-document="${document.type}:${document.id}">Registrar pago</button>` : '';
    const actions = `${files}${document.status === 'active' ? `<button class="iv-btn iv-btn-secondary" data-email-document="${document.type}:${document.id}">Correo</button>${paymentAction}${noteAction}<button class="iv-btn iv-btn-secondary" data-cancel-document="${document.type}:${document.id}">Cancelar</button>` : ''}${document.status === 'cancel_pending' ? `<button class="iv-btn iv-btn-secondary" data-refresh-document="${document.type}:${document.id}">Actualizar</button>` : ''}${document.status === 'unknown' ? `<button class="iv-btn iv-btn-secondary" data-reconcile-document="${document.type}:${document.id}">Conciliar</button>` : ''}${document.hasCancellationReceipt ? `<a class="iv-btn iv-btn-secondary" href="/api/invoicing/documents/${document.type}/${document.id}/cancellation-receipt" target="_blank">Acuse</a>` : ''}`;
    return `<tr><td><span class="iv-doc-type">${typeLabel}</span><b>${escapeHtml(document.series || '')}-${escapeHtml(document.folio || '')}</b><br><small>${escapeHtml(document.uuid || 'Sin UUID')}</small></td><td>${formatDate(document.issuedAt || document.createdAt)}</td><td>${escapeHtml(document.receiver?.rfc || '—')}</td><td>${formatMoney(document.total)}</td><td>${escapeHtml(document.paymentMethod || (document.type === 'payment' ? 'REP 2.0' : 'PUE'))}</td><td><span class="iv-doc-status ${escapeHtml(document.status)}">${escapeHtml(statusLabel(document.status))}</span></td><td><div class="iv-doc-actions">${actions}</div></td></tr>`;
  }).join('')}</tbody></table>`;
  bindDocumentActions();
  fillCreditSources();
}

function splitDocumentKey(value) { const [type,id] = String(value || '').split(':'); return { type,id:Number(id) }; }

function fillCreditSources(selected = '') {
  const select = $('#creditSource'); if (!select) return;
  const rows = DOCUMENTS.filter((row) => row.status === 'active' && ['individual','global','direct'].includes(row.type));
  select.innerHTML = `<option value="">Selecciona una factura</option>${rows.map((row) => `<option value="${row.type}:${row.id}">${escapeHtml(row.series)}-${escapeHtml(row.folio)} · ${escapeHtml(row.receiver?.rfc || '')} · ${formatMoney(row.total)}</option>`).join('')}`;
  if (selected) select.value = selected;
}

async function loadReceivables(selected = '') {
  const data = await api('/api/invoicing/receivables'); RECEIVABLES = data.rows || [];
  const select = $('#paymentSource');
  select.innerHTML = `<option value="">${RECEIVABLES.length ? 'Selecciona una factura PPD' : 'No hay facturas PPD con saldo'}</option>${RECEIVABLES.map((row) => `<option value="${row.type}:${row.id}">${escapeHtml(row.series)}-${escapeHtml(row.folio)} · ${escapeHtml(row.receiver?.rfc || '')} · saldo ${formatMoney(row.balance)}</option>`).join('')}`;
  if (selected) select.value = selected;
}

function bindDocumentActions() {
  document.querySelectorAll('[data-email-document]').forEach((button) => button.onclick = async () => { const email = prompt('Correo al que se enviará el CFDI'); if (!email) return; const {type,id}=splitDocumentKey(button.dataset.emailDocument); try { await api(`/api/invoicing/documents/${type}/${id}/email`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});toast('CFDI enviado por correo'); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-cancel-document]').forEach((button) => button.onclick = async () => { const motive = prompt('Motivo SAT: 01 con relación, 02 errores sin relación, 03 operación no realizada, 04 operación nominativa de global','02'); if (!motive) return; const replacementUuid = motive === '01' ? prompt('UUID del CFDI sustituto (debe tener relación 04)','') : ''; if (motive === '01' && !replacementUuid) return; if (!confirm('Se enviará la solicitud de cancelación al SAT mediante Facturama. ¿Continuar?')) return; const {type,id}=splitDocumentKey(button.dataset.cancelDocument); try { await api(`/api/invoicing/documents/${type}/${id}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({motive,replacementUuid})});toast('Solicitud de cancelación enviada');await loadDocuments(); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-refresh-document]').forEach((button) => button.onclick = async () => { const {type,id}=splitDocumentKey(button.dataset.refreshDocument); try { await api(`/api/invoicing/documents/${type}/${id}/refresh-cancellation`,{method:'POST'});toast('Estado actualizado');await loadDocuments(); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-reconcile-document]').forEach((button) => button.onclick = async () => { const {type,id}=splitDocumentKey(button.dataset.reconcileDocument); try { const result=await api(`/api/invoicing/documents/${type}/${id}/reconcile`,{method:'POST'});toast(result.message || (result.found ? 'CFDI conciliado' : 'Aún sin confirmación'));await loadDocuments(); } catch(error){toast(error.message,true);} });
  document.querySelectorAll('[data-credit-document]').forEach((button) => button.onclick = () => { fillCreditSources(button.dataset.creditDocument); setView('payments'); });
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
}

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
  $('#sidebar').classList.remove('open');
  if (safeView === 'payments') loadReceivables(options.receivable || '').catch((error) => toast(error.message, true));
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
  const ppdOption = $('#directPaymentMethod')?.querySelector('option[value="PPD"]');
  if (ppdOption) ppdOption.disabled = publicGeneral;
  if (publicGeneral && $('#directPaymentMethod')) { $('#directPaymentMethod').value = 'PUE'; $('#directPaymentMethod').dispatchEvent(new Event('change')); }
}

function installDirectFiscalControls() {
  const paymentForm = $('#directPaymentForm');
  paymentForm.querySelector('option[value="99"]')?.remove();
  const paymentWrap = paymentForm.closest('.iv-field');
  paymentWrap.insertAdjacentHTML('beforebegin', `<div class="iv-field"><label for="directPaymentMethod">Método de pago *</label><div class="iv-input"><i class="ph-bold ph-calendar-check"></i><select id="directPaymentMethod"><option value="PUE">PUE · Pagado al emitir</option><option value="PPD">PPD · Pago diferido o parcialidades</option></select></div></div>`);
  paymentWrap.id = 'directPaymentFormWrap';
  paymentWrap.closest('.iv-form-grid').insertAdjacentHTML('beforeend', `<div class="iv-field iv-span-2"><details><summary>Relacionar o sustituir otro CFDI</summary><div class="iv-form-grid" style="margin-top:12px"><div class="iv-field"><label>Tipo de relación</label><select id="directRelationType"><option value="">Sin relación</option><option value="04">04 · Sustitución de CFDI previos</option><option value="07">07 · Aplicación de anticipo</option></select></div><div class="iv-field"><label>UUID relacionado</label><input id="directRelatedUuid" maxlength="36" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" /></div></div></details></div>`);
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

document.querySelectorAll('input[name="directReceiverMode"]').forEach((input) => input.addEventListener('change', updateDirectReceiverMode));
$('#directSaleDate').value = new Date().toISOString().slice(0, 10);
installDirectFiscalControls();
[['607','Enajenación o adquisición de bienes'],['608','Demás ingresos'],['610','Residentes en el extranjero'],['611','Ingresos por dividendos'],['614','Ingresos por intereses'],['615','Obtención de premios'],['620','Sociedades cooperativas de producción'],['622','Actividades agrícolas, ganaderas, silvícolas y pesqueras'],['623','Opcional para grupos de sociedades'],['624','Coordinados']].forEach(([value,label]) => { if (!$('#fiscalRegime').querySelector(`option[value="${value}"]`)) $('#fiscalRegime').add(new Option(`${value} · ${label}`, value)); });
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
        description: $('#directDescription').value, total: Number($('#directTotal').value), paymentMethod: $('#directPaymentMethod').value,
        paymentForm: $('#directPaymentForm').value, relationType: $('#directRelationType').value, relatedUuid: $('#directRelatedUuid').value,
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
    event.currentTarget.reset(); $('#directSaleDate').value = new Date().toISOString().slice(0, 10); $('#directPaymentMethod').dispatchEvent(new Event('change')); updateDirectReceiverMode();
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
  event.preventDefault(); const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;
  try{const result=await api('/api/invoicing/manual-global-invoices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({externalReference:$('#manualGlobalReference').value,businessDate:$('#manualGlobalDate').value,description:$('#manualGlobalDescription').value,total:Number($('#manualGlobalTotal').value),paymentForm:$('#manualGlobalPaymentForm').value,periodicity:$('#manualGlobalPeriodicity').value,months:$('#manualGlobalMonth').value,year:Number($('#manualGlobalYear').value)})});toast(result.message);event.currentTarget.reset();const resetDate=new Date();$('#manualGlobalDate').value=resetDate.toISOString().slice(0,10);syncManualGlobalMonths();$('#manualGlobalYear').value=String(resetDate.getFullYear());$('#manualGlobalDescription').value='Ventas del día al público en general';await loadDocuments();setView('documents');}catch(error){toast(error.message,true);}finally{button.disabled=false;}
});

$('#paymentSource').addEventListener('change',()=>{const selected=RECEIVABLES.find((row)=>`${row.type}:${row.id}`===$('#paymentSource').value);if(selected)$('#paymentAmount').value=selected.balance.toFixed(2);});
$('#paymentComplementForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;try{const source=splitDocumentKey($('#paymentSource').value);const result=await api('/api/invoicing/payment-complements',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceType:source.type,sourceId:source.id,amount:Number($('#paymentAmount').value),paymentDate:new Date($('#paymentDate').value).toISOString(),paymentForm:$('#paymentForm').value,operationNumber:$('#paymentOperation').value})});toast(result.message);event.currentTarget.reset();const resetDate=new Date();$('#paymentDate').value=new Date(resetDate.getTime()-resetDate.getTimezoneOffset()*60000).toISOString().slice(0,16);await loadDocuments();await loadReceivables();setView('documents');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});

$('#creditNoteForm').addEventListener('submit',async(event)=>{event.preventDefault();const button=event.currentTarget.querySelector('button[type="submit"]');button.disabled=true;try{const source=splitDocumentKey($('#creditSource').value);const result=await api('/api/invoicing/credit-notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceType:source.type,sourceId:source.id,total:Number($('#creditTotal').value),description:$('#creditDescription').value,paymentForm:$('#creditPaymentForm').value})});toast(result.message);event.currentTarget.reset();await loadDocuments();setView('documents');}catch(error){toast(error.message,true);}finally{button.disabled=false;}});

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
