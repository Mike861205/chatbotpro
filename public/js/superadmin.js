let SA_TENANTS = [];
let SA_FILTER = 'all';
let SA_SUMMARY = null;
let SA_CLIENTS = [];
let SA_CLIENT_FILTER = 'all';
let SA_CLIENT_SUMMARY = null;
let SA_DEMO_LEADS = [];
let SA_PAYMENT_TENANT_ID = null;
let SA_SUSPEND_TENANT_ID = null;
let SA_ACTIVATE_TENANT_ID = null;
let SA_ACTIVATE_MODE = 'account';
let SA_DEPLOY_POLL_TIMER = null;
let SA_DELETE_TARGET = null;

const SA_MODULE_LABELS = {
  dashboard: 'Dashboard',
  pedidos: 'Pedidos',
  clientes: 'Clientes',
  pos: 'Punto de venta',
  kds: 'Pantallas KDS',
  ventas: 'Ventas',
  productos: 'Productos',
  costos: 'Costo de ventas',
  inventarios: 'Inventarios',
  'stock-sucursales': 'Stock por sucursal',
  compras: 'Compras',
  empleados: 'Productividad',
  chatbot: 'Mi chatbot',
  config: 'Mi negocio',
  suscripciones: 'Suscripciones',
};

const $ = (s) => document.querySelector(s);
let SA_CLOCK_TIMER = null;
const SA_DEFAULT_LOGO = '/static/chatbotpro100.png?v=20260623';

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

function countryFlag(code) {
  return String(code || '').toUpperCase().replace(/[A-Z]/g, (letter) =>
    String.fromCodePoint(127397 + letter.charCodeAt(0))
  );
}

async function copyPhone(value) {
  const phone = String(value || '').trim();
  if (!phone) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(phone);
  } else {
    const input = document.createElement('textarea');
    input.value = phone;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  toast(`Teléfono copiado: ${phone}`);
}

function bindPhoneActions() {
  document.querySelectorAll('[data-sa-copy-phone]').forEach((button) => {
    button.onclick = () => copyPhone(button.dataset.saCopyPhone).catch(() => toast('No se pudo copiar el teléfono', true));
  });
}

function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtMoney(value) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(value || 0));
}

function findBusiness(id) {
  return [...SA_TENANTS, ...SA_CLIENTS].find((item) => Number(item.id) === Number(id));
}

function usageModules(entity) {
  if (Array.isArray(entity?.modules)) return entity.modules;
  try {
    const parsed = JSON.parse(entity?.modules || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function moduleUsageButton(entity, type) {
  const moduleCount = Number(entity?.module_count || 0);
  const views = Number(entity?.module_views || 0);
  return `<button type="button" class="module-usage-btn" data-sa-modules="${type}:${Number(entity.id)}">
    <span><i class="ph-bold ph-squares-four"></i> <b>${moduleCount}</b> módulo${moduleCount === 1 ? '' : 's'}</span>
    <small>${views} acceso${views === 1 ? '' : 's'}${entity?.module_last_seen ? ` · ${fmtDate(entity.module_last_seen)}` : ''}</small>
  </button>`;
}

function normalizeLogoUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return value;
  return `/${value.replace(/^\/+/, '')}`;
}

function applySuperAdminLogo(rawUrl) {
  const logoUrl = normalizeLogoUrl(rawUrl) || SA_DEFAULT_LOGO;
  const logo = $('#saBrandLogo');
  const logoDot = $('#saBrandLogoDot');
  const preview = $('#saBrandLogoPreview');
  const previewIcon = $('#saBrandLogoPreviewIcon');
  const previewDot = document.querySelector('.sa-logo-preview-dot');
  const userLogo = $('#saUserBrandLogo');
  const userLogoWrap = $('#saUserBrandLogoWrap');

  if (logo && logoDot) {
    logo.src = logoUrl;
    logo.hidden = false;
    logoDot.classList.add('has-image');
  }

  if (preview && previewIcon) {
    preview.src = logoUrl;
    preview.hidden = false;
    previewIcon.hidden = true;
    if (previewDot) previewDot.classList.add('has-image');
  }

  if (userLogo && userLogoWrap) {
    userLogo.src = logoUrl;
    userLogo.hidden = false;
    userLogoWrap.classList.add('has-image');
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
  const previewDot = document.querySelector('.sa-logo-preview-dot');
  const userLogo = $('#saUserBrandLogo');
  const userLogoWrap = $('#saUserBrandLogoWrap');

  if (logo && logoDot) {
    logo.src = objectUrl;
    logo.hidden = false;
    logoDot.classList.add('has-image');
  }

  if (preview && previewIcon) {
    preview.src = objectUrl;
    preview.hidden = false;
    previewIcon.hidden = true;
    if (previewDot) previewDot.classList.add('has-image');
  }

  if (userLogo && userLogoWrap) {
    userLogo.src = objectUrl;
    userLogo.hidden = false;
    userLogoWrap.classList.add('has-image');
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
    return [t.slug, t.business_name, t.owner_name, t.phone, t.phone_country_name, t.phone_calling_code].join(' ').toLowerCase().includes(search);
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
    { label: 'Total prospectos', value: Number(s.total || 0), filter: 'all', tone: 'tone-total' },
    { label: 'Con acceso', value: Number(s.activeTenants || 0), filter: 'active', tone: 'tone-active' },
    { label: 'Inactivos', value: Number(s.inactiveTenants || 0), filter: 'inactive', tone: 'tone-inactive' },
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
    <th>Prospecto</th><th>Dueño</th><th>Registro</th><th>Acceso</th><th>Plan de interés</th><th>Módulos</th><th>Acciones</th>
  </tr></thead><tbody>${filtered
    .map((t) => {
      const waUrl = t.phone_valid && t.phone_digits ? `https://wa.me/${t.phone_digits}` : '';
      const country = t.phone_country_name || t.phone_country || 'Sin país';
      return `<tr>
      <td><b>${esc(t.business_name)}</b><div class="meta">/${esc(t.slug)}</div></td>
      <td>${esc(t.owner_name)}
        <div class="meta">${countryFlag(t.phone_country)} ${esc(country)} · Lada ${t.phone_calling_code ? `+${esc(t.phone_calling_code)}` : '—'}</div>
        <div class="meta">${esc(t.phone || '—')}${t.phone && !t.phone_valid ? ' · Revisar número histórico' : ''}</div>
      </td>
      <td>${fmtDate(t.created_at)}</td>
      <td>${statusChip('account', t.account_status)}</td>
      <td>${esc(t.plan_name || 'starter')}<div class="meta">Hasta ${Number(t.branch_limit || 2)} sucursales activas</div></td>
      <td>${moduleUsageButton(t, 'tenant')}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost" data-sa-access="${t.id}"><i class="ph-bold ph-sign-in"></i> Entrar</button>
          <button type="button" class="btn btn-ghost" data-sa-password="${t.id}"><i class="ph-bold ph-key"></i> Password</button>
          <button type="button" class="btn btn-ghost" data-sa-payment="${t.id}"><i class="ph-bold ph-currency-circle-dollar"></i> Pago</button>
          <button type="button" class="btn btn-ghost" data-sa-branches="${t.id}"><i class="ph-bold ph-storefront"></i> Sucursales</button>
          ${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</a>` : ''}
          ${t.phone_valid && t.phone_e164 ? `<button type="button" class="btn btn-ghost" data-sa-copy-phone="${esc(t.phone_e164)}"><i class="ph-bold ph-copy"></i> Copiar</button>` : ''}
          <button type="button" class="btn ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'btn-danger' : 'btn-primary'}" data-sa-suspend="${t.id}">
            <i class="ph-bold ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'ph-pause-circle' : 'ph-play-circle'}"></i>
            ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'Suspender' : 'Activar'}
          </button>
          <button type="button" class="btn btn-danger" data-sa-delete-tenant="${t.id}"><i class="ph-bold ph-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>`;
    })
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
  document.querySelectorAll('#saTenantsTable [data-sa-branches]').forEach((btn) => {
    btn.addEventListener('click', () => changeBranchLimit(Number(btn.dataset.saBranches)).catch((err) => toast(err.message, true)));
  });
  bindModuleUsageButtons();
  bindPhoneActions();
  document.querySelectorAll('[data-sa-delete-tenant]').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal('tenant', Number(btn.dataset.saDeleteTenant)));
  });
}

function getFilteredDemoLeads() {
  const search = String($('#saDemoLeadSearch')?.value || '').trim().toLowerCase();
  return SA_DEMO_LEADS.filter((lead) => {
    if (!search) return true;
    return [lead.contact_name, lead.phone, lead.phone_country_name, lead.phone_calling_code, lead.business_giro, lead.source_label, lead.last_demo_tenant_slug].join(' ').toLowerCase().includes(search);
  });
}

function renderDemoLeadSummary(summary) {
  const el = $('#saDemoLeadSummary');
  if (!el) return;
  const s = summary || { total: 0, landing: 0, login: 0, today: 0, week: 0 };
  const cards = [
    { label: 'Total leads', value: Number(s.total || 0), tone: 'tone-total', icon: 'ph-chart-pie-slice' },
    { label: 'Landing', value: Number(s.landing || 0), tone: 'tone-active', icon: 'ph-globe' },
    { label: 'Login', value: Number(s.login || 0), tone: 'tone-current', icon: 'ph-door-open' },
    { label: 'Hoy', value: Number(s.today || 0), tone: 'tone-soon', icon: 'ph-bell-ringing' },
    { label: 'Últimos 7 días', value: Number(s.week || 0), tone: 'tone-due', icon: 'ph-calendar-check' },
  ];

  el.innerHTML = cards
    .map((card) => `
      <div class="pos-mini-stat sa-summary-card demo-summary-card ${card.tone}">
        <span><i class="ph-bold ${card.icon}"></i> ${esc(card.label)}</span>
        <b>${card.value}</b>
      </div>
    `)
    .join('');
}

function renderDemoLeadsTable() {
  const table = $('#saDemoLeadsTable');
  const filtered = getFilteredDemoLeads();

  if (!table) return;
  if (!filtered.length) {
    table.innerHTML = '<div class="empty"><i class="ph ph-rocket-launch"></i><b>Sin leads demo</b><p>No hay resultados con ese filtro.</p></div>';
    return;
  }

  table.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Nombre</th><th>País</th><th>Lada / teléfono</th><th>Giro</th><th>Origen</th><th>Veces</th><th>Primera vez</th><th>Última vez</th><th>Módulos</th><th>Acciones</th>
  </tr></thead><tbody>${filtered
    .map((lead) => {
      const digits = String(lead.phone_digits || '').replace(/\D/g, '');
      const waUrl = lead.phone_valid && digits ? `https://wa.me/${digits}` : '';
      return `<tr>
        <td><b>${esc(lead.contact_name)}</b><div class="meta">ID #${lead.id}</div></td>
        <td>${countryFlag(lead.phone_country)} ${esc(lead.phone_country_name || lead.phone_country || '—')}</td>
        <td><b>${lead.phone_calling_code ? `+${esc(lead.phone_calling_code)}` : '—'}</b><div class="meta">${digits ? esc(lead.phone) : '—'}${lead.phone && !lead.phone_valid ? ' · Revisar número histórico' : ''}</div></td>
        <td>${esc(lead.business_giro)}</td>
        <td><span class="tag">${esc(lead.source_label || 'Landing')}</span></td>
        <td><b>${Number(lead.demo_count || 0)}</b></td>
        <td>${fmtDate(lead.first_seen_at)}</td>
        <td>${fmtDate(lead.last_seen_at)}</td>
        <td>${moduleUsageButton(lead, 'lead')}</td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</a>` : ''}
            ${lead.phone_valid && lead.phone_e164 ? `<button type="button" class="btn btn-ghost" data-sa-copy-phone="${esc(lead.phone_e164)}"><i class="ph-bold ph-copy"></i> Copiar</button>` : ''}
            <button type="button" class="btn btn-danger" data-sa-delete-lead="${lead.id}"><i class="ph-bold ph-trash"></i> Eliminar</button>
          </div>
        </td>
      </tr>`;
    })
    .join('')}</tbody></table></div>`;

  bindModuleUsageButtons();
  bindPhoneActions();
  document.querySelectorAll('[data-sa-delete-lead]').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal('lead', Number(btn.dataset.saDeleteLead)));
  });
}

function matchesClientFilter(client, filter) {
  if (filter === 'all') return true;
  if (filter === 'active') return client.account_status === 'active' && client.billing_status === 'active';
  if (filter === 'due') return client.billing_status === 'due';
  if (filter === 'suspended') return client.billing_status === 'suspended';
  if (filter === 'mora') return Number(client.mora_days || 0) > 0;
  return true;
}

function getFilteredClients() {
  const search = String($('#saClientSearch')?.value || '').trim().toLowerCase();
  return SA_CLIENTS.filter((client) => {
    if (!matchesClientFilter(client, SA_CLIENT_FILTER)) return false;
    if (!search) return true;
    return [client.slug, client.business_name, client.owner_name, client.phone, client.phone_country_name, client.phone_calling_code]
      .join(' ').toLowerCase().includes(search);
  });
}

function setClientFilter(filter, announce = false) {
  SA_CLIENT_FILTER = filter || 'all';
  document.querySelectorAll('#saClientFilters button').forEach((button) => {
    const active = button.dataset.status === SA_CLIENT_FILTER;
    button.classList.toggle('active', active);
    button.classList.toggle('on', active);
  });
  document.querySelectorAll('[data-sa-client-summary-filter]').forEach((card) => {
    card.classList.toggle('active', card.dataset.saClientSummaryFilter === SA_CLIENT_FILTER);
  });
  renderClientsTable();
  if (announce) {
    const count = getFilteredClients().length;
    toast(`Mostrando ${count} cliente${count === 1 ? '' : 's'}`);
  }
}

function renderClientSummary(summary) {
  SA_CLIENT_SUMMARY = summary || SA_CLIENT_SUMMARY;
  const s = SA_CLIENT_SUMMARY || {};
  const cards = [
    { label: 'Número de clientes', value: Number(s.totalClients || 0), filter: 'all', tone: 'tone-total', icon: 'ph-users-three' },
    { label: 'Clientes activos', value: Number(s.activeClients || 0), filter: 'active', tone: 'tone-active', icon: 'ph-check-circle' },
    { label: 'Por pagar', value: Number(s.billingDue || 0), filter: 'due', tone: 'tone-due', icon: 'ph-clock-countdown' },
    { label: 'En mora', value: Number(s.inMora || 0), filter: 'mora', tone: 'tone-mora', icon: 'ph-warning-circle' },
    { label: 'Ingresos acumulados', value: fmtMoney(s.incomeTotal), tone: 'tone-current', icon: 'ph-currency-circle-dollar' },
    { label: 'Número de licencias', value: Number(s.licenseCount || 0), tone: 'tone-soon', icon: 'ph-key' },
  ];
  const el = $('#saClientSummary');
  if (!el) return;
  el.innerHTML = cards.map((card) => `
    <button type="button" class="pos-mini-stat sa-client-summary-card ${card.tone}" ${card.filter ? `data-sa-client-summary-filter="${card.filter}"` : ''}>
      <span><i class="ph-bold ${card.icon}"></i> ${esc(card.label)}</span><b>${esc(card.value)}</b>
    </button>`).join('');
  document.querySelectorAll('[data-sa-client-summary-filter]').forEach((card) => {
    card.addEventListener('click', () => setClientFilter(card.dataset.saClientSummaryFilter, true));
  });
  setClientFilter(SA_CLIENT_FILTER);
}

function renderClientsTable() {
  const table = $('#saClientsTable');
  if (!table) return;
  const filtered = getFilteredClients();
  if (!filtered.length) {
    table.innerHTML = '<div class="empty"><i class="ph ph-handshake"></i><b>Sin clientes</b><p>Los prospectos aparecerán aquí automáticamente al registrar su primer pago.</p></div>';
    return;
  }

  table.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th>Cliente</th><th>Contacto</th><th>Cliente desde</th><th>Estado</th><th>Plan / cupos</th><th>Último pago</th><th>Vencimiento</th><th>Ingresos</th><th>Acciones</th>
  </tr></thead><tbody>${filtered.map((client) => {
    const waUrl = client.phone_valid && client.phone_digits ? `https://wa.me/${client.phone_digits}` : '';
    return `<tr>
      <td><b>${esc(client.business_name)}</b><div class="meta">/${esc(client.slug)}</div></td>
      <td>${esc(client.owner_name)}<div class="meta">${countryFlag(client.phone_country)} ${esc(client.phone || '—')}</div></td>
      <td>${fmtDate(client.customer_since)}</td>
      <td>${statusChip('billing', client.billing_status)}<div class="meta">${Number(client.mora_days || 0) > 0 ? `${Number(client.mora_days)} días de mora` : 'Cuenta ' + (client.account_status === 'active' ? 'activa' : 'inactiva')}</div></td>
      <td><b>${esc(client.plan_name || 'starter')}</b><div class="meta">${Number(client.license_count || 1)} licencia${Number(client.license_count || 1) === 1 ? '' : 's'} · Hasta ${Number(client.branch_limit || 2)} sucursales</div></td>
      <td>${fmtMoney(client.last_payment_amount)}<div class="meta">${fmtDate(client.last_payment_at)} · ${esc(client.last_payment_method || '—')}</div></td>
      <td>${fmtDate(client.billing_due_date)}</td>
      <td><b>${fmtMoney(client.total_paid)}</b><div class="meta">${Number(client.payment_count || 0)} pago${Number(client.payment_count || 0) === 1 ? '' : 's'}</div></td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" class="btn btn-ghost" data-sa-access="${client.id}"><i class="ph-bold ph-sign-in"></i> Entrar</button>
        <button type="button" class="btn btn-ghost" data-sa-password="${client.id}"><i class="ph-bold ph-key"></i> Password</button>
        <button type="button" class="btn btn-ghost" data-sa-payment="${client.id}"><i class="ph-bold ph-currency-circle-dollar"></i> Pago</button>
        <button type="button" class="btn btn-ghost" data-sa-payments="${client.id}"><i class="ph-bold ph-receipt"></i> Historial</button>
        <button type="button" class="btn btn-ghost" data-sa-licenses="${client.id}"><i class="ph-bold ph-key"></i> Licencias</button>
        <button type="button" class="btn btn-ghost" data-sa-branches="${client.id}"><i class="ph-bold ph-storefront"></i> Sucursales</button>
        ${moduleUsageButton(client, 'tenant')}
        ${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</a>` : ''}
        <button type="button" class="btn ${(client.account_status === 'active' && client.billing_status !== 'suspended') ? 'btn-danger' : 'btn-primary'}" data-sa-suspend="${client.id}">${(client.account_status === 'active' && client.billing_status !== 'suspended') ? 'Suspender' : 'Activar'}</button>
        <button type="button" class="btn btn-danger" data-sa-delete-tenant="${client.id}"><i class="ph-bold ph-trash"></i> Eliminar</button>
      </div></td>
    </tr>`;
  }).join('')}</tbody></table></div>`;

  document.querySelectorAll('#saClientsTable [data-sa-access]').forEach((button) => button.onclick = () => accessTenant(Number(button.dataset.saAccess)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-password]').forEach((button) => button.onclick = () => changeTenantPassword(Number(button.dataset.saPassword)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-payment]').forEach((button) => button.onclick = () => addTenantPayment(Number(button.dataset.saPayment)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-payments]').forEach((button) => button.onclick = () => openPaymentsModal(Number(button.dataset.saPayments)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-licenses]').forEach((button) => button.onclick = () => changeClientLicenses(Number(button.dataset.saLicenses)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-branches]').forEach((button) => button.onclick = () => changeBranchLimit(Number(button.dataset.saBranches)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-suspend]').forEach((button) => button.onclick = () => toggleTenantSuspend(Number(button.dataset.saSuspend)).catch((error) => toast(error.message, true)));
  document.querySelectorAll('#saClientsTable [data-sa-delete-tenant]').forEach((button) => button.onclick = () => openDeleteModal('tenant', Number(button.dataset.saDeleteTenant)));
  bindModuleUsageButtons();
}

function closeModulesModal() {
  $('#saModulesModal')?.classList.remove('show');
}

function openModulesModal(type, id) {
  const entity = type === 'tenant'
    ? findBusiness(id)
    : SA_DEMO_LEADS.find((item) => Number(item.id) === Number(id));
  if (!entity) return;

  const modules = usageModules(entity);
  const name = type === 'tenant' ? entity.business_name : entity.contact_name;
  const totalViews = Number(entity.module_views || 0);
  $('#saModulesSubject').textContent = `${type === 'tenant' ? 'Tenant' : 'Lead demo'}: ${name}`;
  $('#saModulesSummary').innerHTML = `
    <div><span>Módulos utilizados</span><b>${Number(entity.module_count || modules.length)}</b></div>
    <div><span>Accesos totales</span><b>${totalViews}</b></div>
    <div><span>Última actividad</span><b class="module-last-seen">${fmtDateTime(entity.module_last_seen)}</b></div>
  `;

  $('#saModulesDetail').innerHTML = modules.length
    ? `<div class="table-wrap"><table class="module-detail-table"><thead><tr>
        <th>Módulo</th><th>Veces que ingresó</th><th>Primera vez</th><th>Última vez</th>
      </tr></thead><tbody>${modules.map((item) => `<tr>
        <td><b>${esc(SA_MODULE_LABELS[item.key] || item.key)}</b></td>
        <td><span class="tag ok">${Number(item.count || 0)} acceso${Number(item.count || 0) === 1 ? '' : 's'}</span></td>
        <td>${fmtDateTime(item.firstSeenAt)}</td>
        <td>${fmtDateTime(item.lastSeenAt)}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty module-empty"><i class="ph ph-chart-bar"></i><b>Sin actividad registrada</b><p>Los accesos aparecerán aquí cuando ingrese a un módulo.</p></div>';

  $('#saModulesModal')?.classList.add('show');
}

function bindModuleUsageButtons() {
  document.querySelectorAll('[data-sa-modules]').forEach((btn) => {
    btn.onclick = () => {
      const [type, id] = String(btn.dataset.saModules || '').split(':');
      openModulesModal(type, Number(id));
    };
  });
}

function closeDeleteModal() {
  $('#saDeleteModal')?.classList.remove('show');
  SA_DELETE_TARGET = null;
  const confirmBtn = $('#saDeleteConfirm');
  if (confirmBtn) confirmBtn.disabled = false;
}

function openDeleteModal(type, id) {
  const entity = type === 'tenant'
    ? findBusiness(id)
    : SA_DEMO_LEADS.find((item) => Number(item.id) === Number(id));
  if (!entity) return;

  SA_DELETE_TARGET = { type, id: Number(id), name: type === 'tenant' ? entity.business_name : entity.contact_name };
  $('#saDeleteMessage').textContent = `¿Seguro que deseas eliminar ${type === 'tenant' ? 'el tenant' : 'el lead demo'} “${SA_DELETE_TARGET.name}”?`;
  $('#saDeleteHint').textContent = type === 'tenant'
    ? 'Esta acción es permanente: elimina usuarios, pagos, métricas y todos los datos del negocio.'
    : 'Esta acción es permanente y también elimina su historial de uso de módulos.';
  $('#saDeleteModal')?.classList.add('show');
}

async function confirmDelete() {
  const target = SA_DELETE_TARGET;
  if (!target) return;
  const confirmBtn = $('#saDeleteConfirm');
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    const endpoint = target.type === 'tenant'
      ? `/api/superadmin/tenants/${target.id}`
      : `/api/superadmin/demo-leads/${target.id}`;
    await api(endpoint, { method: 'DELETE' });
    const deletedLabel = target.type === 'tenant' ? 'Tenant eliminado' : 'Lead demo eliminado';
    closeDeleteModal();
    toast(deletedLabel);
    if (target.type === 'tenant') await Promise.all([loadTenants(), loadClients()]);
    else await loadDemoLeads();
  } catch (err) {
    if (confirmBtn) confirmBtn.disabled = false;
    throw err;
  }
}

async function loadDemoLeads() {
  const payload = await api('/api/superadmin/demo-leads');
  SA_DEMO_LEADS = Array.isArray(payload?.demoLeads) ? payload.demoLeads : [];
  renderDemoLeadSummary(payload?.summary || null);
  renderDemoLeadsTable();
}

async function loadTenants() {
  const payload = await api('/api/superadmin/tenants');
  SA_TENANTS = Array.isArray(payload?.tenants) ? payload.tenants : [];
  renderBillingSummary(payload?.summary || null);
  renderTenantTable();
}

async function loadClients() {
  const payload = await api('/api/superadmin/clients');
  SA_CLIENTS = Array.isArray(payload?.clients) ? payload.clients : [];
  renderClientSummary(payload?.summary || null);
  renderClientsTable();
}

async function refreshBilling() {
  const payload = await api('/api/superadmin/billing/refresh', { method: 'POST' });
  await Promise.all([loadTenants(), loadClients()]);
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
  const tenant = findBusiness(id);
  if (!tenant) return;
  await api(`/api/superadmin/tenants/${id}/access`, { method: 'POST' });
  window.open('/app', '_blank');
  toast(`Sesión iniciada para ${tenant.business_name}`);
}

async function changeTenantPassword(id) {
  const tenant = findBusiness(id);
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
  const tenant = findBusiness(id);
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
  const tenant = findBusiness(id);
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
  toast(payload?.becameClient
    ? `Pago aplicado: el prospecto ya es cliente. Vence ${fmtDate(payload?.nextDueDate)}`
    : `Pago aplicado. Próximo vencimiento: ${fmtDate(payload?.nextDueDate)}`);
  await Promise.all([loadTenants(), loadClients()]);
}

function closePaymentsModal() {
  $('#saPaymentsModal')?.classList.remove('show');
}

async function openPaymentsModal(clientId) {
  const client = findBusiness(clientId);
  if (!client) return;
  const payload = await api(`/api/superadmin/clients/${clientId}/payments`);
  const payments = Array.isArray(payload?.payments) ? payload.payments : [];
  $('#saPaymentsSubject').textContent = `${client.business_name} · ${payments.length} pago${payments.length === 1 ? '' : 's'}`;
  $('#saPaymentsDetail').innerHTML = payments.length
    ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Monto</th><th>Método</th><th>Referencia / nota</th><th>Registró</th></tr></thead><tbody>${payments.map((payment) => `<tr>
        <td>${fmtDate(payment.paid_at)}</td><td><b>${fmtMoney(payment.amount)}</b></td><td><span class="tag ok">${esc(payment.method || 'manual')}</span></td><td>${esc(payment.note || '—')}</td><td>${esc(payment.created_by || '—')}</td>
      </tr>`).join('')}</tbody></table></div>`
    : '<div class="empty"><i class="ph ph-receipt"></i><b>Sin pagos</b><p>Aún no hay movimientos registrados.</p></div>';
  $('#saPaymentsModal')?.classList.add('show');
}

async function changeClientLicenses(clientId) {
  const client = findBusiness(clientId);
  if (!client) return;
  const raw = prompt(`Número de licencias para ${client.business_name}:`, String(client.license_count || 1));
  if (raw === null) return;
  const licenseCount = Number(raw);
  if (!Number.isInteger(licenseCount) || licenseCount < 1 || licenseCount > 100000) {
    return toast('Captura un número de licencias válido', true);
  }
  await api(`/api/superadmin/tenants/${clientId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license_count: licenseCount }),
  });
  toast('Número de licencias actualizado');
  await loadClients();
}

async function changeBranchLimit(tenantId) {
  const tenant = findBusiness(tenantId);
  if (!tenant) return;
  const details = await api(`/api/superadmin/tenants/${tenantId}/stats`);
  const activeBranches = Number(details?.stats?.activeBranches || 0);
  const totalBranches = Number(details?.stats?.totalBranches || 0);
  $('#saBranchLimitTenantId').value = String(tenant.id);
  $('#saBranchLimitTenantName').value = tenant.business_name || tenant.slug || `Tenant #${tenant.id}`;
  $('#saBranchLimitValue').value = String(Number(tenant.branch_limit || 2));
  $('#saBranchLimitUsage').textContent = `Uso actual: ${activeBranches} sucursal${activeBranches === 1 ? '' : 'es'} activa${activeBranches === 1 ? '' : 's'} de ${totalBranches} registrada${totalBranches === 1 ? '' : 's'}.`;
  $('#saBranchLimitModal')?.classList.add('show');
  setTimeout(() => $('#saBranchLimitValue')?.focus(), 60);
}

function closeBranchLimitModal() {
  $('#saBranchLimitModal')?.classList.remove('show');
}

async function submitBranchLimitForm(event) {
  event.preventDefault();
  const tenantId = Number($('#saBranchLimitTenantId')?.value || 0);
  const branchLimit = Number($('#saBranchLimitValue')?.value || 0);
  if (!tenantId) return toast('No se encontró el negocio', true);
  if (!Number.isInteger(branchLimit) || branchLimit < 1 || branchLimit > 1000) {
    return toast('Captura un límite de 1 a 1000 sucursales', true);
  }
  await api(`/api/superadmin/tenants/${tenantId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch_limit: branchLimit }),
  });
  closeBranchLimitModal();
  toast(`Cupo actualizado: hasta ${branchLimit} sucursales activas`);
  await Promise.all([loadTenants(), loadClients()]);
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
  await Promise.all([loadTenants(), loadClients()]);
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
  await Promise.all([loadTenants(), loadClients()]);
}

async function loadIntegrations() {
  const cfg = await api('/api/superadmin/integrations');
  $('#saOpenAiEnabled').value = cfg.openaiEnabled ? '1' : '0';
  applyOpenAiModelSelection(cfg.openaiModel || 'gpt-4o-mini');
  $('#saOpenAiBaseUrl').value = cfg.openaiBaseUrl || '';
  $('#saWebhookUrl').value = cfg.webhookUrl || '';
  $('#saOpenAiKey').value = '';
  const hasStoredKey = Boolean(cfg.hasEncryptedOpenAiKey || cfg.hasOpenAiKey);
  const keyReadable = cfg.openAiKeyReadable !== false;
  $('#saOpenAiKey').placeholder = hasStoredKey
    ? 'API key guardada (oculta por seguridad). Escribe una nueva solo si deseas reemplazarla.'
    : 'sk-... (deja vacío para no cambiar)';
  applySuperAdminLogo(cfg.superadminLogoUrl || '');
  if (hasStoredKey && !keyReadable) {
    $('#saIntegrationHint').textContent = 'Hay una API key cifrada en la base, pero no se puede leer con la llave actual (DATA_ENCRYPTION_KEY). Usa la misma llave del entorno original o captura de nuevo la API key y guarda.';
  } else if (hasStoredKey) {
    $('#saIntegrationHint').textContent = 'Hay una API key guardada y cifrada. El campo se muestra vacío por seguridad.';
  } else {
    $('#saIntegrationHint').textContent = 'Aún no hay API key guardada.';
  }
}

async function saveIntegrations(e) {
  e.preventDefault();
  const logoFile = $('#saBrandLogoFile')?.files?.[0] || null;

  await api('/api/superadmin/integrations', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      openaiEnabled: $('#saOpenAiEnabled').value === '1',
      openaiModel: getSelectedOpenAiModel(),
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

function formatDeployStatus(deploy) {
  if (!deploy) return 'Estado: sin datos de deploy.';
  if (deploy.running) {
    const started = deploy.startedAt ? fmtDate(deploy.startedAt) : '—';
    return `Estado: ejecutando (iniciado ${started})`;
  }
  if (deploy.completedAt) {
    const code = Number(deploy.exitCode);
    const ok = code === 0;
    return `Estado: ${ok ? 'último deploy exitoso' : 'último deploy con error'} (código ${Number.isFinite(code) ? code : 'n/a'})`;
  }
  return 'Estado: sin ejecuciones todavía.';
}

function renderDeployStatus(payload) {
  const deploy = payload?.deploy || null;
  const statusEl = $('#saDeployStatus');
  const logsEl = $('#saDeployLogs');
  const runBtn = $('#saDeployRun');
  const pushDeployBtn = $('#saPushDeployRun');

  if (!statusEl || !logsEl || !runBtn) return;

  statusEl.textContent = formatDeployStatus(deploy);
  runBtn.disabled = Boolean(deploy?.running);
  if (pushDeployBtn) pushDeployBtn.disabled = Boolean(deploy?.running);

  const logs = Array.isArray(deploy?.logs) ? deploy.logs : [];
  logsEl.textContent = logs.length ? logs.join('\n') : 'Sin logs todavía.';
  logsEl.scrollTop = logsEl.scrollHeight;
}

async function loadDeployStatus() {
  const payload = await api('/api/superadmin/deploy/status');
  renderDeployStatus(payload);
  if (payload?.deploy?.running) startDeployPolling();
  return payload;
}

async function loadGitDeployStatus() {
  const payload = await api('/api/superadmin/deploy/git-status');
  const hint = $('#saGitStatusHint');
  if (hint) {
    const git = payload?.git || {};
    const dirtyCount = Number(git.dirtyCount || 0);
    hint.textContent = `Git: rama local ${git.currentBranch || '-'} | destino ${git.remote || 'origin'}/${git.branch || 'main'} | PM2 ${git.pm2App || 'chatbotpro'} | health ${git.healthUrl || 'http://127.0.0.1:3003/'} | cambios pendientes ${dirtyCount}`;
  }
  return payload;
}

function stopDeployPolling() {
  if (SA_DEPLOY_POLL_TIMER) {
    clearInterval(SA_DEPLOY_POLL_TIMER);
    SA_DEPLOY_POLL_TIMER = null;
  }
}

function startDeployPolling() {
  stopDeployPolling();
  SA_DEPLOY_POLL_TIMER = setInterval(async () => {
    try {
      const payload = await loadDeployStatus();
      if (!payload?.deploy?.running) {
        stopDeployPolling();
        await loadGitDeployStatus().catch(() => {});
      }
    } catch (err) {
      stopDeployPolling();
      toast(err.message, true);
    }
  }, 2500);
}

async function runProductionDeploy() {
  const force = Boolean($('#saDeployForce')?.checked);
  const payload = await api('/api/superadmin/deploy/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  renderDeployStatus(payload);
  startDeployPolling();
  toast('Deploy lanzado. Revisa el log en tiempo real.');
}

async function runPushAndDeploy() {
  const commitMessage = String($('#saDeployCommitMessage')?.value || '').trim();
  if (commitMessage.length < 5) {
    return toast('Escribe un mensaje de commit de al menos 5 caracteres', true);
  }
  const forceDeploy = Boolean($('#saDeployForce')?.checked);
  const payload = await api('/api/superadmin/deploy/push-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commitMessage, forceDeploy }),
  });
  renderDeployStatus(payload);
  startDeployPolling();
  toast('Push + deploy lanzado. Revisa el log en tiempo real.');
}

function applyOpenAiModelSelection(model) {
  const preset = $('#saOpenAiModelPreset');
  const customInput = $('#saOpenAiModel');
  const hint = $('#saOpenAiModelHint');
  const cleanModel = String(model || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const knownModels = new Set(['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4.1-nano']);
  const useCustom = !knownModels.has(cleanModel);

  preset.value = useCustom ? 'custom' : cleanModel;
  customInput.hidden = !useCustom;
  customInput.value = useCustom ? cleanModel : '';
  hint.textContent = useCustom
    ? 'Modelo personalizado para todos los tenants. Verifica que exista en tu cuenta OpenAI.'
    : 'Este será el modelo por default para todos los tenants.';
}

function getSelectedOpenAiModel() {
  const presetValue = $('#saOpenAiModelPreset').value;
  if (presetValue === 'custom') {
    return ($('#saOpenAiModel').value || '').trim() || 'gpt-4o-mini';
  }
  return presetValue || 'gpt-4o-mini';
}

$('#saOpenAiModelPreset')?.addEventListener('change', () => {
  const presetValue = $('#saOpenAiModelPreset').value;
  if (presetValue === 'custom') {
    $('#saOpenAiModel').hidden = false;
    $('#saOpenAiModel').focus();
    $('#saOpenAiModelHint').textContent = 'Modelo personalizado para todos los tenants. Verifica que exista en tu cuenta OpenAI.';
    return;
  }
  $('#saOpenAiModel').hidden = true;
  $('#saOpenAiModel').value = '';
  $('#saOpenAiModelHint').textContent = 'Este será el modelo por default para todos los tenants.';
});

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
  const isClients = view === 'clients';
  const isDemoLeads = view === 'demo-leads';
  let title = '<i class="ph-bold ph-plugs-connected"></i> Integraciones';
  let subtitle = 'Configuración central de OpenAI y APIs del chatbot.';
  if (isTenants) {
    title = '<i class="ph-bold ph-buildings"></i> Prospectos';
    subtitle = 'Tenants que todavía no registran su primer pago.';
  } else if (isClients) {
    title = '<i class="ph-bold ph-handshake"></i> Clientes';
    subtitle = 'Cartera de clientes, ingresos, licencias y cobranza.';
  } else if (isDemoLeads) {
    title = '<i class="ph-bold ph-rocket-launch"></i> Leads demo';
    subtitle = 'Contactos que pidieron acceso al demo con sus datos de negocio.';
  }
  $('#saViewTenants').hidden = !isTenants;
  $('#saViewTenants').classList.toggle('active', isTenants);
  $('#saViewClients').hidden = !isClients;
  $('#saViewClients').classList.toggle('active', isClients);
  $('#saViewDemoLeads').hidden = !isDemoLeads;
  $('#saViewDemoLeads').classList.toggle('active', isDemoLeads);
  $('#saViewIntegrations').hidden = isTenants || isClients || isDemoLeads;
  $('#saViewIntegrations').classList.toggle('active', !isTenants && !isClients && !isDemoLeads);
  $('#saTitle').innerHTML = title;
  $('#saSub').textContent = subtitle;
  document.querySelectorAll('[data-sa-view]').forEach((a) => a.classList.toggle('active', a.dataset.saView === view));
}

async function boot() {
  try {
    const me = await api('/api/superadmin/me');
    $('#saUserName').textContent = me.username || 'superadmin';
    startSuperAdminClock();
    await Promise.all([loadTenants(), loadClients(), loadDemoLeads(), loadIntegrations(), loadDeployStatus(), loadGitDeployStatus()]);
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
$('#saClientSearch')?.addEventListener('input', renderClientsTable);
$('#saReloadClients')?.addEventListener('click', () => loadClients().catch((e) => toast(e.message, true)));
$('#saDemoLeadSearch')?.addEventListener('input', renderDemoLeadsTable);
$('#saReloadDemoLeads')?.addEventListener('click', () => loadDemoLeads().catch((e) => toast(e.message, true)));
$('#saBillingRefresh')?.addEventListener('click', () => refreshBilling().catch((e) => toast(e.message, true)));
$('#saIntegrationForm')?.addEventListener('submit', (e) => saveIntegrations(e).catch((err) => toast(err.message, true)));
$('#saDeployRun')?.addEventListener('click', () => runProductionDeploy().catch((err) => toast(err.message, true)));
$('#saPushDeployRun')?.addEventListener('click', () => runPushAndDeploy().catch((err) => toast(err.message, true)));
$('#saLogout')?.addEventListener('click', async () => {
  stopDeployPolling();
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
$('#saBranchLimitCancel')?.addEventListener('click', closeBranchLimitModal);
$('#saBranchLimitModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saBranchLimitModal') closeBranchLimitModal();
});
$('#saBranchLimitForm')?.addEventListener('submit', (e) => submitBranchLimitForm(e).catch((err) => toast(err.message, true)));
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
document.querySelectorAll('#saClientFilters button').forEach((btn) => {
  btn.addEventListener('click', () => setClientFilter(btn.dataset.status, true));
});
$('#saModulesClose')?.addEventListener('click', closeModulesModal);
$('#saModulesModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saModulesModal') closeModulesModal();
});
$('#saPaymentsClose')?.addEventListener('click', closePaymentsModal);
$('#saPaymentsModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saPaymentsModal') closePaymentsModal();
});
$('#saDeleteCancel')?.addEventListener('click', closeDeleteModal);
$('#saDeleteConfirm')?.addEventListener('click', () => confirmDelete().catch((err) => toast(err.message, true)));
$('#saDeleteModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saDeleteModal') closeDeleteModal();
});

const SA_INITIAL_VIEW = ['tenants', 'clients', 'demo-leads', 'integrations'].includes((location.hash || '#tenants').slice(1))
  ? (location.hash || '#tenants').slice(1)
  : 'tenants';
setView(SA_INITIAL_VIEW);
boot();
