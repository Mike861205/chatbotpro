let DATA = { prospects: [], clients: [], demoLeads: [], followUp: [], summary: {} };
let ME = null;
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const RESELLER_SALES_STAGES = [
  ['new', 'Nuevo', 'new'],
  ['contacted', 'Contactado', 'contacted'],
  ['interested', 'Interesado', 'interested'],
  ['potential', 'Potencial a compra', 'potential'],
  ['follow_up', 'En seguimiento', 'follow-up'],
  ['won', 'Cierre exitoso', 'won'],
  ['not_interested', 'No interesado', 'not-interested'],
  ['lost', 'Cierre no exitoso', 'lost'],
];

const ACTIVITY_LABELS = {
  contact: 'Contactación',
  follow_up: 'Seguimiento',
  note: 'Nota interna',
  close_won: 'Cierre exitoso',
  close_lost: 'Cierre no exitoso',
  stage_change: 'Cambio de etapa',
};

const MODULE_LABELS = {
  dashboard: 'Panel principal',
  pedidos: 'Control de pedidos',
  clientes: 'Directorio de clientes',
  pos: 'Punto de venta (POS)',
  kds: 'Pantalla de cocina (KDS)',
  ventas: 'Reporte de ventas',
  productos: 'Catálogo de productos',
  costos: 'Costeo de recetas',
  inventarios: 'Control de inventario',
  'stock-sucursales': 'Stock sucursales',
  compras: 'Compras a proveedores',
  empleados: 'Gestión de personal',
  chatbot: 'Configuración chatbot',
  config: 'Ajustes del negocio',
  suscripciones: 'Facturación y plan',
  instrucciones: 'Guías de uso',
};

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

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('es-MX', { dateStyle: 'medium' });
}

function fmtDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function countryFlag(code) {
  const c = String(code || '').trim().toUpperCase();
  if (c.length !== 2) return '';
  return String.fromCodePoint(...[...c].map((char) => 127397 + char.charCodeAt(0)));
}

function salesStageMeta(value) {
  const found = RESELLER_SALES_STAGES.find(([key]) => key === String(value || 'new')) || RESELLER_SALES_STAGES[0];
  return { value: found[0], label: found[1], tone: found[2] };
}

function salesStageChip(value) {
  const stage = salesStageMeta(value);
  return `<span class="sa-stage-chip stage-${stage.tone}">${esc(stage.label)}</span>`;
}

function salesStageOptions({ includeAll = false, includeActive = false } = {}) {
  const options = [];
  if (includeAll) options.push('<option value="all">Todas las etapas</option>');
  if (includeActive) options.push('<option value="active">Candidatos activos</option>');
  options.push(...RESELLER_SALES_STAGES.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`));
  return options.join('');
}

function whatsappButton(item) {
  const digits = String(item.phone_digits || '').replace(/\D/g, '');
  return item.phone_valid && digits
    ? `<a class="btn btn-ghost" href="https://wa.me/${digits}" target="_blank" rel="noopener noreferrer" title="Contactar por WhatsApp"><i class="ph-bold ph-whatsapp-logo" style="color:#22c55e"></i> WhatsApp</a>`
    : '';
}

function copyPhoneButton(item) {
  return item.phone_valid && item.phone_e164
    ? `<button class="btn btn-ghost" type="button" data-copy-phone="${esc(item.phone_e164)}" title="Copiar teléfono"><i class="ph-bold ph-copy"></i> Copiar</button>`
    : '';
}

function manageButton(type, item) {
  return `<button class="btn btn-primary" type="button" data-manage="${type}:${Number(item.id)}"><i class="ph-bold ph-note-pencil"></i> Gestionar</button>`;
}

function moduleUsageButton(lead) {
  const count = Number(lead.module_views || 0);
  if (!count) return '<span class="meta">Sin visitas</span>';
  return `<button class="btn btn-ghost" type="button" data-view-modules="${lead.id}" style="font-size:11.5px;padding:4px 8px"><i class="ph-bold ph-browsers"></i> ${count} vista${count === 1 ? '' : 's'}</button>`;
}

function matches(item, query) {
  if (!query) return true;
  return Object.values(item).filter((value) => typeof value === 'string' || typeof value === 'number').join(' ').toLowerCase().includes(query);
}

function renderHeroCards() {
  $('#countProspects').textContent = Number(DATA.summary.prospects || 0);
  $('#countClients').textContent = Number(DATA.summary.clients || 0);
  $('#countDemos').textContent = Number(DATA.summary.demoLeads || 0);
  $('#countFollowUp').textContent = Number(DATA.summary.pendingFollowUp || 0);
}

function renderProspects() {
  const query = String(document.querySelector('[data-search="prospects"]')?.value || '').trim().toLowerCase();
  const stageFilter = String($('#prospectStageFilter')?.value || 'all');
  const items = DATA.prospects.filter((item) => {
    if (stageFilter !== 'all' && String(item.sales_stage || 'new') !== stageFilter) return false;
    return matches(item, query);
  });

  $('#prospectsTable').innerHTML = items.length
    ? `<div class="table-wrap"><table><thead><tr>
        <th>Negocio</th>
        <th>Contacto / Dueño</th>
        <th>Etapa Comercial</th>
        <th>Registro</th>
        <th>Última Gestión</th>
        <th>Acciones</th>
      </tr></thead><tbody>${items.map((item) => {
        const flag = countryFlag(item.phone_country);
        const overdue = item.next_follow_up_at && new Date(item.next_follow_up_at).getTime() < Date.now();
        return `<tr>
          <td>
            <b>${esc(item.business_name)}</b>
            <div class="meta">/${esc(item.slug)}</div>
          </td>
          <td>
            <b>${esc(item.owner_name)}</b>
            <div class="meta">${flag ? `${flag} ` : ''}${esc(item.phone || '—')}</div>
          </td>
          <td>
            ${salesStageChip(item.sales_stage)}
            ${item.next_follow_up_at ? `<div class="meta ${overdue ? 'sa-followup-overdue' : ''}">Próximo: ${fmtDateTime(item.next_follow_up_at)}</div>` : ''}
          </td>
          <td>${fmtDate(item.created_at)}</td>
          <td>
            ${item.last_note ? `<span class="sa-last-note">${esc(item.last_note)}</span>` : '<span class="meta">Sin notas</span>'}
            <div class="meta">${Number(item.activity_count || 0)} gestiones</div>
          </td>
          <td>
            <div class="reseller-actions">
              ${whatsappButton(item)}
              ${copyPhoneButton(item)}
              ${manageButton('tenant', item)}
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody></table></div>`
    : '<div class="empty"><i class="ph ph-buildings"></i><b>Sin prospectos</b><p>Los negocios registrados desde tu enlace comercial aparecerán aquí.</p></div>';

  bindActionButtons();
}

function renderClients() {
  const query = String(document.querySelector('[data-search="clients"]')?.value || '').trim().toLowerCase();
  const items = DATA.clients.filter((item) => matches(item, query));

  $('#clientsTable').innerHTML = items.length
    ? `<div class="table-wrap"><table><thead><tr>
        <th>Cliente / Negocio</th>
        <th>Contacto</th>
        <th>Cliente desde</th>
        <th>Plan</th>
        <th>Estado</th>
        <th>Acciones</th>
      </tr></thead><tbody>${items.map((item) => {
        const flag = countryFlag(item.phone_country);
        return `<tr>
          <td>
            <b>${esc(item.business_name)}</b>
            <div class="meta">/${esc(item.slug)}</div>
          </td>
          <td>
            <b>${esc(item.owner_name)}</b>
            <div class="meta">${flag ? `${flag} ` : ''}${esc(item.phone || '—')}</div>
          </td>
          <td>${fmtDate(item.customer_since)}</td>
          <td><span class="tag">${esc(item.plan_name || 'starter')}</span></td>
          <td><span class="tag ${item.billing_status === 'active' ? 'tone-active' : ''}">${esc(item.billing_status || 'active')}</span></td>
          <td>
            <div class="reseller-actions">
              ${whatsappButton(item)}
              ${copyPhoneButton(item)}
              ${manageButton('tenant', item)}
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody></table></div>`
    : '<div class="empty"><i class="ph ph-handshake"></i><b>Sin clientes convertidos</b><p>Cuando un prospecto active su plan de pago aparecerá en esta lista.</p></div>';

  bindActionButtons();
}

function renderDemoLeads() {
  const query = String(document.querySelector('[data-search="demo-leads"]')?.value || '').trim().toLowerCase();
  const stageFilter = String($('#demoStageFilter')?.value || 'all');
  const items = DATA.demoLeads.filter((item) => {
    if (stageFilter !== 'all' && String(item.sales_stage || 'new') !== stageFilter) return false;
    return matches(item, query);
  });

  $('#demoLeadsTable').innerHTML = items.length
    ? `<div class="table-wrap"><table><thead><tr>
        <th>Contacto</th>
        <th>Giro del Negocio</th>
        <th>Etapa Comercial</th>
        <th>Visitas Demo</th>
        <th>Última Visita</th>
        <th>Módulos</th>
        <th>Acciones</th>
      </tr></thead><tbody>${items.map((item) => {
        const flag = countryFlag(item.phone_country);
        const overdue = item.next_follow_up_at && new Date(item.next_follow_up_at).getTime() < Date.now();
        return `<tr>
          <td>
            <b>${esc(item.contact_name)}</b>
            <div class="meta">${flag ? `${flag} ` : ''}${esc(item.phone || '—')}</div>
          </td>
          <td>${esc(item.business_giro)}</td>
          <td>
            ${salesStageChip(item.sales_stage)}
            ${item.next_follow_up_at ? `<div class="meta ${overdue ? 'sa-followup-overdue' : ''}">Próximo: ${fmtDateTime(item.next_follow_up_at)}</div>` : ''}
          </td>
          <td><b>${Number(item.demo_count || 0)}</b></td>
          <td>${fmtDateTime(item.last_seen_at)}</td>
          <td>${moduleUsageButton(item)}</td>
          <td>
            <div class="reseller-actions">
              ${whatsappButton(item)}
              ${copyPhoneButton(item)}
              ${manageButton('demo_lead', item)}
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody></table></div>`
    : '<div class="empty"><i class="ph ph-rocket-launch"></i><b>Sin leads demo</b><p>Las solicitudes de prueba desde tu enlace aparecerán aquí.</p></div>';

  bindActionButtons();
}

function renderFollowUpSummary() {
  const el = $('#resellerFollowUpSummary');
  if (!el) return;
  const stages = ['contacted', 'interested', 'potential', 'follow_up'];
  el.innerHTML = stages.map((stage) => {
    const meta = salesStageMeta(stage);
    const count = DATA.followUp.filter((item) => item.sales_stage === stage).length;
    return `<button type="button" class="card sa-followup-stage-card stage-${meta.tone}" data-reseller-stage-card="${stage}">
      <span>${esc(meta.label)}</span>
      <b>${count}</b>
    </button>`;
  }).join('');

  document.querySelectorAll('[data-reseller-stage-card]').forEach((button) => {
    button.onclick = () => {
      $('#followUpStageFilter').value = button.dataset.resellerStageCard;
      renderFollowUp();
    };
  });
}

function renderFollowUp() {
  const query = String(document.querySelector('[data-search="follow-up"]')?.value || '').trim().toLowerCase();
  const stageFilter = String($('#followUpStageFilter')?.value || 'active');
  const typeFilter = String($('#followUpTypeFilter')?.value || 'all');
  const activeStages = new Set(['contacted', 'interested', 'potential', 'follow_up']);

  const items = DATA.followUp.filter((item) => {
    if (typeFilter !== 'all' && item.entity_type !== typeFilter) return false;
    if (stageFilter === 'active' && !activeStages.has(item.sales_stage)) return false;
    if (stageFilter !== 'all' && stageFilter !== 'active' && String(item.sales_stage || 'new') !== stageFilter) return false;
    return matches(item, query);
  });

  $('#followUpTable').innerHTML = items.length
    ? `<div class="table-wrap"><table><thead><tr>
        <th>Candidato</th>
        <th>Origen</th>
        <th>Etapa</th>
        <th>Próximo Seguimiento</th>
        <th>Última Gestión</th>
        <th>Acciones</th>
      </tr></thead><tbody>${items.map((item) => {
        const overdue = item.next_follow_up_at && new Date(item.next_follow_up_at).getTime() < Date.now();
        const flag = countryFlag(item.phone_country);
        return `<tr>
          <td>
            <b>${esc(item.name || item.contact_name)}</b>
            <div class="meta">${esc(item.contact_name || '')} · ${flag ? `${flag} ` : ''}${esc(item.phone || '—')}</div>
          </td>
          <td><span class="tag">${item.entity_type === 'tenant' ? 'Prospecto' : 'Lead demo'}</span></td>
          <td>${salesStageChip(item.sales_stage)}</td>
          <td><span class="${overdue ? 'sa-followup-overdue' : ''}">${item.next_follow_up_at ? fmtDateTime(item.next_follow_up_at) : 'Sin programar'}</span></td>
          <td>
            ${item.last_note ? `<span class="sa-last-note">${esc(item.last_note)}</span>` : '<span class="meta">Sin notas</span>'}
            <div class="meta">${Number(item.activity_count || 0)} gestiones · ${fmtDateTime(item.last_activity_at)}</div>
          </td>
          <td>
            <div class="reseller-actions">
              ${whatsappButton(item)}
              ${copyPhoneButton(item)}
              ${manageButton(item.entity_type, item)}
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody></table></div>`
    : '<div class="empty"><i class="ph ph-kanban"></i><b>Sin candidatos en esta etapa</b><p>Gestiona tus prospectos o leads para incorporarlos al seguimiento.</p></div>';

  bindActionButtons();
}

function renderAll() {
  renderHeroCards();
  renderFollowUpSummary();
  renderProspects();
  renderClients();
  renderDemoLeads();
  renderFollowUp();
}

function findSubject(type, id) {
  if (type === 'tenant') return DATA.prospects.find((item) => Number(item.id) === Number(id)) || DATA.clients.find((item) => Number(item.id) === Number(id));
  return DATA.demoLeads.find((item) => Number(item.id) === Number(id));
}

function bindActionButtons() {
  document.querySelectorAll('[data-manage]').forEach((button) => {
    button.onclick = () => {
      const [type, id] = button.dataset.manage.split(':');
      openFollowUp(type, Number(id)).catch((error) => toast(error.message, true));
    };
  });

  document.querySelectorAll('[data-copy-phone]').forEach((button) => {
    button.onclick = async () => {
      await navigator.clipboard.writeText(button.dataset.copyPhone);
      toast('Teléfono copiado al portapapeles');
    };
  });

  document.querySelectorAll('[data-view-modules]').forEach((button) => {
    button.onclick = () => {
      const id = Number(button.dataset.viewModules);
      const lead = DATA.demoLeads.find((item) => Number(item.id) === id);
      if (lead) openModuleModal(lead);
    };
  });
}

function openModuleModal(lead) {
  $('#resellerModuleSubject').textContent = `${lead.contact_name} (${lead.business_giro}) · ${lead.module_views || 0} vistas`;
  const modules = Array.isArray(lead.modules) ? lead.modules : [];
  $('#resellerModuleContent').innerHTML = modules.length
    ? `<div class="table-wrap"><table class="module-detail-table"><thead><tr><th>Módulo</th><th>Vistas</th><th>Primera vez</th><th>Última vez</th></tr></thead><tbody>${modules.map((m) => `<tr><td><b>${esc(MODULE_LABELS[m.key] || m.key)}</b></td><td><b>${Number(m.count || 0)}</b></td><td>${fmtDateTime(m.firstSeenAt)}</td><td>${fmtDateTime(m.lastSeenAt)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="hint">Sin detalle de módulos registrados.</p>';
  $('#resellerModuleModal').classList.add('show');
}

async function openFollowUp(type, id) {
  const item = findSubject(type, id);
  if (!item) return;
  $('#followUpType').value = type;
  $('#followUpId').value = String(id);
  $('#followUpSubjectTitle').textContent = type === 'tenant' ? item.business_name : item.contact_name;
  $('#followUpSubjectSubtitle').textContent = type === 'tenant' ? `Dueño: ${item.owner_name} · ${item.phone || ''}` : `Giro: ${item.business_giro} · ${item.phone || ''}`;
  $('#followUpSubjectBadge').innerHTML = `<span class="tag">${type === 'tenant' ? 'Prospecto' : 'Lead demo'}</span>`;
  $('#followUpStage').innerHTML = salesStageOptions();
  $('#followUpStage').value = item.sales_stage || 'new';
  $('#followUpActivity').value = 'contact';
  $('#followUpDate').value = item.next_follow_up_at ? toDateTimeLocal(item.next_follow_up_at) : '';
  $('#followUpNote').value = '';
  $('#followUpHistory').innerHTML = '<div class="hint">Cargando historial de actividades...</div>';
  $('#followUpModal').classList.add('show');

  try {
    const payload = await api(`/api/resellers/follow-up/${type}/${id}/activities`);
    renderFollowUpHistory(payload.activities || []);
  } catch (error) {
    $('#followUpHistory').innerHTML = `<div class="hint">${esc(error.message)}</div>`;
  }
}

function renderFollowUpHistory(activities) {
  const el = $('#followUpHistory');
  if (!el) return;
  if (!activities.length) {
    el.innerHTML = '<div class="empty sa-history-empty"><i class="ph ph-note"></i><b>Sin gestiones anteriores</b><p>Registra la primera llamada o nota para dar seguimiento.</p></div>';
    return;
  }
  el.innerHTML = `<div class="sa-activity-list">${activities.map((item) => `
    <article class="sa-activity-item">
      <div>
        <b>${esc(ACTIVITY_LABELS[item.activity_type] || item.activity_type)}</b>
        <time>${fmtDateTime(item.created_at)}</time>
      </div>
      ${item.stage_from !== item.stage_to ? `<div>${salesStageChip(item.stage_from)} <i class="ph-bold ph-arrow-right"></i> ${salesStageChip(item.stage_to)}</div>` : ''}
      ${item.note ? `<p>${esc(item.note)}</p>` : ''}
      ${item.follow_up_at ? `<small><i class="ph-bold ph-calendar-check"></i> Próximo: ${fmtDateTime(item.follow_up_at)}</small>` : ''}
      <small>Por ${esc(item.created_by || 'reseller')}</small>
    </article>
  `).join('')}</div>`;
}

async function loadData() {
  DATA = await api('/api/resellers/overview');
  renderAll();
}

function setView(view) {
  const meta = {
    prospects: ['ph-buildings', 'Prospectos', 'Negocios registrados desde tu enlace comercial.'],
    clients: ['ph-handshake', 'Clientes', 'Negocios atribuidos que ya se convirtieron en clientes activos.'],
    'demo-leads': ['ph-rocket-launch', 'Leads demo', 'Personas que solicitaron la demo desde tu enlace comercial.'],
    'follow-up': ['ph-kanban', 'Seguimiento comercial', 'Notas, etapas y próximas acciones comerciales para cerrar ventas.'],
  }[view] || null;
  if (!meta) return;

  document.querySelectorAll('.reseller-view').forEach((section) => {
    section.hidden = section.id !== `view${view.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}`;
  });

  document.querySelectorAll('[data-view]').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === view);
  });

  document.querySelectorAll('.reseller-hero-card').forEach((card) => {
    card.classList.toggle('active-tab', card.dataset.navTarget === view);
  });

  $('#viewTitle').innerHTML = `<i class="ph-bold ${meta[0]}"></i> ${meta[1]}`;
  $('#viewSubtitle').textContent = meta[2];
}

// Event Listeners
document.querySelectorAll('[data-view]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    setView(link.dataset.view);
    history.replaceState(null, '', `#${link.dataset.view}`);
  });
});

document.querySelectorAll('.reseller-hero-card[data-nav-target]').forEach((card) => {
  card.addEventListener('click', () => {
    const target = card.dataset.navTarget;
    setView(target);
    history.replaceState(null, '', `#${target}`);
  });
});

document.querySelectorAll('[data-search]').forEach((input) => {
  input.addEventListener('input', () => {
    ({
      prospects: renderProspects,
      clients: renderClients,
      'demo-leads': renderDemoLeads,
      'follow-up': renderFollowUp,
    }[input.dataset.search])();
  });
});

$('#prospectStageFilter')?.addEventListener('change', renderProspects);
$('#demoStageFilter')?.addEventListener('change', renderDemoLeads);
$('#followUpStageFilter')?.addEventListener('change', renderFollowUp);
$('#followUpTypeFilter')?.addEventListener('change', renderFollowUp);

$('#reload')?.addEventListener('click', () => {
  loadData()
    .then(() => toast('Información comercial actualizada'))
    .catch((error) => toast(error.message, true));
});

$('#copyLink')?.addEventListener('click', async () => {
  const url = $('#referralUrl').textContent;
  await navigator.clipboard.writeText(url);
  toast('Enlace comercial copiado');
});

$('#logout')?.addEventListener('click', async () => {
  await fetch('/api/resellers/logout', { method: 'POST' });
  location.replace(`/resellers/${encodeURIComponent(ME?.slug || '')}`);
});

$('#followUpCancel')?.addEventListener('click', () => $('#followUpModal').classList.remove('show'));
$('#followUpModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'followUpModal') $('#followUpModal').classList.remove('show');
});

$('#resellerModuleClose')?.addEventListener('click', () => $('#resellerModuleModal').classList.remove('show'));
$('#resellerModuleModal')?.addEventListener('click', (event) => {
  if (event.target.id === 'resellerModuleModal') $('#resellerModuleModal').classList.remove('show');
});

$('#followUpForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = $('#followUpType').value;
  const id = Number($('#followUpId').value);
  try {
    await api(`/api/resellers/follow-up/${type}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stage: $('#followUpStage').value,
        activityType: $('#followUpActivity').value,
        nextFollowUpAt: $('#followUpDate').value ? new Date($('#followUpDate').value).toISOString() : null,
        note: $('#followUpNote').value,
      }),
    });
    $('#followUpModal').classList.remove('show');
    await loadData();
    toast('Gestión comercial guardada exitosamente');
  } catch (error) {
    toast(error.message, true);
  }
});

// Inicialización
(async () => {
  try {
    ME = await api('/api/resellers/me');
    $('#resellerName').textContent = ME.displayName || 'Reseller';
    $('#resellerUser').textContent = ME.username;
    const referralUrl = `${location.origin}${ME.referralUrl}`;
    $('#referralUrl').textContent = referralUrl;
    $('#openLink').href = referralUrl;
    $('#shareWhatsApp').href = `https://wa.me/?text=${encodeURIComponent(`Hola! Te comparto nuestro sistema de pedidos por chatbot para restaurantes: ${referralUrl}`)}`;

    try { sessionStorage.setItem('cbp_reseller_slug', ME.slug); } catch {}

    // Inicializar filtros de etapa
    if ($('#prospectStageFilter')) $('#prospectStageFilter').innerHTML = salesStageOptions({ includeAll: true });
    if ($('#demoStageFilter')) $('#demoStageFilter').innerHTML = salesStageOptions({ includeAll: true });
    if ($('#followUpStageFilter')) {
      $('#followUpStageFilter').innerHTML = salesStageOptions({ includeAll: true, includeActive: true });
      $('#followUpStageFilter').value = 'active';
    }

    const initial = ['prospects', 'clients', 'demo-leads', 'follow-up'].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : 'prospects';
    setView(initial);
    await loadData();
  } catch (error) {
    toast(error.message, true);
  }
})();
