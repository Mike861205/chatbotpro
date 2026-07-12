/* ===== ChatBotPro — lógica del panel v2 ===== */
let ME = null;
let SETTINGS = null;
let salesChart = null;
let topChart = null;
let DASHBOARD_PERIOD = 'day';
let orderStatusFilter = '';
let orderPage = 1;
const ORDER_PAGE_SIZE = 10;
let orderTodayOnly = true;
let orderDateStart = '';
let orderDateEnd = '';
let customersDateStart = '';
let customersDateEnd = '';
let customersSort = 'orders_desc';
let customersPage = 1;
const CUSTOMERS_PAGE_SIZE = 10;
let BRANCHES = [];
let CASHIERS = [];
let LAST_ORDERS = [];
let POS_OVERVIEW = null;
let POS_CART = [];
let POS_CATEGORY_FILTER = 'all';
let POS_PRODUCT_SORT = 'top_sold';
let POS_PAYMENT_METHOD = 'cash';
const DASHBOARD_PERIOD_LABELS = {
  day: 'de hoy',
  week: 'de la semana',
  month: 'del mes',
  year: 'del año',
};
let POS_PAYMENT_FORM = { cashReceived: '', cash: '', card: '', transfer: '', notes: '' };
let LAST_POS_SALE = null;
let POS_SALES_PAGE = 1;
const POS_SALES_PAGE_SIZE = 10;
let POS_SALES_TOTAL_PAGES = 1;
let POS_SALES_HISTORY_CACHE = [];
let POS_SALES_FILTER = 'today';
let POS_SALES_START_DATE = '';
let POS_SALES_END_DATE = '';
let POS_PAYMENT_EDIT_METHOD = 'cash';
let POS_IS_DELIVERY = false;
let POS_DELIVERY_FEE = '';
let POS_CHATBOT_QUEUE = [];
let POS_CHATBOT_PAGE = 1;
let POS_CHATBOT_TOTAL_PAGES = 1;
const POS_CHATBOT_IMPORTING = new Set();
let CHATBOT_SUBTAB = 'flow';
let CHATBOT_UPSELL_PRODUCTS = [];
let CHATBOT_UPSELL_SELECTED = new Set();
let CHATBOT_UPSELL_OFFERS = [];
let CHATBOT_INFO_OPTIONS = [];
let DELIVERY_ZONES = [];
let DELIVERY_ZONE_MAP = null;
let DELIVERY_ZONE_LAYER = null;
let DELIVERY_DRAW_ACTIVE = false;
let DELIVERY_DRAW_POINTS = [];
let DELIVERY_DRAW_MARKERS = [];
let DELIVERY_DRAW_PREVIEW = null;
let DELIVERY_DRAW_HELP_SHOWN = false;
let DELIVERY_ZONES_PAGE = 1;
const DELIVERY_ZONES_PAGE_SIZE = 5;
let DELIVERY_ZONE_FILTER_BRANCH = 'all';
const AUTH_SCOPE_KEY = 'cbp_auth_scope';
const ORDER_ALERT_SOUND_KEY = 'cbp_order_alert_sound_enabled';
const ORDER_ALERT_POLL_MS = 10000;
const ORDER_ALERT_MAX_MS = 5000;
let ORDER_ALERT_TIMER = null;
let ORDER_ALERT_DAY_KEY = '';
let ORDER_ALERT_SEEN_PENDING_IDS = new Set();
let ORDER_ALERT_SOUND_ENABLED = true;
let ORDER_ALERT_BOOTSTRAPPED = false;
let ORDER_ALERT_AUDIO_CTX = null;

const $ = (s) => document.querySelector(s);
const fmtMoney = (n, c) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: c || (SETTINGS && SETTINGS.currency) || 'MXN' }).format(n || 0);

function getAuthScope() {
  try {
    const val = String(sessionStorage.getItem(AUTH_SCOPE_KEY) || '').trim().toLowerCase();
    return val === 'owner' || val === 'cashier' ? val : '';
  } catch {
    return '';
  }
}

function setAuthScope(scope) {
  const val = String(scope || '').trim().toLowerCase();
  try {
    if (val === 'owner' || val === 'cashier') {
      sessionStorage.setItem(AUTH_SCOPE_KEY, val);
    } else {
      sessionStorage.removeItem(AUTH_SCOPE_KEY);
    }
  } catch {}
}

function isCashierUser() {
  return ME?.role === 'cashier';
}

function normalizePosSortMode(mode) {
  const value = String(mode || '').trim();
  return value === 'alphabetical' || value === 'top_sold' ? value : 'top_sold';
}

function posSortStorageKey() {
  return `chatbotpro:pos:sort:${ME?.tenant?.slug || 'default'}`;
}

function readStoredPosSortMode() {
  try {
    return normalizePosSortMode(localStorage.getItem(posSortStorageKey()));
  } catch {
    return 'top_sold';
  }
}

function saveStoredPosSortMode(mode) {
  try {
    localStorage.setItem(posSortStorageKey(), normalizePosSortMode(mode));
  } catch {}
}

function syncPosSortControlVisibility() {
  const wrap = $('#posSortWrap');
  const select = $('#posSortSelect');
  if (!wrap || !select) return;
  const show = CURRENT_VIEW === 'pos' || CURRENT_VIEW === 'productos';
  wrap.hidden = !show;
  wrap.style.display = show ? 'inline-flex' : 'none';
  select.value = normalizePosSortMode(POS_PRODUCT_SORT);
}

async function persistTenantPosSortMode(mode) {
  if (!ME || ME.role !== 'owner') return;
  try {
    await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pos_catalog_sort_mode: normalizePosSortMode(mode) }),
    });
    if (SETTINGS) SETTINGS.pos_catalog_sort_mode = normalizePosSortMode(mode);
  } catch {}
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  $('#toastMsg').textContent = msg;
  t.querySelector('i').className = isErr ? 'ph-fill ph-x-circle' : 'ph-fill ph-check-circle';
  t.className = isErr ? 'show err' : 'show ok';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.className = ''), 3200);
}

function orderDayKeyLocal() {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function normalizeOrderStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function isPendingOrder(order) {
  return normalizeOrderStatus(order?.status) === 'pendiente';
}

function ensureOrderAlertDayState() {
  const dayKey = orderDayKeyLocal();
  if (ORDER_ALERT_DAY_KEY === dayKey) return;
  ORDER_ALERT_DAY_KEY = dayKey;
  ORDER_ALERT_SEEN_PENDING_IDS = new Set();
  ORDER_ALERT_BOOTSTRAPPED = false;
}

async function fetchTodayPendingOrders() {
  const params = new URLSearchParams({ todayOnly: '1', status: 'pendiente' });
  const rows = await api(`/api/orders?${params.toString()}`);
  return Array.isArray(rows) ? rows.filter(isPendingOrder) : [];
}

function setPendingTodayCount(count) {
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
  const badge = $('#pendingBadge');
  if (badge) {
    badge.style.display = safeCount ? 'inline-flex' : 'none';
    badge.textContent = String(safeCount);
  }
  const info = $('#ordersPendingTodayInfo');
  if (info) {
    info.innerHTML = `<i class="ph-fill ph-bell-ringing"></i> Nuevos pendientes hoy: ${safeCount}`;
  }
}

function loadOrderSoundPreference() {
  try {
    const raw = localStorage.getItem(ORDER_ALERT_SOUND_KEY);
    ORDER_ALERT_SOUND_ENABLED = raw !== '0';
  } catch {
    ORDER_ALERT_SOUND_ENABLED = true;
  }
}

function persistOrderSoundPreference() {
  try {
    localStorage.setItem(ORDER_ALERT_SOUND_KEY, ORDER_ALERT_SOUND_ENABLED ? '1' : '0');
  } catch {}
}

function syncOrdersSoundToggleUI() {
  const btn = $('#ordersSoundToggle');
  if (!btn) return;
  btn.classList.toggle('on', ORDER_ALERT_SOUND_ENABLED);
  btn.classList.toggle('off', !ORDER_ALERT_SOUND_ENABLED);
  btn.setAttribute('aria-pressed', String(ORDER_ALERT_SOUND_ENABLED));
  btn.innerHTML = ORDER_ALERT_SOUND_ENABLED
    ? '<i class="ph-fill ph-speaker-high"></i> Sonido pedidos: Activado'
    : '<i class="ph-fill ph-speaker-slash"></i> Sonido pedidos: Silenciado';
}

function playIncomingOrderSound(maxMs = ORDER_ALERT_MAX_MS) {
  if (!ORDER_ALERT_SOUND_ENABLED) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!ORDER_ALERT_AUDIO_CTX) ORDER_ALERT_AUDIO_CTX = new AudioCtx();
  const ctx = ORDER_ALERT_AUDIO_CTX;
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  const totalDuration = Math.min(ORDER_ALERT_MAX_MS, Math.max(1200, Number(maxMs) || ORDER_ALERT_MAX_MS)) / 1000;
  const motif = [
    [740, 0.16],
    [988, 0.17],
    [1245, 0.22],
    [988, 0.17],
  ];
  const baseStart = ctx.currentTime + 0.02;
  let timeline = 0;
  while (timeline < totalDuration) {
    for (const [freq, len] of motif) {
      if (timeline + len > totalDuration) break;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, baseStart + timeline);
      gain.gain.setValueAtTime(0.0001, baseStart + timeline);
      gain.gain.exponentialRampToValueAtTime(0.18, baseStart + timeline + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, baseStart + timeline + len);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(baseStart + timeline);
      osc.stop(baseStart + timeline + len + 0.02);
      timeline += len + 0.045;
    }
    timeline += 0.14;
  }
}

async function refreshPendingOrdersMonitor({ allowSound = true } = {}) {
  ensureOrderAlertDayState();
  try {
    const pendingOrders = await fetchTodayPendingOrders();
    const currentIds = new Set(pendingOrders.map((order) => String(order.id)));
    setPendingTodayCount(currentIds.size);

    const newIds = [];
    currentIds.forEach((id) => {
      if (!ORDER_ALERT_SEEN_PENDING_IDS.has(id)) newIds.push(id);
    });

    if (ORDER_ALERT_BOOTSTRAPPED && allowSound && newIds.length) {
      playIncomingOrderSound(4200);
      if (CURRENT_VIEW === 'pedidos') {
        toast(`Llegó ${newIds.length} pedido${newIds.length > 1 ? 's' : ''} nuevo${newIds.length > 1 ? 's' : ''}`);
      }
    }

    ORDER_ALERT_SEEN_PENDING_IDS = currentIds;
    ORDER_ALERT_BOOTSTRAPPED = true;
  } catch {}
}

function startOrdersRealtimeMonitor() {
  if (ORDER_ALERT_TIMER) clearInterval(ORDER_ALERT_TIMER);
  refreshPendingOrdersMonitor({ allowSound: false });
  ORDER_ALERT_TIMER = setInterval(() => {
    refreshPendingOrdersMonitor({ allowSound: true });
  }, ORDER_ALERT_POLL_MS);
}

function showSuspensionModal(message, whatsappUrl) {
  const modal = $('#suspensionModal');
  if (!modal) return;
  const msgEl = $('#suspensionMsg');
  const waBtn = $('#suspensionWhatsapp');
  if (msgEl && message) msgEl.textContent = message;
  if (waBtn && whatsappUrl) waBtn.href = whatsappUrl;
  modal.classList.add('show');
}

async function api(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  const scope = getAuthScope();
  if (scope) headers.set('x-cbp-auth-scope', scope);
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data?.errorCode === 'BILLING_SUSPENDED') {
    showSuspensionModal(data.error, data.whatsappUrl);
    throw new Error(data.error || 'Servicio suspendido por falta de pago');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Error de servidor');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ===== Confirmación elegante (reemplaza confirm()) ===== */
function askConfirm(title, msg, options = {}) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    const yesLabel = String(options?.yesLabel || '<i class="ph-bold ph-trash"></i> Sí, eliminar');
    const noLabel = String(options?.noLabel || 'Cancelar');
    $('#confirmYes').innerHTML = yesLabel;
    $('#confirmNo').textContent = noLabel;
    const modal = $('#confirmModal');
    modal.classList.add('show');
    const done = (val) => {
      modal.classList.remove('show');
      $('#confirmYes').onclick = $('#confirmNo').onclick = null;
      resolve(val);
    };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

function askCancelReason(orderId, initialValue = '') {
  return new Promise((resolve) => {
    const modal = $('#orderCancelReasonModal');
    const input = $('#orderCancelReasonInput');
    const error = $('#orderCancelReasonError');
    const btnCancel = $('#orderCancelReasonCancel');
    const btnSave = $('#orderCancelReasonSave');
    const orderEl = $('#orderCancelReasonOrder');

    if (orderEl) orderEl.textContent = `#${orderId}`;
    if (input) input.value = initialValue || '';
    if (error) error.textContent = '';
    modal.classList.add('show');
    setTimeout(() => input?.focus(), 60);

    const done = (value) => {
      modal.classList.remove('show');
      modal.onclick = null;
      btnCancel.onclick = null;
      btnSave.onclick = null;
      input.oninput = null;
      resolve(value);
    };

    modal.onclick = (e) => {
      if (e.target === modal) done(null);
    };

    input.oninput = () => {
      if (error && String(input.value || '').trim().length >= 3) error.textContent = '';
    };

    btnCancel.onclick = () => done(null);
    btnSave.onclick = () => {
      const note = String(input.value || '').trim();
      if (note.length < 3) {
        if (error) error.textContent = 'Escribe un motivo de al menos 3 caracteres.';
        input.focus();
        return;
      }
      done(note.slice(0, 280));
    };
  });
}

/* ===== Navegación ===== */
const VIEW_META = {
  dashboard: ['Dashboard', 'Resumen de tu negocio', 'ph-chart-pie-slice'],
  pedidos: ['Pedidos', 'Administra y actualiza tus pedidos', 'ph-receipt'],
  clientes: ['Clientes', 'Fidelidad y valor de clientes del chatbot', 'ph-users-three'],
  pos: ['Punto de venta', 'Caja, cobro y cierre del día', 'ph-cash-register'],
  productos: ['Productos', 'Tu menú visible en el chatbot', 'ph-hamburger'],
  inventarios: ['Inventarios', 'Control de stock, entradas, mermas y conteo físico', 'ph-package'],
  chatbot: ['Mi chatbot', 'Configura el flujo y comparte tu liga', 'ph-chat-circle-dots'],
  config: ['Mi negocio', 'Identidad, branding y contacto', 'ph-storefront'],
  suscripciones: ['Suscripciones', 'Planes, beneficios y pago seguro', 'ph-crown'],
};

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  pedidos: loadOrders,
  clientes: loadCustomers,
  pos: loadPos,
  productos: loadProducts,
  inventarios: loadInventarios,
  chatbot: fillBotForm,
  config: fillConfigForm,
  suscripciones: () => {},
};

let CURRENT_VIEW = 'dashboard';

function normalizeView(view) {
  if (isCashierUser()) return 'pos';
  return VIEW_META[view] ? view : 'dashboard';
}

function resetMainScroll() {
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
}

function applyUserScopeUI() {
  const cashierMode = isCashierUser();
  document.body.classList.toggle('cashier-mode', cashierMode);
  document.querySelectorAll('.sidebar nav a').forEach((a) => {
    const allowed = !cashierMode || a.dataset.view === 'pos';
    a.hidden = !allowed;
  });
  const chatLink = $('#openChatLink');
  if (chatLink) chatLink.hidden = cashierMode;
  const banner = $('#cashierBranchBanner');
  if (banner) banner.style.display = cashierMode ? 'inline-flex' : 'none';
  const bannerLabel = $('#cashierBranchLabel');
  if (bannerLabel && cashierMode) bannerLabel.textContent = ME?.branchName ? `Sucursal: ${ME.branchName}` : 'Punto de venta';
  if (cashierMode) {
    $('#viewTitle').innerHTML = '<i class="ph-bold ph-cash-register"></i> Punto de venta';
    $('#viewSub').textContent = ME?.branchName ? `Sucursal ${ME.branchName}` : 'Caja operativa';
    $('#brandName').textContent = ME?.branchName || ME?.tenant?.businessName || 'Caja';
  }
  syncPosSortControlVisibility();
}

async function navigate(view) {
  const nextView = normalizeView(view);
  CURRENT_VIEW = nextView;
  document.body.setAttribute('data-current-view', nextView);

  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === nextView));
  document.querySelectorAll('.section').forEach((s) => {
    const isActive = s.id === `view-${nextView}`;
    s.classList.toggle('active', isActive);
    s.hidden = !isActive;
    s.setAttribute('aria-hidden', String(!isActive));
    if ('inert' in s) s.inert = !isActive;
  });

  if (location.hash !== `#${nextView}`) {
    history.replaceState(null, '', `#${nextView}`);
  }

  const [title, sub, icon] = VIEW_META[nextView];
  $('#viewTitle').innerHTML = `<i class="ph-bold ${icon}"></i> ${title}`;
  $('#viewSub').textContent = sub;
  resetMainScroll();
  closeSidebar();
  syncPosSortControlVisibility();

  const loader = VIEW_LOADERS[nextView];
  if (!loader) return;
  try {
    await loader();
  } catch (err) {
    toast(err.message || 'No se pudo cargar el módulo', true);
  }
}
globalThis.navigate = navigate;

document.querySelectorAll('.sidebar nav a').forEach((a) =>
  a.addEventListener('click', (e) => {
    if (!a.dataset.view) return; // enlaces externos (ej. /notificaciones) — dejar pasar
    e.preventDefault();
    navigate(a.dataset.view);
  })
);

globalThis.addEventListener('hashchange', () => {
  if (isCashierUser()) {
    history.replaceState(null, '', '#pos');
    return;
  }
  const view = normalizeView((location.hash || '#dashboard').slice(1));
  if (view !== CURRENT_VIEW) navigate(view);
});
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('show');
}
$('#menuToggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
  $('#scrim').classList.toggle('show');
});
$('#scrim').addEventListener('click', closeSidebar);
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  setAuthScope('');
  location.href = '/login';
});

$('#posSortSelect')?.addEventListener('change', async (e) => {
  POS_PRODUCT_SORT = normalizePosSortMode(e.target.value);
  saveStoredPosSortMode(POS_PRODUCT_SORT);
  if (CURRENT_VIEW === 'pos') renderPosCatalog();
  if (CURRENT_VIEW === 'productos') renderProductsGrid();
  await persistTenantPosSortMode(POS_PRODUCT_SORT);
});

/* ===== Dashboard ===== */
async function loadDashboard() {
  const s = await api(`/api/dashboard/stats?period=${encodeURIComponent(DASHBOARD_PERIOD)}`);
  const periodMeta = s.period || {};
  const periodKey = periodMeta.key || DASHBOARD_PERIOD;
  const periodSuffix = DASHBOARD_PERIOD_LABELS[periodKey] || 'de hoy';
  $('#stSalesToday').textContent = fmtMoney(s.today.sales);
  $('#stOrdersToday').textContent = s.today.count;
  $('#stPending').textContent = s.pending;
  $('#stAvgTicket').textContent = fmtMoney(s.avgTicket);
  $('#stSalesLabel').textContent = periodMeta.salesLabel || `Ventas ${periodSuffix}`;
  $('#stOrdersLabel').textContent = periodMeta.ordersLabel || `Pedidos ${periodSuffix}`;
  $('#stPendingLabel').textContent = `Pendientes ${periodSuffix}`;
  $('#dashboardSalesTitle').innerHTML = `<i class="ph-bold ph-trend-up"></i> ${periodMeta.chartTitle || 'Ventas'}`;
  $('#dashboardTopTitle').innerHTML = `<i class="ph-bold ph-trophy"></i> ${periodMeta.topTitle || 'Más vendidos'}`;
  document.querySelectorAll('#dashboardPeriodFilter button').forEach((button) => {
    button.classList.toggle('on', button.dataset.period === periodKey);
  });
  refreshPendingOrdersMonitor({ allowSound: false });

  const primary = ME.tenant.primaryColor || '#ff6b35';

  if (salesChart) salesChart.destroy();
  const ctx = $('#salesChart').getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 240);
  grad.addColorStop(0, primary + '55');
  grad.addColorStop(1, primary + '06');
  salesChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: s.last7.map((d) => d.day),
      datasets: [{
        label: periodMeta.salesLabel || 'Ventas',
        data: s.last7.map((d) => d.sales),
        borderColor: primary,
        backgroundColor: grad,
        fill: true,
        tension: 0.42,
        borderWidth: 3,
        pointRadius: 4,
        pointBackgroundColor: '#fff',
        pointBorderColor: primary,
        pointBorderWidth: 2.5,
      }],
    },
    options: {
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + fmtMoney(c.parsed.y) } } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#eef0f6' }, ticks: { font: { family: 'Plus Jakarta Sans' } } },
        x: { grid: { display: false }, ticks: { font: { family: 'Plus Jakarta Sans', weight: 600 } } },
      },
    },
  });

  if (topChart) topChart.destroy();
  topChart = new Chart($('#topChart'), {
    type: 'doughnut',
    data: {
      labels: s.topProducts.length ? s.topProducts.map((p) => p.name) : ['Sin ventas aún'],
      datasets: [{
        data: s.topProducts.length ? s.topProducts.map((p) => p.qty) : [1],
        backgroundColor: s.topProducts.length ? [primary, '#2563eb', '#16a34a', '#d97706', '#7c3aed'] : ['#e8ebf3'],
        borderWidth: 3,
        borderColor: '#fff',
        hoverOffset: 8,
      }],
    },
    options: {
      cutout: '68%',
      plugins: { legend: { position: 'bottom', labels: { font: { family: 'Plus Jakarta Sans', weight: 600 }, usePointStyle: true, pointStyle: 'circle', padding: 14 } } },
    },
  });

  const recent = await api('/api/orders?limit=5');
  $('#recentOrders').innerHTML = recent.length
    ? ordersTableHTML(recent, false)
    : emptyHTML('ph-receipt', 'Aún no hay pedidos', 'Comparte tu liga del chatbot para empezar a vender.');
}

function emptyHTML(icon, title, msg) {
  return `<div class="empty"><i class="ph ${icon}"></i><b>${title}</b><p>${msg}</p></div>`;
}

/* ===== Pedidos ===== */
const STATUSES = ['pendiente', 'confirmado', 'preparando', 'enviado', 'entregado', 'cancelado'];

function custAvatar(name) {
  const initials = (name || 'C').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const hues = [14, 205, 262, 152, 330, 38];
  const hue = hues[(name || '').length % hues.length];
  return `<div class="cav" style="background:linear-gradient(135deg,hsl(${hue} 70% 48%),hsl(${hue} 75% 62%))">${esc(initials)}</div>`;
}

function orderPaymentLabel(method) {
  return {
    cash: 'Efectivo',
    transfer: 'Transferencia',
    card: 'Tarjeta',
  }[String(method || '')] || '—';
}

function buildOrderDeliveryLabel(order) {
  if (order?.delivery === 'domicilio') return 'Domicilio';
  const pickup = String(order?.pickup_branch_name || '').trim();
  return pickup ? `Recoger · ${pickup}` : 'Recoger';
}

function buildOrderComandaItems(order) {
  const rows = Array.isArray(order?.items) ? order.items : [];
  return rows.map((item) => ({
    qty: Number(item?.qty || 0),
    name: String(item?.name || 'Producto'),
  }));
}

function openOrderComandaPrintWindow(order) {
  if (!order) return toast('No se encontró el pedido para imprimir', true);
  const items = buildOrderComandaItems(order);
  if (!items.length) return toast('El pedido no tiene productos para comanda', true);

  const biz = esc(SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio');
  const bizAddress = esc(SETTINGS?.address || '');
  const bizWhatsapp = esc((SETTINGS?.whatsapp || '').trim());
  const widthMm = Math.max(58, Math.min(80, Number(SETTINGS?.ticket_width_mm || 80)));
  const fontPx = Math.max(10, Math.min(24, Number(SETTINGS?.ticket_font_size_px || 14)));
  const lineHeight = Math.max(1.1, Math.min(2, Number(SETTINGS?.ticket_line_height || 1.45)));
  const showLogo = SETTINGS?.ticket_show_logo !== '0';
  const printMode = SETTINGS?.ticket_print_mode === 'bluetooth' ? 'bluetooth' : 'thermal';
  const mobileZoomPercent = Math.max(80, Math.min(120, Number(SETTINGS?.ticket_mobile_zoom_percent || 100)));
  const mobileZoom = mobileZoomPercent / 100;
  const printZoom = printMode === 'bluetooth' ? mobileZoom : 1;
  const pageCss = printMode === 'bluetooth'
    ? '@page { size: auto; margin: 6mm; }'
    : `@page { size: ${widthMm}mm auto; margin: 3mm; }`;
  const printWindowSize = printMode === 'bluetooth' ? 'width=430,height=760' : 'width=420,height=760';
  const logo = ME?.tenant?.logo
    ? `${location.origin}${ME.tenant.logo.startsWith('/') ? ME.tenant.logo : `/${ME.tenant.logo}`}`
    : '';

  const itemRows = items.map((it) => {
    const qty = Number.isFinite(it.qty) ? it.qty : 0;
    return `<tr>
      <td class="qty">${esc(String(qty))}</td>
      <td>${esc(it.name)}</td>
    </tr>`;
  }).join('');

  const customerName = esc(order?.customer?.name || 'Mostrador');
  const customerPhone = esc(order?.customer?.phone || '');
  const delivery = esc(buildOrderDeliveryLabel(order));
  const branch = esc(order?.delivery === 'domicilio' ? (order?.service_branch_name || '—') : (order?.pickup_branch_name || '—'));
  const createdAt = esc(order?.created_at || new Date().toLocaleString('es-MX'));
  const notes = esc(String(order?.notes || '').trim());

  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Comanda #${esc(String(order.id || ''))}</title>
  <style>
    ${pageCss}
    html, body { margin: 0; padding: 0; }
    body { width: 100%; max-width: ${Math.max(50, widthMm - 6)}mm; margin: 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${fontPx}px; line-height: ${lineHeight}; color: #000; }
    .ticket-wrap { width: 100%; margin: 0 auto; zoom: ${printZoom}; }
    @supports not (zoom: 1) {
      .ticket-wrap { transform: scale(${printZoom}); transform-origin: top center; width: ${printZoom === 1 ? 100 : (100 / printZoom).toFixed(4)}%; }
    }
    .center { text-align: center; }
    .meta { font-size: ${Math.max(fontPx - 1, 10)}px; }
    .sep { border-top: 1px dashed #000; margin: 8px 0; }
    .logo { text-align: center; margin-bottom: 6px; }
    .logo img { max-width: 46mm; max-height: 22mm; object-fit: contain; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 2px; vertical-align: top; }
    td.qty { width: 22%; text-align: center; font-weight: 800; }
    .headline { font-size: ${Math.max(fontPx + 2, 14)}px; font-weight: 800; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div class="ticket-wrap">
    ${showLogo && logo ? `<div class="logo"><img src="${esc(logo)}" alt="Logo" /></div>` : ''}
    <div class="center"><b>${biz}</b></div>
    ${bizAddress ? `<div class="center meta">${bizAddress}</div>` : ''}
    ${bizWhatsapp ? `<div class="center meta">WhatsApp: ${bizWhatsapp}</div>` : ''}
    <div class="sep"></div>
    <div class="center headline">COMANDA #${esc(String(order.id || ''))}</div>
    <div class="center meta">${createdAt}</div>
    <div class="meta"><b>Cliente:</b> ${customerName}${customerPhone ? ` · ${customerPhone}` : ''}</div>
    <div class="meta"><b>Entrega:</b> ${delivery}</div>
    <div class="meta"><b>Sucursal:</b> ${branch}</div>
    ${notes ? `<div class="meta"><b>Nota:</b> ${notes}</div>` : ''}
    <div class="sep"></div>
    <table>
      <thead>
        <tr><td class="qty"><b>Cant.</b></td><td><b>Producto</b></td></tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div class="sep"></div>
    <div class="center meta">Impresión de cocina</div>
  </div>
  <script>
    window.onload = () => {
      window.print();
      setTimeout(() => window.close(), 120);
    };
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const w = window.open(blobUrl, '_blank', printWindowSize);
  if (!w) return toast('Permite ventanas emergentes para imprimir', true);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
}

function ordersTableHTML(orders, editable = true) {
  const actionHead = editable ? '<th>Comanda</th>' : '';
  const rows = orders
    .map((o) => {
      const items = o.items.map((it) => `${it.qty}× ${it.name}`).join(', ');
      const statusCell = editable
        ? `<select data-order="${o.id}" class="status-sel s-${o.status}">
            ${STATUSES.map((st) => `<option value="${st}" ${st === o.status ? 'selected' : ''}>${st[0].toUpperCase() + st.slice(1)}</option>`).join('')}
          </select>`
        : `<span class="badge b-${o.status}">${o.status}</span>`;
      const deliveryText =
        o.delivery === 'domicilio'
          ? '<i class="ph-bold ph-moped" style="color:var(--blue)"></i> Domicilio'
          : `<i class="ph-bold ph-storefront" style="color:var(--violet)"></i> Recoger${o.pickup_branch_name ? ` · ${esc(o.pickup_branch_name)}` : ''}`;
      const deliveryFeeText =
        o.delivery === 'domicilio' && Number(o.delivery_fee || 0) > 0
          ? `<div style="font-size:12px;color:var(--ink-3);margin-top:3px"><i class="ph-bold ph-coins"></i> Envío: ${fmtMoney(Number(o.delivery_fee || 0))}${o.delivery_zone_name ? ` · ${esc(o.delivery_zone_name)}` : ''}</div>`
          : '';
      const resolvedLocationText = o.customer_location_resolved
        ? `<div style="font-size:12px;color:var(--ink-3);margin-top:3px"><i class="ph-bold ph-map-trifold"></i> ${esc(o.customer_location_resolved)}</div>`
        : '';
      const mapLink = Number.isFinite(Number(o.customer_location_lat)) && Number.isFinite(Number(o.customer_location_lng))
        ? `<a href="https://www.google.com/maps?q=${Number(o.customer_location_lat)},${Number(o.customer_location_lng)}" target="_blank" rel="noopener noreferrer" style="font-size:12px;color:var(--primary);margin-top:3px;display:inline-flex;gap:6px;align-items:center;text-decoration:none"><i class="ph-bold ph-map-pin"></i> Abrir ubicación</a>`
        : '';
      const locationText = o.customer_location_text
        ? `<div style="font-size:12px;color:var(--ink-3);margin-top:3px"><i class="ph-bold ph-map-pin"></i> ${esc(o.customer_location_text)}</div>${resolvedLocationText}${mapLink}`
        : `${resolvedLocationText}${mapLink}`;
      const cancelNoteText =
        o.status === 'cancelado' && o.cancel_note
          ? `<div style="font-size:12px;color:#b42318;margin-top:4px"><i class="ph-bold ph-note-pencil"></i> Motivo: ${esc(o.cancel_note)}</div>`
          : '';
      const paymentText = `<span class="badge b-confirmado"><span style="display:none"></span>${esc(orderPaymentLabel(o.payment_method))}</span>`;
      const comandaBtn = editable
        ? `<button type="button" class="btn btn-ghost btn-sm order-print-comanda" data-order-print="${o.id}" title="Imprimir comanda"><i class="ph-bold ph-printer"></i> Comanda</button>`
        : '';
      return `<tr>
        <td><b>#${o.id}</b></td>
        <td><div class="cust">${custAvatar(o.customer?.name)}<div class="cmeta"><b>${esc(o.customer?.name || '—')}</b><span>${esc(o.customer?.phone || '')}</span></div></div></td>
        <td style="max-width:280px">${esc(items)}</td>
        <td style="white-space:nowrap">${deliveryText}${deliveryFeeText}${locationText}${cancelNoteText}</td>
        <td style="white-space:nowrap;font-size:13px"><b>${esc(o.delivery === 'domicilio' ? (o.service_branch_name || '—') : (o.pickup_branch_name || '—'))}</b></td>
        <td><b>${fmtMoney(o.total)}</b></td>
        <td>${paymentText}</td>
        <td>${statusCell}</td>
        <td style="white-space:nowrap;color:var(--ink-3);font-size:12.5px">${esc(o.created_at)}</td>
        ${editable ? `<td style="white-space:nowrap">${comandaBtn}</td>` : ''}
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Entrega</th><th>Sucursal</th><th>Total</th><th>Pago</th><th>Estatus</th><th>Fecha</th>${actionHead}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderOrdersPagination(totalItems) {
  const holder = $('#ordersPagination');
  if (!holder) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / ORDER_PAGE_SIZE));
  if (orderPage > totalPages) orderPage = totalPages;

  holder.innerHTML = `
    <div class="orders-pagination-inner">
      <span class="orders-page-info">Página ${orderPage} de ${totalPages} · ${totalItems} pedidos</span>
      <div class="orders-page-actions">
        <button class="btn btn-ghost" id="ordersPrevPage" ${orderPage <= 1 ? 'disabled' : ''}><i class="ph-bold ph-caret-left"></i> Anterior</button>
        <button class="btn btn-ghost" id="ordersNextPage" ${orderPage >= totalPages ? 'disabled' : ''}>Siguiente <i class="ph-bold ph-caret-right"></i></button>
      </div>
    </div>
  `;

  $('#ordersPrevPage')?.addEventListener('click', () => {
    if (orderPage <= 1) return;
    orderPage -= 1;
    loadOrders();
  });
  $('#ordersNextPage')?.addEventListener('click', () => {
    if (orderPage >= totalPages) return;
    orderPage += 1;
    loadOrders();
  });
}

function syncOrdersFiltersUI() {
  const toggle = $('#ordersTodayToggle');
  if (toggle) {
    toggle.classList.toggle('on', orderTodayOnly);
    toggle.setAttribute('aria-pressed', String(orderTodayOnly));
    toggle.innerHTML = `<i class="ph-bold ph-calendar-check"></i> Solo pedidos del día: ${orderTodayOnly ? 'Activado' : 'Desactivado'}`;
  }
  const start = $('#ordersDateStart');
  const end = $('#ordersDateEnd');
  if (start) {
    start.value = orderDateStart;
    start.disabled = orderTodayOnly;
  }
  if (end) {
    end.value = orderDateEnd;
    end.disabled = orderTodayOnly;
  }
  $('#ordersApplyDate')?.toggleAttribute('disabled', orderTodayOnly);
}

async function loadOrders() {
  syncOrdersFiltersUI();
  const params = new URLSearchParams();
  if (orderStatusFilter) params.set('status', orderStatusFilter);
  if (orderTodayOnly) params.set('todayOnly', '1');
  if (!orderTodayOnly && orderDateStart) params.set('startDate', orderDateStart);
  if (!orderTodayOnly && orderDateEnd) params.set('endDate', orderDateEnd);

  const orders = await api(`/api/orders${params.toString() ? `?${params.toString()}` : ''}`);
  LAST_ORDERS = orders;

  const totalPages = Math.max(1, Math.ceil(orders.length / ORDER_PAGE_SIZE));
  if (orderPage > totalPages) orderPage = totalPages;
  const startIdx = (orderPage - 1) * ORDER_PAGE_SIZE;
  const pageOrders = orders.slice(startIdx, startIdx + ORDER_PAGE_SIZE);

  $('#ordersTable').innerHTML = orders.length
    ? ordersTableHTML(pageOrders, true)
    : emptyHTML('ph-funnel', 'Sin resultados', 'No hay pedidos con este filtro.');
  renderOrdersPagination(orders.length);

  document.querySelectorAll('.status-sel').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const current = LAST_ORDERS.find((o) => String(o.id) === String(sel.dataset.order));
      const previousStatus = current?.status || 'pendiente';
      let cancelNote = null;
      try {
        if (sel.value === 'cancelado') {
          const note = await askCancelReason(sel.dataset.order, current?.cancel_note || '');
          if (note === null) {
            sel.value = previousStatus;
            sel.className = `status-sel s-${previousStatus}`;
            return;
          }
          const clean = String(note || '').trim();
          if (clean.length < 3) {
            toast('Debes escribir un motivo de cancelación', true);
            sel.value = previousStatus;
            sel.className = `status-sel s-${previousStatus}`;
            return;
          }
          cancelNote = clean;
        }
        await api(`/api/orders/${sel.dataset.order}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: sel.value, cancel_note: cancelNote }),
        });
        sel.className = `status-sel s-${sel.value}`;
        toast(`Pedido #${sel.dataset.order} → ${sel.value}`);
        await loadOrders();
        loadDashboardBadge();
      } catch (e) {
        sel.value = previousStatus;
        sel.className = `status-sel s-${previousStatus}`;
        toast(e.message, true);
      }
    })
  );

  document.querySelectorAll('.order-print-comanda').forEach((btn) =>
    btn.addEventListener('click', () => {
      const order = LAST_ORDERS.find((o) => String(o.id) === String(btn.dataset.orderPrint));
      if (!order) {
        toast('No se encontró el pedido para imprimir', true);
        return;
      }
      openOrderComandaPrintWindow(order);
    })
  );
}
window.loadOrders = loadOrders;

function customerLoyaltyBadge(ordersCount, totalSpent) {
  if (ordersCount >= 15 || totalSpent >= 8000) return '<span class="loyalty-pill top">Top</span>';
  if (ordersCount >= 8 || totalSpent >= 4000) return '<span class="loyalty-pill high">Alta</span>';
  if (ordersCount >= 4 || totalSpent >= 1500) return '<span class="loyalty-pill mid">Media</span>';
  return '<span class="loyalty-pill base">Nueva</span>';
}

function rankBadge(pos) {
  if (pos === 1) return `<span class="rank-badge rank-gold"   title="1° lugar">🥇</span>`;
  if (pos === 2) return `<span class="rank-badge rank-silver" title="2° lugar">🥈</span>`;
  if (pos === 3) return `<span class="rank-badge rank-bronze" title="3° lugar">🥉</span>`;
  if (pos <= 20) return `<span class="rank-badge rank-loyal"  title="Cliente fiel">🏅</span>`;
  return '';
}

function customersTableHTML(customers, rankOffset = 0) {
  const rows = customers
    .map((c, idx) => `
      <tr>
        <td><span class="rank-cell">${rankBadge(rankOffset + idx + 1)}<b class="rank-num">#${rankOffset + idx + 1}</b></span></td>
        <td>
          <div class="cust">
            ${custAvatar(c.name)}
            <div class="cmeta"><b>${esc(c.name || 'Cliente')}</b><span>${esc(c.phone || '—')}</span></div>
          </div>
        </td>
        <td style="white-space:nowrap">${esc(c.customer_since || '—')}</td>
        <td><b>${Number(c.orders_count || 0)}</b></td>
        <td><b>${fmtMoney(Number(c.total_spent || 0))}</b></td>
        <td style="white-space:nowrap;color:var(--ink-3)">${esc(c.last_order_at || '—')}</td>
        <td>${customerLoyaltyBadge(Number(c.orders_count || 0), Number(c.total_spent || 0))}</td>
      </tr>
    `)
    .join('');

  return `<table><thead><tr><th>Rank</th><th>Cliente</th><th>Registro</th><th># Pedidos</th><th>Monto acumulado</th><th>Último pedido</th><th>Fidelidad</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCustomersPagination(totalItems) {
  const holder = $('#customersPagination');
  if (!holder) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / CUSTOMERS_PAGE_SIZE));
  if (customersPage > totalPages) customersPage = totalPages;
  holder.innerHTML = `
    <div class="orders-pagination-inner">
      <span class="orders-page-info">Página ${customersPage} de ${totalPages} · ${totalItems} clientes</span>
      <div class="orders-page-actions">
        <button class="btn btn-ghost" id="customersPrevPage" ${customersPage <= 1 ? 'disabled' : ''}><i class="ph-bold ph-caret-left"></i> Anterior</button>
        <button class="btn btn-ghost" id="customersNextPage" ${customersPage >= totalPages ? 'disabled' : ''}>Siguiente <i class="ph-bold ph-caret-right"></i></button>
      </div>
    </div>
  `;

  $('#customersPrevPage')?.addEventListener('click', () => {
    if (customersPage <= 1) return;
    customersPage -= 1;
    loadCustomers();
  });
  $('#customersNextPage')?.addEventListener('click', () => {
    if (customersPage >= totalPages) return;
    customersPage += 1;
    loadCustomers();
  });
}

async function loadCustomers() {
  const startInput = $('#customersDateStart');
  const endInput = $('#customersDateEnd');
  const sortInput = $('#customersSort');
  if (startInput) startInput.value = customersDateStart;
  if (endInput) endInput.value = customersDateEnd;
  if (sortInput) sortInput.value = customersSort;

  const params = new URLSearchParams();
  if (customersDateStart) params.set('startDate', customersDateStart);
  if (customersDateEnd) params.set('endDate', customersDateEnd);
  if (customersSort) params.set('sort', customersSort);

  const customers = await api(`/api/customers${params.toString() ? `?${params.toString()}` : ''}`);
  const table = $('#customersTable');
  const pager = $('#customersPagination');
  const hasDateFilter = Boolean(customersDateStart || customersDateEnd);
  if (!hasDateFilter) customersPage = 1;
  const totalPages = Math.max(1, Math.ceil(customers.length / CUSTOMERS_PAGE_SIZE));
  if (customersPage > totalPages) customersPage = totalPages;
  const startIdx = hasDateFilter ? (customersPage - 1) * CUSTOMERS_PAGE_SIZE : 0;
  const pageCustomers = customers.slice(startIdx, startIdx + CUSTOMERS_PAGE_SIZE);
  if (!table) return;
  table.innerHTML = customers.length
    ? customersTableHTML(pageCustomers, startIdx)
    : emptyHTML('ph-users-three', 'Sin clientes aún', 'Cuando lleguen pedidos por chatbot aquí verás los clientes con mayor fidelidad.');
  if (pager) {
    pager.style.display = hasDateFilter && customers.length > CUSTOMERS_PAGE_SIZE ? 'block' : 'none';
    if (!hasDateFilter) pager.innerHTML = '';
  }
  if (hasDateFilter) renderCustomersPagination(customers.length);
}

$('#refreshCustomersBtn')?.addEventListener('click', loadCustomers);
$('#customersApplyFilters')?.addEventListener('click', () => {
  const start = String($('#customersDateStart')?.value || '');
  const end = String($('#customersDateEnd')?.value || '');
  const sort = String($('#customersSort')?.value || 'orders_desc');
  if (start && end && start > end) {
    toast('La fecha inicial no puede ser mayor a la final', true);
    return;
  }
  customersDateStart = start;
  customersDateEnd = end;
  customersSort = sort;
  customersPage = 1;
  loadCustomers();
});
$('#customersClearFilters')?.addEventListener('click', () => {
  customersDateStart = '';
  customersDateEnd = '';
  customersSort = 'orders_desc';
  customersPage = 1;
  const startInput = $('#customersDateStart');
  const endInput = $('#customersDateEnd');
  const sortInput = $('#customersSort');
  if (startInput) startInput.value = '';
  if (endInput) endInput.value = '';
  if (sortInput) sortInput.value = 'orders_desc';
  loadCustomers();
});

function formatExportRows(orders) {
  return orders.map((o) => {
    const sucursal = o.delivery === 'domicilio' ? (o.service_branch_name || '—') : (o.pickup_branch_name || '—');
    return {
      pedido: `#${o.id}`,
      cliente: o.customer?.name || '—',
      telefono: o.customer?.phone || '',
      productos: o.items.map((it) => `${it.qty}x ${it.name}`).join(', '),
      entrega: o.delivery === 'domicilio' ? 'Domicilio' : `Recoger${o.pickup_branch_name ? ` (${o.pickup_branch_name})` : ''}`,
      sucursal: sucursal,
      ubicacion: o.customer_location_text || '',
      motivo_cancelacion: o.cancel_note || '',
      metodo_pago: orderPaymentLabel(o.payment_method),
      total: Number(o.total || 0),
      estatus: o.status,
      fecha: o.created_at || '',
    };
  });
}

function exportOrdersExcel() {
  if (!LAST_ORDERS.length) return toast('No hay pedidos para exportar', true);
  if (!globalThis.XLSX) return toast('No se pudo cargar la librería de Excel', true);
  const rows = formatExportRows(LAST_ORDERS).map((r) => ({
    Pedido: r.pedido,
    Cliente: r.cliente,
    Telefono: r.telefono,
    Productos: r.productos,
    Entrega: r.entrega,
    Sucursal: r.sucursal,
    Ubicacion: r.ubicacion,
    MotivoCancelacion: r.motivo_cancelacion,
    MetodoPago: r.metodo_pago,
    Total: r.total,
    Estatus: r.estatus,
    Fecha: r.fecha,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pedidos');
  XLSX.writeFile(wb, `pedidos_${Date.now()}.xlsx`);
  toast('Pedidos exportados a Excel');
}

function exportOrdersPdf() {
  if (!LAST_ORDERS.length) return toast('No hay pedidos para exportar', true);
  if (!globalThis.jspdf || !globalThis.jspdf.jsPDF) return toast('No se pudo cargar la librería PDF', true);
  const rows = formatExportRows(LAST_ORDERS);
  const doc = new globalThis.jspdf.jsPDF({ orientation: 'landscape' });
  doc.setFontSize(14);
  doc.text(`Pedidos - ${ME?.tenant?.businessName || 'Negocio'}`, 14, 14);
  doc.setFontSize(10);
  doc.text(`Generado: ${new Date().toLocaleString('es-MX')}`, 14, 20);
  doc.autoTable({
    startY: 24,
    head: [['Pedido', 'Cliente', 'Telefono', 'Productos', 'Entrega', 'Ubicacion', 'Motivo cancelacion', 'Metodo pago', 'Total', 'Estatus', 'Fecha']],
    body: rows.map((r) => [r.pedido, r.cliente, r.telefono, r.productos, r.entrega, r.ubicacion, r.motivo_cancelacion, r.metodo_pago, fmtMoney(r.total), r.estatus, r.fecha]),
    styles: { fontSize: 8, cellPadding: 2.2 },
    headStyles: { fillColor: [23, 28, 46] },
    columnStyles: { 3: { cellWidth: 52 }, 5: { cellWidth: 32 }, 6: { cellWidth: 36 }, 7: { cellWidth: 24 } },
  });
  doc.save(`pedidos_${Date.now()}.pdf`);
  toast('Pedidos exportados a PDF');
}

$('#expExcelBtn')?.addEventListener('click', exportOrdersExcel);
$('#expPdfBtn')?.addEventListener('click', exportOrdersPdf);

async function loadDashboardBadge() {
  await refreshPendingOrdersMonitor({ allowSound: false });
}

$('#orderFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#orderFilter button').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  orderStatusFilter = btn.dataset.st;
  orderPage = 1;
  loadOrders();
});

$('#dashboardPeriodFilter')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn || btn.dataset.period === DASHBOARD_PERIOD) return;
  DASHBOARD_PERIOD = btn.dataset.period;
  loadDashboard();
});

$('#ordersTodayToggle')?.addEventListener('click', () => {
  orderTodayOnly = !orderTodayOnly;
  if (orderTodayOnly) {
    orderDateStart = '';
    orderDateEnd = '';
  }
  orderPage = 1;
  loadOrders();
});

$('#ordersApplyDate')?.addEventListener('click', () => {
  if (orderTodayOnly) return;
  orderDateStart = String($('#ordersDateStart')?.value || '');
  orderDateEnd = String($('#ordersDateEnd')?.value || '');
  if (orderDateStart && orderDateEnd && orderDateStart > orderDateEnd) {
    toast('La fecha inicial no puede ser mayor a la final', true);
    return;
  }
  orderPage = 1;
  loadOrders();
});

$('#ordersClearDate')?.addEventListener('click', () => {
  orderDateStart = '';
  orderDateEnd = '';
  const start = $('#ordersDateStart');
  const end = $('#ordersDateEnd');
  if (start) start.value = '';
  if (end) end.value = '';
  orderPage = 1;
  loadOrders();
});

$('#ordersSoundToggle')?.addEventListener('click', () => {
  ORDER_ALERT_SOUND_ENABLED = !ORDER_ALERT_SOUND_ENABLED;
  persistOrderSoundPreference();
  syncOrdersSoundToggleUI();
  toast(ORDER_ALERT_SOUND_ENABLED ? 'Sonido de pedidos activado' : 'Sonido de pedidos silenciado');
});

/* ===== Punto de venta ===== */
function moneyNum(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function posCartTotal() {
  return moneyNum(POS_CART.reduce((sum, item) => sum + item.price * item.qty, 0));
}

function posGrandTotal() {
  const fee = POS_IS_DELIVERY ? moneyNum(Number(POS_DELIVERY_FEE) || 0) : 0;
  return moneyNum(posCartTotal() + fee);
}

function posMethodLabel(method) {
  return {
    cash: 'Efectivo',
    card: 'Tarjeta',
    transfer: 'Transferencia',
    mixed: 'Múltiple',
  }[method] || method;
}

function posMovementLabel(kind) {
  return {
    income: 'Ingreso',
    withdrawal: 'Retiro',
    expense: 'Gasto',
  }[kind] || kind;
}

function posMovementKindMeta(kind) {
  return {
    income: {
      tone: 'income',
      icon: 'ph-trend-up',
      title: 'Ingreso de caja',
      desc: 'Usa este tipo para entradas de efectivo adicionales al fondo inicial.',
    },
    withdrawal: {
      tone: 'withdrawal',
      icon: 'ph-arrow-bend-up-left',
      title: 'Retiro de caja',
      desc: 'Registra salidas de efectivo por retiro administrativo o resguardo.',
    },
    expense: {
      tone: 'expense',
      icon: 'ph-receipt',
      title: 'Gasto operativo',
      desc: 'Registra egresos por compras y gastos del turno.',
    },
  }[kind] || {
    tone: 'income',
    icon: 'ph-arrows-left-right',
    title: 'Movimiento de caja',
    desc: '',
  };
}

function renderPosMovementKindHint(kind) {
  const hint = $('#posMovementKindHint');
  if (!hint) return;
  const meta = posMovementKindMeta(kind);
  hint.className = `pos-movement-kind-hint tone-${meta.tone}`;
  hint.innerHTML = `<i class="ph-bold ${meta.icon}"></i><div><b>${meta.title}</b><span>${meta.desc}</span></div>`;
}

function posSaleStatusBadge(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'cancelado') return '<span class="badge b-cancelado">Cancelado</span>';
  return '<span class="badge b-entregado">Activa</span>';
}

function setPosPaymentEditMethod(method) {
  POS_PAYMENT_EDIT_METHOD = method;
  document.querySelectorAll('#posPaymentEditMethods [data-method]').forEach((button) => {
    button.classList.toggle('on', button.dataset.method === method);
  });
  const showCash = method === 'cash';
  const showMixed = method === 'mixed';
  $('#posPaymentEditCashWrap').style.display = showCash ? 'block' : 'none';
  $('#posPaymentEditMixedWrap').style.display = showMixed ? 'block' : 'none';
  updatePosPaymentEditMixedHint();
}

function updatePosPaymentEditMixedHint() {
  const hint = $('#posPaymentEditMixedHint');
  if (!hint) return;
  if (POS_PAYMENT_EDIT_METHOD !== 'mixed') {
    hint.textContent = '';
    return;
  }
  const id = Number($('#posPaymentEditSaleId')?.value || 0);
  const sale = POS_SALES_HISTORY_CACHE.find((row) => Number(row.id) === id);
  const total = Number(sale?.total || 0);
  const cash = moneyNum($('#posPaymentEditMixCash')?.value || 0);
  const card = moneyNum($('#posPaymentEditMixCard')?.value || 0);
  const transfer = moneyNum($('#posPaymentEditMixTransfer')?.value || 0);
  const sum = moneyNum(cash + card + transfer);
  const diff = moneyNum(total - sum);
  if (Math.abs(diff) < 0.01) {
    hint.style.color = 'var(--green)';
    hint.textContent = `Cuadre correcto: ${fmtMoney(sum)}.`;
    return;
  }
  if (diff > 0) {
    hint.style.color = 'var(--amber)';
    hint.textContent = `Faltan ${fmtMoney(diff)} para completar ${fmtMoney(total)}.`;
    return;
  }
  hint.style.color = 'var(--red)';
  hint.textContent = `Excede por ${fmtMoney(Math.abs(diff))} sobre ${fmtMoney(total)}.`;
}

function openPosPaymentEditModal(id) {
  const sale = POS_SALES_HISTORY_CACHE.find((row) => Number(row.id) === Number(id));
  if (!sale) return toast('No se encontró la venta para editar', true);
  if (sale.status === 'cancelado') return toast('No puedes cambiar pago en una venta cancelada', true);

  const breakdown = sale.payment_breakdown || {};
  const method = sale.payment_method || 'cash';
  $('#posPaymentEditSaleId').value = String(sale.id);
  $('#posPaymentEditTicket').value = `#${sale.id} · ${fmtMoney(sale.total)}`;
  $('#posPaymentEditCashReceived').value = String(sale.cash_received || sale.total || '');
  $('#posPaymentEditMixCash').value = String(Number(breakdown.cash || 0));
  $('#posPaymentEditMixCard').value = String(Number(breakdown.card || 0));
  $('#posPaymentEditMixTransfer').value = String(Number(breakdown.transfer || 0));
  $('#posPaymentEditMixCashReceived').value = String(sale.cash_received || Number(breakdown.cash || 0) || '');
  setPosPaymentEditMethod(method);
  $('#posPaymentEditModal').classList.add('show');
}

function openPosCancelSaleModal(id) {
  const sale = POS_SALES_HISTORY_CACHE.find((row) => Number(row.id) === Number(id));
  if (!sale) return toast('No se encontró la venta', true);
  if (sale.status === 'cancelado') return toast('La venta ya está cancelada', true);
  
  $('#posCancelSaleSaleId').value = String(sale.id);
  $('#posCancelSaleTicket').value = `#${sale.id} · ${fmtMoney(sale.total)}`;
  $('#posCancelSaleReason').value = '';
  $('#posCancelSaleModal').classList.add('show');
}

async function submitPosCancelSale() {
  const saleId = Number($('#posCancelSaleSaleId')?.value || 0);
  const reason = String($('#posCancelSaleReason')?.value || '').trim();
  
  if (!saleId) return toast('Venta inválida', true);
  if (!reason) return toast('Debes indicar un motivo de cancelación', true);
  
  try {
    await api(`/api/pos/sales/${saleId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    $('#posCancelSaleModal').classList.remove('show');
    toast('Venta cancelada correctamente');
    await loadPos();
    await loadPosSalesHistory(POS_SALES_PAGE);
  } catch (err) {
    toast(err.message, true);
  }
}

function getVisiblePosProducts() {
  const products = POS_OVERVIEW?.products || [];
  const filtered = POS_CATEGORY_FILTER === 'all'
    ? products
    : products.filter((product) => String(product.category_id || 'none') === POS_CATEGORY_FILTER);

  const sorted = [...filtered];
  if (normalizePosSortMode(POS_PRODUCT_SORT) === 'alphabetical') {
    sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' }));
    return sorted;
  }

  sorted.sort((a, b) => {
    const soldDiff = Number(b.soldQty || 0) - Number(a.soldQty || 0);
    if (soldDiff !== 0) return soldDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' });
  });
  return sorted;
}

function syncPosCartFromCatalog() {
  const byId = new Map((POS_OVERVIEW?.products || []).map((product) => [Number(product.id), product]));
  POS_CART = POS_CART.filter((item) => byId.has(Number(item.id))).map((item) => {
    const product = byId.get(Number(item.id));
    if (item._cartKey) {
      return {
        ...item,
        image: product.image,
      };
    }
    return {
      ...item,
      name: product.name,
      price: Number(product.price),
      image: product.image,
    };
  });
}

function setPosPaymentDefaults() {
  const total = posGrandTotal();
  if (POS_PAYMENT_METHOD === 'cash' && (POS_PAYMENT_FORM.cashReceived === '' || POS_PAYMENT_FORM.cashReceived === null)) {
    POS_PAYMENT_FORM.cashReceived = String(total || '');
  }
  if (POS_PAYMENT_METHOD !== 'mixed') {
    POS_PAYMENT_FORM.cash = '';
    POS_PAYMENT_FORM.card = '';
    POS_PAYMENT_FORM.transfer = '';
  }
}

function resetPosPaymentForm() {
  POS_PAYMENT_METHOD = 'cash';
  POS_PAYMENT_FORM = { cashReceived: '', cash: '', card: '', transfer: '', notes: '' };
  POS_IS_DELIVERY = false;
  POS_DELIVERY_FEE = '';
}

function updatePosChangeHint() {
  const hint = $('#posChangeHint');
  if (!hint) return;
  const total = posGrandTotal();
  const received = moneyNum($('#posCashReceived')?.value || 0);
  const effectiveCashPart = POS_PAYMENT_METHOD === 'mixed'
    ? moneyNum($('#posMixCash')?.value || POS_PAYMENT_FORM.cash || 0)
    : total;
  const change = Math.max(received - effectiveCashPart, 0);
  hint.textContent = `Cambio estimado: ${fmtMoney(change)}`;
}

function updatePosMixedHint() {
  const hint = $('#posMixedHint');
  if (!hint) return;
  const submitBtn = $('#posCheckoutForm button[type="submit"]');
  const hasSession = Boolean(POS_OVERVIEW?.activeSession);
  const total = posGrandTotal();
  const cash = moneyNum($('#posMixCash')?.value || POS_PAYMENT_FORM.cash || 0);
  const card = moneyNum($('#posMixCard')?.value || POS_PAYMENT_FORM.card || 0);
  const transfer = moneyNum($('#posMixTransfer')?.value || POS_PAYMENT_FORM.transfer || 0);
  const sum = moneyNum(cash + card + transfer);
  const diff = moneyNum(total - sum);
  const base = `Suma capturada: ${fmtMoney(sum)} de ${fmtMoney(total)}.`;
  if (Math.abs(diff) < 0.01) {
    hint.style.color = 'var(--green)';
    hint.textContent = `${base} Cuadre correcto.`;
    if (submitBtn) submitBtn.disabled = !hasSession;
    return;
  }
  if (diff > 0) {
    hint.style.color = 'var(--amber)';
    hint.textContent = `${base} Faltan ${fmtMoney(diff)}.`;
    if (submitBtn) submitBtn.disabled = true;
    return;
  }
  hint.style.color = 'var(--red)';
  hint.textContent = `${base} Excede por ${fmtMoney(Math.abs(diff))}.`;
  if (submitBtn) submitBtn.disabled = true;
}

function buildPosTicketData() {
  if (POS_CART.length) {
    const items = POS_CART.map((item) => ({
      qty: item.qty,
      name: item.name,
      price: Number(item.price),
      total: moneyNum(item.qty * item.price),
    }));
    const subtotal = posCartTotal();
    const deliveryFee = POS_IS_DELIVERY ? moneyNum(Number(POS_DELIVERY_FEE) || 0) : 0;
    const total = moneyNum(subtotal + deliveryFee);
    const paymentBreakdown = {
      cash: POS_PAYMENT_METHOD === 'cash' ? total : moneyNum(POS_PAYMENT_FORM.cash || 0),
      card: POS_PAYMENT_METHOD === 'card' ? total : moneyNum(POS_PAYMENT_FORM.card || 0),
      transfer: POS_PAYMENT_METHOD === 'transfer' ? total : moneyNum(POS_PAYMENT_FORM.transfer || 0),
    };
    return {
      id: null,
      createdAt: new Date().toLocaleString('es-MX'),
      paymentMethod: POS_PAYMENT_METHOD,
      items,
      subtotal,
      deliveryFee,
      total,
      paymentBreakdown,
      cashReceived: moneyNum(POS_PAYMENT_FORM.cashReceived || 0),
      cashChange: POS_PAYMENT_METHOD === 'cash'
        ? Math.max(moneyNum(POS_PAYMENT_FORM.cashReceived || 0) - total, 0)
        : 0,
      notes: POS_PAYMENT_FORM.notes || '',
    };
  }
  if (LAST_POS_SALE) {
    return {
      id: LAST_POS_SALE.id,
      createdAt: new Date().toLocaleString('es-MX'),
      paymentMethod: LAST_POS_SALE.paymentMethod,
      items: LAST_POS_SALE.items.map((item) => ({
        qty: item.qty,
        name: item.name,
        price: Number(item.price),
        total: moneyNum(item.qty * item.price),
      })),
      subtotal: Number(LAST_POS_SALE.subtotal || LAST_POS_SALE.total || 0),
      deliveryFee: Number(LAST_POS_SALE.deliveryFee || 0),
      total: Number(LAST_POS_SALE.total || 0),
      paymentBreakdown: LAST_POS_SALE.paymentBreakdown || null,
      cashReceived: moneyNum(LAST_POS_SALE.cashReceived || 0),
      cashChange: moneyNum(LAST_POS_SALE.cashChange || 0),
      notes: LAST_POS_SALE.notes || '',
    };
  }
  return null;
}

function openThermalPrintWindow(ticket) {
  if (!ticket) return toast('No hay ticket para imprimir', true);
  const biz = esc(SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio');
  const bizAddress = esc(SETTINGS?.address || '');
  const bizHours = esc(SETTINGS?.hours || '');
  const bizWhatsapp = esc((SETTINGS?.whatsapp || '').trim());
  const seller = esc(ME?.username || 'cajero');
  const currency = SETTINGS?.currency || 'MXN';
  const widthMm = Math.max(58, Math.min(80, Number(SETTINGS?.ticket_width_mm || 80)));
  const fontPx = Math.max(10, Math.min(24, Number(SETTINGS?.ticket_font_size_px || 14)));
  const lineHeight = Math.max(1.1, Math.min(2, Number(SETTINGS?.ticket_line_height || 1.45)));
  const showLogo = SETTINGS?.ticket_show_logo !== '0';
  const printMode = SETTINGS?.ticket_print_mode === 'bluetooth' ? 'bluetooth' : 'thermal';
  const mobileZoomPercent = Math.max(80, Math.min(120, Number(SETTINGS?.ticket_mobile_zoom_percent || 100)));
  const mobileZoom = mobileZoomPercent / 100;
  const printZoom = printMode === 'bluetooth' ? mobileZoom : 1;
  const pageCss = printMode === 'bluetooth'
    ? '@page { size: auto; margin: 6mm; }'
    : `@page { size: ${widthMm}mm auto; margin: 3mm; }`;
  const printWindowSize = printMode === 'bluetooth' ? 'width=430,height=760' : 'width=420,height=760';
  const logo = ME?.tenant?.logo
    ? `${location.origin}${ME.tenant.logo.startsWith('/') ? ME.tenant.logo : `/${ME.tenant.logo}`}`
    : '';
  const ticketId = ticket.id ? `#${ticket.id}` : 'Pre-ticket';
  const itemRows = (ticket.items || [])
    .map(
      (it) => `<tr>
        <td>${esc(`${it.qty} x ${it.name}`)}<div style="font-size:${Math.max(fontPx-2,10)}px;color:#555">${esc(fmtMoney(it.price, currency))} c/u</div></td>
        <td class="r">${esc(fmtMoney(it.total, currency))}</td>
      </tr>`
    )
    .join('') || '<tr><td>Sin productos</td><td class="r">$0.00</td></tr>';

  const breakdownObj = ticket.paymentBreakdown || {};
  const isMixed = ticket.paymentMethod === 'mixed';
  const breakdownLines = ['cash', 'card', 'transfer']
    .filter((method) => Number(breakdownObj[method]) > 0)
    .map((method) => `<tr><td>${esc(posMethodLabel(method))}</td><td class="r">${esc(fmtMoney(breakdownObj[method], currency))}</td></tr>`)
    .join('');

  const subtotal = Number(ticket.subtotal || ticket.total || 0);
  const total = Number(ticket.total || 0);
  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Ticket ${esc(ticketId)}</title>
  <style>
    ${pageCss}
    html, body { margin: 0; padding: 0; }
    body { width: 100%; max-width: ${Math.max(50, widthMm - 6)}mm; margin: 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${fontPx}px; line-height: ${lineHeight}; color: #000; }
    .ticket-wrap { width: 100%; margin: 0 auto; zoom: ${printZoom}; }
    @supports not (zoom: 1) {
      .ticket-wrap { transform: scale(${printZoom}); transform-origin: top center; width: ${printZoom === 1 ? 100 : (100 / printZoom).toFixed(4)}%; }
    }
    .center { text-align: center; }
    .right { text-align: right; }
    .sep { border-top: 1px dashed #000; margin: 8px 0; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 2px; vertical-align: top; }
    td.r { text-align: right; white-space: nowrap; }
    .tot { font-size: ${Math.max(fontPx + 2, 14)}px; font-weight: 700; }
    .meta { font-size: ${Math.max(fontPx - 1, 10)}px; }
    .logo { text-align: center; margin-bottom: 6px; }
    .logo img { max-width: 46mm; max-height: 22mm; object-fit: contain; }
  </style>
</head>
<body>
  <div class="ticket-wrap">
  ${showLogo && logo ? `<div class="logo"><img src="${esc(logo)}" alt="Logo" /></div>` : ''}
  <div class="center"><b>${biz}</b></div>
  ${bizAddress ? `<div class="center meta">${bizAddress}</div>` : ''}
  ${bizHours ? `<div class="center meta">Horario: ${bizHours}</div>` : ''}
  ${bizWhatsapp ? `<div class="center meta">WhatsApp: ${bizWhatsapp}</div>` : ''}
  <div class="center meta">Ticket ${esc(ticketId)}</div>
  <div class="center meta">${esc(ticket.createdAt)}</div>
  <div class="center meta">Cajero: ${seller}</div>
  <div class="sep"></div>
  <table>${itemRows}</table>
  <div class="sep"></div>
  <table>
    <tr><td>Método</td><td class="r">${esc(posMethodLabel(ticket.paymentMethod || 'cash'))}</td></tr>
    ${breakdownLines}
    ${Number(ticket.deliveryFee || 0) > 0
      ? `<tr><td>Subtotal</td><td class="r">${esc(fmtMoney(subtotal, currency))}</td></tr><tr><td>&#x1F6F5; Envío domicilio</td><td class="r">+ ${esc(fmtMoney(Number(ticket.deliveryFee), currency))}</td></tr>`
      : `<tr><td>Subtotal</td><td class="r">${esc(fmtMoney(subtotal, currency))}</td></tr>`}
    <tr><td class="tot">TOTAL</td><td class="tot r">${esc(fmtMoney(total, currency))}</td></tr>
    ${!isMixed && Number(ticket.cashReceived || 0) > 0 ? `<tr><td>Efectivo recibido</td><td class="r">${esc(fmtMoney(ticket.cashReceived, currency))}</td></tr>` : ''}
    ${!isMixed && Number(ticket.cashChange || 0) > 0 ? `<tr><td>Cambio</td><td class="r">${esc(fmtMoney(ticket.cashChange, currency))}</td></tr>` : ''}
  </table>
  ${ticket.notes ? `<div class="sep"></div><div class="meta">Nota: ${esc(ticket.notes)}</div>` : ''}
  <div class="sep"></div>
  <div class="center meta">Gracias por tu compra</div>
  </div>
  <script>
    window.onload = () => {
      window.print();
      setTimeout(() => window.close(), 120);
    };
  </script>
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const w = window.open(blobUrl, '_blank', printWindowSize);
  if (!w) return toast('Permite ventanas emergentes para imprimir', true);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
}

function printPosTicket() {
  const ticket = buildPosTicketData();
  if (!ticket) return toast('No hay ticket para imprimir', true);
  openThermalPrintWindow(ticket);
}

function printPosSaleById(id) {
  const sale = POS_SALES_HISTORY_CACHE.find((row) => Number(row.id) === Number(id))
    || (POS_OVERVIEW?.recentSales || []).find((row) => Number(row.id) === Number(id));
  if (!sale) return toast('No se encontró la venta para imprimir', true);
  const items = Array.isArray(sale.items) ? sale.items : [];
  const ticket = {
    id: sale.id,
    createdAt: sale.created_at || new Date().toLocaleString('es-MX'),
    paymentMethod: sale.payment_method,
    items: items.map((it) => ({
      qty: Number(it.qty || 0),
      name: String(it.name || ''),
      price: Number(it.price || 0),
      total: moneyNum(Number(it.qty || 0) * Number(it.price || 0)),
    })),
    subtotal: Number(sale.total || 0),
    total: Number(sale.total || 0),
    paymentBreakdown: sale.payment_breakdown || null,
    cashReceived: moneyNum(sale.cash_received || 0),
    cashChange: moneyNum(sale.cash_change || 0),
    notes: String(sale.notes || ''),
  };
  openThermalPrintWindow(ticket);
}

function exportPosClosePdf(closeResult) {
  if (!closeResult) return;
  if (!globalThis.jspdf || !globalThis.jspdf.jsPDF) {
    toast('No se pudo exportar PDF del cierre (librería no disponible)', true);
    return;
  }
  const totals = closeResult.totals || {};
  const collected = totals.collected || {};
  const salesByMethod = totals.salesByMethod || {};
  const movements = totals.movements || {};
  const cancellations = totals.cancellations || {};
  const delivery = totals.delivery || {};

  const doc = new globalThis.jspdf.jsPDF({ orientation: 'portrait' });
  const bizName = SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio';
  const now = new Date().toLocaleString('es-MX');
  const closedBy = closeResult?.closedSession?.closed_by || ME?.username || 'cajero';

  doc.setFontSize(15);
  doc.text(`Cierre de caja - ${bizName}`, 14, 14);
  doc.setFontSize(10);
  doc.text(`Generado: ${now}`, 14, 20);
  doc.text(`Cerrado por: ${closedBy}`, 14, 25);

  doc.autoTable({
    startY: 30,
    head: [['Concepto', 'Valor']],
    body: [
      ['Fondo inicial', fmtMoney(closeResult?.closedSession?.opening_amount || 0)],
      ['Ventas del turno', fmtMoney(totals.totalSales || 0)],
      ['Efectivo esperado', fmtMoney(closeResult.expectedAmount || 0)],
      ['Efectivo contado', fmtMoney(closeResult.closingAmount || 0)],
      ['Diferencia', fmtMoney(closeResult.differenceAmount || 0)],
      ['Tickets', String(totals.tickets || 0)],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [23, 28, 46] },
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 6,
    head: [['Ventas por medio', 'Monto']],
    body: [
      ['Efectivo', fmtMoney(salesByMethod.cash || 0)],
      ['Tarjeta', fmtMoney(salesByMethod.card || 0)],
      ['Transferencia', fmtMoney(salesByMethod.transfer || 0)],
      ['Mixto', fmtMoney(salesByMethod.mixed || 0)],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [37, 99, 235] },
  });

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 6,
    head: [['Caja / Operación', 'Monto']],
    body: [
      ['Cobrado efectivo', fmtMoney(collected.cash || 0)],
      ['Cobrado tarjeta', fmtMoney(collected.card || 0)],
      ['Cobrado transferencia', fmtMoney(collected.transfer || 0)],
      ['Ingresos manuales', fmtMoney(movements.income || 0)],
      ['Retiros', fmtMoney(movements.withdrawal || 0)],
      ['Gastos', fmtMoney(movements.expense || 0)],
      ['Cancelaciones tickets', String(cancellations.tickets || 0)],
      ['Cancelaciones total', fmtMoney(cancellations.total || 0)],
      ['Domicilios tickets', String(delivery.tickets || 0)],
      ['Domicilios total', fmtMoney(delivery.total || 0)],
      ['Costo envíos', fmtMoney(delivery.fees || 0)],
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [14, 165, 233] },
  });

  const notes = String(closeResult?.closedSession?.notes || '').trim();
  if (notes) {
    doc.setFontSize(9);
    doc.text(`Nota de cierre: ${notes}`, 14, doc.lastAutoTable.finalY + 10, { maxWidth: 180 });
  }

  doc.save(`cierre_caja_${Date.now()}.pdf`);
}

function printPosCloseReport(closeResult) {
  if (!closeResult) return;
  const totals = closeResult.totals || {};
  const collected = totals.collected || {};
  const salesByMethod = totals.salesByMethod || {};
  const movements = totals.movements || {};
  const cancellations = totals.cancellations || {};
  const delivery = totals.delivery || {};
  const biz = esc(SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio');
  const now = new Date().toLocaleString('es-MX');
  const closedBy = esc(closeResult?.closedSession?.closed_by || ME?.username || 'cajero');

  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cierre de caja</title>
  <style>
    body { font-family: ui-sans-serif, system-ui; margin: 16px; color: #111827; }
    h2 { margin: 0 0 8px; }
    p { margin: 2px 0; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; font-size: 12px; text-align: left; }
    th { background: #f3f4f6; }
    .tot { font-weight: 700; }
  </style>
</head>
<body>
  <h2>Cierre de caja - ${biz}</h2>
  <p>Generado: ${esc(now)}</p>
  <p>Cerrado por: ${closedBy}</p>
  <table>
    <tr><th>Concepto</th><th>Valor</th></tr>
    <tr><td>Fondo inicial</td><td>${esc(fmtMoney(closeResult?.closedSession?.opening_amount || 0))}</td></tr>
    <tr><td>Ventas del turno</td><td>${esc(fmtMoney(totals.totalSales || 0))}</td></tr>
    <tr><td>Efectivo esperado</td><td>${esc(fmtMoney(closeResult.expectedAmount || 0))}</td></tr>
    <tr><td>Efectivo contado</td><td>${esc(fmtMoney(closeResult.closingAmount || 0))}</td></tr>
    <tr class="tot"><td>Diferencia</td><td>${esc(fmtMoney(closeResult.differenceAmount || 0))}</td></tr>
  </table>
  <table>
    <tr><th>Medio</th><th>Monto</th></tr>
    <tr><td>Efectivo</td><td>${esc(fmtMoney(salesByMethod.cash || 0))}</td></tr>
    <tr><td>Tarjeta</td><td>${esc(fmtMoney(salesByMethod.card || 0))}</td></tr>
    <tr><td>Transferencia</td><td>${esc(fmtMoney(salesByMethod.transfer || 0))}</td></tr>
    <tr><td>Mixto</td><td>${esc(fmtMoney(salesByMethod.mixed || 0))}</td></tr>
  </table>
  <table>
    <tr><th>Auditoría</th><th>Monto</th></tr>
    <tr><td>Cobrado efectivo</td><td>${esc(fmtMoney(collected.cash || 0))}</td></tr>
    <tr><td>Cobrado tarjeta</td><td>${esc(fmtMoney(collected.card || 0))}</td></tr>
    <tr><td>Cobrado transferencia</td><td>${esc(fmtMoney(collected.transfer || 0))}</td></tr>
    <tr><td>Ingresos</td><td>${esc(fmtMoney(movements.income || 0))}</td></tr>
    <tr><td>Retiros</td><td>${esc(fmtMoney(movements.withdrawal || 0))}</td></tr>
    <tr><td>Gastos</td><td>${esc(fmtMoney(movements.expense || 0))}</td></tr>
    <tr><td>Cancelaciones tickets</td><td>${esc(String(cancellations.tickets || 0))}</td></tr>
    <tr><td>Cancelaciones total</td><td>${esc(fmtMoney(cancellations.total || 0))}</td></tr>
    <tr><td>Domicilios tickets</td><td>${esc(String(delivery.tickets || 0))}</td></tr>
    <tr><td>Domicilios total</td><td>${esc(fmtMoney(delivery.total || 0))}</td></tr>
    <tr><td>Costo envíos</td><td>${esc(fmtMoney(delivery.fees || 0))}</td></tr>
  </table>
  <script>
    window.onload = () => {
      window.print();
      setTimeout(() => window.close(), 120);
    };
  </script>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const w = window.open(blobUrl, '_blank', 'width=780,height=860');
  if (!w) {
    toast('Permite ventanas emergentes para imprimir el cierre', true);
    return;
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
}

async function loadPos() {
  POS_OVERVIEW = await api('/api/pos/overview');
  if (!POS_PRODUCT_SORT || POS_PRODUCT_SORT === 'top_sold') {
    const tenantMode = normalizePosSortMode(SETTINGS?.pos_catalog_sort_mode || '');
    const localMode = readStoredPosSortMode();
    POS_PRODUCT_SORT = tenantMode || localMode || 'top_sold';
  }
  const select = $('#posSortSelect');
  if (select) select.value = normalizePosSortMode(POS_PRODUCT_SORT);
  syncPosCartFromCatalog();
  setPosPaymentDefaults();
  renderPos();
}

function addPosProduct(productId) {
  const product = (POS_OVERVIEW?.products || []).find((item) => Number(item.id) === Number(productId));
  if (!product) return;

  // Si tiene variantes o grupos de modificadores, mostrar modal de configuración
  const hasVariants = Array.isArray(product.variants) && product.variants.length > 1;
  const hasModifiers = Array.isArray(product.modifierGroups) && product.modifierGroups.length > 0;
  if (hasVariants || hasModifiers) {
    openPosProductConfigModal(product);
    return;
  }

  const existing = POS_CART.find((item) => Number(item.id) === Number(product.id) && !item._cartKey);
  if (existing) {
    existing.qty += 1;
  } else {
    POS_CART.push({ id: Number(product.id), name: product.name, price: Number(product.price), image: product.image, qty: 1 });
  }
  setPosPaymentDefaults();
  renderPosCart();
}

// ── Modal configurador de producto (POS) ──
let POS_CONFIG_PRODUCT = null;
let POS_CONFIG_VARIANT_ID = null;
let POS_CONFIG_MODIFIER_SELECTIONS = {}; // { groupId: [optionId, ...] }

function openPosProductConfigModal(product) {
  POS_CONFIG_PRODUCT = product;
  POS_CONFIG_VARIANT_ID = null;
  POS_CONFIG_MODIFIER_SELECTIONS = {};

  $('#posProductConfigTitle').innerHTML = `<i class="ph-bold ph-sliders"></i> ${esc(product.name)}`;
  renderPosProductConfigBody();
  $('#posProductConfigModal').classList.add('show');
}

function renderPosProductConfigBody() {
  const product = POS_CONFIG_PRODUCT;
  if (!product) return;
  const hasVariants = Array.isArray(product.variants) && product.variants.length > 1;
  const hasModifiers = Array.isArray(product.modifierGroups) && product.modifierGroups.length > 0;
  let html = '';

  if (hasVariants) {
    html += `<div class="pos-config-section"><div class="pos-config-label"><i class="ph-bold ph-stack"></i> Elige una opción</div><div class="pos-config-variants">`;
    for (const v of product.variants) {
      const sel = POS_CONFIG_VARIANT_ID === v.id;
      html += `<button type="button" class="pos-variant-btn${sel?' active':''}" data-variant-id="${v.id}" data-variant-price="${v.price}">${esc(v.name)}<span>${fmtMoney(v.price)}</span></button>`;
    }
    html += `</div></div>`;
  }

  if (hasModifiers) {
    for (const g of product.modifierGroups) {
      const sel = POS_CONFIG_MODIFIER_SELECTIONS[g.id] || [];
      const minLabel = g.min_selections > 0 ? `<span class="pos-config-required">Requerido (mín ${g.min_selections})</span>` : '<span class="pos-config-optional">Opcional</span>';
      html += `<div class="pos-config-section"><div class="pos-config-label"><i class="ph-bold ph-sliders-horizontal"></i> ${esc(g.name)} <small>máx ${g.max_selections}</small> ${minLabel}</div><div class="pos-config-options">`;
      for (const o of g.options) {
        const checked = sel.includes(o.id);
        const extraLabel = Number(o.extra_price) > 0 ? `<span>+${fmtMoney(o.extra_price)}</span>` : '';
        html += `<button type="button" class="pos-modifier-btn${checked?' active':''}" data-group-id="${g.id}" data-opt-id="${o.id}" data-extra-price="${o.extra_price}" data-max="${g.max_selections}">${esc(o.name)}${extraLabel}</button>`;
      }
      html += `</div></div>`;
    }
  }

  if (!html) html = `<div class="hint" style="text-align:center;padding:16px">${esc(product.name)} — ${fmtMoney(product.price)}</div>`;
  $('#posProductConfigBody').innerHTML = html;

  // Events
  document.querySelectorAll('#posProductConfigBody .pos-variant-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      POS_CONFIG_VARIANT_ID = Number(btn.dataset.variantId);
      renderPosProductConfigBody();
    });
  });
  document.querySelectorAll('#posProductConfigBody .pos-modifier-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gid = Number(btn.dataset.groupId);
      const oid = Number(btn.dataset.optId);
      const max = Number(btn.dataset.max) || 1;
      if (!POS_CONFIG_MODIFIER_SELECTIONS[gid]) POS_CONFIG_MODIFIER_SELECTIONS[gid] = [];
      const sel = POS_CONFIG_MODIFIER_SELECTIONS[gid];
      const idx = sel.indexOf(oid);
      if (idx >= 0) {
        sel.splice(idx, 1);
      } else {
        if (max === 1) {
          POS_CONFIG_MODIFIER_SELECTIONS[gid] = [oid];
        } else {
          if (sel.length < max) sel.push(oid);
        }
      }
      renderPosProductConfigBody();
    });
  });
}

$('#posProductConfigCancel')?.addEventListener('click', () => $('#posProductConfigModal').classList.remove('show'));
$('#posProductConfigAdd')?.addEventListener('click', () => {
  const product = POS_CONFIG_PRODUCT;
  if (!product) return;
  const hasVariants = Array.isArray(product.variants) && product.variants.length > 1;

  // Validate variant required
  if (hasVariants && !POS_CONFIG_VARIANT_ID) {
    toast('Selecciona una variante para continuar', true);
    return;
  }

  // Validate required modifier groups
  for (const g of (product.modifierGroups || [])) {
    const sel = POS_CONFIG_MODIFIER_SELECTIONS[g.id] || [];
    if (g.min_selections > 0 && sel.length < g.min_selections) {
      toast(`Selecciona al menos ${g.min_selections} opción en "${g.name}"`, true);
      return;
    }
  }

  // Build cart item
  let finalPrice = Number(product.price);
  let variantName = null;
  if (hasVariants && POS_CONFIG_VARIANT_ID) {
    const v = product.variants.find((v) => v.id === POS_CONFIG_VARIANT_ID);
    if (v) { finalPrice = Number(v.price); variantName = v.name; }
  }

  const modifiersDetail = [];
  let modifiersExtra = 0;
  let modifiersLabelParts = [];
  for (const g of (product.modifierGroups || [])) {
    const sel = POS_CONFIG_MODIFIER_SELECTIONS[g.id] || [];
    if (!sel.length) continue;
    const chosenOpts = g.options.filter((o) => sel.includes(o.id));
    modifiersDetail.push({ groupId: g.id, groupName: g.name, options: chosenOpts.map((o) => ({ id: o.id, name: o.name, extraPrice: Number(o.extra_price) })) });
    modifiersExtra += chosenOpts.reduce((sum, o) => sum + Number(o.extra_price), 0);
    modifiersLabelParts.push(chosenOpts.map((o) => o.name).join('/'));
  }
  finalPrice += modifiersExtra;

  const modifiersLabel = modifiersLabelParts.join(' · ');
  const displayName = [product.name, variantName, modifiersLabel].filter(Boolean).join(' · ');
  const cartKey = `${product.id}_${POS_CONFIG_VARIANT_ID || 'base'}_${modifiersLabel}`;

  const existing = POS_CART.find((item) => item._cartKey === cartKey);
  if (existing) {
    existing.qty += 1;
  } else {
    POS_CART.push({
      id: Number(product.id),
      name: displayName,
      price: finalPrice,
      image: product.image,
      qty: 1,
      _cartKey: cartKey,
      variantId: POS_CONFIG_VARIANT_ID,
      variantName,
      modifiers: modifiersDetail,
      modifiersLabel,
      modifiersExtraPrice: modifiersExtra,
    });
  }

  $('#posProductConfigModal').classList.remove('show');
  setPosPaymentDefaults();
  renderPosCart();
});

function updatePosQty(productId, delta, cartKey) {
  const item = cartKey
    ? POS_CART.find((entry) => entry._cartKey === cartKey)
    : POS_CART.find((entry) => Number(entry.id) === Number(productId) && !entry._cartKey);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) {
    POS_CART = cartKey
      ? POS_CART.filter((entry) => entry._cartKey !== cartKey)
      : POS_CART.filter((entry) => !(Number(entry.id) === Number(productId) && !entry._cartKey));
  }
  setPosPaymentDefaults();
  renderPosCart();
}

function clearPosCart() {
  POS_CART = [];
  resetPosPaymentForm();
  renderPosCart();
}

function renderPos() {
  renderPosFinanceStrip();
  renderPosDeliveryStrip();
  renderPosActions();
  renderPosSession();
  renderPosCatalog();
  renderPosCart();
}

function renderPosDeliveryStrip() {
  const el = $('#posDeliveryStrip');
  if (!el) return;
  const session = POS_OVERVIEW?.activeSession;
  const delivery = session?.totals?.delivery || { tickets: 0, total: 0, fees: 0 };
  if (!session) { el.innerHTML = ''; return; }
  const branchHtml = session?.branch_name
    ? `<div class="pos-delivery-branch"><i class="ph-bold ph-storefront"></i><span>Sucursal activa: ${esc(session.branch_name)}</span></div>`
    : '';
  if (!delivery.tickets) {
    el.innerHTML = branchHtml;
    return;
  }
  el.innerHTML = `
    ${branchHtml}
    <div class="pos-delivery-wrap">
      <div class="pos-delivery-header">
        <i class="ph-bold ph-moped"></i>
        <span>Servicios a domicilio del turno</span>
        <span class="pos-delivery-count">${delivery.tickets} pedido${delivery.tickets !== 1 ? 's' : ''}</span>
      </div>
      <div class="pos-delivery-stats">
        <div class="pos-delivery-stat">
          <div class="pos-delivery-stat-ic"><i class="ph-bold ph-package"></i></div>
          <div><span>Pedidos domicilio</span><b>${delivery.tickets}</b></div>
        </div>
        <div class="pos-delivery-stat">
          <div class="pos-delivery-stat-ic"><i class="ph-bold ph-currency-circle-dollar"></i></div>
          <div><span>Total domicilio</span><b>${fmtMoney(delivery.total)}</b></div>
        </div>
        <div class="pos-delivery-stat">
          <div class="pos-delivery-stat-ic"><i class="ph-bold ph-truck"></i></div>
          <div><span>Costo envíos cobrados</span><b>${fmtMoney(delivery.fees)}</b></div>
        </div>
      </div>
    </div>`;
}

function renderPosActions() {
  const el = $('#posActionIcons');
  if (!el) return;
  const hasSession = Boolean(POS_OVERVIEW?.activeSession);
  const chatbotEnabled = Boolean(POS_OVERVIEW?.chatbotIntegrationEnabled);
  el.innerHTML = `
    ${chatbotEnabled ? `<button type="button" class="pos-action-btn" id="posOpenChatbotQueue" ${hasSession ? '' : 'disabled'}>
      <i class="ph-bold ph-chat-circle-dots"></i> Pedidos chatbot
    </button>` : ''}
    <button type="button" class="pos-action-btn" id="posOpenSalesHistory">
      <i class="ph-bold ph-receipt"></i> Historial de ventas
    </button>
    <button type="button" class="pos-action-btn" id="posOpenMovement" ${hasSession ? '' : 'disabled'}>
      <i class="ph-bold ph-arrows-left-right"></i> Movimientos
    </button>
    <button type="button" class="pos-action-btn" id="posOpenClose" ${hasSession ? '' : 'disabled'}>
      <i class="ph-bold ph-lock"></i> Cierre de caja
    </button>
  `;
  $('#posOpenChatbotQueue')?.addEventListener('click', openPosChatbotQueueModal);
  $('#posOpenSalesHistory')?.addEventListener('click', openPosSalesHistoryModal);
  $('#posOpenMovement')?.addEventListener('click', openPosMovementModal);
  $('#posOpenClose')?.addEventListener('click', openPosCloseModal);
}

function renderPosFinanceStrip() {
  const el = $('#posFinanceStrip');
  if (!el) return;
  const session = POS_OVERVIEW?.activeSession;
  const totals = session?.totals || {
    tickets: 0,
    totalSales: 0,
    collected: { cash: 0, card: 0, transfer: 0 },
    movements: { income: 0, withdrawal: 0, expense: 0 },
    cancellations: { tickets: 0, total: 0 },
  };
  const expectedCash = session?.expectedCash || 0;
  const movementNet = moneyNum(totals.movements.income - totals.movements.withdrawal - totals.movements.expense);
  const cards = [
    { icon: 'ph-wallet', title: 'Fondo inicial', value: session?.opening_amount || 0, tone: 'primary' },
    { icon: 'ph-chart-line-up', title: 'Ventas del turno', value: totals.totalSales, tone: 'blue' },
    { icon: 'ph-money', title: 'Efectivo en ventas', value: totals.collected.cash, tone: 'green' },
    { icon: 'ph-credit-card', title: 'Tarjeta', value: totals.collected.card, tone: 'violet' },
    { icon: 'ph-bank', title: 'Transferencia', value: totals.collected.transfer, tone: 'cyan' },
    { icon: 'ph-arrows-down-up', title: 'Movimientos netos', value: movementNet, tone: movementNet < 0 ? 'red' : 'amber' },
    { icon: 'ph-x-circle', title: 'Cancelaciones', value: totals.cancellations.total, tone: 'red' },
    { icon: 'ph-calculator', title: 'Efectivo esperado', value: expectedCash, tone: 'ink' },
  ];
  el.innerHTML = cards
    .map(
      (card) => `<div class="pos-fin-card tone-${card.tone}">
        <div class="pos-fin-ic"><i class="ph-fill ${card.icon}"></i></div>
        <div class="pos-fin-copy">
          <span>${card.title}</span>
          <b>${fmtMoney(card.value)}</b>
          <small>${session ? `Tickets: ${totals.tickets}` : 'Caja cerrada'}</small>
        </div>
      </div>`
    )
    .join('');
}

function renderPosSession() {
  const el = $('#posSessionCard');
  const session = POS_OVERVIEW?.activeSession;
  if (!session) {
    const branches = Array.isArray(POS_OVERVIEW?.branches) ? POS_OVERVIEW.branches : [];
    const blockedIds = new Set((POS_OVERVIEW?.blockedBranchIds || []).map(Number));
    const cashierBranchId = isCashierUser() ? String(ME?.branchId || '') : '';

    // Si el cajero tiene su sucursal bloqueada por otra caja, avísalo
    if (isCashierUser() && ME?.branchId && blockedIds.has(Number(ME.branchId))) {
      el.style.display = 'block';
      el.innerHTML = `
        <h3><i class="ph-bold ph-lock-key-open"></i> Apertura de caja</h3>
        <div class="hint" style="color:var(--red);background:var(--red-soft);border-radius:10px;padding:12px">
          <i class="ph-bold ph-warning"></i>
          La sucursal <b>${esc(ME.branchName || '')}</b> ya tiene una caja abierta por otro usuario.
          Contacta al administrador para cerrarla antes de operar.
        </div>`;
      return;
    }

    const branchField = branches.length
      ? isCashierUser()
        ? `
          <div class="field">
            <label><i class="ph-bold ph-storefront"></i> Sucursal asignada</label>
            <input type="text" value="${esc(ME?.branchName || 'Sucursal asignada')}" disabled />
            <input type="hidden" id="posBranchSelect" value="${esc(cashierBranchId)}" />
          </div>`
        : `
          <div class="field">
            <label><i class="ph-bold ph-storefront"></i> Sucursal</label>
            <select id="posBranchSelect">
              <option value="">Selecciona una sucursal</option>
              ${branches.map((branch) => {
                const blocked = blockedIds.has(Number(branch.id));
                return `<option value="${esc(String(branch.id))}" ${blocked ? 'disabled' : ''}>${esc(branch.name)}${blocked ? ' — caja abierta' : ''}</option>`;
              }).join('')}
            </select>
            ${blockedIds.size ? `<div class="hint" style="margin-top:4px"><i class="ph ph-info"></i> Las sucursales marcadas tienen caja abierta por un cajero y no están disponibles.</div>` : ''}
          </div>`
      : '<div class="hint" style="margin-bottom:12px">No hay sucursales activas configuradas. La caja operará como general.</div>';
    el.style.display = 'block';
    el.innerHTML = `
      <h3><i class="ph-bold ph-lock-key-open"></i> Apertura de caja</h3>
      <p class="hint" style="margin:-8px 0 18px">Abre una caja para empezar a registrar ventas, ingresos, retiros y gastos del turno.</p>
      <form id="posOpenForm">
        ${branchField}
        <div class="row-2">
          <div class="field">
            <label><i class="ph-bold ph-wallet"></i> Fondo inicial</label>
            <input type="number" id="posOpeningAmount" min="0" step="0.01" value="0" />
          </div>
          <div class="field">
            <label><i class="ph-bold ph-note-pencil"></i> Nota</label>
            <input type="text" id="posOpeningNote" placeholder="Caja turno mañana" />
          </div>
        </div>
        <button class="btn btn-primary" type="submit"><i class="ph-bold ph-play"></i> Abrir caja</button>
      </form>`;
    $('#posOpenForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/pos/session/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            branchId: Number($('#posBranchSelect')?.value || 0) || null,
            openingAmount: Number($('#posOpeningAmount').value || 0),
            notes: $('#posOpeningNote').value,
          }),
        });
        toast('Caja abierta correctamente');
        await loadPos();
      } catch (err) {
        toast(err.message, true);
      }
    });
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <div class="pos-session-active">
      <h3><i class="ph-bold ph-storefront"></i> Caja activa</h3>
      <div class="hint">${session.branch_name ? `Sucursal: ${esc(session.branch_name)}` : 'Sucursal general'} · Abierta por ${esc(session.opened_by || '—')}</div>
    </div>`;
}

function renderPosCatalog() {
  const cats = POS_OVERVIEW?.categories || [];
  const products = getVisiblePosProducts();
  $('#posCatChips').innerHTML = [
    `<button class="${POS_CATEGORY_FILTER === 'all' ? 'on' : ''}" data-pos-cat="all">Todos</button>`,
    ...cats.map((cat) => `<button class="${POS_CATEGORY_FILTER === String(cat.id) ? 'on' : ''}" data-pos-cat="${cat.id}">${esc(cat.name)}</button>`),
    `<button class="${POS_CATEGORY_FILTER === 'none' ? 'on' : ''}" data-pos-cat="none">Sin categoría</button>`,
  ].join('');
  document.querySelectorAll('[data-pos-cat]').forEach((button) =>
    button.addEventListener('click', () => {
      POS_CATEGORY_FILTER = button.dataset.posCat;
      renderPosCatalog();
    })
  );
  $('#posProductGrid').innerHTML = products.length
    ? products
        .map(
          (product) => `<button class="pos-prod" type="button" data-pos-product="${product.id}">
            <div class="pos-prod-media">${product.image ? `<img src="${esc(product.image)}" alt="" />` : '<i class="ph ph-fork-knife"></i>'}</div>
            <div class="pos-prod-body">
              <span class="pos-prod-cat">${esc(product.category_name || 'Sin categoría')}</span>
              <b>${esc(product.name)}</b>
              <small>${esc(product.description || 'Producto listo para venta mostrador')}</small>
            </div>
            <span class="pos-prod-price">${fmtMoney(product.price)}</span>
          </button>`
        )
        .join('')
    : emptyHTML('ph-storefront', 'Sin productos activos', 'Activa productos en tu catálogo para cobrarlos aquí.');
  document.querySelectorAll('[data-pos-product]').forEach((button) =>
    button.addEventListener('click', () => addPosProduct(button.dataset.posProduct))
  );
}

function renderPosCart() {
  const el = $('#posCartCard');
  const total = posGrandTotal();
  const subtotalItems = posCartTotal();
  const deliveryFeeAmt = POS_IS_DELIVERY ? moneyNum(Number(POS_DELIVERY_FEE) || 0) : 0;
  const session = POS_OVERVIEW?.activeSession;
  setPosPaymentDefaults();
  const methodButtons = ['cash', 'card', 'transfer', 'mixed']
    .map((method) => `<button type="button" class="${POS_PAYMENT_METHOD === method ? 'on' : ''}" data-pos-method="${method}">${posMethodLabel(method)}</button>`)
    .join('');
  const cashField = POS_PAYMENT_METHOD === 'cash'
    ? `
      <div class="field">
        <label><i class="ph-bold ph-money"></i> Efectivo recibido</label>
        <input type="number" id="posCashReceived" step="0.01" min="0" value="${esc(POS_PAYMENT_FORM.cashReceived || String(total || ''))}" />
        <div class="hint" id="posChangeHint">Cambio estimado: ${fmtMoney(Math.max(moneyNum(POS_PAYMENT_FORM.cashReceived || total) - total, 0))}</div>
      </div>`
    : '';
  const mixedFields = POS_PAYMENT_METHOD === 'mixed'
    ? `
      <div class="row-2">
        <div class="field"><label><i class="ph-bold ph-money"></i> Efectivo</label><input type="number" id="posMixCash" step="0.01" min="0" value="${esc(POS_PAYMENT_FORM.cash || '')}" /></div>
        <div class="field"><label><i class="ph-bold ph-credit-card"></i> Tarjeta</label><input type="number" id="posMixCard" step="0.01" min="0" value="${esc(POS_PAYMENT_FORM.card || '')}" /></div>
      </div>
      <div class="row-2">
        <div class="field"><label><i class="ph-bold ph-arrow-u-up-left"></i> Transferencia</label><input type="number" id="posMixTransfer" step="0.01" min="0" value="${esc(POS_PAYMENT_FORM.transfer || '')}" /></div>
        <div class="field"><label><i class="ph-bold ph-hand-coins"></i> Cambio efectivo</label><input type="number" id="posCashReceived" step="0.01" min="0" value="${esc(POS_PAYMENT_FORM.cashReceived || '')}" placeholder="Efectivo recibido" /></div>
      </div>
      <div class="hint" id="posMixedHint" style="margin-top:-6px;margin-bottom:12px">La suma de los tres medios debe ser igual a ${fmtMoney(total)}.</div>`
    : '';
  const mixedSum = moneyNum(Number(POS_PAYMENT_FORM.cash || 0) + Number(POS_PAYMENT_FORM.card || 0) + Number(POS_PAYMENT_FORM.transfer || 0));
  const mixedValid = POS_PAYMENT_METHOD !== 'mixed' || Math.abs(mixedSum - total) < 0.01;
  const submitDisabled = session && mixedValid ? '' : 'disabled';
  const sessionHint = session ? '' : '<div class="hint" style="margin-top:10px">Abre una caja para poder finalizar ventas.</div>';
  const cartHtml = POS_CART.length
    ? `<div class="pos-cart-list">
        ${POS_CART.map((item) => {
          const ck = item._cartKey ? `data-cart-key="${esc(item._cartKey)}"` : '';
          const pid = `data-pos-dec="${item.id}" data-cart-key="${esc(item._cartKey||'')}"`;
          return `
          <div class="pos-cart-item">
            <div>
              <b>${esc(item.name)}</b>
              <small>${fmtMoney(item.price)} c/u</small>
            </div>
            <div class="pos-cart-actions">
              <button type="button" class="btn btn-ghost btn-icon pos-dec-btn" data-pid="${item.id}" ${ck}><i class="ph-bold ph-minus"></i></button>
              <span>${item.qty}</span>
              <button type="button" class="btn btn-ghost btn-icon pos-inc-btn" data-pid="${item.id}" ${ck}><i class="ph-bold ph-plus"></i></button>
            </div>
          </div>`;
        }).join('')}
      </div>
      ${POS_IS_DELIVERY && deliveryFeeAmt > 0
        ? `<div class="pos-total-line pos-subtotal-line"><span>Subtotal</span><b>${fmtMoney(subtotalItems)}</b></div>
           <div class="pos-total-line pos-delivery-fee-line"><i class="ph-bold ph-moped"></i><span>Envío</span><b>+ ${fmtMoney(deliveryFeeAmt)}</b></div>
           <div class="pos-total-line"><span>Total</span><b>${fmtMoney(total)}</b></div>`
        : `<div class="pos-total-line"><span>Total</span><b>${fmtMoney(total)}</b></div>`}
      <form id="posCheckoutForm">
        <div class="field">
          <label><i class="ph-bold ph-credit-card"></i> Medio de pago</label>
          <div class="segmented pos-pay-methods">${methodButtons}</div>
        </div>
        ${cashField}
        ${mixedFields}
        <div class="toggle-row pos-delivery-toggle">
          <div class="t-info"><i class="ph-bold ph-moped"></i><div><b>Entrega a domicilio</b><span>Cobra envío y registra el pedido como domicilio</span></div></div>
          <label class="switch"><input type="checkbox" id="posDeliveryToggle" ${POS_IS_DELIVERY ? 'checked' : ''} /><span class="track"></span></label>
        </div>
        ${POS_IS_DELIVERY ? `<div class="field">
          <label><i class="ph-bold ph-currency-circle-dollar"></i> Costo de envío</label>
          <input type="number" id="posDeliveryFee" step="0.01" min="0" value="${esc(String(POS_DELIVERY_FEE || ''))}" placeholder="0.00" />
          <div class="hint">Se suma al total y suma al turno en el rubro domicilios.</div>
        </div>` : ''}
        <div class="field">
          <label><i class="ph-bold ph-note"></i> Nota de venta</label>
          <textarea id="posSaleNotes" rows="2" placeholder="${POS_IS_DELIVERY ? 'Dirección, referencia de entrega...' : 'Mesa 4, venta rápida, pedido interno...'}">${esc(POS_PAYMENT_FORM.notes || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" type="submit" ${submitDisabled}><i class="ph-bold ph-check-circle"></i> Cobrar venta</button>
          <button class="btn btn-ghost" type="button" id="posClearCart"><i class="ph-bold ph-broom"></i> Vaciar ticket</button>
          <button class="btn btn-ghost" type="button" id="posPrintTicket"><i class="ph-bold ph-printer"></i> Imprimir ticket</button>
        </div>
        ${sessionHint}
      </form>`
    : emptyHTML('ph-shopping-cart', 'Sin productos en el ticket', 'Toca productos del catálogo para agregarlos a la venta.');
  el.innerHTML = `
    <h3><i class="ph-bold ph-shopping-cart"></i> Ticket actual</h3>
    ${cartHtml}`;

  document.querySelectorAll('.pos-dec-btn').forEach((button) => button.addEventListener('click', () => updatePosQty(button.dataset.pid, -1, button.dataset.cartKey || null)));
  document.querySelectorAll('.pos-inc-btn').forEach((button) => button.addEventListener('click', () => updatePosQty(button.dataset.pid, 1, button.dataset.cartKey || null)));
  document.querySelectorAll('[data-pos-method]').forEach((button) =>
    button.addEventListener('click', () => {
      POS_PAYMENT_METHOD = button.dataset.posMethod;
      if (POS_PAYMENT_METHOD === 'cash' && (POS_PAYMENT_FORM.cashReceived === '' || POS_PAYMENT_FORM.cashReceived === null)) {
        POS_PAYMENT_FORM.cashReceived = String(total || '');
      }
      renderPosCart();
    })
  );
  $('#posClearCart')?.addEventListener('click', clearPosCart);
  $('#posPrintTicket')?.addEventListener('click', printPosTicket);
  $('#posCashReceived')?.addEventListener('input', (e) => {
    POS_PAYMENT_FORM.cashReceived = e.target.value;
    updatePosChangeHint();
  });
  $('#posMixCash')?.addEventListener('input', (e) => {
    POS_PAYMENT_FORM.cash = e.target.value;
    updatePosChangeHint();
    updatePosMixedHint();
  });
  $('#posMixCard')?.addEventListener('input', (e) => {
    POS_PAYMENT_FORM.card = e.target.value;
    updatePosMixedHint();
  });
  $('#posMixTransfer')?.addEventListener('input', (e) => {
    POS_PAYMENT_FORM.transfer = e.target.value;
    updatePosMixedHint();
  });
  $('#posSaleNotes')?.addEventListener('input', (e) => (POS_PAYMENT_FORM.notes = e.target.value));
  $('#posDeliveryToggle')?.addEventListener('change', (e) => {
    POS_IS_DELIVERY = e.target.checked;
    if (!POS_IS_DELIVERY) POS_DELIVERY_FEE = '';
    setPosPaymentDefaults();
    renderPosCart();
  });
  $('#posDeliveryFee')?.addEventListener('input', (e) => {
    POS_DELIVERY_FEE = e.target.value;
    if (POS_PAYMENT_METHOD === 'cash') {
      const newTotal = posGrandTotal();
      const cashInput = $('#posCashReceived');
      if (cashInput && moneyNum(cashInput.value) < newTotal) {
        cashInput.value = String(newTotal);
        POS_PAYMENT_FORM.cashReceived = String(newTotal);
      }
    }
    updatePosChangeHint();
    updatePosMixedHint();
  });
  updatePosChangeHint();
  updatePosMixedHint();
  $('#posCheckoutForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        items: POS_CART.map((item) => ({
          productId: item.id,
          qty: item.qty,
          name: item.name,
          price: Number(item.price),
          cartKey: item._cartKey || null,
          variantId: item.variantId || null,
          variantName: item.variantName || null,
          modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
          modifiersLabel: item.modifiersLabel || '',
          modifiersExtraPrice: Number(item.modifiersExtraPrice || 0),
        })),
        paymentMethod: POS_PAYMENT_METHOD,
        payments: {
          cash: Number($('#posMixCash')?.value || 0),
          card: Number($('#posMixCard')?.value || 0),
          transfer: Number($('#posMixTransfer')?.value || 0),
        },
        cashReceived: Number($('#posCashReceived')?.value || 0),
        notes: $('#posSaleNotes')?.value || '',
        isDelivery: POS_IS_DELIVERY,
        deliveryFee: POS_IS_DELIVERY ? Number($('#posDeliveryFee')?.value || 0) : 0,
      };
      const result = await api('/api/pos/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      LAST_POS_SALE = result?.sale || null;
      toast('Venta registrada en punto de venta');
      clearPosCart();
      setTimeout(() => {
        if (LAST_POS_SALE) printPosTicket();
      }, 100);
      await loadPos();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function renderPosMovements() {
  return null;
}

function renderPosClosings() {
  return null;
}

function getLocalIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function syncPosSalesFilterUI() {
  document.querySelectorAll('#posSalesFilters [data-sales-filter]').forEach((button) => {
    button.classList.toggle('on', button.dataset.salesFilter === POS_SALES_FILTER);
  });
  const customWrap = $('#posSalesCustomRange');
  if (customWrap) customWrap.style.display = POS_SALES_FILTER === 'custom' ? 'grid' : 'none';
  if ($('#posSalesStartDate')) $('#posSalesStartDate').value = POS_SALES_START_DATE || '';
  if ($('#posSalesEndDate')) $('#posSalesEndDate').value = POS_SALES_END_DATE || '';
}

async function loadPosSalesHistory(page = 1) {
  const safePage = Math.max(1, Number(page) || 1);
  if (POS_SALES_FILTER === 'custom') {
    if (!POS_SALES_START_DATE || !POS_SALES_END_DATE) {
      throw new Error('Selecciona fecha inicial y final para buscar por rango');
    }
    if (POS_SALES_START_DATE > POS_SALES_END_DATE) {
      throw new Error('La fecha inicial no puede ser mayor que la fecha final');
    }
  }
  const query = new URLSearchParams({
    page: String(safePage),
    pageSize: String(POS_SALES_PAGE_SIZE),
    filter: POS_SALES_FILTER,
  });
  if (POS_SALES_FILTER === 'custom') {
    query.set('startDate', POS_SALES_START_DATE);
    query.set('endDate', POS_SALES_END_DATE);
  }
  const data = await api(`/api/pos/sales-history?${query.toString()}`);
  POS_SALES_PAGE = Number(data.page || safePage);
  POS_SALES_TOTAL_PAGES = Math.max(1, Number(data.totalPages || 1));
  POS_SALES_HISTORY_CACHE = Array.isArray(data.rows) ? data.rows : [];

  const table = $('#posSalesHistoryTable');
  if (!table) return;
  table.innerHTML = POS_SALES_HISTORY_CACHE.length
    ? `<table><thead><tr><th>Ticket</th><th>Productos</th><th>Pago</th><th>Total</th><th>Estado</th><th>Nota</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>${POS_SALES_HISTORY_CACHE
        .map((row) => {
          const paymentBreakdown = row.payment_breakdown
            ? Object.entries(row.payment_breakdown)
                .filter(([, amount]) => Number(amount) > 0)
                .map(([method, amount]) => `${posMethodLabel(method)} ${fmtMoney(amount)}`)
                .join(' · ')
            : posMethodLabel(row.payment_method);
          const noteText = String(row.notes || '').trim();
          const isCanceled = row.status === 'cancelado';
          return `<tr>
            <td><b>#${row.id}</b></td>
            <td>${esc(row.items.map((item) => `${item.qty}x ${item.name}`).join(', '))}</td>
            <td><div><b>${esc(posMethodLabel(row.payment_method))}</b></div><div style="font-size:12px;color:var(--ink-3)">${esc(paymentBreakdown)}</div></td>
            <td><b>${fmtMoney(row.total)}</b>${row.cash_change ? `<div style="font-size:12px;color:var(--ink-3)">Cambio ${fmtMoney(row.cash_change)}</div>` : ''}</td>
            <td>${posSaleStatusBadge(row.status)}</td>
            <td style="max-width:220px;white-space:normal;line-height:1.4">${noteText ? esc(noteText) : '<span style="color:var(--ink-3)">—</span>'}</td>
            <td>${esc(row.created_at || '')}</td>
            <td>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button type="button" class="btn btn-ghost" data-print-pos-sale="${row.id}"><i class="ph-bold ph-printer"></i> Ticket</button>
                <button type="button" class="btn btn-ghost" data-edit-pos-payment="${row.id}" ${isCanceled ? 'disabled' : ''}><i class="ph-bold ph-credit-card"></i> Pago</button>
                <button type="button" class="btn btn-danger" data-cancel-pos-sale="${row.id}" ${isCanceled ? 'disabled' : ''}><i class="ph-bold ph-x-circle"></i> Cancelar</button>
              </div>
            </td>
          </tr>`;
        })
        .join('')}</tbody></table>`
    : emptyHTML('ph-receipt', 'Sin ventas POS', 'Aún no hay ventas registradas en el punto de venta.');

  document.querySelectorAll('[data-print-pos-sale]').forEach((button) =>
    button.addEventListener('click', () => printPosSaleById(button.dataset.printPosSale))
  );
  document.querySelectorAll('[data-edit-pos-payment]').forEach((button) =>
    button.addEventListener('click', () => openPosPaymentEditModal(button.dataset.editPosPayment))
  );
  document.querySelectorAll('[data-cancel-pos-sale]').forEach((button) =>
    button.addEventListener('click', () => openPosCancelSaleModal(button.dataset.cancelPosSale))
  );

  $('#posSalesHistoryPageInfo').textContent = `Página ${POS_SALES_PAGE} de ${POS_SALES_TOTAL_PAGES} · ${Number(data.total || 0)} ventas`;
  $('#posSalesPrevPage').disabled = POS_SALES_PAGE <= 1;
  $('#posSalesNextPage').disabled = POS_SALES_PAGE >= POS_SALES_TOTAL_PAGES;
}

function openPosSalesHistoryModal() {
  const today = getLocalIsoDate();
  POS_SALES_FILTER = 'today';
  POS_SALES_START_DATE = today;
  POS_SALES_END_DATE = today;
  syncPosSalesFilterUI();
  $('#posSalesHistoryModal').classList.add('show');
  loadPosSalesHistory(1).catch((err) => toast(err.message, true));
}

function chatbotOrderStatusBadge(status) {
  const st = String(status || '').toLowerCase();
  if (st === 'confirmado') return '<span class="badge b-confirmado">Confirmado</span>';
  if (st === 'preparando') return '<span class="badge b-preparando">Preparando</span>';
  if (st === 'enviado') return '<span class="badge b-enviado">Enviado</span>';
  return '<span class="badge b-pendiente">Pendiente</span>';
}

function chatbotDeliveryLabel(order) {
  if (order.delivery === 'domicilio') return 'Domicilio';
  return `Recoger${order.pickup_branch_name ? ` (${order.pickup_branch_name})` : ''}`;
}

function chatbotChargeStatusBadge(orderId) {
  if (POS_CHATBOT_IMPORTING.has(Number(orderId))) {
    return '<span class="badge b-charge-processing"><i class="ph-bold ph-spinner"></i> En proceso</span>';
  }
  return '<span class="badge b-charge-available"><i class="ph-bold ph-check-circle"></i> Disponible</span>';
}

function isCompactChatbotQueueView() {
  return window.matchMedia('(max-width: 760px)').matches;
}

async function loadPosChatbotQueue(page = 1) {
  const safePage = Math.max(1, Number(page) || 1);
  const data = await api(`/api/pos/chatbot-orders?page=${safePage}`);
  POS_CHATBOT_QUEUE = Array.isArray(data.rows) ? data.rows : [];
  POS_CHATBOT_PAGE = Math.max(1, Number(data.page || safePage));
  POS_CHATBOT_TOTAL_PAGES = Math.max(1, Number(data.totalPages || 1));
  const table = $('#posChatbotQueueTable');
  const info = $('#posChatbotQueueInfo');
  if (!table || !info) return;
  table.style.display = 'block';
  table.style.width = '100%';
  table.style.maxWidth = '100%';
  table.style.overflowX = 'auto';
  table.style.overflowY = 'auto';
  table.style.webkitOverflowScrolling = 'touch';

  if (!POS_CHATBOT_QUEUE.length) {
    table.innerHTML = emptyHTML('ph-chat-circle-dots', 'Sin pedidos chatbot por importar hoy', `Aquí se muestran solo pedidos del día de operación${data.sessionBranchName ? ` de la sucursal ${data.sessionBranchName}` : ''} para cobrarlos en caja.`);
    info.textContent = `Página ${POS_CHATBOT_PAGE} de ${POS_CHATBOT_TOTAL_PAGES} · ${Number(data.total || 0)} pedidos`;
    const prev = $('#posChatbotQueuePrev');
    const next = $('#posChatbotQueueNext');
    if (prev) prev.disabled = POS_CHATBOT_PAGE <= 1;
    if (next) next.disabled = POS_CHATBOT_PAGE >= POS_CHATBOT_TOTAL_PAGES;
    return;
  }

  if (isCompactChatbotQueueView()) {
    table.innerHTML = `<div class="pos-chatbot-cards">${POS_CHATBOT_QUEUE
      .map((order) => {
        const items = (order.items || []).map((it) => `${it.qty}x ${it.name}`).join(', ');
        const isImporting = POS_CHATBOT_IMPORTING.has(Number(order.id));
        const locationText = order.customer_location_text || order.customer_location_resolved || '—';
        const noteText = order.notes || '—';
        return `<article class="pos-chatbot-card">
          <div class="pos-chatbot-card-head">
            <b>#${order.id}</b>
            <div>${chatbotChargeStatusBadge(order.id)}</div>
          </div>
          <div class="pos-chatbot-card-meta">
            <div class="pos-chatbot-kv"><span>Cliente</span><div><b>${esc(order.customer_name || 'Cliente')}</b><br>${esc(order.customer_phone || '—')}</div></div>
            <div class="pos-chatbot-kv"><span>Total</span><b>${fmtMoney(order.total)}</b></div>
            <div class="pos-chatbot-kv"><span>Entrega</span><div>${esc(chatbotDeliveryLabel(order))}<br><small style="color:var(--ink-3)">${esc(locationText)}</small></div></div>
            <div class="pos-chatbot-kv"><span>Pago</span><b>${esc(posMethodLabel(order.payment_method || 'cash'))}</b></div>
            <div class="pos-chatbot-kv"><span>Productos</span><div>${esc(items || '—')}</div></div>
            <div class="pos-chatbot-kv"><span>Estado</span><div>${chatbotOrderStatusBadge(order.status)}</div></div>
            <div class="pos-chatbot-kv"><span>Fecha</span><div>${esc(order.created_at || '')}</div></div>
            <div class="pos-chatbot-kv"><span>Nota</span><div>${esc(noteText)}</div></div>
          </div>
          <button type="button" class="btn-pos-charge" data-import-chatbot-order="${order.id}" ${isImporting ? 'disabled' : ''}><i class="ph-bold ph-cash-register"></i> ${isImporting ? 'Procesando...' : 'Cobrar en POS'}</button>
        </article>`;
      })
      .join('')}</div>`;
  } else {
    table.innerHTML = `<table class="pos-chatbot-table" style="width:1580px;min-width:1580px;table-layout:fixed"><thead><tr><th class="th-pedido">Pedido</th><th class="th-action">Cobrar</th><th class="th-cliente">Cliente</th><th class="th-productos">Productos</th><th class="th-entrega">Entrega</th><th class="th-pago">Pago</th><th class="th-total">Total</th><th class="th-estado">Estado</th><th class="th-fecha">Fecha</th><th class="th-cobro">Cobro</th></tr></thead><tbody>${POS_CHATBOT_QUEUE
      .map((order) => {
        const items = (order.items || []).map((it) => `${it.qty}x ${it.name}`).join(', ');
        const isImporting = POS_CHATBOT_IMPORTING.has(Number(order.id));
        const locationLine = order.customer_location_text
          ? `<div style="font-size:12px;color:var(--ink-3)">${esc(order.customer_location_text)}</div>`
          : (order.customer_location_resolved ? `<div style="font-size:12px;color:var(--ink-3)">${esc(order.customer_location_resolved)}</div>` : '');
        const noteLine = order.notes
          ? `<div style="font-size:12px;color:var(--ink-3);margin-top:4px">Nota: ${esc(order.notes)}</div>`
          : '';
        return `<tr>
          <td class="td-pedido"><b>#${order.id}</b></td>
          <td class="td-action"><button type="button" class="btn-pos-charge" data-import-chatbot-order="${order.id}" ${isImporting ? 'disabled' : ''}><i class="ph-bold ph-cash-register"></i> ${isImporting ? 'Procesando...' : 'Cobrar en POS'}</button></td>
          <td class="td-cliente"><b>${esc(order.customer_name || 'Cliente')}</b><div style="font-size:12px;color:var(--ink-3)">${esc(order.customer_phone || '—')}</div></td>
          <td class="td-productos">${esc(items || '—')}</td>
          <td class="td-entrega">${esc(chatbotDeliveryLabel(order))}${locationLine}${noteLine}</td>
          <td class="td-pago">${esc(posMethodLabel(order.payment_method || 'cash'))}</td>
          <td class="td-total"><b>${fmtMoney(order.total)}</b></td>
          <td class="td-estado">${chatbotOrderStatusBadge(order.status)}</td>
          <td class="td-fecha">${esc(order.created_at || '')}</td>
          <td class="td-cobro">${chatbotChargeStatusBadge(order.id)}</td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
  }
  info.textContent = `Página ${POS_CHATBOT_PAGE} de ${POS_CHATBOT_TOTAL_PAGES} · ${Number(data.total || 0)} pedidos${data.sessionBranchName ? ` · ${data.sessionBranchName}` : ''}`;
  table.scrollLeft = 0;
  const prev = $('#posChatbotQueuePrev');
  const next = $('#posChatbotQueueNext');
  if (prev) prev.disabled = POS_CHATBOT_PAGE <= 1;
  if (next) next.disabled = POS_CHATBOT_PAGE >= POS_CHATBOT_TOTAL_PAGES;

  document.querySelectorAll('[data-import-chatbot-order]').forEach((button) => {
    button.addEventListener('click', () => importChatbotOrderToPos(button.dataset.importChatbotOrder));
  });
}

async function importChatbotOrderToPos(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (POS_CHATBOT_IMPORTING.has(id)) return;
  const ok = await askConfirm(
    '¿Pasar pedido a caja?',
    `El pedido #${id} se convertirá en venta POS para cobrar ticket y sumarse al cierre.`,
    { yesLabel: 'Pasar a caja', noLabel: 'Cancelar' }
  );
  if (!ok) return;

  try {
    POS_CHATBOT_IMPORTING.add(id);
    await loadPosChatbotQueue(POS_CHATBOT_PAGE);
    const result = await api(`/api/pos/chatbot-orders/${id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const sale = result?.sale || {};
    LAST_POS_SALE = {
      id: sale.id,
      subtotal: Number(sale.subtotal || sale.total || 0),
      deliveryFee: Number(sale.deliveryFee || sale.delivery_fee || 0),
      total: Number(sale.total || 0),
      items: Array.isArray(sale.items) ? sale.items : [],
      paymentMethod: sale.payment_method || 'cash',
      paymentBreakdown: sale.payment_breakdown || null,
      cashReceived: Number(sale.cash_received || 0),
      cashChange: Number(sale.cash_change || 0),
      notes: String(sale.notes || ''),
    };
    toast(`Pedido #${id} integrado a caja`);
    await loadPos();
    await loadPosChatbotQueue(POS_CHATBOT_PAGE);
    if (!POS_CHATBOT_QUEUE.length && POS_CHATBOT_PAGE > 1) {
      await loadPosChatbotQueue(POS_CHATBOT_PAGE - 1);
    }
    setTimeout(() => {
      if (LAST_POS_SALE?.id) printPosTicket();
    }, 120);
  } catch (err) {
    toast(err.message, true);
  } finally {
    POS_CHATBOT_IMPORTING.delete(id);
  }
}

function openPosChatbotQueueModal() {
  const hasSession = Boolean(POS_OVERVIEW?.activeSession);
  if (!hasSession) return toast('Abre una caja para importar pedidos chatbot', true);
  POS_CHATBOT_PAGE = 1;
  $('#posChatbotQueueModal').classList.add('show');
  loadPosChatbotQueue(POS_CHATBOT_PAGE).catch((err) => toast(err.message, true));
}

function renderLastCloseHint() {
  const last = POS_OVERVIEW?.lastClosedSession;
  const hint = $('#posLastCloseHint');
  if (!hint) return;
  if (!last) {
    hint.textContent = 'Sin cierres anteriores todavía.';
    return;
  }
  hint.textContent = `Último cierre: ${last.closed_at || '—'} · Diferencia ${fmtMoney(last.difference_amount || 0)} · ${last.notes || 'Sin notas.'}`;
}

function openPosMovementModal() {
  const session = POS_OVERVIEW?.activeSession;
  if (!session) return toast('Abre una caja para registrar movimientos', true);
  const rows = POS_OVERVIEW?.recentMovements || [];
  const incomes = rows.filter((row) => row.kind === 'income');
  const outflows = rows.filter((row) => row.kind === 'withdrawal' || row.kind === 'expense');
  const incomeTotal = incomes.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const outflowTotal = outflows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const renderGroupTable = (groupRows) =>
    groupRows.length
      ? `<table><thead><tr><th>Tipo</th><th>Monto</th><th>Nota</th><th>Hora</th></tr></thead><tbody>${groupRows.map((row) => `<tr><td>${esc(posMovementLabel(row.kind))}</td><td><b>${fmtMoney(row.amount)}</b></td><td>${esc(row.note || '—')}</td><td>${esc(row.created_at || '')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="hint" style="margin:0">Sin movimientos registrados en este grupo.</div>';

  $('#posMovementHistory').innerHTML = rows.length
    ? `
      <div class="pos-movement-groups">
        <div class="pos-movement-group income">
          <div class="pos-movement-group-head">
            <div><i class="ph-bold ph-trend-up"></i> Ingresos</div>
            <b>${fmtMoney(incomeTotal)}</b>
          </div>
          ${renderGroupTable(incomes)}
        </div>
        <div class="pos-movement-group outflow">
          <div class="pos-movement-group-head">
            <div><i class="ph-bold ph-arrow-bend-up-left"></i> Gastos y retiros</div>
            <b>${fmtMoney(outflowTotal)}</b>
          </div>
          ${renderGroupTable(outflows)}
        </div>
      </div>`
    : emptyHTML('ph-receipt', 'Sin movimientos', 'Todavía no registras ingresos, retiros ni gastos en esta caja.');
  $('#posMovementAmountModal').value = '';
  $('#posMovementNoteModal').value = '';
  $('#posMovementKindModal').value = 'income';
  document.querySelectorAll('#posMovementKinds [data-kind]').forEach((button) => {
    button.classList.toggle('on', button.dataset.kind === 'income');
  });
  renderPosMovementKindHint('income');
  $('#posMovementModal').classList.add('show');
}

function openPosCloseModal() {
  const session = POS_OVERVIEW?.activeSession;
  if (!session) return toast('No hay caja abierta para cerrar', true);
  const totals = session.totals || {
    totalSales: 0,
    collected: { cash: 0, card: 0, transfer: 0 },
    movements: { income: 0, withdrawal: 0, expense: 0 },
    cancellations: { tickets: 0, total: 0 },
    tickets: 0,
  };
  const delivery = totals.delivery || { tickets: 0, total: 0, fees: 0 };
  $('#posCloseSummary').innerHTML = `
    <div class="pos-close-groups">
      <div class="pos-close-group neutral">
        <h4><i class="ph-bold ph-info"></i> Datos del turno</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-ink"><span>Fondo inicial</span><b>${fmtMoney(session.opening_amount || 0)}</b></div>
          <div class="pos-mini-stat tone-blue"><span>Ventas del turno</span><b>${fmtMoney(totals.totalSales || 0)}</b></div>
          <div class="pos-mini-stat tone-green"><span>Efectivo esperado</span><b>${fmtMoney(session.expectedCash || 0)}</b></div>
          <div class="pos-mini-stat tone-violet"><span>Tickets</span><b>${Number(totals.tickets || 0)}</b></div>
          <div class="pos-mini-stat tone-ink"><span>Abierta por</span><b>${esc(session.opened_by || '—')}</b></div>
        </div>
      </div>
      <div class="pos-close-group payment">
        <h4><i class="ph-bold ph-credit-card"></i> Ventas por medio de pago</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-green"><span>Efectivo</span><b>${fmtMoney(totals.salesByMethod?.cash || 0)}</b></div>
          <div class="pos-mini-stat tone-violet"><span>Tarjeta</span><b>${fmtMoney(totals.salesByMethod?.card || 0)}</b></div>
          <div class="pos-mini-stat tone-cyan"><span>Transferencia</span><b>${fmtMoney(totals.salesByMethod?.transfer || 0)}</b></div>
          <div class="pos-mini-stat tone-amber"><span>Mixto</span><b>${fmtMoney(totals.salesByMethod?.mixed || 0)}</b></div>
        </div>
      </div>
      <div class="pos-close-group delivery">
        <h4><i class="ph-bold ph-moped"></i> Servicio a domicilio</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-cyan"><span>Pedidos domicilio</span><b>${Number(delivery.tickets || 0)}</b></div>
          <div class="pos-mini-stat tone-blue"><span>Total domicilio</span><b>${fmtMoney(delivery.total || 0)}</b></div>
          <div class="pos-mini-stat tone-green"><span>Costo envíos</span><b>${fmtMoney(delivery.fees || 0)}</b></div>
          <div class="pos-mini-stat tone-ink"><span>Cobrado efectivo</span><b>${fmtMoney(totals.collected?.cash || 0)}</b></div>
        </div>
      </div>
      <div class="pos-close-group income">
        <h4><i class="ph-bold ph-trend-up"></i> Entradas</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-green"><span>Ingreso manual</span><b>${fmtMoney(totals.movements.income || 0)}</b></div>
        </div>
      </div>
      <div class="pos-close-group outflow">
        <h4><i class="ph-bold ph-arrow-bend-up-left"></i> Salidas</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-amber"><span>Retiros</span><b>${fmtMoney(totals.movements.withdrawal || 0)}</b></div>
          <div class="pos-mini-stat tone-red"><span>Gastos</span><b>${fmtMoney(totals.movements.expense || 0)}</b></div>
        </div>
      </div>
      <div class="pos-close-group cancel">
        <h4><i class="ph-bold ph-x-circle"></i> Cancelaciones</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-red"><span>Tickets cancelados</span><b>${Number(totals.cancellations.tickets || 0)}</b></div>
          <div class="pos-mini-stat tone-red"><span>Total cancelado</span><b>${fmtMoney(totals.cancellations.total || 0)}</b></div>
        </div>
      </div>
    </div>
  `;
  $('#posClosingAmountModal').value = moneyNum(session.expectedCash || 0);
  $('#posClosingNoteModal').value = '';
  renderLastCloseHint();
  $('#posCloseModal').classList.add('show');
}

$('#posMovementKinds')?.addEventListener('click', (e) => {
  const button = e.target.closest('[data-kind]');
  if (!button) return;
  document.querySelectorAll('#posMovementKinds [data-kind]').forEach((item) => item.classList.remove('on'));
  button.classList.add('on');
  $('#posMovementKindModal').value = button.dataset.kind;
  renderPosMovementKindHint(button.dataset.kind);
});

$('#posMovementCancel')?.addEventListener('click', () => $('#posMovementModal').classList.remove('show'));
$('#posCloseCancel')?.addEventListener('click', () => $('#posCloseModal').classList.remove('show'));
$('#posSalesHistoryClose')?.addEventListener('click', () => $('#posSalesHistoryModal').classList.remove('show'));
$('#posChatbotQueueClose')?.addEventListener('click', () => $('#posChatbotQueueModal').classList.remove('show'));
$('#posChatbotQueueRefresh')?.addEventListener('click', () => {
  loadPosChatbotQueue(POS_CHATBOT_PAGE).catch((err) => toast(err.message, true));
});
$('#posChatbotQueuePrev')?.addEventListener('click', () => {
  if (POS_CHATBOT_PAGE <= 1) return;
  loadPosChatbotQueue(POS_CHATBOT_PAGE - 1).catch((err) => toast(err.message, true));
});
$('#posChatbotQueueNext')?.addEventListener('click', () => {
  if (POS_CHATBOT_PAGE >= POS_CHATBOT_TOTAL_PAGES) return;
  loadPosChatbotQueue(POS_CHATBOT_PAGE + 1).catch((err) => toast(err.message, true));
});
$('#posSalesPrevPage')?.addEventListener('click', () => {
  if (POS_SALES_PAGE <= 1) return;
  loadPosSalesHistory(POS_SALES_PAGE - 1).catch((err) => toast(err.message, true));
});
$('#posSalesNextPage')?.addEventListener('click', () => {
  if (POS_SALES_PAGE >= POS_SALES_TOTAL_PAGES) return;
  loadPosSalesHistory(POS_SALES_PAGE + 1).catch((err) => toast(err.message, true));
});

document.querySelectorAll('#posSalesFilters [data-sales-filter]').forEach((button) =>
  button.addEventListener('click', () => {
    POS_SALES_FILTER = button.dataset.salesFilter;
    syncPosSalesFilterUI();
    if (POS_SALES_FILTER !== 'custom') {
      loadPosSalesHistory(1).catch((err) => toast(err.message, true));
    }
  })
);

$('#posSalesApplyCustomRange')?.addEventListener('click', () => {
  POS_SALES_START_DATE = $('#posSalesStartDate')?.value || '';
  POS_SALES_END_DATE = $('#posSalesEndDate')?.value || '';
  loadPosSalesHistory(1).catch((err) => toast(err.message, true));
});

document.querySelectorAll('#posPaymentEditMethods [data-method]').forEach((button) =>
  button.addEventListener('click', () => setPosPaymentEditMethod(button.dataset.method))
);

$('#posPaymentEditMixCash')?.addEventListener('input', updatePosPaymentEditMixedHint);
$('#posPaymentEditMixCard')?.addEventListener('input', updatePosPaymentEditMixedHint);
$('#posPaymentEditMixTransfer')?.addEventListener('input', updatePosPaymentEditMixedHint);
$('#posPaymentEditMixCashReceived')?.addEventListener('input', updatePosPaymentEditMixedHint);

$('#posPaymentEditCancel')?.addEventListener('click', () => $('#posPaymentEditModal').classList.remove('show'));

$('#posPaymentEditForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saleId = Number($('#posPaymentEditSaleId')?.value || 0);
  if (!saleId) return toast('Venta inválida', true);
  const payload = {
    paymentMethod: POS_PAYMENT_EDIT_METHOD,
    payments: {
      cash: Number($('#posPaymentEditMixCash')?.value || 0),
      card: Number($('#posPaymentEditMixCard')?.value || 0),
      transfer: Number($('#posPaymentEditMixTransfer')?.value || 0),
    },
    cashReceived: POS_PAYMENT_EDIT_METHOD === 'mixed'
      ? Number($('#posPaymentEditMixCashReceived')?.value || 0)
      : Number($('#posPaymentEditCashReceived')?.value || 0),
  };
  try {
    await api(`/api/pos/sales/${saleId}/payment`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    $('#posPaymentEditModal').classList.remove('show');
    toast('Medio de pago actualizado');
    await loadPos();
    await loadPosSalesHistory(POS_SALES_PAGE);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#posCancelSaleForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  await submitPosCancelSale();
});

$('#posCancelSaleCancel')?.addEventListener('click', () => {
  $('#posCancelSaleModal').classList.remove('show');
});

$('#posMovementFormModal')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/pos/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: $('#posMovementKindModal').value,
        amount: Number($('#posMovementAmountModal').value || 0),
        note: $('#posMovementNoteModal').value,
      }),
    });
    toast('Movimiento registrado');
    $('#posMovementModal').classList.remove('show');
    await loadPos();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#posCloseFormModal')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const result = await api('/api/pos/session/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        closingAmount: Number($('#posClosingAmountModal').value || 0),
        notes: $('#posClosingNoteModal').value,
      }),
    });
    clearPosCart();
    $('#posCloseModal').classList.remove('show');
    toast(`Caja cerrada. Diferencia: ${fmtMoney(result.differenceAmount)}`);
    exportPosClosePdf(result);
    printPosCloseReport(result);
    await loadPos();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ===== Productos ===== */
let CATS = [];
let PRODUCTS_CACHE = [];
let PRODUCT_CAT_FILTER = 'all';
let PRODUCT_VIEW_MODE = 'card';
let PRODUCT_VIEW_SWITCH_BOUND = false;
let AI_PRODUCTS_DRAFT = [];

const PRODUCT_VIEW_MODES = new Set(['card', 'detail', 'compact']);

function productViewStorageKey() {
  return `chatbotpro:products:view:${ME?.tenant?.slug || 'default'}`;
}

function readStoredProductViewMode() {
  try {
    const saved = String(localStorage.getItem(productViewStorageKey()) || '').trim();
    return PRODUCT_VIEW_MODES.has(saved) ? saved : 'card';
  } catch {
    return 'card';
  }
}

function saveProductViewMode(mode) {
  try {
    localStorage.setItem(productViewStorageKey(), mode);
  } catch {
    // Ignore storage errors silently.
  }
}

function categoryTone(cat) {
  const seed = `${cat?.id || ''}:${cat?.name || ''}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    bg: `hsl(${hue} 90% 95%)`,
    border: `hsl(${hue} 62% 74%)`,
    ink: `hsl(${hue} 62% 36%)`,
  };
}

function bindProductViewSwitch() {
  if (PRODUCT_VIEW_SWITCH_BOUND) return;
  PRODUCT_VIEW_SWITCH_BOUND = true;
  document.querySelectorAll('[data-prod-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = String(button.dataset.prodView || 'card').trim();
      if (!PRODUCT_VIEW_MODES.has(mode)) return;
      PRODUCT_VIEW_MODE = mode;
      saveProductViewMode(mode);
      renderProductsGrid();
      renderCategoryChips();
    });
  });
}

function renderCategoryChips() {
  const host = $('#catChips');
  if (!host) return;
  const allOn = PRODUCT_CAT_FILTER === 'all';
  const totalProducts = PRODUCTS_CACHE.length;
  const chips = [
    `<button type="button" class="chip chip-cat chip-all ${allOn ? 'on' : ''}" data-cat-filter="all"><span class="chip-ic"><i class="ph-bold ph-squares-four"></i></span><span class="chip-label">Todos</span><span class="chip-count">${totalProducts}</span></button>`,
  ];
  if (CATS.length) {
    chips.push(
      ...CATS.map((cat) => {
        const tone = categoryTone(cat);
        const on = String(PRODUCT_CAT_FILTER) === String(cat.id);
        const count = PRODUCTS_CACHE.filter((p) => String(p.category_id || '') === String(cat.id)).length;
        return `<button type="button" class="chip chip-cat ${on ? 'on' : ''}" data-cat-filter="${cat.id}" style="--chip-bg:${tone.bg};--chip-border:${tone.border};--chip-ink:${tone.ink}"><span class="chip-ic"><i class="ph-bold ph-folder"></i></span><span class="chip-label">${esc(cat.name)}</span><span class="chip-count">${count}</span><span class="x" data-delcat="${cat.id}" title="Eliminar categoria"><i class="ph-bold ph-x"></i></span></button>`;
      })
    );
  }
  host.innerHTML = chips.join('');

  document.querySelectorAll('[data-cat-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      PRODUCT_CAT_FILTER = String(button.dataset.catFilter || 'all');
      renderCategoryChips();
      renderProductsGrid();
    });
  });

  document.querySelectorAll('[data-delcat]').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await askConfirm('¿Eliminar categoria?', 'Los productos de esta categoria quedaran sin categoria.'))) return;
      await api(`/api/products/categories/${a.dataset.delcat}`, { method: 'DELETE' });
      toast('Categoria eliminada');
      if (PRODUCT_CAT_FILTER === String(a.dataset.delcat)) PRODUCT_CAT_FILTER = 'all';
      loadProducts();
    })
  );

  document.querySelectorAll('[data-prod-view]').forEach((btn) => {
    const on = btn.dataset.prodView === PRODUCT_VIEW_MODE;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function renderProductsGrid() {
  const grid = $('#prodGrid');
  if (!grid) return;
  const filtered = PRODUCT_CAT_FILTER === 'all'
    ? PRODUCTS_CACHE
    : PRODUCTS_CACHE.filter((p) => String(p.category_id || '') === String(PRODUCT_CAT_FILTER));
  const visible = [...filtered];

  if (normalizePosSortMode(POS_PRODUCT_SORT) === 'alphabetical') {
    visible.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' }));
  } else {
    visible.sort((a, b) => {
      const soldDiff = Number(b.soldQty || 0) - Number(a.soldQty || 0);
      if (soldDiff !== 0) return soldDiff;
      return String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' });
    });
  }

  grid.classList.remove('view-card', 'view-detail', 'view-compact');
  grid.classList.add(`view-${PRODUCT_VIEW_MODE}`);

  const showTopBadge = normalizePosSortMode(POS_PRODUCT_SORT) === 'top_sold';
  const topBadgeHTML = (product, index) => {
    const soldQty = Number(product?.soldQty || 0);
    if (!showTopBadge || soldQty <= 0) return '';
    const rankLabel = index < 3 ? `TOP ${index + 1}` : 'TOP';
    return `<span class="prod-badge prod-badge-top"><i class="ph-bold ph-fire"></i> ${rankLabel} · ${soldQty} vend.</span>`;
  };

  if (!visible.length) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyHTML('ph-hamburger', 'Sin productos para este filtro', 'Cambia de categoria o agrega productos nuevos al menu.')}</div>`;
    return;
  }

  if (PRODUCT_VIEW_MODE === 'detail') {
    grid.innerHTML = visible
      .map(
        (p, idx) => {
          const varBadge = (p.variants?.length > 1) ? `<span class="prod-badge prod-badge-variant"><i class="ph-bold ph-stack"></i> ${p.variants.length} variantes</span>` : '';
          const modBadge = (p.modifierGroups?.length > 0) ? `<span class="prod-badge prod-badge-mod"><i class="ph-bold ph-sliders"></i> ${p.modifierGroups.length} grupo${p.modifierGroups.length > 1 ? 's' : ''}</span>` : '';
          const topBadge = topBadgeHTML(p, idx);
          return `<article class="prod-row ${p.active ? '' : 'inactive'}">
      <div class="thumb">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" />` : '<i class="ph ph-fork-knife"></i>'}
      </div>
      <div class="meta">
        <div class="top">
          <div>
            <div class="name">${esc(p.name)}</div>
            ${p.category_name ? `<div class="cat">${esc(p.category_name)}</div>` : ''}
            ${topBadge || varBadge || modBadge ? `<div class="prod-badges-row">${topBadge}${varBadge}${modBadge}</div>` : ''}
          </div>
          <span class="price-tag">${fmtMoney(p.price)}</span>
        </div>
        <div class="desc">${esc(p.description || '')}</div>
      </div>
      <div class="row-actions">
        <span class="state-dot ${p.active ? 'on' : 'off'}">${p.active ? 'ACTIVO' : 'OCULTO'}</span>
        <button class="btn btn-ghost" data-edit="${p.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button>
        <button class="btn btn-danger btn-icon" data-del="${p.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
      </div>
    </article>`;
        }
      )
      .join('');
  } else if (PRODUCT_VIEW_MODE === 'compact') {
    grid.innerHTML = visible
      .map(
        (p, idx) => {
          const extras = [];
          const topBadge = topBadgeHTML(p, idx);
          if (topBadge) extras.push(topBadge);
          if (p.variants?.length > 1) extras.push(`<span class="prod-badge prod-badge-variant"><i class="ph-bold ph-stack"></i>${p.variants.length}</span>`);
          if (p.modifierGroups?.length > 0) extras.push(`<span class="prod-badge prod-badge-mod"><i class="ph-bold ph-sliders"></i>${p.modifierGroups.length}</span>`);
          return `<article class="prod-mini ${p.active ? '' : 'inactive'}">
      <div class="mini-thumb">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" />` : '<i class="ph ph-fork-knife"></i>'}</div>
      <div class="mini-name">${esc(p.name)}${extras.length ? ` ${extras.join('')}` : ''}</div>
      <div class="mini-price">${fmtMoney(p.price)}</div>
      <div class="mini-actions">
        <button class="btn btn-ghost" data-edit="${p.id}"><i class="ph-bold ph-pencil-simple"></i></button>
        <button class="btn btn-danger btn-icon" data-del="${p.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
      </div>
    </article>`;
        }
      )
      .join('');
  } else {
    grid.innerHTML = visible
      .map(
        (p, idx) => {
          const varBadge = (p.variants?.length > 1) ? `<span class="prod-badge prod-badge-variant"><i class="ph-bold ph-stack"></i> ${p.variants.length} var.</span>` : '';
          const modBadge = (p.modifierGroups?.length > 0) ? `<span class="prod-badge prod-badge-mod"><i class="ph-bold ph-sliders"></i> ${p.modifierGroups.length} opc.</span>` : '';
          const topBadge = topBadgeHTML(p, idx);
          return `<div class="prod-card ${p.active ? '' : 'inactive'}">
      <div class="img">
        ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" />` : '<i class="ph ph-fork-knife"></i>'}
        <span class="state-dot ${p.active ? 'on' : 'off'}">${p.active ? 'ACTIVO' : 'OCULTO'}</span>
        <span class="price-tag">${fmtMoney(p.price)}</span>
      </div>
      <div class="body">
        ${p.category_name ? `<span class="cat">${esc(p.category_name)}</span>` : ''}
        <div class="name">${esc(p.name)}</div>
        <div class="desc">${esc(p.description || '')}</div>
        ${topBadge || varBadge || modBadge ? `<div class="prod-badges-row">${topBadge}${varBadge}${modBadge}</div>` : ''}
      </div>
      <div class="actions">
        <button class="btn btn-ghost" data-edit="${p.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button>
        <button class="btn btn-danger btn-icon" data-del="${p.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
      </div>
    </div>`;
        }
      )
      .join('');
  }

  document.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openProdModal(PRODUCTS_CACHE.find((p) => p.id == b.dataset.edit)))
  );
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await askConfirm('¿Eliminar producto?', 'Se quitara de tu menu y del chatbot de inmediato.'))) return;
      await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
      toast('Producto eliminado');
      loadProducts();
    })
  );
}

async function loadProducts() {
  bindProductViewSwitch();
  PRODUCT_VIEW_MODE = readStoredProductViewMode();
  POS_PRODUCT_SORT = normalizePosSortMode(SETTINGS?.pos_catalog_sort_mode || readStoredPosSortMode());
  CATS = await api('/api/products/categories');
  PRODUCTS_CACHE = await api('/api/products');

  $('#pCat').innerHTML = '<option value="">Sin categoría</option>' + CATS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  if (PRODUCT_CAT_FILTER !== 'all' && !CATS.some((c) => String(c.id) === String(PRODUCT_CAT_FILTER))) {
    PRODUCT_CAT_FILTER = 'all';
  }

  renderCategoryChips();
  renderProductsGrid();
  syncPosSortControlVisibility();
}

function resetAiImportState() {
  AI_PRODUCTS_DRAFT = [];
  const rows = $('#aiProductRows');
  const notes = $('#aiProductNotes');
  const result = $('#aiProductResult');
  if (rows) rows.innerHTML = '';
  if (notes) notes.textContent = '';
  if (result) result.hidden = true;
  if ($('#aiProductImport')) $('#aiProductImport').disabled = true;
  resetAiAnalyzeProgress();
}

let AI_ANALYZE_PROGRESS_TIMER = null;
let AI_ANALYZE_SUCCESS_TIMER = null;
let AI_ANALYZE_COOLDOWN_TIMER = null;
let AI_ANALYZE_COOLDOWN_UNTIL = 0;
const AI_ANALYZE_BTN_IDLE_HTML = $('#aiAnalyzeBtn')?.innerHTML || '<i class="ph-bold ph-brain"></i> Analizar menú';

function isAiAnalyzeCooldownActive() {
  return AI_ANALYZE_COOLDOWN_UNTIL > Date.now();
}

function applyAiAnalyzeButtonIdleState() {
  const btn = $('#aiAnalyzeBtn');
  if (!btn) return;
  btn.innerHTML = AI_ANALYZE_BTN_IDLE_HTML;
  btn.disabled = false;
}

function startAiAnalyzeCooldown(seconds) {
  const btn = $('#aiAnalyzeBtn');
  const doneNote = $('#aiAnalyzeProgressDone');
  if (!btn) return;

  if (AI_ANALYZE_COOLDOWN_TIMER) {
    clearInterval(AI_ANALYZE_COOLDOWN_TIMER);
    AI_ANALYZE_COOLDOWN_TIMER = null;
  }

  const safeSecs = Math.max(5, Math.min(180, Math.round(Number(seconds) || 30)));
  AI_ANALYZE_COOLDOWN_UNTIL = Date.now() + safeSecs * 1000;

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((AI_ANALYZE_COOLDOWN_UNTIL - Date.now()) / 1000));
    if (remaining <= 0) {
      AI_ANALYZE_COOLDOWN_UNTIL = 0;
      if (AI_ANALYZE_COOLDOWN_TIMER) {
        clearInterval(AI_ANALYZE_COOLDOWN_TIMER);
        AI_ANALYZE_COOLDOWN_TIMER = null;
      }
      applyAiAnalyzeButtonIdleState();
      if (doneNote && doneNote.classList.contains('error')) {
        doneNote.hidden = true;
      }
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `<i class="ph-bold ph-timer"></i> Reintentar en ${remaining}s`;
    if (doneNote) {
      doneNote.hidden = false;
      doneNote.classList.add('error');
      doneNote.textContent = `Límite temporal de IA alcanzado. Reintenta en ${remaining}s.`;
    }
  };

  tick();
  AI_ANALYZE_COOLDOWN_TIMER = setInterval(tick, 1000);
}

function setAiAnalyzeProgress(value, text) {
  const progress = $('#aiAnalyzeProgress');
  const bar = $('#aiAnalyzeProgressBar');
  const pct = $('#aiAnalyzeProgressPct');
  const label = $('#aiAnalyzeProgressText');
  const track = progress?.querySelector('.ai-analyze-progress-track');
  if (!progress || !bar || !pct || !label) return;
  const safeVal = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  progress.hidden = false;
  bar.style.width = `${safeVal}%`;
  pct.textContent = `${safeVal}%`;
  if (text) label.textContent = text;
  track?.setAttribute('aria-valuenow', String(safeVal));
}

function startAiAnalyzeProgress() {
  resetAiAnalyzeProgress();
  const progress = $('#aiAnalyzeProgress');
  progress?.classList.remove('done');
  const phases = [
    'Subiendo imagen...',
    'Leyendo texto del menú...',
    'Analizando productos y precios...',
    'Estructurando resultados...',
  ];
  let step = 0;
  let pct = 8;
  setAiAnalyzeProgress(pct, phases[step]);
  AI_ANALYZE_PROGRESS_TIMER = setInterval(() => {
    pct = Math.min(92, pct + (Math.random() > 0.45 ? 4 : 3));
    if (pct > 26 && step < 1) step = 1;
    if (pct > 52 && step < 2) step = 2;
    if (pct > 74 && step < 3) step = 3;
    setAiAnalyzeProgress(pct, phases[step]);
    if (pct >= 92 && AI_ANALYZE_PROGRESS_TIMER) {
      clearInterval(AI_ANALYZE_PROGRESS_TIMER);
      AI_ANALYZE_PROGRESS_TIMER = null;
    }
  }, 430);
}

function finishAiAnalyzeProgress(ok = true, text = '') {
  if (AI_ANALYZE_PROGRESS_TIMER) {
    clearInterval(AI_ANALYZE_PROGRESS_TIMER);
    AI_ANALYZE_PROGRESS_TIMER = null;
  }
  if (AI_ANALYZE_SUCCESS_TIMER) {
    clearTimeout(AI_ANALYZE_SUCCESS_TIMER);
    AI_ANALYZE_SUCCESS_TIMER = null;
  }
  const progress = $('#aiAnalyzeProgress');
  const doneNote = $('#aiAnalyzeProgressDone');
  if (ok) {
    progress?.classList.add('done');
    setAiAnalyzeProgress(100, text || 'Análisis completado');
    if (doneNote) {
      doneNote.hidden = false;
      doneNote.classList.remove('error');
      doneNote.textContent = text || 'Éxito: menú analizado correctamente.';
      AI_ANALYZE_SUCCESS_TIMER = setTimeout(() => {
        doneNote.hidden = true;
        AI_ANALYZE_SUCCESS_TIMER = null;
      }, 2000);
    }
    return;
  }
  progress?.classList.remove('done');
  const current = Number($('#aiAnalyzeProgressPct')?.textContent?.replace('%', '') || 0);
  setAiAnalyzeProgress(Math.max(18, current), text || 'No se pudo completar el análisis');
  if (doneNote) {
    doneNote.hidden = false;
    doneNote.classList.add('error');
    doneNote.textContent = text || 'No se pudo completar el análisis';
  }
}

function resetAiAnalyzeProgress() {
  if (AI_ANALYZE_PROGRESS_TIMER) {
    clearInterval(AI_ANALYZE_PROGRESS_TIMER);
    AI_ANALYZE_PROGRESS_TIMER = null;
  }
  if (AI_ANALYZE_SUCCESS_TIMER) {
    clearTimeout(AI_ANALYZE_SUCCESS_TIMER);
    AI_ANALYZE_SUCCESS_TIMER = null;
  }
  const progress = $('#aiAnalyzeProgress');
  const bar = $('#aiAnalyzeProgressBar');
  const pct = $('#aiAnalyzeProgressPct');
  const label = $('#aiAnalyzeProgressText');
  const doneNote = $('#aiAnalyzeProgressDone');
  const track = progress?.querySelector('.ai-analyze-progress-track');
  if (progress) {
    progress.hidden = true;
    progress.classList.remove('done');
  }
  if (bar) bar.style.width = '0%';
  if (pct) pct.textContent = '0%';
  if (label) label.textContent = 'Leyendo menú...';
  if (doneNote) {
    doneNote.hidden = true;
    doneNote.classList.remove('error');
    doneNote.textContent = '';
  }
  track?.setAttribute('aria-valuenow', '0');
}

function renderAiDraftRows() {
  const rows = $('#aiProductRows');
  if (!rows) return;
  if (!AI_PRODUCTS_DRAFT.length) {
    rows.innerHTML = '<tr><td colspan="5"><span class="hint">No hay productos detectados.</span></td></tr>';
    $('#aiProductImport').disabled = true;
    return;
  }

  rows.innerHTML = AI_PRODUCTS_DRAFT.map((item, idx) => `
    <tr data-ai-row="${idx}">
      <td><input type="text" class="ai-name" value="${esc(item.name || '')}" placeholder="Nombre" /></td>
      <td><input type="text" class="ai-desc" value="${esc(item.description || '')}" placeholder="Descripción" /></td>
      <td><input type="number" class="ai-price" value="${Number(item.price || 0)}" min="0" step="0.01" /></td>
      <td><input type="text" class="ai-cat" value="${esc(item.categoryName || '')}" placeholder="Categoría" /></td>
      <td><button type="button" class="btn btn-danger btn-icon ai-del" title="Quitar"><i class="ph-bold ph-trash"></i></button></td>
    </tr>`).join('');

  rows.querySelectorAll('.ai-name').forEach((input) => {
    input.addEventListener('input', (e) => {
      const i = Number(e.target.closest('[data-ai-row]').dataset.aiRow);
      AI_PRODUCTS_DRAFT[i].name = e.target.value;
    });
  });
  rows.querySelectorAll('.ai-desc').forEach((input) => {
    input.addEventListener('input', (e) => {
      const i = Number(e.target.closest('[data-ai-row]').dataset.aiRow);
      AI_PRODUCTS_DRAFT[i].description = e.target.value;
    });
  });
  rows.querySelectorAll('.ai-price').forEach((input) => {
    input.addEventListener('input', (e) => {
      const i = Number(e.target.closest('[data-ai-row]').dataset.aiRow);
      AI_PRODUCTS_DRAFT[i].price = Number(e.target.value) || 0;
    });
  });
  rows.querySelectorAll('.ai-cat').forEach((input) => {
    input.addEventListener('input', (e) => {
      const i = Number(e.target.closest('[data-ai-row]').dataset.aiRow);
      AI_PRODUCTS_DRAFT[i].categoryName = e.target.value;
    });
  });
  rows.querySelectorAll('.ai-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = Number(e.target.closest('[data-ai-row]').dataset.aiRow);
      AI_PRODUCTS_DRAFT.splice(i, 1);
      renderAiDraftRows();
    });
  });

  $('#aiProductImport').disabled = false;
}

function openAiImportModal() {
  $('#aiMenuImage').value = '';
  $('#aiMenuImagePreview').hidden = true;
  $('#aiMenuImagePreviewImg').src = '';
  $('#aiMenuImageHint').textContent = 'Aún no has seleccionado imagen.';
  resetAiImportState();
  $('#aiProductModal').classList.add('show');
}

/* — Modal categoría — */
$('#addCatBtn').addEventListener('click', () => {
  $('#catName').value = '';
  $('#catModal').classList.add('show');
  setTimeout(() => $('#catName').focus(), 80);
});
$('#catCancel').addEventListener('click', () => $('#catModal').classList.remove('show'));
$('#catForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/products/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#catName').value }),
    });
    $('#catModal').classList.remove('show');
    toast('Categoría creada');
    loadProducts();
  } catch (err) {
    toast(err.message, true);
  }
});

/* — Modal producto — */
const dz = $('#dropzone');
function resetDropzone(imageUrl = null) {
  $('#pImage').value = '';
  if (imageUrl) {
    $('#dzImg').src = imageUrl;
    dz.classList.add('has-img');
  } else {
    dz.classList.remove('has-img');
  }
}
$('#pImage').addEventListener('change', () => {
  const f = $('#pImage').files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) {
    toast('La imagen supera 8 MB, elige una más ligera', true);
    $('#pImage').value = '';
    return;
  }
  $('#dzImg').src = URL.createObjectURL(f);
  dz.classList.add('has-img');
});
['dragover', 'dragleave', 'drop'].forEach((ev) =>
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    dz.classList.toggle('drag', ev === 'dragover');
    if (ev === 'drop' && e.dataTransfer.files[0]) {
      $('#pImage').files = e.dataTransfer.files;
      $('#pImage').dispatchEvent(new Event('change'));
    }
  })
);

function openProdModal(p = null) {
  $('#prodModalTitle').innerHTML = p
    ? '<i class="ph-bold ph-pencil-simple"></i> Editar producto'
    : '<i class="ph-bold ph-plus-circle"></i> Nuevo producto';
  $('#pId').value = p ? p.id : '';
  $('#pName').value = p ? p.name : '';
  $('#pDesc').value = p ? p.description || '' : '';
  $('#pPrice').value = p ? p.price : '';
  $('#pCat').value = p && p.category_id ? p.category_id : '';
  $('#pActive').checked = p ? !!p.active : true;
  resetDropzone(p && p.image ? p.image : null);

  // Reset tabs
  switchProdTab('basic');

  // Load variants and modifier groups from cache if editing
  CURRENT_PROD_VARIANTS = (p && p.variants) ? JSON.parse(JSON.stringify(p.variants)) : [];
  CURRENT_PROD_MODIFIER_GROUPS = (p && p.modifierGroups) ? JSON.parse(JSON.stringify(p.modifierGroups)) : [];
  renderVariantsList();
  renderModifierGroupsList();
  renderProdTabCounters();
  renderProdExtrasPreview(p);

  $('#prodModal').classList.add('show');
}

// ── Variantes y Modificadores: estado local del modal ──
let CURRENT_PROD_VARIANTS = [];
let CURRENT_PROD_MODIFIER_GROUPS = [];

function switchProdTab(tab) {
  document.querySelectorAll('.prod-modal-tabs button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.prodTab === tab);
  });
  document.querySelectorAll('.prod-tab-panel').forEach((panel) => {
    panel.hidden = panel.id !== `prodTab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`;
    panel.classList.toggle('active', !panel.hidden);
  });
}

function renderProdTabCounters() {
  // Update counter badges on the tab buttons
  document.querySelectorAll('.prod-modal-tabs button').forEach((btn) => {
    btn.querySelectorAll('.tab-count').forEach((el) => el.remove());
    if (btn.dataset.prodTab === 'variants' && CURRENT_PROD_VARIANTS.length) {
      btn.insertAdjacentHTML('beforeend', `<span class="tab-count">${CURRENT_PROD_VARIANTS.length}</span>`);
    }
    if (btn.dataset.prodTab === 'modifiers' && CURRENT_PROD_MODIFIER_GROUPS.length) {
      btn.insertAdjacentHTML('beforeend', `<span class="tab-count">${CURRENT_PROD_MODIFIER_GROUPS.length}</span>`);
    }
  });
}

function renderProdExtrasPreview(p) {
  const container = $('#prodExtrasPreview');
  if (!container) return;
  const vCount = CURRENT_PROD_VARIANTS.length;
  const mCount = CURRENT_PROD_MODIFIER_GROUPS.length;
  if (!vCount && !mCount) {
    container.innerHTML = '';
    return;
  }
  const varHtml = vCount > 1
    ? `<div class="extras-preview-item" data-goto="variants">
        <div class="extras-preview-ic variant-ic"><i class="ph-bold ph-stack"></i></div>
        <div>
          <b>${vCount} variantes de precio</b>
          <span>${CURRENT_PROD_VARIANTS.map((v) => `${esc(v.name)} ${fmtMoney(v.price)}`).join(' · ')}</span>
        </div>
        <i class="ph-bold ph-caret-right"></i>
       </div>`
    : '';
  const modHtml = mCount
    ? `<div class="extras-preview-item" data-goto="modifiers">
        <div class="extras-preview-ic modifier-ic"><i class="ph-bold ph-sliders"></i></div>
        <div>
          <b>${mCount} grupo${mCount > 1 ? 's' : ''} de opciones</b>
          <span>${CURRENT_PROD_MODIFIER_GROUPS.map((g) => `${esc(g.name)} (${(g.options||[]).length} opciones)`).join(' · ')}</span>
        </div>
        <i class="ph-bold ph-caret-right"></i>
       </div>`
    : '';
  container.innerHTML = `<div class="extras-preview-card">${varHtml}${modHtml}</div>`;
  container.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
      switchProdTab(el.dataset.goto);
    });
  });
}

document.querySelectorAll('.prod-modal-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => switchProdTab(btn.dataset.prodTab));
});

function renderVariantsList() {
  const el = $('#variantsList');
  if (!el) return;
  if (!CURRENT_PROD_VARIANTS.length) {
    el.innerHTML = '<div class="hint" style="text-align:center;padding:10px 0"><i class="ph ph-stack"></i> Sin variantes. El precio base se usará directamente.</div>';
    return;
  }
  el.innerHTML = CURRENT_PROD_VARIANTS.map((v, i) => `
    <div class="variant-row" data-vi="${i}">
      <input class="variant-name" type="text" placeholder="Ej: 1 kg" value="${esc(v.name)}" style="flex:1;min-width:100px" />
      <input class="variant-price" type="number" step="0.01" min="0" placeholder="Precio" value="${v.price || ''}" style="width:100px" />
      <button type="button" class="btn-icon btn-ghost variant-del" title="Eliminar variante"><i class="ph-bold ph-trash"></i></button>
    </div>`).join('');
  el.querySelectorAll('.variant-name').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const i = Number(e.target.closest('[data-vi]').dataset.vi);
      CURRENT_PROD_VARIANTS[i].name = e.target.value;
    });
  });
  el.querySelectorAll('.variant-price').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const i = Number(e.target.closest('[data-vi]').dataset.vi);
      CURRENT_PROD_VARIANTS[i].price = Number(e.target.value) || 0;
    });
  });
  el.querySelectorAll('.variant-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const i = Number(e.target.closest('[data-vi]').dataset.vi);
      CURRENT_PROD_VARIANTS.splice(i, 1);
      renderVariantsList();
      renderProdTabCounters();
    });
  });
}

$('#addVariantBtn')?.addEventListener('click', () => {
  CURRENT_PROD_VARIANTS.push({ id: null, name: '', price: 0, sort: CURRENT_PROD_VARIANTS.length, active: 1 });
  renderVariantsList();
  renderProdTabCounters();
});

function renderModifierGroupsList() {
  const el = $('#modifierGroupsList');
  if (!el) return;
  if (!CURRENT_PROD_MODIFIER_GROUPS.length) {
    el.innerHTML = '<div class="hint" style="text-align:center;padding:10px 0"><i class="ph ph-sliders"></i> Sin grupos de opciones.</div>';
    return;
  }
  el.innerHTML = CURRENT_PROD_MODIFIER_GROUPS.map((g, gi) => `
    <div class="modifier-group-card" data-gi="${gi}">
      <div class="modifier-group-head">
        <input class="mg-name" type="text" placeholder="Ej: Mitades, Extras, Punto de cocción…" value="${esc(g.name)}" style="flex:1;font-weight:700" />
        <select class="mg-min" title="Mínimo de selecciones requeridas" style="width:88px">
          ${[0,1,2,3].map((n) => `<option value="${n}" ${Number(g.min_selections)===n?'selected':''}>${n} mín</option>`).join('')}
        </select>
        <select class="mg-max" title="Máximo de selecciones permitidas" style="width:88px">
          ${[1,2,3,4,5,6,8,10].map((n) => `<option value="${n}" ${Number(g.max_selections)===n?'selected':''}>${n} máx</option>`).join('')}
        </select>
        <button type="button" class="btn-icon btn-ghost mg-del" title="Eliminar grupo"><i class="ph-bold ph-trash"></i></button>
      </div>
      <div class="modifier-options-list" data-gi="${gi}">
        ${(g.options||[]).map((o, oi) => `
          <div class="modifier-option-row" data-oi="${oi}">
            <input class="mo-name" type="text" placeholder="Ej: Pepperoni" value="${esc(o.name)}" style="flex:1;min-width:100px" />
            <input class="mo-extra" type="number" step="0.01" min="0" placeholder="+$0" title="Costo extra" value="${o.extra_price||''}" style="width:88px" />
            <button type="button" class="btn-icon btn-ghost mo-del" title="Eliminar opción"><i class="ph-bold ph-x"></i></button>
          </div>`).join('')}
      </div>
      <button type="button" class="btn btn-ghost mo-add" data-gi="${gi}" style="margin-top:6px;font-size:12px"><i class="ph-bold ph-plus"></i> Agregar opción</button>
    </div>`).join('');

  el.querySelectorAll('.mg-name').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      CURRENT_PROD_MODIFIER_GROUPS[Number(e.target.closest('[data-gi]').dataset.gi)].name = e.target.value;
    });
  });
  el.querySelectorAll('.mg-min').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      CURRENT_PROD_MODIFIER_GROUPS[Number(e.target.closest('[data-gi]').dataset.gi)].min_selections = Number(e.target.value);
    });
  });
  el.querySelectorAll('.mg-max').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      CURRENT_PROD_MODIFIER_GROUPS[Number(e.target.closest('[data-gi]').dataset.gi)].max_selections = Number(e.target.value);
    });
  });
  el.querySelectorAll('.mg-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      CURRENT_PROD_MODIFIER_GROUPS.splice(Number(e.target.closest('[data-gi]').dataset.gi), 1);
      renderModifierGroupsList();
      renderProdTabCounters();
    });
  });
  el.querySelectorAll('.mo-name').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const gi = Number(e.target.closest('[data-gi]').dataset.gi);
      const oi = Number(e.target.closest('[data-oi]').dataset.oi);
      CURRENT_PROD_MODIFIER_GROUPS[gi].options[oi].name = e.target.value;
    });
  });
  el.querySelectorAll('.mo-extra').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const gi = Number(e.target.closest('[data-gi]').dataset.gi);
      const oi = Number(e.target.closest('[data-oi]').dataset.oi);
      CURRENT_PROD_MODIFIER_GROUPS[gi].options[oi].extra_price = Number(e.target.value) || 0;
    });
  });
  el.querySelectorAll('.mo-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const gi = Number(e.target.closest('[data-gi]').dataset.gi);
      const oi = Number(e.target.closest('[data-oi]').dataset.oi);
      CURRENT_PROD_MODIFIER_GROUPS[gi].options.splice(oi, 1);
      renderModifierGroupsList();
    });
  });
  el.querySelectorAll('.mo-add').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gi = Number(btn.dataset.gi);
      CURRENT_PROD_MODIFIER_GROUPS[gi].options = CURRENT_PROD_MODIFIER_GROUPS[gi].options || [];
      CURRENT_PROD_MODIFIER_GROUPS[gi].options.push({ id: null, name: '', extra_price: 0, sort: CURRENT_PROD_MODIFIER_GROUPS[gi].options.length, active: 1 });
      renderModifierGroupsList();
    });
  });
}

$('#addModifierGroupBtn')?.addEventListener('click', () => {
  CURRENT_PROD_MODIFIER_GROUPS.push({ id: null, name: '', min_selections: 0, max_selections: 1, sort: CURRENT_PROD_MODIFIER_GROUPS.length, options: [] });
  renderModifierGroupsList();
  renderProdTabCounters();
});

async function saveProductExtras(productId) {
  const existing = PRODUCTS_CACHE.find((p) => p.id == productId);
  const existingVariants = existing?.variants || [];
  const existingGroups = existing?.modifierGroups || [];

  // Sync variants
  const keepVariantIds = new Set();
  for (let i = 0; i < CURRENT_PROD_VARIANTS.length; i++) {
    const v = CURRENT_PROD_VARIANTS[i];
    if (!v.name.trim()) continue;
    if (v.id) {
      await api(`/api/products/${productId}/variants/${v.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v.name, price: v.price, sort: i, active: 1 }),
      });
      keepVariantIds.add(v.id);
    } else {
      const newV = await api(`/api/products/${productId}/variants`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v.name, price: v.price, sort: i }),
      });
      keepVariantIds.add(newV.id);
    }
  }
  for (const ev of existingVariants) {
    if (!keepVariantIds.has(ev.id)) {
      await api(`/api/products/${productId}/variants/${ev.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  // Sync modifier groups
  const keepGroupIds = new Set();
  for (let gi = 0; gi < CURRENT_PROD_MODIFIER_GROUPS.length; gi++) {
    const g = CURRENT_PROD_MODIFIER_GROUPS[gi];
    if (!g.name.trim()) continue;
    let groupId = g.id;
    if (groupId) {
      await api(`/api/products/${productId}/modifier-groups/${groupId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: g.name, min_selections: g.min_selections, max_selections: g.max_selections, sort: gi }),
      });
    } else {
      const newG = await api(`/api/products/${productId}/modifier-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: g.name, min_selections: g.min_selections, max_selections: g.max_selections, sort: gi }),
      });
      groupId = newG.id;
    }
    keepGroupIds.add(groupId);

    // Sync options
    const existingGroup = existingGroups.find((eg) => eg.id === g.id);
    const existingOpts = existingGroup?.options || [];
    const keepOptIds = new Set();
    for (let oi = 0; oi < (g.options || []).length; oi++) {
      const o = g.options[oi];
      if (!o.name.trim()) continue;
      if (o.id) {
        await api(`/api/products/${productId}/modifier-groups/${groupId}/options/${o.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: o.name, extra_price: o.extra_price, sort: oi, active: 1 }),
        });
        keepOptIds.add(o.id);
      } else {
        const newO = await api(`/api/products/${productId}/modifier-groups/${groupId}/options`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: o.name, extra_price: o.extra_price, sort: oi }),
        });
        keepOptIds.add(newO.id);
      }
    }
    for (const eo of existingOpts) {
      if (!keepOptIds.has(eo.id)) {
        await api(`/api/products/${productId}/modifier-groups/${groupId}/options/${eo.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  }
  for (const eg of existingGroups) {
    if (!keepGroupIds.has(eg.id)) {
      await api(`/api/products/${productId}/modifier-groups/${eg.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }
}

$('#addProdBtn').addEventListener('click', () => openProdModal());
$('#aiImportBtn')?.addEventListener('click', () => openAiImportModal());
$('#prodCancel').addEventListener('click', () => $('#prodModal').classList.remove('show'));
$('#aiProductCancel')?.addEventListener('click', () => $('#aiProductModal').classList.remove('show'));

const aiUploadArea = $('#aiMenuUploadArea');
const aiMenuInput = $('#aiMenuImage');
const aiPickBtn = $('#aiMenuPickBtn');

function openAiMenuPicker() {
  aiMenuInput?.click();
}

aiPickBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  openAiMenuPicker();
});

aiUploadArea?.addEventListener('click', () => openAiMenuPicker());
aiUploadArea?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openAiMenuPicker();
  }
});

['dragover', 'dragleave', 'drop'].forEach((ev) => {
  aiUploadArea?.addEventListener(ev, (e) => {
    e.preventDefault();
    aiUploadArea.classList.toggle('drag', ev === 'dragover');
    if (ev === 'drop' && e.dataTransfer?.files?.[0]) {
      aiMenuInput.files = e.dataTransfer.files;
      aiMenuInput.dispatchEvent(new Event('change'));
    }
  });
});

$('#aiMenuImage')?.addEventListener('change', () => {
  const file = $('#aiMenuImage').files?.[0];
  const preview = $('#aiMenuImagePreview');
  const img = $('#aiMenuImagePreviewImg');
  if (!file) {
    preview.hidden = true;
    img.src = '';
    $('#aiMenuImageHint').textContent = 'Aún no has seleccionado imagen.';
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast('La imagen supera 8 MB, elige una más ligera', true);
    $('#aiMenuImage').value = '';
    preview.hidden = true;
    img.src = '';
    return;
  }
  img.src = URL.createObjectURL(file);
  preview.hidden = false;
  $('#aiMenuImageHint').textContent = `${file.name} (${Math.ceil(file.size / 1024)} KB)`;
});

$('#aiProductForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isAiAnalyzeCooldownActive()) {
    const remaining = Math.max(1, Math.ceil((AI_ANALYZE_COOLDOWN_UNTIL - Date.now()) / 1000));
    toast(`Espera ${remaining}s para volver a analizar`, true);
    return;
  }
  const file = $('#aiMenuImage').files?.[0] || null;
  if (!file) {
    toast('Selecciona una imagen del menú para analizar', true);
    return;
  }

  const btn = $('#aiAnalyzeBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ph-bold ph-spinner-gap" style="animation:spin 0.8s linear infinite"></i> Analizando...';
  startAiAnalyzeProgress();
  try {
    const fd = new FormData();
    fd.append('menuImage', file);
    const out = await api('/api/products/ai/suggest', { method: 'POST', body: fd });
    setAiAnalyzeProgress(96, 'Menú leído. Preparando tabla para editar...');
    AI_PRODUCTS_DRAFT = Array.isArray(out.products) ? out.products : [];
    $('#aiProductResult').hidden = false;

    const notes = [];
    if (Array.isArray(out.notes) && out.notes.length) notes.push(`Notas IA: ${out.notes.join(' | ')}`);
    if (Array.isArray(out.categoryHints) && out.categoryHints.length) {
      const newCats = out.categoryHints.filter((c) => !c.exists).map((c) => c.name);
      if (newCats.length) notes.push(`Se crearán categorías nuevas: ${newCats.join(', ')}`);
    }
    if (Array.isArray(out.variantGroupsDetected) && out.variantGroupsDetected.length) {
      notes.push(`Se detectaron variantes para: ${out.variantGroupsDetected.join(', ')}`);
    }
    $('#aiProductNotes').textContent = notes.join(' · ') || `Se detectaron ${AI_PRODUCTS_DRAFT.length} productos. Puedes editar antes de importar.`;
    renderAiDraftRows();
    finishAiAnalyzeProgress(true, `Éxito: ${AI_PRODUCTS_DRAFT.length} productos detectados`);
    toast(`IA detectó ${AI_PRODUCTS_DRAFT.length} productos`);
  } catch (err) {
    const retryAfter = Number(err?.data?.retryAfterSec || 0);
    if (Number(err?.status) === 429) {
      const wait = retryAfter > 0 ? retryAfter : 30;
      finishAiAnalyzeProgress(false, `Demasiadas solicitudes. Espera ${wait}s para reintentar`);
      startAiAnalyzeCooldown(wait);
      toast(`Límite temporal de IA. Reintenta en ${wait}s`, true);
    } else {
      finishAiAnalyzeProgress(false, err?.message || 'Error al analizar menú. Intenta de nuevo');
      toast(err.message, true);
    }
  } finally {
    if (!isAiAnalyzeCooldownActive()) {
      applyAiAnalyzeButtonIdleState();
    }
  }
});

$('#aiProductImport')?.addEventListener('click', async () => {
  const cleanProducts = AI_PRODUCTS_DRAFT
    .map((p) => ({
      name: String(p.name || '').trim(),
      description: String(p.description || '').trim(),
      price: Number(p.price) || 0,
      categoryName: String(p.categoryName || '').trim(),
      variantGroup: String(p.variantGroup || '').trim(),
      variantName: String(p.variantName || '').trim(),
    }))
    .filter((p) => p.name);

  if (!cleanProducts.length) {
    toast('No hay productos válidos para importar', true);
    return;
  }

  const btn = $('#aiProductImport');
  btn.disabled = true;
  try {
    const out = await api('/api/products/ai/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: cleanProducts,
        createMissingCategories: true,
        defaultActive: true,
      }),
    });
    toast(`Importación completada: ${out.created} productos`);
    $('#aiProductModal').classList.remove('show');
    await loadProducts();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

[$('#prodModal'), $('#aiProductModal'), $('#catModal'), $('#confirmModal'), $('#branchModal'), $('#cashierModal'), $('#posMovementModal'), $('#posCloseModal'), $('#posSalesHistoryModal'), $('#posPaymentEditModal'), $('#orderCancelReasonModal'), $('#posProductConfigModal')].forEach((m) =>
  m && m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('show');
  })
);

$('#prodForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#pId').value;
  const btn = $('#prodSave');
  btn.disabled = true;
  const fd = new FormData();
  fd.append('name', $('#pName').value);
  fd.append('description', $('#pDesc').value);
  fd.append('price', $('#pPrice').value);
  fd.append('categoryId', $('#pCat').value);
  fd.append('active', $('#pActive').checked ? '1' : '0');
  if ($('#pImage').files[0]) fd.append('image', $('#pImage').files[0]);
  try {
    const saved = await api(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', body: fd });
    const productId = id || saved?.id;
    if (productId) await saveProductExtras(productId).catch((err) => console.warn('[variants] save error:', err));
    $('#prodModal').classList.remove('show');
    toast(id ? 'Producto actualizado' : '¡Producto creado!');
    loadProducts();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ===== Chatbot ===== */
function parseDeliveryZones(raw) {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    if (!Array.isArray(parsed)) return [];

    const normalizePoint = (point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const a = Number(point[0]);
      const b = Number(point[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      // Prefer [lat,lng], fallback from [lng,lat] (GeoJSON)
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return [a, b];
      if (Math.abs(a) <= 180 && Math.abs(b) <= 90) return [b, a];
      return null;
    };

    const extractPoints = (zone) => {
      if (Array.isArray(zone?.points)) return zone.points.map(normalizePoint).filter(Boolean);
      const coordinates = zone?.geometry?.coordinates;
      if (Array.isArray(coordinates) && Array.isArray(coordinates[0]) && Array.isArray(coordinates[0][0])) {
        return coordinates[0].map(normalizePoint).filter(Boolean);
      }
      return [];
    };

    return parsed
      .map((zone, i) => {
        const props = zone?.properties && typeof zone.properties === 'object' ? zone.properties : zone;
        const points = extractPoints(zone);
        const fee = Number(props?.fee);
        const name = String(props?.name || '').trim();
        if (!name || !Number.isFinite(fee) || fee < 0 || points.length < 3) return null;
        return {
          id: String(props?.id || zone?.id || `zone-${i + 1}`),
          name,
          fee,
          color: String(props?.color || zone?.color || '#0ea5e9'),
          points,
          active: props?.active !== false,
          branchId: props?.branchId != null && props?.branchId !== '' ? String(props.branchId) : '',
          branchName: String(props?.branchName || '').trim(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function deliveryZoneFilterMatches(zone) {
  if (DELIVERY_ZONE_FILTER_BRANCH === 'all') return true;
  if (DELIVERY_ZONE_FILTER_BRANCH === 'general') return !String(zone.branchId || '');
  return String(zone.branchId || '') === DELIVERY_ZONE_FILTER_BRANCH;
}

function getVisibleDeliveryZones() {
  return DELIVERY_ZONES.filter(deliveryZoneFilterMatches);
}

function findBranchName(branchId) {
  if (!branchId) return '';
  const branch = BRANCHES.find((item) => String(item.id) === String(branchId));
  return branch?.name || '';
}

function zoneBranchLabel(zone) {
  return findBranchName(zone?.branchId) || String(zone?.branchName || '').trim() || 'Zona general';
}

function syncDeliveryEditorButtons() {
  const isEditing = Boolean($('#deliveryZoneEditId')?.value);
  const saveBtn = $('#deliverySaveZone');
  const cancelBtn = $('#deliveryCancelEdit');
  if (saveBtn) {
    saveBtn.innerHTML = isEditing
      ? '<i class="ph-bold ph-floppy-disk"></i> Guardar cambios'
      : '<i class="ph-bold ph-plus-circle"></i> Guardar zona';
  }
  if (cancelBtn) cancelBtn.hidden = !isEditing;
}

function resetDeliveryZoneEditor() {
  $('#deliveryZoneEditId').value = '';
  $('#deliveryZoneName').value = '';
  $('#deliveryZoneFee').value = '';
  if ($('#deliveryZoneBranch')) $('#deliveryZoneBranch').value = DELIVERY_ZONE_FILTER_BRANCH !== 'all' && DELIVERY_ZONE_FILTER_BRANCH !== 'general' ? DELIVERY_ZONE_FILTER_BRANCH : '';
  setDeliveryColor('#0ea5e9');
  clearDeliveryDrawing();
  redrawDeliveryPreview();
  $('#deliveryDrawHint').textContent = 'Activa "Iniciar dibujo" y toca el mapa para crear el polígono de tu zona.';
  syncDeliveryEditorButtons();
}

function loadDeliveryZoneIntoEditor(zone) {
  if (!zone) return;
  ensureDeliveryZoneMap();
  $('#deliveryZoneEditId').value = zone.id;
  $('#deliveryZoneName').value = zone.name || '';
  $('#deliveryZoneFee').value = String(zone.fee ?? '');
  if ($('#deliveryZoneBranch')) $('#deliveryZoneBranch').value = String(zone.branchId || '');
  setDeliveryColor(zone.color || '#0ea5e9');
  clearDeliveryDrawing();
  DELIVERY_DRAW_POINTS = (zone.points || []).map((point) => [Number(point[0]), Number(point[1])]);
  if (DELIVERY_ZONE_MAP && globalThis.L) {
    DELIVERY_DRAW_MARKERS = DELIVERY_DRAW_POINTS.map((point) =>
      L.circleMarker(point, { radius: 4, color: $('#deliveryZoneColor')?.value || '#0ea5e9', weight: 2, fillOpacity: 1 }).addTo(DELIVERY_ZONE_MAP)
    );
  }
  redrawDeliveryPreview();
  setDeliveryDrawingActive(true);
  $('#deliveryDrawHint').textContent = `Editando zona: ${zone.name}. Puedes ajustar puntos y luego guardar cambios.`;
  syncDeliveryEditorButtons();
}

async function persistDeliveryZones(successMessage) {
  const fd = new FormData();
  fd.append('delivery_zones_geojson', JSON.stringify(DELIVERY_ZONES));
  await api('/api/settings', { method: 'PUT', body: fd });
  SETTINGS.delivery_zones_geojson = JSON.stringify(DELIVERY_ZONES);
  if (successMessage) toast(successMessage);
}

function renderDeliveryBranchOptions() {
  const branchSelect = $('#deliveryZoneBranch');
  const filterSelect = $('#deliveryZoneFilterBranch');
  if (branchSelect) {
    const current = branchSelect.value;
    branchSelect.innerHTML = ['<option value="">Zona general</option>']
      .concat(BRANCHES.map((branch) => `<option value="${esc(String(branch.id))}">${esc(branch.name)}</option>`))
      .join('');
    branchSelect.value = BRANCHES.some((branch) => String(branch.id) === current) ? current : '';
  }
  if (filterSelect) {
    const options = [
      '<option value="all">Todas las sucursales</option>',
      '<option value="general">Solo zonas generales</option>',
      ...BRANCHES.map((branch) => `<option value="${esc(String(branch.id))}">${esc(branch.name)}</option>`),
    ];
    filterSelect.innerHTML = options.join('');
    const canKeep = DELIVERY_ZONE_FILTER_BRANCH === 'all' || DELIVERY_ZONE_FILTER_BRANCH === 'general' || BRANCHES.some((branch) => String(branch.id) === DELIVERY_ZONE_FILTER_BRANCH);
    if (!canKeep) DELIVERY_ZONE_FILTER_BRANCH = 'all';
    filterSelect.value = DELIVERY_ZONE_FILTER_BRANCH;
  }
}

function fitDeliveryZonesBounds() {
  const visibleZones = getVisibleDeliveryZones();
  if (!DELIVERY_ZONE_MAP || !visibleZones.length) return;
  const allPoints = visibleZones.flatMap((z) => z.points || []).filter((p) => Array.isArray(p) && p.length === 2);
  if (!allPoints.length) return;
  const bounds = L.latLngBounds(allPoints.map((p) => L.latLng(Number(p[0]), Number(p[1]))));
  if (!bounds.isValid()) return;
  DELIVERY_ZONE_MAP.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
}

function setChatbotSubtab(tab) {
  CHATBOT_SUBTAB = tab === 'delivery' || tab === 'upsell' ? tab : 'flow';
  const isDelivery = CHATBOT_SUBTAB === 'delivery';
  const isUpsell = CHATBOT_SUBTAB === 'upsell';
  $('#chatbotTabFlow')?.classList.toggle('active', CHATBOT_SUBTAB === 'flow');
  $('#chatbotTabDelivery')?.classList.toggle('active', isDelivery);
  $('#chatbotTabUpsell')?.classList.toggle('active', isUpsell);
  $('#chatbotFlowPanel').hidden = CHATBOT_SUBTAB !== 'flow';
  $('#chatbotDeliveryPanel').hidden = !isDelivery;
  $('#chatbotUpsellPanel').hidden = !isUpsell;
  if (isDelivery) {
    ensureDeliveryZoneMap();
    setTimeout(() => {
      DELIVERY_ZONE_MAP?.invalidateSize();
      fitDeliveryZonesBounds();
    }, 80);
  }
}

function normalizeInfoUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(text)) return `https://${text}`;
  return '';
}

function parseChatbotInfoOptions(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const used = new Set();
    return parsed
      .map((item, idx) => {
        const label = String(item?.label || '').trim().slice(0, 42);
        const message = String(item?.message || '').trim().slice(0, 300);
        const url = normalizeInfoUrl(item?.url || '');
        let id = String(item?.id || `info_${idx + 1}`)
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 48);
        if (!id) id = `info_${idx + 1}`;
        while (used.has(id)) id = `${id}_${Math.random().toString(36).slice(2, 5)}`;
        used.add(id);
        if (!label || (!message && !url)) return null;
        return { id, label, message, url };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function setChatbotInfoEditorState(entry = null) {
  $('#botInfoOptionId').value = entry?.id || '';
  $('#botInfoOptionLabel').value = entry?.label || '';
  $('#botInfoOptionMessage').value = entry?.message || '';
  $('#botInfoOptionUrl').value = entry?.url || '';
  $('#botInfoOptionSaveBtn').innerHTML = entry
    ? '<i class="ph-bold ph-floppy-disk"></i> Guardar cambios'
    : '<i class="ph-bold ph-plus-circle"></i> Agregar opción';
  $('#botInfoOptionHint').textContent = entry
    ? 'Modo edición activo. Recuerda guardar flujo para publicar cambios.'
    : 'Estas opciones se guardan con el botón "Guardar flujo".';
}

function resetChatbotInfoEditor() {
  setChatbotInfoEditorState(null);
}

function renderChatbotInfoOptionsList() {
  const host = $('#botInfoOptionsList');
  if (!host) return;
  const count = CHATBOT_INFO_OPTIONS.length;
  $('#botInfoOptionsCount').textContent = `${count} opcion${count === 1 ? '' : 'es'}`;

  if (!count) {
    host.innerHTML = emptyHTML('ph-info', 'Sin opciones extra', 'Puedes agregar Horarios, Ofertas de trabajo, Ubicación o Promociones.');
    return;
  }

  host.innerHTML = CHATBOT_INFO_OPTIONS.map((entry) => `
    <div class="chatbot-info-item">
      <div class="meta">
        <div class="label">${esc(entry.label)}</div>
        ${entry.message ? `<div class="message">${esc(entry.message)}</div>` : ''}
        ${entry.url ? `<a class="url" href="${esc(entry.url)}" target="_blank" rel="noopener">${esc(entry.url)}</a>` : ''}
      </div>
      <div class="actions">
        <button class="btn btn-ghost btn-icon" type="button" data-info-up="${esc(entry.id)}" title="Subir"><i class="ph-bold ph-arrow-up"></i></button>
        <button class="btn btn-ghost btn-icon" type="button" data-info-down="${esc(entry.id)}" title="Bajar"><i class="ph-bold ph-arrow-down"></i></button>
        <button class="btn btn-ghost btn-icon" type="button" data-info-edit="${esc(entry.id)}" title="Editar"><i class="ph-bold ph-pencil-simple"></i></button>
        <button class="btn btn-danger btn-icon" type="button" data-info-del="${esc(entry.id)}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
      </div>
    </div>
  `).join('');

  host.querySelectorAll('[data-info-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = CHATBOT_INFO_OPTIONS.find((item) => item.id === button.dataset.infoEdit);
      if (entry) setChatbotInfoEditorState(entry);
    });
  });

  host.querySelectorAll('[data-info-up]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = String(button.dataset.infoUp || '');
      const idx = CHATBOT_INFO_OPTIONS.findIndex((item) => item.id === id);
      if (idx <= 0) return;
      const next = [...CHATBOT_INFO_OPTIONS];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      CHATBOT_INFO_OPTIONS = next;
      renderChatbotInfoOptionsList();
    });
  });

  host.querySelectorAll('[data-info-down]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = String(button.dataset.infoDown || '');
      const idx = CHATBOT_INFO_OPTIONS.findIndex((item) => item.id === id);
      if (idx < 0 || idx >= CHATBOT_INFO_OPTIONS.length - 1) return;
      const next = [...CHATBOT_INFO_OPTIONS];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      CHATBOT_INFO_OPTIONS = next;
      renderChatbotInfoOptionsList();
    });
  });

  host.querySelectorAll('[data-info-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = String(button.dataset.infoDel || '');
      const entry = CHATBOT_INFO_OPTIONS.find((item) => item.id === id);
      if (!(await askConfirm('¿Eliminar opción informativa?', `Se eliminará "${entry?.label || 'sin título'}".`))) return;
      CHATBOT_INFO_OPTIONS = CHATBOT_INFO_OPTIONS.filter((item) => item.id !== id);
      if (String($('#botInfoOptionId')?.value || '') === id) resetChatbotInfoEditor();
      renderChatbotInfoOptionsList();
      toast('Opción informativa eliminada');
    });
  });
}

function fillChatbotInfoOptionsFromSettings() {
  CHATBOT_INFO_OPTIONS = parseChatbotInfoOptions(SETTINGS?.chatbot_extra_options_json || '[]');
  resetChatbotInfoEditor();
  renderChatbotInfoOptionsList();
}

function parseUpsellProductIds(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return [...new Set(parsed.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
    }
  } catch {}
  return [...new Set(text.split(',').map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id > 0))];
}

function parseUpsellOffers(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((offer, idx) => {
        const question = String(offer?.question || '').trim();
        const productIds = parseUpsellProductIds(offer?.productIds || []);
        if (!question || !productIds.length) return null;
        return {
          id: String(offer?.id || `upsell_offer_${idx + 1}`),
          question,
          productIds,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getLegacyUpsellOfferFromSettings() {
  const enabled = (SETTINGS?.chatbot_upsell_enabled || '0') === '1';
  const question = String(SETTINGS?.chatbot_upsell_question || '').trim();
  const productIds = parseUpsellProductIds(SETTINGS?.chatbot_upsell_product_ids || '[]');
  if (!enabled || !question || !productIds.length) return [];
  return [{ id: 'legacy_offer_1', question, productIds }];
}

function setUpsellEditorState(offer = null) {
  $('#botUpsellOfferId').value = offer?.id || '';
  $('#botUpsellQuestion').value = offer?.question || '¿Deseas agregar alguno de estos productos a tu pedido?';
  CHATBOT_UPSELL_SELECTED = new Set(offer?.productIds || []);
  $('#upsellSaveBtn').innerHTML = offer
    ? '<i class="ph-bold ph-floppy-disk"></i> Guardar cambios'
    : '<i class="ph-bold ph-floppy-disk"></i> Guardar ofrecimiento';
  $('#upsellEditingHint').textContent = offer
    ? 'Modo edición activo: modifica pregunta o productos y guarda cambios.'
    : 'Crea un ofrecimiento con su pregunta y selecciona productos.';
  renderUpsellProductsPicker();
  renderUpsellOffersList();
}

function resetUpsellEditor() {
  setUpsellEditorState(null);
}

function productMapById() {
  const map = new Map();
  (CHATBOT_UPSELL_PRODUCTS || []).forEach((p) => map.set(Number(p.id), p));
  return map;
}

function normalizeUpsellOffersWithProducts(offers) {
  const productsById = productMapById();
  const hasCatalog = productsById.size > 0;
  return (offers || [])
    .map((offer, idx) => {
      const question = String(offer?.question || '').trim();
      const id = String(offer?.id || `upsell_offer_${idx + 1}`);
      const productIds = parseUpsellProductIds(offer?.productIds || [])
        .filter((pid) => {
          if (!hasCatalog) return true;
          return productsById.has(Number(pid)) && Number(productsById.get(Number(pid))?.active ?? 0) === 1;
        });
      if (!question || !productIds.length) return null;
      return { id, question, productIds };
    })
    .filter(Boolean);
}

function renderUpsellProductsPicker() {
  const host = $('#upsellProductsPicker');
  if (!host) return;

  const activeProducts = (CHATBOT_UPSELL_PRODUCTS || []).filter((p) => Number(p?.active ?? 0) === 1);
  const validIds = new Set(activeProducts.map((p) => Number(p.id)));
  CHATBOT_UPSELL_SELECTED = new Set([...CHATBOT_UPSELL_SELECTED].filter((id) => validIds.has(Number(id))));

  if (!activeProducts.length) {
    host.innerHTML = emptyHTML('ph-hamburger', 'Sin productos activos', 'Activa productos en tu menú para poder sugerirlos en el upsell.');
    $('#upsellProductsCounter').textContent = 'Seleccionados: 0';
    return;
  }

  host.innerHTML = activeProducts
    .map((p) => {
      const selected = CHATBOT_UPSELL_SELECTED.has(Number(p.id));
      return `
        <button type="button" class="upsell-product-item ${selected ? 'active' : ''}" data-upsell-product="${p.id}">
          <div class="meta">
            <div class="name">${esc(p.name)}</div>
            <div class="cat">${esc(p.category_name || 'Sin categoría')}</div>
          </div>
          <div class="price">${fmtMoney(p.price)}</div>
        </button>
      `;
    })
    .join('');

  host.querySelectorAll('[data-upsell-product]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.upsellProduct);
      if (!Number.isInteger(id) || id <= 0) return;
      if (CHATBOT_UPSELL_SELECTED.has(id)) CHATBOT_UPSELL_SELECTED.delete(id);
      else CHATBOT_UPSELL_SELECTED.add(id);
      renderUpsellProductsPicker();
    });
  });

  $('#upsellProductsCounter').textContent = `Seleccionados: ${CHATBOT_UPSELL_SELECTED.size}`;
}

function renderUpsellOffersList() {
  const host = $('#upsellOffersList');
  if (!host) return;
  const productsById = productMapById();
  const editingId = String($('#botUpsellOfferId')?.value || '').trim();
  $('#upsellOffersCount').textContent = `${CHATBOT_UPSELL_OFFERS.length} ofrecimiento${CHATBOT_UPSELL_OFFERS.length === 1 ? '' : 's'}`;

  if (!CHATBOT_UPSELL_OFFERS.length) {
    host.innerHTML = emptyHTML('ph-list-checks', 'Sin ofrecimientos guardados', 'Crea tu primer ofrecimiento para aumentar el ticket de venta.');
    return;
  }

  host.innerHTML = CHATBOT_UPSELL_OFFERS.map((offer, idx) => {
    const chips = offer.productIds.map((pid) => {
      const prod = productsById.get(Number(pid));
      const label = prod?.name || `Producto #${pid}`;
      return `<span class="upsell-offer-chip">${esc(label)}</span>`;
    }).join('');
    const canMoveUp = idx > 0;
    const canMoveDown = idx < CHATBOT_UPSELL_OFFERS.length - 1;
    return `
      <div class="upsell-offer-card ${editingId && editingId === offer.id ? 'editing' : ''}">
        <div class="upsell-offer-head">
          <div>
            <div class="upsell-offer-q">${idx + 1}. ${esc(offer.question)}</div>
            <div class="hint">${offer.productIds.length} producto${offer.productIds.length === 1 ? '' : 's'} sugerido${offer.productIds.length === 1 ? '' : 's'}</div>
          </div>
          <div class="upsell-offer-actions">
            <button class="btn btn-ghost btn-icon" type="button" data-upsell-up="${esc(offer.id)}" title="Subir" ${canMoveUp ? '' : 'disabled'}><i class="ph-bold ph-arrow-up"></i></button>
            <button class="btn btn-ghost btn-icon" type="button" data-upsell-down="${esc(offer.id)}" title="Bajar" ${canMoveDown ? '' : 'disabled'}><i class="ph-bold ph-arrow-down"></i></button>
            <button class="btn btn-ghost btn-icon" type="button" data-upsell-edit="${esc(offer.id)}" title="Editar ofrecimiento"><i class="ph-bold ph-pencil-simple"></i></button>
            <button class="btn btn-danger btn-icon" type="button" data-upsell-del="${esc(offer.id)}" title="Eliminar ofrecimiento"><i class="ph-bold ph-trash"></i></button>
          </div>
        </div>
        <div class="upsell-offer-products">${chips}</div>
      </div>
    `;
  }).join('');

  host.querySelectorAll('[data-upsell-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const offer = CHATBOT_UPSELL_OFFERS.find((item) => item.id === button.dataset.upsellEdit);
      if (!offer) return;
      setUpsellEditorState(offer);
    });
  });

  host.querySelectorAll('[data-upsell-up]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = String(button.dataset.upsellUp || '');
      const idx = CHATBOT_UPSELL_OFFERS.findIndex((item) => item.id === id);
      if (idx <= 0) return;
      const next = [...CHATBOT_UPSELL_OFFERS];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      CHATBOT_UPSELL_OFFERS = next;
      renderUpsellOffersList();
      await persistUpsellOffersSettings();
      toast('Ofrecimiento movido hacia arriba');
    });
  });

  host.querySelectorAll('[data-upsell-down]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = String(button.dataset.upsellDown || '');
      const idx = CHATBOT_UPSELL_OFFERS.findIndex((item) => item.id === id);
      if (idx < 0 || idx >= CHATBOT_UPSELL_OFFERS.length - 1) return;
      const next = [...CHATBOT_UPSELL_OFFERS];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      CHATBOT_UPSELL_OFFERS = next;
      renderUpsellOffersList();
      await persistUpsellOffersSettings();
      toast('Ofrecimiento movido hacia abajo');
    });
  });

  host.querySelectorAll('[data-upsell-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const offer = CHATBOT_UPSELL_OFFERS.find((item) => item.id === button.dataset.upsellDel);
      if (!(await askConfirm('¿Eliminar ofrecimiento?', `Se eliminará el ofrecimiento: "${offer?.question || 'sin texto'}"`))) return;
      CHATBOT_UPSELL_OFFERS = CHATBOT_UPSELL_OFFERS.filter((item) => item.id !== button.dataset.upsellDel);
      if (String($('#botUpsellOfferId')?.value || '') === String(button.dataset.upsellDel)) {
        resetUpsellEditor();
      }
      if (!CHATBOT_UPSELL_OFFERS.length && $('#botUpsellEnabled')?.checked) {
        $('#botUpsellEnabled').checked = false;
      }
      await persistUpsellOffersSettings();
      toast('Ofrecimiento eliminado');
    });
  });
}

async function persistUpsellOffersSettings() {
  const enabled = $('#botUpsellEnabled')?.checked ? '1' : '0';
  const fd = new FormData();
  fd.append('chatbot_upsell_enabled', enabled);
  fd.append('chatbot_upsell_offers_json', JSON.stringify(CHATBOT_UPSELL_OFFERS));

  // Compatibilidad con llaves legacy para versiones previas.
  const first = CHATBOT_UPSELL_OFFERS[0];
  fd.append('chatbot_upsell_question', first?.question || '¿Deseas agregar alguno de estos productos a tu pedido?');
  fd.append('chatbot_upsell_product_ids', JSON.stringify(first?.productIds || []));

  await api('/api/settings', { method: 'PUT', body: fd });
  SETTINGS = await api('/api/settings');
}

function fillUpsellFormFromSettings() {
  const enabled = (SETTINGS?.chatbot_upsell_enabled || '0') === '1';
  if ($('#botUpsellEnabled')) $('#botUpsellEnabled').checked = enabled;

  const parsed = parseUpsellOffers(SETTINGS?.chatbot_upsell_offers_json || '[]');
  CHATBOT_UPSELL_OFFERS = parsed.length ? parsed : getLegacyUpsellOfferFromSettings();
  CHATBOT_UPSELL_OFFERS = normalizeUpsellOffersWithProducts(CHATBOT_UPSELL_OFFERS);

  resetUpsellEditor();
  renderUpsellOffersList();
}

async function loadUpsellProducts() {
  CHATBOT_UPSELL_PRODUCTS = await api('/api/products');
  CHATBOT_UPSELL_OFFERS = normalizeUpsellOffersWithProducts(CHATBOT_UPSELL_OFFERS);
  renderUpsellProductsPicker();
  renderUpsellOffersList();
}

function renderDeliveryZonesList() {
  const host = $('#deliveryZonesList');
  const pager = $('#deliveryZonesPager');
  if (!host) return;
  const visibleZones = getVisibleDeliveryZones();
  if (!visibleZones.length) {
    const emptyTitle = DELIVERY_ZONE_FILTER_BRANCH === 'all' ? 'Sin zonas aún' : 'Sin zonas para esta sucursal';
    const emptyText = DELIVERY_ZONE_FILTER_BRANCH === 'all'
      ? 'Dibuja tu primera zona y asígnale un costo de envío.'
      : 'Cambia de sucursal o crea una zona para este contexto.';
    host.innerHTML = emptyHTML('ph-map-pin', emptyTitle, emptyText);
    if (pager) pager.innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(visibleZones.length / DELIVERY_ZONES_PAGE_SIZE));
  if (DELIVERY_ZONES_PAGE > totalPages) DELIVERY_ZONES_PAGE = totalPages;
  const start = (DELIVERY_ZONES_PAGE - 1) * DELIVERY_ZONES_PAGE_SIZE;
  const pagedZones = visibleZones.slice(start, start + DELIVERY_ZONES_PAGE_SIZE);

  host.innerHTML = pagedZones.map((zone) => `
    <div class="delivery-zone-item">
      <div class="meta">
        <span class="swatch" style="background:${esc(zone.color)}"></span>
        <div class="meta-text">
          <b>${esc(zone.name)}</b>
          <small>${zone.points.length} puntos · ${fmtMoney(zone.fee)}</small>
          <div class="branch-tag"><i class="ph-bold ph-storefront"></i> ${esc(zoneBranchLabel(zone))}</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost btn-icon" type="button" data-delivery-zone-edit="${esc(zone.id)}" title="Editar zona"><i class="ph-bold ph-pencil-simple"></i></button>
        <button class="btn btn-danger btn-icon" type="button" data-delivery-zone-del="${esc(zone.id)}" title="Eliminar zona"><i class="ph-bold ph-trash"></i></button>
      </div>
    </div>
  `).join('');

  if (pager) {
    pager.innerHTML = totalPages > 1
      ? `
        <span class="hint">Página ${DELIVERY_ZONES_PAGE} de ${totalPages} · ${visibleZones.length} zonas</span>
        <div class="pager-actions">
          <button class="btn btn-ghost" type="button" id="deliveryZonesPrev" ${DELIVERY_ZONES_PAGE <= 1 ? 'disabled' : ''}><i class="ph-bold ph-caret-left"></i> Anterior</button>
          <button class="btn btn-ghost" type="button" id="deliveryZonesNext" ${DELIVERY_ZONES_PAGE >= totalPages ? 'disabled' : ''}>Siguiente <i class="ph-bold ph-caret-right"></i></button>
        </div>
      `
      : `<span class="hint">Mostrando ${visibleZones.length} zona${visibleZones.length === 1 ? '' : 's'}</span>`;

    $('#deliveryZonesPrev')?.addEventListener('click', () => {
      if (DELIVERY_ZONES_PAGE <= 1) return;
      DELIVERY_ZONES_PAGE -= 1;
      renderDeliveryZonesList();
    });
    $('#deliveryZonesNext')?.addEventListener('click', () => {
      if (DELIVERY_ZONES_PAGE >= totalPages) return;
      DELIVERY_ZONES_PAGE += 1;
      renderDeliveryZonesList();
    });
  }

  host.querySelectorAll('[data-delivery-zone-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const zone = DELIVERY_ZONES.find((item) => item.id === btn.dataset.deliveryZoneEdit);
      if (!zone) return;
      loadDeliveryZoneIntoEditor(zone);
    });
  });

  host.querySelectorAll('[data-delivery-zone-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      DELIVERY_ZONES = DELIVERY_ZONES.filter((z) => z.id !== btn.dataset.deliveryZoneDel);
      const nextPages = Math.max(1, Math.ceil(DELIVERY_ZONES.length / DELIVERY_ZONES_PAGE_SIZE));
      if (DELIVERY_ZONES_PAGE > nextPages) DELIVERY_ZONES_PAGE = nextPages;
      drawDeliveryZones();
      renderDeliveryZonesList();
      if ($('#deliveryZoneEditId')?.value === btn.dataset.deliveryZoneDel) resetDeliveryZoneEditor();
      await persistDeliveryZones('Zona eliminada');
    });
  });
}

function clearDeliveryDrawing() {
  DELIVERY_DRAW_POINTS = [];
  DELIVERY_DRAW_MARKERS.forEach((m) => m.remove());
  DELIVERY_DRAW_MARKERS = [];
  if (DELIVERY_DRAW_PREVIEW) {
    DELIVERY_DRAW_PREVIEW.remove();
    DELIVERY_DRAW_PREVIEW = null;
  }
}

function setDeliveryColor(color) {
  const normalized = String(color || '#0ea5e9').toLowerCase();
  const input = $('#deliveryZoneColor');
  if (input) input.value = normalized;
  const code = $('#deliveryColorCode');
  if (code) code.textContent = normalized.toUpperCase();
  document.querySelectorAll('.delivery-color-chip').forEach((chip) => {
    chip.classList.toggle('active', String(chip.dataset.color || '').toLowerCase() === normalized);
  });
}

function setDeliveryDrawingActive(active) {
  DELIVERY_DRAW_ACTIVE = Boolean(active);
  $('#deliveryStartDraw').innerHTML = DELIVERY_DRAW_ACTIVE
    ? '<i class="ph-bold ph-stop-circle"></i> Detener dibujo'
    : '<i class="ph-bold ph-pencil-simple-line"></i> Iniciar dibujo';
  $('#deliveryDrawHint').textContent = DELIVERY_DRAW_ACTIVE
    ? 'Dibujo activo: toca el mapa para crear puntos del polígono.'
    : 'Dibujo pausado. Puedes reactivarlo cuando quieras.';
}

function openDeliveryDrawHelpModal() {
  $('#deliveryDrawHelpModal')?.classList.add('show');
}

function closeDeliveryDrawHelpModal() {
  $('#deliveryDrawHelpModal')?.classList.remove('show');
}

function redrawDeliveryPreview() {
  if (!DELIVERY_ZONE_MAP) return;
  if (DELIVERY_DRAW_PREVIEW) {
    DELIVERY_DRAW_PREVIEW.remove();
    DELIVERY_DRAW_PREVIEW = null;
  }
  if (DELIVERY_DRAW_POINTS.length < 2) return;
  if (DELIVERY_DRAW_POINTS.length >= 3) {
    DELIVERY_DRAW_PREVIEW = L.polygon(DELIVERY_DRAW_POINTS, {
      color: $('#deliveryZoneColor')?.value || '#0ea5e9',
      weight: 2,
      fillOpacity: 0.2,
      dashArray: '6,6',
    }).addTo(DELIVERY_ZONE_MAP);
  } else {
    DELIVERY_DRAW_PREVIEW = L.polyline(DELIVERY_DRAW_POINTS, {
      color: $('#deliveryZoneColor')?.value || '#0ea5e9',
      weight: 2,
      dashArray: '6,6',
    }).addTo(DELIVERY_ZONE_MAP);
  }
}

function drawDeliveryZones() {
  if (!DELIVERY_ZONE_LAYER) return;
  DELIVERY_ZONE_LAYER.clearLayers();
  getVisibleDeliveryZones().forEach((zone) => {
    const polygon = L.polygon(zone.points, {
      color: zone.color || '#0ea5e9',
      weight: 2,
      fillOpacity: 0.22,
    }).addTo(DELIVERY_ZONE_LAYER);
    polygon.bindPopup(`<b>${esc(zone.name)}</b><br/>Sucursal: ${esc(zoneBranchLabel(zone))}<br/>Envío: ${fmtMoney(zone.fee)}`);
  });
  fitDeliveryZonesBounds();
}

function ensureDeliveryZoneMap() {
  if (DELIVERY_ZONE_MAP || !$('#deliveryZoneMap') || !globalThis.L) return;

  DELIVERY_ZONE_MAP = L.map('deliveryZoneMap', { zoomControl: true }).setView([20.6597, -103.3496], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: 'Leaflet | © OpenStreetMap',
    maxZoom: 19,
  }).addTo(DELIVERY_ZONE_MAP);
  DELIVERY_ZONE_LAYER = L.layerGroup().addTo(DELIVERY_ZONE_MAP);
  drawDeliveryZones();

  DELIVERY_ZONE_MAP.on('click', (e) => {
    if (!DELIVERY_DRAW_ACTIVE) return;
    DELIVERY_DRAW_POINTS.push([e.latlng.lat, e.latlng.lng]);
    DELIVERY_DRAW_MARKERS.push(L.circleMarker(e.latlng, { radius: 4, color: $('#deliveryZoneColor')?.value || '#0ea5e9', weight: 2, fillOpacity: 1 }).addTo(DELIVERY_ZONE_MAP));
    redrawDeliveryPreview();
    $('#deliveryDrawHint').textContent = `Puntos capturados: ${DELIVERY_DRAW_POINTS.length}. Necesitas mínimo 3 para guardar.`;
  });
}

function initDeliveryZoneModuleEvents() {
  $('#chatbotTabFlow')?.addEventListener('click', () => setChatbotSubtab('flow'));
  $('#chatbotTabDelivery')?.addEventListener('click', () => setChatbotSubtab('delivery'));
  $('#chatbotTabUpsell')?.addEventListener('click', () => setChatbotSubtab('upsell'));

  $('#deliveryStartDraw')?.addEventListener('click', () => {
    const next = !DELIVERY_DRAW_ACTIVE;
    setDeliveryDrawingActive(next);
    if (next && !DELIVERY_DRAW_HELP_SHOWN) {
      DELIVERY_DRAW_HELP_SHOWN = true;
      openDeliveryDrawHelpModal();
    }
  });

  $('#deliveryHelpClose')?.addEventListener('click', closeDeliveryDrawHelpModal);
  $('#deliveryHelpStart')?.addEventListener('click', () => {
    closeDeliveryDrawHelpModal();
    setDeliveryDrawingActive(true);
  });

  document.querySelectorAll('.delivery-color-chip').forEach((chip) => {
    chip.addEventListener('click', () => setDeliveryColor(chip.dataset.color));
  });
  $('#deliveryColorCustomBtn')?.addEventListener('click', () => $('#deliveryZoneColor')?.click());
  $('#deliveryZoneColor')?.addEventListener('input', (e) => setDeliveryColor(e.target.value));
  $('#deliveryZoneFilterBranch')?.addEventListener('change', (e) => {
    DELIVERY_ZONE_FILTER_BRANCH = e.target.value || 'all';
    DELIVERY_ZONES_PAGE = 1;
    renderDeliveryZonesList();
    drawDeliveryZones();
    if (DELIVERY_ZONE_FILTER_BRANCH !== 'all' && DELIVERY_ZONE_FILTER_BRANCH !== 'general' && $('#deliveryZoneBranch')) {
      $('#deliveryZoneBranch').value = DELIVERY_ZONE_FILTER_BRANCH;
    }
  });
  $('#deliveryCancelEdit')?.addEventListener('click', () => resetDeliveryZoneEditor());

  $('#deliveryUndoPoint')?.addEventListener('click', () => {
    if (!DELIVERY_DRAW_POINTS.length) return;
    DELIVERY_DRAW_POINTS.pop();
    const marker = DELIVERY_DRAW_MARKERS.pop();
    marker?.remove();
    redrawDeliveryPreview();
    $('#deliveryDrawHint').textContent = DELIVERY_DRAW_POINTS.length
      ? `Puntos capturados: ${DELIVERY_DRAW_POINTS.length}.`
      : 'Sin puntos capturados. Inicia dibujo y toca el mapa.';
  });

  $('#deliverySaveZone')?.addEventListener('click', async () => {
    const editId = ($('#deliveryZoneEditId')?.value || '').trim();
    const name = ($('#deliveryZoneName')?.value || '').trim();
    const fee = Number($('#deliveryZoneFee')?.value || '0');
    const color = $('#deliveryZoneColor')?.value || '#0ea5e9';
    const branchId = String($('#deliveryZoneBranch')?.value || '').trim();
    const branchName = branchId ? findBranchName(branchId) : '';
    if (!name) return toast('Escribe un nombre de zona', true);
    if (!Number.isFinite(fee) || fee < 0) return toast('El costo de envío no es válido', true);
    if (DELIVERY_DRAW_POINTS.length < 3) return toast('Dibuja al menos 3 puntos para formar la zona', true);

    const zonePayload = {
      id: editId || `zone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      fee,
      color,
      points: [...DELIVERY_DRAW_POINTS],
      active: true,
      branchId,
      branchName,
    };
    if (editId) {
      DELIVERY_ZONES = DELIVERY_ZONES.map((zone) => (zone.id === editId ? zonePayload : zone));
    } else {
      DELIVERY_ZONES.push(zonePayload);
    }
    if (DELIVERY_ZONE_FILTER_BRANCH !== 'all' && DELIVERY_ZONE_FILTER_BRANCH !== 'general' && branchId && DELIVERY_ZONE_FILTER_BRANCH !== branchId) {
      DELIVERY_ZONE_FILTER_BRANCH = branchId;
      if ($('#deliveryZoneFilterBranch')) $('#deliveryZoneFilterBranch').value = branchId;
    }
    DELIVERY_ZONES_PAGE = Math.max(1, Math.ceil(DELIVERY_ZONES.length / DELIVERY_ZONES_PAGE_SIZE));

    resetDeliveryZoneEditor();
    drawDeliveryZones();
    renderDeliveryZonesList();
    await persistDeliveryZones(editId ? 'Zona actualizada' : 'Zona guardada');
  });
}

async function fillBotForm() {
  if (!SETTINGS) return;
  const link = `${location.origin}/${SETTINGS.slug}`;
  $('#chatLink').value = link;
  $('#qrImg').src = `https://api.qrserver.com/v1/create-qr-code/?size=296x296&margin=8&data=${encodeURIComponent(link)}`;
  $('#waShareBtn').href = `https://wa.me/?text=${encodeURIComponent(`¡Haz tu pedido en ${SETTINGS.business_name}! 🍔 Ordena aquí: ${link}`)}`;
  $('#botWelcome').value = SETTINGS.welcome_message || '';
  $('#botWhatsapp').value = SETTINGS.whatsapp || '';
  $('#botDelivery').checked = SETTINGS.delivery_enabled === '1';
  $('#botPickup').checked = SETTINGS.pickup_enabled === '1';
  $('#botLocation').checked = SETTINGS.location_enabled !== '0';
  fillChatbotInfoOptionsFromSettings();
  DELIVERY_ZONES = parseDeliveryZones(SETTINGS.delivery_zones_geojson || '[]');
  DELIVERY_ZONES_PAGE = 1;
  DELIVERY_ZONE_FILTER_BRANCH = 'all';
  fillUpsellFormFromSettings();
  renderDeliveryBranchOptions();
  setDeliveryColor($('#deliveryZoneColor')?.value || '#0ea5e9');
  resetDeliveryZoneEditor();
  renderDeliveryZonesList();
  try {
    await loadUpsellProducts();
  } catch (err) {
    CHATBOT_UPSELL_PRODUCTS = [];
    renderUpsellProductsPicker();
    console.warn('[upsell] No se pudo cargar productos para upsell:', err?.message || err);
  }
  if (CHATBOT_SUBTAB === 'delivery') {
    ensureDeliveryZoneMap();
    drawDeliveryZones();
    setTimeout(() => {
      DELIVERY_ZONE_MAP?.invalidateSize();
      fitDeliveryZonesBounds();
    }, 80);
  }
  await loadBranches();
}
$('#copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#chatLink').value);
  toast('¡Liga copiada al portapapeles!');
});
$('#botForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!$('#botDelivery').checked && !$('#botPickup').checked) {
    return toast('Activa al menos una opción de entrega', true);
  }
  const fd = new FormData();
  fd.append('welcome_message', $('#botWelcome').value);
  fd.append('whatsapp', $('#botWhatsapp').value);
  fd.append('delivery_enabled', $('#botDelivery').checked ? '1' : '0');
  fd.append('pickup_enabled', $('#botPickup').checked ? '1' : '0');
  fd.append('location_enabled', $('#botLocation').checked ? '1' : '0');
  fd.append('chatbot_extra_options_json', JSON.stringify(CHATBOT_INFO_OPTIONS));
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Flujo del chatbot guardado');
  SETTINGS = await api('/api/settings');
});

$('#botInfoOptionSaveBtn')?.addEventListener('click', () => {
  const editId = String($('#botInfoOptionId')?.value || '').trim();
  const label = String($('#botInfoOptionLabel')?.value || '').trim().slice(0, 42);
  const message = String($('#botInfoOptionMessage')?.value || '').trim().slice(0, 300);
  const url = normalizeInfoUrl($('#botInfoOptionUrl')?.value || '');

  if (!label) return toast('Escribe el texto del botón', true);
  if (!message && !url) return toast('Agrega un mensaje o un enlace para esta opción', true);
  if ($('#botInfoOptionUrl')?.value && !url) return toast('El enlace no es válido. Usa formato https://...', true);

  const payload = {
    id: editId || `info_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label,
    message,
    url,
  };

  if (editId) {
    CHATBOT_INFO_OPTIONS = CHATBOT_INFO_OPTIONS.map((item) => (item.id === editId ? payload : item));
  } else {
    CHATBOT_INFO_OPTIONS.push(payload);
  }

  CHATBOT_INFO_OPTIONS = parseChatbotInfoOptions(JSON.stringify(CHATBOT_INFO_OPTIONS));
  renderChatbotInfoOptionsList();
  resetChatbotInfoEditor();
  toast(editId ? 'Opción actualizada (falta guardar flujo)' : 'Opción agregada (falta guardar flujo)');
});

$('#botInfoOptionNewBtn')?.addEventListener('click', () => {
  resetChatbotInfoEditor();
});

$('#upsellForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const enabled = $('#botUpsellEnabled')?.checked;
  const editId = String($('#botUpsellOfferId')?.value || '').trim();
  const question = String($('#botUpsellQuestion')?.value || '').trim();
  if (!question || question.length < 8) {
    return toast('Escribe una pregunta más clara para el ofrecimiento', true);
  }
  if (!CHATBOT_UPSELL_SELECTED.size) {
    return toast('Selecciona al menos un producto para este ofrecimiento', true);
  }

  const payload = {
    id: editId || `upsell_offer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    question: question.slice(0, 260),
    productIds: [...CHATBOT_UPSELL_SELECTED],
  };

  if (editId) {
    CHATBOT_UPSELL_OFFERS = CHATBOT_UPSELL_OFFERS.map((offer) => (offer.id === editId ? payload : offer));
  } else {
    CHATBOT_UPSELL_OFFERS.push(payload);
  }

  if (enabled && !CHATBOT_UPSELL_OFFERS.length) {
    return toast('Debes tener al menos un ofrecimiento guardado para activar esta función', true);
  }

  CHATBOT_UPSELL_OFFERS = normalizeUpsellOffersWithProducts(CHATBOT_UPSELL_OFFERS);
  await persistUpsellOffersSettings();
  renderUpsellOffersList();
  resetUpsellEditor();
  toast(editId ? 'Ofrecimiento actualizado' : 'Ofrecimiento guardado');
});

$('#upsellNewBtn')?.addEventListener('click', () => {
  resetUpsellEditor();
  toast('Listo para crear un nuevo ofrecimiento');
});

$('#botUpsellEnabled')?.addEventListener('change', async () => {
  if ($('#botUpsellEnabled').checked && !CHATBOT_UPSELL_OFFERS.length) {
    $('#botUpsellEnabled').checked = false;
    return toast('Primero guarda al menos un ofrecimiento para poder activarlo', true);
  }
  await persistUpsellOffersSettings();
  toast($('#botUpsellEnabled').checked ? 'Ofrecimiento inteligente activado' : 'Ofrecimiento inteligente desactivado');
});

initDeliveryZoneModuleEvents();

/* ===== Sucursales ===== */
function branchesTableHTML(rows) {
  if (!rows.length) return emptyHTML('ph-buildings', 'Aún no hay sucursales', 'Agrega la primera para pedidos de recogida.');
  const body = rows
    .map(
      (b) => `<tr>
      <td><b>${esc(b.name)}</b></td>
      <td>${esc(b.address)}</td>
      <td>${esc(b.reference || '—')}</td>
      <td><span class="badge ${b.active ? 'b-entregado' : 'b-cancelado'}">${b.active ? 'Activa' : 'Inactiva'}</span></td>
      <td style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" data-edit-branch="${b.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button>
        <button class="btn btn-danger btn-icon" data-del-branch="${b.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
      </td>
    </tr>`
    )
    .join('');
  return `<table><thead><tr><th>Nombre</th><th>Dirección</th><th>Referencia</th><th>Estatus</th><th style="text-align:right">Acciones</th></tr></thead><tbody>${body}</tbody></table>`;
}

async function loadBranches() {
  BRANCHES = await api('/api/branches');
  renderDeliveryBranchOptions();
  renderDeliveryZonesList();
  drawDeliveryZones();
  $('#branchTable').innerHTML = branchesTableHTML(BRANCHES);
  document.querySelectorAll('[data-edit-branch]').forEach((b) =>
    b.addEventListener('click', () => openBranchModal(BRANCHES.find((x) => x.id == b.dataset.editBranch)))
  );
  document.querySelectorAll('[data-del-branch]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await askConfirm('¿Eliminar sucursal?', 'Dejará de aparecer en pedidos para recoger.'))) return;
      await api(`/api/branches/${b.dataset.delBranch}`, { method: 'DELETE' });
      toast('Sucursal eliminada');
      loadBranches();
    })
  );
}

function openBranchModal(branch = null) {
  $('#branchModalTitle').innerHTML = branch
    ? '<i class="ph-bold ph-pencil-simple"></i> Editar sucursal'
    : '<i class="ph-bold ph-buildings"></i> Nueva sucursal';
  $('#branchId').value = branch ? branch.id : '';
  $('#branchName').value = branch ? branch.name : '';
  $('#branchAddress').value = branch ? branch.address : '';
  $('#branchReference').value = branch ? branch.reference || '' : '';
  $('#branchActive').checked = branch ? !!branch.active : true;
  $('#branchModal').classList.add('show');
}

$('#addBranchBtn').addEventListener('click', () => openBranchModal());
$('#branchCancel').addEventListener('click', () => $('#branchModal').classList.remove('show'));
$('#branchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#branchId').value;
  const payload = {
    name: $('#branchName').value,
    address: $('#branchAddress').value,
    reference: $('#branchReference').value,
    active: $('#branchActive').checked ? 1 : 0,
  };
  await api(id ? `/api/branches/${id}` : '/api/branches', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  $('#branchModal').classList.remove('show');
  toast(id ? 'Sucursal actualizada' : 'Sucursal creada');
  loadBranches();
});

$('#addCashierBtn')?.addEventListener('click', async () => {
  try {
    await ensureBranchesLoaded();
    if (!BRANCHES.length) return toast('Primero crea al menos una sucursal activa', true);
    openCashierModal();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#cashierCancel')?.addEventListener('click', () => $('#cashierModal').classList.remove('show'));
$('#cashierSlug')?.addEventListener('input', syncCashierLinkPreview);

$('#cashierForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = Number($('#cashierId')?.value || 0);
  const payload = {
    displayName: $('#cashierDisplayName').value,
    username: $('#cashierUsername').value,
    branchId: Number($('#cashierBranch').value || 0),
    cashierSlug: $('#cashierSlug').value,
    password: $('#cashierPassword').value,
    active: $('#cashierActive').checked ? 1 : 0,
  };
  if (!id && String(payload.password || '').trim().length < 8) {
    return toast('La contraseña del cajero debe tener al menos 8 caracteres', true);
  }
  await api(id ? `/api/cashiers/${id}` : '/api/cashiers', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  $('#cashierModal').classList.remove('show');
  toast(id ? 'Cajero actualizado' : 'Cajero creado');
  await loadCashiers();
});

/* ===== Mi negocio ===== */
const PALETTE = ['#ff6b35', '#e11d48', '#d97706', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#171c2e'];

function renderSwatches() {
  const current = $('#cfgColor').value;
  $('#swatches').innerHTML =
    PALETTE.map(
      (c) => `<button type="button" class="swatch ${c === current ? 'on' : ''}" style="background:${c}" data-color="${c}"></button>`
    ).join('') + `<input type="color" class="swatch-custom" id="customColor" value="${current}" title="Color personalizado" />`;
  document.querySelectorAll('.swatch').forEach((b) =>
    b.addEventListener('click', () => {
      $('#cfgColor').value = b.dataset.color;
      renderSwatches();
    })
  );
  $('#customColor').addEventListener('input', (e) => {
    $('#cfgColor').value = e.target.value;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
  });
}

function fillConfigForm() {
  if (!SETTINGS) return;
  $('#cfgName').value = SETTINGS.business_name || '';
  $('#cfgColor').value = SETTINGS.primary_color || '#ff6b35';
  $('#cfgAddress').value = SETTINGS.address || '';
  $('#cfgHours').value = SETTINGS.hours || '';
  $('#cfgCurrency').value = SETTINGS.currency || 'MXN';
  $('#cfgChatPayDeliveryCash').checked = (SETTINGS.chatbot_payment_delivery_cash || '1') === '1';
  $('#cfgChatPayDeliveryTransfer').checked = (SETTINGS.chatbot_payment_delivery_transfer || '0') === '1';
  $('#cfgChatPayDeliveryCard').checked = (SETTINGS.chatbot_payment_delivery_card || '0') === '1';
  $('#cfgChatPayPickupCash').checked = (SETTINGS.chatbot_payment_pickup_cash || '1') === '1';
  $('#cfgChatPayPickupTransfer').checked = (SETTINGS.chatbot_payment_pickup_transfer || '0') === '1';
  $('#cfgChatPayPickupCard').checked = (SETTINGS.chatbot_payment_pickup_card || '0') === '1';
  $('#cfgPosChatIntegration').checked = (SETTINGS.chatbot_pos_integration_enabled || '0') === '1';
  $('#cfgTicketWidth').value = String(Number(SETTINGS.ticket_width_mm || 80));
  $('#cfgTicketFont').value = String(Number(SETTINGS.ticket_font_size_px || 14));
  $('#cfgTicketLineHeight').value = String(Number(SETTINGS.ticket_line_height || 1.45));
  $('#cfgTicketShowLogo').value = SETTINGS.ticket_show_logo === '0' ? '0' : '1';
  $('#cfgTicketPrintMode').value = SETTINGS.ticket_print_mode === 'bluetooth' ? 'bluetooth' : 'thermal';
  $('#cfgTicketMobileZoom').value = String(Math.max(80, Math.min(120, Number(SETTINGS.ticket_mobile_zoom_percent || 100))));
  $('#logoPreview').innerHTML = SETTINGS.logo ? `<img src="${esc(SETTINGS.logo)}" alt="" />` : '<i class="ph ph-image"></i>';
  renderSwatches();
  if (!isCashierUser()) loadCashiers().catch((err) => toast(err.message, true));
}
$('#cfgLogo').addEventListener('change', () => {
  const f = $('#cfgLogo').files[0];
  if (f) $('#logoPreview').innerHTML = `<img src="${URL.createObjectURL(f)}" alt="" />`;
});
$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('business_name', $('#cfgName').value);
  fd.append('primary_color', $('#cfgColor').value);
  if ($('#cfgLogo').files[0]) fd.append('logo', $('#cfgLogo').files[0]);
  try {
    await api('/api/settings', { method: 'PUT', body: fd });
    toast('Identidad guardada');
    await boot(false);
    fillConfigForm();
  } catch (err) {
    toast(err.message, true);
  }
});
$('#contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deliveryEnabled = $('#botDelivery') ? $('#botDelivery').checked : true;
  const pickupEnabled = $('#botPickup') ? $('#botPickup').checked : true;
  const hasDeliveryPayment = $('#cfgChatPayDeliveryCash').checked || $('#cfgChatPayDeliveryTransfer').checked || $('#cfgChatPayDeliveryCard').checked;
  const hasPickupPayment = $('#cfgChatPayPickupCash').checked || $('#cfgChatPayPickupTransfer').checked || $('#cfgChatPayPickupCard').checked;
  if (deliveryEnabled && !hasDeliveryPayment) {
    return toast('Activa al menos un medio de pago para domicilio', true);
  }
  if (pickupEnabled && !hasPickupPayment) {
    return toast('Activa al menos un medio de pago para recoger en sucursal', true);
  }
  const fd = new FormData();
  fd.append('address', $('#cfgAddress').value);
  fd.append('hours', $('#cfgHours').value);
  fd.append('currency', $('#cfgCurrency').value);
  fd.append('chatbot_payment_delivery_cash', $('#cfgChatPayDeliveryCash').checked ? '1' : '0');
  fd.append('chatbot_payment_delivery_transfer', $('#cfgChatPayDeliveryTransfer').checked ? '1' : '0');
  fd.append('chatbot_payment_delivery_card', $('#cfgChatPayDeliveryCard').checked ? '1' : '0');
  fd.append('chatbot_payment_pickup_cash', $('#cfgChatPayPickupCash').checked ? '1' : '0');
  fd.append('chatbot_payment_pickup_transfer', $('#cfgChatPayPickupTransfer').checked ? '1' : '0');
  fd.append('chatbot_payment_pickup_card', $('#cfgChatPayPickupCard').checked ? '1' : '0');
  fd.append('chatbot_pos_integration_enabled', $('#cfgPosChatIntegration').checked ? '1' : '0');
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Datos de contacto guardados');
  SETTINGS = await api('/api/settings');
  fillConfigForm();
});

$('#ticketForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('ticket_width_mm', $('#cfgTicketWidth').value);
  fd.append('ticket_font_size_px', $('#cfgTicketFont').value);
  fd.append('ticket_line_height', $('#cfgTicketLineHeight').value);
  fd.append('ticket_show_logo', $('#cfgTicketShowLogo').value);
  fd.append('ticket_print_mode', $('#cfgTicketPrintMode').value);
  fd.append('ticket_mobile_zoom_percent', $('#cfgTicketMobileZoom').value);
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Configuración de ticket guardada');
  SETTINGS = await api('/api/settings');
});

/* ===== Helpers ===== */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function ensureBranchesLoaded() {
  if (BRANCHES.length) return BRANCHES;
  BRANCHES = await api('/api/branches');
  return BRANCHES;
}

function cashierLinkUrl(cashierSlug) {
  return `${location.origin}/caja/${cashierSlug}`;
}

function syncCashierBranchOptions(selected = '') {
  const select = $('#cashierBranch');
  if (!select) return;
  select.innerHTML = ['<option value="">Selecciona una sucursal</option>']
    .concat(BRANCHES.map((branch) => `<option value="${esc(String(branch.id))}">${esc(branch.name)}</option>`))
    .join('');
  select.value = selected || '';
}

function syncCashierLinkPreview() {
  const slug = String($('#cashierSlug')?.value || '').trim().toLowerCase();
  const preview = $('#cashierLinkPreview');
  if (!preview) return;
  preview.innerHTML = slug
    ? `<span class="cashier-link-preview"><i class="ph-bold ph-link"></i> ${esc(cashierLinkUrl(slug))}</span>`
    : 'La caja estará disponible en /caja/...';
}

function cashiersTableHTML(rows) {
  if (!rows.length) return emptyHTML('ph-users-three', 'Aún no hay cajeros', 'Crea un cajero por sucursal para abrir una caja dedicada con su propia liga.');
  const body = rows.map((cashier) => `
    <tr>
      <td><b>${esc(cashier.displayName || cashier.username)}</b><div style="font-size:12px;color:var(--ink-3)">@${esc(cashier.username)}</div></td>
      <td><span class="cashier-chip"><i class="ph-bold ph-storefront"></i>${esc(cashier.branchName || 'Sin sucursal')}</span></td>
      <td><a href="${esc(cashierLinkUrl(cashier.cashierSlug))}" target="_blank">${esc(cashier.cashierSlug)}</a></td>
      <td><span class="badge ${cashier.active ? 'b-entregado' : 'b-cancelado'}">${cashier.active ? 'Activo' : 'Inactivo'}</span></td>
      <td style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
        <button class="btn btn-ghost" type="button" data-copy-cashier-link="${esc(cashier.cashierSlug)}"><i class="ph-bold ph-copy"></i> Copiar link</button>
        <button class="btn btn-ghost" type="button" data-edit-cashier="${cashier.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button>
        <button class="btn btn-danger btn-icon" type="button" data-del-cashier="${cashier.id}" title="Eliminar cajero"><i class="ph-bold ph-trash"></i></button>
      </td>
    </tr>`).join('');
  return `<table><thead><tr><th>Cajero</th><th>Sucursal</th><th>Liga de caja</th><th>Estatus</th><th style="text-align:right">Acciones</th></tr></thead><tbody>${body}</tbody></table>`;
}

async function loadCashiers() {
  if (isCashierUser()) return;
  await ensureBranchesLoaded();
  CASHIERS = await api('/api/cashiers');
  const host = $('#cashiersTable');
  if (!host) return;
  host.innerHTML = cashiersTableHTML(CASHIERS);
  document.querySelectorAll('[data-copy-cashier-link]').forEach((button) =>
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(cashierLinkUrl(button.dataset.copyCashierLink));
      toast('Liga de caja copiada');
    })
  );
  document.querySelectorAll('[data-edit-cashier]').forEach((button) =>
    button.addEventListener('click', () => openCashierModal(CASHIERS.find((item) => Number(item.id) === Number(button.dataset.editCashier))))
  );
  document.querySelectorAll('[data-del-cashier]').forEach((button) =>
    button.addEventListener('click', async () => {
      const cashier = CASHIERS.find((item) => Number(item.id) === Number(button.dataset.delCashier));
      if (!(await askConfirm('¿Eliminar cajero?', `Se eliminará el acceso de caja de ${cashier?.displayName || 'este cajero'}.`))) return;
      await api(`/api/cashiers/${button.dataset.delCashier}`, { method: 'DELETE' });
      toast('Cajero eliminado');
      await loadCashiers();
    })
  );
}

function openCashierModal(cashier = null) {
  $('#cashierModalTitle').innerHTML = cashier
    ? '<i class="ph-bold ph-pencil-simple"></i> Editar cajero'
    : '<i class="ph-bold ph-user-plus"></i> Nuevo cajero';
  $('#cashierId').value = cashier ? cashier.id : '';
  $('#cashierDisplayName').value = cashier ? cashier.displayName : '';
  $('#cashierUsername').value = cashier ? cashier.username : '';
  $('#cashierSlug').value = cashier ? cashier.cashierSlug : '';
  $('#cashierPassword').value = '';
  $('#cashierActive').checked = cashier ? Boolean(cashier.active) : true;
  syncCashierBranchOptions(cashier?.branchId ? String(cashier.branchId) : '');
  syncCashierLinkPreview();
  $('#cashierModal').classList.add('show');
}

/* ===== Boot ===== */
async function boot(navigateToHash = true) {
  const scopeFromUrl = String(new URLSearchParams(location.search).get('scope') || '').trim().toLowerCase();
  if (scopeFromUrl === 'owner' || scopeFromUrl === 'cashier') {
    setAuthScope(scopeFromUrl);
    const cleanUrl = `${location.pathname}${location.hash || ''}`;
    history.replaceState(null, '', cleanUrl);
  }

  ME = await api('/api/auth/me');
  if (ME?.role === 'cashier') setAuthScope('cashier');
  if (ME?.role === 'owner') setAuthScope('owner');
  SETTINGS = await api('/api/settings');
  POS_PRODUCT_SORT = normalizePosSortMode(SETTINGS?.pos_catalog_sort_mode || readStoredPosSortMode());
  saveStoredPosSortMode(POS_PRODUCT_SORT);
  applyUserScopeUI();

  document.documentElement.style.setProperty('--primary', ME.tenant.primaryColor || '#ff6b35');
  const cashier = isCashierUser();

  const defaultBrandLogo = '/static/chatbotpro100.png';
  const tenantLogo = String(ME?.tenant?.logo || '').trim();
  const safeTenantLogo = esc(tenantLogo);
  const brandLogoSrc = tenantLogo || defaultBrandLogo;

  $('#brandMark').innerHTML = `<img src="${esc(brandLogoSrc)}" alt="ChatBotPro" onerror="this.onerror=null;this.src='${defaultBrandLogo}'" />`;
  $('#avatar').innerHTML = `<img src="${safeTenantLogo || defaultBrandLogo}" alt="" onerror="this.onerror=null;this.src='${defaultBrandLogo}'" />`;
  $('#brandName').textContent = cashier ? (ME.branchName || ME.tenant.businessName) : ME.tenant.businessName;
  $('#userBizName').textContent = cashier ? (ME.branchName || ME.tenant.businessName) : ME.tenant.businessName;
  $('#userName').textContent = cashier ? `@${ME.username} · cajero` : `@${ME.username}`;
  $('#openChatLink').href = `/${ME.tenant.slug}`;
  loadOrderSoundPreference();
  syncOrdersSoundToggleUI();
  startOrdersRealtimeMonitor();

  if (navigateToHash) {
    const fallbackView = cashier ? 'pos' : 'dashboard';
    const hashView = (location.hash || '').slice(1);
    const view = cashier ? 'pos' : (VIEW_META[hashView] ? hashView : fallbackView);
    document.body.setAttribute('data-current-view', view);
    navigate(view);
  }
}

boot()
  .catch(() => (location.href = '/login'))
  .finally(() => {
    const l = $('#bootLoader');
    l.classList.add('hide');
    setTimeout(() => l.remove(), 350);
  });

/* ═══════════════════════════════════════════════════════════════
   MÓDULO INVENTARIOS
   ═══════════════════════════════════════════════════════════════ */
let INV_DATA = [];          // filas actuales del resumen
let INV_PRODUCTS = [];      // lista de productos activos para selects
let INV_SEARCH = '';
let INV_EXPORT_FMT = 'csv';
const INV_PAGE_SIZE = 10;
let INV_PAGE = 1;
let INV_PERIOD = 'all';
let INV_START_DATE = '';
let INV_END_DATE = '';
let INV_SORT_KEY = 'product_name';
let INV_SORT_DIR = 'asc';

const INV_PERIOD_HINTS = {
  all: 'Mostrando acumulado desde el ultimo corte (fisico real a inicial).',
  today: 'Mostrando datos historicos de hoy.',
  week: 'Mostrando historico de la semana.',
  month: 'Mostrando historico del mes.',
  custom: 'Mostrando historico del rango personalizado.',
};

/* ── helpers numéricos ── */
function invFmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString('es-MX', { maximumFractionDigits: 2 }) : '—';
}

function invDiffClass(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (n < 0) return 'inv-diff-neg';
  if (n > 0) return 'inv-diff-pos';
  return 'inv-diff-zero';
}

/* ── cargar y renderizar tabla ── */
async function loadInventarios() {
  try {
    const params = new URLSearchParams();
    if (INV_PERIOD !== 'all') params.set('period', INV_PERIOD);
    if (INV_PERIOD === 'custom' && INV_START_DATE && INV_END_DATE) {
      params.set('startDate', INV_START_DATE);
      params.set('endDate', INV_END_DATE);
    }
    const path = params.toString() ? `/api/inventory?${params.toString()}` : '/api/inventory';
    const payload = await api(path);
    INV_DATA = Array.isArray(payload) ? payload : (payload.rows || []);
    INV_PRODUCTS = INV_DATA.map((r) => ({ id: r.product_id, name: r.product_name }));
    if (INV_PAGE < 1) INV_PAGE = 1;
    renderInvTable();
    bindInvSearchFilter();
    bindInvPeriodControls();
    bindInvPagerControls();
    bindInvSortHeaders();
    buildInvMovProductSelect();
    buildInvMovHistFilter();
    updateInvPeriodHint();
  } catch (err) {
    toast(err.message || 'Error al cargar inventarios', true);
  }
}

function filteredInvData() {
  const base = !INV_SEARCH
    ? [...INV_DATA]
    : INV_DATA.filter((r) => r.product_name.toLowerCase().includes(INV_SEARCH.toLowerCase()));
  base.sort(compareInvRows);
  return base;
}

function getInvSortValue(row, key) {
  if (key === 'product_name') return String(row.product_name || '').toLowerCase();
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : String(value).toLowerCase();
}

function compareInvRows(a, b) {
  const va = getInvSortValue(a, INV_SORT_KEY);
  const vb = getInvSortValue(b, INV_SORT_KEY);

  // Nulls at bottom for both directions
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;

  let cmp = 0;
  if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb), 'es', { sensitivity: 'base', numeric: true });
  if (cmp === 0) {
    // Stable fallback by product name
    return String(a.product_name || '').localeCompare(String(b.product_name || ''), 'es', { sensitivity: 'base', numeric: true });
  }
  return INV_SORT_DIR === 'asc' ? cmp : -cmp;
}

function bindInvSortHeaders() {
  const table = $('#invTable');
  if (!table) return;
  const heads = table.querySelectorAll('th.inv-sortable[data-inv-sort]');
  heads.forEach((th) => {
    if (!th._invSortBound) {
      th._invSortBound = true;
      th.addEventListener('click', () => {
        const key = th.dataset.invSort;
        if (!key) return;
        if (INV_SORT_KEY === key) {
          INV_SORT_DIR = INV_SORT_DIR === 'asc' ? 'desc' : 'asc';
        } else {
          INV_SORT_KEY = key;
          INV_SORT_DIR = key === 'product_name' ? 'asc' : 'desc';
        }
        INV_PAGE = 1;
        renderInvTable();
      });
    }

    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.invSort === INV_SORT_KEY) {
      th.classList.add(INV_SORT_DIR === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function renderInvTable() {
  const tbody = $('#invTbody');
  if (!tbody) return;
  bindInvSortHeaders();
  const rows = filteredInvData();
  const totalPages = Math.max(1, Math.ceil(rows.length / INV_PAGE_SIZE));
  if (INV_PAGE > totalPages) INV_PAGE = totalPages;
  const start = (INV_PAGE - 1) * INV_PAGE_SIZE;
  const rowsPage = rows.slice(start, start + INV_PAGE_SIZE);
  syncInvPager(totalPages);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-cell">Sin resultados</td></tr>`;
    return;
  }
  tbody.innerHTML = rowsPage.map((r) => {
    const diffClass = invDiffClass(r.diferencia);
    return `<tr data-pid="${r.product_id}">
      <td class="inv-prod-name">
        <b>${esc(r.product_name)}</b>
        <span class="inv-unit">${esc(r.unit || 'pcs')}</span>
      </td>
      <td class="num">
        <button class="inv-init-btn btn-link-plain" data-pid="${r.product_id}" title="Editar inventario inicial">${invFmt(r.initial_stock)}</button>
      </td>
      <td class="num inv-col-entrada">${invFmt(r.entradas)}</td>
      <td class="num inv-col-merma">${invFmt(r.mermas)}</td>
      <td class="num inv-col-ventas">${invFmt(r.ventas)}</td>
      <td class="num inv-col-sistema"><b>${invFmt(r.fisico_sistema)}</b></td>
      <td class="num inv-col-real">
        ${r.fisico_real !== null ? invFmt(r.fisico_real) : '<span class="inv-no-count">Sin conteo</span>'}
      </td>
      <td class="num inv-col-diff ${diffClass}">
        ${r.diferencia !== null ? invFmt(r.diferencia) : '—'}
      </td>
      <td class="inv-row-actions">
        <button class="btn btn-ghost btn-sm inv-btn-entrada-row" data-pid="${r.product_id}" title="Agregar entrada"><i class="ph-bold ph-arrow-fat-line-down"></i></button>
        <button class="btn btn-ghost btn-sm inv-btn-merma-row" data-pid="${r.product_id}" title="Agregar merma"><i class="ph-bold ph-warning-diamond"></i></button>
        <button class="btn btn-ghost btn-sm inv-btn-apply-real-row" data-pid="${r.product_id}" title="Pasar físico real a inicial" ${r.fisico_real === null ? 'disabled' : ''}><i class="ph-bold ph-arrows-counter-clockwise"></i></button>
        <button class="btn btn-ghost btn-sm inv-btn-hist-row" data-pid="${r.product_id}" title="Ver movimientos"><i class="ph-bold ph-clock-clockwise"></i></button>
      </td>
    </tr>`;
  }).join('');

  /* delegación de eventos de la tabla */
  tbody.querySelectorAll('.inv-init-btn').forEach((btn) =>
    btn.addEventListener('click', () => openInvInitModal(Number(btn.dataset.pid)))
  );
  tbody.querySelectorAll('.inv-btn-entrada-row').forEach((btn) =>
    btn.addEventListener('click', () => openInvMovModal('entrada', Number(btn.dataset.pid)))
  );
  tbody.querySelectorAll('.inv-btn-merma-row').forEach((btn) =>
    btn.addEventListener('click', () => openInvMovModal('merma', Number(btn.dataset.pid)))
  );
  tbody.querySelectorAll('.inv-btn-apply-real-row').forEach((btn) =>
    btn.addEventListener('click', () => applyRealToInitial(Number(btn.dataset.pid)))
  );
  tbody.querySelectorAll('.inv-btn-hist-row').forEach((btn) =>
    btn.addEventListener('click', () => openInvMovHistModal(Number(btn.dataset.pid)))
  );
}

function bindInvSearchFilter() {
  const input = $('#invSearch');
  if (!input || input._invBound) return;
  input._invBound = true;
  input.addEventListener('input', () => {
    INV_SEARCH = input.value.trim();
    INV_PAGE = 1;
    renderInvTable();
  });
}

function syncInvPager(totalPages) {
  const info = $('#invPageInfo');
  if (info) info.textContent = `${INV_PAGE} / ${totalPages}`;
  const prev = $('#invPrevPage');
  const next = $('#invNextPage');
  if (prev) prev.disabled = INV_PAGE <= 1;
  if (next) next.disabled = INV_PAGE >= totalPages;
}

function bindInvPagerControls() {
  const prev = $('#invPrevPage');
  const next = $('#invNextPage');
  if (prev && !prev._invBound) {
    prev._invBound = true;
    prev.addEventListener('click', () => {
      if (INV_PAGE <= 1) return;
      INV_PAGE -= 1;
      renderInvTable();
    });
  }
  if (next && !next._invBound) {
    next._invBound = true;
    next.addEventListener('click', () => {
      const total = Math.max(1, Math.ceil(filteredInvData().length / INV_PAGE_SIZE));
      if (INV_PAGE >= total) return;
      INV_PAGE += 1;
      renderInvTable();
    });
  }
}

function bindInvPeriodControls() {
  const wrap = $('#invPeriodFilters');
  if (!wrap || wrap._invBound) return;
  wrap._invBound = true;

  const today = new Date().toISOString().slice(0, 10);
  const startInput = $('#invStartDate');
  const endInput = $('#invEndDate');
  if (startInput && !startInput.value) startInput.value = today;
  if (endInput && !endInput.value) endInput.value = today;
  if (!INV_START_DATE) INV_START_DATE = startInput?.value || '';
  if (!INV_END_DATE) INV_END_DATE = endInput?.value || '';

  wrap.querySelectorAll('button[data-inv-period]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const period = btn.dataset.invPeriod;
      INV_PERIOD = period;
      INV_PAGE = 1;
      wrap.querySelectorAll('button[data-inv-period]').forEach((b) => b.classList.toggle('on', b === btn));
      const customWrap = $('#invCustomRange');
      if (customWrap) customWrap.hidden = period !== 'custom';
      updateInvPeriodHint();
      if (period !== 'custom') {
        await loadInventarios();
      }
    });
  });

  const applyBtn = $('#invApplyRangeBtn');
  if (applyBtn && !applyBtn._invBound) {
    applyBtn._invBound = true;
    applyBtn.addEventListener('click', async () => {
      const start = $('#invStartDate')?.value || '';
      const end = $('#invEndDate')?.value || '';
      if (!start || !end) {
        toast('Selecciona fecha inicial y final', true);
        return;
      }
      if (start > end) {
        toast('La fecha inicial no puede ser mayor que la final', true);
        return;
      }
      INV_START_DATE = start;
      INV_END_DATE = end;
      INV_PAGE = 1;
      await loadInventarios();
    });
  }
}

function updateInvPeriodHint() {
  const hint = $('#invPeriodHint');
  if (!hint) return;
  if (INV_PERIOD === 'custom' && INV_START_DATE && INV_END_DATE) {
    hint.textContent = `Mostrando del ${INV_START_DATE} al ${INV_END_DATE}.`;
    return;
  }
  hint.textContent = INV_PERIOD_HINTS[INV_PERIOD] || INV_PERIOD_HINTS.all;
}

function buildInvPeriodPayload() {
  const payload = {};
  if (INV_PERIOD !== 'all') payload.period = INV_PERIOD;
  if (INV_PERIOD === 'custom' && INV_START_DATE && INV_END_DATE) {
    payload.startDate = INV_START_DATE;
    payload.endDate = INV_END_DATE;
  }
  return payload;
}

async function applyRealToInitial(productId = null, options = {}) {
  const logAdjustment = Boolean(options.logAdjustment);
  const closureNote = String(options.closureNote || '').trim();
  const isSingle = Number(productId) > 0;
  const title = isSingle
    ? 'Aplicar físico real a inventario inicial'
    : (logAdjustment ? 'Cierre de periodo con ajuste auditable' : 'Aplicar físico real a inicial (global)');
  const msg = isSingle
    ? 'Se actualizará el inventario inicial del producto con su último físico real. ¿Continuar?'
    : (logAdjustment
      ? 'Se aplicará físico real a inventario inicial de todos los productos con conteo y se guardará una bitácora auditable del cierre. ¿Continuar?'
      : 'Se actualizará el inventario inicial de todos los productos con su último físico real. ¿Continuar?');
  const ok = await askConfirm(title, msg, { yesLabel: '<i class="ph-bold ph-check"></i> Sí, aplicar' });
  if (!ok) return;
  try {
    const payload = {
      ...(isSingle ? { product_id: Number(productId) } : {}),
      ...buildInvPeriodPayload(),
    };
    if (logAdjustment) {
      payload.logAdjustment = true;
      payload.closure_note = closureNote || `Cierre de ${INV_PERIOD === 'all' ? 'acumulado general' : INV_PERIOD}`;
    }
    const res = await api('/api/inventory/apply-real-to-initial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await loadInventarios();
    if (logAdjustment) {
      toast(`Cierre aplicado: ${res.updated || 0} actualizados · ${res.logged || 0} en bitácora`);
    } else {
      toast(`Inventario inicial actualizado (${res.updated || 0})`);
    }
  } catch (err) {
    toast(err.message || 'No se pudo aplicar físico real', true);
  }
}

function askInvClosureNote() {
  return new Promise((resolve) => {
    const modal = $('#invClosureModal');
    const input = $('#invClosureNote');
    const auditToggle = $('#invClosureAuditToggle');
    const error = $('#invClosureError');
    const btnCancel = $('#invClosureCancel');
    const btnConfirm = $('#invClosureConfirm');
    if (!modal || !input || !btnCancel || !btnConfirm || !auditToggle) {
      resolve({ note: '', logAdjustment: false });
      return;
    }

    input.value = '';
    auditToggle.checked = true;
    if (error) error.textContent = '';
    openModal('invClosureModal');
    setTimeout(() => input.focus(), 70);

    const done = (value, cancelled = false) => {
      closeModal('invClosureModal');
      modal.onclick = null;
      btnCancel.onclick = null;
      btnConfirm.onclick = null;
      input.oninput = null;
      auditToggle.onchange = null;
      if (cancelled) resolve(null);
      else resolve({
        note: String(value || '').trim(),
        logAdjustment: Boolean(auditToggle.checked),
      });
    };

    modal.onclick = (e) => {
      if (e.target === modal) done(null, true);
    };

    input.oninput = () => {
      if (error) error.textContent = '';
    };

    auditToggle.onchange = () => {
      if (auditToggle.checked) {
        input.placeholder = 'Ej. Corte semanal de almacén, validado contra conteo físico de cocina y barra.';
      } else {
        input.placeholder = 'Nota opcional interna';
      }
    };

    btnCancel.onclick = () => done(null, true);
    btnConfirm.onclick = () => done(input.value || '', false);
  });
}

function buildInvMovProductSelect() {
  const sel = $('#invMovProduct');
  if (!sel) return;
  sel.innerHTML = '<option value="">Selecciona producto…</option>' +
    INV_PRODUCTS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

function buildInvMovHistFilter() {
  const sel = $('#invMovHistFilter');
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos los productos</option>' +
    INV_PRODUCTS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

/* ── Modal: inventario inicial ── */
function openInvInitModal(productId) {
  const row = INV_DATA.find((r) => r.product_id === productId);
  if (!row) return;
  $('#invInitProductId').value = productId;
  $('#invInitProductName').value = row.product_name;
  $('#invInitStock').value = row.initial_stock ?? 0;
  $('#invInitUnit').value = row.unit || 'pcs';
  $('#invInitNotes').value = '';
  openModal('invInitModal');
}

$('#invInitForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/inventory/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: Number($('#invInitProductId').value),
        initial_stock: Number($('#invInitStock').value),
        unit: $('#invInitUnit').value,
        notes: $('#invInitNotes').value,
      }),
    });
    closeModal('invInitModal');
    await loadInventarios();
    toast('Inventario inicial guardado');
  } catch (err) {
    toast(err.message || 'Error al guardar', true);
  }
});
$('#invInitCancel')?.addEventListener('click', () => closeModal('invInitModal'));

/* ── Modal: entrada / merma ── */
function openInvMovModal(type, productId = null) {
  const title = type === 'entrada' ? 'Nueva entrada de inventario' : 'Registrar merma';
  const icon = type === 'entrada' ? 'ph-arrow-fat-line-down' : 'ph-warning-diamond';
  $('#invMovModalTitle').innerHTML = `<i class="ph-bold ${icon}"></i> ${title}`;
  $('#invMovType').value = type;
  $('#invMovQty').value = '';
  $('#invMovNotes').value = '';
  const btn = $('#invMovSave');
  if (btn) {
    btn.className = `btn ${type === 'entrada' ? 'btn-primary' : 'btn-danger'}`;
  }
  if (productId) {
    const sel = $('#invMovProduct');
    if (sel) sel.value = String(productId);
  } else {
    const sel = $('#invMovProduct');
    if (sel) sel.value = '';
  }
  openModal('invMovModal');
  setTimeout(() => $('#invMovQty')?.focus(), 120);
}

$('#invMovForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pid = Number($('#invMovProduct').value);
  if (!pid) { toast('Selecciona un producto', true); return; }
  const qty = Number($('#invMovQty').value);
  if (!qty || qty <= 0) { toast('Cantidad debe ser mayor a 0', true); return; }
  try {
    await api('/api/inventory/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: pid,
        type: $('#invMovType').value,
        quantity: qty,
        notes: $('#invMovNotes').value,
      }),
    });
    closeModal('invMovModal');
    await loadInventarios();
    toast('Movimiento registrado');
  } catch (err) {
    toast(err.message || 'Error al guardar', true);
  }
});
$('#invMovCancel')?.addEventListener('click', () => closeModal('invMovModal'));

/* ── Modal: conteo físico (con buscador + paginación 10/pág) ── */
const INV_COUNT_PAGE_SIZE = 10;
let INV_COUNT_PAGE = 1;
let INV_COUNT_SEARCH = '';
const INV_COUNT_VALUES = new Map(); // Map<product_id, number> — persiste entre páginas

function invCountFilteredRows() {
  if (!INV_COUNT_SEARCH) return INV_DATA;
  const q2 = INV_COUNT_SEARCH.toLowerCase();
  return INV_DATA.filter((r) => r.product_name.toLowerCase().includes(q2));
}

function invCountTotalPages(filtered) {
  return Math.max(1, Math.ceil(filtered.length / INV_COUNT_PAGE_SIZE));
}

function renderInvCountPage() {
  const filtered = invCountFilteredRows();
  const totalPages = invCountTotalPages(filtered);
  if (INV_COUNT_PAGE > totalPages) INV_COUNT_PAGE = totalPages;
  const start = (INV_COUNT_PAGE - 1) * INV_COUNT_PAGE_SIZE;
  const pageRows = filtered.slice(start, start + INV_COUNT_PAGE_SIZE);

  /* página info */
  const pageInfo = $('#invCountPageInfo');
  if (pageInfo) pageInfo.textContent = `${INV_COUNT_PAGE} / ${totalPages}`;
  const prevBtn = $('#invCountPrev');
  const nextBtn = $('#invCountNext');
  if (prevBtn) prevBtn.disabled = INV_COUNT_PAGE <= 1;
  if (nextBtn) nextBtn.disabled = INV_COUNT_PAGE >= totalPages;

  /* badge: cuántos productos tienen valor ingresado */
  const badge = $('#invCountPendingBadge');
  if (badge) {
    const filled = INV_COUNT_VALUES.size;
    badge.textContent = filled ? `${filled} ingresado${filled !== 1 ? 's' : ''}` : '';
    badge.hidden = !filled;
  }

  const tbody = $('#invCountTbody');
  if (!tbody) return;

  tbody.innerHTML = pageRows.map((r) => {
    const storedVal = INV_COUNT_VALUES.has(r.product_id) ? INV_COUNT_VALUES.get(r.product_id) : (r.fisico_real !== null ? r.fisico_real : '');
    const storedNum = parseFloat(storedVal);
    let diffText = '—', diffClass = '';
    if (Number.isFinite(storedNum)) {
      const d = storedNum - Number(r.fisico_sistema);
      diffText = d >= 0 ? `+${invFmt(d)}` : invFmt(d);
      diffClass = d < 0 ? 'inv-diff-neg' : d > 0 ? 'inv-diff-pos' : 'inv-diff-zero';
    }
    return `<tr data-pid="${r.product_id}">
      <td class="inv-prod-name"><b>${esc(r.product_name)}</b><span class="inv-unit">${esc(r.unit || 'pcs')}</span></td>
      <td class="num">${invFmt(r.fisico_sistema)}</td>
      <td class="num inv-count-real-col">
        <input type="number" class="inv-count-input" data-pid="${r.product_id}"
          min="0" step="0.01" placeholder="—"
          value="${storedVal !== '' ? storedVal : ''}" />
      </td>
      <td class="num inv-count-diff-cell ${diffClass}" id="invCD_${r.product_id}">${diffText}</td>
    </tr>`;
  }).join('');

  /* bind inputs — guarda en Map + actualiza diff en tiempo real */
  tbody.querySelectorAll('.inv-count-input').forEach((input) => {
    const pid = Number(input.dataset.pid);
    const row = INV_DATA.find((r) => r.product_id === pid);
    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      if (Number.isFinite(val) && val >= 0) {
        INV_COUNT_VALUES.set(pid, val);
      } else {
        INV_COUNT_VALUES.delete(pid);
      }
      /* actualizar badge */
      const b = $('#invCountPendingBadge');
      if (b) { const f = INV_COUNT_VALUES.size; b.textContent = f ? `${f} ingresado${f !== 1 ? 's' : ''}` : ''; b.hidden = !f; }
      /* actualizar celda de diferencia */
      const diffCell = $(`#invCD_${pid}`);
      if (!row || !diffCell) return;
      if (!Number.isFinite(val)) { diffCell.textContent = '—'; diffCell.className = 'num inv-count-diff-cell'; return; }
      const diff = val - Number(row.fisico_sistema);
      diffCell.textContent = diff >= 0 ? `+${invFmt(diff)}` : invFmt(diff);
      diffCell.className = `num inv-count-diff-cell ${diff < 0 ? 'inv-diff-neg' : diff > 0 ? 'inv-diff-pos' : 'inv-diff-zero'}`;
    });
  });
}

function openInvCountModal() {
  INV_COUNT_PAGE = 1;
  INV_COUNT_SEARCH = '';
  INV_COUNT_VALUES.clear();
  /* pre-cargar valores ya guardados como base */
  INV_DATA.forEach((r) => {
    if (r.fisico_real !== null) INV_COUNT_VALUES.set(r.product_id, r.fisico_real);
  });
  const searchEl = $('#invCountSearch');
  if (searchEl) searchEl.value = '';
  $('#invCountNote').value = '';
  openModal('invCountModal');
  renderInvCountPage();
  setTimeout(() => searchEl?.focus(), 80);
}

/* buscador */
$('#invCountSearch')?.addEventListener('input', (e) => {
  INV_COUNT_SEARCH = e.target.value.trim();
  INV_COUNT_PAGE = 1;
  renderInvCountPage();
});

/* paginación */
$('#invCountPrev')?.addEventListener('click', () => {
  if (INV_COUNT_PAGE > 1) { INV_COUNT_PAGE--; renderInvCountPage(); }
});
$('#invCountNext')?.addEventListener('click', () => {
  const total = invCountTotalPages(invCountFilteredRows());
  if (INV_COUNT_PAGE < total) { INV_COUNT_PAGE++; renderInvCountPage(); }
});

$('#invCountSave')?.addEventListener('click', async () => {
  if (!INV_COUNT_VALUES.size) { toast('No hay cantidades ingresadas', true); return; }
  const note = $('#invCountNote').value.trim();
  const counts = [];
  INV_COUNT_VALUES.forEach((qty, pid) => {
    if (Number.isFinite(qty) && qty >= 0) counts.push({ product_id: pid, physical_qty: qty, notes: note });
  });
  if (!counts.length) { toast('No hay cantidades válidas', true); return; }
  const saveBtn = $('#invCountSave');
  if (saveBtn) saveBtn.disabled = true;
  try {
    await Promise.all(counts.map((c) => api('/api/inventory/count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    })));
    closeModal('invCountModal');
    await loadInventarios();
    toast(`Conteo guardado — ${counts.length} producto${counts.length !== 1 ? 's' : ''}`);
  } catch (err) {
    toast(err.message || 'Error al guardar conteo', true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
});
$('#invCountCancel')?.addEventListener('click', () => closeModal('invCountModal'));

/* ── Modal: historial de movimientos ── */
async function openInvMovHistModal(productId = null) {
  const sel = $('#invMovHistFilter');
  if (sel && productId) sel.value = String(productId);
  else if (sel) sel.value = '';
  await loadInvMovHist();
  openModal('invMovHistModal');
}

async function loadInvMovHist() {
  const sel = $('#invMovHistFilter');
  const pid = sel ? Number(sel.value) : 0;
  const params = new URLSearchParams();
  if (pid) params.set('product_id', String(pid));
  if (INV_PERIOD !== 'all') params.set('period', INV_PERIOD);
  if (INV_PERIOD === 'custom' && INV_START_DATE && INV_END_DATE) {
    params.set('startDate', INV_START_DATE);
    params.set('endDate', INV_END_DATE);
  }
  const url = params.toString() ? `/api/inventory/movements?${params.toString()}` : '/api/inventory/movements';
  try {
    const rows = await api(url);
    const count = $('#invMovHistCount');
    if (count) count.textContent = `${rows.length} movimiento${rows.length !== 1 ? 's' : ''}`;
    const wrap = $('#invMovHistTable');
    if (!wrap) return;
    if (!rows.length) { wrap.innerHTML = '<p class="empty-cell" style="padding:16px">Sin movimientos registrados</p>'; return; }
    wrap.innerHTML = `<table class="inv-table">
      <thead><tr><th>Producto</th><th>Tipo</th><th class="num">Cantidad</th><th>Notas</th><th>Usuario</th><th>Fecha</th><th></th></tr></thead>
      <tbody>${rows.map((m) => `<tr>
        <td>${esc(m.product_name)}</td>
        <td><span class="inv-type-badge inv-type-${m.type}">${m.type === 'entrada' ? '⬇ Entrada' : '⚠ Merma'}</span></td>
        <td class="num">${invFmt(m.quantity)}</td>
        <td>${esc(m.notes || '—')}</td>
        <td>${esc(m.created_by || '—')}</td>
        <td style="white-space:nowrap">${esc(m.created_at)}</td>
        <td><button class="btn btn-ghost btn-sm inv-del-mov" data-id="${m.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button></td>
      </tr>`).join('')}</tbody>
    </table>`;
    wrap.querySelectorAll('.inv-del-mov').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await askConfirm('Eliminar movimiento', '¿Deseas eliminar este movimiento? Esto afectará el cálculo de inventario.');
        if (!ok) return;
        try {
          await api(`/api/inventory/movements/${btn.dataset.id}`, { method: 'DELETE' });
          await loadInvMovHist();
          await loadInventarios();
          toast('Movimiento eliminado');
        } catch (err) { toast(err.message || 'Error al eliminar', true); }
      });
    });
  } catch (err) {
    toast(err.message || 'Error al cargar movimientos', true);
  }
}

$('#invMovHistFilter')?.addEventListener('change', loadInvMovHist);
$('#invMovHistClose')?.addEventListener('click', () => closeModal('invMovHistModal'));

/* ── Botones del toolbar ── */
$('#invRefreshBtn')?.addEventListener('click', async () => {
  await loadInventarios();
  toast('Inventario actualizado');
});
$('#invEntradaBtn')?.addEventListener('click', () => openInvMovModal('entrada'));
$('#invMermaBtn')?.addEventListener('click', () => openInvMovModal('merma'));
$('#invCountBtn')?.addEventListener('click', openInvCountModal);
$('#invMovHistoryBtn')?.addEventListener('click', () => openInvMovHistModal());
$('#invUpdateInitialBtn')?.addEventListener('click', async () => {
  const result = await askInvClosureNote();
  if (result === null) return;
  await applyRealToInitial(null, {
    logAdjustment: Boolean(result?.logAdjustment),
    closureNote: result?.note || '',
  });
});

/* ── Modal: Exportar ── */
$('#invExportBtn')?.addEventListener('click', () => openModal('invExportModal'));
$('#invExportCancel')?.addEventListener('click', () => closeModal('invExportModal'));

$('#invExportFormat')?.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    INV_EXPORT_FMT = btn.dataset.fmt;
    $('#invExportFormat').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
  });
});

$('#invExpOnlyDiff')?.addEventListener('change', (e) => {
  const summary = $('#invExpSummary');
  if (!summary) return;
  if (e.target.checked) summary.checked = true;
});

$('#invExportRun')?.addEventListener('click', async () => {
  const includeOnlyDiff = Boolean($('#invExpOnlyDiff')?.checked);
  const includeSummary = Boolean($('#invExpSummary')?.checked) || includeOnlyDiff;
  const includeMovements = $('#invExpMovements').checked;
  const onlyDiff = includeOnlyDiff;
  if (!includeSummary && !includeMovements) { toast('Elige al menos una sección', true); return; }

  try {
    const params = new URLSearchParams();
    if (INV_PERIOD !== 'all') params.set('period', INV_PERIOD);
    if (INV_PERIOD === 'custom' && INV_START_DATE && INV_END_DATE) {
      params.set('startDate', INV_START_DATE);
      params.set('endDate', INV_END_DATE);
    }
    const exportPath = params.toString() ? `/api/inventory/export?${params.toString()}` : '/api/inventory/export';
    const data = await api(exportPath);
    let summary = data.summary || [];
    const movements = data.movements || [];
    if (onlyDiff) summary = summary.filter((r) => r.diferencia !== null && r.diferencia !== 0);

    if (INV_EXPORT_FMT === 'csv') {
      exportInvCSV(summary, movements, { includeSummary, includeMovements });
    } else {
      exportInvPDF(summary, movements, { includeSummary, includeMovements });
    }
    closeModal('invExportModal');
  } catch (err) {
    toast(err.message || 'Error al exportar', true);
  }
});

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportInvCSV(summary, movements, opts) {
  const lines = [];
  const now = new Date().toLocaleString('es-MX');

  if (opts.includeSummary) {
    lines.push(`Reporte de Inventario — ${now}`);
    lines.push('');
    lines.push(['Producto','Unidad','Inv. Inicial','Entradas','Mermas','Ventas','Físico Sistema','Físico Real','Diferencia'].map(csvEscape).join(','));
    for (const r of summary) {
      lines.push([
        r.product_name, r.unit ?? 'pcs',
        r.initial_stock, r.entradas, r.mermas, r.ventas,
        r.fisico_sistema, r.fisico_real ?? '', r.diferencia ?? '',
      ].map(csvEscape).join(','));
    }
    lines.push('');
  }

  if (opts.includeMovements) {
    lines.push('Detalle de Movimientos');
    lines.push(['Producto','Tipo','Cantidad','Notas','Usuario','Fecha'].map(csvEscape).join(','));
    for (const m of movements) {
      lines.push([
        m.product_name, m.type, m.quantity, m.notes || '', m.created_by || '', m.created_at,
      ].map(csvEscape).join(','));
    }
  }

  const bom = '\uFEFF';
  const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inventario-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function exportInvPDF(summary, movements, opts) {
  const now = new Date().toLocaleString('es-MX');
  const biz = ME?.tenant?.business_name || 'ChatBotPro';

  const summaryHTML = opts.includeSummary ? `
    <h2>Resumen de Inventario</h2>
    <table>
      <thead><tr>
        <th>Producto</th><th>Unidad</th><th>Ini.</th><th>Entradas</th>
        <th>Mermas</th><th>Ventas</th><th>F. Sistema</th><th>F. Real</th><th>Diferencia</th>
      </tr></thead>
      <tbody>${summary.map((r) => {
        const diffClass = r.diferencia < 0 ? 'neg' : r.diferencia > 0 ? 'pos' : '';
        return `<tr>
          <td>${r.product_name}</td>
          <td>${r.unit ?? 'pcs'}</td>
          <td>${r.initial_stock}</td>
          <td>${r.entradas}</td>
          <td>${r.mermas}</td>
          <td>${r.ventas}</td>
          <td><b>${r.fisico_sistema}</b></td>
          <td>${r.fisico_real ?? '—'}</td>
          <td class="${diffClass}">${r.diferencia !== null ? r.diferencia : '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : '';

  const movHTML = opts.includeMovements ? `
    <h2 style="margin-top:28px">Detalle de Movimientos</h2>
    <table>
      <thead><tr><th>Producto</th><th>Tipo</th><th>Cantidad</th><th>Notas</th><th>Usuario</th><th>Fecha</th></tr></thead>
      <tbody>${movements.map((m) => `<tr>
        <td>${m.product_name}</td>
        <td style="color:${m.type === 'entrada' ? '#16a34a' : '#dc2626'}">${m.type}</td>
        <td>${m.quantity}</td>
        <td>${m.notes || '—'}</td>
        <td>${m.created_by || '—'}</td>
        <td>${m.created_at}</td>
      </tr>`).join('')}</tbody>
    </table>` : '';

  const win = window.open('', '_blank', 'width=1050,height=780');
  win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
    <title>Inventario — ${biz}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:12px;padding:20px;color:#111}
      h1{font-size:16px;margin:0 0 4px}
      .sub{font-size:11px;color:#666;margin-bottom:18px}
      h2{font-size:13px;margin:0 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
      table{width:100%;border-collapse:collapse;margin-bottom:12px}
      th{background:#f1f5f9;text-align:left;padding:5px 7px;font-size:11px;border-bottom:2px solid #cbd5e1}
      td{padding:4px 7px;border-bottom:1px solid #e8ecf3;font-size:11px}
      tr:nth-child(even) td{background:#f9fafb}
      .neg{color:#dc2626;font-weight:bold}
      .pos{color:#16a34a;font-weight:bold}
      @media print{button{display:none}}
    </style></head><body>
    <h1>Inventario — ${biz}</h1>
    <div class="sub">Generado: ${now}</div>
    ${summaryHTML}${movHTML}
    <script>window.onload=()=>{window.print();}<\/script>
  </body></html>`);
  win.document.close();
}

/* ── helpers para abrir/cerrar modales ── */
function openModal(id) {
  const m = $(`#${id}`);
  if (!m) return;
  m.hidden = false;
  m.classList.add('show');
}
function closeModal(id) {
  const m = $(`#${id}`);
  if (!m) return;
  m.classList.remove('show');
  m.hidden = true;
}

/* cerrar modales de inventario al hacer clic en el fondo */
['invInitModal','invMovModal','invCountModal','invMovHistModal','invExportModal','invClosureModal'].forEach((id) => {
  const el = $(`#${id}`);
  if (el) el.addEventListener('click', (e) => { if (e.target === el) closeModal(id); });
});
