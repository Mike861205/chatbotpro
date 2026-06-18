/* ===== ChatBotPro — lógica del panel v2 ===== */
let ME = null;
let SETTINGS = null;
let salesChart = null;
let topChart = null;
let orderStatusFilter = '';
let BRANCHES = [];
let LAST_ORDERS = [];
let POS_OVERVIEW = null;
let POS_CART = [];
let POS_CATEGORY_FILTER = 'all';
let POS_PAYMENT_METHOD = 'cash';
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
let CHATBOT_SUBTAB = 'flow';
let DELIVERY_ZONES = [];
let DELIVERY_ZONE_MAP = null;
let DELIVERY_ZONE_LAYER = null;
let DELIVERY_DRAW_ACTIVE = false;
let DELIVERY_DRAW_POINTS = [];
let DELIVERY_DRAW_MARKERS = [];
let DELIVERY_DRAW_PREVIEW = null;
let DELIVERY_DRAW_HELP_SHOWN = false;

const $ = (s) => document.querySelector(s);
const fmtMoney = (n, c) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: c || (SETTINGS && SETTINGS.currency) || 'MXN' }).format(n || 0);

function toast(msg, isErr = false) {
  const t = $('#toast');
  $('#toastMsg').textContent = msg;
  t.querySelector('i').className = isErr ? 'ph-fill ph-x-circle' : 'ph-fill ph-check-circle';
  t.className = isErr ? 'show err' : 'show ok';
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.className = ''), 3200);
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
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data?.errorCode === 'BILLING_SUSPENDED') {
    showSuspensionModal(data.error, data.whatsappUrl);
    throw new Error(data.error || 'Servicio suspendido por falta de pago');
  }
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

/* ===== Confirmación elegante (reemplaza confirm()) ===== */
function askConfirm(title, msg) {
  return new Promise((resolve) => {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
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
  pos: ['Punto de venta', 'Caja, cobro y cierre del día', 'ph-cash-register'],
  productos: ['Productos', 'Tu menú visible en el chatbot', 'ph-hamburger'],
  chatbot: ['Mi chatbot', 'Configura el flujo y comparte tu liga', 'ph-chat-circle-dots'],
  config: ['Mi negocio', 'Identidad, branding y contacto', 'ph-storefront'],
};

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  pedidos: loadOrders,
  pos: loadPos,
  productos: loadProducts,
  chatbot: fillBotForm,
  config: fillConfigForm,
};

let CURRENT_VIEW = 'dashboard';

function normalizeView(view) {
  return VIEW_META[view] ? view : 'dashboard';
}

function resetMainScroll() {
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
}

async function navigate(view) {
  const nextView = normalizeView(view);
  CURRENT_VIEW = nextView;

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
    e.preventDefault();
    navigate(a.dataset.view);
  })
);

globalThis.addEventListener('hashchange', () => {
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
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

/* ===== Dashboard ===== */
async function loadDashboard() {
  const s = await api('/api/dashboard/stats');
  $('#stSalesToday').textContent = fmtMoney(s.today.sales);
  $('#stOrdersToday').textContent = s.today.count;
  $('#stPending').textContent = s.pending;
  $('#stAvgTicket').textContent = fmtMoney(s.avgTicket);
  const badge = $('#pendingBadge');
  badge.style.display = s.pending ? 'inline-flex' : 'none';
  badge.textContent = s.pending;

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
        label: 'Ventas',
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

function ordersTableHTML(orders, editable = true) {
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
      return `<tr>
        <td><b>#${o.id}</b></td>
        <td><div class="cust">${custAvatar(o.customer?.name)}<div class="cmeta"><b>${esc(o.customer?.name || '—')}</b><span>${esc(o.customer?.phone || '')}</span></div></div></td>
        <td style="max-width:280px">${esc(items)}</td>
        <td style="white-space:nowrap">${deliveryText}${deliveryFeeText}${locationText}${cancelNoteText}</td>
        <td><b>${fmtMoney(o.total)}</b></td>
        <td>${statusCell}</td>
        <td style="white-space:nowrap;color:var(--ink-3);font-size:12.5px">${esc(o.created_at)}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Entrega</th><th>Total</th><th>Estatus</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadOrders() {
  const orders = await api(`/api/orders${orderStatusFilter ? `?status=${orderStatusFilter}` : ''}`);
  LAST_ORDERS = orders;
  $('#ordersTable').innerHTML = orders.length
    ? ordersTableHTML(orders, true)
    : emptyHTML('ph-funnel', 'Sin resultados', 'No hay pedidos con este filtro.');
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
}
window.loadOrders = loadOrders;

function formatExportRows(orders) {
  return orders.map((o) => ({
    pedido: `#${o.id}`,
    cliente: o.customer?.name || '—',
    telefono: o.customer?.phone || '',
    productos: o.items.map((it) => `${it.qty}x ${it.name}`).join(', '),
    entrega: o.delivery === 'domicilio' ? 'Domicilio' : `Recoger${o.pickup_branch_name ? ` (${o.pickup_branch_name})` : ''}`,
    ubicacion: o.customer_location_text || '',
    motivo_cancelacion: o.cancel_note || '',
    total: Number(o.total || 0),
    estatus: o.status,
    fecha: o.created_at || '',
  }));
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
    Ubicacion: r.ubicacion,
    MotivoCancelacion: r.motivo_cancelacion,
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
    head: [['Pedido', 'Cliente', 'Telefono', 'Productos', 'Entrega', 'Ubicacion', 'Motivo cancelacion', 'Total', 'Estatus', 'Fecha']],
    body: rows.map((r) => [r.pedido, r.cliente, r.telefono, r.productos, r.entrega, r.ubicacion, r.motivo_cancelacion, fmtMoney(r.total), r.estatus, r.fecha]),
    styles: { fontSize: 8, cellPadding: 2.2 },
    headStyles: { fillColor: [23, 28, 46] },
    columnStyles: { 3: { cellWidth: 52 }, 5: { cellWidth: 32 }, 6: { cellWidth: 42 } },
  });
  doc.save(`pedidos_${Date.now()}.pdf`);
  toast('Pedidos exportados a PDF');
}

$('#expExcelBtn')?.addEventListener('click', exportOrdersExcel);
$('#expPdfBtn')?.addEventListener('click', exportOrdersPdf);

async function loadDashboardBadge() {
  try {
    const s = await api('/api/dashboard/stats');
    const badge = $('#pendingBadge');
    badge.style.display = s.pending ? 'inline-flex' : 'none';
    badge.textContent = s.pending;
  } catch {}
}

$('#orderFilter').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#orderFilter button').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  orderStatusFilter = btn.dataset.st;
  loadOrders();
});

/* ===== Punto de venta ===== */
function moneyNum(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : 0;
}

function posCartTotal() {
  return moneyNum(POS_CART.reduce((sum, item) => sum + item.price * item.qty, 0));
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
  if (POS_CATEGORY_FILTER === 'all') return products;
  return products.filter((product) => String(product.category_id || 'none') === POS_CATEGORY_FILTER);
}

function syncPosCartFromCatalog() {
  const byId = new Map((POS_OVERVIEW?.products || []).map((product) => [Number(product.id), product]));
  POS_CART = POS_CART.filter((item) => byId.has(Number(item.id))).map((item) => {
    const product = byId.get(Number(item.id));
    return {
      ...item,
      name: product.name,
      price: Number(product.price),
      image: product.image,
    };
  });
}

function setPosPaymentDefaults() {
  const total = posCartTotal();
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
}

function updatePosChangeHint() {
  const hint = $('#posChangeHint');
  if (!hint) return;
  const total = posCartTotal();
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
  const total = posCartTotal();
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
    const total = posCartTotal();
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
      subtotal: total,
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
      subtotal: Number(LAST_POS_SALE.total || 0),
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
    @page { size: ${widthMm}mm auto; margin: 3mm; }
    html, body { margin: 0; padding: 0; }
    body { width: 100%; max-width: ${Math.max(50, widthMm - 6)}mm; margin: 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: ${fontPx}px; line-height: ${lineHeight}; color: #000; }
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
    <tr><td>Subtotal</td><td class="r">${esc(fmtMoney(subtotal, currency))}</td></tr>
    <tr><td class="tot">TOTAL</td><td class="tot r">${esc(fmtMoney(total, currency))}</td></tr>
    ${!isMixed && Number(ticket.cashReceived || 0) > 0 ? `<tr><td>Efectivo recibido</td><td class="r">${esc(fmtMoney(ticket.cashReceived, currency))}</td></tr>` : ''}
    ${!isMixed && Number(ticket.cashChange || 0) > 0 ? `<tr><td>Cambio</td><td class="r">${esc(fmtMoney(ticket.cashChange, currency))}</td></tr>` : ''}
  </table>
  ${ticket.notes ? `<div class="sep"></div><div class="meta">Nota: ${esc(ticket.notes)}</div>` : ''}
  <div class="sep"></div>
  <div class="center meta">Gracias por tu compra</div>
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
  const w = window.open(blobUrl, '_blank', 'width=420,height=760');
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

async function loadPos() {
  POS_OVERVIEW = await api('/api/pos/overview');
  syncPosCartFromCatalog();
  setPosPaymentDefaults();
  renderPos();
}

function addPosProduct(productId) {
  const product = (POS_OVERVIEW?.products || []).find((item) => Number(item.id) === Number(productId));
  if (!product) return;
  const existing = POS_CART.find((item) => Number(item.id) === Number(product.id));
  if (existing) {
    existing.qty += 1;
  } else {
    POS_CART.push({ id: Number(product.id), name: product.name, price: Number(product.price), image: product.image, qty: 1 });
  }
  setPosPaymentDefaults();
  renderPosCart();
}

function updatePosQty(productId, delta) {
  const item = POS_CART.find((entry) => Number(entry.id) === Number(productId));
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) POS_CART = POS_CART.filter((entry) => Number(entry.id) !== Number(productId));
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
  renderPosActions();
  renderPosSession();
  renderPosCatalog();
  renderPosCart();
}

function renderPosActions() {
  const el = $('#posActionIcons');
  if (!el) return;
  const hasSession = Boolean(POS_OVERVIEW?.activeSession);
  el.innerHTML = `
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
    { icon: 'ph-safe', title: 'Fondo inicial', value: session?.opening_amount || 0, tone: 'primary' },
    { icon: 'ph-bag-plus', title: 'Ventas del turno', value: totals.totalSales, tone: 'blue' },
    { icon: 'ph-coins', title: 'Efectivo en ventas', value: totals.collected.cash, tone: 'green' },
    { icon: 'ph-credit-card', title: 'Tarjeta', value: totals.collected.card, tone: 'violet' },
    { icon: 'ph-arrow-up-right', title: 'Transferencia', value: totals.collected.transfer, tone: 'cyan' },
    { icon: 'ph-shuffle', title: 'Movimientos netos', value: movementNet, tone: movementNet < 0 ? 'red' : 'amber' },
    { icon: 'ph-prohibit', title: 'Cancelaciones', value: totals.cancellations.total, tone: 'red' },
    { icon: 'ph-lock', title: 'Efectivo esperado', value: expectedCash, tone: 'ink' },
  ];
  el.innerHTML = cards
    .map(
      (card) => `<div class="pos-fin-card tone-${card.tone}">
        <div class="pos-fin-ic"><i class="ph-bold ${card.icon}"></i></div>
        <div>
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
    el.style.display = 'block';
    el.innerHTML = `
      <h3><i class="ph-bold ph-lock-key-open"></i> Apertura de caja</h3>
      <p class="hint" style="margin:-8px 0 18px">Abre una caja para empezar a registrar ventas, ingresos, retiros y gastos del turno.</p>
      <form id="posOpenForm">
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
  el.innerHTML = '';
  el.style.display = 'none';
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
  const total = posCartTotal();
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
        ${POS_CART.map((item) => `
          <div class="pos-cart-item">
            <div>
              <b>${esc(item.name)}</b>
              <small>${fmtMoney(item.price)} c/u</small>
            </div>
            <div class="pos-cart-actions">
              <button type="button" class="btn btn-ghost btn-icon" data-pos-dec="${item.id}"><i class="ph-bold ph-minus"></i></button>
              <span>${item.qty}</span>
              <button type="button" class="btn btn-ghost btn-icon" data-pos-inc="${item.id}"><i class="ph-bold ph-plus"></i></button>
            </div>
          </div>`).join('')}
      </div>
      <div class="pos-total-line"><span>Total</span><b>${fmtMoney(total)}</b></div>
      <form id="posCheckoutForm">
        <div class="field">
          <label><i class="ph-bold ph-credit-card"></i> Medio de pago</label>
          <div class="segmented pos-pay-methods">${methodButtons}</div>
        </div>
        ${cashField}
        ${mixedFields}
        <div class="field">
          <label><i class="ph-bold ph-note"></i> Nota de venta</label>
          <textarea id="posSaleNotes" rows="2" placeholder="Mesa 4, venta rápida, pedido interno...">${esc(POS_PAYMENT_FORM.notes || '')}</textarea>
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

  document.querySelectorAll('[data-pos-dec]').forEach((button) => button.addEventListener('click', () => updatePosQty(button.dataset.posDec, -1)));
  document.querySelectorAll('[data-pos-inc]').forEach((button) => button.addEventListener('click', () => updatePosQty(button.dataset.posInc, 1)));
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
  updatePosChangeHint();
  updatePosMixedHint();
  $('#posCheckoutForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        items: POS_CART.map((item) => ({ productId: item.id, qty: item.qty })),
        paymentMethod: POS_PAYMENT_METHOD,
        payments: {
          cash: Number($('#posMixCash')?.value || 0),
          card: Number($('#posMixCard')?.value || 0),
          transfer: Number($('#posMixTransfer')?.value || 0),
        },
        cashReceived: Number($('#posCashReceived')?.value || 0),
        notes: $('#posSaleNotes')?.value || '',
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
  $('#posCloseSummary').innerHTML = `
    <div class="pos-close-groups">
      <div class="pos-close-group neutral">
        <h4><i class="ph-bold ph-info"></i> Datos del turno</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat"><span>Fondo inicial</span><b>${fmtMoney(session.opening_amount || 0)}</b></div>
          <div class="pos-mini-stat"><span>Ventas del turno</span><b>${fmtMoney(totals.totalSales || 0)}</b></div>
          <div class="pos-mini-stat"><span>Efectivo esperado</span><b>${fmtMoney(session.expectedCash || 0)}</b></div>
          <div class="pos-mini-stat"><span>Tickets</span><b>${Number(totals.tickets || 0)}</b></div>
          <div class="pos-mini-stat"><span>Abierta por</span><b>${esc(session.opened_by || '—')}</b></div>
        </div>
      </div>
      <div class="pos-close-group income">
        <h4><i class="ph-bold ph-trend-up"></i> Entradas</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat"><span>Ingreso manual</span><b>${fmtMoney(totals.movements.income || 0)}</b></div>
        </div>
      </div>
      <div class="pos-close-group outflow">
        <h4><i class="ph-bold ph-arrow-bend-up-left"></i> Salidas</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat"><span>Retiros</span><b>${fmtMoney(totals.movements.withdrawal || 0)}</b></div>
          <div class="pos-mini-stat"><span>Gastos</span><b>${fmtMoney(totals.movements.expense || 0)}</b></div>
        </div>
      </div>
      <div class="pos-close-group cancel">
        <h4><i class="ph-bold ph-x-circle"></i> Cancelaciones</h4>
        <div class="pos-close-grid">
          <div class="pos-mini-stat"><span>Tickets cancelados</span><b>${Number(totals.cancellations.tickets || 0)}</b></div>
          <div class="pos-mini-stat"><span>Total cancelado</span><b>${fmtMoney(totals.cancellations.total || 0)}</b></div>
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
    await loadPos();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ===== Productos ===== */
let CATS = [];

async function loadProducts() {
  CATS = await api('/api/products/categories');
  const prods = await api('/api/products');

  $('#catChips').innerHTML = CATS.length
    ? CATS.map(
        (c) =>
          `<span class="chip"><i class="ph-bold ph-folder" style="color:var(--primary)"></i> ${esc(c.name)} <a href="#" class="x" data-delcat="${c.id}" title="Eliminar categoría"><i class="ph-bold ph-x"></i></a></span>`
      ).join('')
    : '<span class="chip" style="opacity:0.6">Sin categorías — crea la primera</span>';
  document.querySelectorAll('[data-delcat]').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!(await askConfirm('¿Eliminar categoría?', 'Los productos de esta categoría quedarán sin categoría.'))) return;
      await api(`/api/products/categories/${a.dataset.delcat}`, { method: 'DELETE' });
      toast('Categoría eliminada');
      loadProducts();
    })
  );

  $('#pCat').innerHTML = '<option value="">Sin categoría</option>' + CATS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  $('#prodGrid').innerHTML = prods.length
    ? prods
        .map(
          (p) => `<div class="prod-card ${p.active ? '' : 'inactive'}">
        <div class="img">
          ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" />` : '<i class="ph ph-fork-knife"></i>'}
          <span class="state-dot ${p.active ? 'on' : 'off'}">${p.active ? 'ACTIVO' : 'OCULTO'}</span>
          <span class="price-tag">${fmtMoney(p.price)}</span>
        </div>
        <div class="body">
          ${p.category_name ? `<span class="cat">${esc(p.category_name)}</span>` : ''}
          <div class="name">${esc(p.name)}</div>
          <div class="desc">${esc(p.description || '')}</div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" data-edit="${p.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button>
          <button class="btn btn-danger btn-icon" data-del="${p.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
        </div>
      </div>`
        )
        .join('')
    : `<div class="card" style="grid-column:1/-1">${emptyHTML('ph-hamburger', 'Tu menú está vacío', 'Agrega tu primer producto para que el chatbot pueda vender.')}</div>`;

  document.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openProdModal(prods.find((p) => p.id == b.dataset.edit)))
  );
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await askConfirm('¿Eliminar producto?', 'Se quitará de tu menú y del chatbot de inmediato.'))) return;
      await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
      toast('Producto eliminado');
      loadProducts();
    })
  );
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
  $('#prodModal').classList.add('show');
}
$('#addProdBtn').addEventListener('click', () => openProdModal());
$('#prodCancel').addEventListener('click', () => $('#prodModal').classList.remove('show'));
[$('#prodModal'), $('#catModal'), $('#confirmModal'), $('#branchModal'), $('#posMovementModal'), $('#posCloseModal'), $('#posSalesHistoryModal'), $('#posPaymentEditModal'), $('#orderCancelReasonModal')].forEach((m) =>
  m.addEventListener('click', (e) => {
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
    await api(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', body: fd });
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
    return parsed
      .map((zone, i) => {
        const points = Array.isArray(zone?.points)
          ? zone.points
              .map((p) => [Number(p?.[0]), Number(p?.[1])])
              .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
          : [];
        const fee = Number(zone?.fee);
        const name = String(zone?.name || '').trim();
        if (!name || !Number.isFinite(fee) || fee < 0 || points.length < 3) return null;
        return {
          id: String(zone?.id || `zone-${i + 1}`),
          name,
          fee,
          color: String(zone?.color || '#0ea5e9'),
          points,
          active: zone?.active !== false,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function setChatbotSubtab(tab) {
  CHATBOT_SUBTAB = tab === 'delivery' ? 'delivery' : 'flow';
  const isDelivery = CHATBOT_SUBTAB === 'delivery';
  $('#chatbotTabFlow')?.classList.toggle('active', !isDelivery);
  $('#chatbotTabDelivery')?.classList.toggle('active', isDelivery);
  $('#chatbotFlowPanel').hidden = isDelivery;
  $('#chatbotDeliveryPanel').hidden = !isDelivery;
  if (isDelivery) {
    ensureDeliveryZoneMap();
    setTimeout(() => DELIVERY_ZONE_MAP?.invalidateSize(), 80);
  }
}

function renderDeliveryZonesList() {
  const host = $('#deliveryZonesList');
  if (!host) return;
  if (!DELIVERY_ZONES.length) {
    host.innerHTML = emptyHTML('ph-map-pin', 'Sin zonas aún', 'Dibuja tu primera zona y asígnale un costo de envío.');
    return;
  }
  host.innerHTML = DELIVERY_ZONES.map((zone) => `
    <div class="delivery-zone-item">
      <div class="meta">
        <span class="swatch" style="background:${esc(zone.color)}"></span>
        <div>
          <b>${esc(zone.name)}</b>
          <small>${zone.points.length} puntos · ${fmtMoney(zone.fee)}</small>
        </div>
      </div>
      <button class="btn btn-danger btn-icon" type="button" data-delivery-zone-del="${esc(zone.id)}" title="Eliminar zona"><i class="ph-bold ph-trash"></i></button>
    </div>
  `).join('');

  host.querySelectorAll('[data-delivery-zone-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      DELIVERY_ZONES = DELIVERY_ZONES.filter((z) => z.id !== btn.dataset.deliveryZoneDel);
      drawDeliveryZones();
      renderDeliveryZonesList();
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
  DELIVERY_ZONES.forEach((zone) => {
    const polygon = L.polygon(zone.points, {
      color: zone.color || '#0ea5e9',
      weight: 2,
      fillOpacity: 0.22,
    }).addTo(DELIVERY_ZONE_LAYER);
    polygon.bindPopup(`<b>${esc(zone.name)}</b><br/>Envío: ${fmtMoney(zone.fee)}`);
  });
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

  $('#deliverySaveZone')?.addEventListener('click', () => {
    const name = ($('#deliveryZoneName')?.value || '').trim();
    const fee = Number($('#deliveryZoneFee')?.value || '0');
    const color = $('#deliveryZoneColor')?.value || '#0ea5e9';
    if (!name) return toast('Escribe un nombre de zona', true);
    if (!Number.isFinite(fee) || fee < 0) return toast('El costo de envío no es válido', true);
    if (DELIVERY_DRAW_POINTS.length < 3) return toast('Dibuja al menos 3 puntos para formar la zona', true);

    DELIVERY_ZONES.push({
      id: `zone_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      fee,
      color,
      points: [...DELIVERY_DRAW_POINTS],
      active: true,
    });

    clearDeliveryDrawing();
    drawDeliveryZones();
    renderDeliveryZonesList();
    $('#deliveryZoneName').value = '';
    $('#deliveryZoneFee').value = '';
    $('#deliveryDrawHint').textContent = 'Zona agregada. Guarda para aplicar cambios al chatbot.';
    toast('Zona agregada al mapa');
  });

  $('#deliverySaveAll')?.addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('delivery_zones_geojson', JSON.stringify(DELIVERY_ZONES));
    await api('/api/settings', { method: 'PUT', body: fd });
    SETTINGS = await api('/api/settings');
    toast('Servicio a domicilio guardado');
  });
}

function fillBotForm() {
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
  DELIVERY_ZONES = parseDeliveryZones(SETTINGS.delivery_zones_geojson || '[]');
  setDeliveryColor($('#deliveryZoneColor')?.value || '#0ea5e9');
  renderDeliveryZonesList();
  if (CHATBOT_SUBTAB === 'delivery') {
    ensureDeliveryZoneMap();
    drawDeliveryZones();
    setTimeout(() => DELIVERY_ZONE_MAP?.invalidateSize(), 80);
  }
  loadBranches();
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
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Flujo del chatbot guardado');
  SETTINGS = await api('/api/settings');
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
  $('#cfgTicketWidth').value = String(Number(SETTINGS.ticket_width_mm || 80));
  $('#cfgTicketFont').value = String(Number(SETTINGS.ticket_font_size_px || 14));
  $('#cfgTicketLineHeight').value = String(Number(SETTINGS.ticket_line_height || 1.45));
  $('#cfgTicketShowLogo').value = SETTINGS.ticket_show_logo === '0' ? '0' : '1';
  $('#logoPreview').innerHTML = SETTINGS.logo ? `<img src="${esc(SETTINGS.logo)}" alt="" />` : '<i class="ph ph-image"></i>';
  renderSwatches();
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
  const fd = new FormData();
  fd.append('address', $('#cfgAddress').value);
  fd.append('hours', $('#cfgHours').value);
  fd.append('currency', $('#cfgCurrency').value);
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Datos de contacto guardados');
  SETTINGS = await api('/api/settings');
});

$('#ticketForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('ticket_width_mm', $('#cfgTicketWidth').value);
  fd.append('ticket_font_size_px', $('#cfgTicketFont').value);
  fd.append('ticket_line_height', $('#cfgTicketLineHeight').value);
  fd.append('ticket_show_logo', $('#cfgTicketShowLogo').value);
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Configuración de ticket guardada');
  SETTINGS = await api('/api/settings');
});

/* ===== Helpers ===== */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ===== Boot ===== */
async function boot(navigateToHash = true) {
  ME = await api('/api/auth/me');
  SETTINGS = await api('/api/settings');
  document.documentElement.style.setProperty('--primary', ME.tenant.primaryColor || '#ff6b35');
  $('#brandName').textContent = ME.tenant.businessName;
  $('#userBizName').textContent = ME.tenant.businessName;
  $('#userName').textContent = '@' + ME.username;
  $('#brandMark').innerHTML = ME.tenant.logo
    ? `<img src="${esc(ME.tenant.logo)}" alt="" />`
    : '<i class="ph-fill ph-robot"></i>';
  $('#avatar').innerHTML = ME.tenant.logo
    ? `<img src="${esc(ME.tenant.logo)}" alt="" />`
    : esc(ME.tenant.businessName.charAt(0).toUpperCase());
  $('#openChatLink').href = `/${ME.tenant.slug}`;
  if (navigateToHash) {
    const view = (location.hash || '#dashboard').slice(1);
    navigate(VIEW_META[view] ? view : 'dashboard');
  }
}

boot()
  .catch(() => (location.href = '/login'))
  .finally(() => {
    const l = $('#bootLoader');
    l.classList.add('hide');
    setTimeout(() => l.remove(), 350);
  });
