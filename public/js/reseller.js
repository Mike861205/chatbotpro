let DATA = { prospects: [], clients: [], demoLeads: [], followUp: [], summary: {} };
let ME = null;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const STAGES = { new: 'Nuevo', contacted: 'Contactado', interested: 'Interesado', potential: 'Potencial a compra', follow_up: 'En seguimiento', won: 'Cierre exitoso', not_interested: 'No interesado', lost: 'Cierre no exitoso' };

function toast(message, error = false) {
  $('#toastMsg').textContent = message;
  const element = $('#toast');
  element.className = error ? 'show err' : 'show ok';
  clearTimeout(element._timer);
  element._timer = setTimeout(() => { element.className = ''; }, 3000);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    let slug = '';
    try { slug = sessionStorage.getItem('cbp_reseller_slug') || ''; } catch {}
    location.replace(slug ? `/resellers/${encodeURIComponent(slug)}` : '/');
    throw new Error('Sesión expirada');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Error de servidor');
  return data;
}

function fmtDate(value, includeTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return includeTime ? date.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : date.toLocaleDateString('es-MX', { dateStyle: 'medium' });
}

function stageChip(value) {
  const stage = String(value || 'new');
  const tone = stage === 'follow_up' ? 'follow-up' : stage.replaceAll('_', '-');
  return `<span class="sa-stage-chip stage-${tone}">${esc(STAGES[stage] || stage)}</span>`;
}

function whatsappButton(item) {
  const digits = String(item.phone_digits || '').replace(/\D/g, '');
  return item.phone_valid && digits ? `<a class="btn btn-ghost" href="https://wa.me/${digits}" target="_blank" rel="noopener noreferrer"><i class="ph-bold ph-whatsapp-logo"></i> WhatsApp</a>` : '';
}

function manageButton(type, item) {
  return `<button class="btn btn-primary" type="button" data-manage="${type}:${Number(item.id)}"><i class="ph-bold ph-note-pencil"></i> Gestionar</button>`;
}

function matches(item, query) {
  if (!query) return true;
  return Object.values(item).filter((value) => typeof value === 'string' || typeof value === 'number').join(' ').toLowerCase().includes(query);
}

function renderProspects() {
  const query = String(document.querySelector('[data-search="prospects"]')?.value || '').trim().toLowerCase();
  const items = DATA.prospects.filter((item) => matches(item, query));
  $('#prospectsTable').innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr><th>Negocio</th><th>Contacto</th><th>Etapa</th><th>Registro</th><th>Acciones</th></tr></thead><tbody>${items.map((item) => `<tr><td><b>${esc(item.business_name)}</b><div class="meta">/${esc(item.slug)}</div></td><td>${esc(item.owner_name)}<div class="meta">${esc(item.phone || '—')}</div></td><td>${stageChip(item.sales_stage)}${item.next_follow_up_at ? `<div class="meta">Próximo: ${fmtDate(item.next_follow_up_at, true)}</div>` : ''}</td><td>${fmtDate(item.created_at)}</td><td><div class="reseller-actions">${whatsappButton(item)}${manageButton('tenant', item)}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><i class="ph ph-buildings"></i><b>Sin prospectos</b><p>Los registros creados desde tu enlace aparecerán aquí.</p></div>';
  bindManage();
}

function renderClients() {
  const query = String(document.querySelector('[data-search="clients"]')?.value || '').trim().toLowerCase();
  const items = DATA.clients.filter((item) => matches(item, query));
  $('#clientsTable').innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr><th>Cliente</th><th>Contacto</th><th>Cliente desde</th><th>Plan</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${items.map((item) => `<tr><td><b>${esc(item.business_name)}</b><div class="meta">/${esc(item.slug)}</div></td><td>${esc(item.owner_name)}<div class="meta">${esc(item.phone || '—')}</div></td><td>${fmtDate(item.customer_since)}</td><td>${esc(item.plan_name || 'starter')}</td><td><span class="tag">${esc(item.billing_status || 'active')}</span></td><td>${whatsappButton(item)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><i class="ph ph-handshake"></i><b>Sin clientes todavía</b><p>Cuando un prospecto registre su primer pago aparecerá aquí.</p></div>';
}

function renderDemoLeads() {
  const query = String(document.querySelector('[data-search="demo-leads"]')?.value || '').trim().toLowerCase();
  const items = DATA.demoLeads.filter((item) => matches(item, query));
  $('#demoLeadsTable').innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr><th>Contacto</th><th>Giro</th><th>Etapa</th><th>Veces</th><th>Última visita</th><th>Acciones</th></tr></thead><tbody>${items.map((item) => `<tr><td><b>${esc(item.contact_name)}</b><div class="meta">${esc(item.phone || '—')}</div></td><td>${esc(item.business_giro)}</td><td>${stageChip(item.sales_stage)}</td><td>${Number(item.demo_count || 0)}</td><td>${fmtDate(item.last_seen_at, true)}</td><td><div class="reseller-actions">${whatsappButton(item)}${manageButton('demo_lead', item)}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><i class="ph ph-rocket-launch"></i><b>Sin leads demo</b><p>Las solicitudes de demo desde tu enlace aparecerán aquí.</p></div>';
  bindManage();
}

function renderFollowUp() {
  const query = String(document.querySelector('[data-search="follow-up"]')?.value || '').trim().toLowerCase();
  const filter = $('#stageFilter').value;
  const activeStages = new Set(['new', 'contacted', 'interested', 'potential', 'follow_up']);
  const items = DATA.followUp.filter((item) => (filter === 'all' || (filter === 'active' ? activeStages.has(item.sales_stage) : item.sales_stage === filter)) && matches(item, query));
  $('#followUpTable').innerHTML = items.length ? `<div class="table-wrap"><table><thead><tr><th>Candidato</th><th>Origen</th><th>Etapa</th><th>Próximo</th><th>Última gestión</th><th>Acciones</th></tr></thead><tbody>${items.map((item) => `<tr><td><b>${esc(item.name || item.contact_name)}</b><div class="meta">${esc(item.contact_name || '')} · ${esc(item.phone || '—')}</div></td><td><span class="tag">${item.entity_type === 'tenant' ? 'Prospecto' : 'Lead demo'}</span></td><td>${stageChip(item.sales_stage)}</td><td>${fmtDate(item.next_follow_up_at, true)}</td><td>${esc(item.last_note || 'Sin notas')}<div class="meta">${Number(item.activity_count || 0)} gestiones</div></td><td><div class="reseller-actions">${whatsappButton(item)}${manageButton(item.entity_type, item)}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><i class="ph ph-kanban"></i><b>Sin candidatos</b><p>No hay resultados en esta etapa.</p></div>';
  bindManage();
}

function renderAll() {
  $('#countProspects').textContent = Number(DATA.summary.prospects || 0);
  $('#countClients').textContent = Number(DATA.summary.clients || 0);
  $('#countDemos').textContent = Number(DATA.summary.demoLeads || 0);
  $('#countFollowUp').textContent = Number(DATA.summary.pendingFollowUp || 0);
  renderProspects(); renderClients(); renderDemoLeads(); renderFollowUp();
}

function findSubject(type, id) {
  const source = type === 'tenant' ? DATA.prospects : DATA.demoLeads;
  return source.find((item) => Number(item.id) === Number(id));
}

function bindManage() {
  document.querySelectorAll('[data-manage]').forEach((button) => {
    button.onclick = () => {
      const [type, id] = button.dataset.manage.split(':');
      openFollowUp(type, Number(id)).catch((error) => toast(error.message, true));
    };
  });
}

async function openFollowUp(type, id) {
  const item = findSubject(type, id);
  if (!item) return;
  $('#followUpType').value = type;
  $('#followUpId').value = String(id);
  $('#followUpSubject').textContent = type === 'tenant' ? item.business_name : `${item.contact_name} · ${item.business_giro}`;
  $('#followUpStage').value = item.sales_stage || 'new';
  $('#followUpActivity').value = 'contact';
  $('#followUpDate').value = item.next_follow_up_at ? new Date(item.next_follow_up_at).toISOString().slice(0, 16) : '';
  $('#followUpNote').value = '';
  const payload = await api(`/api/resellers/follow-up/${type}/${id}/activities`);
  $('#followUpHistory').innerHTML = payload.activities.length ? `<h3 style="margin-top:18px"><i class="ph-bold ph-clock-counter-clockwise"></i> Historial</h3>${payload.activities.map((activity) => `<div class="card" style="padding:10px;margin-top:8px"><b>${esc(STAGES[activity.stage_to] || activity.activity_type)}</b><div>${esc(activity.note || 'Sin nota')}</div><small>${fmtDate(activity.created_at, true)}</small></div>`).join('')}` : '<p class="hint" style="margin-top:14px">Sin gestiones anteriores.</p>';
  $('#followUpModal').classList.add('show');
}

async function loadData() {
  DATA = await api('/api/resellers/overview');
  renderAll();
}

function setView(view) {
  const meta = {
    prospects: ['ph-buildings', 'Prospectos', 'Negocios registrados desde tu enlace.'],
    clients: ['ph-handshake', 'Clientes', 'Negocios atribuidos que ya se convirtieron en clientes.'],
    'demo-leads': ['ph-rocket-launch', 'Leads demo', 'Personas que solicitaron la demo desde tu enlace.'],
    'follow-up': ['ph-kanban', 'Seguimiento', 'Notas, etapas y próximas acciones comerciales.'],
  }[view] || null;
  if (!meta) return;
  document.querySelectorAll('.reseller-view').forEach((section) => { section.hidden = section.id !== `view${view.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`; });
  document.querySelectorAll('[data-view]').forEach((link) => link.classList.toggle('active', link.dataset.view === view));
  $('#viewTitle').innerHTML = `<i class="ph-bold ${meta[0]}"></i> ${meta[1]}`;
  $('#viewSubtitle').textContent = meta[2];
}

document.querySelectorAll('[data-view]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); setView(link.dataset.view); history.replaceState(null, '', `#${link.dataset.view}`); }));
document.querySelectorAll('[data-search]').forEach((input) => input.addEventListener('input', () => ({ prospects: renderProspects, clients: renderClients, 'demo-leads': renderDemoLeads, 'follow-up': renderFollowUp }[input.dataset.search])()));
$('#stageFilter').addEventListener('change', renderFollowUp);
$('#reload').addEventListener('click', () => loadData().then(() => toast('Información actualizada')).catch((error) => toast(error.message, true)));
$('#copyLink').addEventListener('click', async () => { await navigator.clipboard.writeText($('#referralUrl').textContent); toast('Enlace copiado'); });
$('#logout').addEventListener('click', async () => { await fetch('/api/resellers/logout', { method: 'POST' }); location.replace(`/resellers/${encodeURIComponent(ME?.slug || '')}`); });
$('#followUpCancel').addEventListener('click', () => $('#followUpModal').classList.remove('show'));
$('#followUpModal').addEventListener('click', (event) => { if (event.target.id === 'followUpModal') $('#followUpModal').classList.remove('show'); });
$('#followUpForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = $('#followUpType').value;
  const id = Number($('#followUpId').value);
  try {
    await api(`/api/resellers/follow-up/${type}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: $('#followUpStage').value, activityType: $('#followUpActivity').value, nextFollowUpAt: $('#followUpDate').value ? new Date($('#followUpDate').value).toISOString() : null, note: $('#followUpNote').value }) });
    $('#followUpModal').classList.remove('show');
    await loadData();
    toast('Seguimiento guardado');
  } catch (error) { toast(error.message, true); }
});

(async () => {
  try {
    ME = await api('/api/resellers/me');
    $('#resellerName').textContent = ME.displayName || 'Reseller';
    $('#resellerUser').textContent = ME.username;
    const referralUrl = `${location.origin}${ME.referralUrl}`;
    $('#referralUrl').textContent = referralUrl;
    try { sessionStorage.setItem('cbp_reseller_slug', ME.slug); } catch {}
    const initial = ['prospects', 'clients', 'demo-leads', 'follow-up'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'prospects';
    setView(initial);
    await loadData();
  } catch (error) { toast(error.message, true); }
})();
