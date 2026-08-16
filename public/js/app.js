/* ===== ChatBotPro — lógica del panel v2 ===== */
let ME = null;
let SETTINGS = null;
let salesChart = null;
let topChart = null;
let SALES_REPORT_DATA = null;
let SALES_DAILY_CHART = null;
let SALES_MONTHLY_CHART = null;
let SALES_REPORT_MODE = 'daily';
let SALES_REPORT_BRANCH = 'all';
let SALES_REPORT_YEAR = new Date().getFullYear();
let SALES_REPORT_MONTH = new Date().getMonth() + 1;
let SALES_DETAIL_DATA = null;
let SALES_DETAIL_TITLE = '';
let SALES_DETAIL_RANGE_MODE = 'day';
let COSTING_DATA = { products: [], categories: [], branches: [] };
let COSTING_DRAFT = new Map();
let COSTING_DIRTY = new Set();
let COSTING_TAB = 'products';
let COSTING_SORT = 'alphabetical';
let COSTING_CATEGORY = 'all';
let COSTING_SEARCH = '';
let COSTING_VIEW = 'table';
let COSTING_EXPORT_FORMAT = 'pdf';
let COSTING_EXPENSE_BRANCH = 'all';
let COSTING_EXPENSE_YEAR = new Date().getFullYear();
let COSTING_EXPENSE_MONTH = new Date().getMonth() + 1;
let COSTING_SAVE_QUEUE = Promise.resolve(true);
const COSTING_AUTOSAVE_TIMERS = new Map();
let PURCHASE_DATA = { suppliers: [], branches: [], products: [], branchStock: [] };
let PURCHASE_ORDERS = [];
let PURCHASE_TRANSFERS = [];
let PURCHASE_REPORT = null;
let PURCHASE_CHART = null;
let PURCHASE_TAB = 'dashboard';
let PURCHASE_PERIOD = 'day';
let PURCHASE_ORDER_ITEMS = [];
let PURCHASE_ORDER_EDIT_ID = null;
let PURCHASE_TRANSFER_ITEMS = [];
let PURCHASE_TRANSFER_STOCK = null;
let PURCHASE_TRANSFER_STOCK_LOADING = false;
let PURCHASE_TRANSFER_STOCK_REQUEST = 0;
let BRANCH_STOCK_DATA = { branches: [], summaries: [], rows: [] };
let BRANCH_STOCK_SEARCH = '';
let BRANCH_STOCK_CATEGORY = 'all';
let BRANCH_STOCK_ONLY_AVAILABLE = false;
let BRANCH_STOCK_BRANCH = 'all';
let BRANCH_STOCK_PAGE = 1;
let BRANCH_STOCK_PAGE_SIZE = 10;
try {
  const savedBranchStockPageSize = Number(localStorage.getItem('branchStockPageSize'));
  if ([10, 20, 50, 100].includes(savedBranchStockPageSize)) BRANCH_STOCK_PAGE_SIZE = savedBranchStockPageSize;
} catch {}
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
let KDS_CONFIG = { areas: [], categories: [], products: [], branches: [] };
let KDS_PRODUCT_SELECTED = new Set();
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
let POS_PAYMENT_FORM = { cashReceived: '', cash: '', card: '', transfer: '', notes: '', deliveryAddress: '', deliveryNeighborhood: '', deliveryReference: '' };
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
let POS_CHATBOT_TABLE_ORDER_ID = null;
let POS_TABLE_ACCOUNT = null;
let TABLES_CONFIG = [];
let TABLES_CONFIG_BRANCHES = [];
let TABLES_CONFIG_SELECTED_ID = null;
let CHATBOT_SUBTAB = 'flow';
let CHATBOT_UPSELL_PRODUCTS = [];
let CHATBOT_UPSELL_SELECTED = new Set();
let CHATBOT_UPSELL_OFFERS = [];
let CHATBOT_INFO_OPTIONS = [];
let CHATBOT_RECEIVING_MODES = [];
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
function enhanceResponsiveTables(root = document) {
  root.querySelectorAll?.('.table-wrap table:not(.branch-stock-table)').forEach((table) => {
    const headings = [...table.querySelectorAll('thead th')].map((cell) => cell.textContent.trim());
    if (headings.length < 4) return;
    table.classList.add('mobile-card-table');
    table.querySelectorAll('tbody tr').forEach((row) => {
      [...row.children].forEach((cell, index) => {
        if (cell.tagName === 'TD' && !cell.hasAttribute('colspan')) cell.dataset.label = headings[index] || '';
      });
    });
  });
}

let responsiveTableFrame = 0;
function scheduleResponsiveTableEnhancement() {
  if (responsiveTableFrame) return;
  responsiveTableFrame = requestAnimationFrame(() => {
    responsiveTableFrame = 0;
    enhanceResponsiveTables();
  });
}

if (document.body) {
  new MutationObserver(scheduleResponsiveTableEnhancement).observe(document.body, { childList: true, subtree: true });
  scheduleResponsiveTableEnhancement();
}
const fmtMoney = (n, c) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: c || (SETTINGS && SETTINGS.currency) || 'MXN' }).format(n || 0);

function businessTimeZone() {
  return String(SETTINGS?.timezone || 'America/Mexico_City');
}

function businessIsoDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: businessTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${pick('year')}-${pick('month')}-${pick('day')}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function fmtBusinessDateTime(value = new Date(), options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: businessTimeZone(),
      dateStyle: 'short',
      timeStyle: 'short',
      ...options,
    }).format(date);
  } catch {
    return date.toLocaleString('es-MX');
  }
}

let tenantClockTimer = null;
function updateTenantClock() {
  const dateEl = $('#tenantLocalDate');
  const timeEl = $('#tenantLocalTime');
  const zoneEl = $('#tenantTimezoneLabel');
  const clock = $('#tenantClock');
  if (!dateEl || !timeEl || !zoneEl || !clock || !SETTINGS) return;
  const timezone = businessTimeZone();
  const now = new Date();
  try {
    dateEl.textContent = new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    }).format(now);
    timeEl.textContent = new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(now);
    const option = SETTINGS?.regional?.timezones?.find((item) => item.value === timezone);
    const zoneLabel = option?.label || timezone;
    zoneEl.textContent = `${zoneLabel} · ${timezone}`;
    clock.title = `Fecha y hora local de ${ME?.tenant?.businessName || 'este negocio'} · ${timezone}`;
    clock.setAttribute('aria-label', `${dateEl.textContent}, ${timeEl.textContent}, zona horaria ${zoneLabel}`);
  } catch {
    dateEl.textContent = now.toLocaleDateString('es-MX');
    timeEl.textContent = now.toLocaleTimeString('es-MX');
    zoneEl.textContent = timezone;
  }
}

function startTenantClock() {
  if (tenantClockTimer) clearInterval(tenantClockTimer);
  updateTenantClock();
  tenantClockTimer = setInterval(updateTenantClock, 1000);
}

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

function posManagedBranchStorageKey() {
  return `chatbotpro:pos:managed-branch:${ME?.tenant?.slug || 'default'}`;
}

function getManagedPosBranchId() {
  if (isCashierUser()) return null;
  try {
    const branchId = Number(sessionStorage.getItem(posManagedBranchStorageKey()));
    return Number.isInteger(branchId) && branchId > 0 ? branchId : null;
  } catch {
    return null;
  }
}

function setManagedPosBranchId(branchId) {
  if (isCashierUser()) return;
  try {
    const value = Number(branchId);
    if (Number.isInteger(value) && value > 0) {
      sessionStorage.setItem(posManagedBranchStorageKey(), String(value));
    } else {
      sessionStorage.removeItem(posManagedBranchStorageKey());
    }
  } catch {}
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
  return businessIsoDate();
}

function orderDateKeyLocal(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function defaultOrdersWeekRange() {
  const end = new Date(`${businessIsoDate()}T12:00:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return {
    start: orderDateKeyLocal(start),
    end: orderDateKeyLocal(end),
  };
}

function resetOrdersToDefaultWeek() {
  const range = defaultOrdersWeekRange();
  orderDateStart = range.start;
  orderDateEnd = range.end;
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
  const managedBranchId = String(path || '').startsWith('/api/pos') ? getManagedPosBranchId() : null;
  if (managedBranchId) headers.set('x-cbp-pos-branch-id', String(managedBranchId));
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
const ONBOARDING_STEPS = [
  {
    number: 1,
    icon: 'ph-buildings',
    title: 'Configura la identidad de tu negocio',
    description: 'Entra a Mi negocio y completa la información con la que operará tu sistema.',
    details: ['Nombre, logo, color y dirección', 'Horarios, moneda y cuentas para transferencias', 'Sucursales, cajeros y accesos de caja'],
    action: 'config',
    actionLabel: 'Ir a Mi negocio',
  },
  {
    number: 2,
    icon: 'ph-robot',
    title: 'Prepara tu chatbot',
    description: 'En Mi chatbot configura cómo atenderás a tus clientes y cómo recibirás sus pedidos.',
    details: ['Número de WhatsApp que recibirá los pedidos', 'Servicio a domicilio, recolección y formas de pago', 'Mesas y opciones especiales si aplican a tu negocio'],
    action: 'chatbot',
    actionLabel: 'Configurar chatbot',
  },
  {
    number: 3,
    icon: 'ph-cooking-pot',
    title: 'Da de alta categorías y productos',
    description: 'Construye el catálogo que tus clientes verán al abrir el chatbot.',
    details: ['Crea primero las categorías del menú', 'Agrega nombre, descripción, precio e imagen', 'Configura variantes e ingredientes cuando los necesites'],
    action: 'productos',
    actionLabel: 'Agregar productos',
  },
  {
    number: 4,
    icon: 'ph-chat-circle-dots',
    title: 'Haz un pedido real en tu chatbot',
    description: 'Pulsa Ver mi chatbot y realiza un pedido completo como lo haría uno de tus clientes.',
    details: ['Comprueba el menú y el proceso de compra', 'Finaliza el pedido con datos reales de prueba', 'Confirma que llegue al WhatsApp configurado'],
    action: 'chatbot-preview',
    actionLabel: 'Ver mi chatbot',
  },
  {
    number: 5,
    icon: 'ph-cash-register',
    title: 'Prueba el Punto de venta',
    description: 'Crea pedidos manuales desde el POS para conocer el flujo de caja y comprobar qué sencillo es operar.',
    details: ['Abre la caja o selecciona una sucursal', 'Agrega productos y cobra un pedido de prueba', 'Revisa el ticket y el movimiento en tus reportes'],
    action: 'pos',
    actionLabel: 'Abrir Punto de venta',
  },
  {
    number: 6,
    icon: 'ph-monitor-play',
    title: 'Habilita y abre una pantalla KDS',
    description: 'Configura un área de preparación y mira en tiempo real lo que vería tu cocinero, la barra o el encargado de pedidos.',
    details: ['Crea o habilita un área de preparación', 'Asigna categorías y productos al área', 'Abre su pantalla KDS y envía un pedido de prueba'],
    action: 'kds',
    actionLabel: 'Configurar KDS',
  },
];

function onboardingStepMarkup(step, compact = false) {
  return `<article class="onboarding-step-card step-${step.number} ${compact ? 'compact' : ''}">
    <div class="onboarding-step-number">${step.number}</div>
    <div class="onboarding-step-icon"><i class="ph-fill ${step.icon}"></i></div>
    <div class="onboarding-step-content">
      <span>Paso ${step.number}</span>
      <h3>${esc(step.title)}</h3>
      <p>${esc(step.description)}</p>
      <ul>${step.details.map((detail) => `<li><i class="ph-bold ph-check"></i>${esc(detail)}</li>`).join('')}</ul>
      <button type="button" class="btn btn-sm onboarding-action-btn action-${step.action}" data-onboarding-action="${step.action}">${esc(step.actionLabel)} <i class="ph-bold ph-arrow-right"></i></button>
    </div>
  </article>`;
}

function renderInstructions() {
  const moduleTarget = $('#instructionsSteps');
  const introTarget = $('#onboardingIntroSteps');
  if (moduleTarget) moduleTarget.innerHTML = ONBOARDING_STEPS.map((step) => onboardingStepMarkup(step)).join('');
  if (introTarget) introTarget.innerHTML = ONBOARDING_STEPS.map((step) => onboardingStepMarkup(step, true)).join('');
}

async function completeOnboarding() {
  if (!ME || ME.onboardingCompleted) return;
  await api('/api/auth/onboarding/complete', { method: 'POST' });
  ME.onboardingCompleted = true;
  ME.onboardingRequired = false;
}

function openOnboardingIntro() {
  renderInstructions();
  $('#onboardingIntro')?.classList.add('show');
  document.body.classList.add('onboarding-open');
}

async function closeOnboardingIntro() {
  await completeOnboarding();
  $('#onboardingIntro')?.classList.remove('show');
  document.body.classList.remove('onboarding-open');
}

async function runOnboardingAction(action, fromIntro = false) {
  if (fromIntro) await closeOnboardingIntro();
  if (action === 'chatbot-preview') {
    const url = $('#openChatLink')?.href || `/${ME?.tenant?.slug || ''}`;
    window.open(url, '_blank', 'noopener');
    return;
  }
  if (VIEW_META[action]) await navigate(action);
}

const VIEW_META = {
  dashboard: ['Dashboard', 'Resumen de tu negocio', 'ph-chart-pie-slice'],
  pedidos: ['Pedidos', 'Administra y actualiza tus pedidos', 'ph-receipt'],
  clientes: ['Clientes', 'Fidelidad y valor de clientes del chatbot', 'ph-users-three'],
  pos: ['Punto de venta', 'Caja, cobro y cierre del día', 'ph-cash-register'],
  kds: ['Pantallas KDS', 'Comandas automáticas por área de preparación', 'ph-monitor-play'],
  ventas: ['Ventas', 'Reportes diarios y mensuales por sucursal', 'ph-chart-line-up'],
  cancelaciones: ['Cancelaciones', 'Auditoría de ventas y correcciones', 'ph-file-magnifying-glass'],
  cortes: ['Cortes', 'Aperturas, cierres y diferencias de caja', 'ph-safe'],
  productos: ['Productos', 'Tu menú visible en el chatbot', 'ph-hamburger'],
  costos: ['Costo de ventas', 'Costos, precios, márgenes y gastos por sucursal', 'ph-coins'],
  inventarios: ['Inventarios', 'Control de stock, entradas, mermas y conteo físico', 'ph-package'],
  'stock-sucursales': ['Stock por sucursal', 'Existencias reales y consolidadas por ubicación', 'ph-buildings'],
  compras: ['Compras', 'Proveedores, órdenes y traslados entre sucursales', 'ph-shopping-cart-simple'],
  empleados: ['Productividad Empleados', 'Métricas, comisiones y desempeño del equipo', 'ph-identification-badge'],
  chatbot: ['Mi chatbot', 'Configura el flujo y comparte tu liga', 'ph-chat-circle-dots'],
  config: ['Mi negocio', 'Identidad, branding y contacto', 'ph-storefront'],
  suscripciones: ['Suscripciones', 'Planes, beneficios y pago seguro', 'ph-crown'],
  instrucciones: ['Instrucciones', 'Guía rápida para configurar y probar tu sistema', 'ph-book-open-text'],
};

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  pedidos: loadOrders,
  clientes: loadCustomers,
  pos: loadPos,
  kds: loadKds,
  ventas: loadSalesReport,
  cancelaciones: () => loadAuditLog(1),
  cortes: () => loadCutsHistory(1),
  productos: loadProducts,
  costos: loadCosting,
  inventarios: loadInventarios,
  'stock-sucursales': loadBranchStock,
  compras: loadPurchases,
  empleados: loadEmpleados,
  chatbot: fillBotForm,
  config: fillConfigForm,
  suscripciones: () => {},
  instrucciones: renderInstructions,
};

let CURRENT_VIEW = 'dashboard';

const CASHIER_ALLOWED_VIEWS = new Set(['pos', 'pedidos', 'cancelaciones', 'cortes']);

function normalizeView(view) {
  if (isCashierUser()) {
    return CASHIER_ALLOWED_VIEWS.has(view) ? view : 'pos';
  }
  return VIEW_META[view] ? view : 'dashboard';
}

function resetMainScroll() {
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
}

function trackModuleUsage(moduleKey) {
  if (!ME || !VIEW_META[moduleKey]) return;
  const headers = { 'Content-Type': 'application/json' };
  const scope = getAuthScope();
  if (scope) headers['x-cbp-auth-scope'] = scope;
  fetch('/api/auth/module-usage', {
    method: 'POST',
    headers,
    body: JSON.stringify({ module: moduleKey }),
    keepalive: true,
  }).catch(() => {});
}

function applyUserScopeUI() {
  const cashierMode = isCashierUser();
  document.body.classList.toggle('cashier-mode', cashierMode);
  document.querySelectorAll('.sidebar nav a').forEach((a) => {
    if (!a.dataset.view) {
      a.hidden = cashierMode;
      return;
    }
    const allowed = !cashierMode || CASHIER_ALLOWED_VIEWS.has(a.dataset.view);
    a.hidden = !allowed;
  });
  document.querySelectorAll('.sidebar nav .nav-label').forEach((lbl) => {
    if (cashierMode) {
      lbl.hidden = !lbl.classList.contains('nav-label-principal');
    } else {
      lbl.hidden = false;
    }
  });
  const chatLink = $('#openChatLink');
  if (chatLink) chatLink.hidden = cashierMode;
  const banner = $('#cashierBranchBanner');
  if (banner) banner.style.display = cashierMode ? 'inline-flex' : 'none';
  const bannerLabel = $('#cashierBranchLabel');
  if (bannerLabel && cashierMode) bannerLabel.textContent = ME?.branchName ? `Sucursal: ${ME.branchName}` : 'Punto de venta';
  if (cashierMode) {
    $('#brandName').textContent = ME?.branchName || ME?.tenant?.businessName || 'Caja';
  }
  syncPosSortControlVisibility();
}

async function navigate(view) {
  const nextView = normalizeView(view);
  if (CURRENT_VIEW === 'costos' && COSTING_DIRTY.size) {
    const saved = await saveCostingProducts({ silent: true });
    if (!saved) {
      toast('No se pudo guardar. Revisa tu conexión antes de salir de Costos.', true);
      return;
    }
  }
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
  trackModuleUsage(nextView);

  const loader = VIEW_LOADERS[nextView];
  if (!loader) return;
  try {
    await loader();
  } catch (err) {
    toast(err.message || 'No se pudo cargar el módulo', true);
  }
}
globalThis.navigate = navigate;

$('#configureTimezoneBtn')?.addEventListener('click', async () => {
  if (isCashierUser()) return;
  await navigate('config');
  const select = $('#cfgTimezone');
  const field = select?.closest('.field');
  field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field?.classList.add('timezone-focus-pulse');
  setTimeout(() => field?.classList.remove('timezone-focus-pulse'), 1500);
  setTimeout(() => select?.focus({ preventScroll: true }), 420);
});

document.querySelectorAll('.sidebar nav a').forEach((a) =>
  a.addEventListener('click', (e) => {
    if (!a.dataset.view) return; // enlaces externos (ej. /notificaciones) — dejar pasar
    e.preventDefault();
    navigate(a.dataset.view);
  })
);

globalThis.addEventListener('hashchange', () => {
  const targetView = (location.hash || '').replace(/^#/, '');
  const nextView = normalizeView(targetView || (isCashierUser() ? 'pos' : 'dashboard'));
  if (nextView !== CURRENT_VIEW) navigate(nextView);
});

document.addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-onboarding-action]');
  if (!actionButton) return;
  const fromIntro = Boolean(actionButton.closest('#onboardingIntro'));
  runOnboardingAction(actionButton.dataset.onboardingAction, fromIntro).catch((error) => toast(error.message, true));
});

$('#reopenOnboarding')?.addEventListener('click', openOnboardingIntro);
$('#onboardingIntroClose')?.addEventListener('click', () => closeOnboardingIntro().catch((error) => toast(error.message, true)));
$('#onboardingEnterDashboard')?.addEventListener('click', () => closeOnboardingIntro().catch((error) => toast(error.message, true)));
$('#onboardingStart')?.addEventListener('click', () => runOnboardingAction('config', true).catch((error) => toast(error.message, true)));
$('#onboardingIntro')?.addEventListener('click', (event) => {
  if (event.target?.id === 'onboardingIntro') closeOnboardingIntro().catch((error) => toast(error.message, true));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#onboardingIntro')?.classList.contains('show')) {
    closeOnboardingIntro().catch((error) => toast(error.message, true));
  }
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
function subscriptionPlanLabel(planName) {
  const value = String(planName || 'starter').trim();
  const labels = {
    starter: 'Plan Starter',
    mensual: 'Plan mensual',
    annual: 'Plan anual',
    anual: 'Plan anual',
  };
  return labels[value.toLowerCase()] || value;
}

function renderDashboardSubscription(subscription) {
  const card = $('#dashboardSubscriptionCard');
  if (!card) return;
  if (!subscription?.active) {
    card.hidden = true;
    card.innerHTML = '';
    return;
  }

  const limit = Math.max(1, Number(subscription.branchLimit || 2));
  const active = Math.max(0, Number(subscription.activeBranches || 0));
  const available = Math.max(0, Number(subscription.availableBranches ?? (limit - active)));
  const includedText = limit === 2
    ? 'Tu plan incluye de 1 a 2 sucursales activas'
    : `Tu plan incluye hasta ${limit} sucursales activas`;
  const billingText = subscription.billingStatus === 'due' ? 'Por pagar' : 'Al corriente';
  const dueDateKey = String(subscription.dueDate || '').slice(0, 10);
  const dueText = dueDateKey
    ? ` · vence ${new Date(`${dueDateKey}T12:00:00`).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : '';

  card.innerHTML = `
    <div class="dashboard-plan-icon"><i class="ph-fill ph-storefront"></i></div>
    <div class="dashboard-plan-copy">
      <b>${esc(subscriptionPlanLabel(subscription.planName))} activo</b>
      <span>${esc(includedText)} · ${esc(billingText)}${esc(dueText)}</span>
    </div>
    <div class="dashboard-plan-branches"><span>Sucursales activas</span><b>${active} de ${limit} en uso</b></div>
    <div class="dashboard-plan-available"><span>Disponibilidad</span><b>${available} disponible${available === 1 ? '' : 's'}</b></div>
  `;
  card.hidden = false;
}

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
  renderDashboardSubscription(s.subscription);
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

/* ===== Reporte de ventas ===== */
function salesMonthName(month, style = 'long') {
  return new Intl.DateTimeFormat('es-MX', { month: style, timeZone: 'UTC' })
    .format(new Date(Date.UTC(2024, Math.max(0, Number(month || 1) - 1), 1)));
}

function salesScopeLabel() {
  if (SALES_REPORT_BRANCH === 'all') return 'Todas las sucursales';
  if (SALES_REPORT_BRANCH === 'general') return 'Sin sucursal asignada';
  const branch = SALES_REPORT_DATA?.branches?.find((row) => String(row.id) === String(SALES_REPORT_BRANCH));
  return branch?.name || 'Sucursal seleccionada';
}

function populateSalesBranchFilter() {
  const select = $('#salesBranchFilter');
  if (!select || !SALES_REPORT_DATA) return;
  const options = [
    '<option value="all">Todas las sucursales</option>',
    '<option value="general">Sin sucursal asignada</option>',
    ...SALES_REPORT_DATA.branches.map((branch) => (
      `<option value="${branch.id}">${esc(branch.name)}${branch.active ? '' : ' (inactiva)'}</option>`
    )),
  ];
  select.innerHTML = options.join('');
  select.value = SALES_REPORT_BRANCH;
  if (select.value !== SALES_REPORT_BRANCH) {
    SALES_REPORT_BRANCH = 'all';
    select.value = 'all';
  }
}

function renderSalesReportStats() {
  const host = $('#salesReportStats');
  if (!host || !SALES_REPORT_DATA) return;
  const summary = SALES_REPORT_DATA.summary || {};
  const dailyMode = SALES_REPORT_MODE === 'daily';
  const sales = dailyMode ? summary.selectedMonthSales : summary.yearSales;
  const tickets = dailyMode ? summary.selectedMonthTickets : summary.yearTickets;
  const cogs = dailyMode ? summary.selectedMonthCogs : summary.yearCogs;
  const expenses = dailyMode ? summary.selectedMonthExpenses : summary.yearExpenses;
  const purchases = dailyMode ? summary.selectedMonthPurchases : summary.yearPurchases;
  const cashResult = dailyMode ? summary.selectedMonthCashResult : summary.yearCashResult;
  const netProfit = dailyMode ? summary.selectedMonthNetProfit : summary.yearNetProfit;
  const marginPercent = dailyMode ? summary.selectedMonthMarginPercent : summary.yearMarginPercent;
  const periodLabel = dailyMode ? `${salesMonthName(SALES_REPORT_MONTH)} ${SALES_REPORT_YEAR}` : `Año ${SALES_REPORT_YEAR}`;

  const payments = dailyMode ? summary.selectedMonthPayments : summary.yearPayments;
  const cashCollected = payments?.cash ?? (dailyMode ? summary.selectedMonthCash : summary.yearCash) ?? 0;
  const cardCollected = payments?.card ?? (dailyMode ? summary.selectedMonthCard : summary.yearCard) ?? 0;
  const transferCollected = payments?.transfer ?? (dailyMode ? summary.selectedMonthTransfer : summary.yearTransfer) ?? 0;

  const totalSales = Number(sales || 0);
  const pct = (val) => totalSales > 0 ? ` (${((Number(val || 0) / totalSales) * 100).toFixed(0)}%)` : '';

  host.innerHTML = `
    <div class="card sales-report-stat sales-report-stat-primary">
      <div class="sales-stat-top">
        <small>Ingresos · ${esc(periodLabel)}</small>
        <i class="sales-stat-icon-free ph-duotone ph-chart-line-up icon-emerald"></i>
      </div>
      <strong>${fmtMoney(sales)}</strong>
      <span>${tickets} venta${Number(tickets) === 1 ? '' : 's'} · ${esc(salesScopeLabel())}</span>
    </div>
    <div class="card sales-report-stat">
      <div class="sales-stat-top">
        <small>Efectivo cobrado</small>
        <i class="sales-stat-icon-free ph-duotone ph-money icon-emerald"></i>
      </div>
      <strong>${fmtMoney(cashCollected)}</strong>
      <span>${pct(cashCollected)} cobrado en caja / chatbot</span>
    </div>
    <div class="card sales-report-stat">
      <div class="sales-stat-top">
        <small>Tarjeta cobrada</small>
        <i class="sales-stat-icon-free ph-duotone ph-credit-card icon-blue"></i>
      </div>
      <strong>${fmtMoney(cardCollected)}</strong>
      <span>${pct(cardCollected)} pagos con terminal / tarjeta</span>
    </div>
    <div class="card sales-report-stat">
      <div class="sales-stat-top">
        <small>Transferencias</small>
        <i class="sales-stat-icon-free ph-duotone ph-bank icon-cyan"></i>
      </div>
      <strong>${fmtMoney(transferCollected)}</strong>
      <span>${pct(transferCollected)} transferencias bancarias</span>
    </div>
    <div class="card sales-report-stat">
      <div class="sales-stat-top">
        <small>Costo de ventas</small>
        <i class="sales-stat-icon-free ph-duotone ph-package icon-indigo"></i>
      </div>
      <strong>${fmtMoney(cogs)}</strong>
      <span>Costo de las unidades vendidas</span>
    </div>
    <div class="card sales-report-stat ${Number(netProfit) < 0 ? 'sales-report-stat-loss' : ''}">
      <div class="sales-stat-top">
        <small>${Number(netProfit) < 0 ? 'Pérdida neta' : 'Utilidad neta'}</small>
        <i class="sales-stat-icon-free ph-duotone ${Number(netProfit) < 0 ? 'ph-trend-down icon-rose' : 'ph-trend-up icon-amber'}"></i>
      </div>
      <strong>${fmtMoney(netProfit)}</strong>
      <span>Margen neto ${Number(marginPercent || 0).toFixed(1)}%</span>
    </div>
    <div class="card sales-report-stat">
      <div class="sales-stat-top">
        <small>Gastos</small>
        <i class="sales-stat-icon-free ph-duotone ph-receipt icon-violet"></i>
      </div>
      <strong>${fmtMoney(expenses)}</strong>
      <span>Manuales y registrados en caja</span>
    </div>
    <div class="card sales-report-stat">
      <div class="sales-stat-top">
        <small>Compras recibidas</small>
        <i class="sales-stat-icon-free ph-duotone ph-shopping-cart-simple icon-sky"></i>
      </div>
      <strong>${fmtMoney(purchases)}</strong>
      <span>Entrada de inventario; no duplica costo</span>
    </div>
    <div class="card sales-report-stat ${Number(cashResult) < 0 ? 'sales-report-stat-loss' : ''}">
      <div class="sales-stat-top">
        <small>Resultado de efectivo</small>
        <i class="sales-stat-icon-free ph-duotone ph-wallet ${Number(cashResult) < 0 ? 'icon-rose' : 'icon-amber'}"></i>
      </div>
      <strong>${fmtMoney(cashResult)}</strong>
      <span>Ventas menos compras y gastos</span>
    </div>`;
}

function renderSalesCalendar() {
  const host = $('#salesCalendarGrid');
  if (!host || !SALES_REPORT_DATA) return;
  const rows = SALES_REPORT_DATA.daily || [];
  const title = `${salesMonthName(SALES_REPORT_MONTH)} ${SALES_REPORT_YEAR}`;
  $('#salesCalendarTitle').textContent = title.charAt(0).toUpperCase() + title.slice(1);
  $('#salesDailyScope').textContent = salesScopeLabel();

  if (!rows.length) {
    host.innerHTML = emptyHTML('ph-calendar-x', 'No hay días para mostrar', 'Selecciona otro periodo.');
    return;
  }

  const firstWeekday = new Date(`${rows[0].date}T12:00:00`).getDay();
  const bestDate = SALES_REPORT_DATA.summary?.bestDay?.sales > 0 ? SALES_REPORT_DATA.summary.bestDay.date : '';
  const blanks = Array.from({ length: firstWeekday }, () => '<div class="sales-calendar-empty" aria-hidden="true"></div>');
  const days = rows.map((row) => {
    const hasSales = Number(row.sales) > 0;
    const isBest = row.date === bestDate;
    const classes = ['sales-calendar-day', hasSales ? 'has-sales' : 'no-sales', isBest ? 'is-best' : ''].filter(Boolean).join(' ');
    const cash = Number(row.cash || 0);
    const card = Number(row.card || 0);
    const transfer = Number(row.transfer || 0);

    const paymentBadges = [];
    if (cash > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-cash" title="Efectivo: ${fmtMoney(cash)}"><i class="ph-bold ph-money"></i> Efec ${fmtMoney(cash)}</span>`);
    if (card > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-card" title="Tarjeta: ${fmtMoney(card)}"><i class="ph-bold ph-credit-card"></i> Tarj ${fmtMoney(card)}</span>`);
    if (transfer > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-transfer" title="Transferencia: ${fmtMoney(transfer)}"><i class="ph-bold ph-bank"></i> Transf ${fmtMoney(transfer)}</span>`);
    if (Number(row.other || 0) > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-other" title="Otros: ${fmtMoney(row.other)}"><i class="ph-bold ph-dots-three-circle"></i> Otro ${fmtMoney(row.other)}</span>`);

    const paymentsHtml = paymentBadges.length
      ? `<div class="sales-calendar-payments">${paymentBadges.join('')}</div>`
      : (hasSales ? `<div class="sales-calendar-payments"><span class="sales-pay-chip sales-pay-cash"><i class="ph-bold ph-money"></i> Efec ${fmtMoney(row.sales)}</span></div>` : '');

    return `<article class="${classes}" role="button" tabindex="0" data-sales-detail-date="${row.date}" title="Ver detalle e imprimir este día">
      <div class="sales-calendar-day-head"><b>${row.day}</b>${isBest ? '<span><i class="ph-fill ph-trophy"></i> Mejor día</span>' : ''}</div>
      <strong>${fmtMoney(row.sales)}</strong>
      <small>${row.tickets} ${Number(row.tickets) === 1 ? 'venta' : 'ventas'} · Costo ${fmtMoney(row.cogs)}</small>
      ${paymentsHtml}
      <span class="sales-calendar-result ${Number(row.netProfit) < 0 ? 'loss' : 'profit'}">${Number(row.netProfit) < 0 ? 'Pérdida' : 'Utilidad'} ${fmtMoney(row.netProfit)}</span>
    </article>`;
  });
  host.innerHTML = [...blanks, ...days].join('');
  host.querySelectorAll('[data-sales-detail-date]').forEach((card) => {
    const open = () => {
      const date = card.dataset.salesDetailDate;
      const label = new Date(`${date}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      openSalesDetail(date, date, label);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  });
}

function renderSalesDailyChart() {
  const canvas = $('#salesDailyChart');
  if (!canvas || !SALES_REPORT_DATA) return;
  if (SALES_DAILY_CHART) SALES_DAILY_CHART.destroy();
  const primary = ME?.tenant?.primaryColor || '#16a34a';
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 280);
  gradient.addColorStop(0, `${primary}55`);
  gradient.addColorStop(1, `${primary}05`);
  SALES_DAILY_CHART = new Chart(ctx, {
    type: 'line',
    data: {
      labels: SALES_REPORT_DATA.daily.map((row) => row.day),
      datasets: [{
        label: 'Ventas',
        data: SALES_REPORT_DATA.daily.map((row) => row.sales),
        borderColor: primary,
        backgroundColor: gradient,
        borderWidth: 3,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#fff',
        pointBorderColor: primary,
        pointBorderWidth: 2,
        fill: true,
        tension: 0.35,
      }, {
        label: 'Compras recibidas',
        data: SALES_REPORT_DATA.daily.map((row) => row.purchases),
        borderColor: '#2563eb',
        backgroundColor: '#2563eb',
        borderWidth: 2,
        borderDash: [5, 4],
        pointRadius: 2,
        fill: false,
        tension: 0.25,
      }, {
        label: 'Utilidad neta',
        data: SALES_REPORT_DATA.daily.map((row) => row.netProfit),
        borderColor: '#f59e0b',
        backgroundColor: '#f59e0b',
        borderWidth: 2,
        pointRadius: 2,
        fill: false,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (context) => ` ${fmtMoney(context.parsed.y)}` } },
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#eef0f6' }, ticks: { callback: (value) => fmtMoney(value) } },
        x: { title: { display: true, text: 'Día del mes' }, grid: { display: false } },
      },
    },
  });
}

function renderSalesBranchBreakdown() {
  const host = $('#salesBranchBreakdown');
  if (!host || !SALES_REPORT_DATA) return;
  const rows = SALES_REPORT_DATA.branchBreakdown || [];
  if (!rows.length) {
    host.innerHTML = emptyHTML('ph-storefront', 'Sin ventas en este mes', 'No hay operaciones registradas para el filtro seleccionado.');
    return;
  }
  host.innerHTML = `<div class="table-wrap"><table class="sales-branch-table"><thead><tr><th>Sucursal</th><th>Ventas</th><th>Efectivo</th><th>Tarjeta</th><th>Transferencia</th><th>Costo vendido</th><th>Compras</th><th>Gastos</th><th>Utilidad / pérdida</th><th>Resultado efectivo</th></tr></thead><tbody>${rows.map((row) => {
    return `<tr><td><b>${esc(row.name)}</b><small>${row.tickets} operaciones</small></td><td><b>${fmtMoney(row.sales)}</b></td><td><span class="sales-pay-chip sales-pay-cash">${fmtMoney(row.cash || 0)}</span></td><td><span class="sales-pay-chip sales-pay-card">${fmtMoney(row.card || 0)}</span></td><td><span class="sales-pay-chip sales-pay-transfer">${fmtMoney(row.transfer || 0)}</span></td><td>${fmtMoney(row.cogs)}</td><td>${fmtMoney(row.purchases)}</td><td>${fmtMoney(row.expenses)}</td><td><b class="${Number(row.netProfit) < 0 ? 'sales-value-loss' : 'sales-value-profit'}">${fmtMoney(row.netProfit)}</b><small>${Number(row.marginPercent || 0).toFixed(1)}%</small></td><td><b class="${Number(row.cashResult) < 0 ? 'sales-value-loss' : 'sales-value-profit'}">${fmtMoney(row.cashResult)}</b></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderSalesMonthly() {
  if (!SALES_REPORT_DATA) return;
  $('#salesMonthlyTitle').textContent = `Ventas por mes · ${SALES_REPORT_YEAR}`;
  $('#salesMonthlyScope').textContent = salesScopeLabel();
  const host = $('#salesMonthGrid');
  const bestMonth = SALES_REPORT_DATA.summary?.bestMonth?.sales > 0 ? Number(SALES_REPORT_DATA.summary.bestMonth.month) : 0;
  host.innerHTML = SALES_REPORT_DATA.monthly.map((row) => {
    const cash = Number(row.cash || 0);
    const card = Number(row.card || 0);
    const transfer = Number(row.transfer || 0);
    const paymentBadges = [];
    if (cash > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-cash" title="Efectivo: ${fmtMoney(cash)}"><i class="ph-bold ph-money"></i> Efec ${fmtMoney(cash)}</span>`);
    if (card > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-card" title="Tarjeta: ${fmtMoney(card)}"><i class="ph-bold ph-credit-card"></i> Tarj ${fmtMoney(card)}</span>`);
    if (transfer > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-transfer" title="Transferencia: ${fmtMoney(transfer)}"><i class="ph-bold ph-bank"></i> Transf ${fmtMoney(transfer)}</span>`);
    if (Number(row.other || 0) > 0) paymentBadges.push(`<span class="sales-pay-chip sales-pay-other" title="Otros: ${fmtMoney(row.other)}"><i class="ph-bold ph-dots-three-circle"></i> Otro ${fmtMoney(row.other)}</span>`);

    const paymentsHtml = paymentBadges.length
      ? `<div class="sales-calendar-payments">${paymentBadges.join('')}</div>`
      : (Number(row.sales) > 0 ? `<div class="sales-calendar-payments"><span class="sales-pay-chip sales-pay-cash"><i class="ph-bold ph-money"></i> Efec ${fmtMoney(row.sales)}</span></div>` : '');

    return `
      <article class="card sales-month-card ${Number(row.month) === bestMonth ? 'is-best' : ''}" role="button" tabindex="0" data-sales-detail-month="${row.month}" title="Ver detalle e imprimir este mes">
        <div><span>${esc(row.label)}</span>${Number(row.month) === bestMonth ? '<i class="ph-fill ph-trophy" title="Mejor mes"></i>' : ''}</div>
        <strong>${fmtMoney(row.sales)}</strong>
        <small>${row.tickets} ${Number(row.tickets) === 1 ? 'venta' : 'ventas'} · Costo ${fmtMoney(row.cogs)}</small>
        ${paymentsHtml}
        <span class="sales-month-result ${Number(row.netProfit) < 0 ? 'loss' : 'profit'}">${Number(row.netProfit) < 0 ? 'Pérdida' : 'Utilidad'} ${fmtMoney(row.netProfit)}</span>
      </article>`;
  }).join('');
  host.querySelectorAll('[data-sales-detail-month]').forEach((card) => {
    const open = () => {
      const month = Number(card.dataset.salesDetailMonth);
      const start = `${SALES_REPORT_YEAR}-${String(month).padStart(2, '0')}-01`;
      const end = `${SALES_REPORT_YEAR}-${String(month).padStart(2, '0')}-${String(new Date(SALES_REPORT_YEAR, month, 0).getDate()).padStart(2, '0')}`;
      openSalesDetail(start, end, `${salesMonthName(month)} ${SALES_REPORT_YEAR}`);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  });

  const canvas = $('#salesMonthlyChart');
  if (SALES_MONTHLY_CHART) SALES_MONTHLY_CHART.destroy();
  const primary = ME?.tenant?.primaryColor || '#16a34a';
  SALES_MONTHLY_CHART = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: SALES_REPORT_DATA.monthly.map((row) => row.label.slice(0, 3)),
      datasets: [{
        label: 'Ventas',
        data: SALES_REPORT_DATA.monthly.map((row) => row.sales),
        backgroundColor: SALES_REPORT_DATA.monthly.map((row) => Number(row.month) === bestMonth ? '#f59e0b' : `${primary}cc`),
        borderRadius: 9,
        borderSkipped: false,
        maxBarThickness: 54,
      }, {
        label: 'Compras recibidas',
        data: SALES_REPORT_DATA.monthly.map((row) => row.purchases),
        backgroundColor: '#2563ebbb',
        borderRadius: 9,
        borderSkipped: false,
        maxBarThickness: 40,
      }, {
        label: 'Utilidad neta',
        data: SALES_REPORT_DATA.monthly.map((row) => row.netProfit),
        backgroundColor: SALES_REPORT_DATA.monthly.map((row) => Number(row.netProfit) < 0 ? '#ef4444cc' : '#10b981cc'),
        borderRadius: 9,
        borderSkipped: false,
        maxBarThickness: 40,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8 } },
        tooltip: { callbacks: { label: (context) => ` ${fmtMoney(context.parsed.y)}` } },
      },
      scales: {
        y: { beginAtZero: true, grid: { color: '#eef0f6' }, ticks: { callback: (value) => fmtMoney(value) } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderSalesReport() {
  if (!SALES_REPORT_DATA) return;
  const dailyMode = SALES_REPORT_MODE === 'daily';
  $('#salesDailyPanel').hidden = !dailyMode;
  $('#salesMonthlyPanel').hidden = dailyMode;
  $('#salesDailyControls').hidden = !dailyMode;
  $('#salesMonthlyControls').hidden = dailyMode;
  document.querySelectorAll('#salesReportTabs [data-sales-mode]').forEach((button) => {
    button.classList.toggle('on', button.dataset.salesMode === SALES_REPORT_MODE);
  });
  renderSalesReportStats();
  if (dailyMode) {
    renderSalesCalendar();
    renderSalesBranchBreakdown();
    requestAnimationFrame(renderSalesDailyChart);
  } else {
    requestAnimationFrame(renderSalesMonthly);
  }
}

async function loadSalesReport() {
  const refreshButton = $('#salesRefreshBtn');
  if (refreshButton) refreshButton.disabled = true;
  try {
    const query = new URLSearchParams({
      year: String(SALES_REPORT_YEAR),
      month: String(SALES_REPORT_MONTH),
      branch: SALES_REPORT_BRANCH,
    });
    SALES_REPORT_DATA = await api(`/api/sales/report?${query.toString()}`);
    SALES_REPORT_YEAR = Number(SALES_REPORT_DATA.filters.year);
    SALES_REPORT_MONTH = Number(SALES_REPORT_DATA.filters.month);
    SALES_REPORT_BRANCH = String(SALES_REPORT_DATA.filters.branch || 'all');
    $('#salesMonthFilter').value = `${SALES_REPORT_YEAR}-${String(SALES_REPORT_MONTH).padStart(2, '0')}`;
    $('#salesYearFilter').value = SALES_REPORT_YEAR;
    populateSalesBranchFilter();
    renderSalesReport();
  } finally {
    if (refreshButton) refreshButton.disabled = false;
  }
}

function refreshSalesReportSafely() {
  loadSalesReport().catch((error) => toast(error.message || 'No se pudo cargar el reporte de ventas', true));
}

function shiftSalesMonth(delta) {
  const date = new Date(SALES_REPORT_YEAR, SALES_REPORT_MONTH - 1 + delta, 1);
  SALES_REPORT_YEAR = date.getFullYear();
  SALES_REPORT_MONTH = date.getMonth() + 1;
  refreshSalesReportSafely();
}

document.querySelectorAll('#salesReportTabs [data-sales-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    SALES_REPORT_MODE = button.dataset.salesMode === 'monthly' ? 'monthly' : 'daily';
    renderSalesReport();
  });
});
$('#salesBranchFilter')?.addEventListener('change', (event) => {
  SALES_REPORT_BRANCH = String(event.target.value || 'all');
  refreshSalesReportSafely();
});
$('#salesMonthFilter')?.addEventListener('change', (event) => {
  const match = String(event.target.value || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return;
  SALES_REPORT_YEAR = Number(match[1]);
  SALES_REPORT_MONTH = Number(match[2]);
  refreshSalesReportSafely();
});
$('#salesYearFilter')?.addEventListener('change', (event) => {
  SALES_REPORT_YEAR = Math.max(2000, Math.min(2100, Number(event.target.value) || new Date().getFullYear()));
  refreshSalesReportSafely();
});
$('#salesPrevMonthBtn')?.addEventListener('click', () => shiftSalesMonth(-1));
$('#salesNextMonthBtn')?.addEventListener('click', () => shiftSalesMonth(1));
$('#salesPrevYearBtn')?.addEventListener('click', () => {
  SALES_REPORT_YEAR = Math.max(2000, SALES_REPORT_YEAR - 1);
  refreshSalesReportSafely();
});
$('#salesNextYearBtn')?.addEventListener('click', () => {
  SALES_REPORT_YEAR = Math.min(2100, SALES_REPORT_YEAR + 1);
  refreshSalesReportSafely();
});
$('#salesRefreshBtn')?.addEventListener('click', refreshSalesReportSafely);

function salesIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setSalesDetailQuickRange(mode) {
  SALES_DETAIL_RANGE_MODE = ['day', 'week', 'month', 'custom'].includes(mode) ? mode : 'day';
  const today = new Date();
  let start = new Date(today);
  let end = new Date(today);
  if (SALES_DETAIL_RANGE_MODE === 'week') {
    const weekday = today.getDay();
    start.setDate(today.getDate() + (weekday === 0 ? -6 : 1 - weekday));
    end = new Date(start);
    end.setDate(start.getDate() + 6);
  } else if (SALES_DETAIL_RANGE_MODE === 'month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  }
  if (SALES_DETAIL_RANGE_MODE !== 'custom' || !$('#salesDetailStartDate').value || !$('#salesDetailEndDate').value) {
    $('#salesDetailStartDate').value = salesIsoDate(start);
    $('#salesDetailEndDate').value = salesIsoDate(end);
  }
  document.querySelectorAll('#salesDetailQuickRange [data-sales-range]').forEach((button) => button.classList.toggle('on', button.dataset.salesRange === SALES_DETAIL_RANGE_MODE));
  $('#salesDetailStartDate').classList.toggle('is-custom', SALES_DETAIL_RANGE_MODE === 'custom');
  $('#salesDetailEndDate').classList.toggle('is-custom', SALES_DETAIL_RANGE_MODE === 'custom');
}

function salesDetailRangeTitle(startDate, endDate) {
  const format = (value) => new Date(`${value}T12:00:00`).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
  return startDate === endDate ? format(startDate) : `${format(startDate)} al ${format(endDate)}`;
}

function salesDetailPaymentLabel(sale) {
  const labels = { cash: 'Efectivo', card: 'Tarjeta', transfer: 'Transferencia', mixed: 'Mixto', other: 'Otro' };
  const label = labels[sale.paymentMethod] || 'Otro';
  if (sale.paymentMethod !== 'mixed') return label;
  const parts = [];
  if (Number(sale.paymentBreakdown?.cash) > 0) parts.push(`Efectivo ${fmtMoney(sale.paymentBreakdown.cash)}`);
  if (Number(sale.paymentBreakdown?.card) > 0) parts.push(`Tarjeta ${fmtMoney(sale.paymentBreakdown.card)}`);
  if (Number(sale.paymentBreakdown?.transfer) > 0) parts.push(`Transferencia ${fmtMoney(sale.paymentBreakdown.transfer)}`);
  return parts.length ? `Mixto · ${parts.join(' / ')}` : label;
}

function renderSalesDetail(data) {
  const host = $('#salesDetailContent');
  if (!host) return;
  const summary = data.summary || {};
  const netLoss = Number(summary.netProfit) < 0;
  const salesRows = data.sales.length ? `<table><thead><tr><th>Ticket</th><th>Fecha</th><th>Sucursal</th><th>Origen</th><th>Forma de pago</th><th>Venta</th><th>Costo</th><th>Utilidad</th></tr></thead><tbody>${data.sales.map((sale) => `<tr>
    <td><b>#${sale.id}</b>${sale.tableNumber ? `<small>Mesa ${sale.tableNumber}${sale.waiterName ? ` · ${esc(sale.waiterName)}` : ''}</small>` : ''}</td>
    <td>${esc(sale.createdAt)}</td><td>${esc(sale.branchName)}</td><td>${sale.channel === 'pos' ? 'POS' : 'Chatbot'}</td><td>${esc(salesDetailPaymentLabel(sale))}</td>
    <td><b>${fmtMoney(sale.total)}</b></td><td>${fmtMoney(sale.cogs)}</td><td><b class="${Number(sale.grossProfit) < 0 ? 'sales-value-loss' : 'sales-value-profit'}">${fmtMoney(sale.grossProfit)}</b></td></tr>`).join('')}</tbody></table>` : emptyHTML('ph-receipt', 'Sin ventas en el periodo', 'No se encontraron operaciones no canceladas.');
  const productRows = data.products.length ? `<table><thead><tr><th>Producto</th><th>Cantidad</th><th>Ventas</th><th>Costo</th><th>Utilidad</th></tr></thead><tbody>${data.products.map((row) => `<tr><td><b>${esc(row.name)}</b></td><td>${row.quantity}</td><td>${fmtMoney(row.sales)}</td><td>${fmtMoney(row.cogs)}</td><td><b class="${Number(row.profit) < 0 ? 'sales-value-loss' : 'sales-value-profit'}">${fmtMoney(row.profit)}</b></td></tr>`).join('')}</tbody></table>` : emptyHTML('ph-package', 'Sin productos vendidos', 'No hay productos en este periodo.');
  const expenseRows = data.expenses.length ? `<table><thead><tr><th>Fecha</th><th>Sucursal</th><th>Concepto</th><th>Origen</th><th>Monto</th></tr></thead><tbody>${data.expenses.map((expense) => `<tr><td>${esc(expense.createdAt || expense.date)}</td><td>${esc(expense.branchName)}</td><td><b>${esc(expense.concept)}</b>${expense.notes ? `<small>${esc(expense.notes)}</small>` : ''}</td><td>${expense.source === 'pos' ? 'Caja POS' : 'Manual'}</td><td><b class="sales-value-loss">${fmtMoney(expense.amount)}</b></td></tr>`).join('')}</tbody></table>` : emptyHTML('ph-receipt', 'Sin gastos en el periodo', 'No existen gastos manuales ni gastos registrados en caja.');
  const purchaseRows = data.purchases?.length ? `<table><thead><tr><th>Orden</th><th>Recepción</th><th>Proveedor</th><th>Sucursal</th><th>Productos</th><th>Total</th></tr></thead><tbody>${data.purchases.map((purchase) => `<tr><td><b>${esc(purchase.orderNumber)}</b></td><td>${esc(purchase.receivedAt)}</td><td>${esc(purchase.supplierName)}</td><td>${esc(purchase.branchName)}</td><td>${purchase.items.map((item) => `${esc(item.name)} × ${item.quantity}`).join('<br>')}</td><td><b>${fmtMoney(purchase.total)}</b></td></tr>`).join('')}</tbody></table>` : emptyHTML('ph-shopping-cart-simple', 'Sin compras recibidas', 'No hubo entradas de inventario por compra en este periodo.');
  host.innerHTML = `
    <div class="sales-detail-summary">
      <div><small>Ventas</small><strong>${fmtMoney(summary.sales)}</strong><span>${summary.tickets} operaciones</span></div>
      <div><small>Costo de ventas</small><strong>${fmtMoney(summary.cogs)}</strong><span>Unidades vendidas</span></div>
      <div><small>Utilidad bruta</small><strong>${fmtMoney(summary.grossProfit)}</strong><span>Antes de gastos</span></div>
      <div><small>Gastos</small><strong>${fmtMoney(summary.expenses)}</strong><span>Caja y manuales</span></div>
      <div><small>Compras recibidas</small><strong>${fmtMoney(summary.purchases)}</strong><span>Flujo destinado a inventario</span></div>
      <div class="${netLoss ? 'loss' : 'profit'}"><small>${netLoss ? 'Pérdida neta' : 'Utilidad neta'}</small><strong>${fmtMoney(summary.netProfit)}</strong><span>Margen ${Number(summary.marginPercent || 0).toFixed(1)}%</span></div>
      <div class="${Number(summary.cashResult) < 0 ? 'loss' : 'profit'}"><small>Resultado de efectivo</small><strong>${fmtMoney(summary.cashResult)}</strong><span>Ventas − compras − gastos</span></div>
      <div><small>Ticket promedio</small><strong>${fmtMoney(summary.averageTicket)}</strong><span>Promedio del periodo</span></div>
    </div>
    <div class="sales-detail-payments">
      <div><i class="ph-bold ph-money"></i><span>Efectivo</span><b>${fmtMoney(data.payments.cash)}</b></div>
      <div><i class="ph-bold ph-credit-card"></i><span>Tarjeta</span><b>${fmtMoney(data.payments.card)}</b></div>
      <div><i class="ph-bold ph-bank"></i><span>Transferencia</span><b>${fmtMoney(data.payments.transfer)}</b></div>
      <div><i class="ph-bold ph-dots-three-circle"></i><span>Otros</span><b>${fmtMoney(data.payments.other)}</b></div>
    </div>
    <div class="sales-detail-section"><h4><i class="ph-bold ph-receipt"></i> Ventas y formas de pago</h4><div class="table-wrap">${salesRows}</div></div>
    <div class="sales-detail-section"><h4><i class="ph-bold ph-shopping-cart-simple"></i> Compras recibidas <small>Se muestran aparte: aumentan inventario y sólo se vuelven costo cuando el producto se vende.</small></h4><div class="table-wrap">${purchaseRows}</div></div>
    <div class="sales-detail-columns">
      <div class="sales-detail-section"><h4><i class="ph-bold ph-package"></i> Productos vendidos</h4><div class="table-wrap">${productRows}</div></div>
      <div class="sales-detail-section"><h4><i class="ph-bold ph-money-wavy"></i> Gastos</h4><div class="table-wrap">${expenseRows}</div></div>
    </div>`;
}

async function fetchSalesDetail(startDate, endDate, title = '') {
  if (!startDate || !endDate) throw new Error('Selecciona las fechas del reporte');
  const query = new URLSearchParams({ startDate, endDate, branch: SALES_REPORT_BRANCH });
  const data = await api(`/api/sales/detail?${query.toString()}`);
  SALES_DETAIL_DATA = data;
  SALES_DETAIL_TITLE = title || salesDetailRangeTitle(startDate, endDate);
  return data;
}

async function openSalesDetail(startDate, endDate, title = '') {
  try {
    $('#salesDetailModalTitle').textContent = 'Cargando detalle…';
    $('#salesDetailModalSubtitle').textContent = '';
    $('#salesDetailContent').innerHTML = '<div class="empty"><div class="spinner"></div><p>Preparando información financiera…</p></div>';
    openModal('salesDetailModal');
    const data = await fetchSalesDetail(startDate, endDate, title);
    $('#salesDetailModalTitle').textContent = SALES_DETAIL_TITLE;
    $('#salesDetailModalSubtitle').textContent = `${salesScopeLabel()} · ${data.filters.rangeDays} día${data.filters.rangeDays === 1 ? '' : 's'}`;
    renderSalesDetail(data);
  } catch (error) {
    closeModal('salesDetailModal');
    toast(error.message || 'No se pudo cargar el detalle', true);
  }
}

function salesDetailFileBase(data = SALES_DETAIL_DATA) {
  const start = data?.filters?.startDate || 'inicio';
  const end = data?.filters?.endDate || 'fin';
  return `ventas_${start}_${end}`;
}

function salesDetailPrintHtml(data) {
  const s = data.summary;
  const paymentRows = [
    ['Efectivo', data.payments.cash], ['Tarjeta', data.payments.card], ['Transferencia', data.payments.transfer], ['Otros', data.payments.other],
  ].map(([name, amount]) => `<tr><td>${name}</td><td class="num">${esc(fmtMoney(amount))}</td></tr>`).join('');
  const salesRows = data.sales.map((sale) => `<tr><td>#${sale.id}</td><td>${esc(sale.createdAt)}</td><td>${esc(sale.branchName)}</td><td>${esc(salesDetailPaymentLabel(sale))}</td><td class="num">${esc(fmtMoney(sale.total))}</td><td class="num">${esc(fmtMoney(sale.cogs))}</td><td class="num">${esc(fmtMoney(sale.grossProfit))}</td></tr>`).join('');
  const purchaseRows = (data.purchases || []).map((row) => `<tr><td>${esc(row.orderNumber)}</td><td>${esc(row.receivedAt)}</td><td>${esc(row.supplierName)}</td><td>${esc(row.branchName)}</td><td class="num">${esc(fmtMoney(row.total))}</td></tr>`).join('');
  const expenseRows = data.expenses.map((row) => `<tr><td>${esc(row.createdAt || row.date)}</td><td>${esc(row.branchName)}</td><td>${esc(row.concept)}</td><td class="num">${esc(fmtMoney(row.amount))}</td></tr>`).join('');
  const productRows = data.products.map((row) => `<tr><td>${esc(row.name)}</td><td class="num">${row.quantity}</td><td class="num">${esc(fmtMoney(row.sales))}</td><td class="num">${esc(fmtMoney(row.cogs))}</td><td class="num">${esc(fmtMoney(row.profit))}</td></tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(SALES_DETAIL_TITLE)}</title><style>body{font-family:Arial,sans-serif;color:#172033;padding:24px;font-size:11px}h1{font-size:21px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px}.muted{color:#64748b}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}.summary div{border:1px solid #dfe4ec;border-radius:8px;padding:9px}.summary small{display:block;color:#64748b;text-transform:uppercase;font-weight:700}.summary b{display:block;font-size:16px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-bottom:14px}th,td{padding:6px;border-bottom:1px solid #e5e7eb;text-align:left}th{background:#f1f5f9;font-size:9px;text-transform:uppercase}.num{text-align:right}@media print{button{display:none}}</style></head><body><h1>${esc(ME?.tenant?.businessName || SETTINGS?.business_name || 'Reporte de ventas')}</h1><div class="muted">${esc(SALES_DETAIL_TITLE)} · ${esc(salesScopeLabel())}</div><div class="summary"><div><small>Ventas</small><b>${esc(fmtMoney(s.sales))}</b></div><div><small>Costo vendido</small><b>${esc(fmtMoney(s.cogs))}</b></div><div><small>Compras</small><b>${esc(fmtMoney(s.purchases))}</b></div><div><small>Gastos</small><b>${esc(fmtMoney(s.expenses))}</b></div><div><small>Utilidad bruta</small><b>${esc(fmtMoney(s.grossProfit))}</b></div><div><small>Utilidad / pérdida neta</small><b>${esc(fmtMoney(s.netProfit))}</b></div><div><small>Resultado efectivo</small><b>${esc(fmtMoney(s.cashResult))}</b></div><div><small>Margen neto</small><b>${Number(s.marginPercent || 0).toFixed(1)}%</b></div></div><h2>Formas de pago</h2><table><thead><tr><th>Forma</th><th class="num">Total</th></tr></thead><tbody>${paymentRows}</tbody></table><h2>Ventas</h2><table><thead><tr><th>Ticket</th><th>Fecha</th><th>Sucursal</th><th>Pago</th><th class="num">Venta</th><th class="num">Costo</th><th class="num">Utilidad</th></tr></thead><tbody>${salesRows || '<tr><td colspan="7">Sin ventas</td></tr>'}</tbody></table><h2>Compras recibidas</h2><table><thead><tr><th>Orden</th><th>Recepción</th><th>Proveedor</th><th>Sucursal</th><th class="num">Total</th></tr></thead><tbody>${purchaseRows || '<tr><td colspan="5">Sin compras</td></tr>'}</tbody></table><h2>Productos vendidos</h2><table><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Ventas</th><th class="num">Costo</th><th class="num">Utilidad</th></tr></thead><tbody>${productRows || '<tr><td colspan="5">Sin productos</td></tr>'}</tbody></table><h2>Gastos</h2><table><thead><tr><th>Fecha</th><th>Sucursal</th><th>Concepto</th><th class="num">Monto</th></tr></thead><tbody>${expenseRows || '<tr><td colspan="4">Sin gastos</td></tr>'}</tbody></table></body></html>`;
}

function printSalesDetail() {
  if (!SALES_DETAIL_DATA) return toast('Primero abre un detalle de ventas', true);
  const popup = window.open('', '_blank', 'width=1100,height=800');
  if (!popup) return toast('Permite ventanas emergentes para imprimir', true);
  popup.document.open(); popup.document.write(salesDetailPrintHtml(SALES_DETAIL_DATA)); popup.document.close();
  popup.onload = () => { popup.focus(); popup.print(); };
}

function exportSalesDetailExcel(data = SALES_DETAIL_DATA) {
  if (!data || !globalThis.XLSX) return toast('No se pudo preparar el archivo Excel', true);
  const workbook = XLSX.utils.book_new();
  const s = data.summary;
  const summaryRows = [
    ['Periodo', SALES_DETAIL_TITLE], ['Sucursal', salesScopeLabel()], ['Ventas', s.sales], ['Costo de ventas', s.cogs],
    ['Utilidad bruta', s.grossProfit], ['Compras recibidas', s.purchases], ['Gastos', s.expenses], ['Utilidad o pérdida neta', s.netProfit],
    ['Resultado de efectivo (ventas - compras - gastos)', s.cashResult],
    ['Margen neto %', s.marginPercent], ['Operaciones', s.tickets], ['Ticket promedio', s.averageTicket],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Concepto', 'Valor'], ...summaryRows]), 'Resumen');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { Forma: 'Efectivo', Total: data.payments.cash }, { Forma: 'Tarjeta', Total: data.payments.card },
    { Forma: 'Transferencia', Total: data.payments.transfer }, { Forma: 'Otros', Total: data.payments.other },
  ]), 'Formas de pago');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.sales.map((row) => ({ Ticket: row.id, Fecha: row.createdAt, Sucursal: row.branchName, Origen: row.channel, Pago: salesDetailPaymentLabel(row), Venta: row.total, Costo: row.cogs, Utilidad: row.grossProfit }))), 'Ventas');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet((data.purchases || []).map((row) => ({ Orden: row.orderNumber, Recepción: row.receivedAt, Proveedor: row.supplierName, Sucursal: row.branchName, Total: row.total, Productos: row.items.map((item) => `${item.name} x ${item.quantity}`).join('; ') }))), 'Compras');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.products.map((row) => ({ Producto: row.name, Cantidad: row.quantity, Ventas: row.sales, Costo: row.cogs, Utilidad: row.profit }))), 'Productos');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data.expenses.map((row) => ({ Fecha: row.createdAt || row.date, Sucursal: row.branchName, Concepto: row.concept, Origen: row.source === 'pos' ? 'Caja POS' : 'Manual', Monto: row.amount }))), 'Gastos');
  XLSX.writeFile(workbook, `${salesDetailFileBase(data)}.xlsx`);
}

function exportSalesDetailPdf(data = SALES_DETAIL_DATA) {
  if (!data || !globalThis.jspdf?.jsPDF) return toast('No se pudo preparar el archivo PDF', true);
  const doc = new globalThis.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'letter' });
  const s = data.summary;
  doc.setFontSize(16); doc.text(ME?.tenant?.businessName || SETTINGS?.business_name || 'Reporte de ventas', 14, 14);
  doc.setFontSize(9); doc.setTextColor(90); doc.text(`${SALES_DETAIL_TITLE} · ${salesScopeLabel()}`, 14, 20); doc.setTextColor(0);
  doc.autoTable({ startY: 25, theme: 'grid', head: [['Ventas', 'Costo vendido', 'Compras', 'Gastos', 'Utilidad neta', 'Resultado efectivo', 'Margen']], body: [[fmtMoney(s.sales), fmtMoney(s.cogs), fmtMoney(s.purchases), fmtMoney(s.expenses), fmtMoney(s.netProfit), fmtMoney(s.cashResult), `${Number(s.marginPercent || 0).toFixed(1)}%`]], styles: { fontSize: 8 }, headStyles: { fillColor: [30, 136, 76] } });
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 5, theme: 'striped', head: [['Forma de pago', 'Total']], body: [['Efectivo', fmtMoney(data.payments.cash)], ['Tarjeta', fmtMoney(data.payments.card)], ['Transferencia', fmtMoney(data.payments.transfer)], ['Otros', fmtMoney(data.payments.other)]], styles: { fontSize: 8 }, tableWidth: 90 });
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 6, theme: 'striped', head: [['Ticket', 'Fecha', 'Sucursal', 'Origen', 'Pago', 'Venta', 'Costo', 'Utilidad']], body: data.sales.map((row) => [`#${row.id}`, row.createdAt, row.branchName, row.channel === 'pos' ? 'POS' : 'Chatbot', salesDetailPaymentLabel(row), fmtMoney(row.total), fmtMoney(row.cogs), fmtMoney(row.grossProfit)]), styles: { fontSize: 7 }, headStyles: { fillColor: [37, 99, 235] } });
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 6, theme: 'striped', head: [['Orden', 'Recepción', 'Proveedor', 'Sucursal', 'Total']], body: (data.purchases || []).map((row) => [row.orderNumber, row.receivedAt, row.supplierName, row.branchName, fmtMoney(row.total)]), styles: { fontSize: 7 }, headStyles: { fillColor: [234, 88, 12] } });
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 6, theme: 'striped', head: [['Producto', 'Cantidad', 'Ventas', 'Costo', 'Utilidad']], body: data.products.map((row) => [row.name, row.quantity, fmtMoney(row.sales), fmtMoney(row.cogs), fmtMoney(row.profit)]), styles: { fontSize: 7 }, headStyles: { fillColor: [124, 58, 237] } });
  doc.autoTable({ startY: doc.lastAutoTable.finalY + 6, theme: 'striped', head: [['Fecha', 'Sucursal', 'Concepto', 'Origen', 'Monto']], body: data.expenses.map((row) => [row.createdAt || row.date, row.branchName, row.concept, row.source === 'pos' ? 'Caja POS' : 'Manual', fmtMoney(row.amount)]), styles: { fontSize: 7 }, headStyles: { fillColor: [220, 38, 38] } });
  doc.save(`${salesDetailFileBase(data)}.pdf`);
}

async function salesDetailToolbarAction(action) {
  const start = $('#salesDetailStartDate').value;
  const end = $('#salesDetailEndDate').value;
  try {
    if (action === 'view') {
      await openSalesDetail(start, end, salesDetailRangeTitle(start, end));
      return;
    }
    const data = await fetchSalesDetail(start, end, salesDetailRangeTitle(start, end));
    if (action === 'pdf') exportSalesDetailPdf(data);
    else if (action === 'excel') exportSalesDetailExcel(data);
  } catch (error) { toast(error.message || 'No se pudo generar el reporte', true); }
}

document.querySelectorAll('#salesDetailQuickRange [data-sales-range]').forEach((button) => button.addEventListener('click', () => setSalesDetailQuickRange(button.dataset.salesRange)));
$('#salesDetailStartDate')?.addEventListener('change', () => setSalesDetailQuickRange('custom'));
$('#salesDetailEndDate')?.addEventListener('change', () => setSalesDetailQuickRange('custom'));
$('#salesDetailViewBtn')?.addEventListener('click', () => salesDetailToolbarAction('view'));
$('#salesDetailPdfBtn')?.addEventListener('click', () => salesDetailToolbarAction('pdf'));
$('#salesDetailExcelBtn')?.addEventListener('click', () => salesDetailToolbarAction('excel'));
$('#salesDetailCloseBtn')?.addEventListener('click', () => closeModal('salesDetailModal'));
$('#salesDetailPrintBtn')?.addEventListener('click', printSalesDetail);
$('#salesDetailModalPdfBtn')?.addEventListener('click', () => exportSalesDetailPdf());
$('#salesDetailModalExcelBtn')?.addEventListener('click', () => exportSalesDetailExcel());
setSalesDetailQuickRange('day');

/* ===== Costo de ventas ===== */
function costingMetrics(row) {
  const unitCost = Math.max(0, Number(row?.unitCost || 0));
  const salePrice = Math.max(0, Number(row?.salePrice || 0));
  const margin = Number((salePrice - unitCost).toFixed(2));
  const marginPercent = salePrice ? Number(((margin / salePrice) * 100).toFixed(2)) : 0;
  return { unitCost, salePrice, margin, marginPercent };
}

function costingMarginTone(margin) {
  if (margin < 0) return 'loss';
  if (margin === 0) return 'neutral';
  return 'profit';
}

function renderCostingStats() {
  const host = $('#costingStats');
  if (!host) return;
  const rows = costingFilteredProducts().map((product) => COSTING_DRAFT.get(Number(product.id)) || product);
  const configured = rows.filter((row) => Number(row.unitCost) > 0).length;
  const losses = rows.filter((row) => costingMetrics(row).margin < 0).length;
  const positive = rows.map(costingMetrics).filter((row) => row.salePrice > 0);
  const averageMargin = positive.length ? positive.reduce((sum, row) => sum + row.marginPercent, 0) / positive.length : 0;
  const unitProfit = rows.reduce((sum, row) => sum + costingMetrics(row).margin, 0);
  host.innerHTML = `
    <div class="card costing-stat"><i class="ph-bold ph-check-circle"></i><div><small>Costos configurados</small><strong>${configured} / ${rows.length}</strong></div></div>
    <div class="card costing-stat"><i class="ph-bold ph-percent"></i><div><small>Margen promedio</small><strong>${averageMargin.toFixed(1)}%</strong></div></div>
    <div class="card costing-stat ${losses ? 'danger' : ''}"><i class="ph-bold ph-warning-circle"></i><div><small>Productos con pérdida</small><strong>${losses}</strong></div></div>
    <div class="card costing-stat"><i class="ph-bold ph-trend-up"></i><div><small>Utilidad unitaria combinada</small><strong>${fmtMoney(unitProfit)}</strong></div></div>`;
}

function populateCostingFilters() {
  const category = $('#costingCategory');
  category.innerHTML = '<option value="all">Todas las categorías</option>' + COSTING_DATA.categories.map((row) => `<option value="${row.id}">${esc(row.name)}</option>`).join('');
  category.value = COSTING_CATEGORY;

  const branchOptions = COSTING_DATA.branches.map((row) => `<option value="${row.id}">${esc(row.name)}${row.active ? '' : ' (inactiva)'}</option>`).join('');
  $('#costingExpenseBranch').innerHTML = `<option value="general">Sin sucursal</option>${branchOptions}`;
  $('#costingExpenseFilterBranch').innerHTML = `<option value="all">Todas las sucursales</option><option value="general">Sin sucursal</option>${branchOptions}`;
  $('#costingExpenseFilterBranch').value = COSTING_EXPENSE_BRANCH;
}

function costingFilteredProducts() {
  const query = COSTING_SEARCH.trim().toLocaleLowerCase('es-MX');
  const rows = COSTING_DATA.products.filter((product) => {
    if (COSTING_CATEGORY !== 'all' && String(product.categoryId || '') !== COSTING_CATEGORY) return false;
    return !query || product.name.toLocaleLowerCase('es-MX').includes(query) || product.categoryName.toLocaleLowerCase('es-MX').includes(query);
  });
  return rows.sort((a, b) => {
    if (COSTING_SORT === 'category') {
      const category = a.categoryName.localeCompare(b.categoryName, 'es-MX');
      if (category) return category;
    }
    return a.name.localeCompare(b.name, 'es-MX');
  });
}

function updateCostingPendingLabel() {
  const count = COSTING_DIRTY.size;
  $('#costingPendingLabel').textContent = count ? `${count} cambio${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'} de guardar` : 'Sin cambios pendientes';
  $('#costingSaveBtn').disabled = !count;
  $('#costingSaveBottomBtn').disabled = !count;
}

function costingDraftStorageKey() {
  return `chatbotpro:costing-draft:${ME?.tenant?.slug || 'default'}`;
}

function persistCostingLocalDraft() {
  try {
    if (!COSTING_DIRTY.size) {
      localStorage.removeItem(costingDraftStorageKey());
      return;
    }
    const items = [...COSTING_DIRTY].map((id) => {
      const row = COSTING_DRAFT.get(id);
      return row ? { id, unitCost: row.unitCost, salePrice: row.salePrice } : null;
    }).filter(Boolean);
    localStorage.setItem(costingDraftStorageKey(), JSON.stringify({ items, savedAt: Date.now() }));
  } catch {}
}

function restoreCostingLocalDraft() {
  try {
    const parsed = JSON.parse(localStorage.getItem(costingDraftStorageKey()) || '{}');
    if (!Array.isArray(parsed.items)) return 0;
    let restored = 0;
    for (const item of parsed.items) {
      const id = Number(item?.id);
      const draft = COSTING_DRAFT.get(id);
      if (!draft) continue;
      draft.unitCost = Math.max(0, Number(item.unitCost) || 0);
      draft.salePrice = Math.max(0, Number(item.salePrice) || 0);
      COSTING_DIRTY.add(id);
      restored += 1;
    }
    return restored;
  } catch {
    return 0;
  }
}

function updateCostingRow(rowElement, productId) {
  const draft = COSTING_DRAFT.get(Number(productId));
  if (!rowElement || !draft) return;
  const metrics = costingMetrics(draft);
  const tone = costingMarginTone(metrics.margin);
  rowElement.querySelector('.costing-profit-value').textContent = fmtMoney(metrics.margin);
  rowElement.querySelector('.costing-margin-value').textContent = `${metrics.marginPercent.toFixed(1)}%`;
  rowElement.querySelector('.costing-profit-value').className = `costing-profit-value ${tone}`;
  rowElement.querySelector('.costing-margin-value').className = `costing-margin-value ${tone}`;
  const status = rowElement.querySelector('.costing-status');
  if (status) {
    status.className = `costing-status ${metrics.unitCost > 0 ? 'ready' : 'pending'}`;
    status.innerHTML = metrics.unitCost > 0
      ? '<i class="ph-fill ph-check-circle"></i> Configurado'
      : '<i class="ph-fill ph-clock"></i> Falta costo';
  }
}

function costingStatusHtml(metrics) {
  return metrics.unitCost > 0
    ? '<span class="costing-status ready"><i class="ph-fill ph-check-circle"></i> Configurado</span>'
    : '<span class="costing-status pending"><i class="ph-fill ph-clock"></i> Falta costo</span>';
}

function costingProductCardHtml(product) {
  const draft = COSTING_DRAFT.get(Number(product.id)) || product;
  const metrics = costingMetrics(draft);
  const tone = costingMarginTone(metrics.margin);
  return `<article class="card costing-product-card ${COSTING_DIRTY.has(Number(product.id)) ? 'is-dirty' : ''}" data-cost-product="${product.id}">
    <div class="costing-product-card-head">
      <div><span class="costing-category-pill">${esc(product.categoryName)}</span><h4>${esc(product.name)}</h4>${product.active ? '' : '<small class="costing-inactive">Producto inactivo</small>'}</div>
      ${costingStatusHtml(metrics)}
    </div>
    <div class="costing-card-inputs">
      <label><span>Costo unitario</span><div class="costing-money-input"><span>$</span><input type="number" min="0" step="0.0001" inputmode="decimal" data-cost-field="unitCost" aria-label="Costo unitario de ${esc(product.name)}" value="${metrics.unitCost}" /></div></label>
      <label><span>Precio de venta</span><div class="costing-money-input"><span>$</span><input type="number" min="0" step="0.01" inputmode="decimal" data-cost-field="salePrice" aria-label="Precio de venta de ${esc(product.name)}" value="${metrics.salePrice}" /></div></label>
    </div>
    <div class="costing-card-metrics">
      <div><span>Utilidad unitaria</span><strong class="costing-profit-value ${tone}">${fmtMoney(metrics.margin)}</strong></div>
      <div><span>Margen</span><strong class="costing-margin-value ${tone}">${metrics.marginPercent.toFixed(1)}%</strong></div>
    </div>
  </article>`;
}

function bindCostingInputs(host) {
  host?.querySelectorAll('[data-cost-field]').forEach((input) => {
    input.addEventListener('input', () => {
      const rowElement = input.closest('[data-cost-product]');
      const id = Number(rowElement?.dataset.costProduct);
      const draft = COSTING_DRAFT.get(id);
      if (!rowElement || !draft) return;
      draft[input.dataset.costField] = Math.max(0, Number(input.value) || 0);
      COSTING_DIRTY.add(id);
      persistCostingLocalDraft();
      rowElement.classList.add('is-dirty');
      updateCostingRow(rowElement, id);
      updateCostingPendingLabel();
      renderCostingStats();
      clearTimeout(COSTING_AUTOSAVE_TIMERS.get(id));
      COSTING_AUTOSAVE_TIMERS.set(id, setTimeout(() => {
        COSTING_AUTOSAVE_TIMERS.delete(id);
        saveCostingProducts({ silent: true, ids: [id] });
      }, 900));
    });
  });
}

function syncCostingViewButtons() {
  document.querySelectorAll('#costingView [data-cost-view]').forEach((button) => button.classList.toggle('on', button.dataset.costView === COSTING_VIEW));
}

function renderCostingProducts() {
  const tbody = $('#costingProductsTbody');
  const cards = $('#costingProductCards');
  const tableCard = $('#costingTableCard');
  const categoryHead = $('#costingCategoryHead');
  if (!tbody || !cards || !tableCard || !categoryHead) return;
  const rows = costingFilteredProducts();
  const useCards = COSTING_VIEW === 'cards';
  cards.hidden = !useCards;
  categoryHead.hidden = !useCards;
  tableCard.hidden = useCards;
  syncCostingViewButtons();

  const selectedCategory = COSTING_DATA.categories.find((row) => String(row.id) === COSTING_CATEGORY);
  $('#costingCategoryTitle').textContent = selectedCategory?.name || 'Todos los productos';
  $('#costingCategoryCount').textContent = `${rows.length} producto${rows.length === 1 ? '' : 's'}`;

  if (useCards) {
    cards.innerHTML = rows.length
      ? rows.map(costingProductCardHtml).join('')
      : '<div class="card costing-product-empty"><i class="ph-bold ph-package"></i><b>No hay productos para este filtro</b><span>Prueba con otra categoría o búsqueda.</span></div>';
    bindCostingInputs(cards);
    renderCostingStats();
    return;
  }

  tbody.innerHTML = rows.length ? rows.map((product) => {
    const draft = COSTING_DRAFT.get(Number(product.id)) || product;
    const metrics = costingMetrics(draft);
    const tone = costingMarginTone(metrics.margin);
    return `<tr data-cost-product="${product.id}" class="${COSTING_DIRTY.has(Number(product.id)) ? 'is-dirty' : ''}">
      <td><b>${esc(product.name)}</b>${product.active ? '' : '<small class="costing-inactive">Inactivo</small>'}</td>
      <td><span class="costing-category-pill">${esc(product.categoryName)}</span></td>
      <td><div class="costing-money-input"><span>$</span><input type="number" min="0" step="0.0001" inputmode="decimal" data-cost-field="unitCost" aria-label="Costo unitario de ${esc(product.name)}" value="${metrics.unitCost}" /></div></td>
      <td><div class="costing-money-input"><span>$</span><input type="number" min="0" step="0.01" inputmode="decimal" data-cost-field="salePrice" aria-label="Precio de venta de ${esc(product.name)}" value="${metrics.salePrice}" /></div></td>
      <td><strong class="costing-profit-value ${tone}">${fmtMoney(metrics.margin)}</strong></td>
      <td><strong class="costing-margin-value ${tone}">${metrics.marginPercent.toFixed(1)}%</strong></td>
      <td>${costingStatusHtml(metrics)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7"><div class="empty-cell">No hay productos para este filtro.</div></td></tr>';
  bindCostingInputs(tbody);
  renderCostingStats();
}

const COSTING_EXPORT_COLUMNS = [
  { key: 'name', label: 'Producto', width: 30, pdf: (row) => row.name },
  { key: 'categoryName', label: 'Categoría', width: 20, pdf: (row) => row.categoryName },
  { key: 'unitCost', label: 'Costo unitario', width: 16, pdf: (row) => fmtMoney(row.unitCost) },
  { key: 'salePrice', label: 'Precio de venta', width: 16, pdf: (row) => fmtMoney(row.salePrice) },
  { key: 'margin', label: 'Utilidad unitaria', width: 18, pdf: (row) => fmtMoney(row.margin) },
  { key: 'marginPercent', label: 'Margen %', width: 13, pdf: (row) => `${row.marginPercent.toFixed(1)}%` },
  { key: 'status', label: 'Estado', width: 16, pdf: (row) => row.status },
  { key: 'active', label: 'Producto activo', width: 16, pdf: (row) => row.active },
];

function costingExportRows() {
  return costingFilteredProducts().map((product) => {
    const draft = COSTING_DRAFT.get(Number(product.id)) || product;
    const metrics = costingMetrics(draft);
    return {
      name: product.name,
      categoryName: product.categoryName,
      unitCost: metrics.unitCost,
      salePrice: metrics.salePrice,
      margin: metrics.margin,
      marginPercent: metrics.marginPercent,
      status: metrics.unitCost > 0 ? 'Configurado' : 'Falta costo',
      active: product.active ? 'Sí' : 'No',
    };
  });
}

function costingExportScopeLabel(rows = costingExportRows()) {
  const selectedCategory = COSTING_DATA.categories.find((row) => String(row.id) === COSTING_CATEGORY);
  const parts = [selectedCategory?.name || 'Todas las categorías', `${rows.length} producto${rows.length === 1 ? '' : 's'}`];
  if (COSTING_SEARCH.trim()) parts.push(`búsqueda: “${COSTING_SEARCH.trim()}”`);
  return parts.join(' · ');
}

function costingExportFileBase() {
  const selectedCategory = COSTING_DATA.categories.find((row) => String(row.id) === COSTING_CATEGORY);
  const category = (selectedCategory?.name || 'todas-las-categorias')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `costo_ventas_${category || 'categoria'}_${getLocalIsoDate()}`;
}

function selectedCostingExportColumns() {
  const selected = new Set([...document.querySelectorAll('#costingExportFields input:checked')].map((input) => input.value));
  return COSTING_EXPORT_COLUMNS.filter((column) => selected.has(column.key));
}

function syncCostingExportToggle() {
  const inputs = [...document.querySelectorAll('#costingExportFields input')];
  const allSelected = inputs.length > 0 && inputs.every((input) => input.checked);
  const button = $('#costingExportToggle');
  if (button) button.textContent = allSelected ? 'Limpiar selección' : 'Seleccionar todas';
}

function openCostingExportModal(format = 'pdf') {
  const rows = costingExportRows();
  if (!rows.length) return toast('No hay productos visibles para exportar', true);
  COSTING_EXPORT_FORMAT = format === 'excel' ? 'excel' : 'pdf';
  const host = $('#costingExportFields');
  if (!host.dataset.ready) {
    host.innerHTML = COSTING_EXPORT_COLUMNS.map((column) => `<label><input type="checkbox" value="${column.key}" checked /><span><i class="ph-bold ph-check"></i>${esc(column.label)}</span></label>`).join('');
    host.dataset.ready = 'true';
    host.addEventListener('change', syncCostingExportToggle);
  }
  $('#costingExportScope').textContent = costingExportScopeLabel(rows);
  $('#costingExportPdf').classList.toggle('btn-primary', COSTING_EXPORT_FORMAT === 'pdf');
  $('#costingExportPdf').classList.toggle('btn-ghost', COSTING_EXPORT_FORMAT !== 'pdf');
  $('#costingExportExcel').classList.toggle('btn-primary', COSTING_EXPORT_FORMAT === 'excel');
  $('#costingExportExcel').classList.toggle('btn-ghost', COSTING_EXPORT_FORMAT !== 'excel');
  syncCostingExportToggle();
  openModal('costingExportModal');
}

function exportCostingExcel() {
  const rows = costingExportRows();
  const columns = selectedCostingExportColumns();
  if (!columns.length) return toast('Selecciona al menos una columna', true);
  if (!rows.length) return toast('No hay productos visibles para exportar', true);
  if (!globalThis.XLSX) return toast('No se pudo preparar el archivo Excel', true);

  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ['Reporte', 'Costo de ventas'],
    ['Negocio', ME?.tenant?.businessName || SETTINGS?.business_name || 'Negocio'],
    ['Filtro', costingExportScopeLabel(rows)],
    ['Generado', fmtBusinessDateTime()],
  ]);
  const data = rows.map((row) => Object.fromEntries(columns.map((column) => [column.label, row[column.key]])));
  const sheet = XLSX.utils.json_to_sheet(data);
  sheet['!cols'] = columns.map((column) => ({ wch: column.width }));
  XLSX.utils.book_append_sheet(workbook, summary, 'Resumen');
  XLSX.utils.book_append_sheet(workbook, sheet, 'Productos');
  XLSX.writeFile(workbook, `${costingExportFileBase()}.xlsx`);
  closeModal('costingExportModal');
  toast(`Excel exportado con ${rows.length} producto${rows.length === 1 ? '' : 's'}`);
}

function exportCostingPdf() {
  const rows = costingExportRows();
  const columns = selectedCostingExportColumns();
  if (!columns.length) return toast('Selecciona al menos una columna', true);
  if (!rows.length) return toast('No hay productos visibles para exportar', true);
  if (!globalThis.jspdf?.jsPDF) return toast('No se pudo preparar el archivo PDF', true);

  const orientation = columns.length > 4 ? 'landscape' : 'portrait';
  const doc = new globalThis.jspdf.jsPDF({ orientation, unit: 'mm', format: 'letter' });
  const businessName = ME?.tenant?.businessName || SETTINGS?.business_name || 'Negocio';
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text(String(businessName), 14, 15);
  doc.setFontSize(11);
  doc.text('Reporte de costo de ventas', 14, 21);
  doc.setFontSize(8);
  doc.setTextColor(100, 116, 139);
  doc.text(costingExportScopeLabel(rows), 14, 27);
  doc.text(`Generado: ${fmtBusinessDateTime()}`, 14, 32);
  doc.autoTable({
    startY: 37,
    theme: 'striped',
    head: [columns.map((column) => column.label)],
    body: rows.map((row) => columns.map((column) => column.pdf(row))),
    styles: { fontSize: columns.length > 6 ? 6.5 : 8, cellPadding: 2.2, overflow: 'linebreak' },
    headStyles: { fillColor: [234, 88, 12], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { left: 14, right: 14, bottom: 13 },
  });
  const pages = doc.internal.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(`Página ${page} de ${pages}`, doc.internal.pageSize.getWidth() - 14, doc.internal.pageSize.getHeight() - 7, { align: 'right' });
  }
  doc.save(`${costingExportFileBase()}.pdf`);
  closeModal('costingExportModal');
  toast(`PDF exportado con ${rows.length} producto${rows.length === 1 ? '' : 's'}`);
}

async function persistCostingProducts(options = {}) {
  const silent = Boolean(options.silent);
  const requestedIds = Array.isArray(options.ids) ? options.ids.map(Number) : [...COSTING_DIRTY];
  const targetIds = requestedIds.filter((id) => COSTING_DIRTY.has(id) && COSTING_DRAFT.has(id));
  if (!targetIds.length) return true;
  const buttons = [$('#costingSaveBtn'), $('#costingSaveBottomBtn')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const items = targetIds.map((id) => {
      const row = COSTING_DRAFT.get(id);
      return { id, unitCost: row.unitCost, salePrice: row.salePrice };
    });
    const result = await api('/api/costs/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    let confirmedRows = Array.isArray(result.saved) ? result.saved : null;
    if (!confirmedRows) {
      const verification = await api(`/api/costs/products?sort=${encodeURIComponent(COSTING_SORT)}&verify=${Date.now()}`);
      confirmedRows = verification.products || [];
    }
    for (const requested of items) {
      const confirmed = confirmedRows.find((row) => Number(row.id) === Number(requested.id));
      if (!confirmed || Math.abs(Number(confirmed.unitCost) - Number(requested.unitCost)) > 0.0001 || Math.abs(Number(confirmed.salePrice) - Number(requested.salePrice)) > 0.001) {
        throw new Error(`No se pudo confirmar el guardado de ${COSTING_DRAFT.get(Number(requested.id))?.name || 'un producto'}`);
      }
    }
    for (const saved of items) {
      const current = COSTING_DRAFT.get(Number(saved.id));
      if (current && Number(current.unitCost) === Number(saved.unitCost) && Number(current.salePrice) === Number(saved.salePrice)) {
        COSTING_DIRTY.delete(Number(saved.id));
        const original = COSTING_DATA.products.find((row) => Number(row.id) === Number(saved.id));
        if (original) Object.assign(original, { unitCost: saved.unitCost, salePrice: saved.salePrice });
        document.querySelector(`[data-cost-product="${saved.id}"]`)?.classList.remove('is-dirty');
      }
    }
    persistCostingLocalDraft();
    updateCostingPendingLabel();
    if (!silent) toast(`${items.length} producto${items.length === 1 ? '' : 's'} guardado${items.length === 1 ? '' : 's'} permanentemente`);
    else if (!COSTING_DIRTY.size) $('#costingPendingLabel').textContent = 'Todos los cambios están guardados';
    return true;
  } catch (error) {
    if (!silent) toast(error.message || 'No se pudieron guardar los costos', true);
    updateCostingPendingLabel();
    persistCostingLocalDraft();
    return false;
  } finally {
    buttons.forEach((button) => { button.disabled = !COSTING_DIRTY.size; });
  }
}

function saveCostingProducts(options = {}) {
  COSTING_SAVE_QUEUE = COSTING_SAVE_QUEUE.then(
    () => persistCostingProducts(options),
    () => persistCostingProducts(options)
  );
  return COSTING_SAVE_QUEUE;
}

function setCostingTab(tab) {
  COSTING_TAB = tab === 'expenses' ? 'expenses' : 'products';
  $('#costingProductsPanel').hidden = COSTING_TAB !== 'products';
  $('#costingExpensesPanel').hidden = COSTING_TAB !== 'expenses';
  document.querySelectorAll('#costingTabs [data-costing-tab]').forEach((button) => button.classList.toggle('on', button.dataset.costingTab === COSTING_TAB));
  if (COSTING_TAB === 'expenses') loadCostingExpenses().catch((error) => toast(error.message || 'No se pudieron cargar los gastos', true));
}

async function loadCosting() {
  COSTING_DATA = await api(`/api/costs/products?sort=${encodeURIComponent(COSTING_SORT)}`);
  COSTING_DRAFT = new Map(COSTING_DATA.products.map((product) => [Number(product.id), { ...product }]));
  COSTING_DIRTY.clear();
  const restored = restoreCostingLocalDraft();
  populateCostingFilters();
  renderCostingStats();
  renderCostingProducts();
  updateCostingPendingLabel();
  if (restored) saveCostingProducts({ silent: true });
  $('#costingExpenseDate').value ||= getLocalIsoDate();
  $('#costingExpenseMonth').value = `${COSTING_EXPENSE_YEAR}-${String(COSTING_EXPENSE_MONTH).padStart(2, '0')}`;
  setCostingTab(COSTING_TAB);
}

async function loadCostingExpenses() {
  const query = new URLSearchParams({ year: String(COSTING_EXPENSE_YEAR), month: String(COSTING_EXPENSE_MONTH), branch: COSTING_EXPENSE_BRANCH });
  const data = await api(`/api/costs/expenses?${query.toString()}`);
  $('#costingExpenseTotal').textContent = `Total: ${fmtMoney(data.total)}`;
  const host = $('#costingExpensesTable');
  if (!data.expenses.length) {
    host.innerHTML = emptyHTML('ph-receipt', 'Sin gastos en este periodo', 'Los gastos registrados aquí o desde el POS aparecerán en esta lista.');
    return;
  }
  host.innerHTML = `<table><thead><tr><th>Fecha</th><th>Sucursal</th><th>Concepto</th><th>Origen</th><th>Monto</th><th>Usuario</th><th></th></tr></thead><tbody>${data.expenses.map((expense) => `<tr>
    <td>${esc(String(expense.expense_date || '').slice(0, 10))}</td><td>${esc(expense.branch_name)}</td><td><b>${esc(expense.concept)}</b>${expense.notes ? `<small class="costing-expense-note">${esc(expense.notes)}</small>` : ''}</td>
    <td><span class="costing-source ${expense.source}">${expense.source === 'pos' ? 'Punto de venta' : 'Manual'}</span></td><td><b>${fmtMoney(expense.amount)}</b></td><td>${esc(expense.created_by || '—')}</td>
    <td>${expense.source === 'manual' ? `<button class="btn btn-ghost btn-sm costing-delete-expense" data-expense-id="${expense.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('.costing-delete-expense').forEach((button) => button.addEventListener('click', async () => {
    if (!await askConfirm('Eliminar gasto', '¿Deseas eliminar este gasto? El reporte de utilidad se actualizará.')) return;
    try {
      await api(`/api/costs/expenses/${button.dataset.expenseId}`, { method: 'DELETE' });
      await loadCostingExpenses();
      if (SALES_REPORT_DATA) refreshSalesReportSafely();
      toast('Gasto eliminado');
    } catch (error) { toast(error.message || 'No se pudo eliminar el gasto', true); }
  }));
}

document.querySelectorAll('#costingTabs [data-costing-tab]').forEach((button) => button.addEventListener('click', () => setCostingTab(button.dataset.costingTab)));
document.querySelectorAll('#costingSort [data-cost-sort]').forEach((button) => button.addEventListener('click', () => {
  COSTING_SORT = button.dataset.costSort === 'category' ? 'category' : 'alphabetical';
  document.querySelectorAll('#costingSort [data-cost-sort]').forEach((row) => row.classList.toggle('on', row.dataset.costSort === COSTING_SORT));
  renderCostingProducts();
}));
document.querySelectorAll('#costingView [data-cost-view]').forEach((button) => button.addEventListener('click', () => {
  COSTING_VIEW = button.dataset.costView === 'cards' ? 'cards' : 'table';
  renderCostingProducts();
}));
$('#costingSearch')?.addEventListener('input', (event) => { COSTING_SEARCH = event.target.value; renderCostingProducts(); });
$('#costingCategory')?.addEventListener('change', (event) => {
  COSTING_CATEGORY = event.target.value;
  COSTING_VIEW = 'cards';
  renderCostingProducts();
});
$('#costingSaveBtn')?.addEventListener('click', saveCostingProducts);
$('#costingSaveBottomBtn')?.addEventListener('click', saveCostingProducts);
$('#costingPdfBtn')?.addEventListener('click', () => openCostingExportModal('pdf'));
$('#costingExcelBtn')?.addEventListener('click', () => openCostingExportModal('excel'));
$('#costingExportPdf')?.addEventListener('click', exportCostingPdf);
$('#costingExportExcel')?.addEventListener('click', exportCostingExcel);
$('#costingExportClose')?.addEventListener('click', () => closeModal('costingExportModal'));
$('#costingExportCancel')?.addEventListener('click', () => closeModal('costingExportModal'));
$('#costingExportToggle')?.addEventListener('click', () => {
  const inputs = [...document.querySelectorAll('#costingExportFields input')];
  const shouldSelect = !inputs.length || !inputs.every((input) => input.checked);
  inputs.forEach((input) => { input.checked = shouldSelect; });
  syncCostingExportToggle();
});
$('#costingExportModal')?.addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal('costingExportModal'); });
$('#costingExpenseForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/costs/expenses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        branchId: $('#costingExpenseBranch').value === 'general' ? null : Number($('#costingExpenseBranch').value),
        expenseDate: $('#costingExpenseDate').value,
        concept: $('#costingExpenseConcept').value,
        amount: Number($('#costingExpenseAmount').value),
        notes: $('#costingExpenseNotes').value,
      }),
    });
    $('#costingExpenseConcept').value = '';
    $('#costingExpenseAmount').value = '';
    $('#costingExpenseNotes').value = '';
    await loadCostingExpenses();
    if (SALES_REPORT_DATA) refreshSalesReportSafely();
    toast('Gasto registrado');
  } catch (error) { toast(error.message || 'No se pudo registrar el gasto', true); }
});
$('#costingExpenseMonth')?.addEventListener('change', (event) => {
  const match = String(event.target.value || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return;
  COSTING_EXPENSE_YEAR = Number(match[1]); COSTING_EXPENSE_MONTH = Number(match[2]);
  loadCostingExpenses().catch((error) => toast(error.message, true));
});
$('#costingExpenseFilterBranch')?.addEventListener('change', (event) => {
  COSTING_EXPENSE_BRANCH = event.target.value;
  loadCostingExpenses().catch((error) => toast(error.message, true));
});
$('#costingExpenseRefresh')?.addEventListener('click', () => loadCostingExpenses().catch((error) => toast(error.message, true)));

/* ===== Stock por sucursal ===== */
async function loadBranchStock() {
  try {
    BRANCH_STOCK_DATA = await api('/api/branch-stock');
    const categories = [...new Set(BRANCH_STOCK_DATA.rows.map((row)=>row.categoryName))].sort((a,b)=>a.localeCompare(b,'es'));
    const category = $('#branchStockCategory');
    category.innerHTML = '<option value="all">Todas las categorías</option>' + categories.map((name)=>`<option value="${esc(name)}">${esc(name)}</option>`).join('');
    category.value = BRANCH_STOCK_CATEGORY;
    const branch = $('#branchStockBranch');
    if (!BRANCH_STOCK_DATA.branches.some((row)=>String(row.id)===String(BRANCH_STOCK_BRANCH))) BRANCH_STOCK_BRANCH = 'all';
    branch.innerHTML = '<option value="all">Todas las sucursales</option>' + BRANCH_STOCK_DATA.branches.map((row)=>`<option value="${row.id}">${esc(row.name)}${row.active?'':' · Inactiva'}</option>`).join('');
    branch.value = BRANCH_STOCK_BRANCH;
    $('#branchStockPageSize').value = String(BRANCH_STOCK_PAGE_SIZE);
    renderBranchStock();
  } catch (error) { toast(error.message || 'No se pudo cargar el stock por sucursal', true); }
}

function renderBranchStock() {
  const data = BRANCH_STOCK_DATA;
  const selectedBranchId = BRANCH_STOCK_BRANCH === 'all' ? 0 : Number(BRANCH_STOCK_BRANCH);
  const visibleBranches = selectedBranchId ? data.branches.filter((row)=>Number(row.id)===selectedBranchId) : data.branches;
  const visibleSummaries = selectedBranchId ? data.summaries.filter((row)=>Number(row.branchId)===selectedBranchId) : data.summaries;
  $('#branchStockSummary').innerHTML = visibleSummaries.map((row)=>{
    const profit = Number(row.profitValue || 0);
    const profitTone = profit < 0 ? 'loss' : profit > 0 ? 'profit' : 'neutral';
    return `<div class="card branch-stock-card">
      <i class="ph-bold ph-storefront"></i>
      <div class="branch-stock-card-body">
        <small>${esc(row.branchName)}${row.active?'':' · Inactiva'}</small>
        <strong>${invFmt(row.totalUnits)} unidades</strong>
        <span>${row.productsWithStock} productos con existencia</span>
        <div class="branch-stock-card-metrics">
          <div><span>Venta potencial</span><b>${fmtMoney(row.salesValue ?? row.stockValue)}</b></div>
          <div><span>Costo de venta</span><b>${fmtMoney(row.costValue)}</b></div>
          <div class="branch-stock-card-profit ${profitTone}"><span>Utilidad estimada</span><b>${fmtMoney(profit)}</b><em>${Number(row.profitPercent || 0).toFixed(1)}%</em></div>
        </div>
      </div>
    </div>`;
  }).join('');
  const query = BRANCH_STOCK_SEARCH.toLowerCase();
  const rows = data.rows.filter((row)=>{
    const scopedQuantity = selectedBranchId ? Number(row.locations.find((location)=>location.branchId===selectedBranchId)?.quantity || 0) : Number(row.globalQuantity || 0);
    return (!query||row.productName.toLowerCase().includes(query))&&(BRANCH_STOCK_CATEGORY==='all'||row.categoryName===BRANCH_STOCK_CATEGORY)&&(!BRANCH_STOCK_ONLY_AVAILABLE||scopedQuantity>0);
  });
  const totalPages = Math.max(1, Math.ceil(rows.length / BRANCH_STOCK_PAGE_SIZE));
  BRANCH_STOCK_PAGE = Math.min(Math.max(1, BRANCH_STOCK_PAGE), totalPages);
  const start = (BRANCH_STOCK_PAGE - 1) * BRANCH_STOCK_PAGE_SIZE;
  const pageRows = rows.slice(start, start + BRANCH_STOCK_PAGE_SIZE);
  const range = $('#branchStockRange');
  const pageInfo = $('#branchStockPageInfo');
  const prev = $('#branchStockPrev');
  const next = $('#branchStockNext');
  if (range) range.textContent = rows.length ? `Mostrando ${start + 1}–${start + pageRows.length} de ${rows.length} productos` : '0 productos';
  if (pageInfo) pageInfo.textContent = `${BRANCH_STOCK_PAGE} / ${totalPages}`;
  if (prev) prev.disabled = BRANCH_STOCK_PAGE <= 1;
  if (next) next.disabled = BRANCH_STOCK_PAGE >= totalPages;
  const host=$('#branchStockMatrix');
  if(!pageRows.length){host.innerHTML=emptyHTML('ph-package','Sin productos','No hay existencias para los filtros elegidos.');return;}
  host.innerHTML=`<table class="branch-stock-table"><thead><tr><th>Producto</th>${visibleBranches.map((branch)=>`<th>${esc(branch.name)}${branch.active?'':' · Inactiva'}</th>`).join('')}<th>Global</th></tr></thead><tbody>${pageRows.map((row)=>`<tr><td><b>${esc(row.productName)}</b><small>${esc(row.categoryName)} · Costo ${fmtMoney(row.unitCost)}</small></td>${row.locations.filter((location)=>!selectedBranchId||location.branchId===selectedBranchId).map((location)=>`<td><button class="branch-stock-cell ${location.quantity<=0?'empty':''}" data-product="${row.productId}" data-branch="${location.branchId}" ${location.active?'':'disabled'}><b>${invFmt(location.quantity)}</b><span>${location.active?'Ajustar':'Histórico'}</span></button></td>`).join('')}<td><b class="branch-stock-global">${invFmt(row.globalQuantity)}</b></td></tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('.branch-stock-cell').forEach((button)=>button.addEventListener('click',()=>openBranchStockAdjust(Number(button.dataset.product),Number(button.dataset.branch))));
}

function openBranchStockAdjust(productId,branchId){const product=BRANCH_STOCK_DATA.rows.find((row)=>row.productId===productId);const location=product?.locations.find((row)=>row.branchId===branchId);if(!product||!location)return;$('#branchStockAdjustProduct').value=productId;$('#branchStockAdjustBranch').value=branchId;$('#branchStockAdjustQuantity').value=location.quantity;$('#branchStockAdjustReason').value='';$('#branchStockAdjustContext').innerHTML=`<div><small>Producto</small><b>${esc(product.productName)}</b></div><div><small>Sucursal</small><b>${esc(location.branchName)}</b></div><div><small>Stock actual</small><b>${invFmt(location.quantity)}</b></div>`;openModal('branchStockAdjustModal');}

async function openBranchStockAudit(){try{const rows=await api('/api/branch-stock/audit');$('#branchStockAuditContent').innerHTML=rows.length?`<div class="purchase-audit-list">${rows.map((row)=>`<article><i class="ph-bold ph-shield-check"></i><div><b>${esc(row.action)}</b><span>${esc(row.actor||'Sistema')} · ${esc(row.createdAt)}</span><pre>${esc(JSON.stringify(row.payload,null,2))}</pre></div></article>`).join('')}</div>`:emptyHTML('ph-shield-check','Sin ajustes','Todavía no hay movimientos auditados.');openModal('branchStockAuditModal');}catch(error){toast(error.message,true);}}

$('#branchStockSearch')?.addEventListener('input',(event)=>{BRANCH_STOCK_SEARCH=event.target.value.trim();BRANCH_STOCK_PAGE=1;renderBranchStock();});
$('#branchStockBranch')?.addEventListener('change',(event)=>{BRANCH_STOCK_BRANCH=event.target.value;BRANCH_STOCK_PAGE=1;renderBranchStock();});
$('#branchStockCategory')?.addEventListener('change',(event)=>{BRANCH_STOCK_CATEGORY=event.target.value;BRANCH_STOCK_PAGE=1;renderBranchStock();});
$('#branchStockOnlyAvailable')?.addEventListener('change',(event)=>{BRANCH_STOCK_ONLY_AVAILABLE=event.target.checked;BRANCH_STOCK_PAGE=1;renderBranchStock();});
$('#branchStockPageSize')?.addEventListener('change',(event)=>{const size=Number(event.target.value);BRANCH_STOCK_PAGE_SIZE=[10,20,50,100].includes(size)?size:10;BRANCH_STOCK_PAGE=1;try{localStorage.setItem('branchStockPageSize',String(BRANCH_STOCK_PAGE_SIZE));}catch{}renderBranchStock();});
$('#branchStockPrev')?.addEventListener('click',()=>{if(BRANCH_STOCK_PAGE>1){BRANCH_STOCK_PAGE-=1;renderBranchStock();}});
$('#branchStockNext')?.addEventListener('click',()=>{BRANCH_STOCK_PAGE+=1;renderBranchStock();});
$('#branchStockRefresh')?.addEventListener('click',loadBranchStock);$('#branchStockAuditBtn')?.addEventListener('click',openBranchStockAudit);
$('#branchStockAdjustForm')?.addEventListener('submit',async(event)=>{event.preventDefault();try{const result=await api('/api/branch-stock/adjust',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:Number($('#branchStockAdjustProduct').value),branchId:Number($('#branchStockAdjustBranch').value),physicalQuantity:Number($('#branchStockAdjustQuantity').value),reason:$('#branchStockAdjustReason').value})});closeModal('branchStockAdjustModal');await loadBranchStock();toast(`Stock ajustado: ${result.productName} · ${result.branchName}`);}catch(error){toast(error.message,true);}});

/* ===== Compras, proveedores y traslados ===== */
function purchaseSetPeriod(period) {
  PURCHASE_PERIOD = ['day', 'week', 'month', 'custom'].includes(period) ? period : 'day';
  const today = new Date(); let start = new Date(today); let end = new Date(today);
  if (PURCHASE_PERIOD === 'week') { const day = today.getDay(); start.setDate(today.getDate() + (day === 0 ? -6 : 1 - day)); end = new Date(start); end.setDate(start.getDate() + 6); }
  else if (PURCHASE_PERIOD === 'month') { start = new Date(today.getFullYear(), today.getMonth(), 1); end = new Date(today.getFullYear(), today.getMonth() + 1, 0); }
  if (PURCHASE_PERIOD !== 'custom' || !$('#purchaseStartDate').value || !$('#purchaseEndDate').value) { $('#purchaseStartDate').value = salesIsoDate(start); $('#purchaseEndDate').value = salesIsoDate(end); }
  document.querySelectorAll('#purchasePeriodTabs [data-purchase-period]').forEach((button) => button.classList.toggle('on', button.dataset.purchasePeriod === PURCHASE_PERIOD));
}

function purchaseBranchOptions(includeAll = false, selectedId = '') {
  return `${includeAll ? '<option value="all">Todas las sucursales</option>' : '<option value="">Selecciona…</option>'}${PURCHASE_DATA.branches.filter((row) => row.active || String(row.id) === String(selectedId)).map((row) => `<option value="${row.id}">${esc(row.name)}${row.active ? '' : ' · Inactiva'}</option>`).join('')}`;
}
function purchaseSupplierOptions(selectedId = '') { return `<option value="">Selecciona…</option>${PURCHASE_DATA.suppliers.filter((row) => row.active || String(row.id) === String(selectedId)).map((row) => `<option value="${row.id}">${esc(row.name)}${row.active ? '' : ' · Inactivo'}</option>`).join('')}`; }
function purchaseProductOptions(selected = '') { return `<option value="">Selecciona producto…</option>${PURCHASE_DATA.products.map((row) => `<option value="${row.id}" ${String(row.id) === String(selected) ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}`; }
function purchaseStock(branchId, productId) { return Number(PURCHASE_DATA.branchStock.find((row) => Number(row.branchId) === Number(branchId) && Number(row.productId) === Number(productId))?.quantity || 0); }

function setPurchaseTab(tab) {
  PURCHASE_TAB = ['dashboard','orders','suppliers','transfers'].includes(tab) ? tab : 'dashboard';
  ['dashboard','orders','suppliers','transfers'].forEach((name) => { $(`#purchase${name[0].toUpperCase()}${name.slice(1)}Panel`).hidden = name !== PURCHASE_TAB; });
  document.querySelectorAll('#purchaseTabs [data-purchase-tab]').forEach((button) => button.classList.toggle('on', button.dataset.purchaseTab === PURCHASE_TAB));
  if (PURCHASE_TAB === 'dashboard') loadPurchaseReport();
  else if (PURCHASE_TAB === 'orders') loadPurchaseOrders();
  else if (PURCHASE_TAB === 'suppliers') renderPurchaseSuppliers();
  else loadPurchaseTransfers();
}

async function loadPurchases() {
  PURCHASE_DATA = await api('/api/purchases/bootstrap');
  $('#purchaseReportBranch').innerHTML = purchaseBranchOptions(true);
  $('#purchaseOrderSupplier').innerHTML = purchaseSupplierOptions();
  $('#purchaseOrderBranch').innerHTML = purchaseBranchOptions();
  $('#purchaseTransferFrom').innerHTML = purchaseBranchOptions();
  $('#purchaseTransferTo').innerHTML = purchaseBranchOptions();
  if (!$('#purchaseStartDate').value) purchaseSetPeriod(PURCHASE_PERIOD);
  setPurchaseTab(PURCHASE_TAB);
}

async function loadPurchaseReport() {
  try {
    const query = new URLSearchParams({ startDate: $('#purchaseStartDate').value, endDate: $('#purchaseEndDate').value, branch: $('#purchaseReportBranch').value || 'all' });
    PURCHASE_REPORT = await api(`/api/purchases/report?${query}`);
    const s = PURCHASE_REPORT.summary;
    $('#purchaseStats').innerHTML = `<div class="card purchase-stat"><i class="ph-bold ph-currency-dollar"></i><div><small>Total comprado</small><strong>${fmtMoney(s.total)}</strong></div></div><div class="card purchase-stat"><i class="ph-bold ph-receipt"></i><div><small>Órdenes recibidas</small><strong>${s.orders}</strong></div></div><div class="card purchase-stat"><i class="ph-bold ph-package"></i><div><small>Unidades compradas</small><strong>${s.quantity}</strong></div></div><div class="card purchase-stat"><i class="ph-bold ph-calculator"></i><div><small>Promedio por orden</small><strong>${fmtMoney(s.averageOrder)}</strong></div></div>`;
    const host = $('#purchaseProductsReport');
    host.innerHTML = PURCHASE_REPORT.products.length ? `<table><thead><tr><th>Producto</th><th>Unidades</th><th>Órdenes</th><th>Total comprado</th></tr></thead><tbody>${PURCHASE_REPORT.products.map((row) => `<tr><td><b>${esc(row.productName)}</b></td><td>${row.quantity}</td><td>${row.orders}</td><td><b>${fmtMoney(row.total)}</b></td></tr>`).join('')}</tbody></table>` : emptyHTML('ph-shopping-cart-simple','Sin compras recibidas','Recibe una orden para verla en este reporte.');
    if (PURCHASE_CHART) PURCHASE_CHART.destroy();
    PURCHASE_CHART = new Chart($('#purchaseChart'), { type:'bar', data:{ labels:PURCHASE_REPORT.series.map((row)=>new Date(`${row.date}T12:00:00`).toLocaleDateString('es-MX',{day:'numeric',month:'short'})), datasets:[{label:'Importe comprado',data:PURCHASE_REPORT.series.map((row)=>row.total),backgroundColor:'#2563ebcc',borderRadius:8,yAxisID:'y'},{label:'Unidades',data:PURCHASE_REPORT.series.map((row)=>row.quantity),backgroundColor:'#10b981aa',borderRadius:8,yAxisID:'y1'}]}, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,ticks:{callback:(v)=>fmtMoney(v)}},y1:{beginAtZero:true,position:'right',grid:{drawOnChartArea:false}},x:{grid:{display:false}}}} });
  } catch (error) { toast(error.message || 'No se pudo cargar el reporte de compras', true); }
}

async function loadPurchaseOrders() {
  try { const status=$('#purchaseOrderStatus').value; PURCHASE_ORDERS=await api(`/api/purchases/orders${status?`?status=${encodeURIComponent(status)}`:''}`); renderPurchaseOrders(); } catch(error){toast(error.message||'No se pudieron cargar las órdenes',true);}
}
function purchaseStatusLabel(status){return({ordered:'Pendiente',received:'Recibida',cancelled:'Cancelada'})[status]||String(status||'—');}
function purchaseStatusBadge(status){return `<span class="purchase-status ${status}">${esc(purchaseStatusLabel(status))}</span>`;}

function openPurchasePrintDocument(title, subtitle, content) {
  const popup = window.open('', '_blank', 'width=900,height=760');
  if (!popup) return toast('Permite las ventanas emergentes para imprimir', true);
  const business = esc(ME?.tenant?.businessName || SETTINGS?.business_name || 'Negocio');
  popup.document.open();
  popup.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{margin:12mm}body{font-family:Arial,sans-serif;color:#111827;margin:0;font-size:12px}h1{margin:0;font-size:22px}h2{margin:4px 0 18px;font-size:15px;color:#475569}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:18px}.meta div{padding:9px;border:1px solid #dbe3ed;border-radius:8px}.meta small{display:block;margin-bottom:3px;color:#64748b;font-size:9px;font-weight:700;text-transform:uppercase}table{width:100%;border-collapse:collapse}th,td{padding:8px 6px;border-bottom:1px solid #dbe3ed;text-align:left}th{font-size:9px;text-transform:uppercase;background:#f1f5f9}.num{text-align:right}.total{margin-top:14px;text-align:right;font-size:17px}.notes{margin-top:16px;padding:10px;border:1px solid #cbd5e1;border-radius:8px}.footer{margin-top:24px;color:#64748b;font-size:9px}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body><h1>${business}</h1><h2>${esc(subtitle)}</h2>${content}<div class="footer">Documento generado desde ChatBotPro · ${esc(fmtBusinessDateTime())}</div><script>window.onload=()=>{window.print();}</script></body></html>`);
  popup.document.close();
}

function printPurchaseOrder(order) {
  if (!order) return;
  const rows = order.items.map((item) => `<tr><td>${esc(item.productName)}</td><td class="num">${esc(invFmt(item.quantity))}</td><td class="num">${esc(fmtMoney(item.unitCost))}</td><td class="num">${esc(fmtMoney(item.lineTotal))}</td></tr>`).join('');
  openPurchasePrintDocument(order.orderNumber, `Orden de compra ${order.orderNumber}`, `<div class="meta"><div><small>Proveedor</small><b>${esc(order.supplierName)}</b></div><div><small>Sucursal receptora</small><b>${esc(order.branchName)}</b></div><div><small>Fecha de orden</small><b>${esc(order.orderDate)}</b></div><div><small>Entrega esperada</small><b>${esc(order.expectedDate || 'Sin fecha')}</b></div><div><small>Estatus</small><b>${esc(purchaseStatusLabel(order.status))}</b></div><div><small>Creada por</small><b>${esc(order.createdBy || '—')}</b></div></div><table><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Costo unitario</th><th class="num">Importe</th></tr></thead><tbody>${rows}</tbody></table><div class="total"><b>Total: ${esc(fmtMoney(order.total))}</b></div>${order.notes ? `<div class="notes"><b>Notas:</b> ${esc(order.notes)}</div>` : ''}`);
}

function printPurchaseTransfer(transfer) {
  if (!transfer) return;
  const rows = transfer.items.map((item) => `<tr><td>${esc(item.productName)}</td><td class="num">${esc(invFmt(item.quantity))}</td></tr>`).join('');
  openPurchasePrintDocument(transfer.transfer_number, `Comprobante de traslado ${transfer.transfer_number}`, `<div class="meta"><div><small>Sucursal origen</small><b>${esc(transfer.from_branch_name)}</b></div><div><small>Sucursal destino</small><b>${esc(transfer.to_branch_name)}</b></div><div><small>Fecha</small><b>${esc(transfer.created_at)}</b></div><div><small>Realizado por</small><b>${esc(transfer.created_by || '—')}</b></div></div><table><thead><tr><th>Producto</th><th class="num">Cantidad trasladada</th></tr></thead><tbody>${rows}</tbody></table>${transfer.notes ? `<div class="notes"><b>Notas:</b> ${esc(transfer.notes)}</div>` : ''}`);
}

function renderPurchaseOrders(){const host=$('#purchaseOrdersTable');if(!PURCHASE_ORDERS.length){host.innerHTML=emptyHTML('ph-shopping-cart-simple','Sin órdenes de compra','Crea tu primera orden para comenzar.');return;}host.innerHTML=`<table><thead><tr><th>Orden</th><th>Proveedor</th><th>Sucursal</th><th>Productos</th><th>Total</th><th>Fecha</th><th>Estatus</th><th>Acciones</th></tr></thead><tbody>${PURCHASE_ORDERS.map(order=>`<tr><td><b>${esc(order.orderNumber)}</b><small>${esc(order.createdBy)}</small></td><td>${esc(order.supplierName)}</td><td>${esc(order.branchName)}</td><td>${order.items.map(item=>`${item.quantity} ${esc(item.productName)}`).join('<br>')}</td><td><b>${fmtMoney(order.total)}</b></td><td>${esc(order.orderDate)}${order.receivedAt?`<small>Recibida ${esc(order.receivedAt)}</small>`:''}</td><td>${purchaseStatusBadge(order.status)}</td><td><div class="purchase-row-actions"><button class="btn btn-ghost btn-sm purchase-print-order" data-id="${order.id}"><i class="ph-bold ph-printer"></i> Imprimir</button>${order.status==='ordered'?`<button class="btn btn-ghost btn-sm purchase-edit-order" data-id="${order.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button><button class="btn btn-primary btn-sm purchase-receive" data-id="${order.id}"><i class="ph-bold ph-package"></i> Recibir</button><button class="btn btn-ghost btn-sm purchase-cancel" data-id="${order.id}"><i class="ph-bold ph-x-circle"></i> Cancelar</button>`:''}${order.status!=='received'?`<button class="btn btn-danger btn-sm purchase-delete-order" data-id="${order.id}"><i class="ph-bold ph-trash"></i> Borrar</button>`:''}</div></td></tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('.purchase-print-order').forEach(button=>button.addEventListener('click',()=>printPurchaseOrder(PURCHASE_ORDERS.find(row=>row.id===Number(button.dataset.id)))));
  host.querySelectorAll('.purchase-edit-order').forEach(button=>button.addEventListener('click',()=>openPurchaseOrder(Number(button.dataset.id))));
  host.querySelectorAll('.purchase-receive').forEach(button=>button.addEventListener('click',async()=>{const order=PURCHASE_ORDERS.find(row=>row.id===Number(button.dataset.id));if(!await askConfirm('Recibir orden',`Se agregarán ${order.items.length} productos al inventario de ${order.branchName} y se actualizarán sus costos promedio.`))return;try{await api(`/api/purchases/orders/${order.id}/receive`,{method:'POST'});toast('Orden recibida e inventario actualizado');PURCHASE_DATA=await api('/api/purchases/bootstrap');await loadPurchaseOrders();await loadPurchaseReport();}catch(error){toast(error.message||'No se pudo recibir',true);}}));
  host.querySelectorAll('.purchase-cancel').forEach(button=>button.addEventListener('click',async()=>{if(!await askConfirm('Cancelar orden','La orden quedará en la auditoría y no afectará inventario.'))return;try{await api(`/api/purchases/orders/${button.dataset.id}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await loadPurchaseOrders();toast('Orden cancelada');}catch(error){toast(error.message,true);}}));
  host.querySelectorAll('.purchase-delete-order').forEach(button=>button.addEventListener('click',async()=>{const order=PURCHASE_ORDERS.find(row=>row.id===Number(button.dataset.id));if(!order||!await askConfirm('Borrar orden',`Se eliminará definitivamente ${order.orderNumber}. Esta acción sólo está permitida porque la orden no ha afectado inventario.`))return;try{await api(`/api/purchases/orders/${order.id}`,{method:'DELETE'});await loadPurchaseOrders();toast('Orden eliminada');}catch(error){toast(error.message,true);}}));
}

function renderPurchaseSuppliers(){const host=$('#purchaseSuppliersTable');const rows=PURCHASE_DATA.suppliers;if(!rows.length){host.innerHTML=emptyHTML('ph-truck','Sin proveedores','Registra tu primer proveedor.');return;}host.innerHTML=`<table><thead><tr><th>Proveedor</th><th>Contacto</th><th>Teléfono</th><th>Correo</th><th>RFC</th><th>Estatus</th><th>Acciones</th></tr></thead><tbody>${rows.map(row=>`<tr><td><b>${esc(row.name)}</b><small>${esc(row.address||'')}</small></td><td>${esc(row.contact_name||'—')}</td><td>${esc(row.phone||'—')}</td><td>${esc(row.email||'—')}</td><td>${esc(row.tax_id||'—')}</td><td>${row.active?'<span class="purchase-status received">Activo</span>':'<span class="purchase-status cancelled">Inactivo</span>'}</td><td><div class="purchase-row-actions"><button class="btn btn-ghost btn-sm purchase-edit-supplier" data-id="${row.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button><button class="btn btn-ghost btn-sm purchase-toggle-supplier" data-id="${row.id}"><i class="ph-bold ${row.active?'ph-user-minus':'ph-user-plus'}"></i> ${row.active?'Desactivar':'Activar'}</button></div></td></tr>`).join('')}</tbody></table>`;host.querySelectorAll('.purchase-edit-supplier').forEach(button=>button.addEventListener('click',()=>openPurchaseSupplier(Number(button.dataset.id))));host.querySelectorAll('.purchase-toggle-supplier').forEach(button=>button.addEventListener('click',async()=>{const row=PURCHASE_DATA.suppliers.find(item=>Number(item.id)===Number(button.dataset.id));if(!row||!await askConfirm(row.active?'Desactivar proveedor':'Activar proveedor',row.active?'Ya no aparecerá al crear nuevas órdenes; sus registros anteriores se conservarán.':'Volverá a estar disponible para nuevas órdenes.'))return;try{await api(`/api/purchases/suppliers/${row.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:row.name,taxId:row.tax_id,contactName:row.contact_name,phone:row.phone,email:row.email,address:row.address,notes:row.notes,active:!row.active})});PURCHASE_DATA=await api('/api/purchases/bootstrap');renderPurchaseSuppliers();toast(`Proveedor ${row.active?'desactivado':'activado'}`);}catch(error){toast(error.message,true);}}));}

async function loadPurchaseTransfers(){try{PURCHASE_TRANSFERS=await api('/api/purchases/transfers');const host=$('#purchaseTransfersTable');host.innerHTML=PURCHASE_TRANSFERS.length?`<table><thead><tr><th>Traslado</th><th>Origen</th><th>Destino</th><th>Productos</th><th>Usuario</th><th>Fecha</th><th>Acciones</th></tr></thead><tbody>${PURCHASE_TRANSFERS.map(row=>`<tr><td><b>${esc(row.transfer_number)}</b></td><td>${esc(row.from_branch_name)}</td><td>${esc(row.to_branch_name)}</td><td>${row.items.map(item=>`${item.quantity} ${esc(item.productName)}`).join('<br>')}</td><td>${esc(row.created_by||'—')}</td><td>${esc(row.created_at)}</td><td><div class="purchase-row-actions"><button class="btn btn-ghost btn-sm purchase-print-transfer" data-id="${row.id}"><i class="ph-bold ph-printer"></i> Imprimir</button><button class="btn btn-ghost btn-sm purchase-repeat-transfer" data-id="${row.id}"><i class="ph-bold ph-arrows-clockwise"></i> Repetir</button></div></td></tr>`).join('')}</tbody></table>`:emptyHTML('ph-arrows-left-right','Sin traslados','Los movimientos entre sucursales aparecerán aquí.');host.querySelectorAll('.purchase-print-transfer').forEach(button=>button.addEventListener('click',()=>printPurchaseTransfer(PURCHASE_TRANSFERS.find(row=>row.id===Number(button.dataset.id)))));host.querySelectorAll('.purchase-repeat-transfer').forEach(button=>button.addEventListener('click',()=>openPurchaseTransfer(PURCHASE_TRANSFERS.find(row=>row.id===Number(button.dataset.id)))));}catch(error){toast(error.message||'No se cargaron los traslados',true);}}

function openPurchaseSupplier(id=null){const row=PURCHASE_DATA.suppliers.find(item=>Number(item.id)===Number(id));$('#purchaseSupplierModalTitle').textContent=row?'Editar proveedor':'Nuevo proveedor';$('#purchaseSupplierId').value=row?.id||'';$('#purchaseSupplierName').value=row?.name||'';$('#purchaseSupplierTaxId').value=row?.tax_id||'';$('#purchaseSupplierContact').value=row?.contact_name||'';$('#purchaseSupplierPhone').value=row?.phone||'';$('#purchaseSupplierEmail').value=row?.email||'';$('#purchaseSupplierAddress').value=row?.address||'';$('#purchaseSupplierNotes').value=row?.notes||'';$('#purchaseSupplierActive').checked=row?Boolean(row.active):true;openModal('purchaseSupplierModal');}

function newPurchaseOrderItem(){return{key:`i${Date.now()}${Math.random()}`,productId:'',quantity:1,unitCost:0};}
function purchaseGlobalStock(productId){return Math.max(0,PURCHASE_DATA.branchStock.filter((row)=>Number(row.productId)===Number(productId)).reduce((sum,row)=>sum+Number(row.quantity||0),0));}
function purchaseCostGuidance(item){
  const product=PURCHASE_DATA.products.find((row)=>Number(row.id)===Number(item.productId));
  if(!product)return 'Selecciona un producto para cargar su costo.';
  const currentCost=Math.max(0,Number(product.unitCost||0));
  const purchaseCost=Math.max(0,Number(item.unitCost||0));
  const quantity=Math.max(0,Number(item.quantity||0));
  const currentStock=purchaseGlobalStock(item.productId);
  const estimatedAverage=currentStock+quantity>0?((currentStock*currentCost)+(quantity*purchaseCost))/(currentStock+quantity):purchaseCost;
  return `Costo actual: ${fmtMoney(currentCost)}${Math.abs(currentCost-purchaseCost)>0.0001?` · Promedio estimado: ${fmtMoney(estimatedAverage)}`:' · Se conservará al recibir'} `;
}
function updatePurchaseOrderTotal(){
  $('#purchaseOrderTotal').textContent=fmtMoney(PURCHASE_ORDER_ITEMS.reduce((sum,item)=>sum+Number(item.quantity||0)*Number(item.unitCost||0),0));
}
function updatePurchaseOrderRow(index){
  const item=PURCHASE_ORDER_ITEMS[index];
  const row=document.querySelector(`#purchaseOrderItems [data-index="${index}"]`);
  if(!item||!row)return;
  const lineTotal=row.querySelector('[data-po-line-total]');
  const guidance=row.querySelector('[data-po-cost-guidance]');
  if(lineTotal)lineTotal.textContent=fmtMoney(Number(item.quantity||0)*Number(item.unitCost||0));
  if(guidance)guidance.textContent=purchaseCostGuidance(item);
  updatePurchaseOrderTotal();
}
function renderPurchaseOrderItems(){
  const host=$('#purchaseOrderItems');
  host.innerHTML=PURCHASE_ORDER_ITEMS.map((item,index)=>`<div class="purchase-item-row" data-index="${index}">
    <div class="purchase-item-field" data-label="Producto"><select data-po-field="productId" aria-label="Producto">${purchaseProductOptions(item.productId)}</select></div>
    <div class="purchase-item-field" data-label="Cantidad"><input data-po-field="quantity" aria-label="Cantidad" type="number" min="0.0001" step="0.0001" value="${item.quantity}" placeholder="Cantidad"></div>
    <div class="purchase-item-field purchase-cost-input" data-label="Costo unitario"><input data-po-field="unitCost" aria-label="Costo unitario" type="number" min="0" step="0.0001" value="${item.unitCost}" placeholder="Costo unitario"><small data-po-cost-guidance>${purchaseCostGuidance(item)}</small></div>
    <b class="purchase-item-line-total" data-label="Importe" data-po-line-total>${fmtMoney(Number(item.quantity||0)*Number(item.unitCost||0))}</b>
    <button type="button" class="btn btn-ghost btn-sm purchase-remove-item" aria-label="Eliminar producto"><i class="ph-bold ph-trash"></i></button>
  </div>`).join('');
  host.querySelectorAll('[data-po-field="productId"]').forEach(select=>select.addEventListener('change',()=>{
    const index=Number(select.closest('[data-index]').dataset.index);
    PURCHASE_ORDER_ITEMS[index].productId=select.value;
    const product=PURCHASE_DATA.products.find((row)=>String(row.id)===select.value);
    PURCHASE_ORDER_ITEMS[index].unitCost=product?Number(product.unitCost||0):0;
    renderPurchaseOrderItems();
  }));
  host.querySelectorAll('[data-po-field="quantity"],[data-po-field="unitCost"]').forEach(input=>input.addEventListener('input',()=>{
    const index=Number(input.closest('[data-index]').dataset.index);
    PURCHASE_ORDER_ITEMS[index][input.dataset.poField]=Math.max(0,Number(input.value)||0);
    updatePurchaseOrderRow(index);
  }));
  host.querySelectorAll('.purchase-remove-item').forEach(button=>button.addEventListener('click',()=>{PURCHASE_ORDER_ITEMS.splice(Number(button.closest('[data-index]').dataset.index),1);renderPurchaseOrderItems();}));
  updatePurchaseOrderTotal();
}
function openPurchaseOrder(id=null){
  const order=id?PURCHASE_ORDERS.find(row=>Number(row.id)===Number(id)):null;
  if(id&&!order)return toast('No se encontró la orden',true);
  if(order&&order.status!=='ordered')return toast('Sólo las órdenes pendientes se pueden editar',true);
  if(!order&&!PURCHASE_DATA.suppliers.some(row=>row.active))return toast('Primero registra un proveedor activo',true);
  if(!order&&!PURCHASE_DATA.branches.some(row=>row.active))return toast('Primero configura una sucursal',true);
  PURCHASE_ORDER_EDIT_ID=order?.id||null;
  PURCHASE_ORDER_ITEMS=order?order.items.map(item=>({key:`i${item.id||Date.now()}${Math.random()}`,productId:item.productId,quantity:item.quantity,unitCost:item.unitCost})):[newPurchaseOrderItem()];
  $('#purchaseOrderModalTitle').textContent=order?`Editar ${order.orderNumber}`:'Nueva orden de compra';
  $('#purchaseOrderSubmit').innerHTML=order?'<i class="ph-bold ph-floppy-disk"></i> Guardar cambios':'<i class="ph-bold ph-check-circle"></i> Crear orden';
  $('#purchaseOrderSupplier').innerHTML=purchaseSupplierOptions(order?.supplierId);
  $('#purchaseOrderBranch').innerHTML=purchaseBranchOptions(false,order?.branchId);
  $('#purchaseOrderSupplier').value=order?.supplierId||'';
  $('#purchaseOrderBranch').value=order?.branchId||'';
  $('#purchaseOrderDate').value=order?.orderDate||getLocalIsoDate();
  $('#purchaseExpectedDate').value=order?.expectedDate||'';
  $('#purchaseOrderNotes').value=order?.notes||'';
  renderPurchaseOrderItems();
  openModal('purchaseOrderModal');
}

function newPurchaseTransferItem(){return{productId:'',quantity:1};}

function purchaseTransferRound(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function purchaseTransferStockRow(productId) {
  return PURCHASE_TRANSFER_STOCK?.products?.find((row) => Number(row.productId) === Number(productId)) || null;
}

function purchaseTransferProductOptions(selected = '', currentIndex = -1) {
  const selectedElsewhere = new Set(PURCHASE_TRANSFER_ITEMS
    .filter((item, index) => index !== currentIndex && item.productId)
    .map((item) => String(item.productId)));
  const products = PURCHASE_TRANSFER_STOCK?.products || PURCHASE_DATA.products.map((product) => ({
    productId: product.id,
    productName: product.name,
    availableFrom: Math.max(0, purchaseStock($('#purchaseTransferFrom').value, product.id)),
  }));
  return `<option value="">Selecciona producto…</option>${products.map((product) => {
    const id = String(product.productId);
    const isSelected = id === String(selected);
    const disabled = selectedElsewhere.has(id) && !isSelected;
    return `<option value="${product.productId}" ${isSelected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(product.productName)} · origen ${invFmt(product.availableFrom)}</option>`;
  }).join('')}`;
}

function purchaseTransferItemMetrics(item) {
  const stock = purchaseTransferStockRow(item.productId);
  const quantity = Math.max(0, purchaseTransferRound(item.quantity));
  const fromCurrent = purchaseTransferRound(stock?.fromQuantity || 0);
  const available = Math.max(0, purchaseTransferRound(stock?.availableFrom || 0));
  const toCurrent = purchaseTransferRound(stock?.toQuantity || 0);
  return {
    stock,
    quantity,
    fromCurrent,
    available,
    toCurrent,
    fromAfter: purchaseTransferRound(fromCurrent - quantity),
    toAfter: purchaseTransferRound(toCurrent + quantity),
    insufficient: Boolean(item.productId) && quantity > available,
  };
}

function purchaseTransferMetricsHtml(item) {
  if (!item.productId) return '<div class="purchase-transfer-empty-metric"><i class="ph-bold ph-package"></i> Selecciona un producto para consultar ambas existencias.</div>';
  const metrics = purchaseTransferItemMetrics(item);
  return `<div class="purchase-transfer-flow ${metrics.insufficient ? 'is-insufficient' : ''}">
    <div class="origin"><small>Origen actual</small><b>${invFmt(metrics.fromCurrent)}</b><span>Quedará ${invFmt(metrics.fromAfter)}</span></div>
    <i class="ph-bold ph-arrow-right"></i>
    <div class="destination"><small>Destino actual</small><b>${invFmt(metrics.toCurrent)}</b><span>Quedará ${invFmt(metrics.toAfter)}</span></div>
    ${metrics.insufficient ? `<em><i class="ph-bold ph-warning"></i> Sólo hay ${invFmt(metrics.available)} disponibles</em>` : ''}
  </div>`;
}

function updatePurchaseTransferValidity() {
  const fromId = Number($('#purchaseTransferFrom').value);
  const toId = Number($('#purchaseTransferTo').value);
  const snapshotIsCurrent = Number(PURCHASE_TRANSFER_STOCK?.from?.id) === fromId && Number(PURCHASE_TRANSFER_STOCK?.to?.id) === toId;
  const productIds = PURCHASE_TRANSFER_ITEMS.map((item) => String(item.productId || '')).filter(Boolean);
  const uniqueProducts = new Set(productIds).size === productIds.length;
  const itemsValid = PURCHASE_TRANSFER_ITEMS.length > 0 && PURCHASE_TRANSFER_ITEMS.every((item) => {
    const metrics = purchaseTransferItemMetrics(item);
    return Boolean(item.productId) && metrics.quantity > 0 && !metrics.insufficient;
  });
  const valid = !PURCHASE_TRANSFER_STOCK_LOADING && snapshotIsCurrent && fromId !== toId && uniqueProducts && itemsValid;
  const submit = $('#purchaseTransferSubmit');
  const refresh = $('#purchaseTransferRefresh');
  if (submit) submit.disabled = !valid;
  if (refresh) refresh.disabled = PURCHASE_TRANSFER_STOCK_LOADING || !fromId || !toId || fromId === toId;
  return valid;
}

function updatePurchaseTransferRow(index) {
  const item = PURCHASE_TRANSFER_ITEMS[index];
  const row = document.querySelector(`#purchaseTransferItems [data-index="${index}"]`);
  if (!item || !row) return;
  const metrics = purchaseTransferItemMetrics(item);
  row.classList.toggle('is-insufficient', metrics.insufficient);
  const metricHost = row.querySelector('[data-pt-stock-metrics]');
  if (metricHost) metricHost.innerHTML = purchaseTransferMetricsHtml(item);
  updatePurchaseTransferValidity();
}

function renderPurchaseTransferSummary() {
  const host = $('#purchaseTransferStockSummary');
  if (!host) return;
  const fromId = Number($('#purchaseTransferFrom').value);
  const toId = Number($('#purchaseTransferTo').value);
  if (!fromId || !toId || fromId === toId) {
    host.innerHTML = '<div class="purchase-transfer-message warning"><i class="ph-bold ph-warning-circle"></i><span>Selecciona dos sucursales diferentes para consultar su inventario real.</span></div>';
    return;
  }
  if (PURCHASE_TRANSFER_STOCK_LOADING) {
    host.innerHTML = '<div class="purchase-transfer-message loading"><span class="spinner"></span><span>Consultando existencias actuales de ambas sucursales…</span></div>';
    return;
  }
  if (PURCHASE_TRANSFER_STOCK?.error) {
    host.innerHTML = `<div class="purchase-transfer-message danger"><i class="ph-bold ph-warning-circle"></i><span>${esc(PURCHASE_TRANSFER_STOCK.error)}</span></div>`;
    return;
  }
  const data = PURCHASE_TRANSFER_STOCK;
  if (!data?.from || !data?.to) {
    host.innerHTML = '<div class="purchase-transfer-message"><i class="ph-bold ph-info"></i><span>Selecciona las sucursales para cargar sus existencias.</span></div>';
    return;
  }
  const updatedAt = new Date(data.generatedAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  host.innerHTML = `<div class="purchase-transfer-branch origin"><i class="ph-bold ph-storefront"></i><div><small>Origen · inventario actual</small><b>${esc(data.from.name)}</b><span>${invFmt(data.from.totalUnits)} unidades · ${data.from.productsWithStock} productos con existencia</span></div></div>
    <i class="ph-bold ph-arrow-right purchase-transfer-summary-arrow"></i>
    <div class="purchase-transfer-branch destination"><i class="ph-bold ph-warehouse"></i><div><small>Destino · inventario actual</small><b>${esc(data.to.name)}</b><span>${invFmt(data.to.totalUnits)} unidades · ${data.to.productsWithStock} productos con existencia</span></div></div>
    <div class="purchase-transfer-freshness"><i class="ph-bold ph-clock"></i> Actualizado ${esc(updatedAt)}</div>`;
}

function renderPurchaseTransferItems() {
  const host = $('#purchaseTransferItems');
  host.innerHTML = PURCHASE_TRANSFER_ITEMS.map((item,index) => {
    const metrics = purchaseTransferItemMetrics(item);
    return `<div class="purchase-item-row transfer ${metrics.insufficient ? 'is-insufficient' : ''}" data-index="${index}">
      <div class="purchase-item-field" data-label="Producto"><select data-pt-field="productId" aria-label="Producto a trasladar">${purchaseTransferProductOptions(item.productId,index)}</select></div>
      <div class="purchase-item-field" data-label="Cantidad"><input data-pt-field="quantity" aria-label="Cantidad a trasladar" inputmode="decimal" type="number" min="0.0001" ${item.productId ? `max="${metrics.available}"` : ''} step="0.0001" value="${item.quantity}" placeholder="Cantidad"></div>
      <div class="purchase-transfer-row-metrics" data-pt-stock-metrics>${purchaseTransferMetricsHtml(item)}</div>
      <button type="button" class="btn btn-ghost btn-sm purchase-remove-item" aria-label="Eliminar producto"><i class="ph-bold ph-trash"></i></button>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-pt-field="productId"]').forEach((select) => select.addEventListener('change', () => {
    const index = Number(select.closest('[data-index]').dataset.index);
    PURCHASE_TRANSFER_ITEMS[index].productId = select.value;
    renderPurchaseTransferItems();
  }));
  host.querySelectorAll('[data-pt-field="quantity"]').forEach((input) => input.addEventListener('input', () => {
    const index = Number(input.closest('[data-index]').dataset.index);
    PURCHASE_TRANSFER_ITEMS[index].quantity = Math.max(0, Number(input.value) || 0);
    updatePurchaseTransferRow(index);
  }));
  host.querySelectorAll('.purchase-remove-item').forEach((button) => button.addEventListener('click', () => {
    PURCHASE_TRANSFER_ITEMS.splice(Number(button.closest('[data-index]').dataset.index), 1);
    renderPurchaseTransferItems();
  }));
  updatePurchaseTransferValidity();
}

async function loadPurchaseTransferStock(options = {}) {
  const fromId = Number($('#purchaseTransferFrom').value);
  const toId = Number($('#purchaseTransferTo').value);
  const requestId = ++PURCHASE_TRANSFER_STOCK_REQUEST;
  if (!fromId || !toId || fromId === toId) {
    PURCHASE_TRANSFER_STOCK = null;
    PURCHASE_TRANSFER_STOCK_LOADING = false;
    renderPurchaseTransferSummary();
    renderPurchaseTransferItems();
    return false;
  }
  PURCHASE_TRANSFER_STOCK = null;
  PURCHASE_TRANSFER_STOCK_LOADING = true;
  renderPurchaseTransferSummary();
  renderPurchaseTransferItems();
  try {
    const query = new URLSearchParams({ fromBranchId: String(fromId), toBranchId: String(toId), refresh: String(Date.now()) });
    const data = await api(`/api/purchases/transfer-stock?${query}`);
    if (requestId !== PURCHASE_TRANSFER_STOCK_REQUEST) return false;
    PURCHASE_TRANSFER_STOCK = data;
    const selectedBranches = new Set([fromId, toId]);
    PURCHASE_DATA.branchStock = PURCHASE_DATA.branchStock.filter((row) => !selectedBranches.has(Number(row.branchId)));
    data.products.forEach((product) => {
      PURCHASE_DATA.branchStock.push({ branchId: fromId, productId: product.productId, quantity: product.fromQuantity });
      PURCHASE_DATA.branchStock.push({ branchId: toId, productId: product.productId, quantity: product.toQuantity });
    });
    return true;
  } catch (error) {
    if (requestId !== PURCHASE_TRANSFER_STOCK_REQUEST) return false;
    PURCHASE_TRANSFER_STOCK = { error: error.message || 'No se pudo consultar el inventario actual' };
    if (!options.quiet) toast(PURCHASE_TRANSFER_STOCK.error, true);
    return false;
  } finally {
    if (requestId === PURCHASE_TRANSFER_STOCK_REQUEST) {
      PURCHASE_TRANSFER_STOCK_LOADING = false;
      renderPurchaseTransferSummary();
      renderPurchaseTransferItems();
    }
  }
}

function normalizePurchaseTransferBranches(changed) {
  const from = $('#purchaseTransferFrom');
  const to = $('#purchaseTransferTo');
  if (!from.value || !to.value || from.value !== to.value) return;
  const alternatives = PURCHASE_DATA.branches.filter((row) => row.active && String(row.id) !== (changed === 'from' ? from.value : to.value));
  if (!alternatives.length) return;
  if (changed === 'from') to.value = String(alternatives[0].id);
  else from.value = String(alternatives[0].id);
}

function openPurchaseTransfer(source = null) {
  const branches = PURCHASE_DATA.branches.filter((row) => row.active);
  if (branches.length < 2) return toast('Configura al menos dos sucursales', true);
  const sourceFrom = Number(source?.from_branch_id);
  const sourceTo = Number(source?.to_branch_id);
  if (source && (!branches.some((row) => Number(row.id) === sourceFrom) || !branches.some((row) => Number(row.id) === sourceTo))) {
    return toast('No se puede repetir: una de las sucursales ya no está activa', true);
  }
  PURCHASE_TRANSFER_ITEMS = source?.items?.length
    ? source.items.map((item) => ({ productId: item.productId, quantity: item.quantity }))
    : [newPurchaseTransferItem()];
  PURCHASE_TRANSFER_STOCK = null;
  $('#purchaseTransferFrom').innerHTML = purchaseBranchOptions();
  $('#purchaseTransferTo').innerHTML = purchaseBranchOptions();
  $('#purchaseTransferFrom').value = String(source ? sourceFrom : branches[0].id);
  $('#purchaseTransferTo').value = String(source ? sourceTo : branches[1].id);
  $('#purchaseTransferNotes').value = source ? `Repetición de ${source.transfer_number}${source.notes ? ` · ${source.notes}` : ''}`.slice(0,300) : '';
  renderPurchaseTransferSummary();
  renderPurchaseTransferItems();
  openModal('purchaseTransferModal');
  loadPurchaseTransferStock();
}

document.querySelectorAll('#purchaseTabs [data-purchase-tab]').forEach(button=>button.addEventListener('click',()=>setPurchaseTab(button.dataset.purchaseTab)));
document.querySelectorAll('#purchasePeriodTabs [data-purchase-period]').forEach(button=>button.addEventListener('click',()=>purchaseSetPeriod(button.dataset.purchasePeriod)));
$('#purchaseStartDate')?.addEventListener('change',()=>purchaseSetPeriod('custom'));$('#purchaseEndDate')?.addEventListener('change',()=>purchaseSetPeriod('custom'));$('#purchaseApplyReport')?.addEventListener('click',loadPurchaseReport);$('#purchaseReportBranch')?.addEventListener('change',loadPurchaseReport);
$('#purchaseOrderStatus')?.addEventListener('change',loadPurchaseOrders);$('#purchaseRefreshOrders')?.addEventListener('click',loadPurchaseOrders);$('#purchaseNewOrder')?.addEventListener('click',()=>openPurchaseOrder());$('#purchaseNewSupplier')?.addEventListener('click',()=>openPurchaseSupplier());$('#purchaseNewTransfer')?.addEventListener('click',()=>openPurchaseTransfer());
$('#purchaseAddOrderItem')?.addEventListener('click',()=>{PURCHASE_ORDER_ITEMS.push(newPurchaseOrderItem());renderPurchaseOrderItems();});
$('#purchaseAddTransferItem')?.addEventListener('click',()=>{PURCHASE_TRANSFER_ITEMS.push(newPurchaseTransferItem());renderPurchaseTransferItems();});
$('#purchaseTransferFrom')?.addEventListener('change',()=>{normalizePurchaseTransferBranches('from');loadPurchaseTransferStock();});
$('#purchaseTransferTo')?.addEventListener('change',()=>{normalizePurchaseTransferBranches('to');loadPurchaseTransferStock();});
$('#purchaseTransferRefresh')?.addEventListener('click',()=>loadPurchaseTransferStock());
$('#purchaseSupplierForm')?.addEventListener('submit',async event=>{event.preventDefault();const id=Number($('#purchaseSupplierId').value);const body={name:$('#purchaseSupplierName').value,taxId:$('#purchaseSupplierTaxId').value,contactName:$('#purchaseSupplierContact').value,phone:$('#purchaseSupplierPhone').value,email:$('#purchaseSupplierEmail').value,address:$('#purchaseSupplierAddress').value,notes:$('#purchaseSupplierNotes').value,active:$('#purchaseSupplierActive').checked};try{await api(id?`/api/purchases/suppliers/${id}`:'/api/purchases/suppliers',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});closeModal('purchaseSupplierModal');PURCHASE_DATA=await api('/api/purchases/bootstrap');renderPurchaseSuppliers();toast('Proveedor guardado');}catch(error){toast(error.message,true);}});
$('#purchaseOrderForm')?.addEventListener('submit',async event=>{event.preventDefault();const editId=PURCHASE_ORDER_EDIT_ID;try{await api(editId?`/api/purchases/orders/${editId}`:'/api/purchases/orders',{method:editId?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({supplierId:Number($('#purchaseOrderSupplier').value),branchId:Number($('#purchaseOrderBranch').value),orderDate:$('#purchaseOrderDate').value,expectedDate:$('#purchaseExpectedDate').value,notes:$('#purchaseOrderNotes').value,items:PURCHASE_ORDER_ITEMS.map(item=>({productId:Number(item.productId),quantity:Number(item.quantity),unitCost:Number(item.unitCost)}))})});closeModal('purchaseOrderModal');PURCHASE_ORDER_EDIT_ID=null;setPurchaseTab('orders');toast(editId?'Orden actualizada':'Orden de compra creada');}catch(error){toast(error.message,true);}});
$('#purchaseTransferForm')?.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!updatePurchaseTransferValidity())return toast('Revisa las sucursales, productos y existencias disponibles',true);
  const submit=$('#purchaseTransferSubmit');
  const original=submit.innerHTML;
  submit.disabled=true;
  submit.innerHTML='<span class="spinner"></span> Trasladando…';
  try{
    const result=await api('/api/purchases/transfers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fromBranchId:Number($('#purchaseTransferFrom').value),toBranchId:Number($('#purchaseTransferTo').value),notes:$('#purchaseTransferNotes').value,items:PURCHASE_TRANSFER_ITEMS.map(item=>({productId:Number(item.productId),quantity:Number(item.quantity)}))})});
    closeModal('purchaseTransferModal');
    PURCHASE_DATA=await api('/api/purchases/bootstrap');
    await loadPurchaseTransfers();
    if(BRANCH_STOCK_DATA.rows.length)loadBranchStock();
    toast(`${result.transferNumber}: inventario descontado de ${result.fromBranch} y sumado a ${result.toBranch}`);
  }catch(error){
    toast(error.message,true);
    await loadPurchaseTransferStock({quiet:true});
  }finally{
    submit.innerHTML=original;
    updatePurchaseTransferValidity();
  }
});

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
  const configuredLabel = String(order?.receiving_mode_label || '').trim();
  const isAddressDelivery = order?.receiving_mode_behavior === 'delivery' || order?.delivery === 'domicilio';
  if (isAddressDelivery) return configuredLabel || 'Domicilio';
  const pickup = String(order?.pickup_branch_name || '').trim();
  const label = configuredLabel || (order?.delivery === 'comer_sucursal' ? 'Comer en sucursal' : 'Recoger');
  return pickup ? `${label} · ${pickup}` : label;
}

function buildOrderComandaItems(order) {
  const rows = Array.isArray(order?.items) ? order.items : [];
  return rows.map((item) => ({
    qty: Number(item?.qty || 0),
    name: String(item?.name || 'Producto'),
  }));
}

function operationalOrderNote(order) {
  return String(order?.order_note || order?.order_notes || (order?.channel === 'pos' ? order?.notes : '') || '').trim();
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
  const addressDelivery = order?.receiving_mode_behavior === 'delivery' || order?.delivery === 'domicilio';
  const branch = esc(addressDelivery ? (order?.service_branch_name || '—') : (order?.pickup_branch_name || '—'));
  const createdAt = esc(order?.created_at || fmtBusinessDateTime());
  const notes = esc(operationalOrderNote(order));
  const deliveryAddress = esc(order?.delivery_address || order?.customer?.address || '');
  const deliveryNeighborhood = esc(order?.delivery_neighborhood || '');
  const deliveryReference = esc(order?.delivery_reference || (order?.channel === 'chatbot' ? order?.notes : '') || '');
  const deliveryLocation = esc(order?.customer_location_text || order?.customer_location_resolved || '');

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
    .order-note { margin: 9px 0; padding: 8px; border: 3px double #000; font-size: ${Math.max(fontPx + 2, 14)}px; font-weight: 900; line-height: 1.35; text-align: center; overflow-wrap: anywhere; }
    .order-note span { display: block; margin-bottom: 3px; font-size: ${Math.max(fontPx - 2, 10)}px; letter-spacing: .7px; }
    .delivery-block { margin: 7px 0; padding: 7px; border: 2px solid #000; overflow-wrap: anywhere; }
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
    ${addressDelivery && (deliveryAddress || deliveryNeighborhood || deliveryReference || deliveryLocation) ? `<div class="delivery-block">
      <div><b>DOMICILIO:</b> ${deliveryAddress || '—'}</div>
      ${deliveryNeighborhood ? `<div><b>COLONIA / BARRIO:</b> ${deliveryNeighborhood}</div>` : ''}
      ${deliveryReference ? `<div><b>REFERENCIA:</b> ${deliveryReference}</div>` : ''}
      ${deliveryLocation && deliveryLocation !== deliveryAddress ? `<div><b>UBICACIÓN:</b> ${deliveryLocation}</div>` : ''}
    </div>` : ''}
    ${notes ? `<div class="order-note"><span>⚠ NOTA DEL PEDIDO</span>${notes}</div>` : ''}
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
      const orderNote = operationalOrderNote(o);
      const noteCallout = orderNote
        ? `<div class="order-note-callout"><span><i class="ph-fill ph-warning-circle"></i> Nota del pedido</span><b>${esc(orderNote)}</b></div>`
        : '';
      const statusCell = editable
        ? `<select data-order="${o.id}" class="status-sel s-${o.status}">
            ${STATUSES.map((st) => `<option value="${st}" ${st === o.status ? 'selected' : ''}>${st[0].toUpperCase() + st.slice(1)}</option>`).join('')}
          </select>`
        : `<span class="badge b-${o.status}">${o.status}</span>`;
      const isAddressDelivery = o.receiving_mode_behavior === 'delivery' || o.delivery === 'domicilio';
      const deliveryText = `<i class="ph-bold ${isAddressDelivery ? 'ph-moped' : (o.delivery === 'comer_sucursal' ? 'ph-fork-knife' : 'ph-storefront')}" style="color:${isAddressDelivery ? 'var(--blue)' : 'var(--violet)'}"></i> ${esc(buildOrderDeliveryLabel(o))}`;
      const deliveryFeeText =
        isAddressDelivery && Number(o.delivery_fee || 0) > 0
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
        <td style="max-width:280px">${esc(items)}${noteCallout}</td>
        <td style="white-space:nowrap">${deliveryText}${deliveryFeeText}${locationText}${cancelNoteText}</td>
        <td style="white-space:nowrap;font-size:13px"><b>${esc(isAddressDelivery ? (o.service_branch_name || '—') : (o.pickup_branch_name || '—'))}</b></td>
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
    const defaultRange = defaultOrdersWeekRange();
    let dateModeLabel = 'todas las fechas';
    if (orderDateStart || orderDateEnd) {
      dateModeLabel = orderDateStart === defaultRange.start && orderDateEnd === defaultRange.end
        ? 'últimos 7 días'
        : 'rango personalizado';
    }
    toggle.classList.toggle('on', orderTodayOnly);
    toggle.setAttribute('aria-pressed', String(orderTodayOnly));
    toggle.innerHTML = `<i class="ph-bold ph-calendar-check"></i> Solo pedidos del día: ${orderTodayOnly ? 'Activado' : `Desactivado · ${dateModeLabel}`}`;
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
    const isAddressDelivery = o.receiving_mode_behavior === 'delivery' || o.delivery === 'domicilio';
    const sucursal = isAddressDelivery ? (o.service_branch_name || '—') : (o.pickup_branch_name || '—');
    return {
      pedido: `#${o.id}`,
      cliente: o.customer?.name || '—',
      telefono: o.customer?.phone || '',
      productos: o.items.map((it) => `${it.qty}x ${it.name}`).join(', '),
      entrega: buildOrderDeliveryLabel(o),
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
  doc.text(`Generado: ${fmtBusinessDateTime()}`, 14, 20);
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
  } else {
    resetOrdersToDefaultWeek();
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
  orderTodayOnly = false;
  orderDateStart = '';
  orderDateEnd = '';
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
  if (POS_TABLE_ACCOUNT) {
    return moneyNum(Number(POS_TABLE_ACCOUNT.total || 0) + posCartTotal());
  }
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
  $('#posCancelSalePin').value = '';
  $('#posCancelSalePinWrap').hidden = !POS_OVERVIEW?.policy?.cancelRequirePin;
  $('#posCancelSaleModal').classList.add('show');
}

async function submitPosCancelSale() {
  const saleId = Number($('#posCancelSaleSaleId')?.value || 0);
  const reason = String($('#posCancelSaleReason')?.value || '').trim();
  const pin = String($('#posCancelSalePin')?.value || '').trim();
  
  if (!saleId) return toast('Venta inválida', true);
  if (!reason) return toast('Debes indicar un motivo de cancelación', true);
  
  try {
    await api(`/api/pos/sales/${saleId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, pin }),
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
  if (POS_PAYMENT_METHOD === 'cash' && (POS_PAYMENT_FORM.cashReceived === '' || POS_PAYMENT_FORM.cashReceived === null || moneyNum(POS_PAYMENT_FORM.cashReceived) < total)) {
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
  POS_PAYMENT_FORM = { cashReceived: '', cash: '', card: '', transfer: '', notes: '', deliveryAddress: '', deliveryNeighborhood: '', deliveryReference: '' };
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
      createdAt: fmtBusinessDateTime(),
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
      delivery: POS_IS_DELIVERY ? 'domicilio' : 'mostrador',
      deliveryAddress: POS_IS_DELIVERY ? POS_PAYMENT_FORM.deliveryAddress || '' : '',
      deliveryNeighborhood: POS_IS_DELIVERY ? POS_PAYMENT_FORM.deliveryNeighborhood || '' : '',
      deliveryReference: POS_IS_DELIVERY ? POS_PAYMENT_FORM.deliveryReference || '' : '',
    };
  }
  if (LAST_POS_SALE) {
    return {
      id: LAST_POS_SALE.id,
      createdAt: fmtBusinessDateTime(),
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
      delivery: LAST_POS_SALE.delivery || '',
      deliveryAddress: LAST_POS_SALE.deliveryAddress || LAST_POS_SALE.delivery_address || '',
      deliveryNeighborhood: LAST_POS_SALE.deliveryNeighborhood || LAST_POS_SALE.delivery_neighborhood || '',
      deliveryReference: LAST_POS_SALE.deliveryReference || LAST_POS_SALE.delivery_reference || '',
      tableNumber: LAST_POS_SALE.tableNumber || null,
      waiterName: LAST_POS_SALE.waiterName || '',
      rounds: Array.isArray(LAST_POS_SALE.rounds) ? LAST_POS_SALE.rounds : [],
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
  const isRoundTicket = Boolean(ticket.isTableRound);
  const ticketId = isRoundTicket
    ? `Mesa ${ticket.tableNumber} · Ronda ${ticket.roundNumber}`
    : ticket.id ? `#${ticket.id}` : 'Pre-ticket';
  const itemRows = (ticket.items || [])
    .map(
      (it) => `<tr>
        <td>${esc(`${it.qty} x ${it.name}`)}<div style="font-size:${Math.max(fontPx-2,10)}px;color:#555">${esc(fmtMoney(it.price, currency))} c/u</div></td>
        <td class="r">${esc(fmtMoney(it.total, currency))}</td>
      </tr>`
    )
    .join('') || '<tr><td>Sin productos</td><td class="r">$0.00</td></tr>';
  const groupedRoundRows = !isRoundTicket && Array.isArray(ticket.rounds) && ticket.rounds.length
    ? ticket.rounds.map((round) => `
      <tr><td colspan="2" style="padding-top:7px;border-top:1px dashed #777"><b>RONDA ${esc(String(round.roundNumber))}</b><span style="float:right"><b>${esc(fmtMoney(round.subtotal || 0, currency))}</b></span></td></tr>
      ${(round.items || []).map((it) => `<tr><td>${esc(`${it.qty} x ${it.name}`)}<div style="font-size:${Math.max(fontPx-2,10)}px;color:#555">${esc(fmtMoney(it.price, currency))} c/u</div></td><td class="r">${esc(fmtMoney(Number(it.qty || 0) * Number(it.price || 0), currency))}</td></tr>`).join('')}
    `).join('')
    : '';

  const breakdownObj = ticket.paymentBreakdown || {};
  const isMixed = ticket.paymentMethod === 'mixed';
  const breakdownLines = ['cash', 'card', 'transfer']
    .filter((method) => Number(breakdownObj[method]) > 0)
    .map((method) => `<tr><td>${esc(posMethodLabel(method))}</td><td class="r">${esc(fmtMoney(breakdownObj[method], currency))}</td></tr>`)
    .join('');

  const subtotal = Number(ticket.subtotal || ticket.total || 0);
  const total = Number(ticket.total || 0);
  const deliveryAddress = esc(ticket.deliveryAddress || ticket.delivery_address || '');
  const deliveryNeighborhood = esc(ticket.deliveryNeighborhood || ticket.delivery_neighborhood || '');
  const deliveryReference = esc(ticket.deliveryReference || ticket.delivery_reference || '');
  const hasDeliveryData = Boolean(deliveryAddress || deliveryNeighborhood || deliveryReference);
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
    .order-note { margin: 9px 0; padding: 8px; border: 3px double #000; font-size: ${Math.max(fontPx + 2, 14)}px; font-weight: 900; line-height: 1.35; text-align: center; overflow-wrap: anywhere; }
    .order-note span { display: block; margin-bottom: 3px; font-size: ${Math.max(fontPx - 2, 10)}px; letter-spacing: .7px; }
    .delivery-block { margin: 7px 0; padding: 7px; border: 2px solid #000; overflow-wrap: anywhere; }
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
  ${isRoundTicket ? `<div class="center meta"><b>Mesero: ${esc(ticket.waiterName || '—')}</b></div><div class="center meta"><b>COMANDA DE RONDA</b></div>` : ''}
  ${!isRoundTicket && ticket.tableNumber ? `<div class="center meta"><b>Mesa ${esc(String(ticket.tableNumber))} · Mesero: ${esc(ticket.waiterName || '—')}</b></div>` : ''}
  ${hasDeliveryData ? `<div class="delivery-block"><div class="center"><b>ENTREGA A DOMICILIO</b></div>
    ${deliveryAddress ? `<div><b>DOMICILIO:</b> ${deliveryAddress}</div>` : ''}
    ${deliveryNeighborhood ? `<div><b>COLONIA / BARRIO:</b> ${deliveryNeighborhood}</div>` : ''}
    ${deliveryReference ? `<div><b>REFERENCIA:</b> ${deliveryReference}</div>` : ''}
  </div>` : ''}
  <div class="sep"></div>
  <table>${groupedRoundRows || itemRows}</table>
  <div class="sep"></div>
  <table>
    ${isRoundTicket
      ? `<tr><td>Total ronda ${esc(String(ticket.roundNumber))}</td><td class="r">${esc(fmtMoney(subtotal, currency))}</td></tr>
         <tr><td class="tot">ACUMULADO MESA</td><td class="tot r">${esc(fmtMoney(total, currency))}</td></tr>`
      : `<tr><td>Método</td><td class="r">${esc(posMethodLabel(ticket.paymentMethod || 'cash'))}</td></tr>
    ${breakdownLines}
    ${Number(ticket.deliveryFee || 0) > 0
      ? `<tr><td>Subtotal</td><td class="r">${esc(fmtMoney(subtotal, currency))}</td></tr><tr><td>&#x1F6F5; Envío domicilio</td><td class="r">+ ${esc(fmtMoney(Number(ticket.deliveryFee), currency))}</td></tr>`
      : `<tr><td>Subtotal</td><td class="r">${esc(fmtMoney(subtotal, currency))}</td></tr>`}
    <tr><td class="tot">TOTAL</td><td class="tot r">${esc(fmtMoney(total, currency))}</td></tr>
    ${!isMixed && Number(ticket.cashReceived || 0) > 0 ? `<tr><td>Efectivo recibido</td><td class="r">${esc(fmtMoney(ticket.cashReceived, currency))}</td></tr>` : ''}
    ${!isMixed && Number(ticket.cashChange || 0) > 0 ? `<tr><td>Cambio</td><td class="r">${esc(fmtMoney(ticket.cashChange, currency))}</td></tr>` : ''}`}
  </table>
  ${ticket.notes ? `<div class="sep"></div><div class="order-note"><span>⚠ NOTA DEL PEDIDO</span>${esc(ticket.notes)}</div>` : ''}
  <div class="sep"></div>
  <div class="center meta">${isRoundTicket ? 'Ronda enviada a preparación' : 'Gracias por tu compra'}</div>
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

function printTableRoundTicket(round, account, accumulatedTotal) {
  if (!round || !account) return;
  const items = Array.isArray(round.items) ? round.items : [];
  openThermalPrintWindow({
    isTableRound: true,
    tableNumber: account.table_number,
    roundNumber: round.roundNumber,
    waiterName: account.waiter_name,
    createdAt: round.createdAt || fmtBusinessDateTime(),
    items: items.map((item) => ({
      qty: Number(item.qty || 0), name: String(item.name || ''), price: Number(item.price || 0),
      total: moneyNum(Number(item.qty || 0) * Number(item.price || 0)),
    })),
    subtotal: Number(round.subtotal || 0),
    total: Number(accumulatedTotal ?? account.total ?? 0),
    notes: round.notes || '',
  });
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
    createdAt: sale.created_at || fmtBusinessDateTime(),
    paymentMethod: sale.payment_method,
    items: items.map((it) => ({
      qty: Number(it.qty || 0),
      name: String(it.name || ''),
      price: Number(it.price || 0),
      total: moneyNum(Number(it.qty || 0) * Number(it.price || 0)),
    })),
    subtotal: Number(sale.total || 0) - Number(sale.delivery_fee || 0),
    deliveryFee: Number(sale.delivery_fee || 0),
    total: Number(sale.total || 0),
    paymentBreakdown: sale.payment_breakdown || null,
    cashReceived: moneyNum(sale.cash_received || 0),
    cashChange: moneyNum(sale.cash_change || 0),
    notes: String(sale.notes || ''),
    tableNumber: sale.table_number || null,
    waiterName: sale.waiter_name || '',
    rounds: Array.isArray(sale.rounds) ? sale.rounds : [],
    delivery: sale.delivery || '',
    deliveryAddress: sale.delivery_address || '',
    deliveryNeighborhood: sale.delivery_neighborhood || '',
    deliveryReference: sale.delivery_reference || '',
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
  const tables = totals.tables || {};

  const doc = new globalThis.jspdf.jsPDF({ orientation: 'portrait' });
  const bizName = SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio';
  const now = fmtBusinessDateTime();
  const session = closeResult?.closedSession || {};
  const closedBy = session.closed_by || ME?.username || 'cajero';

  doc.setFontSize(15);
  doc.text(`Corte de caja #${session.id || ''} - ${bizName}`, 14, 14);
  doc.setFontSize(10);
  doc.text(`Generado: ${now}`, 14, 20);
  doc.text(`Sucursal: ${session.branch_name || 'General'}`, 14, 25);
  doc.text(`Apertura: ${session.opened_at || '—'} · Cierre: ${session.closed_at || 'Pendiente'}`, 14, 30);
  doc.text(`Abrió: ${session.opened_by || '—'} · Cerró: ${closedBy}`, 14, 35);

  doc.autoTable({
    startY: 40,
    head: [['Concepto', 'Valor']],
    body: [
      ['Fondo inicial', fmtMoney(session.opening_amount || 0)],
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

  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 6,
    head: [['Mesas', 'Cantidad / total']],
    body: [
      ['Mesas cerradas', `${Number(tables.closedCount || 0)} · ${fmtMoney(tables.closedTotal || 0)}`],
      ['Mesas abiertas al cierre', `${Number(tables.openCount || 0)} · ${fmtMoney(tables.openTotal || 0)}`],
      ...(tables.closed || []).map((row) => [`Cerrada · Mesa ${row.table_number} · ${row.waiter_name || 'Sin mesero'}`, fmtMoney(row.total || 0)]),
      ...(tables.open || []).map((row) => [`Abierta · Mesa ${row.table_number} · ${row.waiter_name || 'Sin mesero'}`, fmtMoney(row.total || 0)]),
    ],
    styles: { fontSize: 9 },
    headStyles: { fillColor: [249, 115, 22] },
  });

  const notes = String(session.notes || '').trim();
  if (notes) {
    doc.setFontSize(9);
    doc.text(`Nota de cierre: ${notes}`, 14, doc.lastAutoTable.finalY + 10, { maxWidth: 180 });
  }

  doc.save(`corte_caja_${session.id || Date.now()}.pdf`);
}

function printPosCloseReport(closeResult) {
  if (!closeResult) return;
  const totals = closeResult.totals || {};
  const collected = totals.collected || {};
  const salesByMethod = totals.salesByMethod || {};
  const movements = totals.movements || {};
  const cancellations = totals.cancellations || {};
  const delivery = totals.delivery || {};
  const tables = totals.tables || {};
  const biz = esc(SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio');
  const now = fmtBusinessDateTime();
  const session = closeResult?.closedSession || {};
  const closedBy = esc(session.closed_by || ME?.username || 'cajero');

  const html = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Corte de caja #${esc(String(session.id || ''))}</title>
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
  <h2>Corte de caja #${esc(String(session.id || ''))} - ${biz}</h2>
  <p>Generado: ${esc(now)}</p>
  <p>Sucursal: ${esc(session.branch_name || 'General')}</p>
  <p>Apertura: ${esc(session.opened_at || '—')} · Cierre: ${esc(session.closed_at || 'Pendiente')}</p>
  <p>Abrió: ${esc(session.opened_by || '—')} · Cerró: ${closedBy}</p>
  <table>
    <tr><th>Concepto</th><th>Valor</th></tr>
    <tr><td>Fondo inicial</td><td>${esc(fmtMoney(session.opening_amount || 0))}</td></tr>
    <tr><td>Ventas del turno</td><td>${esc(fmtMoney(totals.totalSales || 0))}</td></tr>
    <tr><td>Efectivo esperado</td><td>${esc(fmtMoney(closeResult.expectedAmount || 0))}</td></tr>
    <tr><td>Efectivo contado</td><td>${esc(fmtMoney(closeResult.closingAmount || 0))}</td></tr>
    <tr class="tot"><td>Diferencia</td><td>${esc(fmtMoney(closeResult.differenceAmount || 0))}</td></tr>
  </table>
  ${session.notes ? `<p><b>Notas:</b> ${esc(session.notes)}</p>` : ''}
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
  <table>
    <tr><th>Mesas</th><th>Detalle</th></tr>
    <tr><td>Mesas cerradas</td><td>${esc(String(tables.closedCount || 0))} · ${esc(fmtMoney(tables.closedTotal || 0))}</td></tr>
    <tr><td>Mesas abiertas al cierre</td><td>${esc(String(tables.openCount || 0))} · ${esc(fmtMoney(tables.openTotal || 0))}</td></tr>
    ${(tables.closed || []).map((row) => `<tr><td>Cerrada · Mesa ${esc(String(row.table_number))}</td><td>${esc(row.waiter_name || 'Sin mesero')} · ${esc(fmtMoney(row.total || 0))}</td></tr>`).join('')}
    ${(tables.open || []).map((row) => `<tr><td>Abierta · Mesa ${esc(String(row.table_number))}</td><td>${esc(row.waiter_name || 'Sin mesero')} · ${esc(fmtMoney(row.total || 0))}</td></tr>`).join('')}
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
  const managedBranchId = getManagedPosBranchId();
  const managedSessionStillOpen = (POS_OVERVIEW?.openSessions || [])
    .some((session) => Number(session.branch_id) === Number(managedBranchId));
  if (managedBranchId && !POS_OVERVIEW?.activeSession && !managedSessionStillOpen) {
    setManagedPosBranchId(null);
    POS_OVERVIEW = await api('/api/pos/overview');
  }
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

function posCartPayload() {
  return POS_CART.map((item) => ({
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
  }));
}

function selectPosTableAccount(account) {
  if (!account) return;
  POS_TABLE_ACCOUNT = { ...account };
  POS_CART = [];
  resetPosPaymentForm();
  $('#posTablesModal')?.classList.remove('show');
  renderPosCart();
  toast(`Mesa ${account.table_number || account.tableNumber} seleccionada`);
}

function exitPosTableAccount() {
  POS_TABLE_ACCOUNT = null;
  POS_CART = [];
  resetPosPaymentForm();
  renderPosCart();
}

async function sendActiveTableRound({ silent = false } = {}) {
  if (!POS_TABLE_ACCOUNT) return;
  if (!POS_CART.length) throw new Error('Agrega al menos un producto para enviar la ronda');
  const draftItems = posCartPayload();
  const result = await api(`/api/pos/table-accounts/${POS_TABLE_ACCOUNT.id}/rounds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: draftItems, notes: POS_PAYMENT_FORM.notes || '' }),
  });
  POS_TABLE_ACCOUNT = result.account;
  POS_CART = [];
  POS_PAYMENT_FORM.notes = '';
  resetPosPaymentForm();
  const overviewTable = (POS_OVERVIEW?.tables || []).find((table) => Number(table.account?.id) === Number(result.account.id));
  if (overviewTable) overviewTable.account = result.account;
  const openSummary = POS_OVERVIEW?.activeSession?.totals?.tables;
  if (openSummary) {
    const summaryAccount = (openSummary.open || []).find((item) => Number(item.id) === Number(result.account.id));
    if (summaryAccount) Object.assign(summaryAccount, result.account);
    openSummary.openTotal = moneyNum((openSummary.open || []).reduce((sum, item) => sum + Number(item.total || 0), 0));
  }
  printTableRoundTicket(result.round, result.account, result.accumulatedTotal);
  if (!silent) toast(`Ronda ${result.round.roundNumber} enviada · Mesa ${result.account.table_number}`);
  renderPosActions();
  renderPosCart();
  return result;
}

function openPosRoundEditModal(roundId) {
  const round = (POS_TABLE_ACCOUNT?.rounds || []).find((item) => Number(item.id) === Number(roundId));
  if (!round) return toast('No se encontró la ronda', true);
  $('#posRoundEditId').value = String(round.id);
  $('#posRoundEditReason').value = '';
  $('#posRoundEditPin').value = '';
  $('#posRoundEditPinWrap').hidden = !POS_OVERVIEW?.policy?.roundEditRequirePin;
  $('#posRoundEditItems').innerHTML = (round.items || []).map((item, index) => `
    <div class="round-edit-item" data-round-edit-index="${index}">
      <div><b>${esc(item.name || 'Producto')}</b><small>${fmtMoney(item.price)} c/u</small></div>
      <input type="number" min="0" step="1" value="${Number(item.qty || 1)}" aria-label="Cantidad de ${esc(item.name || 'producto')}" />
    </div>`).join('');
  $('#posRoundEditModal').classList.add('show');
}

async function submitPosRoundEdit() {
  const roundId = Number($('#posRoundEditId').value || 0);
  const round = (POS_TABLE_ACCOUNT?.rounds || []).find((item) => Number(item.id) === roundId);
  if (!round) return toast('No se encontró la ronda', true);
  const reason = String($('#posRoundEditReason').value || '').trim();
  if (!reason) return toast('Escribe el motivo de la corrección', true);
  const quantities = [...document.querySelectorAll('#posRoundEditItems [data-round-edit-index] input')];
  const items = (round.items || []).map((item, index) => ({ ...item, qty: Math.max(0, Number(quantities[index]?.value || 0)) })).filter((item) => item.qty > 0);
  const result = await api(`/api/pos/table-accounts/${POS_TABLE_ACCOUNT.id}/rounds/${roundId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, reason, pin: $('#posRoundEditPin').value || '' }),
  });
  POS_TABLE_ACCOUNT = result.account;
  if (POS_PAYMENT_METHOD === 'cash') POS_PAYMENT_FORM.cashReceived = String(posGrandTotal());
  const table = (POS_OVERVIEW?.tables || []).find((item) => Number(item.account?.id) === Number(result.account.id));
  if (table) table.account = result.account;
  $('#posRoundEditModal').classList.remove('show');
  renderPosCart();
  renderPosActions();
  toast('Ronda corregida y registrada en auditoría');
}

function renderPosTablesLayout() {
  const host = $('#posTablesLayout');
  if (!host) return;
  const tables = Array.isArray(POS_OVERVIEW?.tables) ? POS_OVERVIEW.tables : [];
  const busy = tables.filter((table) => table.account).length;
  $('#posTablesCounts').textContent = `${tables.length} mesas · ${busy} abiertas`;
  if ($('#posTablesHint')) {
    $('#posTablesHint').textContent = POS_CHATBOT_TABLE_ORDER_ID
      ? `Selecciona una mesa libre para abrir la cuenta del pedido chatbot #${POS_CHATBOT_TABLE_ORDER_ID}.`
      : 'Selecciona una mesa libre para abrirla o una ocupada para continuar agregando consumos.';
  }
  host.innerHTML = tables.length
    ? tables.map((table) => {
        const account = table.account;
        const label = table.label || `Mesa ${table.tableNumber}`;
        return `<button type="button" class="pos-table-node ${esc(table.shape)} ${account ? 'busy' : ''}" data-pos-table="${table.id}" style="--x:${table.positionX}%;--y:${table.positionY}%">
          <b>${esc(label)}</b>
          <small>${account ? `${esc(account.customer_name || account.waiter_name || 'Cuenta abierta')} · ${(account.rounds || []).length} ronda(s)` : 'Disponible'}</small>
          ${account ? `<span class="table-total">${fmtMoney(account.total || 0)}</span>` : ''}
        </button>`;
      }).join('')
    : emptyHTML('ph-fork-knife', 'Sin mesas habilitadas', 'Configura y habilita mesas desde Mi chatbot > Mesas.');
  host.querySelectorAll('[data-pos-table]').forEach((button) => button.addEventListener('click', () => {
    const table = tables.find((item) => Number(item.id) === Number(button.dataset.posTable));
    if (!table) return;
    if (POS_CHATBOT_TABLE_ORDER_ID && table.account) return toast('Selecciona una mesa libre para este pedido', true);
    if (table.account) return selectPosTableAccount(table.account);
    $('#posTableOpenId').value = String(table.id);
    $('#posTableOpenTitle').textContent = `${table.label || `Mesa ${table.tableNumber}`}${POS_CHATBOT_TABLE_ORDER_ID ? ` · Pedido #${POS_CHATBOT_TABLE_ORDER_ID}` : ''}`;
    $('#posTableWaiterName').value = ME?.displayName || ME?.username || '';
    if ($('#posTableOpenSubmit')) $('#posTableOpenSubmit').innerHTML = POS_CHATBOT_TABLE_ORDER_ID
      ? '<i class="ph-bold ph-fork-knife"></i> Abrir cuenta con pedido'
      : '<i class="ph-bold ph-door-open"></i> Abrir mesa';
    $('#posTableOpenModal').classList.add('show');
    setTimeout(() => $('#posTableWaiterName')?.focus(), 40);
  }));
}

function openPosTablesModal({ chatbotOrderId = null } = {}) {
  if (!POS_OVERVIEW?.activeSession) return toast('Abre una caja antes de operar mesas', true);
  POS_CHATBOT_TABLE_ORDER_ID = Number.isInteger(Number(chatbotOrderId)) && Number(chatbotOrderId) > 0
    ? Number(chatbotOrderId)
    : null;
  renderPosTablesLayout();
  $('#posTablesModal').classList.add('show');
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
  const tables = Array.isArray(POS_OVERVIEW?.tables) ? POS_OVERVIEW.tables : [];
  const openTables = tables.filter((table) => table.account).length;
  el.innerHTML = `
    <button type="button" class="pos-action-btn" id="posOpenTables" ${hasSession ? '' : 'disabled'}>
      <i class="ph-bold ph-fork-knife"></i> Mesas${openTables ? ` (${openTables})` : ''}
    </button>
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
  $('#posOpenTables')?.addEventListener('click', openPosTablesModal);
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
    const openSessions = Array.isArray(POS_OVERVIEW?.openSessions) ? POS_OVERVIEW.openSessions : [];
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

    const openSessionsHtml = !isCashierUser() && openSessions.length
      ? `<div style="margin-bottom:20px">
          <h3><i class="ph-bold ph-monitor"></i> Cajas abiertas en sucursales</h3>
          <p class="hint" style="margin:-8px 0 12px">Selecciona una caja para administrarla, registrar movimientos o realizar su cierre.</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px">
            ${openSessions.map((openSession) => `
              <div style="border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--surface)">
                <b><i class="ph-bold ph-storefront"></i> ${esc(openSession.branch_name || 'Sucursal general')}</b>
                <div class="hint" style="margin:5px 0 10px">Abierta por ${esc(openSession.opened_by || '—')} · ${esc(openSession.opened_at || '')}</div>
                ${openSession.branch_id ? `<button type="button" class="btn btn-primary" data-manage-pos-branch="${esc(String(openSession.branch_id))}"><i class="ph-bold ph-arrow-square-in"></i> Administrar caja</button>` : ''}
              </div>`).join('')}
          </div>
        </div>`
      : '';

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
      ${openSessionsHtml}
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
    el.querySelectorAll('[data-manage-pos-branch]').forEach((button) => button.addEventListener('click', async () => {
      setManagedPosBranchId(Number(button.dataset.managePosBranch));
      await loadPos();
      toast('Caja seleccionada para administración');
    }));
    $('#posOpenForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        setManagedPosBranchId(null);
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
  const openSessions = Array.isArray(POS_OVERVIEW?.openSessions) ? POS_OVERVIEW.openSessions : [];
  const branchSessionOptions = !isCashierUser()
    ? openSessions.filter((openSession) => openSession.branch_id).map((openSession) => `
        <option value="${esc(String(openSession.branch_id))}" ${Number(openSession.branch_id) === Number(session.branch_id) ? 'selected' : ''}>
          ${esc(openSession.branch_name || 'Sucursal')} · ${esc(openSession.opened_by || 'sin usuario')}
        </option>`).join('')
    : '';
  el.style.display = 'block';
  el.innerHTML = `
    <div class="pos-session-active">
      <h3><i class="ph-bold ph-storefront"></i> Caja activa</h3>
      <div class="hint">${session.branch_name ? `Sucursal: ${esc(session.branch_name)}` : 'Sucursal general'} · Abierta por ${esc(session.opened_by || '—')}</div>
      ${branchSessionOptions ? `
        <div class="field" style="max-width:460px;margin-top:12px">
          <label><i class="ph-bold ph-arrows-left-right"></i> Administrar otra caja abierta</label>
          <select id="posManagedBranchSelect">${branchSessionOptions}</select>
        </div>` : ''}
    </div>`;
  $('#posManagedBranchSelect')?.addEventListener('change', async (event) => {
    setManagedPosBranchId(Number(event.target.value));
    await loadPos();
    toast('Caja seleccionada para administración');
  });
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
  const tableAccount = POS_TABLE_ACCOUNT;
  const tableNumber = tableAccount?.table_number || tableAccount?.tableNumber;
  const tableRounds = Array.isArray(tableAccount?.rounds) ? tableAccount.rounds : [];
  const roundHistoryHtml = tableAccount && tableRounds.length ? `
    <div class="pos-rounds-list">
      ${tableRounds.map((round) => `
        <div class="pos-round-card">
          <div class="pos-round-head"><b>Ronda ${round.roundNumber}</b><span>${fmtMoney(round.subtotal || 0)}</span></div>
          <div class="pos-round-items">${(round.items || []).map((item) => `<span>${Number(item.qty || 1)}× ${esc(item.name || 'Producto')}</span>`).join('')}</div>
          <div class="pos-round-foot"><small>${esc(round.createdAt || '')}</small><div>${POS_OVERVIEW?.policy?.roundEditEnabled ? `<button type="button" class="btn btn-ghost btn-icon" data-edit-table-round="${round.id}" title="Corregir ronda"><i class="ph-bold ph-pencil-simple"></i></button>` : ''}<button type="button" class="btn btn-ghost btn-icon" data-print-table-round="${round.id}" title="Reimprimir ronda"><i class="ph-bold ph-printer"></i></button></div></div>
        </div>`).join('')}
    </div>` : (tableAccount ? '<div class="hint" style="margin-bottom:10px">Aún no se ha enviado ninguna ronda.</div>' : '');
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
  const cartHtml = POS_CART.length || Number(tableAccount?.total || 0) > 0
    ? `${roundHistoryHtml}
      ${tableAccount ? `<div class="pos-current-round"><b><i class="ph-bold ph-plus-circle"></i> ${POS_CART.length ? `Nueva ronda ${tableRounds.length + 1}` : 'Sin ronda pendiente'}</b><small>${POS_CART.length ? `${POS_CART.reduce((sum, item) => sum + Number(item.qty || 0), 0)} producto(s) por enviar` : 'Agrega productos para iniciar la siguiente ronda.'}</small></div>` : ''}
      <div class="pos-cart-list">
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
        ${tableAccount ? '' : `<div class="toggle-row pos-delivery-toggle">
          <div class="t-info"><i class="ph-bold ph-moped"></i><div><b>Entrega a domicilio</b><span>Cobra envío y registra el pedido como domicilio</span></div></div>
          <label class="switch"><input type="checkbox" id="posDeliveryToggle" ${POS_IS_DELIVERY ? 'checked' : ''} /><span class="track"></span></label>
        </div>`}
        ${POS_IS_DELIVERY ? `<div class="field">
          <label><i class="ph-bold ph-currency-circle-dollar"></i> Costo de envío</label>
          <input type="number" id="posDeliveryFee" step="0.01" min="0" value="${esc(String(POS_DELIVERY_FEE || ''))}" placeholder="0.00" />
          <div class="hint">Se suma al total y suma al turno en el rubro domicilios.</div>
        </div>
        <div class="field">
          <label><i class="ph-bold ph-map-pin"></i> Domicilio *</label>
          <textarea id="posDeliveryAddress" rows="2" maxlength="300" required placeholder="Calle, número exterior/interior">${esc(POS_PAYMENT_FORM.deliveryAddress || '')}</textarea>
        </div>
        <div class="field">
          <label><i class="ph-bold ph-map-trifold"></i> Colonia / barrio / sector *</label>
          <input id="posDeliveryNeighborhood" maxlength="160" required value="${esc(POS_PAYMENT_FORM.deliveryNeighborhood || '')}" placeholder="Nombre de la colonia o barrio" />
        </div>
        <div class="field">
          <label><i class="ph-bold ph-signpost"></i> Referencias de entrega</label>
          <textarea id="posDeliveryReference" rows="2" maxlength="240" placeholder="Color de casa, portón, esquina, negocio cercano...">${esc(POS_PAYMENT_FORM.deliveryReference || '')}</textarea>
        </div>` : ''}
        <div class="field">
          <label><i class="ph-bold ph-note"></i> ${tableAccount ? 'Nota de la ronda' : 'Nota de venta'}</label>
          <textarea id="posSaleNotes" rows="2" placeholder="${tableAccount ? 'Ej. Sin cebolla, término medio...' : POS_IS_DELIVERY ? 'Indicaciones de preparación: sin cebolla, salsa aparte...' : 'Mesa 4, venta rápida, pedido interno...'}">${esc(POS_PAYMENT_FORM.notes || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" type="submit" ${submitDisabled}><i class="ph-bold ph-check-circle"></i> ${tableAccount ? 'Cerrar y cobrar cuenta' : 'Cobrar venta'}</button>
          ${tableAccount ? `<button class="btn btn-ghost" type="button" id="posSaveTable" ${POS_CART.length ? '' : 'disabled'}><i class="ph-bold ph-paper-plane-tilt"></i> Enviar ronda e imprimir</button>` : ''}
          <button class="btn btn-ghost" type="button" id="posClearCart"><i class="ph-bold ${tableAccount ? 'ph-arrow-left' : 'ph-broom'}"></i> ${tableAccount ? 'Salir de mesa' : 'Vaciar ticket'}</button>
          ${tableAccount ? '' : '<button class="btn btn-ghost" type="button" id="posPrintTicket"><i class="ph-bold ph-printer"></i> Imprimir ticket</button>'}
        </div>
        ${sessionHint}
      </form>`
    : `${roundHistoryHtml}${emptyHTML('ph-shopping-cart', tableAccount ? `Mesa ${tableNumber} sin productos` : 'Sin productos en el ticket', 'Toca productos del catálogo para agregar la primera ronda.')}`;
  const tableContext = tableAccount ? `
    <div class="pos-table-context">
      <div class="pos-table-context-head">
        <div><b><i class="ph-bold ph-fork-knife"></i> Mesa ${esc(String(tableNumber || ''))}${tableAccount.customer_name ? ` · ${esc(tableAccount.customer_name)}` : ''}</b><small>${tableAccount.customer_phone ? `Cliente: ${esc(tableAccount.customer_phone)} · ` : ''}Mesero: ${esc(tableAccount.waiter_name || '—')} · La cuenta se acumula hasta cobrarla.</small></div>
        <button class="btn btn-ghost btn-icon" type="button" id="posExitTable" title="Salir de la mesa"><i class="ph-bold ph-x"></i></button>
      </div>
    </div>` : '';
  el.innerHTML = `
    <h3><i class="ph-bold ${tableAccount ? 'ph-fork-knife' : 'ph-shopping-cart'}"></i> ${tableAccount ? `Cuenta mesa ${esc(String(tableNumber || ''))}` : 'Ticket actual'}</h3>
    ${tableContext}
    ${cartHtml}`;

  document.querySelectorAll('.pos-dec-btn').forEach((button) => button.addEventListener('click', () => updatePosQty(button.dataset.pid, -1, button.dataset.cartKey || null)));
  document.querySelectorAll('.pos-inc-btn').forEach((button) => button.addEventListener('click', () => updatePosQty(button.dataset.pid, 1, button.dataset.cartKey || null)));
  document.querySelectorAll('[data-print-table-round]').forEach((button) => button.addEventListener('click', () => {
    const round = tableRounds.find((item) => Number(item.id) === Number(button.dataset.printTableRound));
    printTableRoundTicket(round, tableAccount, tableAccount.total);
  }));
  document.querySelectorAll('[data-edit-table-round]').forEach((button) => button.addEventListener('click', () => openPosRoundEditModal(button.dataset.editTableRound)));
  document.querySelectorAll('[data-pos-method]').forEach((button) =>
    button.addEventListener('click', () => {
      POS_PAYMENT_METHOD = button.dataset.posMethod;
      if (POS_PAYMENT_METHOD === 'cash' && (POS_PAYMENT_FORM.cashReceived === '' || POS_PAYMENT_FORM.cashReceived === null)) {
        POS_PAYMENT_FORM.cashReceived = String(total || '');
      }
      renderPosCart();
    })
  );
  $('#posClearCart')?.addEventListener('click', tableAccount ? exitPosTableAccount : clearPosCart);
  $('#posExitTable')?.addEventListener('click', exitPosTableAccount);
  $('#posSaveTable')?.addEventListener('click', () => sendActiveTableRound().catch((err) => toast(err.message, true)));
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
  $('#posDeliveryAddress')?.addEventListener('input', (e) => (POS_PAYMENT_FORM.deliveryAddress = e.target.value));
  $('#posDeliveryNeighborhood')?.addEventListener('input', (e) => (POS_PAYMENT_FORM.deliveryNeighborhood = e.target.value));
  $('#posDeliveryReference')?.addEventListener('input', (e) => (POS_PAYMENT_FORM.deliveryReference = e.target.value));
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
        deliveryAddress: POS_IS_DELIVERY ? ($('#posDeliveryAddress')?.value || '') : '',
        deliveryNeighborhood: POS_IS_DELIVERY ? ($('#posDeliveryNeighborhood')?.value || '') : '',
        deliveryReference: POS_IS_DELIVERY ? ($('#posDeliveryReference')?.value || '') : '',
      };
      if (!tableAccount) payload.items = posCartPayload();
      let checkoutAccount = tableAccount;
      if (tableAccount && POS_CART.length) {
        const roundResult = await sendActiveTableRound({ silent: true });
        checkoutAccount = roundResult.account;
      }
      const endpoint = checkoutAccount ? `/api/pos/table-accounts/${checkoutAccount.id}/checkout` : '/api/pos/sales';
      const result = await api(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      LAST_POS_SALE = result?.sale || null;
      toast(checkoutAccount ? `Cuenta de mesa ${tableNumber} cerrada` : 'Venta registrada en punto de venta');
      POS_TABLE_ACCOUNT = null;
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
  return businessIsoDate();
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
                ${POS_OVERVIEW?.policy?.sameDayCancelEnabled ? `<button type="button" class="btn btn-danger" data-cancel-pos-sale="${row.id}" ${isCanceled ? 'disabled' : ''}><i class="ph-bold ph-x-circle"></i> Cancelar</button>` : ''}
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
  return buildOrderDeliveryLabel(order);
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
        const isDineIn = order.delivery === 'comer_sucursal';
        const locationText = [order.delivery_address, order.delivery_neighborhood, order.delivery_reference].filter(Boolean).join(' · ') || order.customer_location_text || order.customer_location_resolved || '—';
        const noteText = String(order.notes || '').trim();
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
            ${noteText ? `<div class="order-note-callout" style="grid-column:1/-1"><span><i class="ph-fill ph-warning-circle"></i> Nota del pedido</span><b>${esc(noteText)}</b></div>` : ''}
          </div>
          <button type="button" class="btn-pos-charge" data-import-chatbot-order="${order.id}" ${isImporting ? 'disabled' : ''}><i class="ph-bold ${isDineIn ? 'ph-fork-knife' : 'ph-cash-register'}"></i> ${isImporting ? 'Procesando...' : (isDineIn ? 'Abrir en mesa' : 'Cobrar en POS')}</button>
        </article>`;
      })
      .join('')}</div>`;
  } else {
    table.innerHTML = `<table class="pos-chatbot-table" style="width:1580px;min-width:1580px;table-layout:fixed"><thead><tr><th class="th-pedido">Pedido</th><th class="th-action">Acción</th><th class="th-cliente">Cliente</th><th class="th-productos">Productos</th><th class="th-entrega">Entrega</th><th class="th-pago">Pago</th><th class="th-total">Total</th><th class="th-estado">Estado</th><th class="th-fecha">Fecha</th><th class="th-cobro">Cobro</th></tr></thead><tbody>${POS_CHATBOT_QUEUE
      .map((order) => {
        const items = (order.items || []).map((it) => `${it.qty}x ${it.name}`).join(', ');
        const isImporting = POS_CHATBOT_IMPORTING.has(Number(order.id));
        const isDineIn = order.delivery === 'comer_sucursal';
        const deliveryLocation = [order.delivery_address, order.delivery_neighborhood, order.delivery_reference].filter(Boolean).join(' · ') || order.customer_location_text || order.customer_location_resolved || '';
        const locationLine = deliveryLocation ? `<div style="font-size:12px;color:var(--ink-3)">${esc(deliveryLocation)}</div>` : '';
        const noteLine = order.notes
          ? `<div class="order-note-callout"><span><i class="ph-fill ph-warning-circle"></i> Nota del pedido</span><b>${esc(order.notes)}</b></div>`
          : '';
        return `<tr>
          <td class="td-pedido"><b>#${order.id}</b></td>
          <td class="td-action"><button type="button" class="btn-pos-charge" data-import-chatbot-order="${order.id}" ${isImporting ? 'disabled' : ''}><i class="ph-bold ${isDineIn ? 'ph-fork-knife' : 'ph-cash-register'}"></i> ${isImporting ? 'Procesando...' : (isDineIn ? 'Abrir en mesa' : 'Cobrar en POS')}</button></td>
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
  const queueOrder = POS_CHATBOT_QUEUE.find((order) => Number(order.id) === id);
  if (queueOrder?.delivery === 'comer_sucursal') {
    const availableTables = (POS_OVERVIEW?.tables || []).filter((table) => !table.account);
    if (!availableTables.length) return toast('No hay mesas libres para abrir este pedido', true);
    $('#posChatbotQueueModal')?.classList.remove('show');
    openPosTablesModal({ chatbotOrderId: id });
    toast(`Selecciona la mesa para el pedido #${id}`);
    return;
  }
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
      delivery: sale.delivery || '',
      deliveryAddress: sale.delivery_address || '',
      deliveryNeighborhood: sale.delivery_neighborhood || '',
      deliveryReference: sale.delivery_reference || '',
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
    hint.innerHTML = `
      <div class="pos-last-close-inner">
        <div class="pos-last-close-icon"><i class="ph-bold ph-clock-counter-clockwise"></i></div>
        <div class="pos-last-close-details">
          <div class="pos-last-close-top">
            <span class="pos-last-close-date">Sin cierres anteriores registrados</span>
          </div>
          <div class="pos-last-close-notes">Este será el primer corte de caja registrado para este periodo o dispositivo.</div>
        </div>
      </div>
    `;
    return;
  }
  const diff = Number(last.difference_amount || 0);
  const isExact = Math.abs(diff) < 0.005;
  const isSurplus = diff > 0;
  const diffClass = isExact ? 'badge-exact' : isSurplus ? 'badge-surplus' : 'badge-shortage';
  const diffText = isExact ? 'Cuadre exacto ($0.00)' : isSurplus ? `+${fmtMoney(diff)} (Sobrante)` : `-${fmtMoney(Math.abs(diff))} (Faltante)`;

  hint.innerHTML = `
    <div class="pos-last-close-inner">
      <div class="pos-last-close-icon"><i class="ph-bold ph-clock-counter-clockwise"></i></div>
      <div class="pos-last-close-details">
        <div class="pos-last-close-top">
          <b>Último cierre:</b>
          <span class="pos-last-close-date">${esc(fmtBusinessDateTime(last.closed_at) || last.closed_at || '—')}</span>
          <span class="pos-last-close-diff-tag ${diffClass}">${diffText}</span>
        </div>
        <div class="pos-last-close-notes">
          <i class="ph-bold ph-chat-text"></i> ${esc(last.notes || 'Cierre registrado sin observaciones.')} · Cajero: <b>${esc(last.closed_by || '—')}</b>
        </div>
      </div>
    </div>
  `;
}

function updatePosCloseDifference() {
  const session = POS_OVERVIEW?.activeSession;
  if (!session) return;
  const expected = moneyNum(session.expectedCash || 0);
  const inputEl = $('#posClosingAmountModal');
  const rawVal = inputEl?.value?.trim();
  const counted = (rawVal === '' || rawVal === undefined || isNaN(Number(rawVal))) ? 0 : moneyNum(Number(rawVal));
  const diff = moneyNum(counted - expected);

  const diffCard = $('#posCloseDiffCard');
  const iconWrap = $('#posCloseDiffIcon');
  const badgeEl = $('#posCloseDiffBadge');
  const amountEl = $('#posCloseDiffAmount');
  const descEl = $('#posCloseDiffDesc');

  if (!diffCard || !iconWrap || !badgeEl || !amountEl || !descEl) return;

  diffCard.classList.remove('status-exact', 'status-surplus', 'status-shortage');

  if (Math.abs(diff) < 0.005) {
    diffCard.classList.add('status-exact');
    iconWrap.innerHTML = '<i class="ph-fill ph-check-circle"></i>';
    badgeEl.textContent = 'Caja Cuadrada Exacta';
    amountEl.textContent = fmtMoney(0);
    descEl.textContent = `El efectivo contado coincide al 100% con el monto esperado en sistema (${fmtMoney(expected)}).`;
  } else if (diff > 0) {
    diffCard.classList.add('status-surplus');
    iconWrap.innerHTML = '<i class="ph-fill ph-arrow-circle-up-right"></i>';
    badgeEl.textContent = 'Sobrante en Caja';
    amountEl.textContent = `+${fmtMoney(diff)}`;
    descEl.textContent = `Hay un sobrante de +${fmtMoney(diff)} por encima del efectivo esperado (${fmtMoney(expected)}).`;
  } else {
    diffCard.classList.add('status-shortage');
    iconWrap.innerHTML = '<i class="ph-fill ph-warning-circle"></i>';
    badgeEl.textContent = 'Faltante en Caja';
    amountEl.textContent = `-${fmtMoney(Math.abs(diff))}`;
    descEl.textContent = `Faltan -${fmtMoney(Math.abs(diff))} para completar el efectivo esperado de ${fmtMoney(expected)}.`;
  }
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
  const tableSummary = totals.tables || { closedCount: 0, closedTotal: 0, openCount: 0, openTotal: 0, closed: [], open: [] };
  const expectedCash = moneyNum(session.expectedCash || 0);

  const subtitleEl = $('#posCloseSubtitle');
  if (subtitleEl) {
    subtitleEl.innerHTML = `
      <span class="pos-meta-chip"><i class="ph-bold ph-user"></i> ${esc(session.opened_by || 'Cajero')}</span>
      <span class="pos-meta-chip"><i class="ph-bold ph-clock"></i> ${esc(fmtBusinessDateTime(session.opened_at) || 'Turno activo')}</span>
      <span class="pos-meta-chip"><i class="ph-bold ph-vault"></i> Fondo inicial: ${fmtMoney(session.opening_amount || 0)}</span>
    `;
  }

  const expectedDisplay = $('#posCloseExpectedDisplay');
  if (expectedDisplay) expectedDisplay.textContent = fmtMoney(expectedCash);

  $('#posCloseSummary').innerHTML = `
    <div class="pos-close-groups">
      <div class="pos-close-group neutral">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-chart-pie-slice"></i></span>
            <span>Resumen General del Turno</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-ink"><span>Fondo inicial</span><b>${fmtMoney(session.opening_amount || 0)}</b></div>
          <div class="pos-mini-stat tone-blue"><span>Ventas totales</span><b>${fmtMoney(totals.totalSales || 0)}</b></div>
          <div class="pos-mini-stat tone-green"><span>Efectivo esperado</span><b>${fmtMoney(expectedCash)}</b></div>
          <div class="pos-mini-stat tone-violet"><span>Tickets emitidos</span><b>${Number(totals.tickets || 0)}</b></div>
        </div>
      </div>

      <div class="pos-close-group payment">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-credit-card"></i></span>
            <span>Ventas por Medio de Pago</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-green"><span>Efectivo</span><b>${fmtMoney(totals.salesByMethod?.cash || 0)}</b></div>
          <div class="pos-mini-stat tone-violet"><span>Tarjeta</span><b>${fmtMoney(totals.salesByMethod?.card || 0)}</b></div>
          <div class="pos-mini-stat tone-cyan"><span>Transferencia</span><b>${fmtMoney(totals.salesByMethod?.transfer || 0)}</b></div>
          <div class="pos-mini-stat tone-amber"><span>Mixto</span><b>${fmtMoney(totals.salesByMethod?.mixed || 0)}</b></div>
        </div>
      </div>

      <div class="pos-close-group income">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-trend-up"></i></span>
            <span>Entradas de Efectivo</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-green"><span>Ingreso manual</span><b>${fmtMoney(totals.movements.income || 0)}</b></div>
          <div class="pos-mini-stat tone-blue"><span>Cobrado en efec.</span><b>${fmtMoney(totals.collected?.cash || 0)}</b></div>
        </div>
      </div>

      <div class="pos-close-group outflow">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-arrow-bend-up-left"></i></span>
            <span>Salidas y Gastos</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-amber"><span>Retiros</span><b>${fmtMoney(totals.movements.withdrawal || 0)}</b></div>
          <div class="pos-mini-stat tone-red"><span>Gastos</span><b>${fmtMoney(totals.movements.expense || 0)}</b></div>
        </div>
      </div>

      ${(delivery.tickets || delivery.total) ? `
      <div class="pos-close-group delivery">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-moped"></i></span>
            <span>Servicio a Domicilio</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-cyan"><span>Pedidos domicilio</span><b>${Number(delivery.tickets || 0)}</b></div>
          <div class="pos-mini-stat tone-blue"><span>Total ventas</span><b>${fmtMoney(delivery.total || 0)}</b></div>
          <div class="pos-mini-stat tone-green"><span>Costo de envíos</span><b>${fmtMoney(delivery.fees || 0)}</b></div>
          <div class="pos-mini-stat tone-ink"><span>Cobrado efectivo</span><b>${fmtMoney(totals.collected?.cash || 0)}</b></div>
        </div>
      </div>` : ''}

      ${(tableSummary.closedCount || tableSummary.openCount) ? `
      <div class="pos-close-group tables">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-fork-knife"></i></span>
            <span>Mesas del Restaurante</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-green"><span>Mesas cerradas</span><b>${Number(tableSummary.closedCount || 0)}</b></div>
          <div class="pos-mini-stat tone-blue"><span>Total cerradas</span><b>${fmtMoney(tableSummary.closedTotal || 0)}</b></div>
          <div class="pos-mini-stat ${tableSummary.openCount ? 'tone-red' : 'tone-ink'}"><span>Mesas abiertas</span><b>${Number(tableSummary.openCount || 0)}</b></div>
          <div class="pos-mini-stat tone-amber"><span>Consumo abierto</span><b>${fmtMoney(tableSummary.openTotal || 0)}</b></div>
        </div>
        ${tableSummary.openCount ? `<div class="hint" style="margin-top:8px;color:var(--red)"><i class="ph-bold ph-warning"></i> Cuentas abiertas: ${tableSummary.open.map((row) => `Mesa ${esc(String(row.table_number))} (${esc(row.waiter_name || 'sin mesero')})`).join(', ')}.</div>` : ''}
      </div>` : ''}

      ${(totals.cancellations?.tickets || totals.cancellations?.total) ? `
      <div class="pos-close-group cancel">
        <div class="pos-close-group-head">
          <div class="pos-close-group-title">
            <span class="pos-close-group-icon"><i class="ph-bold ph-x-circle"></i></span>
            <span>Cancelaciones</span>
          </div>
        </div>
        <div class="pos-close-grid">
          <div class="pos-mini-stat tone-red"><span>Tickets cancelados</span><b>${Number(totals.cancellations.tickets || 0)}</b></div>
          <div class="pos-mini-stat tone-red"><span>Total cancelado</span><b>${fmtMoney(totals.cancellations.total || 0)}</b></div>
        </div>
      </div>` : ''}
    </div>
  `;

  const closingInput = $('#posClosingAmountModal');
  if (closingInput) {
    closingInput.value = expectedCash;
  }
  $('#posClosingNoteModal').value = '';
  updatePosCloseDifference();
  renderLastCloseHint();
  $('#posCloseModal').classList.add('show');

  setTimeout(() => {
    closingInput?.focus();
    closingInput?.select();
  }, 100);
}

$('#posClosingAmountModal')?.addEventListener('input', updatePosCloseDifference);
$('#posClosingAmountModal')?.addEventListener('change', updatePosCloseDifference);
$('#posCloseCopyExpectedBtn')?.addEventListener('click', () => {
  const session = POS_OVERVIEW?.activeSession;
  if (!session) return;
  const expected = moneyNum(session.expectedCash || 0);
  const input = $('#posClosingAmountModal');
  if (input) {
    input.value = expected;
    updatePosCloseDifference();
    input.focus();
    input.select();
  }
});
$('#posCloseTopClose')?.addEventListener('click', () => $('#posCloseModal').classList.remove('show'));

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
$('#posTablesClose')?.addEventListener('click', () => {
  $('#posTablesModal').classList.remove('show');
  POS_CHATBOT_TABLE_ORDER_ID = null;
});
$('#posTableOpenCancel')?.addEventListener('click', () => $('#posTableOpenModal').classList.remove('show'));
$('#posTableOpenForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const chatbotOrderId = POS_CHATBOT_TABLE_ORDER_ID;
  try {
    const tableId = Number($('#posTableOpenId')?.value || 0);
    const waiterName = $('#posTableWaiterName')?.value || '';
    if (chatbotOrderId) POS_CHATBOT_IMPORTING.add(chatbotOrderId);
    const result = await api(chatbotOrderId
      ? `/api/pos/chatbot-orders/${chatbotOrderId}/import`
      : `/api/pos/tables/${tableId}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatbotOrderId ? { tableId, waiterName } : { waiterName }),
    });
    $('#posTableOpenModal').classList.remove('show');
    $('#posTablesModal').classList.remove('show');
    POS_CHATBOT_TABLE_ORDER_ID = null;
    await loadPos();
    selectPosTableAccount(result.account);
    if (chatbotOrderId) {
      toast(`Pedido #${chatbotOrderId} abierto en mesa ${result.account?.table_number || ''}`);
      await loadPosChatbotQueue(POS_CHATBOT_PAGE);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (chatbotOrderId) POS_CHATBOT_IMPORTING.delete(chatbotOrderId);
  }
});
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
$('#posRoundEditCancel')?.addEventListener('click', () => $('#posRoundEditModal').classList.remove('show'));
$('#posRoundEditForm')?.addEventListener('submit', (event) => {
  event.preventDefault();
  submitPosRoundEdit().catch((error) => toast(error.message, true));
});

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
    POS_TABLE_ACCOUNT = null;
    clearPosCart();
    setManagedPosBranchId(null);
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

[$('#prodModal'), $('#aiProductModal'), $('#catModal'), $('#confirmModal'), $('#branchModal'), $('#cashierModal'), $('#posTablesModal'), $('#posTableOpenModal'), $('#posMovementModal'), $('#posCloseModal'), $('#posSalesHistoryModal'), $('#posPaymentEditModal'), $('#orderCancelReasonModal'), $('#posProductConfigModal')].forEach((m) =>
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
  CHATBOT_SUBTAB = ['delivery', 'upsell', 'tables'].includes(tab) ? tab : 'flow';
  const isDelivery = CHATBOT_SUBTAB === 'delivery';
  const isUpsell = CHATBOT_SUBTAB === 'upsell';
  const isTables = CHATBOT_SUBTAB === 'tables';
  $('#chatbotTabFlow')?.classList.toggle('active', CHATBOT_SUBTAB === 'flow');
  $('#chatbotTabDelivery')?.classList.toggle('active', isDelivery);
  $('#chatbotTabUpsell')?.classList.toggle('active', isUpsell);
  $('#chatbotTabTables')?.classList.toggle('active', isTables);
  $('#chatbotFlowPanel').hidden = CHATBOT_SUBTAB !== 'flow';
  $('#chatbotDeliveryPanel').hidden = !isDelivery;
  $('#chatbotUpsellPanel').hidden = !isUpsell;
  $('#chatbotTablesPanel').hidden = !isTables;
  if (isDelivery) {
    ensureDeliveryZoneMap();
    setTimeout(() => {
      DELIVERY_ZONE_MAP?.invalidateSize();
      fitDeliveryZonesBounds();
    }, 80);
  }
  if (isTables) loadTablesConfig().catch((err) => toast(err.message, true));
}

function currentTablesConfigBranch() {
  return Number($('#tablesConfigBranch')?.value || 0);
}

function tablesForConfigBranch() {
  const branchId = currentTablesConfigBranch();
  return TABLES_CONFIG.filter((table) => Number(table.branchId || 0) === branchId);
}

async function loadTablesConfig() {
  const data = await api('/api/pos/tables/config');
  TABLES_CONFIG = Array.isArray(data.tables) ? data.tables : [];
  TABLES_CONFIG_BRANCHES = Array.isArray(data.branches) ? data.branches : [];
  const select = $('#tablesConfigBranch');
  if (select) {
    const current = String(select.value || '0');
    select.innerHTML = ['<option value="0">Todas / general</option>', ...TABLES_CONFIG_BRANCHES.map((branch) => `<option value="${branch.id}">${esc(branch.name)}</option>`)].join('');
    select.value = TABLES_CONFIG_BRANCHES.some((branch) => String(branch.id) === current) ? current : '0';
  }
  renderTablesConfig();
}

function createTableConfigDraft(tableNumber, branchId, index = 0, total = 1) {
  const columns = Math.max(2, Math.ceil(Math.sqrt(total)));
  const row = Math.floor(index / columns);
  const col = index % columns;
  const rows = Math.max(1, Math.ceil(total / columns));
  return {
    id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    tableNumber,
    label: `Mesa ${tableNumber}`,
    branchId,
    positionX: Math.round(10 + (col * 80) / Math.max(1, columns - 1)),
    positionY: Math.round(12 + (row * 76) / Math.max(1, rows - 1)),
    shape: 'round',
    enabled: true,
  };
}

function renderTablesConfig() {
  renderTablesConfigLayout();
  renderTablesConfigList();
}

function renderTablesConfigLayout() {
  const host = $('#tablesConfigLayout');
  if (!host) return;
  const tables = tablesForConfigBranch();
  host.innerHTML = tables.length ? tables.map((table) => `
    <button type="button" class="table-config-node ${esc(table.shape || 'round')} ${table.enabled ? '' : 'disabled'} ${String(TABLES_CONFIG_SELECTED_ID) === String(table.id) ? 'selected' : ''}"
      data-table-config-node="${esc(String(table.id))}" style="--x:${Number(table.positionX || 50)}%;--y:${Number(table.positionY || 50)}%">
      <b>${esc(table.label || `Mesa ${table.tableNumber}`)}</b><small>#${table.tableNumber} · ${table.enabled ? 'Habilitada' : 'Deshabilitada'}</small>
    </button>`).join('') : emptyHTML('ph-fork-knife', 'Sin mesas en esta sucursal', 'Genera la cantidad de mesas que utiliza el restaurante.');
  host.querySelectorAll('[data-table-config-node]').forEach((node) => {
    const id = node.dataset.tableConfigNode;
    let moved = false;
    node.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      moved = false;
      node.setPointerCapture(event.pointerId);
      node.classList.add('dragging');
    });
    node.addEventListener('pointermove', (event) => {
      if (!node.hasPointerCapture(event.pointerId)) return;
      const rect = host.getBoundingClientRect();
      const x = Math.max(5, Math.min(95, ((event.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(7, Math.min(93, ((event.clientY - rect.top) / rect.height) * 100));
      const table = TABLES_CONFIG.find((item) => String(item.id) === id);
      if (!table) return;
      table.positionX = Math.round(x);
      table.positionY = Math.round(y);
      node.style.setProperty('--x', `${table.positionX}%`);
      node.style.setProperty('--y', `${table.positionY}%`);
      moved = true;
    });
    node.addEventListener('pointerup', (event) => {
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      node.classList.remove('dragging');
      TABLES_CONFIG_SELECTED_ID = id;
      if (!moved) renderTablesConfig();
    });
  });
}

function renderTablesConfigList() {
  const host = $('#tablesConfigList');
  if (!host) return;
  const tables = tablesForConfigBranch();
  const enabled = tables.filter((table) => table.enabled).length;
  $('#tablesConfigSummary').textContent = `${tables.length} mesas · ${enabled} habilitadas`;
  $('#tablesConfigCount').value = String(enabled || 1);
  host.innerHTML = tables.length ? `<table><thead><tr><th>Mesa</th><th>Nombre visible</th><th>Forma</th><th>Mostrar en POS</th><th></th></tr></thead><tbody>${tables.map((table) => `
    <tr data-table-config-row="${esc(String(table.id))}">
      <td><input type="number" min="1" max="999" value="${table.tableNumber}" data-table-field="number" style="width:84px" /></td>
      <td><input type="text" maxlength="40" value="${esc(table.label || '')}" data-table-field="label" /></td>
      <td><select data-table-field="shape"><option value="round" ${table.shape === 'round' ? 'selected' : ''}>Redonda</option><option value="square" ${table.shape === 'square' ? 'selected' : ''}>Cuadrada</option><option value="rectangle" ${table.shape === 'rectangle' ? 'selected' : ''}>Rectangular</option></select></td>
      <td><label class="switch"><input type="checkbox" data-table-field="enabled" ${table.enabled ? 'checked' : ''} /><span class="track"></span></label></td>
      <td style="text-align:right"><button class="btn btn-danger btn-icon" type="button" data-table-delete="${esc(String(table.id))}" title="Eliminar"><i class="ph-bold ph-trash"></i></button></td>
    </tr>`).join('')}</tbody></table>` : emptyHTML('ph-list-numbers', 'Sin mesas', 'Usa Generar mesas para comenzar.');
  host.querySelectorAll('[data-table-config-row]').forEach((row) => {
    const table = TABLES_CONFIG.find((item) => String(item.id) === row.dataset.tableConfigRow);
    if (!table) return;
    row.querySelector('[data-table-field="number"]').addEventListener('input', (event) => { table.tableNumber = Number(event.target.value || 0); renderTablesConfigLayout(); });
    row.querySelector('[data-table-field="label"]').addEventListener('input', (event) => { table.label = event.target.value; renderTablesConfigLayout(); });
    row.querySelector('[data-table-field="shape"]').addEventListener('change', (event) => { table.shape = event.target.value; renderTablesConfigLayout(); });
    row.querySelector('[data-table-field="enabled"]').addEventListener('change', (event) => { table.enabled = event.target.checked; renderTablesConfigLayout(); $('#tablesConfigSummary').textContent = `${tables.length} mesas · ${tables.filter((item) => item.enabled).length} habilitadas`; });
  });
  host.querySelectorAll('[data-table-delete]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.tableDelete;
    const table = TABLES_CONFIG.find((item) => String(item.id) === id);
    if (!table) return;
    if (Number.isInteger(Number(table.id)) && Number(table.id) > 0) {
      try {
        await api(`/api/pos/tables/config/${table.id}`, { method: 'DELETE' });
      } catch (err) {
        return toast(err.message, true);
      }
    }
    TABLES_CONFIG = TABLES_CONFIG.filter((item) => String(item.id) !== id);
    renderTablesConfig();
  }));
}

function generateTablesConfig() {
  const branchId = currentTablesConfigBranch();
  const count = Math.max(1, Math.min(200, Number($('#tablesConfigCount')?.value || 1)));
  const current = tablesForConfigBranch();
  const used = new Set(current.map((table) => Number(table.tableNumber)));
  current.forEach((table, index) => { table.enabled = index < count; });
  if (current.length < count) {
    let next = 1;
    for (let i = current.length; i < count; i += 1) {
      while (used.has(next)) next += 1;
      const draft = createTableConfigDraft(next, branchId, i, count);
      used.add(next);
      TABLES_CONFIG.push(draft);
      next += 1;
    }
  } else if (current.length > count) {
    toast('Las mesas excedentes se conservaron deshabilitadas para no perder su historial');
  }
  renderTablesConfig();
}

async function saveTablesConfig() {
  const tables = TABLES_CONFIG.map((table) => ({
    id: Number.isInteger(Number(table.id)) ? Number(table.id) : null,
    tableNumber: Number(table.tableNumber), label: table.label || '', branchId: Number(table.branchId || 0),
    positionX: Number(table.positionX || 50), positionY: Number(table.positionY || 50), shape: table.shape || 'round', enabled: Boolean(table.enabled),
  }));
  await api('/api/pos/tables/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tables }) });
  toast('Distribución de mesas guardada');
  await loadTablesConfig();
}

function normalizeInfoUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(text)) return `https://${text}`;
  return '';
}

function parseChatbotReceivingModes(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const used = new Set();
    return parsed.slice(0, 10).map((mode, idx) => {
      const label = String(mode?.label || '').trim().replace(/\s+/g, ' ').slice(0, 42);
      const behavior = ['delivery', 'branch', 'simple'].includes(mode?.behavior) ? mode.behavior : 'simple';
      let id = String(mode?.id || `custom_${idx + 1}`).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 36);
      if (!id || ['domicilio', 'recoger', 'comer_sucursal'].includes(id)) id = `custom_${idx + 1}`;
      while (used.has(id)) id = `${id}_${idx + 1}`.slice(0, 36);
      used.add(id);
      return label ? { id, label, behavior, enabled: mode?.enabled !== false } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function receivingModeBehaviorLabel(behavior) {
  if (behavior === 'delivery') return 'Solicita domicilio';
  if (behavior === 'branch') return 'Solicita sucursal';
  return 'Sin datos adicionales';
}

function resetReceivingModeEditor() {
  $('#botReceivingModeId').value = '';
  $('#botReceivingModeLabel').value = '';
  $('#botReceivingModeBehavior').value = 'simple';
  $('#botReceivingModeSaveBtn').innerHTML = '<i class="ph-bold ph-plus-circle"></i> Agregar modalidad';
  $('#botReceivingModeHint').textContent = 'Las modalidades se publican al guardar el flujo.';
}

function setReceivingModeEditor(mode) {
  $('#botReceivingModeId').value = mode.id;
  $('#botReceivingModeLabel').value = mode.label;
  $('#botReceivingModeBehavior').value = mode.behavior;
  $('#botReceivingModeSaveBtn').innerHTML = '<i class="ph-bold ph-floppy-disk"></i> Guardar cambios';
  $('#botReceivingModeHint').textContent = 'Editando modalidad. Guarda el flujo para publicar los cambios.';
}

function renderReceivingModesList() {
  const host = $('#botReceivingModesList');
  if (!host) return;
  if (!CHATBOT_RECEIVING_MODES.length) {
    host.innerHTML = emptyHTML('ph-path', 'Sin modalidades adicionales', 'Las tres modalidades principales se administran con sus interruptores.');
    return;
  }
  host.innerHTML = CHATBOT_RECEIVING_MODES.map((mode) => `
    <div class="chatbot-info-item">
      <div class="meta">
        <div class="label">${esc(mode.label)}</div>
        <div class="message">${esc(receivingModeBehaviorLabel(mode.behavior))} · ${mode.enabled ? 'Activa' : 'Inactiva'}</div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost btn-icon" type="button" data-mode-toggle="${esc(mode.id)}" title="${mode.enabled ? 'Desactivar' : 'Activar'}"><i class="ph-bold ${mode.enabled ? 'ph-toggle-right' : 'ph-toggle-left'}"></i></button>
        <button class="btn btn-ghost btn-icon" type="button" data-mode-edit="${esc(mode.id)}" title="Editar"><i class="ph-bold ph-pencil-simple"></i></button>
        <button class="btn btn-danger btn-icon" type="button" data-mode-del="${esc(mode.id)}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
      </div>
    </div>
  `).join('');
  host.querySelectorAll('[data-mode-toggle]').forEach((button) => button.addEventListener('click', () => {
    const id = String(button.dataset.modeToggle || '');
    CHATBOT_RECEIVING_MODES = CHATBOT_RECEIVING_MODES.map((mode) => mode.id === id ? { ...mode, enabled: !mode.enabled } : mode);
    renderReceivingModesList();
  }));
  host.querySelectorAll('[data-mode-edit]').forEach((button) => button.addEventListener('click', () => {
    const mode = CHATBOT_RECEIVING_MODES.find((item) => item.id === button.dataset.modeEdit);
    if (mode) setReceivingModeEditor(mode);
  }));
  host.querySelectorAll('[data-mode-del]').forEach((button) => button.addEventListener('click', async () => {
    const id = String(button.dataset.modeDel || '');
    const mode = CHATBOT_RECEIVING_MODES.find((item) => item.id === id);
    if (!(await askConfirm('¿Eliminar modalidad?', `Se eliminará “${mode?.label || 'sin nombre'}”.`))) return;
    CHATBOT_RECEIVING_MODES = CHATBOT_RECEIVING_MODES.filter((item) => item.id !== id);
    if ($('#botReceivingModeId').value === id) resetReceivingModeEditor();
    renderReceivingModesList();
  }));
}

function fillReceivingModesFromSettings() {
  CHATBOT_RECEIVING_MODES = parseChatbotReceivingModes(SETTINGS?.chatbot_receiving_modes_json || '[]');
  resetReceivingModeEditor();
  renderReceivingModesList();
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
  $('#chatbotTabTables')?.addEventListener('click', () => setChatbotSubtab('tables'));
  $('#tablesConfigBranch')?.addEventListener('change', renderTablesConfig);
  $('#tablesConfigGenerate')?.addEventListener('click', generateTablesConfig);
  $('#tablesConfigAdd')?.addEventListener('click', () => {
    const branchId = currentTablesConfigBranch();
    const current = tablesForConfigBranch();
    const used = new Set(current.map((table) => Number(table.tableNumber)));
    let next = 1;
    while (used.has(next)) next += 1;
    TABLES_CONFIG.push(createTableConfigDraft(next, branchId, current.length, current.length + 1));
    renderTablesConfig();
  });
  $('#tablesConfigSave')?.addEventListener('click', () => saveTablesConfig().catch((err) => toast(err.message, true)));

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
  $('#botDineIn').checked = SETTINGS.dine_in_enabled !== '0';
  $('#botLocation').checked = SETTINGS.location_enabled !== '0';
  fillChatbotInfoOptionsFromSettings();
  fillReceivingModesFromSettings();
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
let AI_PROMO_IDEAS = [];

function openAiPromoModal() {
  openModal('aiPromoModal');
  if (!AI_PROMO_IDEAS.length) {
    generateAiPromoTexts();
  }
}

async function generateAiPromoTexts() {
  const goal = $('#aiPromoGoal')?.value || 'general';
  const tone = $('#aiPromoTone')?.value || 'friendly';
  const details = ($('#aiPromoDetails')?.value || '').trim();
  const link = $('#chatLink')?.value || (SETTINGS?.slug ? `${location.origin}/${SETTINGS.slug}` : location.origin);

  const btn = $('#aiPromoGenerateBtn');
  const btnText = $('#aiPromoBtnText');
  const resultsContainer = $('#aiPromoResults');
  const regenBtn = $('#aiPromoRegenerateBtn');

  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = 'Generando ideas con IA…';
  if (resultsContainer) {
    resultsContainer.innerHTML = `
      <div class="ai-promo-empty" style="border-style:solid;background:#fff">
        <div class="spinner" style="margin:0 auto 12px"></div>
        <h4>Creando textos personalizados con IA…</h4>
        <p>Redactando copies con emojis y tu liga oficial para WhatsApp, Estados y Redes Sociales.</p>
      </div>`;
  }

  try {
    const res = await api('/api/settings/ai-promo-texts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, tone, details, link }),
    });
    AI_PROMO_IDEAS = res.ideas || [];
    renderAiPromoResults(AI_PROMO_IDEAS);
    if (regenBtn) regenBtn.style.display = 'inline-flex';
  } catch (err) {
    if (resultsContainer) {
      resultsContainer.innerHTML = `
        <div class="ai-promo-empty" style="border-color:#fca5a5;background:#fef2f2">
          <i class="ph-bold ph-warning-circle" style="color:#ef4444"></i>
          <h4>No se pudieron generar los textos</h4>
          <p>${esc(err?.message || 'Ocurrió un error al contactar al generador de IA. Inténtalo de nuevo.')}</p>
        </div>`;
    }
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = 'Generar textos con IA';
  }
}

function renderAiPromoResults(ideas) {
  const resultsContainer = $('#aiPromoResults');
  if (!resultsContainer) return;
  if (!Array.isArray(ideas) || !ideas.length) {
    resultsContainer.innerHTML = `
      <div class="ai-promo-empty">
        <i class="ph-bold ph-magic-wand"></i>
        <h4>Sin resultados</h4>
        <p>Intenta con otro objetivo o agrega más detalles.</p>
      </div>`;
    return;
  }

  const badgeMap = {
    whatsapp: { cls: 'whatsapp', icon: 'ph-bold ph-whatsapp-logo' },
    promo: { cls: 'promo', icon: 'ph-bold ph-tag' },
    weekend: { cls: 'weekend', icon: 'ph-bold ph-sparkle' },
    social: { cls: 'social', icon: 'ph-bold ph-share-network' },
  };

  resultsContainer.innerHTML = ideas.map((idea, index) => {
    const badgeKey = String(idea.badge || '').toLowerCase().includes('whats')
      ? 'whatsapp'
      : String(idea.badge || '').toLowerCase().includes('promo')
      ? 'promo'
      : String(idea.badge || '').toLowerCase().includes('fin')
      ? 'weekend'
      : 'social';
    const badgeInfo = badgeMap[badgeKey] || { cls: 'social', icon: 'ph-bold ph-sparkle' };

    return `
      <div class="ai-promo-card" data-promo-index="${index}">
        <div class="ai-promo-card-head">
          <span class="ai-promo-card-badge ${badgeInfo.cls}"><i class="${badgeInfo.icon}"></i> ${esc(idea.badge || idea.title || 'Idea')}</span>
          <b class="ai-promo-card-title">${esc(idea.title || `Opción ${index + 1}`)}</b>
        </div>
        <div class="ai-promo-text-wrap">
          <textarea class="ai-promo-textarea" rows="5">${esc(idea.text)}</textarea>
        </div>
        <div class="ai-promo-card-actions">
          <button type="button" class="btn btn-primary btn-sm ai-promo-copy-btn">
            <i class="ph-bold ph-copy"></i> <span>Copiar texto</span>
          </button>
          <a href="https://wa.me/?text=${encodeURIComponent(idea.text)}" target="_blank" class="btn btn-sm btn-ghost ai-promo-wa-btn">
            <i class="ph-bold ph-whatsapp-logo"></i> Compartir en WhatsApp
          </a>
        </div>
      </div>`;
  }).join('');

  resultsContainer.querySelectorAll('.ai-promo-card').forEach((card) => {
    const textarea = card.querySelector('.ai-promo-textarea');
    const copyBtn = card.querySelector('.ai-promo-copy-btn');
    const copyBtnSpan = copyBtn?.querySelector('span');
    const waLink = card.querySelector('.ai-promo-wa-btn');

    textarea?.addEventListener('input', () => {
      const updatedText = textarea.value;
      if (waLink) waLink.href = `https://wa.me/?text=${encodeURIComponent(updatedText)}`;
    });

    copyBtn?.addEventListener('click', () => {
      const textToCopy = textarea ? textarea.value : '';
      navigator.clipboard.writeText(textToCopy);
      if (copyBtnSpan) copyBtnSpan.textContent = '¡Copiado! ✓';
      toast('¡Texto copiado al portapapeles!');
      setTimeout(() => {
        if (copyBtnSpan) copyBtnSpan.textContent = 'Copiar texto';
      }, 2000);
    });
  });
}

$('#openAiPromoBtn')?.addEventListener('click', () => openAiPromoModal());
$('#openAiPromoQuickBtn')?.addEventListener('click', () => openAiPromoModal());
$('#aiPromoForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  generateAiPromoTexts();
});
$('#aiPromoRegenerateBtn')?.addEventListener('click', () => generateAiPromoTexts());

$('#copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#chatLink').value);
  toast('¡Liga copiada al portapapeles!');
});
$('#botForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const hasCustomMode = CHATBOT_RECEIVING_MODES.some((mode) => mode.enabled);
  if (!$('#botDelivery').checked && !$('#botPickup').checked && !$('#botDineIn').checked && !hasCustomMode) {
    return toast('Activa al menos una modalidad para recibir pedidos', true);
  }
  const fd = new FormData();
  fd.append('welcome_message', $('#botWelcome').value);
  fd.append('whatsapp', $('#botWhatsapp').value);
  fd.append('delivery_enabled', $('#botDelivery').checked ? '1' : '0');
  fd.append('pickup_enabled', $('#botPickup').checked ? '1' : '0');
  fd.append('dine_in_enabled', $('#botDineIn').checked ? '1' : '0');
  fd.append('chatbot_receiving_modes_json', JSON.stringify(CHATBOT_RECEIVING_MODES));
  fd.append('location_enabled', $('#botLocation').checked ? '1' : '0');
  fd.append('chatbot_extra_options_json', JSON.stringify(CHATBOT_INFO_OPTIONS));
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Flujo del chatbot guardado');
  SETTINGS = await api('/api/settings');
});

$('#botReceivingModeSaveBtn')?.addEventListener('click', () => {
  const editId = String($('#botReceivingModeId')?.value || '').trim();
  const label = String($('#botReceivingModeLabel')?.value || '').trim().replace(/\s+/g, ' ').slice(0, 42);
  const behavior = String($('#botReceivingModeBehavior')?.value || 'simple');
  if (!label) return toast('Escribe el nombre de la modalidad', true);
  if (!['delivery', 'branch', 'simple'].includes(behavior)) return toast('Selecciona los datos que solicitará', true);
  if (!editId && CHATBOT_RECEIVING_MODES.length >= 10) return toast('Puedes crear hasta 10 modalidades personalizadas', true);
  const payload = {
    id: editId || `custom_${Date.now().toString(36)}`,
    label,
    behavior,
    enabled: editId ? CHATBOT_RECEIVING_MODES.find((mode) => mode.id === editId)?.enabled !== false : true,
  };
  if (editId) CHATBOT_RECEIVING_MODES = CHATBOT_RECEIVING_MODES.map((mode) => mode.id === editId ? payload : mode);
  else CHATBOT_RECEIVING_MODES.push(payload);
  CHATBOT_RECEIVING_MODES = parseChatbotReceivingModes(JSON.stringify(CHATBOT_RECEIVING_MODES));
  resetReceivingModeEditor();
  renderReceivingModesList();
  toast(editId ? 'Modalidad actualizada; falta guardar el flujo' : 'Modalidad agregada; falta guardar el flujo');
});

$('#botReceivingModeNewBtn')?.addEventListener('click', resetReceivingModeEditor);

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
let BANK_ACCOUNTS = [];

function readBankAccountInputs() {
  return [...document.querySelectorAll('.bank-account-card')].map((card) => ({
    bankName: card.querySelector('[data-bank-field="bankName"]').value.trim(),
    holderName: card.querySelector('[data-bank-field="holderName"]').value.trim(),
    identifierType: card.querySelector('[data-bank-field="identifierType"]').value,
    identifier: card.querySelector('[data-bank-field="identifier"]').value.trim(),
  }));
}

function renderBankAccounts() {
  const list = $('#bankAccountsList');
  if (!list) return;
  if (!BANK_ACCOUNTS.length) {
    list.innerHTML = '<div class="bank-account-empty"><i class="ph-bold ph-bank"></i> Agrega la cuenta que usarán tus clientes para transferir.</div>';
    return;
  }
  list.innerHTML = BANK_ACCOUNTS.map((account, index) => `
    <article class="bank-account-card" data-bank-account="${index}">
      <div class="bank-account-card-head">
        <b>Cuenta bancaria ${index + 1}</b>
        <button class="btn btn-danger btn-icon bank-account-remove" type="button" data-remove-bank="${index}" title="Eliminar cuenta" aria-label="Eliminar cuenta ${index + 1}">
          <i class="ph-bold ph-trash"></i>
        </button>
      </div>
      <div class="bank-account-fields">
        <div class="field">
          <label>Nombre del banco</label>
          <input type="text" data-bank-field="bankName" maxlength="80" value="${esc(account.bankName || '')}" placeholder="Ej. BBVA" />
        </div>
        <div class="field">
          <label>Nombre del titular</label>
          <input type="text" data-bank-field="holderName" maxlength="100" value="${esc(account.holderName || '')}" placeholder="Persona o razón social" />
        </div>
        <div class="field">
          <label>Tipo de dato</label>
          <select data-bank-field="identifierType">
            <option value="account" ${account.identifierType === 'account' ? 'selected' : ''}>Número de cuenta</option>
            <option value="clabe" ${account.identifierType === 'clabe' ? 'selected' : ''}>CLABE interbancaria</option>
            <option value="card" ${account.identifierType === 'card' ? 'selected' : ''}>Número de tarjeta</option>
          </select>
        </div>
        <div class="field">
          <label>Número</label>
          <input type="text" inputmode="numeric" data-bank-field="identifier" maxlength="50" value="${esc(account.identifier || '')}" placeholder="Ingresa el número completo" />
        </div>
      </div>
    </article>`).join('');
}

function syncBankAccountsVisibility() {
  const enabled = $('#cfgChatPayDeliveryTransfer').checked || $('#cfgChatPayPickupTransfer').checked;
  $('#cfgBankAccountsPanel').hidden = !enabled;
}

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

function renderRegionalSettingsOptions() {
  const currencies = Array.isArray(SETTINGS?.regional?.currencies) ? SETTINGS.regional.currencies : [];
  const timezones = Array.isArray(SETTINGS?.regional?.timezones) ? SETTINGS.regional.timezones : [];
  if (currencies.length) {
    $('#cfgCurrency').innerHTML = currencies.map((item) =>
      `<option value="${esc(item.code)}">${esc(item.flag)} ${esc(item.code)} — ${esc(item.name)}</option>`
    ).join('');
  }
  $('#cfgTimezone').innerHTML = timezones.map((item) =>
    `<option value="${esc(item.value)}">${esc(item.label)} · ${esc(item.value)}</option>`
  ).join('');
}

function updateTimezonePreview() {
  const timezone = $('#cfgTimezone')?.value || businessTimeZone();
  const preview = $('#cfgTimezoneNow');
  if (!preview) return;
  try {
    const local = new Intl.DateTimeFormat('es-MX', {
      timeZone: timezone,
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date());
    preview.textContent = `Hora local del negocio: ${local}`;
  } catch {
    preview.textContent = 'Selecciona una zona horaria válida.';
  }
}

function fillConfigForm() {
  if (!SETTINGS) return;
  renderRegionalSettingsOptions();
  $('#cfgName').value = SETTINGS.business_name || '';
  $('#cfgColor').value = SETTINGS.primary_color || '#ff6b35';
  $('#cfgAddress').value = SETTINGS.address || '';
  $('#cfgHours').value = SETTINGS.hours || '';
  $('#cfgCurrency').value = SETTINGS.currency || 'MXN';
  $('#cfgTimezone').value = SETTINGS.timezone || 'America/Mexico_City';
  updateTimezonePreview();
  $('#cfgChatPayDeliveryCash').checked = (SETTINGS.chatbot_payment_delivery_cash || '1') === '1';
  $('#cfgChatPayDeliveryTransfer').checked = (SETTINGS.chatbot_payment_delivery_transfer || '0') === '1';
  $('#cfgChatPayDeliveryCard').checked = (SETTINGS.chatbot_payment_delivery_card || '0') === '1';
  $('#cfgChatPayPickupCash').checked = (SETTINGS.chatbot_payment_pickup_cash || '1') === '1';
  $('#cfgChatPayPickupTransfer').checked = (SETTINGS.chatbot_payment_pickup_transfer || '0') === '1';
  $('#cfgChatPayPickupCard').checked = (SETTINGS.chatbot_payment_pickup_card || '0') === '1';
  try {
    const parsedAccounts = JSON.parse(SETTINGS.chatbot_bank_accounts_json || '[]');
    BANK_ACCOUNTS = Array.isArray(parsedAccounts) ? parsedAccounts : [];
  } catch {
    BANK_ACCOUNTS = [];
  }
  renderBankAccounts();
  syncBankAccountsVisibility();
  $('#cfgPosChatIntegration').checked = (SETTINGS.chatbot_pos_integration_enabled || '0') === '1';
  $('#cfgRoundEditEnabled').checked = (SETTINGS.pos_round_edit_enabled || '0') === '1';
  $('#cfgRoundEditRequirePin').checked = (SETTINGS.pos_round_edit_require_pin || '0') === '1';
  $('#cfgSameDayCancelEnabled').checked = (SETTINGS.pos_same_day_cancel_enabled || '1') === '1';
  $('#cfgCancelRequirePin').checked = (SETTINGS.pos_cancel_require_pin || '0') === '1';
  $('#cfgAuthorizationPin').value = '';
  $('#posAuthorizationPinStatus').textContent = SETTINGS.authorization_pin_configured ? 'NIP configurado' : 'NIP no configurado';
  $('#cfgTicketWidth').value = String(Number(SETTINGS.ticket_width_mm || 80));
  $('#cfgTicketFont').value = String(Number(SETTINGS.ticket_font_size_px || 14));
  $('#cfgTicketLineHeight').value = String(Number(SETTINGS.ticket_line_height || 1.45));
  $('#cfgTicketShowLogo').value = SETTINGS.ticket_show_logo === '0' ? '0' : '1';
  $('#cfgTicketPrintMode').value = SETTINGS.ticket_print_mode === 'bluetooth' ? 'bluetooth' : 'thermal';
  $('#cfgTicketMobileZoom').value = String(Math.max(80, Math.min(120, Number(SETTINGS.ticket_mobile_zoom_percent || 100))));
  $('#logoPreview').innerHTML = SETTINGS.logo ? `<img src="${esc(SETTINGS.logo)}" alt="" />` : '<i class="ph ph-image"></i>';
  renderSwatches();
  renderBusinessModelPicker();
  if (!isCashierUser()) loadCashiers().catch((err) => toast(err.message, true));
}
$('#cfgLogo').addEventListener('change', () => {
  const f = $('#cfgLogo').files[0];
  if (f) $('#logoPreview').innerHTML = `<img src="${URL.createObjectURL(f)}" alt="" />`;
});
$('#addBankAccountBtn')?.addEventListener('click', () => {
  BANK_ACCOUNTS = readBankAccountInputs();
  if (BANK_ACCOUNTS.length >= 10) return toast('Puedes configurar hasta 10 cuentas bancarias', true);
  BANK_ACCOUNTS.push({ bankName: '', holderName: '', identifierType: 'clabe', identifier: '' });
  renderBankAccounts();
  const cards = document.querySelectorAll('.bank-account-card');
  cards[cards.length - 1]?.querySelector('input')?.focus();
});
$('#bankAccountsList')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-bank]');
  if (!button) return;
  BANK_ACCOUNTS = readBankAccountInputs();
  BANK_ACCOUNTS.splice(Number(button.dataset.removeBank), 1);
  renderBankAccounts();
});
[$('#cfgChatPayDeliveryTransfer'), $('#cfgChatPayPickupTransfer')].forEach((checkbox) => {
  checkbox?.addEventListener('change', syncBankAccountsVisibility);
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
$('#operationPolicyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const pin = String($('#cfgAuthorizationPin').value || '').trim();
  if (($('#cfgRoundEditRequirePin').checked || $('#cfgCancelRequirePin').checked) && !pin && !SETTINGS.authorization_pin_configured) {
    return toast('Configura un NIP antes de activar la autorización', true);
  }
  const fd = new FormData();
  fd.append('pos_round_edit_enabled', $('#cfgRoundEditEnabled').checked ? '1' : '0');
  fd.append('pos_round_edit_require_pin', $('#cfgRoundEditRequirePin').checked ? '1' : '0');
  fd.append('pos_same_day_cancel_enabled', $('#cfgSameDayCancelEnabled').checked ? '1' : '0');
  fd.append('pos_cancel_require_pin', $('#cfgCancelRequirePin').checked ? '1' : '0');
  if (pin) fd.append('pos_authorization_pin', pin);
  await api('/api/settings', { method: 'PUT', body: fd });
  SETTINGS = await api('/api/settings');
  fillConfigForm();
  toast('Controles de operación guardados');
});

let AUDIT_PAGE = 1;
let AUDIT_PAGE_SIZE = 10;
let AUDIT_FILTER = 'month';
let AUDIT_SEARCH = '';
let AUDIT_BRANCH = 'all';
let AUDIT_START_DATE = '';
let AUDIT_END_DATE = '';
let AUDIT_CACHE = [];
let AUDIT_SELECTED = null;
let AUDIT_SEARCH_TIMER = null;
let CUTS_PAGE = 1;
let CUTS_PAGE_SIZE = 10;
let CUTS_SEARCH = '';
let CUTS_BRANCH = 'all';
let CUTS_CACHE = [];
let CUTS_SELECTED = null;
let CUTS_SEARCH_TIMER = null;

function reportPager(host, page, totalPages, onPage) {
  if (!host) return;
  host.innerHTML = `<div class="orders-pagination-inner"><span>Página ${page} de ${totalPages}</span><div><button class="btn btn-ghost" type="button" data-report-prev ${page <= 1 ? 'disabled' : ''}><i class="ph-bold ph-caret-left"></i></button><button class="btn btn-ghost" type="button" data-report-next ${page >= totalPages ? 'disabled' : ''}><i class="ph-bold ph-caret-right"></i></button></div></div>`;
  host.querySelector('[data-report-prev]')?.addEventListener('click', () => onPage(page - 1));
  host.querySelector('[data-report-next]')?.addEventListener('click', () => onPage(page + 1));
}

async function loadAuditLog(page = 1) {
  if (!AUDIT_END_DATE) {
    AUDIT_END_DATE = getLocalIsoDate();
    AUDIT_START_DATE = `${AUDIT_END_DATE.slice(0, 7)}-01`;
    if ($('#auditStartDate')) $('#auditStartDate').value = AUDIT_START_DATE;
    if ($('#auditEndDate')) $('#auditEndDate').value = AUDIT_END_DATE;
  }
  if (isCashierUser()) {
    AUDIT_BRANCH = ME?.branchId ? String(ME.branchId) : 'general';
  }
  const query = new URLSearchParams({
    page: String(Math.max(1, page)), pageSize: String(AUDIT_PAGE_SIZE), filter: AUDIT_FILTER,
    search: AUDIT_SEARCH, branchId: AUDIT_BRANCH,
  });
  if (AUDIT_FILTER === 'custom') {
    query.set('startDate', AUDIT_START_DATE);
    query.set('endDate', AUDIT_END_DATE);
  }
  const data = await api(`/api/pos/audit-log?${query.toString()}`);
  AUDIT_PAGE = Number(data.page || 1);
  AUDIT_PAGE_SIZE = Number(data.pageSize || AUDIT_PAGE_SIZE);
  AUDIT_CACHE = Array.isArray(data.rows) ? data.rows : [];
  const summary = data.summary || {};
  const scope = isCashierUser()
    ? (ME?.branchName || 'Mi sucursal')
    : (AUDIT_BRANCH === 'all' ? 'Todas las sucursales' : ($('#auditBranchFilter')?.selectedOptions?.[0]?.textContent || 'Sucursal'));
  $('#auditSummaryCards').innerHTML = `
    <article class="audit-summary-card total"><i class="ph-bold ph-shield-check"></i><div><span>Eventos auditados</span><b>${Number(summary.total || 0)}</b><small>${esc(scope)}</small></div></article>
    <article class="audit-summary-card cancelled"><i class="ph-bold ph-x-circle"></i><div><span>Ventas canceladas</span><b>${Number(summary.cancellations || 0)}</b><small>${fmtMoney(summary.cancelled_amount || 0)}</small></div></article>
    <article class="audit-summary-card corrected"><i class="ph-bold ph-pencil-simple"></i><div><span>Rondas corregidas</span><b>${Number(summary.round_edits || 0)}</b><small>Impacto ${fmtMoney(summary.corrected_amount || 0)}</small></div></article>
    <article class="audit-summary-card payments"><i class="ph-bold ph-credit-card"></i><div><span>Cambios de pago</span><b>${Number(summary.payment_edits || 0)}</b><small>Movimientos registrados</small></div></article>`;
  const branchSelect = $('#auditBranchFilter');
  if (branchSelect) {
    if (isCashierUser()) {
      branchSelect.innerHTML = `<option value="${AUDIT_BRANCH}">${esc(ME?.branchName || 'Mi sucursal')}</option>`;
      branchSelect.value = AUDIT_BRANCH;
      branchSelect.disabled = true;
    } else if (branchSelect.options.length <= 2) {
      branchSelect.innerHTML = `<option value="all">Todas las sucursales</option><option value="general">General</option>${(data.branches || []).map((branch) => `<option value="${branch.id}">${esc(branch.name)}</option>`).join('')}`;
      branchSelect.value = AUDIT_BRANCH;
      branchSelect.disabled = false;
    }
  }
  $('#auditResultSummary').innerHTML = `<span><i class="ph-bold ph-file-magnifying-glass"></i>${Number(data.total || 0)} resultado${Number(data.total || 0) === 1 ? '' : 's'}</span><span><i class="ph-bold ph-calendar"></i>${auditPeriodLabel()}</span>`;
  $('#auditLogTable').innerHTML = AUDIT_CACHE.length ? `<table class="audit-table"><thead><tr><th class="audit-head-date"><i class="ph-bold ph-calendar-blank"></i> Fecha</th><th class="audit-head-event"><i class="ph-bold ph-lightning"></i> Evento</th><th class="audit-head-branch"><i class="ph-bold ph-storefront"></i> Sucursal</th><th class="audit-head-reference"><i class="ph-bold ph-link"></i> Referencia</th><th class="audit-head-amount"><i class="ph-bold ph-coins"></i> Impacto</th><th class="audit-head-user"><i class="ph-bold ph-user-circle"></i> Responsable</th><th class="audit-head-reason"><i class="ph-bold ph-note-pencil"></i> Motivo</th><th class="audit-head-actions"></th></tr></thead><tbody>${AUDIT_CACHE.map(renderAuditRow).join('')}</tbody></table>` : emptyHTML('ph-file-magnifying-glass', 'Sin movimientos auditados', 'Cambia el periodo, sucursal o búsqueda para consultar otros eventos.');
  document.querySelectorAll('[data-view-audit]').forEach((button) => button.addEventListener('click', () => openAuditDetail(button.dataset.viewAudit)));
  document.querySelectorAll('[data-print-audit]').forEach((button) => button.addEventListener('click', () => printAuditEvent(button.dataset.printAudit)));
  reportPager($('#auditLogPagination'), AUDIT_PAGE, Number(data.totalPages || 1), (next) => loadAuditLog(next).catch((error) => toast(error.message, true)));
}

const AUDIT_EVENT_META = {
  sale_cancelled: { label: 'Venta cancelada', icon: 'ph-x-circle', tone: 'cancelled' },
  sale_payment_edited: { label: 'Pago editado', icon: 'ph-credit-card', tone: 'payment' },
  table_round_edited: { label: 'Ronda editada', icon: 'ph-pencil-simple', tone: 'edited' },
  table_round_deleted: { label: 'Ronda eliminada', icon: 'ph-trash', tone: 'deleted' },
};

function auditPeriodLabel() {
  if (AUDIT_FILTER === 'today') return 'Hoy';
  if (AUDIT_FILTER === 'week') return 'Semana actual';
  if (AUDIT_FILTER === 'custom') return `${AUDIT_START_DATE || '—'} a ${AUDIT_END_DATE || '—'}`;
  return 'Mes actual';
}

function auditReference(row) {
  if (row.order_id) return `Venta #${row.order_id}`;
  return `Mesa #${row.table_account_id || '—'} · Ronda #${row.table_round_id || '—'}`;
}

function renderAuditRow(row) {
  const meta = AUDIT_EVENT_META[row.event_type] || { label: row.event_type, icon: 'ph-warning-circle', tone: 'other' };
  const initials = String(row.actor_username || '?').slice(0, 2).toUpperCase();
  return `<tr class="audit-row tone-${meta.tone}">
    <td data-label="Fecha"><div class="audit-date"><i class="ph-bold ph-clock"></i><span>${esc(row.created_at || '—')}</span></div></td>
    <td data-label="Evento"><span class="audit-event ${meta.tone}"><i class="ph-bold ${meta.icon}"></i>${esc(meta.label)}</span></td>
    <td data-label="Sucursal"><span class="audit-branch"><i class="ph-fill ph-map-pin"></i>${esc(row.branch_name || 'General')}</span></td>
    <td data-label="Referencia"><b class="audit-reference">${esc(auditReference(row))}</b></td>
    <td data-label="Impacto"><span class="audit-amount ${meta.tone}">${fmtMoney(Math.abs(Number(row.amount || 0)))}</span></td>
    <td data-label="Responsable"><div class="audit-user"><span>${esc(initials)}</span><div><b>${esc(row.actor_username || '—')}</b><small>${esc(row.authorized_by || 'Sin NIP')}</small></div></div></td>
    <td data-label="Motivo"><p class="audit-reason">${esc(row.reason || 'Sin motivo')}</p></td>
    <td data-label="Acciones"><div class="audit-actions"><button class="btn btn-ghost btn-icon" type="button" data-view-audit="${row.id}" title="Ver evidencia"><i class="ph-bold ph-eye"></i></button><button class="btn btn-ghost btn-icon" type="button" data-print-audit="${row.id}" title="Imprimir auditoría"><i class="ph-bold ph-printer"></i></button></div></td>
  </tr>`;
}

function parseAuditData(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function auditSnapshotHtml(value) {
  const data = parseAuditData(value);
  const items = Array.isArray(data.items) ? data.items : [];
  const labels = { status: 'Estado', total: 'Total', paymentMethod: 'Forma de pago', paymentBreakdown: 'Distribución del pago', cashReceived: 'Efectivo recibido', cashChange: 'Cambio', roundNumber: 'Ronda', subtotal: 'Subtotal' };
  const fields = Object.entries(data).filter(([key]) => key !== 'items');
  return `<div class="audit-snapshot-fields">${fields.length ? fields.map(([key, val]) => `<span><small>${esc(labels[key] || key)}</small><b>${typeof val === 'object' ? esc(JSON.stringify(val)) : esc(String(val ?? '—'))}</b></span>`).join('') : '<span><small>Información</small><b>Sin datos adicionales</b></span>'}</div>${items.length ? `<div class="audit-snapshot-items"><b>Productos</b>${items.map((item) => `<span><i>${Number(item.qty || 1)}×</i><strong>${esc(item.name || 'Producto')}</strong><em>${fmtMoney(Number(item.price || 0) * Number(item.qty || 1))}</em></span>`).join('')}</div>` : ''}`;
}

function auditDetailMarkup(row) {
  const meta = AUDIT_EVENT_META[row.event_type] || { label: row.event_type, icon: 'ph-warning-circle', tone: 'other' };
  return `<div class="audit-detail-meta"><span><i class="ph-bold ph-calendar"></i><small>Fecha</small><b>${esc(row.created_at || '—')}</b></span><span><i class="ph-bold ph-storefront"></i><small>Sucursal</small><b>${esc(row.branch_name || 'General')}</b></span><span><i class="ph-bold ph-user"></i><small>Responsable</small><b>${esc(row.actor_username || '—')}</b></span><span><i class="ph-bold ph-password"></i><small>Autorización</small><b>${esc(row.authorized_by || 'No requerida')}</b></span></div><div class="audit-detail-banner ${meta.tone}"><i class="ph-bold ${meta.icon}"></i><div><span>${esc(meta.label)}</span><b>${esc(auditReference(row))} · ${fmtMoney(Math.abs(Number(row.amount || 0)))}</b><p>${esc(row.reason || 'Sin motivo registrado')}</p></div></div><div class="audit-before-after"><section><h4><i class="ph-bold ph-arrow-counter-clockwise"></i> Antes</h4>${auditSnapshotHtml(row.before_data)}</section><section><h4><i class="ph-bold ph-arrow-clockwise"></i> Después</h4>${auditSnapshotHtml(row.after_data)}</section></div>`;
}

function openAuditDetail(id) {
  const row = AUDIT_CACHE.find((item) => Number(item.id) === Number(id));
  if (!row) return toast('No se encontró el movimiento auditado', true);
  AUDIT_SELECTED = row;
  const meta = AUDIT_EVENT_META[row.event_type] || { label: row.event_type };
  $('#auditDetailTitle').innerHTML = `<i class="ph-bold ph-shield-check"></i> Evento #${row.id} · ${esc(meta.label)}`;
  $('#auditDetailContent').innerHTML = auditDetailMarkup(row);
  $('#auditDetailModal').classList.add('show');
}

function printAuditEvent(id) {
  const row = AUDIT_CACHE.find((item) => Number(item.id) === Number(id));
  if (!row) return toast('No se encontró el movimiento auditado', true);
  const meta = AUDIT_EVENT_META[row.event_type] || { label: row.event_type };
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Auditoría #${row.id}</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#172033}header{border-bottom:3px solid #0f766e;padding-bottom:12px}h1{font-size:20px;margin:0 0 5px}p{font-size:12px}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:16px 0}.meta span,section{border:1px solid #dbe3ea;padding:10px;border-radius:6px}.meta small{display:block;color:#64748b}.event{padding:12px;background:#f8fafc;border-left:5px solid #f97316}.event b,.event span{display:block}.snapshots{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}.audit-snapshot-fields span,.audit-snapshot-items span{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid #e5e7eb;font-size:11px}.audit-snapshot-fields small{color:#64748b}.audit-snapshot-items>b{display:block;margin:8px 0;font-size:11px}.audit-snapshot-items i,.audit-snapshot-items em{font-style:normal}@media print{button{display:none}}@media(max-width:600px){.meta,.snapshots{grid-template-columns:1fr}}</style></head><body><header><h1>Auditoría #${row.id} · ${esc(meta.label)}</h1><p>${esc(SETTINGS?.business_name || ME?.tenant?.businessName || 'Negocio')}</p></header><div class="meta"><span><small>Fecha</small><b>${esc(row.created_at || '—')}</b></span><span><small>Sucursal</small><b>${esc(row.branch_name || 'General')}</b></span><span><small>Responsable</small><b>${esc(row.actor_username || '—')}</b></span><span><small>Autorización</small><b>${esc(row.authorized_by || 'No requerida')}</b></span></div><div class="event"><span>${esc(auditReference(row))} · ${fmtMoney(Math.abs(Number(row.amount || 0)))}</span><b>Motivo: ${esc(row.reason || 'Sin motivo')}</b></div><div class="snapshots"><section><h3>Antes</h3>${auditSnapshotHtml(row.before_data)}</section><section><h3>Después</h3>${auditSnapshotHtml(row.after_data)}</section></div><script>window.onload=()=>{window.print();setTimeout(()=>window.close(),120)};<\/script></body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, '_blank', 'width=900,height=820');
  if (!popup) return toast('Permite ventanas emergentes para imprimir la auditoría', true);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function loadCutsHistory(page = 1) {
  if (isCashierUser()) {
    CUTS_BRANCH = ME?.branchId ? String(ME.branchId) : 'general';
  }
  const query = new URLSearchParams({
    page: String(Math.max(1, page)),
    pageSize: String(CUTS_PAGE_SIZE),
    search: CUTS_SEARCH,
    branchId: CUTS_BRANCH,
  });
  const data = await api(`/api/pos/cuts?${query.toString()}`);
  CUTS_PAGE = Number(data.page || 1);
  CUTS_PAGE_SIZE = Number(data.pageSize || CUTS_PAGE_SIZE);
  CUTS_CACHE = Array.isArray(data.rows) ? data.rows : [];
  const branchSelect = $('#cutsBranchFilter');
  if (branchSelect) {
    if (isCashierUser()) {
      branchSelect.innerHTML = `<option value="${CUTS_BRANCH}">${esc(ME?.branchName || 'Mi sucursal')}</option>`;
      branchSelect.value = CUTS_BRANCH;
      branchSelect.disabled = true;
    } else if (branchSelect.options.length <= 2) {
      branchSelect.innerHTML = `<option value="all">Todas las sucursales</option><option value="general">General</option>${(data.branches || []).map((branch) => `<option value="${branch.id}">${esc(branch.name)}</option>`).join('')}`;
      branchSelect.value = CUTS_BRANCH;
      branchSelect.disabled = false;
    }
  }
  $('#cutsResultSummary').innerHTML = `<span><i class="ph-bold ph-receipt"></i> ${Number(data.total || 0)} corte${Number(data.total || 0) === 1 ? '' : 's'}</span><span><i class="ph-bold ph-files"></i> Página ${CUTS_PAGE} de ${Number(data.totalPages || 1)}</span>`;
  $('#cutsHistoryTable').innerHTML = CUTS_CACHE.length ? `<table class="cuts-table"><thead><tr><th class="cut-head-id"><i class="ph-bold ph-hash"></i> Corte</th><th class="cut-head-branch"><i class="ph-bold ph-storefront"></i> Sucursal</th><th class="cut-head-user"><i class="ph-bold ph-user-circle"></i> Usuario</th><th class="cut-head-open"><i class="ph-bold ph-door-open"></i> Apertura</th><th class="cut-head-close"><i class="ph-bold ph-lock-key"></i> Cierre</th><th class="cut-head-sales"><i class="ph-bold ph-chart-line-up"></i> Ventas</th><th class="cut-head-expected"><i class="ph-bold ph-calculator"></i> Esperado</th><th class="cut-head-counted"><i class="ph-bold ph-money"></i> Contado</th><th class="cut-head-difference"><i class="ph-bold ph-scales"></i> Diferencia</th><th class="cut-head-actions"><i class="ph-bold ph-dots-three"></i></th></tr></thead><tbody>${CUTS_CACHE.map(renderCutRow).join('')}</tbody></table>` : emptyHTML('ph-safe', 'Sin cortes encontrados', 'Cambia la búsqueda o los filtros para consultar otros turnos.');
  document.querySelectorAll('[data-view-cut]').forEach((button) => button.addEventListener('click', () => openCutDetail(button.dataset.viewCut)));
  document.querySelectorAll('[data-print-cut]').forEach((button) => button.addEventListener('click', () => printHistoricalCut(button.dataset.printCut)));
  reportPager($('#cutsPagination'), CUTS_PAGE, Number(data.totalPages || 1), (next) => loadCutsHistory(next).catch((error) => toast(error.message, true)));
}

function renderCutRow(row) {
  const difference = Number(row.difference_amount || 0);
  const statusLabel = row.status === 'open' ? 'Abierta' : 'Cerrada';
  const initials = String(row.opened_by || '?').slice(0, 2).toUpperCase();
  const differenceClass = difference < 0 ? 'negative' : difference > 0 ? 'positive' : 'balanced';
  return `<tr class="cut-row ${row.status === 'open' ? 'is-open' : ''}">
    <td data-label="Corte"><div class="cut-id"><b>#${row.id}</b><span class="cut-status ${row.status}">${statusLabel}</span></div></td>
    <td data-label="Sucursal"><span class="cut-branch"><i class="ph-fill ph-map-pin"></i>${esc(row.branch_name || 'General')}</span></td>
    <td data-label="Usuario"><div class="cut-user"><span>${esc(initials)}</span><div><b>${esc(row.opened_by || '—')}</b><small>Cerró: ${esc(row.closed_by || '—')}</small></div></div></td>
    <td data-label="Apertura"><div class="cut-date open"><i class="ph-bold ph-sun-horizon"></i><span>${esc(row.opened_at || '—')}</span></div></td>
    <td data-label="Cierre"><div class="cut-date close"><i class="ph-bold ph-moon-stars"></i><span>${esc(row.closed_at || 'Pendiente')}</span></div></td>
    <td data-label="Ventas"><div class="cut-money sales"><b>${fmtMoney(row.totals?.totalSales || 0)}</b><small>${Number(row.totals?.tickets || 0)} ticket${Number(row.totals?.tickets || 0) === 1 ? '' : 's'}</small></div></td>
    <td data-label="Esperado"><span class="cut-money expected">${fmtMoney(row.expected_cash || 0)}</span></td>
    <td data-label="Contado"><span class="cut-money counted">${row.closing_amount == null ? '—' : fmtMoney(row.closing_amount)}</span></td>
    <td data-label="Diferencia"><span class="cut-difference ${differenceClass}">${row.status === 'open' ? 'Pendiente' : fmtMoney(difference)}</span></td>
    <td data-label="Acciones"><div class="cut-actions"><button class="btn btn-ghost btn-icon" type="button" data-view-cut="${row.id}" title="Ver detalle"><i class="ph-bold ph-eye"></i></button><button class="btn btn-ghost btn-icon" type="button" data-print-cut="${row.id}" title="Imprimir corte"><i class="ph-bold ph-printer"></i></button></div></td>
  </tr>`;
}

function historicalCutResult(row) {
  return {
    closedSession: row,
    totals: row.totals || {},
    expectedAmount: Number(row.expected_cash || 0),
    closingAmount: row.closing_amount == null ? 0 : Number(row.closing_amount),
    differenceAmount: Number(row.difference_amount || 0),
  };
}

function printHistoricalCut(id) {
  const row = CUTS_CACHE.find((item) => Number(item.id) === Number(id));
  if (!row) return toast('No se encontró el corte', true);
  printPosCloseReport(historicalCutResult(row));
}

function openCutDetail(id) {
  const row = CUTS_CACHE.find((item) => Number(item.id) === Number(id));
  if (!row) return toast('No se encontró el corte', true);
  CUTS_SELECTED = row;
  const totals = row.totals || {};
  const methods = totals.salesByMethod || {};
  const movements = totals.movements || {};
  const difference = Number(row.difference_amount || 0);
  $('#cutsDetailTitle').innerHTML = `<i class="ph-bold ph-receipt"></i> Corte #${row.id} · ${esc(row.branch_name || 'General')}`;
  $('#cutsDetailContent').innerHTML = `
    <div class="cut-detail-meta"><span><i class="ph-bold ph-user"></i><b>Abrió</b>${esc(row.opened_by || '—')}</span><span><i class="ph-bold ph-door-open"></i><b>Apertura</b>${esc(row.opened_at || '—')}</span><span><i class="ph-bold ph-lock-key"></i><b>Cierre</b>${esc(row.closed_at || 'Pendiente')}</span></div>
    <div class="cut-detail-kpis"><article class="opening"><i class="ph-bold ph-wallet"></i><span>Fondo inicial</span><b>${fmtMoney(row.opening_amount || 0)}</b></article><article class="sales"><i class="ph-bold ph-chart-line-up"></i><span>Ventas</span><b>${fmtMoney(totals.totalSales || 0)}</b><small>${Number(totals.tickets || 0)} tickets</small></article><article class="expected"><i class="ph-bold ph-calculator"></i><span>Esperado</span><b>${fmtMoney(row.expected_cash || 0)}</b></article><article class="counted"><i class="ph-bold ph-money"></i><span>Contado</span><b>${row.closing_amount == null ? 'Pendiente' : fmtMoney(row.closing_amount)}</b></article><article class="difference ${difference < 0 ? 'negative' : difference > 0 ? 'positive' : ''}"><i class="ph-bold ph-scales"></i><span>Diferencia</span><b>${row.status === 'open' ? 'Pendiente' : fmtMoney(difference)}</b></article></div>
    <div class="cut-detail-groups"><section><h4><i class="ph-bold ph-credit-card"></i> Ventas por medio</h4><div><span>Efectivo <b>${fmtMoney(methods.cash || 0)}</b></span><span>Tarjeta <b>${fmtMoney(methods.card || 0)}</b></span><span>Transferencia <b>${fmtMoney(methods.transfer || 0)}</b></span><span>Mixto <b>${fmtMoney(methods.mixed || 0)}</b></span></div></section><section><h4><i class="ph-bold ph-arrows-left-right"></i> Movimientos de caja</h4><div><span>Ingresos <b>${fmtMoney(movements.income || 0)}</b></span><span>Retiros <b>${fmtMoney(movements.withdrawal || 0)}</b></span><span>Gastos <b>${fmtMoney(movements.expense || 0)}</b></span><span>Cancelaciones <b>${fmtMoney(totals.cancellations?.total || 0)}</b></span></div></section></div>
    ${row.notes ? `<div class="cut-detail-notes"><i class="ph-bold ph-note"></i><div><b>Notas del corte</b><p>${esc(row.notes)}</p></div></div>` : ''}`;
  $('#cutsDetailModal').classList.add('show');
}

$('#auditRefreshBtn')?.addEventListener('click', () => loadAuditLog(AUDIT_PAGE).catch((error) => toast(error.message, true)));
document.querySelectorAll('#auditPeriodFilter [data-audit-period]').forEach((button) => button.addEventListener('click', () => {
  AUDIT_FILTER = button.dataset.auditPeriod;
  document.querySelectorAll('#auditPeriodFilter [data-audit-period]').forEach((item) => item.classList.toggle('on', item === button));
  $('#auditCustomRange').hidden = AUDIT_FILTER !== 'custom';
  if (AUDIT_FILTER !== 'custom') loadAuditLog(1).catch((error) => toast(error.message, true));
}));
$('#auditApplyRange')?.addEventListener('click', () => {
  AUDIT_START_DATE = $('#auditStartDate').value || '';
  AUDIT_END_DATE = $('#auditEndDate').value || '';
  loadAuditLog(1).catch((error) => toast(error.message, true));
});
$('#auditSearch')?.addEventListener('input', (event) => {
  AUDIT_SEARCH = event.target.value.trim();
  clearTimeout(AUDIT_SEARCH_TIMER);
  AUDIT_SEARCH_TIMER = setTimeout(() => loadAuditLog(1).catch((error) => toast(error.message, true)), 280);
});
$('#auditBranchFilter')?.addEventListener('change', (event) => { AUDIT_BRANCH = event.target.value; loadAuditLog(1).catch((error) => toast(error.message, true)); });
$('#auditPageSize')?.addEventListener('change', (event) => { AUDIT_PAGE_SIZE = Number(event.target.value) || 10; loadAuditLog(1).catch((error) => toast(error.message, true)); });
[$('#auditDetailClose'), $('#auditDetailCancel')].forEach((button) => button?.addEventListener('click', () => $('#auditDetailModal').classList.remove('show')));
$('#auditDetailPrint')?.addEventListener('click', () => AUDIT_SELECTED && printAuditEvent(AUDIT_SELECTED.id));
$('#cutsRefreshBtn')?.addEventListener('click', () => loadCutsHistory(CUTS_PAGE).catch((error) => toast(error.message, true)));
$('#cutsSearch')?.addEventListener('input', (event) => {
  CUTS_SEARCH = event.target.value.trim();
  clearTimeout(CUTS_SEARCH_TIMER);
  CUTS_SEARCH_TIMER = setTimeout(() => loadCutsHistory(1).catch((error) => toast(error.message, true)), 280);
});
$('#cutsBranchFilter')?.addEventListener('change', (event) => { CUTS_BRANCH = event.target.value; loadCutsHistory(1).catch((error) => toast(error.message, true)); });
$('#cutsPageSize')?.addEventListener('change', (event) => { CUTS_PAGE_SIZE = Number(event.target.value) || 10; loadCutsHistory(1).catch((error) => toast(error.message, true)); });
[$('#cutsDetailClose'), $('#cutsDetailCancel')].forEach((button) => button?.addEventListener('click', () => $('#cutsDetailModal').classList.remove('show')));
$('#cutsDetailPrint')?.addEventListener('click', () => CUTS_SELECTED && printPosCloseReport(historicalCutResult(CUTS_SELECTED)));
$('#cutsDetailPdf')?.addEventListener('click', () => CUTS_SELECTED && exportPosClosePdf(historicalCutResult(CUTS_SELECTED)));
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
    return toast('Activa al menos un medio de pago para sucursal o modalidades personalizadas', true);
  }
  const transferEnabled = $('#cfgChatPayDeliveryTransfer').checked || $('#cfgChatPayPickupTransfer').checked;
  BANK_ACCOUNTS = readBankAccountInputs();
  if (transferEnabled && !BANK_ACCOUNTS.length) {
    return toast('Agrega al menos una cuenta para recibir transferencias', true);
  }
  if (BANK_ACCOUNTS.some((account) => !account.bankName || !account.holderName || !account.identifierType || !account.identifier)) {
    return toast('Completa todos los datos de cada cuenta bancaria', true);
  }
  const fd = new FormData();
  fd.append('address', $('#cfgAddress').value);
  fd.append('hours', $('#cfgHours').value);
  fd.append('currency', $('#cfgCurrency').value);
  fd.append('timezone', $('#cfgTimezone').value);
  fd.append('chatbot_payment_delivery_cash', $('#cfgChatPayDeliveryCash').checked ? '1' : '0');
  fd.append('chatbot_payment_delivery_transfer', $('#cfgChatPayDeliveryTransfer').checked ? '1' : '0');
  fd.append('chatbot_payment_delivery_card', $('#cfgChatPayDeliveryCard').checked ? '1' : '0');
  fd.append('chatbot_payment_pickup_cash', $('#cfgChatPayPickupCash').checked ? '1' : '0');
  fd.append('chatbot_payment_pickup_transfer', $('#cfgChatPayPickupTransfer').checked ? '1' : '0');
  fd.append('chatbot_payment_pickup_card', $('#cfgChatPayPickupCard').checked ? '1' : '0');
  fd.append('chatbot_bank_accounts_json', JSON.stringify(BANK_ACCOUNTS));
  fd.append('chatbot_pos_integration_enabled', $('#cfgPosChatIntegration').checked ? '1' : '0');
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Cuentas y medios de pago guardados');
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

/* ===== Modelo de negocio ===== */
const BUSINESS_MODELS = [
  {
    id: 'restaurant',
    icon: 'ph-fork-knife',
    label: 'Restaurante / cafetería',
    desc: 'Toma pedidos desde el menú, entrega a domicilio o recolección en sucursal (flujo original).',
    tag: 'Por defecto',
  },
  {
    id: 'furniture',
    icon: 'ph-armchair',
    label: 'Mueblería',
    desc: 'Asesora sobre catálogo, medidas, materiales, tiempos y opciones de envío o recolección.',
  },
  {
    id: 'travel_agency',
    icon: 'ph-airplane-tilt',
    label: 'Agencia de viajes',
    desc: 'Presenta paquetes, destinos y tours; recopila datos del viajero para cotizar y reservar.',
  },
  {
    id: 'office_services',
    icon: 'ph-briefcase',
    label: 'Oficina / servicios profesionales',
    desc: 'Consultoría, contable, legal, arquitectura. Explica servicios, honorarios y agenda citas.',
  },
  {
    id: 'screen_printing',
    icon: 'ph-t-shirt',
    label: 'Serigrafía / estampado',
    desc: 'Cotiza playeras, técnicas (serigrafía, DTF, vinil, sublimación), tirajes y tiempos.',
  },
  {
    id: 'carpentry',
    icon: 'ph-hammer',
    label: 'Carpintería',
    desc: 'Muebles de línea y a la medida: maderas, acabados, tiempos y anticipos.',
  },
  {
    id: 'health',
    icon: 'ph-first-aid-kit',
    label: 'Salud / clínica',
    desc: 'Explica servicios y especialidades, requisitos previos y agenda citas (sin diagnóstico).',
  },
  {
    id: 'dentist',
    icon: 'ph-tooth',
    label: 'Consultorio dental',
    desc: 'Tratamientos (limpieza, resinas, endodoncia, ortodoncia, implantes) y agenda de citas.',
  },
];

function currentBusinessType() {
  const raw = String(SETTINGS?.business_type || 'restaurant').toLowerCase().trim();
  return BUSINESS_MODELS.some((m) => m.id === raw) ? raw : 'restaurant';
}

function renderBusinessModelPicker() {
  const grid = document.getElementById('bizModelGrid');
  const hidden = document.getElementById('cfgBusinessType');
  const label = document.getElementById('bizModelCurrentLabel');
  if (!grid || !hidden) return;
  const active = currentBusinessType();
  hidden.value = active;
  grid.innerHTML = BUSINESS_MODELS.map(
    (m) => `
      <button type="button" class="biz-model-card ${m.id === active ? 'on' : ''}" data-model="${m.id}">
        <span class="biz-model-icon"><i class="ph-bold ${m.icon}"></i></span>
        <span class="biz-model-body">
          <span class="biz-model-title">${esc(m.label)}${m.tag ? ` <em class="biz-model-tag">${esc(m.tag)}</em>` : ''}</span>
          <span class="biz-model-desc">${esc(m.desc)}</span>
        </span>
        <span class="biz-model-check"><i class="ph-bold ph-check-circle"></i></span>
      </button>
    `
  ).join('');
  const activeModel = BUSINESS_MODELS.find((m) => m.id === active);
  if (label) label.textContent = activeModel ? `Actual: ${activeModel.label}` : '';
  grid.querySelectorAll('.biz-model-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      grid.querySelectorAll('.biz-model-card').forEach((el) => el.classList.remove('on'));
      btn.classList.add('on');
      hidden.value = btn.dataset.model;
      const chosen = BUSINESS_MODELS.find((m) => m.id === btn.dataset.model);
      if (label && chosen) label.textContent = `Seleccionado: ${chosen.label}`;
    });
  });
}

document.addEventListener('submit', async (e) => {
  if (!e.target || e.target.id !== 'businessTypeForm') return;
  e.preventDefault();
  const value = document.getElementById('cfgBusinessType')?.value || 'restaurant';
  const fd = new FormData();
  fd.append('business_type', value);
  try {
    await api('/api/settings', { method: 'PUT', body: fd });
    const chosen = BUSINESS_MODELS.find((m) => m.id === value);
    toast(`Modelo de negocio guardado: ${chosen ? chosen.label : value}`);
    SETTINGS = await api('/api/settings');
    renderBusinessModelPicker();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ===== Pantallas KDS ===== */
function kdsAreaIcon(name) {
  const value = String(name || '').toLowerCase();
  if (value.includes('barra') || value.includes('bebida')) return 'ph-wine';
  if (value.includes('postre') || value.includes('dulce')) return 'ph-cake';
  if (value.includes('cafe') || value.includes('café')) return 'ph-coffee';
  return 'ph-cooking-pot';
}

function kdsAbsoluteLink(area) {
  return `${location.origin}${area.link}`;
}

function kdsCategoryNames(area) {
  const selected = new Set((area.categoryIds || []).map(Number));
  return KDS_CONFIG.categories.filter((category) => selected.has(Number(category.id))).map((category) => category.name);
}

function renderKdsAreas() {
  const grid = $('#kdsAreaGrid');
  if (!grid) return;
  const areas = Array.isArray(KDS_CONFIG.areas) ? KDS_CONFIG.areas : [];
  const active = areas.filter((area) => area.active).length;
  $('#kdsAdminSummary').textContent = areas.length
    ? `${areas.length} área${areas.length === 1 ? '' : 's'} configurada${areas.length === 1 ? '' : 's'} · ${active} activa${active === 1 ? '' : 's'}`
    : 'Aún no hay áreas configuradas';
  $('#kdsQuickSetupBtn').hidden = areas.length > 0;

  if (!areas.length) {
    grid.innerHTML = `<div class="kds-admin-empty">
      <i class="ph-bold ph-monitor-play"></i>
      <h3>Conecta tu primera pantalla de preparación</h3>
      <p>Crea Cocina y Barra automáticamente o configura tus propias estaciones y decide qué productos recibe cada una.</p>
      <button class="btn btn-primary" type="button" data-kds-empty-add><i class="ph-bold ph-plus-circle"></i> Crear área KDS</button>
    </div>`;
    grid.querySelector('[data-kds-empty-add]')?.addEventListener('click', () => openKdsAreaModal());
    return;
  }

  grid.innerHTML = areas.map((area) => {
    const categoryNames = kdsCategoryNames(area);
    const productCount = (area.productIds || []).length;
    const chips = categoryNames.map((name) => `<span class="kds-route-chip">${esc(name)}</span>`).join('');
    return `<article class="kds-area-card ${area.active ? '' : 'off'}" style="--kds-color:${esc(area.color || '#f97316')}">
      <div class="kds-area-card-head">
        <span class="kds-area-card-icon"><i class="ph-bold ${kdsAreaIcon(area.name)}"></i></span>
        <div class="kds-area-card-title"><h4>${esc(area.name)}</h4><p>${area.branchName ? `<i class="ph-bold ph-storefront"></i> ${esc(area.branchName)}` : 'Todas las sucursales / general'}</p></div>
        <span class="kds-area-status">${area.active ? 'Activa' : 'Pausada'}</span>
      </div>
      <div class="kds-area-routes"><span>Recibe</span><div class="kds-route-chips">${chips || '<span class="kds-route-chip">Productos individuales</span>'}${productCount ? `<span class="kds-route-chip">+ ${productCount} producto${productCount === 1 ? '' : 's'}</span>` : ''}</div></div>
      <div class="kds-area-link"><code>${esc(kdsAbsoluteLink(area))}</code><button class="btn btn-ghost btn-icon" type="button" data-kds-copy="${area.id}" title="Copiar enlace"><i class="ph-bold ph-copy"></i></button></div>
      <div class="kds-area-card-actions">
        <a class="btn btn-primary btn-sm" href="${esc(area.link)}" target="_blank" rel="noopener"><i class="ph-bold ph-arrow-square-out"></i> Abrir pantalla</a>
        <button class="btn btn-ghost btn-sm" type="button" data-kds-edit="${area.id}"><i class="ph-bold ph-pencil-simple"></i> Configurar</button>
        <button class="btn btn-ghost btn-sm" type="button" data-kds-rotate="${area.id}" title="Invalidar el enlace anterior"><i class="ph-bold ph-arrows-clockwise"></i> Renovar link</button>
        <button class="btn btn-danger btn-icon btn-sm" type="button" data-kds-delete="${area.id}" title="Eliminar área"><i class="ph-bold ph-trash"></i></button>
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-kds-copy]').forEach((button) => button.addEventListener('click', async () => {
    const area = areas.find((item) => Number(item.id) === Number(button.dataset.kdsCopy));
    try {
      await navigator.clipboard.writeText(kdsAbsoluteLink(area));
      toast(`Enlace de ${area.name} copiado`);
    } catch { toast('No se pudo copiar el enlace', true); }
  }));
  grid.querySelectorAll('[data-kds-edit]').forEach((button) => button.addEventListener('click', () => {
    openKdsAreaModal(areas.find((item) => Number(item.id) === Number(button.dataset.kdsEdit)));
  }));
  grid.querySelectorAll('[data-kds-rotate]').forEach((button) => button.addEventListener('click', async () => {
    const area = areas.find((item) => Number(item.id) === Number(button.dataset.kdsRotate));
    const ok = await askConfirm('¿Renovar enlace KDS?', `El enlace anterior de ${area.name} dejará de funcionar.`, { yesLabel: '<i class="ph-bold ph-arrows-clockwise"></i> Sí, renovar' });
    if (!ok) return;
    await api(`/api/kds/${area.id}/rotate-token`, { method: 'POST' });
    toast('Enlace renovado');
    await loadKds();
  }));
  grid.querySelectorAll('[data-kds-delete]').forEach((button) => button.addEventListener('click', async () => {
    const area = areas.find((item) => Number(item.id) === Number(button.dataset.kdsDelete));
    const ok = await askConfirm('¿Eliminar área KDS?', `Se eliminará ${area.name} y su historial de preparación.`, { yesLabel: '<i class="ph-bold ph-trash"></i> Sí, eliminar' });
    if (!ok) return;
    await api(`/api/kds/${area.id}`, { method: 'DELETE' });
    toast('Área KDS eliminada');
    await loadKds();
  }));
}

function renderKdsProductPicker(filter = '') {
  const picker = $('#kdsProductPicker');
  if (!picker) return;
  const query = String(filter || '').trim().toLowerCase();
  const products = KDS_CONFIG.products.filter((product) => !query || String(product.name || '').toLowerCase().includes(query));
  picker.innerHTML = products.length
    ? products.map((product) => `<label class="kds-check-option"><input type="checkbox" value="${product.id}" ${KDS_PRODUCT_SELECTED.has(Number(product.id)) ? 'checked' : ''} /><span>${esc(product.name)}</span></label>`).join('')
    : '<span class="hint">No se encontraron productos.</span>';
}

function openKdsAreaModal(area = null) {
  $('#kdsAreaModalTitle').innerHTML = area
    ? '<i class="ph-bold ph-pencil-simple"></i> Configurar área KDS'
    : '<i class="ph-bold ph-monitor-play"></i> Nueva área KDS';
  $('#kdsAreaId').value = area?.id || '';
  $('#kdsAreaName').value = area?.name || '';
  $('#kdsAreaColor').value = area?.color || '#f97316';
  $('#kdsAreaActive').checked = area ? Boolean(area.active) : true;
  $('#kdsAreaBranch').innerHTML = ['<option value="">Todas / sin sucursal</option>']
    .concat(KDS_CONFIG.branches.map((branch) => `<option value="${branch.id}">${esc(branch.name)}</option>`)).join('');
  $('#kdsAreaBranch').value = area?.branchId ? String(area.branchId) : '';
  const selectedCategories = new Set((area?.categoryIds || []).map(Number));
  $('#kdsCategoryPicker').innerHTML = KDS_CONFIG.categories.length
    ? KDS_CONFIG.categories.map((category) => `<label class="kds-check-option"><input type="checkbox" value="${category.id}" ${selectedCategories.has(Number(category.id)) ? 'checked' : ''} /><span>${esc(category.name)}</span></label>`).join('')
    : '<span class="hint">Primero crea categorías en Productos.</span>';
  $('#kdsProductSearch').value = '';
  KDS_PRODUCT_SELECTED = new Set((area?.productIds || []).map(Number));
  $('#kdsProductPicker').innerHTML = '';
  renderKdsProductPicker();
  $('#kdsAreaModal').classList.add('show');
  setTimeout(() => $('#kdsAreaName')?.focus(), 50);
}

async function loadKds() {
  KDS_CONFIG = await api('/api/kds');
  renderKdsAreas();
}

$('#kdsAddAreaBtn')?.addEventListener('click', () => openKdsAreaModal());
$('#kdsRefreshBtn')?.addEventListener('click', () => loadKds().catch((error) => toast(error.message, true)));
$('#kdsAreaCancel')?.addEventListener('click', () => $('#kdsAreaModal').classList.remove('show'));
$('#kdsProductSearch')?.addEventListener('input', (event) => renderKdsProductPicker(event.target.value));
$('#kdsProductPicker')?.addEventListener('change', (event) => {
  const input = event.target.closest('input[type="checkbox"]');
  if (!input) return;
  const id = Number(input.value);
  if (input.checked) KDS_PRODUCT_SELECTED.add(id);
  else KDS_PRODUCT_SELECTED.delete(id);
});
$('#kdsSelectAllCategories')?.addEventListener('click', () => {
  const inputs = [...document.querySelectorAll('#kdsCategoryPicker input[type="checkbox"]')];
  const shouldSelect = inputs.some((input) => !input.checked);
  inputs.forEach((input) => { input.checked = shouldSelect; });
});
$('#kdsQuickSetupBtn')?.addEventListener('click', async () => {
  try {
    await api('/api/kds/setup/defaults', { method: 'POST' });
    toast('Áreas Cocina y Barra configuradas');
    await loadKds();
  } catch (error) { toast(error.message, true); }
});
$('#kdsAreaForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = Number($('#kdsAreaId').value || 0);
  const categoryIds = [...document.querySelectorAll('#kdsCategoryPicker input:checked')].map((input) => Number(input.value));
  const productIds = [...KDS_PRODUCT_SELECTED];
  try {
    await api(id ? `/api/kds/${id}` : '/api/kds', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#kdsAreaName').value,
        branchId: $('#kdsAreaBranch').value || null,
        color: $('#kdsAreaColor').value,
        active: $('#kdsAreaActive').checked,
        categoryIds,
        productIds,
      }),
    });
    $('#kdsAreaModal').classList.remove('show');
    toast(id ? 'Área KDS actualizada' : 'Área KDS creada');
    await loadKds();
  } catch (error) { toast(error.message, true); }
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

function cashiersTableHTML(rows, branches = []) {
  const assignedBranchIds = new Set(rows.map((cashier) => Number(cashier.branchId)));
  const missingBranches = branches.filter((branch) => Number(branch.active) !== 0 && !assignedBranchIds.has(Number(branch.id)));
  if (!rows.length && !missingBranches.length) return emptyHTML('ph-users-three', 'Aún no hay cajeros', 'Crea un cajero por sucursal para abrir una caja dedicada con su propia liga.');
  const cashierRows = rows.map((cashier) => `
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
  const missingRows = missingBranches.map((branch) => `
    <tr>
      <td><b>Sin cajero asignado</b><div style="font-size:12px;color:var(--ink-3)">Configura un acceso independiente</div></td>
      <td><span class="cashier-chip"><i class="ph-bold ph-storefront"></i>${esc(branch.name)}</span></td>
      <td><span class="hint">Sin liga</span></td>
      <td><span class="badge b-pendiente">Pendiente</span></td>
      <td style="text-align:right"><button class="btn btn-primary" type="button" data-create-cashier-branch="${esc(String(branch.id))}"><i class="ph-bold ph-user-plus"></i> Crear acceso</button></td>
    </tr>`).join('');
  return `<table><thead><tr><th>Cajero</th><th>Sucursal</th><th>Liga de caja</th><th>Estatus</th><th style="text-align:right">Acciones</th></tr></thead><tbody>${cashierRows}${missingRows}</tbody></table>`;
}

async function loadCashiers() {
  if (isCashierUser()) return;
  await ensureBranchesLoaded();
  CASHIERS = await api('/api/cashiers');
  const host = $('#cashiersTable');
  if (!host) return;
  host.innerHTML = cashiersTableHTML(CASHIERS, BRANCHES);
  document.querySelectorAll('[data-copy-cashier-link]').forEach((button) =>
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(cashierLinkUrl(button.dataset.copyCashierLink));
      toast('Liga de caja copiada');
    })
  );
  document.querySelectorAll('[data-edit-cashier]').forEach((button) =>
    button.addEventListener('click', () => openCashierModal(CASHIERS.find((item) => Number(item.id) === Number(button.dataset.editCashier))))
  );
  document.querySelectorAll('[data-create-cashier-branch]').forEach((button) =>
    button.addEventListener('click', () => openCashierModal(null, Number(button.dataset.createCashierBranch)))
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

function openCashierModal(cashier = null, branchId = null) {
  $('#cashierModalTitle').innerHTML = cashier
    ? '<i class="ph-bold ph-pencil-simple"></i> Editar cajero'
    : '<i class="ph-bold ph-user-plus"></i> Nuevo cajero';
  $('#cashierId').value = cashier ? cashier.id : '';
  $('#cashierDisplayName').value = cashier ? cashier.displayName : '';
  $('#cashierUsername').value = cashier ? cashier.username : '';
  $('#cashierSlug').value = cashier ? cashier.cashierSlug : '';
  $('#cashierPassword').value = '';
  $('#cashierActive').checked = cashier ? Boolean(cashier.active) : true;
  syncCashierBranchOptions(cashier?.branchId ? String(cashier.branchId) : (branchId ? String(branchId) : ''));
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

  [ME, SETTINGS] = await Promise.all([
    api('/api/auth/me'),
    api('/api/settings'),
  ]);
  if (ME?.role === 'cashier') setAuthScope('cashier');
  if (ME?.role === 'owner') setAuthScope('owner');
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
  startTenantClock();
  renderInstructions();
  loadOrderSoundPreference();
  syncOrdersSoundToggleUI();
  startOrdersRealtimeMonitor();

  if (navigateToHash) {
    const fallbackView = cashier ? 'pos' : 'dashboard';
    const hashView = (location.hash || '').slice(1);
    const view = normalizeView(hashView || fallbackView);
    document.body.setAttribute('data-current-view', view);
    navigate(view);
  }
  if (!cashier && ME.onboardingRequired) setTimeout(openOnboardingIntro, 180);
}
$('#cfgTimezone')?.addEventListener('change', updateTimezonePreview);

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
let INV_BRANCH = 'all';
let INV_BRANCHES = [];

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
    params.set('branch', INV_BRANCH);
    const path = params.toString() ? `/api/inventory?${params.toString()}` : '/api/inventory';
    const payload = await api(path);
    INV_DATA = Array.isArray(payload) ? payload : (payload.rows || []);
    INV_BRANCHES = payload.branches || INV_BRANCHES;
    const branchSelect = $('#invBranchFilter');
    if (branchSelect) {
      branchSelect.innerHTML = '<option value="all">Global · todas las sucursales</option>' + INV_BRANCHES.map((row)=>`<option value="${row.id}">${esc(row.name)}${row.active?'':' · Inactiva'}</option>`).join('');
      branchSelect.value = INV_BRANCH;
    }
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
    tbody.innerHTML = `<tr><td colspan="11" class="empty-cell">Sin resultados</td></tr>`;
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
      <td class="num inv-col-compras">${invFmt(r.compras || 0)}</td>
      <td class="num">${Number(r.traslados||0)>0?'+':''}${invFmt(r.traslados||0)}</td>
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
  const scope = INV_BRANCH === 'all' ? 'Global consolidado' : (INV_BRANCHES.find((row)=>String(row.id)===String(INV_BRANCH))?.name || 'Sucursal');
  if (INV_PERIOD === 'custom' && INV_START_DATE && INV_END_DATE) {
    hint.textContent = `${scope} · mostrando del ${INV_START_DATE} al ${INV_END_DATE}.`;
    return;
  }
  hint.textContent = `${scope} · ${INV_PERIOD_HINTS[INV_PERIOD] || INV_PERIOD_HINTS.all}`;
}

$('#invBranchFilter')?.addEventListener('change', async (event) => {
  INV_BRANCH = String(event.target.value || 'all'); INV_PAGE = 1; await loadInventarios();
});

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
    ? (INV_BRANCH==='all'?'Aplicar físico real a inventario inicial':'Aplicar conteo al stock de sucursal')
    : (logAdjustment ? 'Cierre de periodo con ajuste auditable' : 'Aplicar físico real a inicial (global)');
  const msg = isSingle
    ? (INV_BRANCH==='all'?'Se actualizará el inventario inicial del producto con su último físico real. ¿Continuar?':'Se ajustará la existencia de esta sucursal al último conteo físico y se guardará en auditoría. ¿Continuar?')
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
    if (INV_BRANCH !== 'all') payload.branch_id = Number(INV_BRANCH);
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

function invSelectedBranchId() {
  const selected = INV_BRANCHES.find((row)=>String(row.id)===String(INV_BRANCH));
  if (selected?.active) return Number(selected.id);
  return Number(INV_BRANCHES.find((row)=>row.active)?.id || 0);
}
function invBranchOptions(selected = invSelectedBranchId()) {
  return INV_BRANCHES.filter((row)=>row.active).map((row)=>`<option value="${row.id}" ${Number(row.id)===Number(selected)?'selected':''}>${esc(row.name)}</option>`).join('');
}

function buildInvMovHistFilter() {
  const sel = $('#invMovHistFilter');
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos los productos</option>' +
    INV_PRODUCTS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

/* ── Modal: inventario inicial ── */
function openInvInitModal(productId) {
  if (INV_BRANCH === 'all') return toast('Selecciona una sucursal para editar su inventario inicial', true);
  if (!INV_BRANCHES.find((row)=>String(row.id)===String(INV_BRANCH))?.active) return toast('La sucursal inactiva sólo está disponible para consulta histórica', true);
  const row = INV_DATA.find((r) => r.product_id === productId);
  if (!row) return;
  $('#invInitProductId').value = productId;
  $('#invInitProductName').value = row.product_name;
  $('#invInitStock').value = row.initial_stock ?? 0;
  $('#invInitUnit').value = row.unit || 'pcs';
  $('#invInitNotes').value = '';
  $('#invInitBranch').innerHTML = invBranchOptions();
  $('#invInitBranch').disabled = true;
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
        branch_id: Number($('#invInitBranch').value),
      }),
    });
    closeModal('invInitModal');
    await loadInventarios();
    toast('Inventario inicial guardado');
  } catch (err) {
    toast(err.message || 'Error al guardar', true);
  }
});

/* ═══════════════════════════════════════════════════════════════
   MÓDULO: PRODUCTIVIDAD EMPLEADOS
═══════════════════════════════════════════════════════════════ */

/* ── Cerrar modales de empleados al hacer clic en el fondo ── */
['empEmployeeModal','empMetricModal','empSchemeModal','empAssignModal','empProfileModal'].forEach((id) => {
  const el = $(`#${id}`);
  if (el) el.addEventListener('click', (e) => { if (e.target === el) closeModal(id); });
});

/* ── Toggle de gráficas ── */
function empToggleChart(bodyId, storageKey, iconId, labelId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const willCollapse = !body.classList.contains('emp-chart-body-hidden');
  body.classList.toggle('emp-chart-body-hidden', willCollapse);
  const icon = document.getElementById(iconId);
  if (icon) icon.className = willCollapse ? 'ph-bold ph-caret-down' : 'ph-bold ph-caret-up';
  const label = document.getElementById(labelId);
  if (label) label.textContent = willCollapse ? 'Mostrar' : 'Ocultar';
  try { localStorage.setItem(storageKey, willCollapse ? '1' : '0'); } catch {}
}
globalThis.empToggleChart = empToggleChart;

function empInitChartToggle(bodyId, storageKey, iconId, labelId) {
  try {
    if (localStorage.getItem(storageKey) === '1') {
      const body = document.getElementById(bodyId);
      if (body) body.classList.add('emp-chart-body-hidden');
      const icon = document.getElementById(iconId);
      if (icon) icon.className = 'ph-bold ph-caret-down';
      const label = document.getElementById(labelId);
      if (label) label.textContent = 'Mostrar';
    }
  } catch {}
}

/* ── Estado ── */
let EMP_EMPLOYEES = [];
let EMP_BRANCHES = [];
let EMP_METRICS = [];
let EMP_SCHEMES = [];
let EMP_ASSIGNMENTS = [];
let EMP_RECORDS = [];
let EMP_COMMISSION_RECORDS = [];
let EMP_INSIGHTS = [];
let EMP_INSIGHT_SUMMARY = [];
let EMP_INSIGHT_MAP = new Map();
let EMP_INSIGHT_SUMMARY_MAP = new Map();
let EMP_HISTORY_CACHE = new Map();
let EMP_HISTORY_FILTERS = new Map();
let EMP_TAB = 'team';
let EMP_TEAM_CHART = null;
let EMP_EVOLUTION_CHART = null;
let EMP_TIERS = [];

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function empCurrentPeriod() {
  const year = parseInt($('#empYearSel')?.value) || new Date().getFullYear();
  const month = parseInt($('#empMonthSel')?.value) || (new Date().getMonth() + 1);
  return { year, month };
}

function empFmt(n) {
  return fmtMoney(n);
}

function empAvatar(emp) {
  const initials = String(emp.name || '?').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  return `<span class="emp-avatar" style="background:${esc(emp.avatar_color || '#6c47ff')}">${esc(initials)}</span>`;
}

function empIndexBadge(val) {
  if (val === null || val === undefined) return '<span class="emp-badge emp-badge-gray">Sin datos</span>';
  const n = Math.round(Number(val));
  let cls = 'emp-badge-red';
  if (n >= 90) cls = 'emp-badge-green';
  else if (n >= 70) cls = 'emp-badge-yellow';
  else if (n >= 50) cls = 'emp-badge-orange';
  return `<span class="emp-badge ${cls}">${n}%</span>`;
}

function empStatusBadge(status) {
  const map = { pending: ['Pendiente','emp-badge-gray'], approved: ['Aprobada','emp-badge-yellow'], paid: ['Pagada','emp-badge-green'] };
  const [label, cls] = map[status] || ['Desconocido','emp-badge-gray'];
  return `<span class="emp-badge ${cls}">${label}</span>`;
}

function empInsightKey(employeeId, metricId) {
  return `${Number(employeeId)}_${Number(metricId)}`;
}

function empGetInsight(employeeId, metricId) {
  return EMP_INSIGHT_MAP.get(empInsightKey(employeeId, metricId)) || null;
}

function empGetEmployeeInsightSummary(employeeId) {
  return EMP_INSIGHT_SUMMARY_MAP.get(Number(employeeId)) || { improved: 0, declined: 0, stable: 0 };
}

function empGetMetricMonthAggregate(employeeId, metric) {
  const rows = EMP_RECORDS.filter((r) => Number(r.employee_id) === Number(employeeId) && Number(r.metric_id) === Number(metric.id));
  if (!rows.length) return 0;
  const systemValue = rows.filter((r) => r.system_generated || r.input_source === 'system').reduce((sum, row) => sum + Number(row.value || 0), 0);
  const manualValues = rows.filter((r) => !r.system_generated && r.input_source !== 'system').map((r) => Number(r.value || 0));
  const manualValue = !manualValues.length
    ? 0
    : (metric.aggregation || 'sum') === 'avg'
      ? manualValues.reduce((sum, value) => sum + value, 0) / manualValues.length
      : manualValues.reduce((sum, value) => sum + value, 0);
  if (metric.source === 'system_sales') return systemValue;
  if (metric.source === 'both') return systemValue + manualValue;
  return manualValue;
}

function empComputeEmployeeIndex(employeeId) {
  const activeMetrics = EMP_METRICS.filter((m) => m.active !== 0);
  if (!activeMetrics.length) return null;

  let totalWeight = 0;
  let weightedScore = 0;
  for (const metric of activeMetrics) {
    const target = Number(metric.target || 0);
    const weight = Number(metric.weight || 1);
    if (!Number.isFinite(target) || target <= 0) continue;

    const value = empGetMetricMonthAggregate(employeeId, metric);
    const higher = metric.higher_is_better !== 0;
    const score = higher
      ? Math.min(100, (value / target) * 100)
      : Math.max(0, 100 - (value / target) * 100);

    totalWeight += weight;
    weightedScore += score * weight;
  }

  if (!totalWeight) return null;
  return weightedScore / totalWeight;
}

function empComputeRealtimeStats() {
  const activeEmps = EMP_EMPLOYEES.filter((e) => e.active !== 0);
  const rows = activeEmps.map((emp) => ({ emp, idx: empComputeEmployeeIndex(emp.id) }));
  const valid = rows.filter((r) => r.idx !== null && Number.isFinite(r.idx));

  const avgIdx = valid.length
    ? valid.reduce((s, r) => s + r.idx, 0) / valid.length
    : null;

  let topPerformer = null;
  for (const r of valid) {
    if (!topPerformer || r.idx > topPerformer.idx) topPerformer = r;
  }

  return {
    totalEmployees: activeEmps.length,
    avgIndex: avgIdx,
    topPerformer: topPerformer ? topPerformer.emp : null,
  };
}

function empTrendVisual(insight) {
  if (!insight || insight.improvement_state === 'none' || insight.trend === 'none') {
    return { cls: 'emp-trend-none', icon: 'ph-minus', label: 'Sin tendencia', delta: '—' };
  }
  if (insight.improvement_state === 'stable') {
    return { cls: 'emp-trend-stable', icon: 'ph-arrows-left-right', label: 'Equilibrado', delta: '0%' };
  }
  if (insight.improvement_state === 'improved') {
    return {
      cls: 'emp-trend-up',
      icon: 'ph-trend-up',
      label: 'Mejora',
      delta: insight.delta_pct !== null && insight.delta_pct !== undefined ? `+${Math.abs(Math.round(insight.delta_pct))}%` : '↑',
    };
  }
  return {
    cls: 'emp-trend-down',
    icon: 'ph-trend-down',
    label: 'Oportunidad',
    delta: insight.delta_pct !== null && insight.delta_pct !== undefined ? `-${Math.abs(Math.round(insight.delta_pct))}%` : '↓',
  };
}

function empTrendBadge(insight) {
  const t = empTrendVisual(insight);
  return `<span class="emp-trend-badge ${t.cls}"><i class="ph-bold ${t.icon}"></i>${t.delta}</span>`;
}

function empTrendHint(insight, metric) {
  if (!insight || insight.improvement_state === 'none') return 'Aún sin histórico suficiente';
  const unit = metric?.unit ? ` ${metric.unit}` : '';
  const prev = insight.previous_value !== null && insight.previous_value !== undefined
    ? `${Math.round(insight.previous_value * 100) / 100}${unit}`
    : '—';
  const avg = insight.avg_recent !== null && insight.avg_recent !== undefined
    ? `${Math.round(insight.avg_recent * 100) / 100}${unit}`
    : '—';
  const t = empTrendVisual(insight);
  const baseLabel = insight.trend_scope === 'capture' ? 'Captura anterior' : 'Periodo anterior';
  return `${t.label} · ${baseLabel}: ${prev} · Promedio: ${avg}`;
}

function empHistoryKey(employeeId, metricId, year, month) {
  return `${Number(employeeId)}_${Number(metricId)}_${Number(year)}_${Number(month)}`;
}

function empHistorySourceLabel(source) {
  const map = {
    manual: 'Manual',
    sync_sales: 'Sistema ventas',
    pos_chatbot: 'POS/Chatbot',
    system: 'Sistema',
  };
  return map[String(source || '').trim()] || 'Manual';
}

function empFormatEvidenceDate(row) {
  const raw = row?.record_date || row?.created_at;
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 19).replace('T', ' ');
  return d.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

function empHistoryCompletion(value, target, higherIsBetter) {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return null;
  if (higherIsBetter) return (value / target) * 100;
  return Math.max(0, 100 - (value / target) * 100);
}

function empEvidenceDateValue(row) {
  const raw = row?.record_date || row?.created_at;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function empFilterEvidenceRows(rows, mode) {
  if (!Array.isArray(rows) || mode === 'all') return Array.isArray(rows) ? rows : [];
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (mode === 'today') {
    return rows.filter((row) => {
      const d = empEvidenceDateValue(row);
      if (!d) return false;
      return d >= startToday;
    });
  }

  if (mode === 'week') {
    const start = new Date(startToday);
    start.setDate(start.getDate() - 6);
    return rows.filter((row) => {
      const d = empEvidenceDateValue(row);
      if (!d) return false;
      return d >= start;
    });
  }

  return rows;
}

function empCsvCell(value) {
  const txt = String(value ?? '');
  return `"${txt.replace(/"/g, '""')}"`;
}

function empDownloadCsv(filename, rows) {
  const bom = '\uFEFF';
  const csv = bom + rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function empRenderEvidenceRows(rows, metric) {
  if (!rows.length) {
    return '<div class="emp-rec-evidence-empty">Sin capturas de evidencia en este periodo.</div>';
  }
  const target = Number(metric.target) || 0;
  const unit = String(metric.unit || '').trim();
  const higherIsBetter = metric.higher_is_better !== 0;

  return rows.map((row) => {
    const value = Number(row.value);
    const completion = empHistoryCompletion(value, target, higherIsBetter);
    const completionTxt = completion === null ? '—' : `${Math.round(completion)}%`;
    const sourceLbl = empHistorySourceLabel(row.input_source);
    const valueTxt = `${Math.round(value * 100) / 100}${unit ? ` ${unit}` : ''}`;
    const targetTxt = `${Math.round(target * 100) / 100}${unit ? ` ${unit}` : ''}`;
    const notesTxt = String(row.notes || '').trim();

    return `<div class="emp-rec-evidence-row">
      <div class="emp-rec-evidence-top">
        <span class="emp-rec-evidence-date"><i class="ph-bold ph-calendar-blank"></i> ${esc(empFormatEvidenceDate(row))}</span>
        <span class="emp-rec-evidence-source">${esc(sourceLbl)}</span>
      </div>
      <div class="emp-rec-evidence-meta">
        <span>Captura: <b>${esc(valueTxt)}</b></span>
        <span>Meta: <b>${esc(targetTxt || '—')}</b></span>
        <span>Cumplimiento: <b>${esc(completionTxt)}</b></span>
      </div>
      ${notesTxt ? `<div class="emp-rec-evidence-notes">${esc(notesTxt)}</div>` : ''}
    </div>`;
  }).join('');
}

function empRenderEvidencePanel(rows, metric, ctx, mode) {
  const filtered = empFilterEvidenceRows(rows, mode);
  const countTxt = `${filtered.length}/${rows.length}`;
  return `
    <div class="emp-rec-evidence-wrap"
      data-cache-key="${esc(ctx.cacheKey)}"
      data-emp-name="${esc(ctx.employeeName || '')}"
      data-metric-name="${esc(ctx.metricName || '')}"
      data-year="${ctx.year}"
      data-month="${ctx.month}"
      data-target="${Number(metric.target) || 0}"
      data-unit="${esc(metric.unit || '')}"
      data-higher="${metric.higher_is_better !== 0 ? '1' : '0'}">
      <div class="emp-rec-evidence-toolbar">
        <div class="emp-rec-evidence-tools-left">
          <select class="emp-rec-evidence-filter" onchange="empSetMetricEvidenceFilter(this)">
            <option value="all" ${mode === 'all' ? 'selected' : ''}>Todo el periodo</option>
            <option value="week" ${mode === 'week' ? 'selected' : ''}>Ultimos 7 dias</option>
            <option value="today" ${mode === 'today' ? 'selected' : ''}>Hoy</option>
          </select>
          <span class="emp-rec-evidence-count">${countTxt}</span>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" onclick="empExportMetricEvidence(this)">
          <i class="ph-bold ph-file-xls"></i> Exportar CSV
        </button>
      </div>
      <div class="emp-rec-evidence-list">${empRenderEvidenceRows(filtered, metric)}</div>
    </div>`;
}

function empGetEvidenceCtxFromWrap(wrap) {
  if (!wrap) return null;
  const cacheKey = String(wrap.dataset.cacheKey || '');
  if (!cacheKey) return null;
  const metric = {
    target: Number(wrap.dataset.target || 0),
    unit: String(wrap.dataset.unit || ''),
    higher_is_better: wrap.dataset.higher === '1' ? 1 : 0,
  };
  return {
    cacheKey,
    metric,
    employeeName: String(wrap.dataset.empName || ''),
    metricName: String(wrap.dataset.metricName || ''),
    year: Number(wrap.dataset.year || 0),
    month: Number(wrap.dataset.month || 0),
  };
}

function empSetMetricEvidenceFilter(selectEl) {
  const wrap = selectEl.closest('.emp-rec-evidence-wrap');
  const ctx = empGetEvidenceCtxFromWrap(wrap);
  if (!ctx) return;
  const mode = String(selectEl.value || 'all');
  EMP_HISTORY_FILTERS.set(ctx.cacheKey, mode);

  const rows = EMP_HISTORY_CACHE.get(ctx.cacheKey) || [];
  const filtered = empFilterEvidenceRows(rows, mode);
  const list = wrap.querySelector('.emp-rec-evidence-list');
  if (list) list.innerHTML = empRenderEvidenceRows(filtered, ctx.metric);
  const count = wrap.querySelector('.emp-rec-evidence-count');
  if (count) count.textContent = `${filtered.length}/${rows.length}`;
}
globalThis.empSetMetricEvidenceFilter = empSetMetricEvidenceFilter;

function empExportMetricEvidence(buttonEl) {
  const wrap = buttonEl.closest('.emp-rec-evidence-wrap');
  const ctx = empGetEvidenceCtxFromWrap(wrap);
  if (!ctx) return;

  const mode = EMP_HISTORY_FILTERS.get(ctx.cacheKey) || 'all';
  const rows = EMP_HISTORY_CACHE.get(ctx.cacheKey) || [];
  const filtered = empFilterEvidenceRows(rows, mode);
  if (!filtered.length) {
    toast('No hay evidencia para exportar con ese filtro', true);
    return;
  }

  const target = Number(ctx.metric.target) || 0;
  const unit = String(ctx.metric.unit || '').trim();
  const csvRows = [[
    'Empleado', 'Metrica', 'Fecha', 'Fuente', 'Captura', 'Meta', 'Cumplimiento', 'Notas', 'Periodo',
  ]];

  filtered.forEach((row) => {
    const value = Number(row.value || 0);
    const completion = empHistoryCompletion(value, target, ctx.metric.higher_is_better !== 0);
    const valueTxt = `${Math.round(value * 100) / 100}${unit ? ` ${unit}` : ''}`;
    const targetTxt = `${Math.round(target * 100) / 100}${unit ? ` ${unit}` : ''}`;
    const completionTxt = completion === null ? '—' : `${Math.round(completion)}%`;
    csvRows.push([
      empCsvCell(ctx.employeeName),
      empCsvCell(ctx.metricName),
      empCsvCell(empFormatEvidenceDate(row)),
      empCsvCell(empHistorySourceLabel(row.input_source)),
      empCsvCell(valueTxt),
      empCsvCell(targetTxt),
      empCsvCell(completionTxt),
      empCsvCell(String(row.notes || '').trim()),
      empCsvCell(`${MONTHS_ES[Math.max(0, ctx.month - 1)] || ''} ${ctx.year}`),
    ]);
  });

  const safeEmp = String(ctx.employeeName || 'empleado').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const safeMetric = String(ctx.metricName || 'metrica').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const filename = `evidencia-${safeEmp}-${safeMetric}-${ctx.year}-${String(ctx.month).padStart(2, '0')}.csv`;
  empDownloadCsv(filename, csvRows);
  toast('Evidencia exportada (CSV)');
}
globalThis.empExportMetricEvidence = empExportMetricEvidence;

async function empLoadMetricEvidence(head, body) {
  const { year, month } = empCurrentPeriod();
  const employeeId = Number(head.dataset.emp || 0);
  const metricId = Number(head.dataset.metric || 0);
  if (!employeeId || !metricId) return;

  const metric = {
    target: Number(head.dataset.target || 0),
    unit: String(head.dataset.unit || ''),
    higher_is_better: head.dataset.higher === '1' ? 1 : 0,
  };

  const cacheKey = empHistoryKey(employeeId, metricId, year, month);
  const mode = EMP_HISTORY_FILTERS.get(cacheKey) || 'all';
  const ctx = {
    cacheKey,
    employeeName: String(head.dataset.empName || ''),
    metricName: String(head.dataset.metricName || ''),
    year,
    month,
  };
  const cached = EMP_HISTORY_CACHE.get(cacheKey);
  if (cached) {
    body.innerHTML = empRenderEvidencePanel(cached, metric, ctx, mode);
    return;
  }

  body.innerHTML = '<div class="emp-rec-evidence-empty">Cargando evidencia...</div>';
  try {
    const rows = await api(`/api/employees/productivity/history?employee_id=${employeeId}&metric_id=${metricId}&year=${year}&month=${month}`);
    const normalizedRows = Array.isArray(rows) ? rows : [];
    EMP_HISTORY_CACHE.set(cacheKey, normalizedRows);
    body.innerHTML = empRenderEvidencePanel(normalizedRows, metric, ctx, mode);

    const countEl = head.querySelector('.emp-rec-hist-count');
    if (countEl) countEl.textContent = String(normalizedRows.length);
  } catch {
    body.innerHTML = '<div class="emp-rec-evidence-empty">No se pudo cargar la evidencia.</div>';
  }
}

async function empToggleMetricEvidence(head) {
  const body = head.nextElementSibling;
  if (!body) return;

  const isHidden = body.hidden;
  body.hidden = !body.hidden;

  const arrow = head.querySelector('.emp-rec-hist-arrow');
  if (arrow) arrow.className = `ph-bold ${body.hidden ? 'ph-caret-down' : 'ph-caret-up'} emp-rec-hist-arrow`;
  if (!isHidden) return;

  await empLoadMetricEvidence(head, body);
}
globalThis.empToggleMetricEvidence = empToggleMetricEvidence;

async function empLoadInsights() {
  const { year, month } = empCurrentPeriod();
  const data = await api(`/api/employees/productivity/insights?year=${year}&month=${month}`);
  EMP_INSIGHTS = Array.isArray(data?.insights) ? data.insights : [];
  EMP_INSIGHT_SUMMARY = Array.isArray(data?.employee_summary) ? data.employee_summary : [];
  EMP_INSIGHT_MAP = new Map(EMP_INSIGHTS.map((x) => [empInsightKey(x.employee_id, x.metric_id), x]));
  EMP_INSIGHT_SUMMARY_MAP = new Map(EMP_INSIGHT_SUMMARY.map((x) => [Number(x.employee_id), x]));
}

/* ── Init del módulo ── */
async function loadEmpleados() {
  empInitPeriodSelectors();
  empSwitchTab(EMP_TAB || 'team');
  await empLoadAll();
}

function empInitPeriodSelectors() {
  const now = new Date();
  const ySel = $('#empYearSel');
  const mSel = $('#empMonthSel');
  if (!ySel || !mSel) return;

  if (!ySel.children.length) {
    const curYear = now.getFullYear();
    for (let y = curYear - 2; y <= curYear + 1; y++) {
      ySel.innerHTML += `<option value="${y}" ${y === curYear ? 'selected' : ''}>${y}</option>`;
    }
    MONTHS_ES.forEach((m, i) => {
      mSel.innerHTML += `<option value="${i + 1}" ${i + 1 === now.getMonth() + 1 ? 'selected' : ''}>${m}</option>`;
    });

    ySel.addEventListener('change', () => empLoadAll());
    mSel.addEventListener('change', () => empLoadAll());
  }
}

async function empLoadAll() {
  const { year, month } = empCurrentPeriod();
  try {
    [EMP_EMPLOYEES, EMP_METRICS, EMP_SCHEMES, EMP_ASSIGNMENTS, EMP_BRANCHES] = await Promise.all([
      api('/api/employees'),
      api('/api/employees/metrics'),
      api('/api/employees/commission-schemes'),
      api('/api/employees/commission-assignments'),
      api('/api/branches'),
    ]);
    [EMP_RECORDS, EMP_COMMISSION_RECORDS] = await Promise.all([
      api(`/api/employees/productivity?year=${year}&month=${month}`),
      api(`/api/employees/commission-records?year=${year}&month=${month}`),
    ]);
    try {
      await empLoadInsights();
    } catch {
      EMP_INSIGHTS = [];
      EMP_INSIGHT_SUMMARY = [];
      EMP_INSIGHT_MAP = new Map();
      EMP_INSIGHT_SUMMARY_MAP = new Map();
    }
    EMP_HISTORY_CACHE = new Map();
    EMP_HISTORY_FILTERS = new Map();
  } catch (err) {
    toast(err.message || 'Error cargando empleados', true);
    return;
  }
  await empLoadQuickStats();
  empRenderCurrentTab();
}

async function empLoadQuickStats() {
  const realtime = empComputeRealtimeStats();
  const totalCommissions = EMP_COMMISSION_RECORDS.reduce((s, r) => s + Number(r.commission_amount || 0), 0);

  $('#empKpiTotal').textContent = String(realtime.totalEmployees || 0);
  $('#empKpiIndex').textContent = realtime.avgIndex !== null ? `${Math.round(realtime.avgIndex)}%` : '—';
  $('#empKpiComm').textContent = totalCommissions ? empFmt(totalCommissions) : '$0.00';
  $('#empKpiTop').textContent = realtime.topPerformer?.name || '—';
}

/* ── Tabs ── */
function empSwitchTab(tab) {
  EMP_TAB = tab;
  document.querySelectorAll('#empTabs button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.empTab === tab);
  });
  document.querySelectorAll('.emp-panel').forEach((p) => { p.hidden = true; });
  const panel = document.getElementById('empPanel' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (panel) panel.hidden = false;
  empRenderCurrentTab();
}

document.querySelectorAll('#empTabs button').forEach((btn) => {
  btn.addEventListener('click', () => empSwitchTab(btn.dataset.empTab));
});

function empRenderCurrentTab() {
  switch (EMP_TAB) {
    case 'team': empRenderTeam(); break;
    case 'records': empRenderRecords(); break;
    case 'commissions': empRenderCommissions(); break;
    case 'config': empRenderConfig(); break;
  }
}

/* ══ Panel: Equipo ══ */
function empRenderTeam() {
  const { year, month } = empCurrentPeriod();
  const periodLabel = `${MONTHS_ES[month - 1]} ${year}`;
  if ($('#empChartPeriodLabel')) $('#empChartPeriodLabel').textContent = periodLabel;

  const activeEmps = EMP_EMPLOYEES.filter((e) => e.active !== 0);
  const activeMetrics = EMP_METRICS.filter((m) => m.active !== 0).slice(0, 4);

  const empData = activeEmps.map((emp) => {
    const commRec = EMP_COMMISSION_RECORDS.filter((c) => c.employee_id === emp.id);
    const idx = empComputeEmployeeIndex(emp.id);
    const totalComm = commRec.reduce((s, c) => s + (c.commission_amount || 0), 0);
    const empRecs = EMP_RECORDS.filter((r) => r.employee_id === emp.id);
    return { emp, idx, totalComm, empRecs };
  });

  // Chart barras
  const canvas = $('#empTeamChart');
  if (canvas) {
    if (EMP_TEAM_CHART) { EMP_TEAM_CHART.destroy(); EMP_TEAM_CHART = null; }
    const labels = empData.map((d) => d.emp.name.split(' ')[0]);
    const values = empData.map((d) => d.idx !== null ? Math.round(d.idx) : 0);
    const colors = empData.map((d) => d.emp.avatar_color || '#6c47ff');
    EMP_TEAM_CHART = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Índice de productividad (%)',
          data: values,
          backgroundColor: colors.map((c) => c + 'cc'),
          borderColor: colors,
          borderWidth: 2,
          borderRadius: 8,
        }],
      },
      options: {
        responsive: true,
        scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `Productividad: ${ctx.raw}%` } },
        },
      },
    });
    empInitChartToggle('empTeamChartBody', 'emp_team_chart', 'empTeamChartToggleIcon', 'empTeamChartToggleLabel');
  }

  // Cards grid
  const wrap = $('#empTeamTable');
  if (!wrap) return;
  if (!empData.length) {
    wrap.innerHTML = `<div class="emp-empty-state"><i class="ph-fill ph-user-plus" style="color:#6c47ff"></i><p>No hay empleados activos.<br>Crea el primero con <b>+ Nuevo empleado</b>.</p></div>`;
    return;
  }

  wrap.innerHTML = `<div class="emp-team-grid">
    ${empData.map(({ emp, idx, totalComm, empRecs }) => {
      const initials = emp.name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
      const color = emp.avatar_color || '#6c47ff';
      const pct = idx !== null ? Math.round(idx) : null;
      const idxColor = pct === null ? '#9aa1b5' : pct >= 90 ? '#16a34a' : pct >= 70 ? '#d97706' : pct >= 50 ? '#f97316' : '#dc2626';

      const metricsHtml = activeMetrics.length
        ? activeMetrics.map((m) => {
            const insight = empGetInsight(emp.id, m.id);
            const metricRows = empRecs.filter((r) => r.metric_id === m.id);
            const hasMetricData = metricRows.length > 0;
            const val = m.source !== 'manual'
              ? empGetMetricMonthAggregate(emp.id, m)
              : insight && insight.current_value !== null && insight.current_value !== undefined
              ? Number(insight.current_value)
              : empGetMetricMonthAggregate(emp.id, m);
            const target = Number(m.target) || 1;
            const barPct = m.higher_is_better !== 0
              ? Math.min(100, Math.round((val / target) * 100))
              : Math.max(0, 100 - Math.round((val / target) * 100));
            return `<div class="emp-metric-progress">
              <div class="emp-metric-progress-head">
                <span>${esc(m.name)}</span>
                <span class="emp-metric-progress-val">${val !== 0 || hasMetricData ? val + (m.unit ? '\u00a0' + esc(m.unit) : '') : '—'} ${empTrendBadge(insight)}</span>
              </div>
              <div class="emp-progress-track">
                <div class="emp-progress-fill" style="width:${barPct}%;background:${color}80"></div>
              </div>
              <div class="emp-metric-trend-hint">${esc(empTrendHint(insight, m))}</div>
            </div>`;
          }).join('')
        : `<div style="font-size:12px;color:var(--ink-3);padding:4px 0">Configura métricas en <b>Configurar</b></div>`;

      const summary = empGetEmployeeInsightSummary(emp.id);
      const summaryHtml = `<div class="emp-scoreline">
        <span class="emp-score-up"><i class="ph-bold ph-trend-up"></i> ${summary.improved || 0} mejora${(summary.improved || 0) === 1 ? '' : 's'}</span>
        <span class="emp-score-stable"><i class="ph-bold ph-arrows-left-right"></i> ${summary.stable || 0} estable${(summary.stable || 0) === 1 ? '' : 's'}</span>
        <span class="emp-score-down"><i class="ph-bold ph-trend-down"></i> ${summary.declined || 0} oportunidad${(summary.declined || 0) === 1 ? '' : 'es'}</span>
      </div>`;

      return `<div class="emp-emp-card">
        <div class="emp-emp-card-top" style="background:linear-gradient(135deg,${color}18,${color}06);border-top:3px solid ${color}">
          <div style="display:flex;align-items:center;gap:14px">
            <div class="emp-emp-card-avatar-wrap">
              <span class="emp-avatar emp-avatar-xl" style="background:${color}">${esc(initials)}</span>
              ${pct !== null ? `<span class="emp-idx-pill" style="background:${idxColor}">${pct}%</span>` : ''}
            </div>
            <div class="emp-emp-card-info">
              <div class="emp-emp-card-name">${esc(emp.name)}</div>
              <div class="emp-emp-card-meta">${esc(emp.position || '—')}</div>
              ${emp.department ? `<div class="emp-emp-card-dept">${esc(emp.department)}</div>` : ''}
              <div class="emp-emp-card-branch"><i class="ph-bold ph-storefront"></i> ${esc(emp.branch_name || 'Sin sucursal asignada')}</div>
            </div>
          </div>
        </div>
        <div class="emp-emp-card-metrics">${metricsHtml}</div>
        <div class="emp-emp-card-footer">
          <div>
            <div class="emp-comm-total" style="color:${color}">${empFmt(totalComm)}</div>
            <div class="emp-comm-label">Comisión del mes</div>
            ${summaryHtml}
          </div>
          <div class="emp-emp-card-actions">
            <button class="btn btn-ghost btn-sm" onclick="empOpenProfile(${emp.id})" title="Ver perfil"><i class="ph-bold ph-chart-line-up"></i></button>
            <button class="btn btn-ghost btn-sm" onclick="empOpenEmployeeModal(${emp.id})" title="Editar"><i class="ph-bold ph-pencil"></i></button>
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

$('#empAddBtn')?.addEventListener('click', () => empOpenEmployeeModal());
$('#empRefreshBtn')?.addEventListener('click', () => empLoadAll());
$('#empPrintTeamBtn')?.addEventListener('click', () => empPrintTeam());

/* ══ Panel: Registrar Métricas ══ */
const EMP_PERIOD_LABELS = {
  monthly: 'Mensual', biweekly: 'Quincenal', weekly: 'Semanal', daily: 'Diaria',
};
const EMP_PERIOD_HINTS = {
  monthly: 'Ingresa el valor total del mes.',
  biweekly: 'Ingresa un valor por quincena (se acumula en el mes).',
  weekly: 'Ingresa un valor por semana (se acumula en el mes).',
  daily: 'Ingresa el valor del día seleccionado (se acumula en el mes).',
};

function empRecordDate(periodType) {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function empRenderRecords() {
  const { year, month } = empCurrentPeriod();
  const wrap = $('#empRecordsWrap');
  if (!wrap) return;

  const activeEmps = EMP_EMPLOYEES.filter((e) => e.active !== 0);
  const activeMetrics = EMP_METRICS.filter((m) => m.active !== 0);

  if (!activeMetrics.length) {
    wrap.innerHTML = `<div class="emp-empty-state"><i class="ph-fill ph-sliders" style="color:#6c47ff"></i><p>Configura primero las métricas en la pestaña <b>Configurar</b>.</p></div>`;
    return;
  }
  if (!activeEmps.length) {
    wrap.innerHTML = `<div class="emp-empty-state"><i class="ph-fill ph-user-plus" style="color:#6c47ff"></i><p>Aún no hay empleados activos. Crea uno en la pestaña <b>Equipo</b>.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="emp-records-header-bar">
      <div class="emp-records-header-info">
        <i class="ph-bold ph-clipboard-text"></i>
        <div>
          <b>Registro de métricas — ${MONTHS_ES[month - 1]} ${year}</b>
          <div style="font-size:12px;color:var(--ink-3);margin-top:2px">Escribe el valor y presiona <kbd>Enter</kbd> o el botón <i class="ph-bold ph-check"></i></div>
        </div>
      </div>
    </div>
    <div class="emp-record-emps">
      ${activeEmps.map((emp) => {
        const empRecs = EMP_RECORDS.filter((r) => r.employee_id === emp.id);
        const initials = emp.name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
        const color = emp.avatar_color || '#6c47ff';
        return `<div class="emp-record-emp-section">
          <div class="emp-record-emp-header" style="border-left:4px solid ${color}">
            <span class="emp-avatar emp-avatar-md" style="background:${color}">${esc(initials)}</span>
            <div>
              <b>${esc(emp.name)}</b>
              ${emp.position ? `<span class="emp-record-emp-pos">${esc(emp.position)}</span>` : ''}
              <span class="emp-record-emp-branch"><i class="ph-bold ph-storefront"></i> ${esc(emp.branch_name || 'Sin sucursal')}</span>
            </div>
          </div>
          <div class="emp-record-metrics-grid">
            ${activeMetrics.map((m) => {
              const insight = empGetInsight(emp.id, m.id);
              const isMonthly = !m.period_type || m.period_type === 'monthly';
              const canType = m.source !== 'system_sales';
              const periodLabel = EMP_PERIOD_LABELS[m.period_type] || 'Mensual';
              const aggLabel = m.aggregation === 'avg' ? 'Promedio' : 'Suma';
              const aggHint = isMonthly ? '' : ` · ${aggLabel} del mes`;

              // Para métricas mensuales: mostrar valor acumulado
              const allRecs = empRecs.filter((r) => r.metric_id === m.id);
              const systemRecs = allRecs.filter((r) => r.system_generated || r.input_source === 'system');
              const manualRecs = allRecs.filter((r) => !r.system_generated && r.input_source !== 'system');

              // Calcular valor acumulado del mes según aggregation
              const currentVal = allRecs.length ? empGetMetricMonthAggregate(emp.id, m) : null;
              const manualVals = manualRecs.map((r) => Number(r.value));
              const manualVal = !manualVals.length ? null : m.aggregation === 'avg'
                ? manualVals.reduce((s, v) => s + v, 0) / manualVals.length
                : manualVals.reduce((s, v) => s + v, 0);
              const systemVal = systemRecs.reduce((sum, row) => sum + Number(row.value || 0), 0);

              const barPct = currentVal !== null && m.target
                ? Math.min(100, Math.round((currentVal / Number(m.target)) * 100))
                : null;

              const defaultDate = empRecordDate(m.period_type);
              const inputId = `empRec_${emp.id}_${m.id}`;
              const dateId = `empRecDate_${emp.id}_${m.id}`;

              return `<div class="emp-record-metric-card${canType ? '' : ' emp-record-metric-auto'}">
                <div class="emp-record-metric-card-top">
                  <span class="emp-record-metric-name">${esc(m.name)}</span>
                  <span class="emp-badge ${m.source === 'manual' ? 'emp-badge-gray' : 'emp-badge-indigo'}">${m.source === 'manual' ? 'Manual' : m.source === 'system_sales' ? 'Sistema' : 'Mixta'}</span>
                </div>
                <div class="emp-record-metric-meta">
                  Meta: <b>${m.target}${m.unit ? '\u00a0' + esc(m.unit) : ''}</b>
                  <span class="emp-period-chip">${periodLabel}${aggHint}</span>
                </div>
                ${!isMonthly ? `<div class="field" style="margin:0 0 6px">
                  <input type="date" id="${dateId}" class="emp-date-input"
                    data-emp="${emp.id}" data-metric="${m.id}"
                    value="${defaultDate}" max="${defaultDate}" />
                </div>` : ''}
                <div class="emp-record-input-group">
                  <input
                    type="number" min="0" step="0.01"
                    class="emp-record-input" id="${inputId}"
                    data-emp="${emp.id}" data-metric="${m.id}"
                    data-monthly="${isMonthly ? '1' : '0'}"
                    value="${isMonthly && manualVal !== null ? manualVal : ''}"
                    placeholder="${canType ? '0' : 'automático'}"
                    ${canType ? '' : 'readonly'}
                    onkeydown="if(event.key==='Enter'){event.preventDefault();empSaveRecord(this)}"
                  />
                  <div class="emp-record-input-actions">
                    ${canType ? `<button class="btn btn-primary btn-xs emp-save-rec-btn" onclick="empSaveRecord(document.getElementById('${inputId}'))" title="Guardar"><i class="ph-bold ph-check"></i></button>` : ''}
                    ${m.source !== 'manual' ? `<button class="btn btn-ghost btn-xs" onclick="empSyncSales(${m.id},${emp.id})" title="Importar del sistema"><i class="ph-bold ph-arrows-clockwise"></i></button>` : ''}
                  </div>
                </div>
                ${m.source !== 'manual' ? `<div class="hint" style="margin:7px 0 0"><i class="ph-bold ph-storefront"></i> Sistema: <b>${empFmt(systemVal)}</b>${m.source === 'both' ? ` · Total con ajuste: <b>${empFmt(currentVal || 0)}</b>` : ''}</div>` : ''}
                ${barPct !== null ? `
                  <div class="emp-record-metric-prog">
                    <div class="emp-progress-track emp-progress-sm"><div class="emp-progress-fill" style="width:${barPct}%;background:${color}"></div></div>
                    <span class="emp-record-metric-pct">${barPct}%${currentVal !== null ? ` (${Math.round(currentVal * 100) / 100}${m.unit ? '\u00a0' + esc(m.unit) : ''})` : ''}</span>
                  </div>` : ''}
                <div class="emp-record-trend-row">
                  ${empTrendBadge(insight)}
                  <span>${esc(empTrendHint(insight, m))}</span>
                </div>
                <div class="emp-rec-history">
                  <div class="emp-rec-history-head"
                    data-emp="${emp.id}"
                    data-metric="${m.id}"
                    data-emp-name="${esc(emp.name)}"
                    data-metric-name="${esc(m.name)}"
                    data-target="${Number(m.target) || 0}"
                    data-unit="${esc(m.unit || '')}"
                    data-higher="${m.higher_is_better !== 0 ? '1' : '0'}"
                    onclick="empToggleMetricEvidence(this)">
                    <i class="ph-bold ph-clock-clockwise"></i> Evidencia manual (<span class="emp-rec-hist-count">${manualRecs.length}</span>)
                    <i class="ph-bold ph-caret-down emp-rec-hist-arrow"></i>
                  </div>
                  <div class="emp-rec-history-body" hidden></div>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

async function empSaveRecord(input, source = 'manual') {
  const empId = input.dataset.emp;
  const metricId = input.dataset.metric;
  const isMonthly = input.dataset.monthly === '1';
  const { year, month } = empCurrentPeriod();
  const value = parseFloat(input.value);
  if (!isFinite(value)) { toast('Ingresa un valor numérico válido', true); return; }

  let body = { employee_id: empId, metric_id: metricId, year, month, value, input_source: source };

  if (!isMonthly) {
    const dateInput = document.getElementById(`empRecDate_${empId}_${metricId}`);
    const record_date = dateInput?.value;
    if (!record_date) { toast('Selecciona la fecha del registro', true); return; }
    body.record_date = record_date;
  }

  try {
    input.classList.add('emp-saving');
    await api('/api/employees/productivity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    input.classList.remove('emp-saving');
    input.classList.add('emp-saved');
    setTimeout(() => input.classList.remove('emp-saved'), 1400);

    // Actualizar cache local
    if (isMonthly) {
      const idx = EMP_RECORDS.findIndex((r) => r.employee_id == empId && r.metric_id == metricId && !r.record_date && !r.system_generated && r.input_source !== 'system');
      if (idx >= 0) { EMP_RECORDS[idx].value = value; EMP_RECORDS[idx].input_source = source; }
      else EMP_RECORDS.push({ employee_id: Number(empId), metric_id: Number(metricId), value, record_date: null, input_source: source });
    } else {
      const rd = body.record_date;
      const idx = EMP_RECORDS.findIndex((r) => r.employee_id == empId && r.metric_id == metricId && r.record_date === rd);
      if (idx >= 0) { EMP_RECORDS[idx].value = value; EMP_RECORDS[idx].input_source = source; }
      else EMP_RECORDS.push({ employee_id: Number(empId), metric_id: Number(metricId), value, record_date: rd, input_source: source });
    }

    // Recalcular barra de progreso en la tarjeta
    const m = EMP_METRICS.find((x) => x.id == metricId);
    const emp = EMP_EMPLOYEES.find((e) => e.id == empId);
    const color = emp?.avatar_color || '#6c47ff';
    const card = input.closest('.emp-record-metric-card');
    if (m && m.target && card) {
      const allRecs = EMP_RECORDS.filter((r) => r.employee_id == empId && r.metric_id == metricId);
      const vals = allRecs.map((r) => Number(r.value));
      const agg = m.aggregation === 'avg' ? vals.reduce((s, v) => s + v, 0) / vals.length : vals.reduce((s, v) => s + v, 0);
      const barPct = Math.min(100, Math.round((agg / Number(m.target)) * 100));
      let progEl = card.querySelector('.emp-record-metric-prog');
      if (!progEl) {
        card.insertAdjacentHTML('beforeend', `<div class="emp-record-metric-prog"><div class="emp-progress-track emp-progress-sm"><div class="emp-progress-fill" style="width:0%;background:${color}"></div></div><span class="emp-record-metric-pct">0%</span></div>`);
        progEl = card.querySelector('.emp-record-metric-prog');
      }
      progEl.querySelector('.emp-progress-fill').style.width = barPct + '%';
      progEl.querySelector('.emp-record-metric-pct').textContent = `${barPct}% (${Math.round(agg * 100) / 100}${m.unit ? '\u00a0' + m.unit : ''})`;
    }

    const historyKey = empHistoryKey(empId, metricId, year, month);
    EMP_HISTORY_CACHE.delete(historyKey);
    EMP_HISTORY_FILTERS.delete(historyKey);
    const headEl = card?.querySelector('.emp-rec-history-head');
    const histBody = card?.querySelector('.emp-rec-history-body');
    if (headEl && histBody && !histBody.hidden) {
      await empLoadMetricEvidence(headEl, histBody);
    }

    try {
      await empLoadInsights();
      if (EMP_TAB === 'team' || EMP_TAB === 'records') empRenderCurrentTab();
    } catch {}

    await empLoadQuickStats();

    toast('Registro guardado');
  } catch (err) {
    input.classList.remove('emp-saving');
    toast(err.message || 'Error al guardar', true);
  }
}

async function empSyncSales(metricId, empId) {
  const { year, month } = empCurrentPeriod();
  try {
    const data = await api('/api/employees/productivity/sync-sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metric_id: metricId, employee_id: empId, year, month }),
    });
    await empLoadAll();
    toast(`Ventas de ${data.branch_name}: ${empFmt(data.total_sales)} (${data.order_count} pedido${data.order_count !== 1 ? 's' : ''})`);
  } catch (err) {
    toast(err.message || 'Error al sincronizar ventas', true);
  }
}

/* ══ Panel: Comisiones ══ */
function empRenderCommissions() {
  const { year, month } = empCurrentPeriod();
  if ($('#empCommYearLabel')) $('#empCommYearLabel').textContent = String(year);

  empRenderEvolutionChart(year);

  const wrap = $('#empCommTable');
  if (!wrap) return;

  if (!EMP_COMMISSION_RECORDS.length) {
    wrap.innerHTML = `<div class="emp-empty-state"><i class="ph-fill ph-calculator" style="color:#6c47ff"></i><p>No hay comisiones calculadas para <b>${MONTHS_ES[month - 1]} ${year}</b>.<br>Registra métricas y usa <b>Calcular comisiones</b>.</p></div>`;
    return;
  }

  const statusMap = {
    pending: ['Pendiente', '#9aa1b5', '#f3f4f6'],
    approved: ['Aprobada', '#d97706', '#fdf3e0'],
    paid: ['Pagada', '#16a34a', '#e8f8ee'],
  };

  wrap.innerHTML = `<div class="emp-comm-cards">
    ${EMP_COMMISSION_RECORDS.map((cr) => {
      const emp = EMP_EMPLOYEES.find((e) => e.id === cr.employee_id);
      const color = emp?.avatar_color || '#6c47ff';
      const initials = emp ? emp.name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2) : '?';
      const pct = cr.productivity_index !== null ? Math.round(cr.productivity_index) : 0;
      const idxColor = pct >= 90 ? '#16a34a' : pct >= 70 ? '#d97706' : pct >= 50 ? '#f97316' : '#dc2626';
      const [statusLabel, statusTxt, statusBg] = statusMap[cr.status] || ['Desconocido', '#9aa1b5', '#f3f4f6'];
      return `<div class="emp-comm-card" style="border-top:3px solid ${color}">
        <div class="emp-comm-card-header">
          <span class="emp-avatar emp-avatar-md" style="background:${color}">${esc(initials)}</span>
          <div class="emp-comm-card-name">
            <b>${esc(cr.employee_name)}</b>
            ${emp?.position ? `<span>${esc(emp.position)}</span>` : ''}
          </div>
          <span class="emp-comm-card-status-pill" style="background:${statusBg};color:${statusTxt}">${statusLabel}</span>
        </div>
        <div class="emp-comm-card-body">
          <div class="emp-comm-card-idx">
            <div class="emp-comm-idx-label">Índice de productividad</div>
            <div class="emp-progress-track emp-progress-lg" style="margin:6px 0">
              <div class="emp-progress-fill" style="width:${pct}%;background:linear-gradient(90deg,${idxColor}aa,${idxColor})"></div>
            </div>
            <div class="emp-comm-idx-val" style="color:${idxColor}">${pct}%</div>
          </div>
          <div class="emp-comm-card-amounts">
            <div class="emp-comm-card-amount-row">
              <span>Base de cálculo</span><span>${empFmt(cr.base_value)}</span>
            </div>
            <div class="emp-comm-card-amount-main">
              <span>Comisión</span>
              <span style="color:${color};font-size:18px;font-weight:800">${empFmt(cr.commission_amount)}</span>
            </div>
            ${cr.scheme_name ? `<div class="emp-comm-card-scheme">${esc(cr.scheme_name)}</div>` : ''}
          </div>
        </div>
        <div class="emp-comm-card-actions">
          ${cr.status === 'pending' ? `<button class="btn btn-primary btn-sm" onclick="empUpdateCommStatus(${cr.id},'approved')"><i class="ph-bold ph-check"></i> Aprobar</button>` : ''}
          ${cr.status === 'approved' ? `<button class="btn btn-primary btn-sm" onclick="empUpdateCommStatus(${cr.id},'paid')"><i class="ph-bold ph-money"></i> Marcar pagada</button>` : ''}
          ${cr.status === 'paid' ? `<span style="color:var(--green);font-size:13px;font-weight:700"><i class="ph-fill ph-check-circle"></i> Pagada</span>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

async function empRenderEvolutionChart(year) {
  try {
    const data = await api(`/api/employees/reports/team?year=${year}&month=1`);
    const teamHistory = data.team_history || [];
    const canvas = $('#empEvolutionChart');
    if (!canvas) return;

    if (EMP_EVOLUTION_CHART) { EMP_EVOLUTION_CHART.destroy(); EMP_EVOLUTION_CHART = null; }

    const series = MONTHS_ES.map((_, i) => {
      const rec = teamHistory.find((h) => h.period_month === i + 1);
      return rec ? Math.round(rec.avg_index) : null;
    });

    EMP_EVOLUTION_CHART = new Chart(canvas, {
      type: 'line',
      data: {
        labels: MONTHS_ES.map((m) => m.slice(0, 3)),
        datasets: [{
          label: 'Productividad promedio equipo (%)',
          data: series,
          borderColor: '#6c47ff',
          backgroundColor: 'rgba(108,71,255,0.12)',
          tension: 0.4,
          pointRadius: 5,
          pointHoverRadius: 7,
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `Productividad: ${ctx.raw !== null ? ctx.raw + '%' : 'Sin datos'}` } },
        },
      },
    });
    empInitChartToggle('empEvoChartBody', 'emp_evo_chart', 'empEvoChartToggleIcon', 'empEvoChartToggleLabel');
  } catch {}
}

$('#empCalcBtn')?.addEventListener('click', async () => {
  const { year, month } = empCurrentPeriod();
  const ok = await askConfirm(
    'Calcular comisiones',
    `¿Calcular comisiones para ${MONTHS_ES[month - 1]} ${year}? Los registros existentes se actualizarán.`,
    { yesLabel: '<i class="ph-bold ph-calculator"></i> Calcular', noLabel: 'Cancelar' }
  );
  if (!ok) return;
  try {
    const result = await api('/api/employees/commission-records/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month }),
    });
    toast(`Comisiones calculadas para ${result.results.length} empleado(s)`);
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error al calcular comisiones', true);
  }
});

async function empUpdateCommStatus(id, status) {
  try {
    await api(`/api/employees/commission-records/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    toast(status === 'approved' ? 'Comisión aprobada' : 'Comisión marcada como pagada');
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error', true);
  }
}
globalThis.empUpdateCommStatus = empUpdateCommStatus;

/* ══ Panel: Configurar ══ */
function empRenderConfig() {
  empRenderMetricsList();
  empRenderSchemesList();
  empRenderAssignTable();
}

function empRenderMetricsList() {
  const wrap = $('#empMetricsList');
  if (!wrap) return;
  if (!EMP_METRICS.length) {
    wrap.innerHTML = '<div class="hint">Sin métricas configuradas. Crea una nueva.</div>';
    return;
  }
  wrap.innerHTML = EMP_METRICS.map((m) => `
    <div class="emp-metric-row ${m.active === 0 ? 'emp-inactive' : ''}">
      <div class="emp-metric-info">
        <b>${esc(m.name)}</b>
        <span class="emp-metric-meta">
          Meta: ${m.target}${esc(m.unit)} · Peso: ${m.weight} · ${m.source === 'manual' ? 'Manual' : m.source === 'system_sales' ? 'Sistema' : 'Sistema+Manual'}
          · ${m.higher_is_better ? 'Mayor=Mejor' : 'Menor=Mejor'}
          ${m.active === 0 ? ' · <em>Inactiva</em>' : ''}
        </span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="empOpenMetricModal(${m.id})"><i class="ph-bold ph-pencil"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="empToggleMetric(${m.id},${m.active === 0 ? 1 : 0})">
          <i class="ph-bold ${m.active === 0 ? 'ph-eye' : 'ph-eye-slash'}"></i>
        </button>
      </div>
    </div>`).join('');
}

function empRenderSchemesList() {
  const wrap = $('#empSchemesList');
  if (!wrap) return;
  const TYPE_LABELS = {
    percentage: 'Porcentaje',
    fixed: 'Monto fijo',
    tiered: 'Escalonado',
    productivity_bonus: 'Bono productividad',
  };
  if (!EMP_SCHEMES.length) {
    wrap.innerHTML = '<div class="hint">Sin esquemas configurados. Crea uno nuevo.</div>';
    return;
  }
  wrap.innerHTML = EMP_SCHEMES.map((s) => `
    <div class="emp-metric-row ${s.active === 0 ? 'emp-inactive' : ''}">
      <div class="emp-metric-info">
        <b>${esc(s.name)}</b>
        <span class="emp-metric-meta">${TYPE_LABELS[s.type] || s.type}${s.description ? ' · ' + esc(s.description) : ''}${s.active === 0 ? ' · <em>Inactivo</em>' : ''}</span>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="empOpenSchemeModal(${s.id})"><i class="ph-bold ph-pencil"></i></button>
      </div>
    </div>`).join('');
}

function empRenderAssignTable() {
  const wrap = $('#empAssignTable');
  if (!wrap) return;
  if (!EMP_ASSIGNMENTS.length) {
    wrap.innerHTML = '<div class="hint" style="padding:16px">Sin asignaciones. Asigna un esquema de comisión a cada empleado.</div>';
    return;
  }
  wrap.innerHTML = `
    <table class="emp-table">
      <thead><tr><th>Empleado</th><th>Esquema</th><th>Métrica vinculada</th><th></th></tr></thead>
      <tbody>
        ${EMP_ASSIGNMENTS.map((a) => `<tr>
          <td>${esc(a.employee_name)}</td>
          <td>${esc(a.scheme_name)}</td>
          <td>${esc(a.metric_name || 'Índice global')}</td>
          <td><button class="btn btn-ghost btn-sm" onclick="empDeleteAssign(${a.id})"><i class="ph-bold ph-trash"></i></button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

/* ── Modales: Empleado ── */
function empBranchOptions(selected = '') {
  const selectedId = String(selected || '');
  const rows = EMP_BRANCHES.filter((branch) => branch.active || String(branch.id) === selectedId);
  return '<option value="">Selecciona una sucursal…</option>' + rows.map((branch) => `<option value="${branch.id}" ${String(branch.id) === selectedId ? 'selected' : ''}>${esc(branch.name)}${branch.active ? '' : ' · Inactiva'}</option>`).join('');
}

function empOpenEmployeeModal(id) {
  if (!id && !EMP_BRANCHES.some((branch) => branch.active)) return toast('Primero crea o activa una sucursal para asignar al empleado', true);
  const emp = id ? EMP_EMPLOYEES.find((e) => Number(e.id) === Number(id)) : null;
  $('#empEmpId').value = emp ? emp.id : '';
  $('#empEmployeeModalTitle').innerHTML = emp
    ? '<i class="ph-bold ph-user-gear"></i> Editar empleado'
    : '<i class="ph-bold ph-user-plus"></i> Nuevo empleado';
  $('#empEmpName').value = emp?.name || '';
  $('#empEmpPosition').value = emp?.position || '';
  $('#empEmpDepartment').value = emp?.department || '';
  $('#empEmpHireDate').value = emp?.hire_date ? String(emp.hire_date).slice(0, 10) : '';
  $('#empEmpSalary').value = emp?.salary_base || '';
  $('#empEmpPhone').value = emp?.phone || '';
  $('#empEmpEmail').value = emp?.email || '';
  $('#empEmpBranch').innerHTML = empBranchOptions(emp?.branch_id);
  $('#empEmpBranch').value = emp?.branch_id ? String(emp.branch_id) : '';
  $('#empEmpNotes').value = emp?.notes || '';
  const color = emp?.avatar_color || '#6c47ff';
  $('#empEmpColor').value = color;
  document.querySelectorAll('.emp-color-dot').forEach((d) => d.classList.toggle('selected', d.dataset.color === color));
  openModal('empEmployeeModal');
}
globalThis.empOpenEmployeeModal = empOpenEmployeeModal;

document.querySelectorAll('.emp-color-dot').forEach((dot) => {
  dot.addEventListener('click', () => {
    document.querySelectorAll('.emp-color-dot').forEach((d) => d.classList.remove('selected'));
    dot.classList.add('selected');
    $('#empEmpColor').value = dot.dataset.color;
  });
});

$('#empEmployeeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#empEmpId').value;
  const body = {
    name: $('#empEmpName').value,
    position: $('#empEmpPosition').value,
    department: $('#empEmpDepartment').value,
    hire_date: $('#empEmpHireDate').value || null,
    salary_base: $('#empEmpSalary').value || 0,
    phone: $('#empEmpPhone').value,
    email: $('#empEmpEmail').value,
    branch_id: Number($('#empEmpBranch').value),
    notes: $('#empEmpNotes').value,
    avatar_color: $('#empEmpColor').value || '#6c47ff',
  };
  try {
    if (id) {
      await api(`/api/employees/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      await api('/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    closeModal('empEmployeeModal');
    toast(id ? 'Empleado actualizado' : 'Empleado creado');
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error al guardar', true);
  }
});

/* ── Modales: Métrica ── */
const EMP_METRIC_PRESETS = {
  sales: {
    name: 'Ventas', unit: '$', target: 10000, weight: 3,
    source: 'both', higher_is_better: '1', period_type: 'monthly', aggregation: 'sum',
  },
  attendance: {
    name: 'Asistencia', unit: 'días', target: 26, weight: 2,
    source: 'manual', higher_is_better: '1', period_type: 'monthly', aggregation: 'sum',
  },
  punctuality: {
    name: 'Puntualidad', unit: '%', target: 100, weight: 1,
    source: 'manual', higher_is_better: '1', period_type: 'daily', aggregation: 'avg',
  },
  quality: {
    name: 'Calidad de servicio', unit: 'puntos', target: 10, weight: 2,
    source: 'manual', higher_is_better: '1', period_type: 'weekly', aggregation: 'avg',
  },
  objectives: {
    name: 'Objetivos cumplidos', unit: '%', target: 100, weight: 2,
    source: 'manual', higher_is_better: '1', period_type: 'monthly', aggregation: 'sum',
  },
};

function empNormalizeMetricSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'system_sales' || source === 'system' || source === 'sales') return 'system_sales';
  if (['both', 'mixed', 'mixta', 'system_manual', 'system+manual'].includes(source)) return 'both';
  return 'manual';
}

function empFillMetricForm(preset) {
  if (!preset) return;
  const has = (key) => Object.prototype.hasOwnProperty.call(preset, key);
  if (has('name')) $('#empMetricName').value = preset.name ?? '';
  if (has('unit')) $('#empMetricUnit').value = preset.unit ?? '';
  if (has('target')) $('#empMetricTarget').value = preset.target ?? 100;
  if (has('weight')) $('#empMetricWeight').value = preset.weight ?? 1;
  if (has('source')) $('#empMetricSource').value = empNormalizeMetricSource(preset.source);
  if (has('higher_is_better')) $('#empMetricHigher').value = Number(preset.higher_is_better) === 0 ? '0' : '1';
  if (has('period_type')) $('#empMetricPeriodType').value = ['monthly','biweekly','weekly','daily'].includes(preset.period_type) ? preset.period_type : 'monthly';
  if (has('aggregation')) $('#empMetricAggregation').value = preset.aggregation === 'avg' ? 'avg' : 'sum';
  empUpdateAggWrap();
}

function empUpdateAggWrap() {
  const pt = $('#empMetricPeriodType')?.value;
  const wrap = $('#empMetricAggWrap');
  if (wrap) wrap.style.opacity = pt === 'monthly' ? '0.45' : '1';
}

document.querySelectorAll('.emp-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = EMP_METRIC_PRESETS[btn.dataset.preset];
    if (preset) empFillMetricForm(preset);
    document.querySelectorAll('.emp-preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

$('#empMetricPeriodType')?.addEventListener('change', empUpdateAggWrap);

function empOpenMetricModal(id) {
  const m = id ? EMP_METRICS.find((x) => Number(x.id) === Number(id)) : null;
  $('#empMetricId').value = m ? m.id : '';
  $('#empMetricModalTitle').innerHTML = m
    ? '<i class="ph-bold ph-pencil"></i> Editar métrica'
    : '<i class="ph-bold ph-sliders"></i> Nueva métrica';
  document.querySelectorAll('.emp-preset-btn').forEach((b) => b.classList.remove('active'));
  const values = m ? {
    name: m.name,
    unit: m.unit,
    target: m.target,
    weight: m.weight,
    source: m.source,
    higher_is_better: m.higher_is_better,
    period_type: m.period_type,
    aggregation: m.aggregation,
  } : {
    name: '', unit: '', target: 100, weight: 1, source: 'manual',
    higher_is_better: 1, period_type: 'monthly', aggregation: 'sum',
  };
  empFillMetricForm(values);
  openModal('empMetricModal');
}
globalThis.empOpenMetricModal = empOpenMetricModal;

$('#empAddMetricBtn')?.addEventListener('click', () => empOpenMetricModal());

$('#empMetricForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#empMetricId').value;
  const target = Number($('#empMetricTarget').value);
  const weight = Number($('#empMetricWeight').value);
  const body = {
    name: $('#empMetricName').value,
    unit: $('#empMetricUnit').value,
    target: Number.isFinite(target) ? target : 100,
    weight: Number.isFinite(weight) ? weight : 1,
    source: empNormalizeMetricSource($('#empMetricSource').value),
    higher_is_better: $('#empMetricHigher').value === '1' ? 1 : 0,
    period_type: $('#empMetricPeriodType').value || 'monthly',
    aggregation: $('#empMetricAggregation').value || 'sum',
  };
  try {
    if (id) {
      await api(`/api/employees/metrics/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      await api('/api/employees/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    closeModal('empMetricModal');
    toast(id ? 'Métrica actualizada' : 'Métrica creada');
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error al guardar', true);
  }
});

async function empToggleMetric(id, newActive) {
  try {
    const metric = EMP_METRICS.find((m) => m.id === id);
    if (!metric) return;
    await api(`/api/employees/metrics/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...metric, active: newActive }),
    });
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error', true);
  }
}
globalThis.empToggleMetric = empToggleMetric;

/* ── Modales: Esquema ── */
function empOpenSchemeModal(id) {
  const s = id ? EMP_SCHEMES.find((x) => x.id === id) : null;
  EMP_TIERS = (s?.config?.tiers ? JSON.parse(JSON.stringify(s.config.tiers)) : []);
  $('#empSchemeId').value = s ? s.id : '';
  $('#empSchemeModalTitle').innerHTML = s
    ? '<i class="ph-bold ph-pencil"></i> Editar esquema'
    : '<i class="ph-bold ph-percent"></i> Nuevo esquema';
  $('#empSchemeName').value = s?.name || '';
  $('#empSchemeType').value = s?.type || 'percentage';
  $('#empSchemeDesc').value = s?.description || '';
  const cfg = s?.config || {};
  $('#empSchemePct').value = cfg.percentage ?? 5;
  $('#empSchemeFixed').value = cfg.fixed_amount ?? 0;
  $('#empSchemeFixedMinIdx').value = cfg.min_productivity ?? 70;
  $('#empSchemeBonusAmount').value = cfg.bonus_amount ?? 0;
  $('#empSchemeBonusMinIdx').value = cfg.min_index ?? 80;
  empSchemeTypeChanged($('#empSchemeType').value);
  empRenderTiers();
  openModal('empSchemeModal');
}
globalThis.empOpenSchemeModal = empOpenSchemeModal;

function empSchemeTypeChanged(type) {
  document.querySelectorAll('.emp-scheme-config').forEach((el) => el.hidden = true);
  const map = { percentage: 'empSchemeConfigPercentage', fixed: 'empSchemeConfigFixed', tiered: 'empSchemeConfigTiered', productivity_bonus: 'empSchemeConfigBonus' };
  const el = document.getElementById(map[type]);
  if (el) el.hidden = false;
}

$('#empSchemeType')?.addEventListener('change', (e) => empSchemeTypeChanged(e.target.value));

$('#empAddSchemeBtn')?.addEventListener('click', () => empOpenSchemeModal());

$('#empAddTierBtn')?.addEventListener('click', () => {
  EMP_TIERS.push({ min: 0, max: 9999999, percentage: 5 });
  empRenderTiers();
});

function empRenderTiers() {
  const wrap = $('#empTiersWrap');
  if (!wrap) return;
  if (!EMP_TIERS.length) { wrap.innerHTML = '<div class="hint">Sin rangos. Agrega al menos uno.</div>'; return; }
  wrap.innerHTML = EMP_TIERS.map((tier, i) => `
    <div class="emp-tier-row">
      <div class="field" style="margin:0"><label>Mín</label><input type="number" min="0" step="0.01" class="emp-tier-min" data-idx="${i}" value="${tier.min ?? 0}" /></div>
      <div class="field" style="margin:0"><label>Máx</label><input type="number" min="0" step="0.01" class="emp-tier-max" data-idx="${i}" value="${tier.max === Infinity ? '' : (tier.max ?? '')}" placeholder="Sin límite" /></div>
      <div class="field" style="margin:0"><label>% Comisión</label><input type="number" min="0" step="0.01" class="emp-tier-pct" data-idx="${i}" value="${tier.percentage ?? 0}" /></div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="empRemoveTier(${i})"><i class="ph-bold ph-trash"></i></button>
    </div>`).join('');

  document.querySelectorAll('.emp-tier-min').forEach((el) => el.addEventListener('input', (e) => { EMP_TIERS[Number(e.target.dataset.idx)].min = Number(e.target.value); }));
  document.querySelectorAll('.emp-tier-max').forEach((el) => el.addEventListener('input', (e) => { EMP_TIERS[Number(e.target.dataset.idx)].max = e.target.value === '' ? Infinity : Number(e.target.value); }));
  document.querySelectorAll('.emp-tier-pct').forEach((el) => el.addEventListener('input', (e) => { EMP_TIERS[Number(e.target.dataset.idx)].percentage = Number(e.target.value); }));
}

function empRemoveTier(idx) {
  EMP_TIERS.splice(idx, 1);
  empRenderTiers();
}
globalThis.empRemoveTier = empRemoveTier;

$('#empSchemeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#empSchemeId').value;
  const type = $('#empSchemeType').value;
  let config = {};
  if (type === 'percentage') config = { percentage: parseFloat($('#empSchemePct').value) || 0 };
  else if (type === 'fixed') config = { fixed_amount: parseFloat($('#empSchemeFixed').value) || 0, min_productivity: parseFloat($('#empSchemeFixedMinIdx').value) || 0 };
  else if (type === 'tiered') config = { tiers: EMP_TIERS };
  else if (type === 'productivity_bonus') config = { bonus_amount: parseFloat($('#empSchemeBonusAmount').value) || 0, min_index: parseFloat($('#empSchemeBonusMinIdx').value) || 0 };

  const body = { name: $('#empSchemeName').value, type, config, description: $('#empSchemeDesc').value };
  try {
    if (id) {
      await api(`/api/employees/commission-schemes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } else {
      await api('/api/employees/commission-schemes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    closeModal('empSchemeModal');
    toast(id ? 'Esquema actualizado' : 'Esquema creado');
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error al guardar', true);
  }
});

/* ── Modales: Asignación ── */
$('#empAddAssignBtn')?.addEventListener('click', () => {
  const empSel = $('#empAssignEmployee');
  const schemeSel = $('#empAssignScheme');
  const metricSel = $('#empAssignMetric');
  if (!empSel || !schemeSel || !metricSel) return;

  empSel.innerHTML = EMP_EMPLOYEES.filter((e) => e.active !== 0).map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  schemeSel.innerHTML = EMP_SCHEMES.filter((s) => s.active !== 0).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  metricSel.innerHTML = '<option value="">Sin métrica específica (usa índice global)</option>' +
    EMP_METRICS.filter((m) => m.active !== 0).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  openModal('empAssignModal');
});

$('#empAssignForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    employee_id: parseInt($('#empAssignEmployee').value),
    scheme_id: parseInt($('#empAssignScheme').value),
    metric_id: $('#empAssignMetric').value ? parseInt($('#empAssignMetric').value) : null,
  };
  try {
    await api('/api/employees/commission-assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    closeModal('empAssignModal');
    toast('Asignación creada');
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error al asignar', true);
  }
});

async function empDeleteAssign(id) {
  const ok = await askConfirm('Eliminar asignación', '¿Eliminar esta asignación de comisión?', { yesLabel: '<i class="ph-bold ph-trash"></i> Eliminar' });
  if (!ok) return;
  try {
    await api(`/api/employees/commission-assignments/${id}`, { method: 'DELETE' });
    toast('Asignación eliminada');
    await empLoadAll();
  } catch (err) {
    toast(err.message || 'Error', true);
  }
}
globalThis.empDeleteAssign = empDeleteAssign;
globalThis.empSyncSales = empSyncSales;
globalThis.empSaveRecord = empSaveRecord;

/* ── Perfil individual ── */
async function empOpenProfile(empId) {
  const { year } = empCurrentPeriod();
  try {
    const data = await api(`/api/employees/reports/individual/${empId}?year=${year}`);
    const emp = data.employee;
    const monthlySeries = data.monthly_series || [];
    const totalComm = data.commissions.reduce((s, c) => s + (c.commission_amount || 0), 0);

    const avgIdx = (() => {
      const valid = monthlySeries.filter((m) => m.productivity_index !== null);
      return valid.length ? Math.round(valid.reduce((s, m) => s + m.productivity_index, 0) / valid.length) : null;
    })();

    const initials = emp.name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 2);
    const empObj = EMP_EMPLOYEES.find((e) => e.id === empId) || emp;

    const profileHtml = `
      <div class="emp-profile-header">
        <span class="emp-avatar emp-avatar-lg" style="background:${esc(empObj.avatar_color || '#6c47ff')}">${esc(initials)}</span>
        <div>
          <h3 style="margin:0">${esc(emp.name)}</h3>
          <div style="color:var(--ink-2);font-size:14px">${esc(emp.position || '')} ${emp.department ? '· ' + esc(emp.department) : ''}</div>
        </div>
      </div>
      <div class="emp-profile-kpis">
        <div class="emp-kpi-card"><div class="emp-kpi-icon" style="background:linear-gradient(135deg,#6c47ff,#8b5cf6)"><i class="ph-fill ph-trend-up"></i></div><div><div class="emp-kpi-val">${avgIdx !== null ? avgIdx + '%' : '—'}</div><div class="emp-kpi-lbl">Productividad promedio ${year}</div></div></div>
        <div class="emp-kpi-card"><div class="emp-kpi-icon" style="background:linear-gradient(135deg,#f59e0b,#d97706)"><i class="ph-fill ph-coins"></i></div><div><div class="emp-kpi-val">${empFmt(totalComm)}</div><div class="emp-kpi-lbl">Total comisiones ${year}</div></div></div>
        <div class="emp-kpi-card"><div class="emp-kpi-icon" style="background:linear-gradient(135deg,#10b981,#059669)"><i class="ph-fill ph-currency-dollar"></i></div><div><div class="emp-kpi-val">${empFmt(emp.salary_base)}</div><div class="emp-kpi-lbl">Sueldo base</div></div></div>
      </div>
      <canvas id="empProfileChart" height="140" style="margin:16px 0"></canvas>
      <h4 style="margin:16px 0 8px"><i class="ph-bold ph-calendar"></i> Detalle mensual ${year}</h4>
      <div style="overflow-x:auto">
      <table class="emp-table">
        <thead><tr><th>Mes</th><th class="num">Índice</th><th class="num">Comisión</th><th>Estado</th></tr></thead>
        <tbody>
          ${monthlySeries.map((m) => `<tr>
            <td>${MONTHS_ES[m.month - 1]}</td>
            <td class="num">${empIndexBadge(m.productivity_index)}</td>
            <td class="num">${m.commission_amount ? empFmt(m.commission_amount) : '—'}</td>
            <td>${m.status ? empStatusBadge(m.status) : '<span style="color:var(--ink-3)">—</span>'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>`;

    $('#empProfileContent').innerHTML = profileHtml;
    openModal('empProfileModal');

    // Renderizar gráfica dentro del modal
    setTimeout(() => {
      const canvas = document.getElementById('empProfileChart');
      if (!canvas) return;
      new Chart(canvas, {
        type: 'bar',
        data: {
          labels: MONTHS_ES.map((m) => m.slice(0, 3)),
          datasets: [{
            label: 'Índice de productividad (%)',
            data: monthlySeries.map((m) => m.productivity_index !== null ? Math.round(m.productivity_index) : null),
            backgroundColor: 'rgba(108,71,255,0.7)',
            borderColor: '#6c47ff',
            borderWidth: 2,
            borderRadius: 6,
          }],
        },
        options: {
          responsive: true,
          scales: { y: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } },
          plugins: { legend: { display: false } },
        },
      });
    }, 80);
  } catch (err) {
    toast(err.message || 'Error cargando perfil', true);
  }
}
globalThis.empOpenProfile = empOpenProfile;

$('#empPrintProfileBtn')?.addEventListener('click', () => {
  const content = $('#empProfileContent')?.innerHTML || '';
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Perfil Empleado</title><style>
    body{font-family:sans-serif;padding:24px;color:#222}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
    th{background:#f3f4f6}
    .emp-avatar{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;color:#fff;font-weight:700;font-size:18px}
    .emp-profile-header{display:flex;align-items:center;gap:16px;margin-bottom:20px}
    .emp-profile-kpis{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px}
    .emp-kpi-card{background:#f8f9fb;border-radius:12px;padding:14px 20px;min-width:140px;display:flex;align-items:center;gap:12px}
    .emp-kpi-val{font-size:20px;font-weight:800}
    .emp-kpi-lbl{font-size:12px;color:#6b7280}
    .emp-kpi-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px}
    canvas{display:none}
    @media print{canvas{display:block!important}}
  </style></head><body>${content}<script>window.onload=()=>window.print()<\/script></body></html>`);
  w.document.close();
});

/* ── Impresión equipo ── */
function empPrintTeam() {
  const { year, month } = empCurrentPeriod();
  const periodLabel = `${MONTHS_ES[month - 1]} ${year}`;
  const activeEmps = EMP_EMPLOYEES.filter((e) => e.active !== 0);
  const activeMetrics = EMP_METRICS.filter((m) => m.active !== 0);

  const rows = activeEmps.map((emp) => {
    const empRecs = EMP_RECORDS.filter((r) => r.employee_id === emp.id);
    const commRec = EMP_COMMISSION_RECORDS.filter((c) => c.employee_id === emp.id);
    const idx = commRec.length ? Math.round(commRec[0].productivity_index) : null;
    const totalComm = commRec.reduce((s, c) => s + (c.commission_amount || 0), 0);
    return `<tr>
      <td>${esc(emp.name)}</td>
      <td>${esc(emp.position || '—')}</td>
      ${activeMetrics.map((m) => {
        const rec = empRecs.find((r) => r.metric_id === m.id);
        return `<td>${rec ? rec.value + (m.unit ? ' ' + m.unit : '') : '—'}</td>`;
      }).join('')}
      <td>${idx !== null ? idx + '%' : '—'}</td>
      <td>${empFmt(totalComm)}</td>
    </tr>`;
  }).join('');

  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Reporte Equipo ${periodLabel}</title><style>
    body{font-family:sans-serif;padding:24px;color:#222}
    h1{font-size:20px;margin-bottom:4px}
    p{margin:0 0 16px;color:#6b7280}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:13px}
    th{background:#f3f4f6;font-weight:700}
    @media print{body{padding:10px}}
  </style></head><body>
    <h1>Reporte Productividad Equipo</h1>
    <p>Período: ${periodLabel} · Generado: ${new Date().toLocaleDateString('es-MX')}</p>
    <table>
      <thead><tr><th>Empleado</th><th>Puesto</th>${activeMetrics.map((m) => `<th>${esc(m.name)}</th>`).join('')}<th>Índice</th><th>Comisión</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload=()=>window.print()<\/script>
  </body></html>`);
  w.document.close();
}

$('#empPrintCommBtn')?.addEventListener('click', () => {
  const { year, month } = empCurrentPeriod();
  const periodLabel = `${MONTHS_ES[month - 1]} ${year}`;
  const rows = EMP_COMMISSION_RECORDS.map((cr) => `<tr>
    <td>${esc(cr.employee_name)}</td>
    <td>${cr.productivity_index !== null ? Math.round(cr.productivity_index) + '%' : '—'}</td>
    <td>${empFmt(cr.base_value)}</td>
    <td><b>${empFmt(cr.commission_amount)}</b></td>
    <td>${esc(cr.scheme_name || 'Sin esquema')}</td>
    <td>${cr.status === 'paid' ? 'Pagada' : cr.status === 'approved' ? 'Aprobada' : 'Pendiente'}</td>
  </tr>`).join('');
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><title>Comisiones ${periodLabel}</title><style>
    body{font-family:sans-serif;padding:24px;color:#222}
    h1{font-size:20px;margin-bottom:4px}
    p{margin:0 0 16px;color:#6b7280}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:6px 10px;text-align:left;font-size:13px}
    th{background:#f3f4f6;font-weight:700}
    @media print{body{padding:10px}}
  </style></head><body>
    <h1>Reporte de Comisiones</h1>
    <p>Período: ${periodLabel} · Generado: ${new Date().toLocaleDateString('es-MX')}</p>
    <table>
      <thead><tr><th>Empleado</th><th>Índice</th><th>Base</th><th>Comisión</th><th>Esquema</th><th>Estado</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>window.onload=()=>window.print()<\/script>
  </body></html>`);
  w.document.close();
});
/* ═══════════ FIN: Módulo Productividad Empleados ═══════════ */
$('#invInitCancel')?.addEventListener('click', () => closeModal('invInitModal'));

/* ── Modal: entrada / merma ── */
function openInvMovModal(type, productId = null) {
  const title = type === 'entrada' ? 'Nueva entrada de inventario' : 'Registrar merma';
  const icon = type === 'entrada' ? 'ph-arrow-fat-line-down' : 'ph-warning-diamond';
  $('#invMovModalTitle').innerHTML = `<i class="ph-bold ${icon}"></i> ${title}`;
  $('#invMovType').value = type;
  $('#invMovQty').value = '';
  $('#invMovNotes').value = '';
  $('#invMovUnitCost').value = '';
  $('#invMovUnitCostField').hidden = type !== 'entrada';
  $('#invMovUnitCost').required = type === 'entrada';
  $('#invMovBranch').innerHTML = invBranchOptions();
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
  const unitCost = $('#invMovType').value === 'entrada' ? Number($('#invMovUnitCost').value) : null;
  if ($('#invMovType').value === 'entrada' && (!Number.isFinite(unitCost) || unitCost < 0)) { toast('Ingresa el costo unitario de la entrada', true); return; }
  try {
    await api('/api/inventory/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: pid,
        type: $('#invMovType').value,
        quantity: qty,
        unit_cost: unitCost,
        notes: $('#invMovNotes').value,
        branch_id: Number($('#invMovBranch').value),
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
  if (INV_BRANCH !== 'all' && !INV_BRANCHES.find((row)=>String(row.id)===String(INV_BRANCH))?.active) {
    return toast('La sucursal inactiva sólo está disponible para consulta histórica', true);
  }
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
        body: JSON.stringify({ ...c, branch_id: INV_BRANCH !== 'all' ? Number(INV_BRANCH) : null }),
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
    if (INV_BRANCH !== 'all') params.set('branch', INV_BRANCH);
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
      <thead><tr><th>Producto</th><th>Tipo</th><th>Sucursal</th><th class="num">Cantidad</th><th class="num">Costo unitario</th><th class="num">Costo total</th><th>Notas</th><th>Usuario</th><th>Fecha</th><th></th></tr></thead>
      <tbody>${rows.map((m) => `<tr>
        <td>${esc(m.product_name)}</td>
        <td><span class="inv-type-badge inv-type-${m.type}">${m.source_type === 'purchase' ? '🛒 Compra' : m.type === 'entrada' ? '⬇ Entrada' : '⚠ Merma'}</span></td>
        <td>${esc(m.branch_name || '—')}</td>
        <td class="num">${invFmt(m.quantity)}</td>
        <td class="num">${m.type === 'entrada' ? fmtMoney(m.unit_cost || 0) : '—'}</td>
        <td class="num">${m.type === 'entrada' ? fmtMoney(m.total_cost || 0) : '—'}</td>
        <td>${esc(m.notes || '—')}</td>
        <td>${esc(m.created_by || '—')}</td>
        <td style="white-space:nowrap">${esc(m.created_at)}</td>
        <td>${m.source_type === 'purchase' ? '<i class="ph-bold ph-lock" title="Movimiento auditado"></i>' : `<button class="btn btn-ghost btn-sm inv-del-mov" data-id="${m.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>`}</td>
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
    params.set('branch', INV_BRANCH);
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
  const now = fmtBusinessDateTime();

  if (opts.includeSummary) {
    lines.push(`Reporte de Inventario — ${now}`);
    lines.push('');
    lines.push(['Producto','Unidad','Inv. Inicial','Entradas','Compras','Traslados','Mermas','Ventas','Físico Sistema','Físico Real','Diferencia'].map(csvEscape).join(','));
    for (const r of summary) {
      lines.push([
        r.product_name, r.unit ?? 'pcs',
        r.initial_stock, r.entradas, r.compras || 0, r.traslados || 0, r.mermas, r.ventas,
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
        m.product_name, m.source_type === 'purchase' ? 'compra' : m.type, m.quantity, m.notes || '', m.created_by || '', m.created_at,
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
  const now = fmtBusinessDateTime();
  const biz = ME?.tenant?.business_name || 'ChatBotPro';

  const summaryHTML = opts.includeSummary ? `
    <h2>Resumen de Inventario</h2>
    <table>
      <thead><tr>
        <th>Producto</th><th>Unidad</th><th>Ini.</th><th>Entradas</th><th>Compras</th><th>Traslados</th>
        <th>Mermas</th><th>Ventas</th><th>F. Sistema</th><th>F. Real</th><th>Diferencia</th>
      </tr></thead>
      <tbody>${summary.map((r) => {
        const diffClass = r.diferencia < 0 ? 'neg' : r.diferencia > 0 ? 'pos' : '';
        return `<tr>
          <td>${r.product_name}</td>
          <td>${r.unit ?? 'pcs'}</td>
          <td>${r.initial_stock}</td>
          <td>${r.entradas}</td>
          <td>${r.compras || 0}</td>
          <td>${r.traslados || 0}</td>
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
        <td style="color:${m.type === 'entrada' ? '#16a34a' : '#dc2626'}">${m.source_type === 'purchase' ? 'compra' : m.type}</td>
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
