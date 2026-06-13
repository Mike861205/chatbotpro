let SA_TENANTS = [];
let SA_FILTER = 'all';
let SA_SUMMARY = null;
let SA_PAYMENT_TENANT_ID = null;
let SA_SUSPEND_TENANT_ID = null;
let SA_ACTIVATE_TENANT_ID = null;
let SA_ACTIVATE_MODE = 'account';

const $ = (s) => document.querySelector(s);
let SA_CLOCK_TIMER = null;

function toast(msg, isErr = false) {
  const t = $('#toast');
  $('#toastMsg').textContent = msg;
  t.querySelector('i').className = isErr ? 'ph-fill ph-x-circle' : 'ph-fill ph-check-circle';
  t.className = isErr ? 'show err' : 'show ok';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.className = ''), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = '/superadmin/login';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
}

function normalizeLogoUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  return `/${value.replace(/^\/+/, '')}`;
}

function applySuperAdminLogo(rawUrl) {
  const logoUrl = normalizeLogoUrl(rawUrl);
  const logo = $('#saBrandLogo');
  const logoDot = $('#saBrandLogoDot');
  const preview = $('#saBrandLogoPreview');
  const previewIcon = $('#saBrandLogoPreviewIcon');

  if (logo && logoDot) {
    if (logoUrl) {
      logo.src = logoUrl;
      logo.hidden = false;
      logoDot.classList.add('has-image');
    } else {
      logo.removeAttribute('src');
      logo.hidden = true;
      logoDot.classList.remove('has-image');
    }
  }

  if (preview && previewIcon) {
    if (logoUrl) {
      preview.src = logoUrl;
      preview.hidden = false;
      previewIcon.hidden = true;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
      previewIcon.hidden = false;
    }
  }
}

function applySuperAdminLogoFromFile(file) {
  if (!file) {
    applySuperAdminLogo('');
    return;
  }
  const objectUrl = URL.createObjectURL(file);
  const logo = $('#saBrandLogo');
  const logoDot = $('#saBrandLogoDot');
  const preview = $('#saBrandLogoPreview');
  const previewIcon = $('#saBrandLogoPreviewIcon');

  if (logo && logoDot) {
    logo.src = objectUrl;
    logo.hidden = false;
    logoDot.classList.add('has-image');
  }

  if (preview && previewIcon) {
    preview.src = objectUrl;
    preview.hidden = false;
    previewIcon.hidden = true;
  }
}

function updateSuperAdminClock() {
  const now = new Date();
  const dateEl = $('#saNowDate');
  const timeEl = $('#saNowTime');
  if (dateEl) dateEl.textContent = now.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  if (timeEl) timeEl.textContent = now.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function startSuperAdminClock() {
  if (SA_CLOCK_TIMER) clearInterval(SA_CLOCK_TIMER);
  updateSuperAdminClock();
  SA_CLOCK_TIMER = setInterval(updateSuperAdminClock, 1000);
}

function fmtInputDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addOneMonth(dateText) {
  const base = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  const y = base.getFullYear();
  const m = base.getMonth();
  const d = base.getDate();
  const candidate = new Date(y, m + 1, d);
  if (candidate.getDate() === d) return candidate;
  return new Date(y, m + 2, 0);
}

function statusChip(type, value) {
  const map = {
    account_active: ['Activa', 'ok'],
    account_inactive: ['Inactiva', 'err'],
    billing_active: ['Al corriente', 'ok'],
    billing_due: ['Por pagar', 'warn'],
    billing_suspended: ['Suspendido', 'err'],
  };
  const [label, tone] = map[`${type}_${value}`] || [value || '—', ''];
  return `<span class="tag ${tone}">${label}</span>`;
}

function matchesTenantFilter(tenant, filter) {
  if (filter === 'all') return true;
  if (filter === 'active') return tenant.account_status === 'active';
  if (filter === 'inactive') return tenant.account_status === 'inactive';
  if (filter === 'current') return tenant.billing_status === 'active';
  if (filter === 'due') return tenant.billing_status === 'due';
  if (filter === 'suspended') return tenant.billing_status === 'suspended';
  if (filter === 'mora') return Number(tenant.mora_days || 0) > 0;
  if (filter === 'dueSoon5') {
    const days = Number(tenant.days_to_due);
    return Number.isFinite(days) && days >= 0 && days <= 5;
  }
  return true;
}

function getFilteredTenants() {
  const search = String($('#saTenantSearch')?.value || '').trim().toLowerCase();
  return SA_TENANTS.filter((t) => {
    if (!matchesTenantFilter(t, SA_FILTER)) return false;
    if (!search) return true;
    return [t.slug, t.business_name, t.owner_name, t.phone].join(' ').toLowerCase().includes(search);
  });
}

function syncFilterControls() {
  document.querySelectorAll('#saTenantFilters button').forEach((btn) => {
    const isActive = btn.dataset.status === SA_FILTER;
    btn.classList.toggle('active', isActive);
    btn.classList.toggle('on', isActive);
  });

  document.querySelectorAll('[data-sa-summary-filter]').forEach((card) => {
    card.classList.toggle('active', card.dataset.saSummaryFilter === SA_FILTER);
  });
}

function setTenantFilter(filter, announce = false) {
  SA_FILTER = filter || 'all';
  syncFilterControls();
  renderTenantTable();
  if (announce) {
    const count = getFilteredTenants().length;
    toast(`Mostrando ${count} tenant${count === 1 ? '' : 's'}`);
  }
}

function renderBillingSummary(summary) {
  SA_SUMMARY = summary || SA_SUMMARY;
  const s = SA_SUMMARY || {
    total: 0,
    activeTenants: 0,
    inactiveTenants: 0,
    billingCurrent: 0,
    billingDue: 0,
    billingSuspended: 0,
    dueSoon5: 0,
    inMora: 0,
  };
  const el = $('#saBillingSummary');
  if (!el) return;
  const cards = [
    { label: 'Total tenants', value: Number(s.total || 0), filter: 'all', tone: 'tone-total' },
    { label: 'Activos', value: Number(s.activeTenants || 0), filter: 'active', tone: 'tone-active' },
    { label: 'Inactivos', value: Number(s.inactiveTenants || 0), filter: 'inactive', tone: 'tone-inactive' },
    { label: 'Al corriente', value: Number(s.billingCurrent || 0), filter: 'current', tone: 'tone-current' },
    { label: 'Por pagar', value: Number(s.billingDue || 0), filter: 'due', tone: 'tone-due' },
    { label: 'Suspendidos', value: Number(s.billingSuspended || 0), filter: 'suspended', tone: 'tone-suspended' },
    { label: 'Vencen en 5 días', value: Number(s.dueSoon5 || 0), filter: 'dueSoon5', tone: 'tone-soon' },
    { label: 'En mora', value: Number(s.inMora || 0), filter: 'mora', tone: 'tone-mora' },
  ];

  el.innerHTML = cards
    .map((card) => `
      <button type="button" class="pos-mini-stat sa-summary-card ${card.tone}" data-sa-summary-filter="${card.filter}">
        <span>${esc(card.label)}</span>
        <b>${card.value}</b>
      </button>
    `)
    .join('');

  document.querySelectorAll('[data-sa-summary-filter]').forEach((card) => {
    card.addEventListener('click', () => {
      setTenantFilter(card.dataset.saSummaryFilter, true);
      $('#saTenantsTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  syncFilterControls();
}

function renderTenantTable() {
  const table = $('#saTenantsTable');
  const filtered = getFilteredTenants();

  if (!filtered.length) {
    table.innerHTML = '<div class="empty"><i class="ph ph-buildings"></i><b>Sin tenants</b><p>No hay resultados con ese filtro.</p></div>';
    return;
  }

  table.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Tenant</th><th>Dueño</th><th>Cuenta</th><th>Pago</th><th>Plan</th><th>Vence</th><th>Acciones</th>
  </tr></thead><tbody>${filtered
    .map((t) => `<tr>
      <td><b>${esc(t.business_name)}</b><div class="meta">/${esc(t.slug)}</div></td>
      <td>${esc(t.owner_name)}<div class="meta">${esc(t.phone || '')}</div></td>
      <td>${statusChip('account', t.account_status)}</td>
      <td>${statusChip('billing', t.billing_status)}</td>
      <td>${esc(t.plan_name || 'starter')}</td>
      <td>${fmtDate(t.billing_due_date)}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost" data-sa-access="${t.id}"><i class="ph-bold ph-sign-in"></i> Entrar</button>
          <button type="button" class="btn btn-ghost" data-sa-password="${t.id}"><i class="ph-bold ph-key"></i> Password</button>
          <button type="button" class="btn btn-ghost" data-sa-payment="${t.id}"><i class="ph-bold ph-currency-circle-dollar"></i> Pago</button>
          <button type="button" class="btn ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'btn-danger' : 'btn-primary'}" data-sa-suspend="${t.id}">
            <i class="ph-bold ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'ph-pause-circle' : 'ph-play-circle'}"></i>
            ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'Suspender' : 'Activar'}
          </button>
        </div>
      </td>
    </tr>`)
    .join('')}</tbody></table></div>`;

  document.querySelectorAll('[data-sa-access]').forEach((btn) => {
    btn.addEventListener('click', () => accessTenant(Number(btn.dataset.saAccess)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-password]').forEach((btn) => {
    btn.addEventListener('click', () => changeTenantPassword(Number(btn.dataset.saPassword)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-payment]').forEach((btn) => {
    btn.addEventListener('click', () => addTenantPayment(Number(btn.dataset.saPayment)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-suspend]').forEach((btn) => {
    btn.addEventListener('click', () => toggleTenantSuspend(Number(btn.dataset.saSuspend)).catch((err) => toast(err.message, true)));
  });
}

async function loadTenants() {
  const payload = await api('/api/superadmin/tenants');
  SA_TENANTS = Array.isArray(payload?.tenants) ? payload.tenants : [];
  renderBillingSummary(payload?.summary || null);
  renderTenantTable();
}

async function refreshBilling() {
  const payload = await api('/api/superadmin/billing/refresh', { method: 'POST' });
  renderBillingSummary(payload?.summary || null);
  await loadTenants();
  const movedDue = Number(payload?.refreshed?.movedToDue || 0);
  const movedSuspended = Number(payload?.refreshed?.movedToSuspended || 0);
  toast(`Cobranza actualizada: ${movedDue} a por pagar, ${movedSuspended} a suspendido`);
}

function closePaymentModal() {
  const modal = $('#saPaymentModal');
  if (!modal) return;
  modal.classList.remove('show');
  SA_PAYMENT_TENANT_ID = null;
}

function updatePaymentNextDue() {
  const payDate = String($('#saPayDate')?.value || '');
  const next = addOneMonth(payDate);
  $('#saPayNextDue').value = next ? fmtDate(next) : '—';
}

function openPaymentModal(tenant) {
  const modal = $('#saPaymentModal');
  if (!modal || !tenant) return;
  SA_PAYMENT_TENANT_ID = Number(tenant.id);
  $('#saPayTenantId').value = String(tenant.id);
  $('#saPayTenantName').value = tenant.business_name || tenant.slug || `Tenant #${tenant.id}`;
  $('#saPayAmount').value = '';
  $('#saPayMethod').value = 'stripe';
  $('#saPayNote').value = '';
  $('#saPayDate').value = fmtInputDate(new Date());
  updatePaymentNextDue();
  modal.classList.add('show');
}

function closeSuspendModal() {
  const modal = $('#saSuspendModal');
  if (!modal) return;
  modal.classList.remove('show');
  SA_SUSPEND_TENANT_ID = null;
}

function openSuspendModal(tenant) {
  const modal = $('#saSuspendModal');
  if (!modal || !tenant) return;
  SA_SUSPEND_TENANT_ID = Number(tenant.id);
  $('#saSuspendTenantId').value = String(tenant.id);
  $('#saSuspendTenantName').value = tenant.business_name || tenant.slug || `Tenant #${tenant.id}`;
  $('#saSuspendMode').value = 'billing';
  $('#saSuspendNote').value = '';
  modal.classList.add('show');
}

function closeActivateModal() {
  const modal = $('#saActivateModal');
  if (!modal) return;
  modal.classList.remove('show');
  SA_ACTIVATE_TENANT_ID = null;
  SA_ACTIVATE_MODE = 'account';
}

function openActivateModal(tenant, mode) {
  const modal = $('#saActivateModal');
  if (!modal || !tenant) return;
  SA_ACTIVATE_TENANT_ID = Number(tenant.id);
  SA_ACTIVATE_MODE = mode === 'billing' ? 'billing' : 'account';
  $('#saActivateMsg').textContent = SA_ACTIVATE_MODE === 'billing'
    ? `¿Reactivar por cobranza a ${tenant.business_name}?`
    : `¿Activar nuevamente el sistema para ${tenant.business_name}?`;
  $('#saActivateHint').textContent = SA_ACTIVATE_MODE === 'billing'
    ? 'Se quitará la suspensión por falta de pago y el tenant podrá entrar al sistema.'
    : 'La cuenta volverá a estado activo para que el tenant opere normalmente.';
  modal.classList.add('show');
}

async function accessTenant(id) {
  const tenant = SA_TENANTS.find((t) => Number(t.id) === Number(id));
  if (!tenant) return;
  await api(`/api/superadmin/tenants/${id}/access`, { method: 'POST' });
  window.open('/app', '_blank');
  toast(`Sesión iniciada para ${tenant.business_name}`);
}

async function changeTenantPassword(id) {
  const tenant = SA_TENANTS.find((t) => Number(t.id) === Number(id));
  if (!tenant) return;
  const pass = String(prompt(`Nueva contraseña para ${tenant.business_name} (mínimo 8 caracteres):`, '') || '').trim();
  if (!pass) return;
  if (pass.length < 8) return toast('La contraseña debe tener al menos 8 caracteres', true);
  await api(`/api/superadmin/tenants/${id}/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword: pass }),
  });
  toast('Contraseña actualizada');
}

async function toggleTenantSuspend(id) {
  const tenant = SA_TENANTS.find((t) => Number(t.id) === Number(id));
  if (!tenant) return;
  const needsActivation = tenant.account_status !== 'active' || tenant.billing_status === 'suspended';
  if (!needsActivation) {
    openSuspendModal(tenant);
    return;
  }

  const mode = tenant.billing_status === 'suspended' ? 'billing' : 'account';
  openActivateModal(tenant, mode);
}

async function addTenantPayment(id) {
  const tenant = SA_TENANTS.find((t) => Number(t.id) === Number(id));
  if (!tenant) return;
  openPaymentModal(tenant);
}

async function submitPaymentForm(e) {
  e.preventDefault();
  const tenantId = Number($('#saPayTenantId')?.value || SA_PAYMENT_TENANT_ID || 0);
  if (!tenantId) return toast('No se encontró el tenant para aplicar el pago', true);

  const amount = Number($('#saPayAmount')?.value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return toast('Monto de pago inválido', true);

  const method = String($('#saPayMethod')?.value || '').trim().toLowerCase();
  if (!['stripe', 'transferencia', 'deposito'].includes(method)) {
    return toast('Selecciona un método de pago válido', true);
  }

  const paidAt = String($('#saPayDate')?.value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return toast('Fecha de pago inválida', true);

  const note = String($('#saPayNote')?.value || '').trim();

  const payload = await api(`/api/superadmin/tenants/${tenantId}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, method, note, paidAt }),
  });

  closePaymentModal();
  toast(`Pago aplicado. Próximo vencimiento: ${fmtDate(payload?.nextDueDate)}`);
  await loadTenants();
}

async function submitSuspendForm(e) {
  e.preventDefault();
  const tenantId = Number($('#saSuspendTenantId')?.value || SA_SUSPEND_TENANT_ID || 0);
  if (!tenantId) return toast('No se encontró el tenant para suspender', true);

  const mode = String($('#saSuspendMode')?.value || 'account').trim().toLowerCase();
  const note = String($('#saSuspendNote')?.value || '').trim();
  await api(`/api/superadmin/tenants/${tenantId}/suspend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suspend: true, mode, note }),
  });

  closeSuspendModal();
  toast(mode === 'billing' ? 'Tenant suspendido por falta de pago' : 'Sistema suspendido para tenant');
  await loadTenants();
}

async function confirmActivateTenant() {
  const tenantId = Number(SA_ACTIVATE_TENANT_ID || 0);
  if (!tenantId) return;
  const mode = SA_ACTIVATE_MODE;
  await api(`/api/superadmin/tenants/${tenantId}/suspend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suspend: false, mode }),
  });
  closeActivateModal();
  toast(mode === 'billing' ? 'Servicio reactivado por cobranza' : 'Sistema activado para tenant');
  await loadTenants();
}

async function loadIntegrations() {
  const cfg = await api('/api/superadmin/integrations');
  $('#saOpenAiEnabled').value = cfg.openaiEnabled ? '1' : '0';
  $('#saOpenAiModel').value = cfg.openaiModel || 'gpt-4o-mini';
  $('#saOpenAiBaseUrl').value = cfg.openaiBaseUrl || '';
  $('#saWebhookUrl').value = cfg.webhookUrl || '';
  $('#saOpenAiKey').value = '';
  $('#saOpenAiKey').placeholder = cfg.hasOpenAiKey
    ? 'API key guardada (oculta por seguridad). Escribe una nueva solo si deseas reemplazarla.'
    : 'sk-... (deja vacío para no cambiar)';
  applySuperAdminLogo(cfg.superadminLogoUrl || '');
  $('#saIntegrationHint').textContent = cfg.hasOpenAiKey
    ? 'Hay una API key guardada y cifrada. El campo se muestra vacío por seguridad.'
    : 'Aún no hay API key guardada.';
}

async function saveIntegrations(e) {
  e.preventDefault();
  const logoFile = $('#saBrandLogoFile')?.files?.[0] || null;

  await api('/api/superadmin/integrations', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      openaiEnabled: $('#saOpenAiEnabled').value === '1',
      openaiModel: $('#saOpenAiModel').value,
      openaiBaseUrl: $('#saOpenAiBaseUrl').value,
      webhookUrl: $('#saWebhookUrl').value,
      openaiApiKey: $('#saOpenAiKey').value || undefined,
    }),
  });

  if (logoFile) {
    await uploadSuperAdminLogo(logoFile, { suppressToast: true });
  }

  toast(logoFile ? 'Integraciones y logo guardados' : 'Integraciones guardadas');
  await loadIntegrations();
}

async function uploadSuperAdminLogo(fileParam, options = {}) {
  const input = $('#saBrandLogoFile');
  const file = fileParam || input?.files?.[0];
  if (!file) return toast('Selecciona un archivo para subir', true);

  const fd = new FormData();
  fd.append('logo', file);
  const payload = await api('/api/superadmin/branding/logo', {
    method: 'POST',
    body: fd,
  });

  applySuperAdminLogo(payload?.superadminLogoUrl || '');
  if (input) input.value = '';
  if (!options.suppressToast) toast('Logo de SuperAdmin actualizado');
}

function setView(view) {
  const isTenants = view === 'tenants';
  $('#saViewTenants').hidden = !isTenants;
  $('#saViewTenants').classList.toggle('active', isTenants);
  $('#saViewIntegrations').hidden = isTenants;
  $('#saViewIntegrations').classList.toggle('active', !isTenants);
  $('#saTitle').innerHTML = isTenants
    ? '<i class="ph-bold ph-buildings"></i> Tenants'
    : '<i class="ph-bold ph-plugs-connected"></i> Integraciones';
  $('#saSub').textContent = isTenants
    ? 'Administra tenants activos, por pagar y suspendidos.'
    : 'Configuración central de OpenAI y APIs del chatbot.';
  document.querySelectorAll('[data-sa-view]').forEach((a) => a.classList.toggle('active', a.dataset.saView === view));
}

async function boot() {
  try {
    const me = await api('/api/superadmin/me');
    $('#saUserName').textContent = me.username || 'superadmin';
    startSuperAdminClock();
    await Promise.all([loadTenants(), loadIntegrations()]);
  } catch (err) {
    toast(err.message, true);
  }
}

$('#saBrandLogoFile')?.addEventListener('change', (e) => {
  const file = e.target?.files?.[0];
  if (!file) return;
  applySuperAdminLogoFromFile(file);
});
$('#saUploadBrandLogo')?.addEventListener('click', () => uploadSuperAdminLogo().catch((e) => toast(e.message, true)));

$('#saTenantSearch')?.addEventListener('input', renderTenantTable);
$('#saReloadTenants')?.addEventListener('click', () => loadTenants().catch((e) => toast(e.message, true)));
$('#saBillingRefresh')?.addEventListener('click', () => refreshBilling().catch((e) => toast(e.message, true)));
$('#saIntegrationForm')?.addEventListener('submit', (e) => saveIntegrations(e).catch((err) => toast(err.message, true)));
$('#saLogout')?.addEventListener('click', async () => {
  await fetch('/api/superadmin/logout', { method: 'POST' });
  location.href = '/superadmin/login';
});

document.querySelectorAll('[data-sa-view]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    setView(a.dataset.saView);
    history.replaceState(null, '', `#${a.dataset.saView}`);
  });
});

document.querySelectorAll('#saTenantFilters button').forEach((btn) => {
  btn.addEventListener('click', () => {
    setTenantFilter(btn.dataset.status, true);
  });
});

$('#saPayDate')?.addEventListener('change', updatePaymentNextDue);
$('#saPayCancel')?.addEventListener('click', closePaymentModal);
$('#saPaymentModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saPaymentModal') closePaymentModal();
});
$('#saPaymentForm')?.addEventListener('submit', (e) => submitPaymentForm(e).catch((err) => toast(err.message, true)));
$('#saSuspendCancel')?.addEventListener('click', closeSuspendModal);
$('#saSuspendModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saSuspendModal') closeSuspendModal();
});
$('#saSuspendForm')?.addEventListener('submit', (e) => submitSuspendForm(e).catch((err) => toast(err.message, true)));
$('#saActivateCancel')?.addEventListener('click', closeActivateModal);
$('#saActivateConfirm')?.addEventListener('click', () => confirmActivateTenant().catch((err) => toast(err.message, true)));
$('#saActivateModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saActivateModal') closeActivateModal();
});

setView((location.hash || '#tenants').slice(1) === 'integrations' ? 'integrations' : 'tenants');
boot();
