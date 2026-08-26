let SA_TENANTS = [];
let SA_FILTER = 'all';
let SA_SUMMARY = null;
let SA_CLIENTS = [];
let SA_CLIENT_FILTER = 'all';
let SA_CLIENT_SUMMARY = null;
let SA_DEMO_LEADS = [];
let SA_FOLLOW_UP = [];
let SA_RESELLERS = [];
let SA_FOLLOWUP_TARGETS = [];
const SA_SELECTED = new Set();
let SA_PAYMENT_TENANT_ID = null;
let SA_SUSPEND_TENANT_ID = null;
let SA_ACTIVATE_TENANT_ID = null;
let SA_ACTIVATE_MODE = 'account';
let SA_STAMP_TENANT_ID = null;
let SA_STAMP_DATA = null;
let SA_DEPLOY_POLL_TIMER = null;
let SA_DELETE_TARGET = null;
let SA_TENANT_SORT = { key: 'created_at', dir: 'desc' };
let SA_TENANT_PAGE = 1;
let SA_TENANT_PER_PAGE = 20;
let SA_DEMO_SORT = { key: 'last_seen_at', dir: 'desc' };
let SA_DEMO_PAGE = 1;
let SA_DEMO_PER_PAGE = 20;

const SA_SALES_STAGES = [
  ['new', 'Nuevo', 'new'],
  ['contacted', 'Contactado', 'contacted'],
  ['interested', 'Interesado', 'interested'],
  ['potential', 'Potencial a compra', 'potential'],
  ['follow_up', 'En seguimiento', 'follow-up'],
  ['won', 'Cierre exitoso', 'won'],
  ['not_interested', 'No interesado', 'not-interested'],
  ['lost', 'Cierre no exitoso', 'lost'],
];
const SA_DELETABLE_STAGES = new Set(['not_interested', 'lost']);

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

function matchesModuleFilter(entity, filter) {
  if (filter === 'all') return true;
  const moduleCount = Number(entity.module_count || 0);
  if (filter === '1') return moduleCount >= 1 && moduleCount <= 2;
  if (filter === '3') return moduleCount >= 3 && moduleCount <= 4;
  if (filter === '5') return moduleCount >= 5 && moduleCount <= 9;
  if (filter === '10') return moduleCount >= 10;
  return true;
}

function compareBySortKey(a, b, key, dir) {
  let va, vb;
  if (key === 'last_seen_at') {
    va = new Date(a.module_last_seen || a.last_seen_at || a.first_seen_at || a.created_at || 0).getTime();
    vb = new Date(b.module_last_seen || b.last_seen_at || b.first_seen_at || b.created_at || 0).getTime();
  } else if (key === 'first_seen_at') {
    va = new Date(a.first_seen_at || a.created_at || 0).getTime();
    vb = new Date(b.first_seen_at || b.created_at || 0).getTime();
  } else if (['created_at', 'module_last_seen', 'module_first_seen'].includes(key)) {
    va = new Date(a[key] || 0).getTime();
    vb = new Date(b[key] || 0).getTime();
  } else if (['module_count', 'module_views', 'demo_count'].includes(key)) {
    va = Number(a[key] || 0);
    vb = Number(b[key] || 0);
  } else {
    va = String(a[key] || '').toLowerCase();
    vb = String(b[key] || '').toLowerCase();
  }
  const cmp = va < vb ? -1 : va > vb ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

function paginateArray(arr, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(arr.length / perPage));
  const safePage = Math.max(1, Math.min(page, totalPages));
  return { items: arr.slice((safePage - 1) * perPage, safePage * perPage), page: safePage, totalPages, total: arr.length, perPage };
}

function renderPaginationBar(prefix, pag) {
  const from = pag.total === 0 ? 0 : ((pag.page - 1) * pag.perPage) + 1;
  const to = Math.min(pag.page * pag.perPage, pag.total);
  return `<div class="sa-pagination">
    <div class="sa-pagination-left">
      <span>${from}–${to} de ${pag.total}</span>
      <select data-sa-per-page="${prefix}" aria-label="Registros por página">
        ${[10, 20, 30].map((n) => `<option value="${n}" ${pag.perPage === n ? 'selected' : ''}>${n} por página</option>`).join('')}
      </select>
    </div>
    <div class="sa-pagination-controls">
      <button type="button" class="btn btn-ghost btn-sm" data-sa-page-prev="${prefix}" ${pag.page <= 1 ? 'disabled' : ''}><i class="ph-bold ph-caret-left"></i></button>
      <span>Pág ${pag.page} de ${pag.totalPages}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-sa-page-next="${prefix}" ${pag.page >= pag.totalPages ? 'disabled' : ''}><i class="ph-bold ph-caret-right"></i></button>
    </div>
  </div>`;
}

function sortableHeader(label, key, currentSort) {
  const isActive = currentSort.key === key;
  const arrow = isActive ? (currentSort.dir === 'asc' ? 'ph-caret-up' : 'ph-caret-down') : 'ph-caret-up-down';
  return `<th class="sortable${isActive ? ' sort-active' : ''}" data-sort-key="${key}">${label} <i class="ph ${arrow}"></i></th>`;
}

function bindPagination(prefix, renderFn, getPage, setPage, getPerPage, setPerPage) {
  document.querySelectorAll(`[data-sa-page-prev="${prefix}"]`).forEach((btn) => {
    btn.onclick = () => { setPage(getPage() - 1); renderFn(); };
  });
  document.querySelectorAll(`[data-sa-page-next="${prefix}"]`).forEach((btn) => {
    btn.onclick = () => { setPage(getPage() + 1); renderFn(); };
  });
  document.querySelectorAll(`[data-sa-per-page="${prefix}"]`).forEach((sel) => {
    sel.onchange = () => { setPerPage(Number(sel.value)); setPage(1); renderFn(); };
  });
}

function getFilteredTenants() {
  const search = String($('#saTenantSearch')?.value || '').trim().toLowerCase();
  const moduleFilter = String($('#saTenantModuleFilter')?.value || 'all');
  const stage = String($('#saTenantStageFilter')?.value || 'all');
  const country = String($('#saTenantCountryFilter')?.value || 'all');
  const reseller = String($('#saTenantResellerFilter')?.value || 'all');
  return SA_TENANTS.filter((t) => {
    if (!matchesTenantFilter(t, SA_FILTER)) return false;
    if (!matchesModuleFilter(t, moduleFilter)) return false;
    if (stage !== 'all' && String(t.sales_stage || 'new') !== stage) return false;
    if (country === 'unknown' && t.phone_country) return false;
    if (!['all', 'unknown'].includes(country) && String(t.phone_country || '').toUpperCase() !== country) return false;
    if (reseller === 'direct' && t.reseller_id) return false;
    if (!['all', 'direct'].includes(reseller) && String(t.reseller_id || '') !== reseller) return false;
    if (!search) return true;
    return [t.id, t.slug, t.business_name, t.owner_name, t.owner_username, t.phone, t.phone_digits,
      t.phone_country, t.phone_country_name, t.phone_calling_code, t.reseller_name, t.reseller_slug,
      t.plan_name, t.sales_stage, t.module_count, t.module_views]
      .join(' ').toLowerCase().includes(search);
  }).sort((a, b) => compareBySortKey(a, b, SA_TENANT_SORT.key, SA_TENANT_SORT.dir));
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
  SA_TENANT_PAGE = 1;
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
    renderSalesBulkBars();
    return;
  }

  const pag = paginateArray(filtered, SA_TENANT_PAGE, SA_TENANT_PER_PAGE);
  SA_TENANT_PAGE = pag.page;
  const pageItems = pag.items;

  const allChecked = pageItems.length > 0 && pageItems.every((item) => SA_SELECTED.has(salesSubjectKey('tenant', item.id)));
  table.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th class="sa-select-col"><input type="checkbox" data-sa-select-all="tenant" ${allChecked ? 'checked' : ''} aria-label="Seleccionar prospectos visibles" /></th><th>Prospecto</th><th>Dueño</th><th>Reseller</th><th>Etapa</th>${sortableHeader('Registro', 'created_at', SA_TENANT_SORT)}${sortableHeader('Última actividad', 'module_last_seen', SA_TENANT_SORT)}<th>Acceso</th><th>Plan de interés</th>${sortableHeader('Módulos', 'module_count', SA_TENANT_SORT)}<th>Acciones</th>
  </tr></thead><tbody>${pageItems
    .map((t) => {
      const waUrl = t.phone_valid && t.phone_digits ? `https://wa.me/${t.phone_digits}` : '';
      const country = t.phone_country_name || t.phone_country || 'Sin país';
      const key = salesSubjectKey('tenant', t.id);
      return `<tr class="${SA_SELECTED.has(key) ? 'sa-row-selected' : ''}">
      <td class="sa-select-col"><input type="checkbox" data-sa-sales-select="${key}" ${SA_SELECTED.has(key) ? 'checked' : ''} aria-label="Seleccionar ${esc(t.business_name)}" /></td>
      <td><b>${esc(t.business_name)}</b><div class="meta">/${esc(t.slug)}</div></td>
      <td>${esc(t.owner_name)}
        <div class="meta">${countryFlag(t.phone_country)} ${esc(country)} · Lada ${t.phone_calling_code ? `+${esc(t.phone_calling_code)}` : '—'}</div>
        <div class="meta">${esc(t.phone || '—')}${t.phone && !t.phone_valid ? ' · Revisar número histórico' : ''}</div>
      </td>
      <td>${t.reseller_name ? `<b>${esc(t.reseller_name)}</b><div class="meta">/${esc(t.reseller_slug)}</div>` : '<span class="meta">Directo</span>'}</td>
      <td>${salesStageChip(t.sales_stage)}${t.next_follow_up_at ? `<div class="meta">Próximo: ${fmtDateTime(t.next_follow_up_at)}</div>` : ''}</td>
      <td>${fmtDate(t.created_at)}</td>
      <td>${t.module_last_seen ? fmtDate(t.module_last_seen) : '<span class="meta">—</span>'}</td>
      <td>${statusChip('account', t.account_status)}</td>
      <td>${esc(t.plan_name || 'starter')}<div class="meta">Hasta ${Number(t.branch_limit || 2)} sucursales activas</div></td>
      <td>${moduleUsageButton(t, 'tenant')}</td>
      <td>
        <div class="sa-actions-grid">
          <button type="button" class="btn btn-ghost" data-sa-access="${t.id}"><i class="ph-bold ph-sign-in"></i> Entrar</button>
          <button type="button" class="btn btn-sa-manage" data-sa-manage="tenant:${t.id}"><i class="ph-bold ph-note-pencil"></i> Gestionar</button>
          ${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo" style="color:#22c55e"></i> WhatsApp</a>` : '<button type="button" class="btn btn-ghost" disabled style="opacity:.3"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</button>'}
          <button type="button" class="btn btn-ghost" data-sa-password="${t.id}"><i class="ph-bold ph-key"></i> Clave</button>
          <button type="button" class="btn btn-ghost" data-sa-payment="${t.id}"><i class="ph-bold ph-currency-circle-dollar"></i> Pago</button>
          ${(t.phone_country === 'MX' || String(t.phone_calling_code || '').replace('+', '') === '52') ? `<button type="button" class="btn btn-ghost" data-sa-stamps="${t.id}"><i class="ph-bold ph-stamp"></i> ${Number(t.invoicing_enabled) ? 'Facturación activa' : 'Activar facturación'}</button>` : ''}
          ${t.phone_valid && t.phone_e164 ? `<button type="button" class="btn btn-ghost" data-sa-copy-phone="${esc(t.phone_e164)}"><i class="ph-bold ph-copy"></i> Copiar</button>` : '<button type="button" class="btn btn-ghost" disabled style="opacity:.3"><i class="ph-bold ph-copy"></i> Copiar</button>'}
          <button type="button" class="btn btn-ghost" data-sa-branches="${t.id}"><i class="ph-bold ph-storefront"></i> Sucursales</button>
          <button type="button" class="btn ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'btn-danger' : 'btn-primary'}" data-sa-suspend="${t.id}">
            <i class="ph-bold ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'ph-pause-circle' : 'ph-play-circle'}"></i>
            ${(t.account_status === 'active' && t.billing_status !== 'suspended') ? 'Suspender' : 'Activar'}
          </button>
          <button type="button" class="btn btn-danger" data-sa-delete-tenant="${t.id}"><i class="ph-bold ph-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>`;
    })
    .join('')}</tbody></table></div>${renderPaginationBar('tenant', pag)}`;
  document.querySelectorAll('[data-sa-access]').forEach((btn) => {
    btn.addEventListener('click', () => accessTenant(Number(btn.dataset.saAccess)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-password]').forEach((btn) => {
    btn.addEventListener('click', () => changeTenantPassword(Number(btn.dataset.saPassword)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-payment]').forEach((btn) => {
    btn.addEventListener('click', () => addTenantPayment(Number(btn.dataset.saPayment)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-stamps]').forEach((btn) => {
    btn.addEventListener('click', () => manageTenantStamps(Number(btn.dataset.saStamps)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('[data-sa-suspend]').forEach((btn) => {
    btn.addEventListener('click', () => toggleTenantSuspend(Number(btn.dataset.saSuspend)).catch((err) => toast(err.message, true)));
  });
  document.querySelectorAll('#saTenantsTable [data-sa-branches]').forEach((btn) => {
    btn.addEventListener('click', () => changeBranchLimit(Number(btn.dataset.saBranches)).catch((err) => toast(err.message, true)));
  });
  bindModuleUsageButtons();
  bindPhoneActions();
  bindSalesSelection('tenant', filtered);
  document.querySelectorAll('[data-sa-delete-tenant]').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal('tenant', Number(btn.dataset.saDeleteTenant)));
  });
  // Sort bindings
  document.querySelectorAll('#saTenantsTable .sortable').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sortKey;
      SA_TENANT_SORT = { key: k, dir: SA_TENANT_SORT.key === k && SA_TENANT_SORT.dir === 'desc' ? 'asc' : 'desc' };
      SA_TENANT_PAGE = 1;
      renderTenantTable();
    };
  });
  bindPagination('tenant', renderTenantTable, () => SA_TENANT_PAGE, (v) => { SA_TENANT_PAGE = v; }, () => SA_TENANT_PER_PAGE, (v) => { SA_TENANT_PER_PAGE = v; });
}

async function manageTenantStamps(tenantId) {
  SA_STAMP_TENANT_ID = tenantId;
  SA_STAMP_DATA = await api(`/api/superadmin/tenants/${tenantId}/stamps`);
  renderStampControl();
  $('#saStampModal')?.classList.add('show');
}

const SA_STAMP_MOVEMENT_LABELS = {
  courtesy_grant: 'Cortesía inicial', trial_grant: 'Bono inicial', courtesy_policy_adjustment: 'Ajuste de cortesía', credit: 'Recarga', adjustment: 'Ajuste', consumed: 'CFDI timbrado',
  reserved: 'Reserva', released: 'Reserva liberada', invoicing_enabled: 'Activación', invoicing_disabled: 'Desactivación', environment_changed: 'Cambio de ambiente',
};

function renderStampControl() {
  const data = SA_STAMP_DATA || {};
  const tenant = data.tenant || {};
  const wallet = data.wallet || {};
  const active = Boolean(tenant.enabled);
  const pendingTrial = !tenant.trialGrantedAt;
  const environmentSelect = $('#saStampEnvironment');
  if (environmentSelect) {
    environmentSelect.value = tenant.environment || 'sandbox';
    environmentSelect.disabled = Boolean(tenant.isDemo);
  }
  const productionReady = Boolean(data.provider?.productionConfigured);
  $('#saStampEnvironmentHelp').textContent = tenant.environment === 'production'
    ? 'Producción activa: los timbres generan CFDI fiscales reales. Cada emisor necesita su CSD cargado en Producción.'
    : `Sandbox activo: los CFDI son de prueba.${productionReady ? ' Producción ya está configurada en el servidor.' : ' Faltan credenciales de Producción en el servidor.'}`;
  $('#saStampBusiness').textContent = tenant.businessName || 'Control de timbres';
  $('#saStampSlug').textContent = tenant.slug ? `${tenant.slug} · ${active ? 'Licencia activa' : 'Licencia inactiva'}` : '';
  $('#saStampAvailable').textContent = String(wallet.available ?? wallet.balance ?? 0);
  $('#saStampBalance').textContent = String(wallet.balance || 0);
  $('#saStampReserved').textContent = String(wallet.reserved || 0);
  $('#saStampConsumed').textContent = String(data.totals?.consumed || 0);
  const license = document.querySelector('.sa-stamp-license');
  license?.classList.toggle('is-active', active);
  $('#saStampLicenseTitle').textContent = active ? 'Facturación activa' : 'Facturación desactivada';
  $('#saStampLicenseHelp').textContent = active
    ? (pendingTrial ? 'Confirma la activación para preparar los 2 timbres de cortesía.' : `Cortesía inicial aplicada${tenant.activatedBy ? ` por ${tenant.activatedBy}` : ''}.`)
    : (pendingTrial ? 'Al activar se otorgarán 2 timbres de cortesía una sola vez.' : 'El saldo se conserva y volverá a estar disponible al reactivar.');
  const activationBtn = $('#saStampActivationBtn');
  if (activationBtn) {
    activationBtn.dataset.nextEnabled = (!active || pendingTrial) ? '1' : '0';
    activationBtn.className = `btn ${active && !pendingTrial ? 'btn-danger' : 'btn-primary'}`;
    activationBtn.innerHTML = active && !pendingTrial
      ? '<i class="ph-bold ph-pause-circle"></i> Desactivar facturación'
      : `<i class="ph-bold ph-power"></i> ${active ? 'Aplicar cortesía de 2' : 'Activar facturación'}`;
  }
  const submit = $('#saStampSubmit');
  if (submit) submit.disabled = !active || pendingTrial;
  $('#saStampEmitters').innerHTML = (data.emitters || []).length
    ? data.emitters.map((emitter) => `<div class="sa-stamp-emitter"><div><b>${esc(emitter.label || 'Emisor')}</b><span>${esc(emitter.legalName || '')}</span></div><em>${emitter.enabled ? 'ACTIVO' : 'INACTIVO'}</em><span>RFC ${esc(emitter.rfc)} · Serie ${esc(emitter.series || '—')}</span><span>${emitter.csdUploaded || emitter.sandboxShared ? 'CSD listo' : 'CSD pendiente'} · ${esc(emitter.environment)}</span></div>`).join('')
    : '<div class="empty-mini">Este tenant todavía no ha registrado emisores fiscales.</div>';
  $('#saStampHistory').innerHTML = (data.movements || []).length
    ? data.movements.map((movement) => {
      const quantity = Number(movement.quantity || 0);
      return `<div class="sa-stamp-history-row"><small>${esc(fmtDateTime(movement.created_at))}</small><div><b>${esc(SA_STAMP_MOVEMENT_LABELS[movement.movement_type] || movement.movement_type)}</b><small>${esc(movement.detail || '')}${movement.actor ? ` · ${esc(movement.actor)}` : ''}</small></div><strong class="${quantity > 0 ? 'positive' : quantity < 0 ? 'negative' : ''}">${quantity > 0 ? '+' : ''}${quantity}</strong><small>Saldo ${Number(movement.balance_after ?? wallet.balance ?? 0)}</small></div>`;
    }).join('')
    : '<div class="empty-mini">Aún no hay movimientos de timbres.</div>';
}

function closeStampModal() {
  $('#saStampModal')?.classList.remove('show');
  SA_STAMP_TENANT_ID = null;
  SA_STAMP_DATA = null;
}

async function toggleTenantInvoicing() {
  if (!SA_STAMP_TENANT_ID) return;
  const enabled = $('#saStampActivationBtn')?.dataset.nextEnabled === '1';
  const result = await api(`/api/superadmin/tenants/${SA_STAMP_TENANT_ID}/invoicing`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
  });
  toast(result.trialGrant ? 'Facturación activada: se otorgaron 2 timbres de cortesía' : (enabled ? 'Facturación activada' : 'Facturación desactivada'));
  SA_STAMP_DATA = await api(`/api/superadmin/tenants/${SA_STAMP_TENANT_ID}/stamps`);
  renderStampControl();
  await Promise.all([loadTenants(), loadClients()]);
}

async function submitStampRecharge(event) {
  event.preventDefault();
  if (!SA_STAMP_TENANT_ID) return;
  const quantity = Number($('#saStampQuantity')?.value || 0);
  const note = String($('#saStampNote')?.value || '').trim();
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Captura una cantidad entera mayor a cero');
  await api(`/api/superadmin/tenants/${SA_STAMP_TENANT_ID}/stamps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity, note }),
  });
  toast(`Se agregaron ${quantity} timbres al tenant`);
  SA_STAMP_DATA = await api(`/api/superadmin/tenants/${SA_STAMP_TENANT_ID}/stamps`);
  renderStampControl();
}

async function saveTenantInvoicingEnvironment() {
  if (!SA_STAMP_TENANT_ID) return;
  const environment = String($('#saStampEnvironment')?.value || 'sandbox');
  await api(`/api/superadmin/tenants/${SA_STAMP_TENANT_ID}/invoicing-environment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environment }),
  });
  toast(environment === 'production' ? 'Producción activada; carga el CSD real de cada emisor' : 'Tenant cambiado a Sandbox');
  SA_STAMP_DATA = await api(`/api/superadmin/tenants/${SA_STAMP_TENANT_ID}/stamps`);
  renderStampControl();
}

function getFilteredDemoLeads() {
  const search = String($('#saDemoLeadSearch')?.value || '').trim().toLowerCase();
  const moduleFilter = String($('#saDemoModuleFilter')?.value || 'all');
  const stage = String($('#saDemoStageFilter')?.value || 'all');
  const country = String($('#saDemoCountryFilter')?.value || 'all');
  return SA_DEMO_LEADS.filter((lead) => {
    if (!matchesModuleFilter(lead, moduleFilter)) return false;
    if (stage !== 'all' && String(lead.sales_stage || 'new') !== stage) return false;
    if (country === 'unknown' && lead.phone_country) return false;
    if (!['all', 'unknown'].includes(country) && String(lead.phone_country || '').toUpperCase() !== country) return false;
    if (!search) return true;
    return [lead.id, lead.contact_name, lead.phone, lead.phone_digits, lead.phone_country,
      lead.phone_country_name, lead.phone_calling_code, lead.business_giro, lead.source_label,
      lead.source_page, lead.last_demo_tenant_slug, lead.demo_count, lead.sales_stage,
      lead.module_count, lead.module_views]
      .join(' ').toLowerCase().includes(search);
  }).sort((a, b) => compareBySortKey(a, b, SA_DEMO_SORT.key, SA_DEMO_SORT.dir));
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
    renderSalesBulkBars();
    return;
  }

  const pag = paginateArray(filtered, SA_DEMO_PAGE, SA_DEMO_PER_PAGE);
  SA_DEMO_PAGE = pag.page;
  const pageItems = pag.items;

  const allChecked = pageItems.length > 0 && pageItems.every((item) => SA_SELECTED.has(salesSubjectKey('demo_lead', item.id)));
  table.innerHTML = `<div class="table-wrap"><table><thead><tr>
    <th class="sa-select-col"><input type="checkbox" data-sa-select-all="demo_lead" ${allChecked ? 'checked' : ''} aria-label="Seleccionar leads visibles" /></th>${sortableHeader('Nombre', 'contact_name', SA_DEMO_SORT)}${sortableHeader('Etapa', 'sales_stage', SA_DEMO_SORT)}<th>País</th><th>Lada / teléfono</th><th>Giro</th><th>Origen</th>${sortableHeader('Veces', 'demo_count', SA_DEMO_SORT)}${sortableHeader('Primera vez', 'first_seen_at', SA_DEMO_SORT)}${sortableHeader('Última vez', 'last_seen_at', SA_DEMO_SORT)}${sortableHeader('Módulos', 'module_count', SA_DEMO_SORT)}<th>Acciones</th>
  </tr></thead><tbody>${pageItems
    .map((lead) => {
      const digits = String(lead.phone_digits || '').replace(/\D/g, '');
      const waUrl = lead.phone_valid && digits ? `https://wa.me/${digits}` : '';
      const key = salesSubjectKey('demo_lead', lead.id);
      const firstSeen = lead.first_seen_at || lead.created_at;
      const lastSeen = lead.module_last_seen || lead.last_seen_at || firstSeen;
      return `<tr class="${SA_SELECTED.has(key) ? 'sa-row-selected' : ''}">
        <td class="sa-select-col"><input type="checkbox" data-sa-sales-select="${key}" ${SA_SELECTED.has(key) ? 'checked' : ''} aria-label="Seleccionar ${esc(lead.contact_name)}" /></td>
        <td><b>${esc(lead.contact_name)}</b><div class="meta">ID #${lead.id}</div></td>
        <td>${salesStageChip(lead.sales_stage)}${lead.next_follow_up_at ? `<div class="meta">Próximo: ${fmtDateTime(lead.next_follow_up_at)}</div>` : ''}</td>
        <td>${countryFlag(lead.phone_country)} ${esc(lead.phone_country_name || lead.phone_country || '—')}</td>
        <td><b>${lead.phone_calling_code ? `+${esc(lead.phone_calling_code)}` : '—'}</b><div class="meta">${digits ? esc(lead.phone) : '—'}${lead.phone && !lead.phone_valid ? ' · Revisar número histórico' : ''}</div></td>
        <td>${esc(lead.business_giro)}</td>
        <td><span class="tag">${esc(lead.source_label || 'Landing')}</span></td>
        <td><b>${Number(lead.demo_count || 0)}</b></td>
        <td>${fmtDate(firstSeen)}</td>
        <td>${lastSeen ? fmtDate(lastSeen) : '<span class="meta">—</span>'}</td>
        <td>${moduleUsageButton(lead, 'lead')}</td>
        <td>
          <div class="sa-actions-grid-2">
            ${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</a>` : '<button type="button" class="btn btn-ghost" disabled style="opacity:.3"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</button>'}
            ${lead.phone_valid && lead.phone_e164 ? `<button type="button" class="btn btn-ghost" data-sa-copy-phone="${esc(lead.phone_e164)}"><i class="ph-bold ph-copy"></i> Copiar</button>` : '<button type="button" class="btn btn-ghost" disabled style="opacity:.3"><i class="ph-bold ph-copy"></i> Copiar</button>'}
            <button type="button" class="btn btn-sa-manage" data-sa-manage="demo_lead:${lead.id}"><i class="ph-bold ph-note-pencil"></i> Gestionar</button>
            <button type="button" class="btn btn-danger" data-sa-delete-lead="${lead.id}"><i class="ph-bold ph-trash"></i> Eliminar</button>
          </div>
        </td>
      </tr>`;
    })
    .join('')}</tbody></table></div>${renderPaginationBar('demo_lead', pag)}`;

  bindModuleUsageButtons();
  bindPhoneActions();
  bindSalesSelection('demo_lead', filtered);
  document.querySelectorAll('[data-sa-delete-lead]').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal('lead', Number(btn.dataset.saDeleteLead)));
  });
  // Sort bindings
  document.querySelectorAll('#saDemoLeadsTable .sortable').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sortKey;
      SA_DEMO_SORT = { key: k, dir: SA_DEMO_SORT.key === k && SA_DEMO_SORT.dir === 'desc' ? 'asc' : 'desc' };
      SA_DEMO_PAGE = 1;
      renderDemoLeadsTable();
    };
  });
  bindPagination('demo_lead', renderDemoLeadsTable, () => SA_DEMO_PAGE, (v) => { SA_DEMO_PAGE = v; }, () => SA_DEMO_PER_PAGE, (v) => { SA_DEMO_PER_PAGE = v; });
}

function salesStageMeta(value) {
  const found = SA_SALES_STAGES.find(([key]) => key === String(value || 'new')) || SA_SALES_STAGES[0];
  return { value: found[0], label: found[1], tone: found[2] };
}

function salesStageChip(value) {
  const stage = salesStageMeta(value);
  return `<span class="sa-stage-chip stage-${stage.tone}">${esc(stage.label)}</span>`;
}

function salesStageOptions({ includeAll = false, includeActive = false, includeKeep = false } = {}) {
  const options = [];
  if (includeKeep) options.push('<option value="">Mantener etapa actual</option>');
  if (includeAll) options.push('<option value="all">Todas las etapas</option>');
  if (includeActive) options.push('<option value="active">Candidatos activos</option>');
  options.push(...SA_SALES_STAGES.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`));
  return options.join('');
}

function salesSubjectKey(type, id) {
  return `${type}:${Number(id)}`;
}

function findSalesSubject(type, id) {
  if (type === 'tenant') return SA_TENANTS.find((item) => Number(item.id) === Number(id))
    || SA_FOLLOW_UP.find((item) => item.entity_type === type && Number(item.id) === Number(id));
  return SA_DEMO_LEADS.find((item) => Number(item.id) === Number(id))
    || SA_FOLLOW_UP.find((item) => item.entity_type === type && Number(item.id) === Number(id));
}

function selectionSubjects(type = null) {
  return [...SA_SELECTED].map((key) => {
    const [subjectType, rawId] = key.split(':');
    const entity = findSalesSubject(subjectType, Number(rawId));
    return entity ? { type: subjectType, id: Number(rawId), entity } : null;
  }).filter((item) => item && (!type || item.type === type));
}

function initSalesStageControls() {
  const tenantFilter = $('#saTenantStageFilter');
  const demoFilter = $('#saDemoStageFilter');
  const followFilter = $('#saFollowUpStageFilter');
  const modalStage = $('#saFollowUpStage');
  if (tenantFilter) tenantFilter.innerHTML = salesStageOptions({ includeAll: true });
  if (demoFilter) demoFilter.innerHTML = salesStageOptions({ includeAll: true });
  if (followFilter) {
    followFilter.innerHTML = salesStageOptions({ includeAll: true, includeActive: true });
    followFilter.value = 'active';
  }
  if (modalStage) modalStage.innerHTML = salesStageOptions();
}

function subjectDisplayName(subject) {
  if (subject.type === 'tenant') return subject.entity.business_name || subject.entity.name || `Prospecto #${subject.id}`;
  return subject.entity.contact_name || subject.entity.name || `Lead #${subject.id}`;
}

function renderSalesBulkBars() {
  const configs = [['#saTenantBulkBar', 'tenant'], ['#saDemoBulkBar', 'demo_lead'], ['#saFollowUpBulkBar', null]];
  configs.forEach(([selector, type]) => {
    const bar = $(selector);
    if (!bar) return;
    const subjects = selectionSubjects(type);
    bar.hidden = subjects.length === 0;
    if (!subjects.length) { bar.innerHTML = ''; return; }
    const deletable = subjects.every((item) => SA_DELETABLE_STAGES.has(String(item.entity.sales_stage || 'new')));
    const scope = type || 'all';
    bar.innerHTML = `<div><b>${subjects.length}</b> seleccionado${subjects.length === 1 ? '' : 's'}</div>
      <div class="sa-bulk-actions">
        <button type="button" class="btn btn-primary" data-sa-bulk-manage="${scope}"><i class="ph-bold ph-note-pencil"></i> Agregar gestión</button>
        <button type="button" class="btn btn-danger" data-sa-bulk-delete="${scope}" ${deletable ? '' : 'disabled title="Marca primero todos como No interesado o Cierre no exitoso"'}><i class="ph-bold ph-trash"></i> Eliminar</button>
        <button type="button" class="btn btn-ghost" data-sa-bulk-clear="${scope}">Quitar selección</button>
      </div>`;
  });
  document.querySelectorAll('[data-sa-bulk-manage]').forEach((button) => {
    button.onclick = () => {
      const scope = button.dataset.saBulkManage;
      openFollowUpModal(selectionSubjects(scope === 'all' ? null : scope));
    };
  });
  document.querySelectorAll('[data-sa-bulk-delete]').forEach((button) => {
    button.onclick = () => {
      const scope = button.dataset.saBulkDelete;
      openBulkDelete(selectionSubjects(scope === 'all' ? null : scope));
    };
  });
  document.querySelectorAll('[data-sa-bulk-clear]').forEach((button) => {
    button.onclick = () => {
      const scope = button.dataset.saBulkClear;
      selectionSubjects(scope === 'all' ? null : scope).forEach((item) => SA_SELECTED.delete(salesSubjectKey(item.type, item.id)));
      renderTenantTable(); renderDemoLeadsTable(); renderFollowUpTable();
    };
  });
}

function bindSalesSelection(type, visibleItems) {
  document.querySelectorAll('[data-sa-sales-select]').forEach((checkbox) => {
    checkbox.onchange = () => {
      if (checkbox.checked) SA_SELECTED.add(checkbox.dataset.saSalesSelect);
      else SA_SELECTED.delete(checkbox.dataset.saSalesSelect);
      checkbox.closest('tr')?.classList.toggle('sa-row-selected', checkbox.checked);
      renderSalesBulkBars();
    };
  });
  document.querySelectorAll(`[data-sa-select-all="${type || 'all'}"]`).forEach((checkbox) => {
    checkbox.onchange = () => {
      visibleItems.forEach((item) => {
        const itemType = type || item.entity_type;
        const key = salesSubjectKey(itemType, item.id);
        if (checkbox.checked) SA_SELECTED.add(key); else SA_SELECTED.delete(key);
      });
      if (type === 'tenant') renderTenantTable();
      else if (type === 'demo_lead') renderDemoLeadsTable();
      else renderFollowUpTable();
    };
  });
  document.querySelectorAll('[data-sa-manage]').forEach((button) => {
    button.onclick = () => {
      const [subjectType, rawId] = String(button.dataset.saManage || '').split(':');
      const entity = findSalesSubject(subjectType, Number(rawId));
      if (entity) openFollowUpModal([{ type: subjectType, id: Number(rawId), entity }]);
    };
  });
  renderSalesBulkBars();
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function closeFollowUpModal() {
  $('#saFollowUpModal')?.classList.remove('show');
  SA_FOLLOWUP_TARGETS = [];
}

async function openFollowUpModal(subjects) {
  if (!Array.isArray(subjects) || !subjects.length) return;
  SA_FOLLOWUP_TARGETS = subjects;
  const isBulk = subjects.length > 1;
  const stage = $('#saFollowUpStage');
  stage.innerHTML = salesStageOptions({ includeKeep: isBulk });
  stage.required = !isBulk;
  stage.value = isBulk ? '' : String(subjects[0].entity.sales_stage || 'new');
  $('#saFollowUpActivityType').value = 'contact';
  $('#saFollowUpDate').value = isBulk ? '' : toDateTimeLocal(subjects[0].entity.next_follow_up_at);
  $('#saFollowUpNote').value = '';
  $('#saFollowUpSubject').textContent = isBulk ? `${subjects.length} contactos seleccionados. La gestión se agregará a todos.` : subjectDisplayName(subjects[0]);
  $('#saFollowUpHistoryWrap').hidden = isBulk;
  $('#saFollowUpHistory').innerHTML = isBulk ? '' : '<div class="hint">Cargando historial...</div>';
  $('#saFollowUpModal')?.classList.add('show');
  if (!isBulk) {
    try {
      const subject = subjects[0];
      const payload = await api(`/api/superadmin/follow-up/${subject.type}/${subject.id}/activities`);
      renderFollowUpHistory(payload.activities || []);
    } catch (error) {
      $('#saFollowUpHistory').innerHTML = `<div class="hint">${esc(error.message)}</div>`;
    }
  }
}

function renderFollowUpHistory(activities) {
  const el = $('#saFollowUpHistory');
  if (!el) return;
  if (!activities.length) {
    el.innerHTML = '<div class="empty sa-history-empty"><i class="ph ph-note"></i><b>Sin gestiones todavía</b></div>';
    return;
  }
  const typeLabels = { contact: 'Contactación', follow_up: 'Seguimiento', note: 'Nota', close_won: 'Cierre exitoso', close_lost: 'Cierre no exitoso', stage_change: 'Cambio de etapa' };
  el.innerHTML = `<div class="sa-activity-list">${activities.map((item) => `<article class="sa-activity-item">
    <div><b>${esc(typeLabels[item.activity_type] || item.activity_type)}</b><time>${fmtDateTime(item.created_at)}</time></div>
    ${item.stage_from !== item.stage_to ? `<div>${salesStageChip(item.stage_from)} <i class="ph-bold ph-arrow-right"></i> ${salesStageChip(item.stage_to)}</div>` : ''}
    ${item.note ? `<p>${esc(item.note)}</p>` : ''}
    ${item.follow_up_at ? `<small><i class="ph-bold ph-calendar-check"></i> Próximo: ${fmtDateTime(item.follow_up_at)}</small>` : ''}
    <small>Por ${esc(item.created_by || 'superadmin')}</small>
  </article>`).join('')}</div>`;
}

async function submitFollowUp(event) {
  event.preventDefault();
  if (!SA_FOLLOWUP_TARGETS.length) return;
  const targets = [...SA_FOLLOWUP_TARGETS];
  const isBulk = targets.length > 1;
  const followUpDate = $('#saFollowUpDate').value;
  const payload = { activityType: $('#saFollowUpActivityType').value, note: $('#saFollowUpNote').value };
  if (followUpDate) payload.nextFollowUpAt = new Date(followUpDate).toISOString();
  else if (!isBulk) payload.nextFollowUpAt = null;
  const selectedStage = $('#saFollowUpStage').value;
  if (selectedStage) payload.stage = selectedStage;
  if (isBulk) {
    payload.subjects = targets.map(({ type, id }) => ({ type, id }));
    await api('/api/superadmin/follow-up/bulk/update', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } else {
    const subject = targets[0];
    await api(`/api/superadmin/follow-up/item/${subject.type}/${subject.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  }
  closeFollowUpModal();
  toast(isBulk ? `Gestión agregada a ${targets.length} contactos` : 'Gestión comercial guardada');
  SA_SELECTED.clear();
  await Promise.all([loadTenants(), loadDemoLeads(), loadFollowUp()]);
}

function isActiveSalesStage(stage) {
  return ['contacted', 'interested', 'potential', 'follow_up'].includes(String(stage || 'new'));
}

function getFilteredFollowUp() {
  const search = String($('#saFollowUpSearch')?.value || '').trim().toLowerCase();
  const stage = String($('#saFollowUpStageFilter')?.value || 'active');
  const type = String($('#saFollowUpTypeFilter')?.value || 'all');
  return SA_FOLLOW_UP.filter((item) => {
    if (type !== 'all' && item.entity_type !== type) return false;
    if (stage === 'active' && !isActiveSalesStage(item.sales_stage)) return false;
    if (stage !== 'all' && stage !== 'active' && String(item.sales_stage || 'new') !== stage) return false;
    if (!search) return true;
    return [item.name, item.contact_name, item.phone, item.phone_country_name, item.detail, item.last_note].join(' ').toLowerCase().includes(search);
  });
}

function renderFollowUpSummary() {
  const el = $('#saFollowUpSummary');
  if (!el) return;
  el.innerHTML = ['contacted', 'interested', 'potential', 'follow_up'].map((stage) => {
    const meta = salesStageMeta(stage);
    const count = SA_FOLLOW_UP.filter((item) => item.sales_stage === stage).length;
    return `<button type="button" class="card sa-followup-stage-card stage-${meta.tone}" data-sa-followup-stage="${stage}"><span>${esc(meta.label)}</span><b>${count}</b></button>`;
  }).join('');
  document.querySelectorAll('[data-sa-followup-stage]').forEach((button) => {
    button.onclick = () => { $('#saFollowUpStageFilter').value = button.dataset.saFollowupStage; renderFollowUpTable(); };
  });
}

function renderFollowUpTable() {
  const table = $('#saFollowUpTable');
  if (!table) return;
  const filtered = getFilteredFollowUp();
  if (!filtered.length) {
    table.innerHTML = '<div class="empty"><i class="ph ph-path"></i><b>Sin candidatos en esta etapa</b><p>Gestiona prospectos o leads demo para incorporarlos al seguimiento.</p></div>';
    renderSalesBulkBars(); return;
  }
  const allChecked = filtered.every((item) => SA_SELECTED.has(salesSubjectKey(item.entity_type, item.id)));
  table.innerHTML = `<div class="table-wrap"><table><thead><tr><th class="sa-select-col"><input type="checkbox" data-sa-select-all="all" ${allChecked ? 'checked' : ''} aria-label="Seleccionar candidatos visibles" /></th><th>Candidato</th><th>Origen</th><th>Etapa</th><th>Próximo seguimiento</th><th>Última gestión</th><th>Acciones</th></tr></thead><tbody>${filtered.map((item) => {
    const key = salesSubjectKey(item.entity_type, item.id);
    const overdue = item.next_follow_up_at && new Date(item.next_follow_up_at).getTime() < Date.now();
    const waUrl = item.phone_valid && item.phone_digits ? `https://wa.me/${item.phone_digits}` : '';
    return `<tr class="${SA_SELECTED.has(key) ? 'sa-row-selected' : ''}"><td class="sa-select-col"><input type="checkbox" data-sa-sales-select="${key}" ${SA_SELECTED.has(key) ? 'checked' : ''} /></td><td><b>${esc(item.name || item.contact_name)}</b><div class="meta">${esc(item.contact_name || '')} · ${esc(item.phone || '—')}</div></td><td><span class="tag">${item.entity_type === 'tenant' ? 'Prospecto' : 'Lead demo'}</span></td><td>${salesStageChip(item.sales_stage)}</td><td><span class="${overdue ? 'sa-followup-overdue' : ''}">${item.next_follow_up_at ? fmtDateTime(item.next_follow_up_at) : 'Sin programar'}</span></td><td>${item.last_note ? `<span class="sa-last-note">${esc(item.last_note)}</span>` : '<span class="meta">Sin notas</span>'}<div class="meta">${Number(item.activity_count || 0)} gestiones · ${fmtDateTime(item.last_activity_at)}</div></td><td><div class="sa-row-actions"><button type="button" class="btn btn-primary" data-sa-manage="${key}"><i class="ph-bold ph-note-pencil"></i> Gestionar</button>${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</a>` : ''}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
  bindSalesSelection(null, filtered);
}

async function loadFollowUp() {
  const payload = await api('/api/superadmin/follow-up');
  SA_FOLLOW_UP = Array.isArray(payload?.items) ? payload.items : [];
  renderFollowUpSummary(); renderFollowUpTable();
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
    <th>Cliente</th><th>Contacto</th><th>Cliente desde</th><th>Estado</th><th>Plan / cupos</th><th>Timbres</th><th>Último pago</th><th>Vencimiento</th><th>Ingresos</th><th>Acciones</th>
  </tr></thead><tbody>${filtered.map((client) => {
    const waUrl = client.phone_valid && client.phone_digits ? `https://wa.me/${client.phone_digits}` : '';
    return `<tr>
      <td><b>${esc(client.business_name)}</b><div class="meta">/${esc(client.slug)}</div></td>
      <td>${esc(client.owner_name)}<div class="meta">${countryFlag(client.phone_country)} ${esc(client.phone || '—')}</div></td>
      <td>${fmtDate(client.customer_since)}</td>
      <td>${statusChip('billing', client.billing_status)}<div class="meta">${Number(client.mora_days || 0) > 0 ? `${Number(client.mora_days)} días de mora` : 'Cuenta ' + (client.account_status === 'active' ? 'activa' : 'inactiva')}</div></td>
      <td><b>${esc(client.plan_name || 'starter')}</b><div class="meta">${Number(client.license_count || 1)} licencia${Number(client.license_count || 1) === 1 ? '' : 's'} · Hasta ${Number(client.branch_limit || 2)} sucursales</div></td>
      <td>${Number(client.invoicing_enabled) ? `<b>${client.stamp_unlimited ? 'Ilimitados' : Number(client.stamp_available || 0)} disponibles</b><div class="meta">${Number(client.stamp_consumed || 0)} gastados</div>` : '<span class="meta">No activa</span>'}</td>
      <td>${fmtMoney(client.last_payment_amount)}<div class="meta">${fmtDate(client.last_payment_at)} · ${esc(client.last_payment_method || '—')}</div></td>
      <td>${fmtDate(client.billing_due_date)}</td>
      <td><b>${fmtMoney(client.total_paid)}</b><div class="meta">${Number(client.payment_count || 0)} pago${Number(client.payment_count || 0) === 1 ? '' : 's'}</div></td>
      <td><div class="sa-actions-grid">
        <button type="button" class="btn btn-ghost" data-sa-access="${client.id}"><i class="ph-bold ph-sign-in"></i> Entrar</button>
        <button type="button" class="btn btn-ghost" data-sa-password="${client.id}"><i class="ph-bold ph-key"></i> Clave</button>
        <button type="button" class="btn btn-ghost" data-sa-payment="${client.id}"><i class="ph-bold ph-currency-circle-dollar"></i> Pago</button>
        <button type="button" class="btn btn-ghost" data-sa-payments="${client.id}"><i class="ph-bold ph-receipt"></i> Historial</button>
        <button type="button" class="btn btn-ghost" data-sa-licenses="${client.id}"><i class="ph-bold ph-key"></i> Licencias</button>
        <button type="button" class="btn btn-ghost" data-sa-branches="${client.id}"><i class="ph-bold ph-storefront"></i> Sucursales</button>
        ${(Number(client.invoicing_enabled) || client.phone_country === 'MX' || String(client.phone_calling_code || '').replace('+', '') === '52') ? `<button type="button" class="btn btn-ghost" data-sa-stamps="${client.id}"><i class="ph-bold ph-stamp"></i> ${Number(client.invoicing_enabled) ? 'Facturación activa' : 'Activar facturación'}</button>` : ''}
        ${waUrl ? `<a class="btn btn-ghost" href="${waUrl}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo" style="color:#22c55e"></i> WhatsApp</a>` : '<button type="button" class="btn btn-ghost" disabled style="opacity:.3"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</button>'}
        <button type="button" class="btn ${(client.account_status === 'active' && client.billing_status !== 'suspended') ? 'btn-danger' : 'btn-primary'}" data-sa-suspend="${client.id}">
          <i class="ph-bold ${(client.account_status === 'active' && client.billing_status !== 'suspended') ? 'ph-pause-circle' : 'ph-play-circle'}"></i>
          ${(client.account_status === 'active' && client.billing_status !== 'suspended') ? 'Suspender' : 'Activar'}
        </button>
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
  document.querySelectorAll('#saClientsTable [data-sa-stamps]').forEach((button) => button.onclick = () => manageTenantStamps(Number(button.dataset.saStamps)).catch((error) => toast(error.message, true)));
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

  // Calcular tiempo total activo: suma del tiempo activo en cada módulo individual
  let totalActiveMs = 0;
  for (const m of modules) {
    if (m.firstSeenAt && m.lastSeenAt) {
      const d1 = new Date(m.firstSeenAt).getTime();
      const d2 = new Date(m.lastSeenAt).getTime();
      if (!Number.isNaN(d1) && !Number.isNaN(d2) && d2 > d1) {
        totalActiveMs += (d2 - d1);
      }
    }
  }

  let tiempoTotal = '—';
  if (totalActiveMs > 0) {
    if (totalActiveMs < 60000) {
      tiempoTotal = `${Math.round(totalActiveMs / 1000)} seg`;
    } else if (totalActiveMs < 3600000) {
      tiempoTotal = `${Math.round(totalActiveMs / 60000)} min`;
    } else {
      const hrs = Math.floor(totalActiveMs / 3600000);
      const mins = Math.round((totalActiveMs % 3600000) / 60000);
      tiempoTotal = mins > 0 ? `${hrs}h ${mins}min` : `${hrs}h`;
    }
  } else if (totalViews > 0) {
    tiempoTotal = '< 1 min';
  }

  $('#saModulesSubject').textContent = `${type === 'tenant' ? 'Tenant' : 'Lead demo'}: ${name}`;
  $('#saModulesSummary').innerHTML = `
    <div><span>Módulos utilizados</span><b>${Number(entity.module_count || modules.length)}</b></div>
    <div><span>Accesos totales</span><b>${totalViews}</b></div>
    <div><span>Primera actividad</span><b class="module-first-seen">${fmtDateTime(entity.module_first_seen)}</b></div>
    <div><span>Última actividad</span><b class="module-last-seen">${fmtDateTime(entity.module_last_seen)}</b></div>
    <div><span>Tiempo total en sistema</span><b class="module-total-time">${tiempoTotal}</b></div>
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

function openBulkDelete(subjects) {
  if (!Array.isArray(subjects) || !subjects.length) return;
  if (!subjects.every((item) => SA_DELETABLE_STAGES.has(String(item.entity.sales_stage || 'new')))) {
    return toast('Solo puedes eliminar en masa contactos marcados como No interesado o Cierre no exitoso', true);
  }
  SA_DELETE_TARGET = { type: 'bulk', subjects: subjects.map(({ type, id }) => ({ type, id })) };
  $('#saDeleteMessage').textContent = `¿Seguro que deseas eliminar permanentemente ${subjects.length} contactos descartados?`;
  $('#saDeleteHint').textContent = 'Se eliminarán sus datos e historial. Esta acción no incluye clientes y no se puede deshacer.';
  $('#saDeleteModal')?.classList.add('show');
}

async function confirmDelete() {
  const target = SA_DELETE_TARGET;
  if (!target) return;
  const confirmBtn = $('#saDeleteConfirm');
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    if (target.type === 'bulk') {
      await api('/api/superadmin/follow-up/bulk', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjects: target.subjects }),
      });
      const deletedCount = target.subjects.length;
      closeDeleteModal();
      SA_SELECTED.clear();
      toast(`${deletedCount} contacto${deletedCount === 1 ? '' : 's'} eliminado${deletedCount === 1 ? '' : 's'}`);
      await Promise.all([loadTenants(), loadDemoLeads(), loadFollowUp()]);
      return;
    }
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
  renderCountryFilter('#saDemoCountryFilter', SA_DEMO_LEADS);
  renderDemoLeadSummary(payload?.summary || null);
  renderDemoLeadsTable();
}

async function loadTenants() {
  const payload = await api('/api/superadmin/tenants');
  SA_TENANTS = Array.isArray(payload?.tenants) ? payload.tenants : [];
  renderTenantCountryFilter();
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
  const currentPlan = String(tenant.plan_name || '').toLowerCase();
  $('#saPayPlan').value = ['mensual', 'annual', 'invoicing_sat'].includes(currentPlan) ? currentPlan : 'mensual';
  $('#saPayAmount').value = currentPlan === 'invoicing_sat' ? '1499' : '';
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
  const planCode = String($('#saPayPlan')?.value || '').trim().toLowerCase();
  if (!['mensual', 'annual', 'invoicing_sat'].includes(planCode)) return toast('Selecciona un plan válido', true);

  const payload = await api(`/api/superadmin/tenants/${tenantId}/payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, method, note, paidAt, planCode }),
  });

  closePaymentModal();
  const bonusText = payload?.stampBonusGranted ? ' Se acreditaron 100 timbres de bienvenida.' : '';
  toast((payload?.becameClient
    ? `Pago aplicado: el prospecto ya es cliente. Vence ${fmtDate(payload?.nextDueDate)}`
    : `Pago aplicado. Próximo vencimiento: ${fmtDate(payload?.nextDueDate)}`) + bonusText);
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

function renderResellerFilter() {
  const select = $('#saTenantResellerFilter');
  if (!select) return;
  const current = select.value || 'all';
  select.innerHTML = '<option value="all">Todos los resellers</option><option value="direct">Registro directo</option>'
    + SA_RESELLERS.map((item) => `<option value="${Number(item.id)}">${esc(item.display_name)}</option>`).join('');
  select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
}

function renderTenantCountryFilter() {
  renderCountryFilter('#saTenantCountryFilter', SA_TENANTS);
}

function renderCountryFilter(selector, entities) {
  const select = $(selector);
  if (!select) return;
  const current = select.value || 'all';
  const countries = new Map();
  let hasUnknown = false;
  entities.forEach((entity) => {
    const code = String(entity.phone_country || '').trim().toUpperCase();
    if (!code) {
      hasUnknown = true;
      return;
    }
    countries.set(code, String(entity.phone_country_name || code).trim());
  });
  const options = [...countries.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'es', { sensitivity: 'base' }))
    .map(([code, name]) => `<option value="${esc(code)}">${countryFlag(code)} ${esc(name)}</option>`);
  if (hasUnknown) options.push('<option value="unknown">Sin país registrado</option>');
  select.innerHTML = '<option value="all">Todos los países</option>' + options.join('');
  select.value = [...select.options].some((option) => option.value === current) ? current : 'all';
}

function renderResellers() {
  const table = $('#saResellersTable');
  if (!table) return;
  if (!SA_RESELLERS.length) {
    table.innerHTML = '<div class="empty"><i class="ph ph-users-four"></i><b>Sin resellers</b><p>Crea el primer acceso y comparte su enlace de captación.</p></div>';
    return;
  }
  table.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Reseller</th><th>Contacto</th><th>Enlaces</th><th>Prospectos</th><th>Clientes</th><th>Leads demo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${SA_RESELLERS.map((item) => {
    const referral = `${location.origin}/${item.slug}`;
    const login = `${location.origin}/resellers/${item.slug}`;
    return `<tr><td><b>${esc(item.display_name)}</b><div class="meta">Usuario: ${esc(item.username)}</div></td><td>${esc(item.contact_name || '—')}<div class="meta">${esc(item.contact_phone || '')}</div></td><td><div class="meta">Clientes: /${esc(item.slug)}</div><div class="meta">Acceso: /resellers/${esc(item.slug)}</div></td><td><b>${Number(item.prospect_count || 0)}</b></td><td><b>${Number(item.client_count || 0)}</b></td><td><b>${Number(item.demo_lead_count || 0)}</b></td><td><span class="tag">${Number(item.active) ? 'Activo' : 'Inactivo'}</span></td><td><div class="sa-row-actions"><button class="btn btn-ghost" type="button" data-reseller-copy="${esc(referral)}"><i class="ph-bold ph-copy"></i> Link clientes</button><button class="btn btn-ghost" type="button" data-reseller-copy="${esc(login)}"><i class="ph-bold ph-sign-in"></i> Link acceso</button><button class="btn btn-ghost" type="button" data-reseller-edit="${item.id}"><i class="ph-bold ph-pencil"></i> Editar</button><button class="btn ${Number(item.active) ? 'btn-danger' : 'btn-primary'}" type="button" data-reseller-toggle="${item.id}">${Number(item.active) ? 'Desactivar' : 'Activar'}</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
  document.querySelectorAll('[data-reseller-copy]').forEach((button) => button.onclick = async () => { await navigator.clipboard.writeText(button.dataset.resellerCopy); toast('Enlace copiado'); });
  document.querySelectorAll('[data-reseller-edit]').forEach((button) => button.onclick = () => openResellerModal(Number(button.dataset.resellerEdit)));
  document.querySelectorAll('[data-reseller-toggle]').forEach((button) => button.onclick = () => toggleReseller(Number(button.dataset.resellerToggle)).catch((error) => toast(error.message, true)));
}

async function loadResellers() {
  const payload = await api('/api/superadmin/resellers');
  SA_RESELLERS = Array.isArray(payload.resellers) ? payload.resellers : [];
  renderResellers();
  renderResellerFilter();
  renderTenantTable();
}

function openResellerModal(id = null) {
  const item = id ? SA_RESELLERS.find((entry) => Number(entry.id) === Number(id)) : null;
  $('#saResellerId').value = item ? String(item.id) : '';
  $('#saResellerName').value = item?.display_name || '';
  $('#saResellerSlug').value = item?.slug || '';
  $('#saResellerUsername').value = item?.username || '';
  $('#saResellerPassword').value = '';
  $('#saResellerContact').value = item?.contact_name || '';
  $('#saResellerPhone').value = item?.contact_phone || '';
  $('#saResellerNotes').value = item?.notes || '';
  $('#saResellerSlug').readOnly = Boolean(item);
  $('#saResellerUsername').readOnly = Boolean(item);
  $('#saResellerPassword').required = !item;
  $('#saResellerPasswordHint').textContent = item ? '(vacía para conservar)' : '*';
  $('#saResellerModalTitle').textContent = item ? 'Editar reseller' : 'Nuevo reseller';
  $('#saResellerModal').classList.add('show');
}

function closeResellerModal() { $('#saResellerModal')?.classList.remove('show'); }

async function saveReseller(event) {
  event.preventDefault();
  const id = Number($('#saResellerId').value || 0);
  const payload = {
    displayName: $('#saResellerName').value,
    contactName: $('#saResellerContact').value,
    contactPhone: $('#saResellerPhone').value,
    notes: $('#saResellerNotes').value,
  };
  if ($('#saResellerPassword').value) payload.password = $('#saResellerPassword').value;
  if (!id) {
    payload.slug = $('#saResellerSlug').value.trim().toLowerCase();
    payload.username = $('#saResellerUsername').value.trim().toLowerCase();
  }
  await api(id ? `/api/superadmin/resellers/${id}` : '/api/superadmin/resellers', { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  closeResellerModal();
  await loadResellers();
  toast(id ? 'Reseller actualizado' : 'Reseller creado');
}

async function toggleReseller(id) {
  const item = SA_RESELLERS.find((entry) => Number(entry.id) === Number(id));
  if (!item) return;
  await api(`/api/superadmin/resellers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !Number(item.active) }) });
  await loadResellers();
  toast(Number(item.active) ? 'Reseller desactivado' : 'Reseller activado');
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
  const isFollowUp = view === 'follow-up';
  const isResellers = view === 'resellers';
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
  } else if (isFollowUp) {
    title = '<i class="ph-bold ph-path"></i> Seguimiento';
    subtitle = 'Pipeline comercial de candidatos con potencial de compra.';
  } else if (isResellers) {
    title = '<i class="ph-bold ph-users-four"></i> Resellers';
    subtitle = 'Accesos, enlaces de captación y resultados por revendedor.';
  }
  $('#saViewTenants').hidden = !isTenants;
  $('#saViewTenants').classList.toggle('active', isTenants);
  $('#saViewClients').hidden = !isClients;
  $('#saViewClients').classList.toggle('active', isClients);
  $('#saViewDemoLeads').hidden = !isDemoLeads;
  $('#saViewDemoLeads').classList.toggle('active', isDemoLeads);
  $('#saViewFollowUp').hidden = !isFollowUp;
  $('#saViewFollowUp').classList.toggle('active', isFollowUp);
  $('#saViewResellers').hidden = !isResellers;
  $('#saViewResellers').classList.toggle('active', isResellers);
  $('#saViewIntegrations').hidden = isTenants || isClients || isDemoLeads || isFollowUp || isResellers;
  $('#saViewIntegrations').classList.toggle('active', !isTenants && !isClients && !isDemoLeads && !isFollowUp && !isResellers);
  $('#saTitle').innerHTML = title;
  $('#saSub').textContent = subtitle;
  document.querySelectorAll('[data-sa-view]').forEach((a) => a.classList.toggle('active', a.dataset.saView === view));
}

async function boot() {
  try {
    const me = await api('/api/superadmin/me');
    $('#saUserName').textContent = me.username || 'superadmin';
    startSuperAdminClock();
    initSalesStageControls();
    await Promise.all([loadTenants(), loadClients(), loadDemoLeads(), loadFollowUp(), loadResellers(), loadIntegrations(), loadDeployStatus(), loadGitDeployStatus()]);
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

$('#saTenantSearch')?.addEventListener('input', () => { SA_TENANT_PAGE = 1; renderTenantTable(); });
$('#saTenantModuleFilter')?.addEventListener('change', () => { SA_TENANT_PAGE = 1; renderTenantTable(); });
$('#saTenantStageFilter')?.addEventListener('change', () => { SA_TENANT_PAGE = 1; renderTenantTable(); });
$('#saTenantCountryFilter')?.addEventListener('change', () => { SA_TENANT_PAGE = 1; renderTenantTable(); });
$('#saTenantResellerFilter')?.addEventListener('change', () => { SA_TENANT_PAGE = 1; renderTenantTable(); });
$('#saReloadTenants')?.addEventListener('click', () => { SA_TENANT_PAGE = 1; loadTenants().catch((e) => toast(e.message, true)); });
$('#saClientSearch')?.addEventListener('input', renderClientsTable);
$('#saReloadClients')?.addEventListener('click', () => loadClients().catch((e) => toast(e.message, true)));
$('#saDemoLeadSearch')?.addEventListener('input', () => { SA_DEMO_PAGE = 1; renderDemoLeadsTable(); });
$('#saDemoModuleFilter')?.addEventListener('change', () => { SA_DEMO_PAGE = 1; renderDemoLeadsTable(); });
$('#saDemoStageFilter')?.addEventListener('change', () => { SA_DEMO_PAGE = 1; renderDemoLeadsTable(); });
$('#saDemoCountryFilter')?.addEventListener('change', () => { SA_DEMO_PAGE = 1; renderDemoLeadsTable(); });
$('#saReloadDemoLeads')?.addEventListener('click', () => { SA_DEMO_PAGE = 1; loadDemoLeads().catch((e) => toast(e.message, true)); });
$('#saFollowUpSearch')?.addEventListener('input', renderFollowUpTable);
$('#saFollowUpStageFilter')?.addEventListener('change', renderFollowUpTable);
$('#saFollowUpTypeFilter')?.addEventListener('change', renderFollowUpTable);
$('#saReloadFollowUp')?.addEventListener('click', () => loadFollowUp().catch((e) => toast(e.message, true)));
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
$('#saPayPlan')?.addEventListener('change', (event) => {
  if (event.target.value === 'invoicing_sat') $('#saPayAmount').value = '1499';
});
$('#saPayCancel')?.addEventListener('click', closePaymentModal);
$('#saPaymentModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saPaymentModal') closePaymentModal();
});
$('#saPaymentForm')?.addEventListener('submit', (e) => submitPaymentForm(e).catch((err) => toast(err.message, true)));
$('#saStampClose')?.addEventListener('click', closeStampModal);
$('#saStampCancel')?.addEventListener('click', closeStampModal);
$('#saStampModal')?.addEventListener('click', (e) => { if (e.target?.id === 'saStampModal') closeStampModal(); });
$('#saStampActivationBtn')?.addEventListener('click', () => toggleTenantInvoicing().catch((err) => toast(err.message, true)));
$('#saStampEnvironmentBtn')?.addEventListener('click', () => saveTenantInvoicingEnvironment().catch((err) => toast(err.message, true)));
$('#saStampForm')?.addEventListener('submit', (e) => submitStampRecharge(e).catch((err) => toast(err.message, true)));
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

$('#saFollowUpCancel')?.addEventListener('click', closeFollowUpModal);
$('#saFollowUpModal')?.addEventListener('click', (e) => {
  if (e.target?.id === 'saFollowUpModal') closeFollowUpModal();
});
$('#saFollowUpForm')?.addEventListener('submit', (e) => submitFollowUp(e).catch((err) => toast(err.message, true)));
$('#saFollowUpActivityType')?.addEventListener('change', (e) => {
  const type = e.target.value;
  const stage = $('#saFollowUpStage');
  if (type === 'close_won') stage.value = 'won';
  if (type === 'close_lost') stage.value = 'lost';
  if (type === 'follow_up') stage.value = 'follow_up';
  if (type === 'contact' && stage.value === 'new') stage.value = 'contacted';
});

$('#saNewReseller')?.addEventListener('click', () => openResellerModal());
$('#saResellerCancel')?.addEventListener('click', closeResellerModal);
$('#saResellerModal')?.addEventListener('click', (event) => { if (event.target?.id === 'saResellerModal') closeResellerModal(); });
$('#saResellerForm')?.addEventListener('submit', (event) => saveReseller(event).catch((error) => toast(error.message, true)));

const SA_INITIAL_VIEW = ['tenants', 'clients', 'demo-leads', 'follow-up', 'resellers', 'integrations'].includes((location.hash || '#tenants').slice(1))
  ? (location.hash || '#tenants').slice(1)
  : 'tenants';
setView(SA_INITIAL_VIEW);
boot();
