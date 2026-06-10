/* ===== ChatBotPro — lógica del panel ===== */
let ME = null;
let SETTINGS = null;
let salesChart = null;
let topChart = null;

const $ = (s) => document.querySelector(s);
const fmtMoney = (n, c) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: c || (SETTINGS && SETTINGS.currency) || 'MXN' }).format(n || 0);

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'show err' : 'show';
  setTimeout(() => (t.className = ''), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('No autenticado');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

/* ===== Navegación ===== */
const VIEW_META = {
  dashboard: ['Dashboard', 'Resumen de tu negocio'],
  pedidos: ['Pedidos', 'Administra y actualiza tus pedidos'],
  productos: ['Productos', 'Tu menú visible en el chatbot'],
  chatbot: ['Mi chatbot', 'Configura el flujo y comparte tu liga'],
  config: ['Configuración', 'Datos, logo y branding de tu negocio'],
};

function navigate(view) {
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `view-${view}`));
  const [title, sub] = VIEW_META[view] || VIEW_META.dashboard;
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  $('#sidebar').classList.remove('open');
  if (view === 'dashboard') loadDashboard();
  if (view === 'pedidos') loadOrders();
  if (view === 'productos') loadProducts();
  if (view === 'chatbot') fillBotForm();
  if (view === 'config') fillConfigForm();
}

document.querySelectorAll('.sidebar nav a').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', `#${a.dataset.view}`);
    navigate(a.dataset.view);
  })
);
$('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
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
  $('#stProducts').textContent = s.productCount;
  const badge = $('#pendingBadge');
  badge.style.display = s.pending ? 'inline-block' : 'none';
  badge.textContent = s.pending;

  const css = getComputedStyle(document.documentElement);
  const primary = css.getPropertyValue('--primary').trim() || '#ff6b35';

  if (salesChart) salesChart.destroy();
  salesChart = new Chart($('#salesChart'), {
    type: 'bar',
    data: {
      labels: s.last7.map((d) => d.day),
      datasets: [{ label: 'Ventas', data: s.last7.map((d) => d.sales), backgroundColor: primary, borderRadius: 8 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });

  if (topChart) topChart.destroy();
  topChart = new Chart($('#topChart'), {
    type: 'doughnut',
    data: {
      labels: s.topProducts.length ? s.topProducts.map((p) => p.name) : ['Sin datos'],
      datasets: [{
        data: s.topProducts.length ? s.topProducts.map((p) => p.qty) : [1],
        backgroundColor: [primary, '#3b82f6', '#1db954', '#f5a623', '#7c3aed'],
      }],
    },
    options: { plugins: { legend: { position: 'bottom' } } },
  });

  const recent = await api('/api/orders?limit=5');
  $('#recentOrders').innerHTML = recent.length ? ordersTableHTML(recent, false) : '<div class="empty">Aún no hay pedidos. ¡Comparte tu liga del chatbot! 🚀</div>';
}

/* ===== Pedidos ===== */
const STATUSES = ['pendiente', 'confirmado', 'preparando', 'enviado', 'entregado', 'cancelado'];

function ordersTableHTML(orders, editable = true) {
  const rows = orders
    .map((o) => {
      const items = o.items.map((it) => `${it.qty}x ${it.name}`).join(', ');
      const statusCell = editable
        ? `<select data-order="${o.id}" class="status-sel" style="width:auto;padding:6px 10px">
            ${STATUSES.map((st) => `<option value="${st}" ${st === o.status ? 'selected' : ''}>${st}</option>`).join('')}
          </select>`
        : `<span class="badge b-${o.status}">${o.status}</span>`;
      return `<tr>
        <td><b>#${o.id}</b></td>
        <td>${o.customer ? esc(o.customer.name) : '—'}<br><small style="color:var(--ink-3)">${o.customer ? esc(o.customer.phone) : ''}</small></td>
        <td style="max-width:280px">${esc(items)}</td>
        <td>${o.delivery === 'domicilio' ? '🛵 Domicilio' : '🏪 Recoger'}</td>
        <td><b>${fmtMoney(o.total)}</b></td>
        <td>${statusCell}</td>
        <td><small>${o.created_at}</small></td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Pedido</th><th>Cliente</th><th>Productos</th><th>Entrega</th><th>Total</th><th>Estatus</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadOrders() {
  const status = $('#orderFilter').value;
  const orders = await api(`/api/orders${status ? `?status=${status}` : ''}`);
  $('#ordersTable').innerHTML = orders.length ? ordersTableHTML(orders, true) : '<div class="empty">No hay pedidos con este filtro</div>';
  document.querySelectorAll('.status-sel').forEach((sel) =>
    sel.addEventListener('change', async () => {
      try {
        await api(`/api/orders/${sel.dataset.order}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: sel.value }),
        });
        toast(`Pedido #${sel.dataset.order} → ${sel.value}`);
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
}
$('#orderFilter').addEventListener('change', loadOrders);

/* ===== Productos ===== */
let CATS = [];

async function loadProducts() {
  CATS = await api('/api/products/categories');
  const prods = await api('/api/products');

  $('#catChips').innerHTML = CATS.length
    ? CATS.map((c) => `<span class="chip">${esc(c.name)} <a href="#" data-delcat="${c.id}" style="color:var(--red)">✕</a></span>`).join('')
    : '<span class="chip">Sin categorías aún</span>';
  document.querySelectorAll('[data-delcat]').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('¿Eliminar esta categoría? Los productos quedarán sin categoría.')) return;
      await api(`/api/products/categories/${a.dataset.delcat}`, { method: 'DELETE' });
      loadProducts();
    })
  );

  $('#pCat').innerHTML = '<option value="">Sin categoría</option>' + CATS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  $('#prodGrid').innerHTML = prods.length
    ? prods
        .map(
          (p) => `<div class="prod-card ${p.active ? '' : 'inactive'}">
        <div class="img">${p.image ? `<img src="${p.image}" alt="" />` : '🍽️'}</div>
        <div class="body">
          <div class="name">${esc(p.name)}</div>
          ${p.category_name ? `<span class="chip">${esc(p.category_name)}</span>` : ''}
          <div class="desc">${esc(p.description || '')}</div>
          <div class="price">${fmtMoney(p.price)}</div>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" data-edit="${p.id}">✏️ Editar</button>
          <button class="btn btn-danger" data-del="${p.id}">🗑️</button>
        </div>
      </div>`
        )
        .join('')
    : '<div class="empty card" style="grid-column:1/-1">Aún no tienes productos. ¡Agrega el primero para que tu chatbot pueda vender! 🍔</div>';

  document.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openProdModal(prods.find((p) => p.id == b.dataset.edit)))
  );
  document.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este producto?')) return;
      await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
      toast('Producto eliminado');
      loadProducts();
    })
  );
}

$('#addCatBtn').addEventListener('click', async () => {
  const name = prompt('Nombre de la categoría (ej. Tacos, Bebidas, Postres):');
  if (!name || !name.trim()) return;
  await api('/api/products/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  toast('Categoría creada');
  loadProducts();
});

function openProdModal(p = null) {
  $('#prodModalTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  $('#pId').value = p ? p.id : '';
  $('#pName').value = p ? p.name : '';
  $('#pDesc').value = p ? p.description || '' : '';
  $('#pPrice').value = p ? p.price : '';
  $('#pCat').value = p && p.category_id ? p.category_id : '';
  $('#pActive').value = p ? String(p.active) : '1';
  $('#pImage').value = '';
  $('#prodModal').classList.add('show');
}
$('#addProdBtn').addEventListener('click', () => openProdModal());
$('#prodCancel').addEventListener('click', () => $('#prodModal').classList.remove('show'));
$('#prodModal').addEventListener('click', (e) => {
  if (e.target.id === 'prodModal') $('#prodModal').classList.remove('show');
});

$('#prodForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#pId').value;
  const fd = new FormData();
  fd.append('name', $('#pName').value);
  fd.append('description', $('#pDesc').value);
  fd.append('price', $('#pPrice').value);
  fd.append('categoryId', $('#pCat').value);
  fd.append('active', $('#pActive').value);
  if ($('#pImage').files[0]) fd.append('image', $('#pImage').files[0]);
  try {
    await api(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', body: fd });
    $('#prodModal').classList.remove('show');
    toast(id ? 'Producto actualizado' : 'Producto creado');
    loadProducts();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ===== Chatbot ===== */
function fillBotForm() {
  if (!SETTINGS) return;
  const link = `${location.origin}/c/${SETTINGS.slug}`;
  $('#chatLink').value = link;
  $('#waShareBtn').href = `https://wa.me/?text=${encodeURIComponent(`¡Haz tu pedido en ${SETTINGS.business_name}! 🍔 Ordena aquí: ${link}`)}`;
  $('#botWelcome').value = SETTINGS.welcome_message || '';
  $('#botWhatsapp').value = SETTINGS.whatsapp || '';
  $('#botDelivery').value = SETTINGS.delivery_enabled || '1';
  $('#botPickup').value = SETTINGS.pickup_enabled || '1';
}
$('#copyLinkBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#chatLink').value);
  toast('¡Liga copiada! 📋');
});
$('#botForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('welcome_message', $('#botWelcome').value);
  fd.append('whatsapp', $('#botWhatsapp').value);
  fd.append('delivery_enabled', $('#botDelivery').value);
  fd.append('pickup_enabled', $('#botPickup').value);
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Flujo del chatbot guardado ✅');
  SETTINGS = await api('/api/settings');
});

/* ===== Configuración ===== */
function fillConfigForm() {
  if (!SETTINGS) return;
  $('#cfgName').value = SETTINGS.business_name || '';
  $('#cfgColor').value = SETTINGS.primary_color || '#ff6b35';
  $('#cfgAddress').value = SETTINGS.address || '';
  $('#cfgHours').value = SETTINGS.hours || '';
  $('#cfgCurrency').value = SETTINGS.currency || 'MXN';
  $('#logoPreview').innerHTML = SETTINGS.logo
    ? `<img src="${SETTINGS.logo}" style="height:60px;border-radius:12px" />`
    : '<span class="hint">Sin logo aún</span>';
}
$('#configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append('business_name', $('#cfgName').value);
  fd.append('primary_color', $('#cfgColor').value);
  fd.append('address', $('#cfgAddress').value);
  fd.append('hours', $('#cfgHours').value);
  fd.append('currency', $('#cfgCurrency').value);
  if ($('#cfgLogo').files[0]) fd.append('logo', $('#cfgLogo').files[0]);
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Configuración guardada ✅');
  await boot(false);
  fillConfigForm();
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
  $('#avatar').innerHTML = ME.tenant.logo
    ? `<img src="${ME.tenant.logo}" alt="" />`
    : esc(ME.tenant.businessName.charAt(0).toUpperCase());
  $('#openChatLink').href = `/c/${ME.tenant.slug}`;
  if (navigateToHash) {
    const view = (location.hash || '#dashboard').slice(1);
    navigate(VIEW_META[view] ? view : 'dashboard');
  }
}

boot().catch(() => (location.href = '/login'));
