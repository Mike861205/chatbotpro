/* Módulo WhatsApp: conexión Zernio, bandeja y puente al flujo actual de pedidos. */
let WHATSAPP_DATA = { connections: [], conversations: [] };
let WHATSAPP_SELECTED_CONNECTION = null;
let WHATSAPP_SELECTED_CONVERSATION = null;
let WHATSAPP_BOUND = false;
let WHATSAPP_SOCKET = null;
let WHATSAPP_CHANNEL_CHOICES = [];
let WHATSAPP_DISCOVERY_VERSION = 0;
let WHATSAPP_SETUP_BUSY = false;

function whatsappAnalyticsDateKey(date = new Date()) {
  const timezone = ME?.tenant?.timezone || undefined;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function whatsappAnalyticsLocalKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function whatsappAnalyticsRange() {
  const preset = $('#whatsappAnalyticsRange')?.value || 'today';
  const today = whatsappAnalyticsDateKey();
  if (preset === 'custom') {
    const from = $('#whatsappAnalyticsFrom')?.value || today;
    const to = $('#whatsappAnalyticsTo')?.value || from;
    return { from, to };
  }
  const date = new Date(`${today}T12:00:00`);
  let from = today;
  if (preset === 'week') {
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1);
    from = whatsappAnalyticsLocalKey(date);
  } else if (preset === 'month') {
    from = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
  } else if (preset === 'year') {
    from = `${date.getFullYear()}-01-01`;
  }
  return { from, to: today };
}

function whatsappAnalyticsDateLabel(value) {
  if (!value) return '—';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function syncWhatsAppAnalyticsFilterVisibility() {
  const custom = $('#whatsappAnalyticsRange')?.value === 'custom';
  if ($('#whatsappAnalyticsFromField')) $('#whatsappAnalyticsFromField').hidden = !custom;
  if ($('#whatsappAnalyticsToField')) $('#whatsappAnalyticsToField').hidden = !custom;
  if (custom) {
    const range = whatsappAnalyticsRange();
    if ($('#whatsappAnalyticsFrom') && !$('#whatsappAnalyticsFrom').value) $('#whatsappAnalyticsFrom').value = range.from;
    if ($('#whatsappAnalyticsTo') && !$('#whatsappAnalyticsTo').value) $('#whatsappAnalyticsTo').value = range.to;
  }
}

async function loadWhatsAppAnalytics() {
  const range = whatsappAnalyticsRange();
  if (range.from > range.to) throw new Error('La fecha inicial no puede ser posterior a la fecha final');
  const query = new URLSearchParams({ from: range.from, to: range.to });
  const result = await api(`/api/whatsapp/analytics?${query.toString()}`);
  const totals = result?.totals || {};
  const number = new Intl.NumberFormat('es-MX');
  const chats = $('#whatsappMetricChats');
  const messages = $('#whatsappMetricMessages');
  const orders = $('#whatsappMetricOrders');
  if (chats) chats.textContent = number.format(Number(totals.chats || 0));
  if (messages) messages.textContent = number.format(Number(totals.messagesWithCost || 0));
  if (orders) orders.textContent = number.format(Number(totals.successfulOrders || 0));
  const label = $('#whatsappAnalyticsRangeLabel');
  if (label) label.textContent = `Del ${whatsappAnalyticsDateLabel(result?.from || range.from)} al ${whatsappAnalyticsDateLabel(result?.to || range.to)}`;
  const messagesHint = $('#whatsappMetricMessagesHint');
  if (messagesHint) messagesHint.textContent = 'Enviados por la API sin error';
  const ordersHint = $('#whatsappMetricOrdersHint');
  if (ordersHint) ordersHint.textContent = 'Pedidos WhatsApp no cancelados';
}

function normalizeWhatsAppEntryNumber(value) {
  let digits = String(value || '').replace(/\D/g, '').replace(/^00+/, '');
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  if (digits.length === 10) digits = `52${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : '';
}

function whatsappEntryNumber(row) {
  return normalizeWhatsAppEntryNumber(row?.phoneNumber)
    || normalizeWhatsAppEntryNumber(row?.sandbox?.number);
}

function whatsappEntryLink(number) {
  return number ? `https://wa.me/${number}?text=${encodeURIComponent('Hola, quiero hacer un pedido')}` : '';
}

function renderWhatsAppCustomerEntry(row = WHATSAPP_SELECTED_CONNECTION) {
  const card = $('#whatsappCustomerEntryCard');
  if (!card) return;
  card.hidden = !row?.enabled || !whatsappEntryNumber(row);
  if (!row) return;
  const number = whatsappEntryNumber(row);
  const numberLabel = number ? `+${number}` : 'Número pendiente';
  const link = whatsappEntryLink(number);
  const input = $('#whatsappCustomerLink');
  const qr = $('#whatsappCustomerQr');
  const open = $('#whatsappCustomerOpenBtn');
  const copy = $('#whatsappCustomerCopyBtn');
  const share = $('#whatsappCustomerShareBtn');
  const syncPhoto = $('#whatsappSyncProfilePhotoBtn');
  const logo = String(ME?.tenant?.logo || '').trim();
  const logoImage = $('#whatsappCustomerEntryLogo');
  const logoFallback = $('#whatsappCustomerEntryLogoFallback');
  const businessName = String(ME?.tenant?.businessName || '').trim();
  $('#whatsappCustomerEntryNumber').textContent = numberLabel;
  $('#whatsappCustomerEntryBusiness').textContent = businessName ? `Pide por ${businessName}` : 'Pide por WhatsApp';
  $('#whatsappCustomerEntryHint').textContent = link
    ? 'Comparte este QR o enlace directo; abrirá WhatsApp con un mensaje listo para enviar.'
    : 'Conecta tu número o activa el teléfono de prueba para generar el enlace.';
  if (input) input.value = link;
  if (qr) {
    qr.hidden = !link;
    qr.src = link ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(link)}` : '';
  }
  if (open) { open.href = link || '#'; open.classList.toggle('disabled', !link); open.setAttribute('aria-disabled', String(!link)); }
  if (copy) copy.disabled = !link;
  if (share) share.disabled = !link;
  if (logoImage) {
    logoImage.hidden = !logo;
    logoImage.src = logo || '';
    logoImage.alt = businessName ? `Logo de ${businessName}` : 'Logo del negocio';
    logoImage.onerror = () => { logoImage.hidden = true; if (logoFallback) logoFallback.hidden = false; };
  }
  if (logoFallback) logoFallback.hidden = Boolean(logo);
  if (syncPhoto) syncPhoto.disabled = !row?.id || !row?.zernioAccountId || !logo || row?.mode !== 'api';
  const profilePhotoHint = $('#whatsappProfilePhotoHint');
  if (profilePhotoHint) {
    profilePhotoHint.innerHTML = row?.mode === 'business_app'
      ? '<i class="ph-bold ph-info"></i><span>La foto se toma del logo configurado en <b>Mi negocio</b>. En coexistencia, WhatsApp exige cambiarla desde la app del teléfono.</span>'
      : logo
        ? '<i class="ph-bold ph-check-circle"></i><span>Usa el logo de <b>Mi negocio</b>. Pulsa <b>Sincronizar foto</b> para enviarlo al perfil de WhatsApp.</span>'
        : '<i class="ph-bold ph-info"></i><span>Configura primero el logo en <b>Mi negocio</b> para poder sincronizar la foto del perfil.</span>';
  }
}

function whatsappConnectionStatus(status, enabled, mode) {
  const key = String(status || '').toLowerCase();
  if (key === 'error') return { label: 'Revisar conexión', tone: 'danger' };
  if (key === 'pending') return { label: 'Pendiente de activar', tone: 'warning' };
  if (!enabled) return { label: 'Desactivada', tone: 'muted' };
  if (mode === 'sandbox') return { label: 'Sandbox activa', tone: 'info' };
  if (key === 'active') return { label: 'Activa', tone: 'success' };
  if (key === 'error') return { label: 'Revisar conexión', tone: 'danger' };
  if (key === 'connected') return { label: 'Conectada', tone: 'info' };
  return { label: 'Pendiente', tone: 'warning' };
}

function renderWhatsAppConnections() {
  const host = $('#whatsappConnectionsList');
  if (!host) return;
  const rows = Array.isArray(WHATSAPP_DATA.connections) ? WHATSAPP_DATA.connections : [];
  if (!rows.length) {
    host.innerHTML = `<div class="whatsapp-empty-state compact"><i class="ph-duotone ph-plugs-connected"></i><b>Sin conexiones todavía</b><span>Guarda la cuenta de Zernio del tenant para comenzar.</span></div>`;
    return;
  }
  host.innerHTML = rows.map((row) => {
    const state = whatsappConnectionStatus(row.status, row.enabled, row.mode);
    const selected = Number(row.id) === Number(WHATSAPP_SELECTED_CONNECTION?.id);
    return `<button type="button" class="whatsapp-connection-row ${selected ? 'selected' : ''}" data-whatsapp-connection="${row.id}">
      <span class="whatsapp-connection-icon"><i class="ph-bold ph-whatsapp-logo"></i></span>
      <span class="whatsapp-connection-copy"><b>${esc(row.displayName || row.phoneNumber || 'WhatsApp del negocio')}</b><small>${esc(row.phoneNumber || 'Número pendiente')} · ${row.mode === 'sandbox' ? 'Pruebas' : row.mode === 'business_app' ? 'API + celular' : 'Cloud API'}</small></span>
      <span class="whatsapp-status-pill ${state.tone}">${esc(state.label)}</span>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-whatsapp-connection]').forEach((button) => button.addEventListener('click', () => selectWhatsAppConnection(Number(button.dataset.whatsappConnection))));
}

function renderWhatsAppChannelChoices(choices, preferred = '') {
  WHATSAPP_CHANNEL_CHOICES = Array.isArray(choices) ? choices : [];
  const select = $('#whatsappChannel');
  const selected = WHATSAPP_CHANNEL_CHOICES.some((choice) => choice.channelId === preferred)
    ? preferred : WHATSAPP_CHANNEL_CHOICES.length === 1 ? WHATSAPP_CHANNEL_CHOICES[0].channelId : '';
  select.innerHTML = '<option value="">Selecciona tu número o cuenta</option>' + WHATSAPP_CHANNEL_CHOICES
    .map((choice) => `<option value="${esc(choice.channelId)}">${esc(choice.label)}</option>`).join('');
  select.value = selected;
}

function syncWhatsAppSetupActions() {
  const row = WHATSAPP_SELECTED_CONNECTION;
  const mode = $('#whatsappMode').value;
  const sandbox = mode === 'sandbox';
  const savedMode = row?.mode === mode;
  $('#whatsappChannelField').hidden = sandbox;
  $('#whatsappSandboxPanel').hidden = !sandbox;
  $('#whatsappModeHint').textContent = sandbox
    ? 'Guarda la conexión y activa abajo el teléfono desde el que harás la prueba.'
    : mode === 'business_app'
      ? 'Conserva WhatsApp Business en el celular y atiende también desde el sistema.'
      : 'Usa tu número de Zernio para recibir pedidos y responder desde este sistema.';
  $('#whatsappConnectMetaBtn').hidden = sandbox || (savedMode && row?.enabled && row?.status === 'active');
  $('#whatsappConnectMetaBtn').disabled = WHATSAPP_SETUP_BUSY || !savedMode || !row?.profileId;
  $('#whatsappTestBtn').hidden = sandbox;
  $('#whatsappTestBtn').disabled = WHATSAPP_SETUP_BUSY || !savedMode || !row?.zernioAccountId;
  ['Activate', 'Refresh', 'Start', 'Discover', 'Revoke'].forEach((action) => {
    const button = $(`#whatsappSandbox${action}Btn`);
    if (button) button.disabled = WHATSAPP_SETUP_BUSY || !savedMode || !row?.id;
  });
}

function renderWhatsAppSetupStatus(row) {
  const host = $('#whatsappSetupStatus');
  host.hidden = !row;
  if (!row) { $('#whatsappWebhookCard').hidden = true; return; }
  const state = whatsappConnectionStatus(row.status, row.enabled, row.mode);
  const message = row.lastError || (row.enabled
    ? 'Tu canal está activo y puede atender pedidos.'
    : row.mode === 'sandbox' ? 'Activa tu teléfono de prueba para comenzar.'
      : 'Conexión guardada. Completa la activación con Meta y revisa el estado.');
  host.className = `whatsapp-setup-status ${row.lastError ? 'danger' : state.tone}`;
  host.innerHTML = `<i class="ph-bold ${row.lastError ? 'ph-warning-circle' : row.enabled ? 'ph-check-circle' : 'ph-info'}"></i><span><b>${esc(state.label)}</b>${esc(message)}</span>`;
  const card = $('#whatsappWebhookCard');
  if (card) {
    card.hidden = !row.webhookUrl;
    $('#whatsappWebhookUrl').textContent = row.webhookUrl || '—';
    $('#whatsappWebhookStatus').textContent = row.webhookError
      ? `No se pudo configurar la recepción: ${row.webhookError}. Guarda nuevamente para reintentar.`
      : row.webhookRegistered ? 'Webhook configurado automáticamente. No necesitas copiar la URL ni un secreto.'
        : 'La recepción de mensajes está pendiente. Guarda la conexión para configurarla.';
  }
}

async function discoverWhatsAppChannels() {
  const version = ++WHATSAPP_DISCOVERY_VERSION;
  const button = $('#whatsappDiscoverBtn');
  const hint = $('#whatsappChannelHint');
  button.disabled = true;
  hint.textContent = 'Consultando tus números y cuentas en Zernio…';
  try {
    const result = await api('/api/whatsapp/connections/discover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number($('#whatsappConnectionId').value) || undefined,
        apiKey: $('#whatsappApiKey').value.trim(), mode: $('#whatsappMode').value }),
    });
    if (version !== WHATSAPP_DISCOVERY_VERSION) return false;
    renderWhatsAppChannelChoices(result.choices, $('#whatsappChannel').value);
    hint.textContent = WHATSAPP_CHANNEL_CHOICES.length === 1
      ? 'Cuenta detectada. Guarda la conexión para activar el canal.'
      : 'Encontramos varias cuentas. Selecciona la que usará este negocio.';
    return true;
  } catch (error) {
    if (version === WHATSAPP_DISCOVERY_VERSION) hint.textContent = error.message;
    throw error;
  } finally {
    if (version === WHATSAPP_DISCOVERY_VERSION) button.disabled = WHATSAPP_SETUP_BUSY;
  }
}

function setWhatsAppSetupBusy(busy) {
  WHATSAPP_SETUP_BUSY = busy;
  ['whatsappSaveBtn', 'whatsappDiscoverBtn', 'whatsappApiKey', 'whatsappMode', 'whatsappChannel', 'whatsappWebhookSecret'].forEach((id) => {
    const element = $(`#${id}`);
    if (element) element.disabled = busy;
  });
  $('#whatsappConnectionForm').setAttribute('aria-busy', String(busy));
  syncWhatsAppSetupActions();
}

function fillWhatsAppConnectionForm(row) {
  WHATSAPP_SELECTED_CONNECTION = row || null;
  WHATSAPP_DISCOVERY_VERSION++;
  $('#whatsappConnectionId').value = row?.id || '';
  $('#whatsappApiKey').value = '';
  $('#whatsappApiKey').required = !row?.hasApiKey;
  $('#whatsappApiKey').placeholder = row?.hasApiKey ? 'API key guardada — pega otra sólo para reemplazarla' : 'Pega aquí tu API key de Zernio';
  $('#whatsappApiKeyHint').textContent = row?.hasApiKey ? 'Ya está guardada de forma segura. No necesitas ingresarla otra vez.' : 'Se guarda cifrada y no vuelve a mostrarse.';
  $('#whatsappMode').value = row?.mode || 'api';
  $('#whatsappWebhookSecret').value = '';
  const channelId = row?.zernioAccountId ? `account:${row.zernioAccountId}` : row?.profileId ? `profile:${row.profileId}` : '';
  renderWhatsAppChannelChoices(channelId && row.mode !== 'sandbox' ? [{ channelId,
    label: [row.phoneNumber, row.displayName || 'WhatsApp del negocio'].filter(Boolean).join(' · ') }] : [], channelId);
  $('#whatsappChannelHint').textContent = channelId ? 'Cuenta guardada. Consulta Zernio si deseas cambiar el número.' : 'No necesitas copiar identificadores. Consultaremos los números asociados a tu API key.';
  const sandbox = row?.sandbox || {};
  if ($('#whatsappSandboxPhone')) $('#whatsappSandboxPhone').value = sandbox.phone || '';
  syncWhatsAppSetupActions();
  renderWhatsAppSetupStatus(row);
  renderWhatsAppSandbox(row);
  renderWhatsAppCustomerEntry(row);
  renderWhatsAppConnections();
}

function renderWhatsAppSandbox(row = WHATSAPP_SELECTED_CONNECTION) {
  const host = $('#whatsappSandboxStatus');
  if (!host) return;
  const sandbox = row?.sandbox;
  if (!row || row.mode !== 'sandbox') {
    host.innerHTML = '<i class="ph-bold ph-info"></i><span>Selecciona el modo Sandbox y guarda la conexión para comenzar.</span>';
    return;
  }
  const state = String(sandbox?.status || 'pending').toLowerCase();
  const label = state === 'active' ? 'Teléfono activo' : state === 'pending' ? 'Pendiente de respuesta' : state;
  const details = [sandbox?.number ? `Número compartido: ${sandbox.number}` : '', sandbox?.phone ? `Teléfono: ${sandbox.phone}` : '', sandbox?.expiresAt ? `Expira: ${new Date(sandbox.expiresAt).toLocaleString()}` : ''].filter(Boolean).join(' · ');
  host.innerHTML = `<i class="ph-bold ${state === 'active' ? 'ph-check-circle' : 'ph-clock'}"></i><span><b>${esc(label)}</b>${details ? `<small>${esc(details)}</small>` : ''}${state === 'pending' ? '<small>Responde en WhatsApp el mensaje de activación de Zernio y después revisa el estado.</small>' : ''}</span>`;
}

function renderWhatsAppInbox() {
  const host = $('#whatsappConversationList');
  if (!host) return;
  const rows = Array.isArray(WHATSAPP_DATA.conversations) ? WHATSAPP_DATA.conversations : [];
  if (!rows.length) {
    host.innerHTML = `<div class="whatsapp-empty-state compact"><i class="ph-duotone ph-chat-circle-dots"></i><b>Sin conversaciones</b><span>Las conversaciones entrantes aparecerán aquí.</span></div>`;
    return;
  }
  host.innerHTML = rows.map((row) => `<button type="button" class="whatsapp-conversation-row ${Number(row.id) === Number(WHATSAPP_SELECTED_CONVERSATION?.id) ? 'selected' : ''}" data-whatsapp-conversation="${row.id}">
    <span class="whatsapp-avatar"><i class="ph-bold ph-user"></i></span><span><b>${esc(row.customerName || row.customerPhone || 'Cliente WhatsApp')}</b><small>${esc(row.lastMessage || 'Sin mensaje')}</small></span>${row.botEnabled ? '<em>Bot</em>' : '<em class="human">Humano</em>'}
  </button>`).join('');
  host.querySelectorAll('[data-whatsapp-conversation]').forEach((button) => button.addEventListener('click', () => selectWhatsAppConversation(Number(button.dataset.whatsappConversation))));
}

async function loadWhatsAppMessages() {
  const list = $('#whatsappMessageList');
  if (!list || !WHATSAPP_SELECTED_CONVERSATION) return;
  const messages = await api(`/api/whatsapp/conversations/${WHATSAPP_SELECTED_CONVERSATION.id}/messages`);
  const visibleMessages = messages.filter((message, index) => {
    const previous = messages[index - 1];
    // Zernio represents the prompt and its interactive payload separately.
    // Hide only the repeated prompt in this inbox; keep both records and the
    // real WhatsApp delivery intact.
    return !(message.message_type === 'interactive'
      && previous?.direction === message.direction
      && previous?.body === message.body);
  });
  list.innerHTML = visibleMessages.length
    ? visibleMessages.map((message) => `<div class="whatsapp-message ${message.direction === 'outbound' ? 'outbound' : 'inbound'}"><span>${esc(message.body || '')}</span><small>${esc(message.source || message.direction || '')} · ${esc(message.created_at || '')}</small></div>`).join('')
    : `<div class="whatsapp-empty-state"><i class="ph-duotone ph-chat-circle-dots"></i><b>Conversación sin mensajes</b><span>El siguiente mensaje quedará registrado aquí.</span></div>`;
  list.scrollTop = list.scrollHeight;
}

async function selectWhatsAppConversation(id) {
  WHATSAPP_SELECTED_CONVERSATION = WHATSAPP_DATA.conversations.find((row) => Number(row.id) === Number(id)) || null;
  renderWhatsAppInbox();
  const row = WHATSAPP_SELECTED_CONVERSATION;
  $('#whatsappChatHeader').innerHTML = row
    ? `<div><span>${esc(row.customerName || row.customerPhone || 'Cliente WhatsApp')}</span><b>${esc(row.customerPhone || '')}</b></div><button class="btn btn-ghost btn-sm" type="button" id="whatsappTakeoverBtn"><i class="ph-bold ph-hand"></i> ${row.botEnabled ? 'Tomar control humano' : 'Reactivar bot'}</button>`
    : `<div><span>Selecciona una conversación</span><b>Los mensajes del bot y del equipo aparecerán aquí.</b></div>`;
  const input = $('#whatsappMessageInput');
  const submit = $('#whatsappSendForm button[type="submit"]');
  if (input) input.disabled = !row;
  if (submit) submit.disabled = !row;
  $('#whatsappTakeoverBtn')?.addEventListener('click', async () => {
    try {
      await api(`/api/whatsapp/conversations/${row.id}/takeover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botEnabled: !row.botEnabled }) });
      await loadWhatsApp();
      await selectWhatsAppConversation(row.id);
      toast(row.botEnabled ? 'El bot fue desactivado para esta conversación' : 'El bot fue reactivado');
    } catch (error) { toast(error.message, true); }
  });
  await loadWhatsAppMessages();
}

function setWhatsAppTab(tab) {
  document.querySelectorAll('[data-whatsapp-tab]').forEach((button) => button.classList.toggle('on', button.dataset.whatsappTab === tab));
  ['analytics', 'connection', 'inbox', 'orders', 'help'].forEach((key) => { const panel = $(`#whatsappPanel${key[0].toUpperCase()}${key.slice(1)}`); if (panel) panel.hidden = key !== tab; });
  if (tab === 'analytics') loadWhatsAppAnalytics().catch((error) => toast(error.message, true));
}

async function selectWhatsAppConnection(id) {
  const row = WHATSAPP_DATA.connections.find((item) => Number(item.id) === Number(id));
  if (!row) return;
  fillWhatsAppConnectionForm(row);
}

async function loadWhatsApp() {
  WHATSAPP_DATA = await api('/api/whatsapp');
  renderWhatsAppConnections();
  renderWhatsAppInbox();
  const active = WHATSAPP_DATA.connections?.find((row) => row.enabled) || WHATSAPP_DATA.connections?.[0] || null;
  if (active && !WHATSAPP_SELECTED_CONNECTION) fillWhatsAppConnectionForm(active);
  if (!active) fillWhatsAppConnectionForm(null);
  if (WHATSAPP_SELECTED_CONNECTION) {
    WHATSAPP_SELECTED_CONNECTION = WHATSAPP_DATA.connections.find((row) => Number(row.id) === Number(WHATSAPP_SELECTED_CONNECTION.id)) || null;
    renderWhatsAppSetupStatus(WHATSAPP_SELECTED_CONNECTION);
    renderWhatsAppSandbox(WHATSAPP_SELECTED_CONNECTION);
    syncWhatsAppSetupActions();
    renderWhatsAppConnections();
  }
  renderWhatsAppCustomerEntry(WHATSAPP_SELECTED_CONNECTION || active);
  const pill = $('#whatsappConnectionPill');
  if (pill) {
    const state = active ? whatsappConnectionStatus(active.status, active.enabled, active.mode) : { label: 'Sin conectar', tone: 'muted' };
    pill.textContent = state.label;
    pill.className = `whatsapp-status-pill ${state.tone}`;
  }
  syncWhatsAppAnalyticsFilterVisibility();
  loadWhatsAppAnalytics().catch((error) => {
    const label = $('#whatsappAnalyticsRangeLabel');
    if (label) label.textContent = error.message;
  });
  if (WHATSAPP_BOUND) return;
  WHATSAPP_BOUND = true;
  document.querySelectorAll('[data-whatsapp-tab]').forEach((button) => button.addEventListener('click', () => setWhatsAppTab(button.dataset.whatsappTab)));
  $('#whatsappAnalyticsRange')?.addEventListener('change', () => { syncWhatsAppAnalyticsFilterVisibility(); if ($('#whatsappAnalyticsRange').value !== 'custom') loadWhatsAppAnalytics().catch((error) => toast(error.message, true)); });
  $('#whatsappAnalyticsApplyBtn')?.addEventListener('click', () => loadWhatsAppAnalytics().catch((error) => toast(error.message, true)));
  $('#whatsappAnalyticsRefreshBtn')?.addEventListener('click', () => loadWhatsAppAnalytics().catch((error) => toast(error.message, true)));
  $('#whatsappRefreshBtn')?.addEventListener('click', () => loadWhatsApp().catch((error) => toast(error.message, true)));
  $('#whatsappInboxRefreshBtn')?.addEventListener('click', () => loadWhatsApp().catch((error) => toast(error.message, true)));
  if (typeof window.io === 'function') {
    const socketScope = typeof getAuthScope === 'function' ? getAuthScope() : 'owner';
    WHATSAPP_SOCKET = window.io({ auth: { scope: socketScope || 'owner' }, reconnectionDelay: 2000 });
    WHATSAPP_SOCKET.on('whatsapp_update', () => { if (!document.hidden) loadWhatsApp().catch(() => {}); });
  }
  $('#whatsappOpenOrdersBtn')?.addEventListener('click', () => navigate('pedidos'));
  $('#whatsappMode')?.addEventListener('change', () => {
    WHATSAPP_DISCOVERY_VERSION++;
    renderWhatsAppChannelChoices([]);
    $('#whatsappDiscoverBtn').disabled = false;
    syncWhatsAppSetupActions();
  });
  $('#whatsappApiKey')?.addEventListener('input', () => {
    WHATSAPP_DISCOVERY_VERSION++;
    renderWhatsAppChannelChoices([]);
    $('#whatsappChannelHint').textContent = 'Consulta Zernio para detectar los números de esta API key.';
    $('#whatsappDiscoverBtn').disabled = false;
  });
  $('#whatsappDiscoverBtn')?.addEventListener('click', () => discoverWhatsAppChannels().catch((error) => toast(error.message, true)));
  $('#whatsappCopyWebhookBtn')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#whatsappWebhookUrl').textContent); toast('URL de webhook copiada'); } catch { toast('No se pudo copiar la URL', true); } });
  $('#whatsappCustomerCopyBtn')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#whatsappCustomerLink').value); toast('Liga de WhatsApp copiada'); } catch { toast('No se pudo copiar la liga', true); } });
  $('#whatsappCustomerShareBtn')?.addEventListener('click', async () => {
    const link = $('#whatsappCustomerLink')?.value || '';
    if (!link) return;
    try {
      if (navigator.share) await navigator.share({ title: 'WhatsApp de pedidos', text: 'Haz tu pedido por WhatsApp', url: link });
      else { await navigator.clipboard.writeText(link); toast('Liga de WhatsApp copiada'); }
    } catch (error) { if (error?.name !== 'AbortError') toast('No se pudo compartir la liga', true); }
  });
  $('#whatsappConnectionForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (WHATSAPP_SETUP_BUSY) return;
    setWhatsAppSetupBusy(true);
    try {
      if ($('#whatsappMode').value !== 'sandbox' && !WHATSAPP_CHANNEL_CHOICES.length) {
        if (!await discoverWhatsAppChannels()) return;
      }
      if ($('#whatsappMode').value !== 'sandbox' && !$('#whatsappChannel').value) {
        $('#whatsappChannel').disabled = false;
        $('#whatsappChannel').focus();
        throw new Error('Selecciona el número o la cuenta que usará este negocio');
      }
      const body = { id: Number($('#whatsappConnectionId').value) || undefined,
        channelId: $('#whatsappChannel').value, mode: $('#whatsappMode').value,
        apiKey: $('#whatsappApiKey').value.trim(), webhookSecret: $('#whatsappWebhookSecret').value.trim() };
      const result = await api('/api/whatsapp/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      fillWhatsAppConnectionForm(result.connection);
      toast(result.connection?.lastError || (result.webhookSetup?.registered === false ? result.webhookSetup.reason || 'Conexión guardada; recepción de mensajes pendiente' : 'Conexión de WhatsApp guardada'), Boolean(result.connection?.lastError || result.webhookSetup?.registered === false));
      await loadWhatsApp();
    } catch (error) {
      if (error.data?.choices) renderWhatsAppChannelChoices(error.data.choices);
      toast(error.message, true);
    } finally { setWhatsAppSetupBusy(false); }
  });
  $('#whatsappConnectMetaBtn')?.addEventListener('click', async () => {
    const row = WHATSAPP_SELECTED_CONNECTION;
    if (!row || WHATSAPP_SETUP_BUSY) return;
    // Reserve the tab during the click, before awaiting Zernio, to avoid popup blocking.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setWhatsAppSetupBusy(true);
    try {
      const result = await api(`/api/whatsapp/connections/${row.id}/connect-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (popup && !popup.closed) popup.location.replace(result.authUrl);
      else window.location.assign(result.authUrl);
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      toast(error.message, true);
    } finally { setWhatsAppSetupBusy(false); }
  });
  $('#whatsappTestBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; if (!row) return; const result = await api(`/api/whatsapp/connections/${row.id}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); WHATSAPP_SELECTED_CONNECTION = result.connection; toast('Canal validado correctamente'); await loadWhatsApp(); fillWhatsAppConnectionForm(result.connection); } catch (error) { toast(error.message, true); } });
  $('#whatsappSyncProfilePhotoBtn')?.addEventListener('click', async () => {
    try {
      const row = WHATSAPP_SELECTED_CONNECTION;
      if (!row) return;
      const result = await api(`/api/whatsapp/connections/${row.id}/profile-photo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      WHATSAPP_SELECTED_CONNECTION = result.connection;
      await loadWhatsApp();
      fillWhatsAppConnectionForm(result.connection);
      toast('Foto de perfil sincronizada');
    } catch (error) { toast(error.message, true); }
  });
  $('#whatsappSandboxDiscoverBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; if (!row) throw new Error('Guarda primero la conexión en modo sandbox'); const result = await api(`/api/whatsapp/connections/${row.id}/sandbox/discover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); WHATSAPP_SELECTED_CONNECTION = result.connection; await loadWhatsApp(); fillWhatsAppConnectionForm(result.connection); toast('Sandbox detectado'); } catch (error) { toast(error.message, true); } });
  $('#whatsappSandboxActivateBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; const phone = $('#whatsappSandboxPhone').value.trim(); if (!row) throw new Error('Guarda primero la conexión en modo sandbox'); const result = await api(`/api/whatsapp/connections/${row.id}/sandbox/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) }); WHATSAPP_SELECTED_CONNECTION = result.connection; await loadWhatsApp(); fillWhatsAppConnectionForm(result.connection); toast('Revisa WhatsApp y responde el mensaje de activación'); } catch (error) { toast(error.message, true); } });
  $('#whatsappSandboxRefreshBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; if (!row) return; const result = await api(`/api/whatsapp/connections/${row.id}/sandbox/session`); WHATSAPP_SELECTED_CONNECTION = result.connection; await loadWhatsApp(); fillWhatsAppConnectionForm(result.connection); toast(result.connection?.sandbox?.status === 'active' ? 'Teléfono sandbox activo' : 'La sesión sigue pendiente'); } catch (error) { toast(error.message, true); } });
  $('#whatsappSandboxStartBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; if (!row) return; await api(`/api/whatsapp/connections/${row.id}/sandbox/start-conversation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await loadWhatsApp(); setWhatsAppTab('inbox'); toast('Conversación sandbox iniciada'); } catch (error) { toast(error.message, true); } });
  $('#whatsappSandboxRevokeBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; if (!row) return; if (!confirm('¿Revocar la sesión sandbox actual?')) return; const result = await api(`/api/whatsapp/connections/${row.id}/sandbox/session`, { method: 'DELETE' }); WHATSAPP_SELECTED_CONNECTION = result.connection; await loadWhatsApp(); fillWhatsAppConnectionForm(result.connection); toast('Sesión sandbox revocada'); } catch (error) { toast(error.message, true); } });
  $('#whatsappSendForm')?.addEventListener('submit', async (event) => { event.preventDefault(); const text = $('#whatsappMessageInput').value.trim(); const row = WHATSAPP_SELECTED_CONVERSATION; if (!text || !row) return; try { await api(`/api/whatsapp/conversations/${row.id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) }); $('#whatsappMessageInput').value = ''; await loadWhatsApp(); await selectWhatsAppConversation(row.id); } catch (error) { toast(error.message, true); } });
}
