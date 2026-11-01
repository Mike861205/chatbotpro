/* Canal QR independiente del módulo Zernio. */
let WAB_DATA = { templates: [], presets: [], orders: [] };
let WAB_ORDER_CONTEXT = null;
let WAB_CONVERSATIONS = [];
let WAB_SELECTED_CONVERSATION = '';
let WAB_BOUND = false;
let WAB_TIMER = null;
let WAB_TICKS = 0;
let WAB_POLL_BUSY = false;
const wab = (id) => document.getElementById(id);
const wabEsc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function wabError(error, target = 'wabStatus') { wab(target).textContent = error.message || String(error); }
function wabConnection(connection) {
  const status = connection?.status || 'not_connected';
  const labels = { not_connected: 'Sin conectar', starting: 'Iniciando', connecting: 'Conectando', qr: 'Escanea el QR', connected: 'Conectado', reconnecting: 'Reconectando', logged_out: 'Sesión cerrada', unavailable: 'Pasarela no disponible', error: 'Error' };
  const label = labels[status] || status;
  wab('wabBadge').textContent = label;
  wab('wabStatus').textContent = connection?.conflict ? `El número ${connection.phone} también está activo en Zernio. Desactiva uno de los dos canales para evitar respuestas duplicadas.` : connection?.phone ? `${label} · ${connection.phone}` : connection?.error || label;
  const box = wab('wabQrBox');
  box.replaceChildren();
  if (status === 'qr' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(connection.qr || '')) {
    const image = document.createElement('img'); image.src = connection.qr; image.alt = 'Código QR para vincular WhatsApp'; box.append(image);
  } else { const span = document.createElement('span'); span.textContent = status === 'connected' ? `Dispositivo vinculado: ${connection.phone || ''}` : label; box.append(span); }
  wab('wabDisconnect').hidden = status === 'not_connected';
  wab('wabTestForm').querySelector('button[type="submit"]').disabled = status !== 'connected';
  const phone = status === 'connected' ? String(connection?.phone || '').replace(/\D/g, '') : '';
  wab('wabCustomerLink').value = /^\d{8,15}$/.test(phone) ? `https://wa.me/${phone}?text=Hola%2C%20quiero%20hacer%20un%20pedido` : '';
  wab('wabCopyLink').disabled = !wab('wabCustomerLink').value;
  wab('wabShareLink').disabled = !wab('wabCustomerLink').value;
  const customerQrPanel = wab('wabCustomerQrPanel');
  customerQrPanel.hidden = !wab('wabCustomerLink').value;
  if (wab('wabCustomerLink').value) {
    if (!wab('wabCustomerQr').getAttribute('src')) wab('wabCustomerQr').src = '/api/whatsapp-bot/customer-qr';
    wab('wabCustomerQrDownload').href = '/api/whatsapp-bot/customer-qr?download=1';
  } else {
    wab('wabCustomerQr').removeAttribute('src');
    wab('wabCustomerQrDownload').href = '#';
  }
}
function wabRenderLists() {
  wab('wabPresets').innerHTML = WAB_DATA.presets.map((row, index) => { const saved = WAB_DATA.templates.find(template => template.presetKey === row.key); return `<button type="button" data-wab-preset="${index}"><b>${wabEsc(row.name)}${saved ? ' · Personalizada' : ''}</b><small>${wabEsc(saved?.body || row.body)}</small></button>`; }).join('');
  wab('wabTemplates').innerHTML = WAB_DATA.templates.length ? WAB_DATA.templates.map(row => `<button type="button" data-wab-template="${Number(row.id)}"><b>${wabEsc(row.name)}</b><small>${wabEsc(row.body)}</small></button>`).join('') : '<p class="hint">Aún no hay plantillas guardadas.</p>';
}
function wabRenderOrders() {
  const select = wab('wabOrderSelect');
  const selected = select.value;
  select.innerHTML = '<option value="">Sin pedido: mensaje manual</option>' + (WAB_DATA.orders || []).map(row => `<option value="${Number(row.id)}">${wabEsc(row.label)}</option>`).join('');
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
  else { WAB_ORDER_CONTEXT = null; wab('wabTemplateRecipient').textContent = 'Sin pedido: se enviará al número del recuadro “Probar envío”.'; }
}
async function wabSelectOrder() {
  const id = Number(wab('wabOrderSelect').value);
  WAB_ORDER_CONTEXT = null;
  if (!id) { wab('wabTemplateRecipient').textContent = 'Sin pedido: se enviará al número del recuadro “Probar envío”.'; wabPreview(); return; }
  wab('wabTemplateRecipient').textContent = 'Cargando datos del pedido…';
  try {
    const context = await api(`/api/whatsapp-bot/orders/${id}/context`);
    if (Number(wab('wabOrderSelect').value) !== id) return;
    WAB_ORDER_CONTEXT = context;
    wab('wabTemplateRecipient').textContent = context.phone ? `Destino: ${context.phone}. Envío: ${context.values.envio}.` : 'Este pedido no tiene un teléfono válido para enviar.';
    wabPreview();
  } catch (error) { wabError(error, 'wabTemplateRecipient'); }
}
function wabManualValues() {
  const parsed = JSON.parse(wab('wabPreviewValues').value || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Las variables manuales deben ser un objeto JSON.');
  return { ...parsed, ...(wab('wabCustomerName').value.trim() ? { nombre: wab('wabCustomerName').value.trim() } : {}) };
}
function wabPreview() {
  const body = wab('wabTemplateBody').value;
  const keys = [...new Set([...body.matchAll(/\{([a-zA-Z][\w]{0,39})\}/g)].map(match => match[1]))];
  wab('wabVariables').textContent = keys.length ? `Variables: ${keys.map(key => `{${key}}`).join(', ')}` : 'Puedes usar variables como {nombre}, {pedido} y {total}.';
  let values = {};
  try { values = { ...wabManualValues(), negocio: WAB_DATA.businessName || 'Tu negocio', ...(WAB_ORDER_CONTEXT?.values || {}) }; }
  catch { wab('wabPreview').textContent = 'El JSON de valores no es válido.'; return; }
  wab('wabPreview').textContent = body.replace(/\{([a-zA-Z][\w]{0,39})\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key] ?? '') : match);
  wab('wabTemplateSend').hidden = !body.trim();
}
function wabEdit(row) {
  wab('wabTemplateId').value = row?.id || '';
  wab('wabTemplatePresetKey').value = row?.presetKey || row?.key || '';
  wab('wabTemplateName').value = row?.name || '';
  wab('wabTemplateBody').value = row?.body || '';
  wab('wabTemplateDelete').hidden = !row?.id;
  wab('wabTemplateSend').hidden = !row?.body;
  wabPreview();
}
function wabRenderConversations() {
  const query = String(wab('wabConversationSearch').value || '').replace(/\D/g, '');
  const rows = WAB_CONVERSATIONS.filter(row => !query || String(row.phone || row.label).includes(query));
  wab('wabConversationList').innerHTML = rows.length ? rows.map(row => {
    const preview = row.lastType === 'image' ? '\uD83D\uDCF7 Imagen' : row.lastType === 'location' ? '\uD83D\uDCCD Ubicaci\u00F3n' : String(row.lastBody || '');
    const direction = row.lastDirection === 'outbound' ? 'T\u00FA: ' : '';
    const time = new Date(row.lastAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<button type="button" class="wab-conversation${row.id === WAB_SELECTED_CONVERSATION ? ' selected' : ''}" data-wab-conversation="${wabEsc(row.id)}"><span class="wab-avatar">${row.phone ? wabEsc(row.phone.slice(-2)) : 'WA'}</span><span class="wab-conversation-copy"><span class="wab-conversation-top"><strong>${wabEsc(row.label)}</strong><time>${wabEsc(time)}</time></span><span class="wab-conversation-preview">${wabEsc(direction + preview)}</span></span></button>`;
  }).join('') : `<div class="wab-inbox-empty">${WAB_CONVERSATIONS.length ? 'No hay coincidencias para ese n\u00FAmero.' : 'Todav\u00EDa no hay conversaciones.'}</div>`;
}
async function wabOpenConversation(id, scrollBottom = true) {
  const selected = WAB_CONVERSATIONS.find(row => row.id === id);
  if (!selected) return;
  const messageBox = wab('wabChatMessages');
  const wasAtBottom = messageBox.scrollHeight - messageBox.clientHeight - messageBox.scrollTop < 48;
  WAB_SELECTED_CONVERSATION = id;
  wabRenderConversations();
  wab('wabChatPlaceholder').hidden = true;
  wab('wabChatView').hidden = false;
  wab('wabChatPhone').textContent = selected.label;
  wab('wabChatAvatar').textContent = selected.phone ? selected.phone.slice(-2) : 'WA';
  wab('wabChatMeta').textContent = `${selected.messageCount} mensajes \u00B7 WhatsApp`;
  const data = await api(`/api/whatsapp-bot/conversations/${encodeURIComponent(id)}`);
  const content = (data.messages || []).map(row => {
    const body = String(row.body || (row.message_type === 'image' ? 'Imagen' : ''));
    const maps = row.message_type === 'location' ? body.match(/(https:\/\/www\.google\.com\/maps\?q=-?[\d.]+,-?[\d.]+)/) : null;
    const text = maps ? `<a target="_blank" rel="noopener" href="${wabEsc(maps[1])}">\uD83D\uDCCD Ver ubicaci\u00F3n en Maps</a>` : wabEsc(body);
    const image = row.has_media ? `<a class="wab-chat-image" target="_blank" rel="noopener" href="/api/whatsapp-bot/media/${Number(row.id)}"><img loading="lazy" src="/api/whatsapp-bot/media/${Number(row.id)}" alt="Imagen enviada en la conversaci\u00F3n"></a>` : '';
    const label = row.direction === 'inbound' ? 'Cliente' : 'WhatsApp Bot';
    return `<article class="wab-bubble ${row.direction === 'outbound' ? 'outbound' : 'inbound'}">${image}${text ? `<div class="wab-bubble-text">${text}</div>` : ''}<footer><span>${label}</span><time>${wabEsc(new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></footer></article>`;
  }).join('');
  wab('wabChatMessages').innerHTML = content || '<div class="wab-inbox-empty">No hay mensajes guardados en esta conversaci\u00F3n.</div>';
  if (scrollBottom || wasAtBottom) messageBox.scrollTop = messageBox.scrollHeight;
}
async function wabRecent() {
  const data = await api('/api/whatsapp-bot/conversations');
  WAB_CONVERSATIONS = data.conversations || [];
  wabRenderConversations();
  if (WAB_SELECTED_CONVERSATION && WAB_CONVERSATIONS.some(row => row.id === WAB_SELECTED_CONVERSATION)) return wabOpenConversation(WAB_SELECTED_CONVERSATION, false);
  if (WAB_CONVERSATIONS.length) return wabOpenConversation(WAB_CONVERSATIONS[0].id, false);
  WAB_SELECTED_CONVERSATION = '';
  wab('wabChatView').hidden = true;
  wab('wabChatPlaceholder').hidden = false;
}
function wabSetTab(tab) {
  const activity = tab === 'activity';
  wab('wabSetupPanel').hidden = activity;
  wab('wabActivityPanel').hidden = !activity;
  wab('wabTabSetup').classList.toggle('active', !activity);
  wab('wabTabSetup').setAttribute('aria-selected', String(!activity));
  wab('wabTabActivity').classList.toggle('active', activity);
  wab('wabTabActivity').setAttribute('aria-selected', String(activity));
  if (activity) wabRecent().catch(error => wabError(error, 'wabConversationList'));
}
async function loadWhatsAppBot() {
  if (!WAB_BOUND) wabBind();
  const canManageConnection = typeof ME !== 'undefined' && ME?.role === 'owner';
  wab('wabConnect').hidden = !canManageConnection;
  if (!canManageConnection) wab('wabDisconnect').hidden = true;
  const data = await api('/api/whatsapp-bot');
  WAB_DATA = data;
  wabConnection(data.connection);
  if (wab('wabMenuMode')) wab('wabMenuMode').value = data.menuMode || 'catalog';
  if (wab('wabMenuImageForm')) wab('wabMenuImageForm').hidden = !canManageConnection;
  if (wab('wabMenuImagePreview')) {
    wab('wabMenuImagePreview').hidden = !data.hasMenuImage;
    wab('wabMenuImagePreview').style.display = data.hasMenuImage ? 'block' : 'none';
    wab('wabMenuImagePreview').src = data.hasMenuImage ? `/api/whatsapp-bot/menu-image?v=${Date.now()}` : '';
  }
  if (!canManageConnection) wab('wabDisconnect').hidden = true;
  wabRenderLists();
  wabRenderOrders();
  wabPreview();
  await wabRecent();
  if (!WAB_TIMER) WAB_TIMER = setInterval(async () => {
    if (!wab('view-whatsapp-bot')?.classList.contains('active') || WAB_POLL_BUSY) return;
    WAB_POLL_BUSY = true;
    try {
      if (++WAB_TICKS % 3 === 0) await loadWhatsAppBot();
      else { const refreshed = await api('/api/whatsapp-bot/status'); wabConnection(refreshed.connection); if (!wab('wabActivityPanel').hidden) await wabRecent(); if (typeof ME !== 'undefined' && ME?.role !== 'owner') wab('wabDisconnect').hidden = true; }
    } catch (error) { wabError(error); }
    finally { WAB_POLL_BUSY = false; }
  }, 4000);
}
function wabBind() {
  WAB_BOUND = true;
  wab('wabTabSetup').addEventListener('click', () => wabSetTab('setup'));
  wab('wabTabActivity').addEventListener('click', () => wabSetTab('activity'));
  wab('wabConversationSearch').addEventListener('input', wabRenderConversations);
  wab('wabConversationList').addEventListener('click', event => {
    const button = event.target.closest('[data-wab-conversation]');
    if (button) wabOpenConversation(button.dataset.wabConversation).catch(error => wabError(error, 'wabConversationList'));
  });
  wab('wabRefreshActivity').addEventListener('click', () => wabRecent().catch(error => wabError(error, 'wabConversationList')));
  wab('wabCopyLink').addEventListener('click', async () => { try { await navigator.clipboard.writeText(wab('wabCustomerLink').value); wab('wabLinkStatus').textContent = 'Enlace copiado. Compártelo con tus clientes.'; } catch { wab('wabCustomerLink').select(); wab('wabLinkStatus').textContent = 'Selecciona y copia el enlace.'; } });
  wab('wabShareLink').addEventListener('click', async () => { const url = wab('wabCustomerLink').value; if (!url) return; try { if (navigator.share) await navigator.share({ title: `Pide por WhatsApp · ${WAB_DATA.businessName || 'negocio'}`, text: 'Haz tu pedido por WhatsApp:', url }); else { await navigator.clipboard.writeText(url); wab('wabLinkStatus').textContent = 'Enlace copiado. Pégalo en tus redes o chats.'; } } catch (error) { if (error.name !== 'AbortError') wabError(error, 'wabLinkStatus'); } });
  wab('wabConnect').addEventListener('click', async () => { try { wab('wabStatus').textContent = 'Iniciando sesión…'; await api('/api/whatsapp-bot/connect', { method: 'POST' }); await loadWhatsAppBot(); } catch (error) { wabError(error); } });
  wab('wabDisconnect').addEventListener('click', async () => { if (!confirm('¿Desvincular este dispositivo y borrar sus credenciales locales?')) return; try { await api('/api/whatsapp-bot/disconnect', { method: 'POST' }); await loadWhatsAppBot(); } catch (error) { wabError(error); } });
  wab('wabTestForm').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/whatsapp-bot/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: wab('wabTestPhone').value, message: wab('wabTestMessage').value }) }); wab('wabTestStatus').textContent = 'Mensaje enviado.'; await wabRecent(); } catch (error) { wabError(error, 'wabTestStatus'); } });
  wab('wabMenuImageForm').addEventListener('submit', async (event) => { event.preventDefault(); const file = wab('wabMenuImageFile').files[0]; if (!file) { wabError(new Error('Selecciona primero la imagen.'), 'wabMenuStatus'); return; } try { const form = new FormData(); form.append('image', file); await api('/api/whatsapp-bot/menu-image', { method: 'POST', body: form }); wab('wabMenuStatus').textContent = 'Imagen guardada. Ahora puedes elegir “Imagen de mi menú” y guardar la opción.'; await loadWhatsAppBot(); } catch (error) { wabError(error, 'wabMenuStatus'); } });
  wab('wabMenuModeSave').addEventListener('click', async () => { try { const result = await api('/api/whatsapp-bot/menu-config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: wab('wabMenuMode').value }) }); wab('wabMenuStatus').textContent = result.mode === 'image' ? 'Los clientes recibirán la imagen cuando pidan el menú.' : 'Los clientes verán el catálogo configurado en el sistema.'; } catch (error) { wabError(error, 'wabMenuStatus'); } });
  wab('wabPresets').addEventListener('click', (event) => { const button = event.target.closest('[data-wab-preset]'); if (!button) return; const preset = WAB_DATA.presets[Number(button.dataset.wabPreset)]; wabEdit(WAB_DATA.templates.find(row => row.presetKey === preset.key) || preset); });
  wab('wabTemplates').addEventListener('click', (event) => { const button = event.target.closest('[data-wab-template]'); if (button) wabEdit(WAB_DATA.templates.find(row => Number(row.id) === Number(button.dataset.wabTemplate))); });
  wab('wabOrderSelect').addEventListener('change', wabSelectOrder);
  wab('wabTemplateClear').addEventListener('click', () => wabEdit(null));
  wab('wabTemplateDelete').addEventListener('click', async () => { const id = Number(wab('wabTemplateId').value); if (!id || !confirm('¿Eliminar esta plantilla?')) return; try { await api(`/api/whatsapp-bot/templates/${id}`, { method: 'DELETE' }); wabEdit(null); await loadWhatsAppBot(); } catch (error) { wabError(error); } });
  wab('wabTemplateForm').addEventListener('submit', async (event) => { event.preventDefault(); const id = Number(wab('wabTemplateId').value); try { const result = await api(`/api/whatsapp-bot/templates${id ? `/${id}` : ''}`, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: wab('wabTemplateName').value, body: wab('wabTemplateBody').value, presetKey: wab('wabTemplatePresetKey').value }) }); await loadWhatsAppBot(); wabEdit(result.template); wab('wabTemplateStatus').textContent = 'Plantilla guardada.'; } catch (error) { wabError(error, 'wabTemplateStatus'); } });
  wab('wabTemplateSend').addEventListener('click', async () => { try { const values = wabManualValues(); await api('/api/whatsapp-bot/templates/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: wab('wabTemplateBody').value, orderId: Number(wab('wabOrderSelect').value) || undefined, phone: wab('wabTestPhone').value, values }) }); wab('wabTemplateStatus').textContent = 'Mensaje enviado.'; await wabRecent(); } catch (error) { wabError(error, 'wabTemplateStatus'); } });
  ['wabTemplateBody', 'wabPreviewValues', 'wabCustomerName'].forEach(id => wab(id).addEventListener('input', wabPreview));
}
