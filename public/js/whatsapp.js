/* Módulo WhatsApp: conexión Zernio, bandeja y puente al flujo actual de pedidos. */
let WHATSAPP_DATA = { connections: [], conversations: [] };
let WHATSAPP_SELECTED_CONNECTION = null;
let WHATSAPP_SELECTED_CONVERSATION = null;
let WHATSAPP_BOUND = false;
let WHATSAPP_SOCKET = null;

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
  const slug = String(ME?.tenant?.slug || '').trim().toLowerCase();
  if (number && /^[a-z0-9-]{3,40}$/.test(slug)) return `${window.location.origin}/w/${encodeURIComponent(slug)}`;
  return number ? `https://wa.me/${number}?text=${encodeURIComponent('Hola, quiero hacer un pedido')}` : '';
}

function renderWhatsAppCustomerEntry(row = WHATSAPP_SELECTED_CONNECTION) {
  const card = $('#whatsappCustomerEntryCard');
  if (!card) return;
  card.hidden = !row;
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
    ? 'Comparte este QR o enlace; abrirá directamente el WhatsApp de pedidos.'
    : 'Captura el número conectado o activa el teléfono para generar el enlace.';
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
  if (syncPhoto) syncPhoto.disabled = !row?.id || !logo || row?.mode !== 'api';
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
      <span class="whatsapp-connection-copy"><b>${esc(row.displayName || row.phoneNumber || 'WhatsApp del negocio')}</b><small>${esc(row.phoneNumber || 'Número pendiente')} · ${esc(row.zernioAccountId || 'Sin Account ID')}</small></span>
      <span class="whatsapp-status-pill ${state.tone}">${esc(state.label)}</span>
    </button>`;
  }).join('');
  host.querySelectorAll('[data-whatsapp-connection]').forEach((button) => button.addEventListener('click', () => selectWhatsAppConnection(Number(button.dataset.whatsappConnection))));
}

function fillWhatsAppConnectionForm(row) {
  WHATSAPP_SELECTED_CONNECTION = row || null;
  $('#whatsappConnectionId').value = row?.id || '';
  $('#whatsappProfileId').value = row?.profileId || '';
  $('#whatsappAccountId').value = row?.zernioAccountId || '';
  $('#whatsappApiKey').value = '';
  $('#whatsappWabaId').value = row?.wabaId || '';
  $('#whatsappPhoneNumberId').value = row?.phoneNumberId || '';
  $('#whatsappPhoneNumber').value = row?.phoneNumber || '';
  $('#whatsappDisplayName').value = row?.displayName || ME?.tenant?.businessName || '';
  $('#whatsappMode').value = row?.mode || 'business_app';
  $('#whatsappWebhookSecret').value = '';
  $('#whatsappConnectMetaBtn').disabled = !row?.id;
  $('#whatsappTestBtn').disabled = !row?.id;
  const webhookCard = $('#whatsappWebhookCard');
  if (webhookCard) {
    webhookCard.hidden = !row?.webhookUrl;
    $('#whatsappWebhookUrl').textContent = row?.webhookUrl || '—';
  }
  const sandboxPanel = $('#whatsappSandboxPanel');
  const sandbox = row?.sandbox || {};
  if (sandboxPanel) sandboxPanel.hidden = row?.mode !== 'sandbox';
  if ($('#whatsappSandboxPhone')) $('#whatsappSandboxPhone').value = sandbox.phone || '';
  renderWhatsAppSandbox(row);
  renderWhatsAppCustomerEntry(row);
  const productionConnect = $('#whatsappConnectMetaBtn');
  const productionTest = $('#whatsappTestBtn');
  if (productionConnect) { productionConnect.hidden = row?.mode === 'sandbox'; productionConnect.disabled = !row?.id || row?.mode === 'sandbox'; }
  if (productionTest) { productionTest.hidden = row?.mode === 'sandbox'; productionTest.disabled = !row?.id || row?.mode === 'sandbox'; }
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
  ['connection', 'inbox', 'orders', 'help'].forEach((key) => { const panel = $(`#whatsappPanel${key[0].toUpperCase()}${key.slice(1)}`); if (panel) panel.hidden = key !== tab; });
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
  renderWhatsAppCustomerEntry(WHATSAPP_SELECTED_CONNECTION || active);
  const pill = $('#whatsappConnectionPill');
  if (pill) {
    const state = active ? whatsappConnectionStatus(active.status, active.enabled, active.mode) : { label: 'Sin conectar', tone: 'muted' };
    pill.textContent = state.label;
    pill.className = `whatsapp-status-pill ${state.tone}`;
  }
  if (WHATSAPP_BOUND) return;
  WHATSAPP_BOUND = true;
  document.querySelectorAll('[data-whatsapp-tab]').forEach((button) => button.addEventListener('click', () => setWhatsAppTab(button.dataset.whatsappTab)));
  $('#whatsappRefreshBtn')?.addEventListener('click', () => loadWhatsApp().catch((error) => toast(error.message, true)));
  $('#whatsappInboxRefreshBtn')?.addEventListener('click', () => loadWhatsApp().catch((error) => toast(error.message, true)));
  if (typeof window.io === 'function') {
    const socketScope = typeof getAuthScope === 'function' ? getAuthScope() : 'owner';
    WHATSAPP_SOCKET = window.io({ auth: { scope: socketScope || 'owner' }, reconnectionDelay: 2000 });
    WHATSAPP_SOCKET.on('whatsapp_update', () => { if (!document.hidden) loadWhatsApp().catch(() => {}); });
  }
  $('#whatsappOpenOrdersBtn')?.addEventListener('click', () => navigate('pedidos'));
  $('#whatsappMode')?.addEventListener('change', () => {
    const sandboxMode = $('#whatsappMode').value === 'sandbox';
    $('#whatsappSandboxPanel').hidden = !sandboxMode;
    $('#whatsappConnectMetaBtn').hidden = sandboxMode;
    $('#whatsappTestBtn').hidden = sandboxMode;
  });
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
    const id = Number($('#whatsappConnectionId').value || 0);
    const body = { id: id || undefined, profileId: $('#whatsappProfileId').value, zernioAccountId: $('#whatsappAccountId').value, wabaId: $('#whatsappWabaId').value, phoneNumberId: $('#whatsappPhoneNumberId').value, phoneNumber: $('#whatsappPhoneNumber').value, displayName: $('#whatsappDisplayName').value, mode: $('#whatsappMode').value, apiKey: $('#whatsappApiKey').value, webhookSecret: $('#whatsappWebhookSecret').value };
    try { const result = await api('/api/whatsapp/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); WHATSAPP_SELECTED_CONNECTION = result.connection; toast('Conexión de WhatsApp guardada'); await loadWhatsApp(); fillWhatsAppConnectionForm(result.connection); } catch (error) { toast(error.message, true); }
  });
  $('#whatsappConnectMetaBtn')?.addEventListener('click', async () => { try { const row = WHATSAPP_SELECTED_CONNECTION; if (!row) return; const result = await api(`/api/whatsapp/connections/${row.id}/connect-url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); window.open(result.authUrl, '_blank', 'noopener,noreferrer'); toast('Se abrió la conexión segura de Meta'); } catch (error) { toast(error.message, true); } });
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
