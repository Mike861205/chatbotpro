(() => {
  const segments = location.pathname.split('/').filter(Boolean);
  const slug = segments[1] || '';
  const token = segments[2] || '';
  const endpoint = `/api/kds/public/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`;
  const POLL_MS = 4000;
  const SOUND_KEY = `cbp:kds:sound:${slug}`;
  let payload = null;
  let loading = false;
  let bootstrapped = false;
  let knownPending = new Set();
  let soundEnabled = localStorage.getItem(SOUND_KEY) !== '0';
  let audioContext = null;
  let toastTimer = null;

  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  function setConnection(mode, label) {
    const el = $('#connectionState');
    el.className = `kds-connection ${mode}`;
    el.querySelector('span').textContent = label;
  }

  function toast(message, error = false) {
    const el = $('#kdsToast');
    el.querySelector('span').textContent = message;
    el.className = `kds-toast show${error ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'kds-toast'; }, 2600);
  }

  function playAlert() {
    if (!soundEnabled) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    audioContext ||= new AudioCtx();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    const start = audioContext.currentTime + .03;
    [740, 988, 1245].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, start + index * .22);
      gain.gain.exponentialRampToValueAtTime(.18, start + index * .22 + .025);
      gain.gain.exponentialRampToValueAtTime(.0001, start + index * .22 + .17);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start + index * .22);
      oscillator.stop(start + index * .22 + .19);
    });
  }

  function syncSoundButton() {
    const button = $('#soundBtn');
    button.classList.toggle('active', soundEnabled);
    button.setAttribute('aria-pressed', String(soundEnabled));
    button.querySelector('i').className = soundEnabled ? 'ph-bold ph-speaker-high' : 'ph-bold ph-speaker-slash';
  }

  function itemModifiers(item) {
    if (item.modifiersLabel) return String(item.modifiersLabel);
    if (Array.isArray(item.modifiers) && item.modifiers.length) {
      return item.modifiers.map((modifier) => modifier?.name || modifier?.label || '').filter(Boolean).join(', ');
    }
    return item.variantName ? String(item.variantName) : '';
  }

  function itemList(items) {
    return items.map((item) => {
      const modifiers = itemModifiers(item);
      return `<li>
        <span class="item-qty">${esc(item.qty || 1)}×</span>
        <span><span class="item-name">${esc(item.name || 'Producto')}</span>${modifiers ? `<small class="item-mods">${esc(modifiers)}</small>` : ''}</span>
      </li>`;
    }).join('');
  }

  function minutesSince(date) {
    const ms = Date.now() - new Date(date).getTime();
    return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 60000)) : 0;
  }

  function timeLabel(date) {
    try { return new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date)); }
    catch { return '--:--'; }
  }

  function ticketCard(ticket) {
    const age = minutesSince(ticket.createdAt);
    const urgent = ticket.status !== 'ready' && age >= 15;
    const action = ticket.status === 'pending'
      ? ['preparing', 'ph-cooking-pot', 'Iniciar preparación']
      : ticket.status === 'preparing'
        ? ['ready', 'ph-check-circle', 'Marcar listo']
        : ['completed', 'ph-hand-palm', 'Entregar / retirar'];
    const back = ticket.status === 'preparing' ? 'pending' : ticket.status === 'ready' ? 'preparing' : '';
    const channelLabel = ticket.channel === 'table_round' ? 'Mesa' : ticket.channel === 'pos' ? 'Punto de venta' : 'Chatbot';
    const ticketLabel = ticket.channel === 'table_round'
      ? `Mesa ${ticket.tableNumber} · Ronda ${ticket.roundNumber}`
      : `#${ticket.id}`;
    const otherNames = ticket.otherItems.map((item) => `${item.qty || 1}× ${item.name || 'Producto'}`).join(' · ');
    const routeNames = ticket.routedAreas.map((area) => area.name).join(' + ');
    return `<article class="kds-ticket ${urgent ? 'urgent' : ''}" data-ticket="${ticket.id}" style="--ticket-color:${esc(payload.area.color)}">
      <div class="ticket-head">
        <div class="ticket-number">${esc(ticketLabel)}<span class="ticket-channel">${channelLabel}</span></div>
        <div class="ticket-time"><b>${timeLabel(ticket.createdAt)}</b><small class="${urgent ? 'late' : ''}">hace ${age} min</small></div>
      </div>
      <div class="ticket-meta">
        ${ticket.customerName ? `<span><i class="ph-bold ph-user"></i> ${esc(ticket.customerName)}</span>` : ''}
        ${ticket.waiterName ? `<span><i class="ph-bold ph-identification-badge"></i> Mesero: ${esc(ticket.waiterName)}</span>` : ''}
        ${ticket.branchName ? `<span><i class="ph-bold ph-storefront"></i> ${esc(ticket.branchName)}</span>` : ''}
        <span><i class="ph-bold ${ticket.delivery === 'domicilio' ? 'ph-scooter' : 'ph-shopping-bag-open'}"></i> ${esc(ticket.delivery || 'mostrador')}</span>
        ${ticket.isMixed ? `<span class="mixed-badge"><i class="ph-bold ph-arrows-split"></i> Mixto: ${esc(routeNames || 'varias áreas')}</span>` : ''}
      </div>
      <ul class="ticket-items">${itemList(ticket.areaItems)}</ul>
      ${ticket.notes ? `<p class="ticket-notes"><i class="ph-bold ph-note-pencil"></i> <b>Nota:</b> ${esc(ticket.notes)}</p>` : ''}
      ${ticket.otherItems.length ? `<details class="ticket-other"><summary>${ticket.otherItems.length} partida(s) enviadas a otra área</summary><p>${esc(otherNames)}</p></details>` : ''}
      <div class="ticket-actions">
        ${back ? `<button class="ticket-back" type="button" data-status="${back}" title="Regresar estado"><i class="ph-bold ph-arrow-u-up-left"></i></button>` : ''}
        <button class="ticket-action" type="button" data-status="${action[0]}"><i class="ph-bold ${action[1]}"></i> ${action[2]}</button>
      </div>
    </article>`;
  }

  function emptyColumn(status) {
    const messages = {
      pending: ['ph-bell-simple-slash', 'Sin comandas nuevas'],
      preparing: ['ph-cooking-pot', 'Nada en preparación'],
      ready: ['ph-checks', 'Nada esperando entrega'],
    };
    return `<div class="kds-empty"><i class="ph-bold ${messages[status][0]}"></i><span>${messages[status][1]}</span></div>`;
  }

  function render() {
    if (!payload) return;
    document.documentElement.style.setProperty('--area', payload.area.color || payload.tenant.primaryColor);
    document.title = `${payload.area.name} — ${payload.tenant.businessName}`;
    $('#tenantName').textContent = payload.tenant.businessName;
    $('#areaName').textContent = payload.area.name;
    const logo = $('#tenantLogo');
    logo.src = payload.tenant.logo || '/static/chatbotpro100.png';
    logo.onerror = () => { logo.onerror = null; logo.src = '/static/chatbotpro100.png'; };
    const branch = $('#branchName');
    branch.hidden = !payload.area.branchName;
    branch.querySelector('span').textContent = payload.area.branchName || '';

    for (const status of ['pending', 'preparing', 'ready']) {
      const tickets = payload.tickets.filter((ticket) => ticket.status === status);
      const list = document.querySelector(`[data-list="${status}"]`);
      list.innerHTML = tickets.length ? tickets.map(ticketCard).join('') : emptyColumn(status);
      document.querySelector(`[data-count="${status}"]`).textContent = tickets.length;
      $(`#${status}Count`).textContent = tickets.length;
    }
    $('#lastUpdate').innerHTML = `<i class="ph-bold ph-check"></i> Actualizado ${timeLabel(new Date())}`;
  }

  async function refresh({ initial = false } = {}) {
    if (loading) return;
    loading = true;
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 404 && initial) {
          $('#kdsFatalMessage').textContent = data.error || 'Verifica que el enlace siga activo.';
          $('#kdsFatal').hidden = false;
        }
        throw new Error(data.error || 'No se pudo actualizar la pantalla');
      }
      payload = data;
      const pending = new Set(data.tickets.filter((ticket) => ticket.status === 'pending').map((ticket) => String(ticket.id)));
      if (bootstrapped) {
        const newCount = [...pending].filter((id) => !knownPending.has(id)).length;
        if (newCount) {
          playAlert();
          toast(`${newCount} comanda${newCount > 1 ? 's' : ''} nueva${newCount > 1 ? 's' : ''}`);
        }
      }
      knownPending = pending;
      bootstrapped = true;
      render();
      setConnection('online', 'En línea');
      $('#kdsLoader').classList.add('hide');
    } catch (error) {
      setConnection('offline', 'Sin conexión');
      if (!initial) toast(error.message, true);
    } finally {
      loading = false;
    }
  }

  async function updateTicket(orderId, status, button) {
    button.disabled = true;
    try {
      const response = await fetch(`${endpoint}/orders/${orderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo actualizar la comanda');
      const ticket = payload?.tickets.find((item) => Number(item.id) === Number(orderId));
      const ticketLabel = ticket?.channel === 'table_round'
        ? `Mesa ${ticket.tableNumber} · Ronda ${ticket.roundNumber}`
        : `Pedido #${orderId}`;
      if (ticket) ticket.status = status;
      if (status === 'completed' && payload) payload.tickets = payload.tickets.filter((item) => Number(item.id) !== Number(orderId));
      render();
      toast(status === 'ready' ? `${ticketLabel} lista` : status === 'completed' ? `${ticketLabel} retirada` : 'Comanda actualizada');
      refresh();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  }

  $('#kdsBoard').addEventListener('click', (event) => {
    const button = event.target.closest('[data-status]');
    const card = event.target.closest('[data-ticket]');
    if (!button || !card) return;
    updateTicket(Number(card.dataset.ticket), button.dataset.status, button);
  });

  $('#soundBtn').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem(SOUND_KEY, soundEnabled ? '1' : '0');
    syncSoundButton();
    if (soundEnabled) { playAlert(); toast('Alertas de sonido activadas'); }
  });

  $('#fullscreenBtn').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { toast('El navegador no permitió pantalla completa', true); }
  });

  document.addEventListener('fullscreenchange', () => {
    $('#fullscreenBtn').querySelector('i').className = document.fullscreenElement ? 'ph-bold ph-corners-in' : 'ph-bold ph-corners-out';
  });
  window.addEventListener('online', () => refresh());
  window.addEventListener('offline', () => setConnection('offline', 'Sin conexión'));
  setInterval(() => { $('#clock').textContent = timeLabel(new Date()); }, 1000);
  setInterval(() => refresh(), POLL_MS);
  setInterval(() => { if (payload) render(); }, 30000);
  syncSoundButton();
  $('#clock').textContent = timeLabel(new Date());
  refresh({ initial: true });
})();
