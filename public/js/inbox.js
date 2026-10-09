'use strict';
/* Bandeja WhatsApp como app instalable (PWA): espejo en tiempo real de la bandeja del panel. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  let tz;
  let conversations = [];
  let selectedId = null;
  let socket = null;
  let soundOn = localStorage.getItem('cbp_inbox_sound') !== '0';
  let audioCx = null;
  let deferredInstall = null;
  let messagesRequest = 0;
  let refreshTimer = null;
  let refreshBusy = false;
  let refreshAgain = false;
  let loadedOnce = false;
  const pending = new Map();
  const seenStore = (() => { try { return JSON.parse(localStorage.getItem('cbp_inbox_seen') || '{}'); } catch { return {}; } })();
  const known = new Map(); // conversation id -> last message stamp, to detect new inbound messages

  const isStandalone = ('standalone' in navigator && navigator.standalone) || matchMedia('(display-mode: standalone)').matches;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
  const wide = () => matchMedia('(min-width: 860px)').matches;

  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || 'Error de conexión'), { status: response.status });
    return data;
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  function gate(title, text, link) {
    const el = $('gate');
    el.innerHTML = `<div><div style="font-size:54px">🔒</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${link ? `<a href="${esc(link.href)}">${esc(link.label)}</a>` : ''}</div>`;
    el.classList.remove('hidden');
  }

  // ---------- formato ----------
  const plain = (value) => String(value ?? '').replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  function format(value) {
    return esc(value)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<i>$2</i>')
      .replace(/\n/g, '<br>');
  }
  function fmt(options, value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    try { return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: tz }).format(date); }
    catch { return new Intl.DateTimeFormat('es-MX', options).format(date); }
  }
  const timeOf = (value) => fmt({ hour: '2-digit', minute: '2-digit', hour12: false }, value);
  const dayKey = (value) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, value);
  function dayLabel(value) {
    const key = dayKey(value);
    if (key === dayKey(Date.now())) return 'Hoy';
    if (key === dayKey(Date.now() - 86400000)) return 'Ayer';
    return fmt({ day: 'numeric', month: 'long', year: 'numeric' }, value);
  }
  function listTime(value) {
    if (!value) return '';
    const key = dayKey(value);
    if (key === dayKey(Date.now())) return timeOf(value);
    if (key === dayKey(Date.now() - 86400000)) return 'Ayer';
    return fmt({ day: '2-digit', month: '2-digit' }, value);
  }
  const nameOf = (row) => row.customerName || row.customerPhone || 'Cliente WhatsApp';
  const initials = (row) => (String(nameOf(row)).match(/[\p{L}\p{N}]/u)?.[0] || '#').toUpperCase();

  // ---------- no leídos ----------
  const saveSeen = () => { try { localStorage.setItem('cbp_inbox_seen', JSON.stringify(seenStore)); } catch {} };
  function markSeen(row) {
    if (!row) return;
    seenStore[row.id] = row.lastMessageAt || new Date().toISOString();
    saveSeen();
  }
  const isUnread = (row) => row.lastDirection === 'inbound' && row.id !== selectedId
    && (!seenStore[row.id] || Date.parse(row.lastMessageAt) > Date.parse(seenStore[row.id]));

  function updateAppBadge() {
    const count = conversations.filter(isUnread).length;
    document.title = count ? `(${count}) Bandeja WhatsApp` : 'Bandeja WhatsApp — ChatBotPro';
    if (navigator.setAppBadge) (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
  }

  // ---------- sonido ----------
  function chime() {
    if (!soundOn) return;
    try {
      audioCx = audioCx || new AudioContext();
      [880, 1175].forEach((freq, i) => {
        const osc = audioCx.createOscillator();
        const gain = audioCx.createGain();
        osc.connect(gain); gain.connect(audioCx.destination);
        osc.frequency.value = freq; osc.type = 'sine';
        const start = audioCx.currentTime + i * 0.11;
        gain.gain.setValueAtTime(0.2, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
        osc.start(start); osc.stop(start + 0.22);
      });
    } catch {}
    navigator.vibrate?.([100, 50, 100]);
  }

  // ---------- lista ----------
  function previewOf(row) {
    const text = row.lastMessageType === 'location' ? '📍 Ubicación' : (plain(row.lastMessage) || 'Sin mensajes');
    return `${row.lastDirection === 'outbound' ? '✓ ' : ''}${text}`;
  }

  function renderList() {
    const query = $('search').value.trim().toLowerCase();
    const rows = conversations.filter((row) => !query || `${nameOf(row)} ${row.customerPhone || ''}`.toLowerCase().includes(query));
    $('convs').innerHTML = rows.length
      ? rows.map((row) => {
        const unread = isUnread(row);
        return `<button class="conv${unread ? ' unread' : ''}${row.id === selectedId ? ' sel' : ''}" data-id="${row.id}">
          <span class="av">${esc(initials(row))}</span>
          <span class="mid"><span class="row1"><span class="name">${esc(nameOf(row))}</span><span class="time">${esc(listTime(row.lastMessageAt))}</span></span>
          <span class="row2"><span class="prev">${esc(previewOf(row))}</span>${unread ? '<span class="badge">●</span>' : ''}<span class="mode${row.botEnabled ? '' : ' human'}">${row.botEnabled ? 'BOT' : 'TÚ'}</span></span></span>
        </button>`;
      }).join('')
      : `<div class="empty"><b>${query ? 'Sin resultados' : 'Sin conversaciones'}</b>${query ? 'Prueba con otro nombre o número.' : 'Cuando un cliente escriba a tu WhatsApp, aparecerá aquí al instante.'}</div>`;
    updateAppBadge();
  }

  // ---------- chat ----------
  function ticks(message) {
    if (message.direction !== 'outbound') return '';
    if (message.pending) return '<span class="tick">🕓</span>';
    const status = String(message.status || '').toLowerCase();
    if (status === 'failed') return '<span class="tick failed">⚠</span>';
    if (status === 'read') return '<span class="tick read">✓✓</span>';
    if (status === 'delivered') return '<span class="tick">✓✓</span>';
    return '<span class="tick">✓</span>';
  }

  function locationCard(message) {
    const lat = Number(message.location.lat);
    const lng = Number(message.location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
    const label = plain(message.location.label || message.body);
    const coords = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    return `<a class="loc" href="https://www.google.com/maps?q=${encodeURIComponent(`${lat},${lng}`)}" target="_blank" rel="noopener noreferrer">
      <span class="pin">📍</span><b>Ubicación</b><span>${label && label !== coords ? esc(label) : esc(coords)}</span>
      ${label && label !== coords ? `<small>${esc(coords)}</small>` : ''}<span class="open">Abrir en Maps</span></a>`;
  }

  function bodyOf(message) {
    const parts = [];
    if (message.location) parts.push(locationCard(message));
    else {
      if (message.mediaUrl && /^https?:\/\//i.test(message.mediaUrl)) parts.push(`<a href="${esc(message.mediaUrl)}" target="_blank" rel="noopener noreferrer"><img class="media" src="${esc(message.mediaUrl)}" alt="Imagen" loading="lazy"></a>`);
      if (message.body) parts.push(`<span>${format(message.body)}</span>`);
    }
    if (Array.isArray(message.options) && message.options.length) {
      parts.push(`<span class="opts">${message.options.map((title) => `<em>${esc(plain(title))}</em>`).join('')}</span>`);
    }
    return parts.join('');
  }

  function who(message) {
    if (message.direction !== 'outbound') return '';
    const source = String(message.source || '');
    if (source === 'bot') return 'Asistente · ';
    if (source.startsWith('human')) return 'Equipo · ';
    if (source === 'cellular') return 'Celular · ';
    return '';
  }

  function renderHeader(row) {
    $('chatName').textContent = nameOf(row);
    $('chatSub').textContent = row.botEnabled ? 'Atiende el asistente' : 'Atiendes tú';
    const button = $('takeoverBtn');
    button.textContent = row.botEnabled ? '✋ Tomar control' : '🤖 Devolver al bot';
    button.classList.toggle('human', !row.botEnabled);
  }

  async function loadMessages(options = {}) {
    if (!selectedId) return;
    const id = selectedId;
    const request = ++messagesRequest;
    const rows = await api(`/api/whatsapp/conversations/${id}/messages`);
    if (request !== messagesRequest || id !== selectedId) return;
    const visible = rows.filter((message, index) => {
      const next = rows[index + 1];
      return !(message.message_type === 'text' && next?.message_type === 'interactive'
        && next.direction === message.direction && String(next.body || '').trim() === String(message.body || '').trim());
    });
    const waiting = (pending.get(id) || []).filter((item) => !visible.some((m) => m.direction === 'outbound' && m.body === item.body && Date.parse(m.created_at) >= item.sentAt - 5000));
    pending.set(id, waiting);
    const all = [...visible, ...waiting];
    const row = conversations.find((item) => item.id === id);
    const box = $('msgs');
    const nearBottom = options.forceBottom || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    let lastDay = '';
    const html = all.map((message) => {
      const key = dayKey(message.created_at);
      const sep = key && key !== lastDay ? `<div class="day">${esc(dayLabel(message.created_at))}</div>` : '';
      lastDay = key || lastDay;
      return `${sep}<div class="msg ${message.direction === 'outbound' ? 'out' : 'in'}${message.status === 'failed' ? ' failed' : ''}">${bodyOf(message)}<span class="meta">${esc(who(message))}${esc(timeOf(message.created_at))} ${ticks(message)}</span></div>`;
    }).join('');
    const hint = row && row.botEnabled && all.length
      ? '<div class="note">El asistente está atendiendo este chat. Si escribes una respuesta, tomas el control.</div>' : '';
    box.innerHTML = (html || '<div class="empty"><b>Sin mensajes</b>El siguiente mensaje aparecerá aquí.</div>') + hint;
    if (nearBottom) box.scrollTop = box.scrollHeight;
    const current = conversations.find((item) => item.id === id);
    if (current) { markSeen(current); updateAppBadge(); }
  }

  function showChat(visible) {
    $('placeholder').style.display = visible ? 'none' : 'grid';
    $('chatView').style.display = visible ? 'flex' : 'none';
  }

  async function openConversation(id, { push = true } = {}) {
    const row = conversations.find((item) => item.id === Number(id));
    if (!row) return;
    selectedId = row.id;
    markSeen(row);
    renderHeader(row);
    showChat(true);
    $('msgs').innerHTML = '';
    $('app').classList.add('in-chat');
    if (push && !wide()) history.pushState({ chat: row.id }, '');
    renderList();
    try { await loadMessages({ forceBottom: true }); } catch (error) { toast(error.message); }
    if (wide()) $('input').focus();
  }

  function closeConversation() {
    selectedId = null;
    $('app').classList.remove('in-chat');
    showChat(false);
    renderList();
  }

  // ---------- refresco en tiempo real ----------
  function detectIncoming(next) {
    let alert = false;
    for (const row of next) {
      const stamp = `${row.lastMessageAt}|${row.lastDirection}|${row.lastMessage}`;
      const previous = known.get(row.id);
      known.set(row.id, stamp);
      if (loadedOnce && previous !== stamp && row.lastDirection === 'inbound') {
        const watching = row.id === selectedId && document.visibilityState === 'visible';
        if (!watching) alert = true;
      }
    }
    if (alert) chime();
  }

  async function refresh() {
    if (refreshBusy) { refreshAgain = true; return; }
    refreshBusy = true;
    try {
      const data = await api('/api/whatsapp');
      const rows = (data.conversations || []).map((row) => ({ ...row, id: Number(row.id) }));
      if (!loadedOnce) for (const row of rows) if (!seenStore[row.id]) seenStore[row.id] = row.lastMessageAt;
      saveSeen();
      detectIncoming(rows);
      conversations = rows;
      loadedOnce = true;
      renderList();
      const current = conversations.find((row) => row.id === selectedId);
      if (current) { renderHeader(current); await loadMessages(); }
    } catch (error) {
      if (error.status === 401) gate('Sesión requerida', 'Inicia sesión para ver tus mensajes.', { href: '/login?redirect=/bandeja', label: 'Iniciar sesión' });
    } finally {
      refreshBusy = false;
      if (refreshAgain) { refreshAgain = false; schedule(60); }
    }
  }
  function schedule(delay = 100) { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, delay); }

  function setStatus(state) {
    $('statusDot').className = `dot${state === 'on' ? ' on' : state === 'off' ? ' off' : ''}`;
    $('statusText').textContent = state === 'on' ? 'En línea' : state === 'off' ? 'Reconectando…' : 'Conectando…';
  }

  function connectSocket() {
    if (typeof window.io !== 'function') { setStatus('off'); return; }
    socket = window.io({ reconnectionDelay: 1500, reconnectionDelayMax: 8000 });
    socket.on('connect', () => { setStatus('on'); schedule(0); });
    socket.on('disconnect', () => setStatus('off'));
    socket.on('connect_error', () => setStatus('off'));
    socket.on('whatsapp_update', () => schedule(80));
  }

  // ---------- acciones ----------
  async function sendMessage(event) {
    event.preventDefault();
    const field = $('input');
    const text = field.value.trim();
    const id = selectedId;
    if (!text || !id) return;
    const item = { pending: true, direction: 'outbound', source: 'human', message_type: 'text', body: text, created_at: new Date().toISOString(), sentAt: Date.now() };
    pending.set(id, [...(pending.get(id) || []), item]);
    field.value = ''; field.style.height = 'auto';
    loadMessages({ forceBottom: true }).catch(() => {});
    try {
      await api(`/api/whatsapp/conversations/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) });
      schedule(0);
    } catch (error) {
      pending.set(id, (pending.get(id) || []).filter((entry) => entry !== item));
      if (!field.value) field.value = text;
      loadMessages().catch(() => {});
      toast(error.message);
    }
  }

  async function toggleTakeover() {
    const row = conversations.find((item) => item.id === selectedId);
    if (!row) return;
    try {
      await api(`/api/whatsapp/conversations/${row.id}/takeover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botEnabled: !row.botEnabled }) });
      toast(row.botEnabled ? 'Tomaste el control: el bot dejó de responder' : 'El bot volvió a atender este chat');
      await refresh();
    } catch (error) { toast(error.message); }
  }

  // ---------- notificaciones push ----------
  const urlBase64 = (value) => {
    const pad = '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob((value + pad).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  };

  async function registerSubscription(subscription) {
    const json = subscription.toJSON();
    await api('/api/notifications/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, topic: 'whatsapp' }) });
  }

  async function enablePush() {
    if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
      toast(isIos && !isStandalone ? 'En iPhone instala primero la app en tu pantalla de inicio' : 'Este navegador no admite avisos');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') { toast('Permiso denegado. Actívalo en los ajustes del navegador.'); return; }
    try {
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await api('/api/notifications/vapid-public-key');
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64(publicKey) });
      await registerSubscription(subscription);
      $('pushBanner').classList.add('hidden');
      toast('Avisos activados en este dispositivo');
    } catch (error) { toast(error.message || 'No se pudieron activar los avisos'); }
  }

  async function checkPush() {
    if (!('PushManager' in window) || !('serviceWorker' in navigator) || !('Notification' in window)) {
      if (isIos && !isStandalone) $('iosGuide').classList.remove('hidden');
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription && Notification.permission === 'granted') {
        await registerSubscription(subscription).catch(() => {});
        return;
      }
      if (Notification.permission !== 'denied') $('pushBanner').classList.remove('hidden');
    } catch {}
  }

  // ---------- arranque ----------
  async function init() {
    setStatus('wait');
    $('soundBtn').textContent = soundOn ? '🔔' : '🔕';
    let settings;
    try {
      settings = await api('/api/settings');
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        gate('Sesión requerida', 'Inicia sesión con tu cuenta del negocio para ver los mensajes.', { href: '/login?redirect=/bandeja', label: 'Iniciar sesión' });
      } else {
        gate('Sin conexión', 'No pudimos conectar con el servidor. Revisa tu internet e inténtalo de nuevo.', { href: '/bandeja', label: 'Reintentar' });
      }
      return;
    }
    tz = settings.timezone || undefined;
    if (settings.business_name) { $('bizName').textContent = settings.business_name; $('brandAvatar').textContent = settings.business_name[0].toUpperCase(); }
    const logo = String(settings.logo || '').trim();
    if (logo) $('brandAvatar').innerHTML = `<img src="${esc(logo.startsWith('http') ? logo : (logo.startsWith('/') ? logo : `/${logo}`))}" alt="">`;

    try {
      await refresh();
    } catch {}
    const wanted = Number(new URLSearchParams(location.search).get('c'));
    if (wanted) openConversation(wanted, { push: false });
    connectSocket();
    checkPush();
  }

  // ---------- eventos ----------
  $('convs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-id]');
    if (button) openConversation(Number(button.dataset.id));
  });
  $('search').addEventListener('input', renderList);
  $('composer').addEventListener('submit', sendMessage);
  $('takeoverBtn').addEventListener('click', toggleTakeover);
  $('backBtn').addEventListener('click', () => { if (history.state?.chat) history.back(); else closeConversation(); });
  $('pushBtn').addEventListener('click', enablePush);
  $('soundBtn').addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('cbp_inbox_sound', soundOn ? '1' : '0');
    $('soundBtn').textContent = soundOn ? '🔔' : '🔕';
    if (soundOn) chime();
  });
  $('input').addEventListener('input', (event) => {
    const el = event.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  });
  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && wide()) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  window.addEventListener('popstate', () => { if (!history.state?.chat) closeConversation(); });
  window.addEventListener('online', () => { $('offlineBanner').classList.add('hidden'); schedule(0); });
  window.addEventListener('offline', () => $('offlineBanner').classList.remove('hidden'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); });
  setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, 15000);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstall = event;
    if (!isStandalone && localStorage.getItem('cbp_inbox_install_dismissed') !== '1') $('installBanner').classList.remove('hidden');
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    $('installBanner').classList.add('hidden');
  });
  $('installClose').addEventListener('click', () => {
    localStorage.setItem('cbp_inbox_install_dismissed', '1');
    $('installBanner').classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => $('installBanner').classList.add('hidden'));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-conversation') {
        schedule(0);
        setTimeout(() => openConversation(Number(event.data.id)), 350);
      }
    });
  }

  init();
})();
