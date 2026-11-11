/**
 * Reloj checador — kiosco público.
 *
 * Vive en la liga externa `/checador/:slug/:token`. No hay sesión de panel:
 * la autoridad es el token del dispositivo (en la URL) más la credencial del
 * empleado. El flujo siempre es identificar → elegir movimiento → confirmar.
 */
(() => {
  const $ = (selector) => document.querySelector(selector);

  const [, , SLUG, TOKEN] = location.pathname.split('/');
  const BASE = `/api/checador/kiosk/${encodeURIComponent(SLUG)}/${encodeURIComponent(TOKEN)}`;

  const PUNCH_LABELS = {
    in: { label: 'Entrada', icon: 'ph-sign-in', tone: 'in' },
    out: { label: 'Salida', icon: 'ph-sign-out', tone: 'out' },
    break_start: { label: 'Inicio de comida', icon: 'ph-coffee', tone: 'break' },
    break_end: { label: 'Fin de comida', icon: 'ph-fork-knife', tone: 'break' },
  };
  const IDLE_RESET_MS = 20000;
  const DONE_RESET_MS = 6000;

  let DEVICE = null;
  let SESSION = null;
  let EMPLOYEE = null;
  let STATE = null;
  let PIN = '';
  let METHOD = 'pin';
  let LAST_POSITION = null;
  let idleTimer = null;
  let countdownTimer = null;
  let cameraStream = null;
  let scannerStream = null;
  let scannerLoop = null;
  let busy = false;

  /* ─────────── Utilidades ─────────── */
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  const pad = (n) => String(n).padStart(2, '0');

  function formatMinutes(total) {
    const minutes = Math.max(0, Math.round(Number(total) || 0));
    return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} m`;
  }

  function formatClock(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function post(path, body) {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'No se pudo completar la operación');
    return data;
  }

  function showError(node, message) {
    const target = $(node);
    if (!target) return;
    target.textContent = message;
    target.hidden = !message;
  }

  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch {} }
  }

  /* Base64url ⇄ ArrayBuffer para WebAuthn */
  const toBuffer = (value) => {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  };
  const toBase64Url = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const toBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  /* ─────────── Reloj de pantalla ─────────── */
  function tickClock() {
    const now = new Date();
    $('#ckTime').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    $('#ckDate').textContent = now.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  /* ─────────── Navegación entre pasos ─────────── */
  function showStage(name) {
    $('#ckStageIdentify').hidden = name !== 'identify';
    $('#ckStageAction').hidden = name !== 'action';
    $('#ckStageDone').hidden = name !== 'done';
  }

  function resetToIdentify({ keepMethod = true } = {}) {
    clearTimeout(idleTimer);
    clearInterval(countdownTimer);
    stopCamera();
    SESSION = null;
    EMPLOYEE = null;
    STATE = null;
    PIN = '';
    renderPinDots();
    $('#ckEmpCode').value = '';
    $('#ckQrInput').value = '';
    showError('#ckError', '');
    showError('#ckActionError', '');
    $('#ckCountdown').textContent = '';
    showStage('identify');
    if (!keepMethod) selectMethod(DEVICE?.device?.methods?.[0] || 'pin');
    else if (METHOD === 'qr') startScanner();
  }

  function armIdleReset(ms = IDLE_RESET_MS) {
    clearTimeout(idleTimer);
    clearInterval(countdownTimer);
    const deadline = Date.now() + ms;
    countdownTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      $('#ckCountdown').textContent = left ? `La pantalla se reinicia en ${left} s` : '';
    }, 500);
    idleTimer = setTimeout(() => resetToIdentify(), ms);
  }

  /* ─────────── Selección de método ─────────── */
  function selectMethod(method) {
    METHOD = method;
    document.querySelectorAll('#ckMethods button').forEach((button) => {
      button.classList.toggle('on', button.dataset.method === method);
    });
    $('#ckPanelPin').hidden = method !== 'pin';
    $('#ckPanelQr').hidden = method !== 'qr';
    $('#ckPanelBio').hidden = method !== 'biometric';
    showError('#ckError', '');
    if (method === 'qr') startScanner(); else stopScanner();
    if (method === 'pin') setTimeout(() => $('#ckEmpCode')?.focus(), 60);
    if (method === 'qr') setTimeout(() => $('#ckQrInput')?.focus(), 60);
  }

  /* ─────────── NIP ─────────── */
  function renderPinDots() {
    const dots = $('#ckPinDots');
    dots.innerHTML = Array.from({ length: Math.max(4, PIN.length) }, (_, index) => (
      `<span class="${index < PIN.length ? 'on' : ''}"></span>`
    )).join('');
  }

  function pushPin(digit) {
    if (PIN.length >= 8) return;
    PIN += digit;
    renderPinDots();
    vibrate(8);
  }

  async function submitPin() {
    const code = $('#ckEmpCode').value.trim();
    if (!code) { showError('#ckError', 'Escribe tu número de empleado'); $('#ckEmpCode').focus(); return; }
    if (PIN.length < 4) { showError('#ckError', 'Tu NIP debe tener al menos 4 dígitos'); return; }
    await identify({ method: 'pin', code, pin: PIN });
  }

  /* ─────────── Identificación ─────────── */
  async function identify(payload) {
    if (busy) return;
    busy = true;
    showError('#ckError', '');
    try {
      const data = await post('/identify', payload);
      await onIdentified(data);
    } catch (error) {
      showError('#ckError', error.message);
      PIN = '';
      renderPinDots();
      vibrate([40, 60, 40]);
    } finally {
      busy = false;
    }
  }

  async function onIdentified(data) {
    SESSION = data.session;
    EMPLOYEE = data.employee;
    STATE = data.state;
    stopScanner();
    renderEmployee();
    showStage('action');
    if (DEVICE?.device?.require_photo) await startCamera();
    if (DEVICE?.device?.require_geo) requestPosition();
    armIdleReset();
  }

  function renderEmployee() {
    const initials = String(EMPLOYEE.name || '?').split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
    const avatar = $('#ckAvatar');
    avatar.textContent = initials;
    avatar.style.background = EMPLOYEE.avatar_color || '#6c47ff';
    if (EMPLOYEE.photo_url) {
      avatar.innerHTML = `<img src="${esc(EMPLOYEE.photo_url)}" alt="" />`;
    }
    $('#ckEmpName').textContent = EMPLOYEE.name;
    $('#ckEmpMeta').textContent = [EMPLOYEE.emp_code && `No. ${EMPLOYEE.emp_code}`, EMPLOYEE.position, EMPLOYEE.schedule_name]
      .filter(Boolean).join(' · ') || 'Sin datos adicionales';

    const chips = [];
    chips.push(`<span class="ck-chip ${STATE.shift_open ? 'on' : ''}"><i class="ph-bold ph-timer"></i> ${STATE.shift_open ? 'Turno abierto' : 'Fuera de turno'}</span>`);
    chips.push(`<span class="ck-chip"><i class="ph-bold ph-hourglass-medium"></i> Hoy: ${formatMinutes(STATE.worked_minutes_today)}</span>`);
    if (STATE.break_minutes_today) {
      chips.push(`<span class="ck-chip"><i class="ph-bold ph-coffee"></i> Comida: ${formatMinutes(STATE.break_minutes_today)}</span>`);
    }
    if (STATE.punches_today?.length) {
      const last = STATE.punches_today[STATE.punches_today.length - 1];
      const meta = PUNCH_LABELS[last.type] || PUNCH_LABELS.in;
      chips.push(`<span class="ck-chip"><i class="ph-bold ${meta.icon}"></i> Último: ${meta.label} ${formatClock(new Date(last.at))}</span>`);
    }
    $('#ckStatusStrip').innerHTML = chips.join('');

    const actions = $('#ckActions');
    actions.innerHTML = STATE.available.map((type, index) => {
      const meta = PUNCH_LABELS[type] || PUNCH_LABELS.in;
      return `<button type="button" class="ck-action ck-action-${meta.tone} ${index === 0 ? 'primary' : ''}" data-punch="${type}">
        <i class="ph-fill ${meta.icon}"></i><span>${meta.label}</span>
      </button>`;
    }).join('');

    const canEnroll = Boolean(window.PublicKeyCredential)
      && (DEVICE?.device?.methods || []).includes('biometric')
      && location.protocol === 'https:';
    $('#ckEnrollBtn').hidden = !canEnroll;
  }

  /* ─────────── Geolocalización ─────────── */
  function requestPosition() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        LAST_POSITION = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
      },
      () => { LAST_POSITION = null; },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  /* ─────────── Cámara (foto de evidencia) ─────────── */
  async function startCamera() {
    if (cameraStream || !navigator.mediaDevices?.getUserMedia) return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640 }, audio: false });
      const video = $('#ckCameraVideo');
      video.srcObject = cameraStream;
      await video.play().catch(() => {});
      $('#ckCameraWrap').hidden = false;
    } catch {
      $('#ckCameraWrap').hidden = true;
      showError('#ckActionError', 'No se pudo abrir la cámara; este checador la necesita para registrar la evidencia.');
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    $('#ckCameraWrap').hidden = true;
  }

  function capturePhoto() {
    const video = $('#ckCameraVideo');
    if (!cameraStream || !video.videoWidth) return '';
    const canvas = document.createElement('canvas');
    const width = 480;
    canvas.width = width;
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * width) || 360;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  /* ─────────── Escáner de credenciales QR ─────────── */
  async function startScanner() {
    if (scannerStream || !navigator.mediaDevices?.getUserMedia) return;
    if (!('BarcodeDetector' in window)) {
      $('#ckScannerHint').textContent = 'Este navegador no puede leer el QR con la cámara: usa un lector o captura el código.';
      return;
    }
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      const video = $('#ckScannerVideo');
      video.srcObject = scannerStream;
      await video.play().catch(() => {});
      // eslint-disable-next-line no-undef
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      scannerLoop = setInterval(async () => {
        if (busy || !scannerStream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            const value = String(codes[0].rawValue || '').trim();
            if (value) { vibrate(30); await identify({ method: 'qr', qr: value }); }
          }
        } catch {}
      }, 450);
    } catch {
      $('#ckScannerHint').textContent = 'Sin acceso a la cámara: usa un lector físico o captura el código del gafete.';
    }
  }

  function stopScanner() {
    clearInterval(scannerLoop);
    scannerLoop = null;
    if (scannerStream) {
      scannerStream.getTracks().forEach((track) => track.stop());
      scannerStream = null;
    }
  }

  /* ─────────── Huella (WebAuthn) ─────────── */
  async function biometricLogin() {
    if (busy) return;
    if (!window.PublicKeyCredential) {
      showError('#ckError', 'Este navegador no soporta huella. Usa tu NIP.');
      return;
    }
    busy = true;
    showError('#ckError', '');
    $('#ckBioBtn').classList.add('working');
    try {
      const options = await post('/webauthn/options', { mode: 'login' });
      if (!options.publicKey.allowCredentials?.length) {
        throw new Error('Aún no hay huellas registradas en este dispositivo. Entra con tu NIP y regístrala.');
      }
      const credential = await navigator.credentials.get({
        publicKey: {
          ...options.publicKey,
          challenge: toBuffer(options.publicKey.challenge),
          allowCredentials: options.publicKey.allowCredentials.map((item) => ({ ...item, id: toBuffer(item.id) })),
        },
      });
      if (!credential) throw new Error('No se recibió la huella');
      const data = await post('/webauthn/login', {
        challenge_token: options.challenge_token,
        credential_id: credential.id,
        client_data: toBase64Url(credential.response.clientDataJSON),
        authenticator_data: toBase64Url(credential.response.authenticatorData),
        signature: toBase64Url(credential.response.signature),
      });
      vibrate(30);
      await onIdentified(data);
    } catch (error) {
      showError('#ckError', error.name === 'NotAllowedError' ? 'Huella cancelada o no reconocida' : error.message);
    } finally {
      $('#ckBioBtn').classList.remove('working');
      busy = false;
    }
  }

  async function enrollBiometric() {
    if (busy || !SESSION) return;
    busy = true;
    showError('#ckActionError', '');
    try {
      const options = await post('/webauthn/options', { mode: 'register', session: SESSION });
      const credential = await navigator.credentials.create({
        publicKey: {
          ...options.publicKey,
          challenge: toBuffer(options.publicKey.challenge),
          user: { ...options.publicKey.user, id: toBuffer(options.publicKey.user.id) },
          excludeCredentials: (options.publicKey.excludeCredentials || []).map((item) => ({ ...item, id: toBuffer(item.id) })),
        },
      });
      if (!credential) throw new Error('No se recibió la huella');
      const publicKey = credential.response.getPublicKey?.();
      if (!publicKey) throw new Error('Este navegador no entregó la llave de la huella. Actualiza Chrome, Edge o Safari.');
      await post('/webauthn/register', {
        challenge_token: options.challenge_token,
        credential_id: credential.id,
        client_data: toBase64Url(credential.response.clientDataJSON),
        public_key: toBase64(publicKey),
        algorithm: credential.response.getPublicKeyAlgorithm?.() ?? -7,
      });
      showError('#ckActionError', '');
      $('#ckEnrollBtn').innerHTML = '<i class="ph-bold ph-check-circle"></i> Huella registrada en este dispositivo';
      $('#ckEnrollBtn').disabled = true;
      vibrate([20, 40, 20]);
      armIdleReset();
    } catch (error) {
      showError('#ckActionError', error.name === 'NotAllowedError' ? 'Registro de huella cancelado' : error.message);
    } finally {
      busy = false;
    }
  }

  /* ─────────── Registro de la checada ─────────── */
  async function punch(type) {
    if (busy || !SESSION) return;
    busy = true;
    showError('#ckActionError', '');
    document.querySelectorAll('.ck-action').forEach((button) => { button.disabled = true; });
    try {
      const body = { session: SESSION, type };
      if (DEVICE?.device?.require_photo) {
        const photo = capturePhoto();
        if (!photo) throw new Error('No se pudo tomar la foto de evidencia');
        body.photo = photo;
      }
      if (DEVICE?.device?.require_geo) {
        if (!LAST_POSITION) throw new Error('Activa la ubicación del dispositivo para poder checar');
        Object.assign(body, LAST_POSITION);
      }
      const data = await post('/punch', body);
      vibrate([20, 50, 20]);
      renderDone(type, data);
    } catch (error) {
      showError('#ckActionError', error.message);
      document.querySelectorAll('.ck-action').forEach((button) => { button.disabled = false; });
      armIdleReset();
    } finally {
      busy = false;
    }
  }

  function renderDone(type, data) {
    clearTimeout(idleTimer);
    clearInterval(countdownTimer);
    stopCamera();
    const meta = PUNCH_LABELS[type] || PUNCH_LABELS.in;
    const at = new Date(data.punch.punched_at);
    $('#ckDoneMark').className = `ck-done-mark ck-done-${meta.tone}`;
    $('#ckDoneTitle').textContent = `${meta.label} registrada`;
    $('#ckDoneName').textContent = data.employee.name;
    $('#ckDoneTime').textContent = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    const extras = [`Acumulado de hoy: ${formatMinutes(data.state.worked_minutes_today)}`];
    if (data.punch.distance_m !== null && data.punch.distance_m !== undefined) {
      extras.push(`a ${data.punch.distance_m} m del punto autorizado`);
    }
    $('#ckDoneMeta').textContent = extras.join(' · ');
    showStage('done');
    setTimeout(() => resetToIdentify(), DONE_RESET_MS);
  }

  /* ─────────── Arranque ─────────── */
  async function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    try {
      const response = await fetch(BASE, { headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'Checador no disponible');
      DEVICE = data;
    } catch (error) {
      $('#ckBoot').innerHTML = `<div class="ck-boot-mark"><i class="ph-bold ph-warning-circle"></i></div><strong>${esc(error.message)}</strong>`;
      return;
    }

    document.documentElement.style.setProperty('--ck-accent', DEVICE.business.color || '#ff6b35');
    if (DEVICE.business.logo) $('#ckLogo').src = DEVICE.business.logo;
    $('#ckBusiness').textContent = DEVICE.business.name || 'ChatBotPro';
    $('#ckDeviceName').textContent = DEVICE.device.name || 'Reloj checador';
    document.title = `Checador — ${DEVICE.business.name || 'ChatBotPro'}`;
    if (DEVICE.device.branch_name) {
      const branch = $('#ckBranch');
      branch.hidden = false;
      branch.querySelector('span').textContent = DEVICE.device.branch_name;
    }

    const methods = DEVICE.device.methods || ['pin'];
    document.querySelectorAll('#ckMethods button').forEach((button) => {
      button.hidden = !methods.includes(button.dataset.method);
    });
    $('#ckMethods').hidden = methods.length < 2;

    const footer = [];
    if (DEVICE.device.require_photo) footer.push('Foto de evidencia obligatoria');
    if (DEVICE.device.require_geo) footer.push(`Geocerca de ${DEVICE.device.geo_radius_m} m`);
    footer.push(`Zona horaria ${DEVICE.timezone}`);
    $('#ckFooterMeta').textContent = footer.join(' · ');

    $('#ckBoot').hidden = true;
    $('#ckShell').hidden = false;
    renderPinDots();
    selectMethod(methods[0]);
  }

  /* ─────────── Eventos ─────────── */
  $('#ckMethods').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-method]');
    if (button) selectMethod(button.dataset.method);
  });

  $('#ckKeypad').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-key]');
    if (!button) return;
    const key = button.dataset.key;
    if (key === 'clear') { PIN = ''; renderPinDots(); showError('#ckError', ''); return; }
    if (key === 'enter') { submitPin(); return; }
    pushPin(key);
  });

  $('#ckEmpCode').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submitPin(); }
  });

  // Teclado físico: cómodo en kioscos con teclado numérico conectado.
  document.addEventListener('keydown', (event) => {
    if (METHOD !== 'pin' || $('#ckStageIdentify').hidden) return;
    if (document.activeElement === $('#ckEmpCode') || document.activeElement === $('#ckQrInput')) return;
    if (/^\d$/.test(event.key)) { pushPin(event.key); event.preventDefault(); }
    else if (event.key === 'Backspace') { PIN = PIN.slice(0, -1); renderPinDots(); event.preventDefault(); }
    else if (event.key === 'Enter') { submitPin(); event.preventDefault(); }
  });

  // Lectores de gafete y de huella en modo teclado terminan la lectura con Enter.
  $('#ckQrInput').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const value = $('#ckQrInput').value.trim();
    if (value) identify({ method: 'qr', qr: value });
  });
  $('#ckQrSubmit').addEventListener('click', () => {
    const value = $('#ckQrInput').value.trim();
    if (value) identify({ method: 'qr', qr: value });
    else showError('#ckError', 'Escanea o captura el código de tu gafete');
  });

  $('#ckBioBtn').addEventListener('click', biometricLogin);
  $('#ckEnrollBtn').addEventListener('click', enrollBiometric);
  $('#ckCancelBtn').addEventListener('click', () => resetToIdentify());
  $('#ckActions').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-punch]');
    if (button) punch(button.dataset.punch);
  });
  $('#ckStageAction').addEventListener('pointerdown', () => { if (SESSION) armIdleReset(); });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopScanner(); stopCamera(); }
    else if (METHOD === 'qr' && !$('#ckStageIdentify').hidden) startScanner();
  });

  boot();
})();
