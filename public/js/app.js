/* ===== ChatBotPro — lógica del panel v2 ===== */
let ME = null;
let SETTINGS = null;
let salesChart = null;
let topChart = null;
let orderStatusFilter = '';

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

/* ===== Navegación ===== */
const VIEW_META = {
  dashboard: ['Dashboard', 'Resumen de tu negocio', 'ph-chart-pie-slice'],
  pedidos: ['Pedidos', 'Administra y actualiza tus pedidos', 'ph-receipt'],
  productos: ['Productos', 'Tu menú visible en el chatbot', 'ph-hamburger'],
  chatbot: ['Mi chatbot', 'Configura el flujo y comparte tu liga', 'ph-chat-circle-dots'],
  config: ['Mi negocio', 'Identidad, branding y contacto', 'ph-storefront'],
};

function navigate(view) {
  document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `view-${view}`));
  const [title, sub, icon] = VIEW_META[view] || VIEW_META.dashboard;
  $('#viewTitle').innerHTML = `<i class="ph-bold ${icon}"></i> ${title}`;
  $('#viewSub').textContent = sub;
  closeSidebar();
  if (view === 'dashboard') loadDashboard();
  if (view === 'pedidos') loadOrders();
  if (view === 'productos') loadProducts();
  if (view === 'chatbot') fillBotForm();
  if (view === 'config') fillConfigForm();
}
window.navigate = navigate;

document.querySelectorAll('.sidebar nav a').forEach((a) =>
  a.addEventListener('click', (e) => {
    e.preventDefault();
    history.replaceState(null, '', `#${a.dataset.view}`);
    navigate(a.dataset.view);
  })
);
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
      return `<tr>
        <td><b>#${o.id}</b></td>
        <td><div class="cust">${custAvatar(o.customer?.name)}<div class="cmeta"><b>${esc(o.customer?.name || '—')}</b><span>${esc(o.customer?.phone || '')}</span></div></div></td>
        <td style="max-width:280px">${esc(items)}</td>
        <td style="white-space:nowrap">${o.delivery === 'domicilio' ? '<i class="ph-bold ph-moped" style="color:var(--blue)"></i> Domicilio' : '<i class="ph-bold ph-storefront" style="color:var(--violet)"></i> Recoger'}</td>
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
  $('#ordersTable').innerHTML = orders.length
    ? ordersTableHTML(orders, true)
    : emptyHTML('ph-funnel', 'Sin resultados', 'No hay pedidos con este filtro.');
  document.querySelectorAll('.status-sel').forEach((sel) =>
    sel.addEventListener('change', async () => {
      try {
        await api(`/api/orders/${sel.dataset.order}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: sel.value }),
        });
        sel.className = `status-sel s-${sel.value}`;
        toast(`Pedido #${sel.dataset.order} → ${sel.value}`);
        loadDashboardBadge();
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
}
window.loadOrders = loadOrders;

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
[$('#prodModal'), $('#catModal'), $('#confirmModal')].forEach((m) =>
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
function fillBotForm() {
  if (!SETTINGS) return;
  const link = `${location.origin}/c/${SETTINGS.slug}`;
  $('#chatLink').value = link;
  $('#qrImg').src = `https://api.qrserver.com/v1/create-qr-code/?size=296x296&margin=8&data=${encodeURIComponent(link)}`;
  $('#waShareBtn').href = `https://wa.me/?text=${encodeURIComponent(`¡Haz tu pedido en ${SETTINGS.business_name}! 🍔 Ordena aquí: ${link}`)}`;
  $('#botWelcome').value = SETTINGS.welcome_message || '';
  $('#botWhatsapp').value = SETTINGS.whatsapp || '';
  $('#botDelivery').checked = SETTINGS.delivery_enabled === '1';
  $('#botPickup').checked = SETTINGS.pickup_enabled === '1';
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
  await api('/api/settings', { method: 'PUT', body: fd });
  toast('Flujo del chatbot guardado');
  SETTINGS = await api('/api/settings');
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
    ? `<img src="${esc(ME.tenant.logo)}" alt="" />`
    : esc(ME.tenant.businessName.charAt(0).toUpperCase());
  $('#openChatLink').href = `/c/${ME.tenant.slug}`;
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
