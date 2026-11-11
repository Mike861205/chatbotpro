/**
 * Reloj checador — panel del administrador.
 *
 * Carga perezosa: `window.loadChecador()` es el enganche que usa el router de
 * app.js. Reutiliza los helpers globales del panel (`api`, `toast`, `esc`,
 * `askConfirm`, `ME`) para no duplicar infraestructura.
 */
(() => {
  const $c = (selector) => document.querySelector(selector);
  const $$c = (selector) => [...document.querySelectorAll(selector)];

  const WEEKDAYS = [
    [1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'],
    [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo'],
  ];
  const PUNCH_LABELS = {
    in: 'Entrada', out: 'Salida', break_start: 'Inicio de comida', break_end: 'Fin de comida',
  };
  const METHOD_LABELS = {
    pin: 'NIP', qr: 'Credencial QR', biometric: 'Huella', device: 'Lector externo', manual: 'Manual', photo: 'Foto',
  };
  const PAY_TYPE_LABELS = {
    monthly: 'Mensual', biweekly: 'Quincenal', weekly: 'Semanal', daily: 'Por día', hourly: 'Por hora',
  };
  const STATUS_META = {
    trabajado: ['Trabajado', 'ok'],
    falta: ['Falta', 'bad'],
    descanso: ['Descanso', 'rest'],
    sin_horario: ['Sin horario', 'rest'],
    vacaciones: ['Vacaciones', 'info'],
    incapacidad: ['Incapacidad', 'info'],
    permiso_con_goce: ['Permiso con goce', 'info'],
    permiso_sin_goce: ['Permiso sin goce', 'warn'],
    festivo: ['Día festivo', 'info'],
    descanso_otorgado: ['Descanso', 'rest'],
    suspension: ['Suspensión', 'bad'],
  };

  let BASE = null;            // { config, branches, schedules, devices, incidence_types, timezone, today }
  let EMPLOYEES = [];
  let OVERVIEW = null;
  let ATTENDANCE = null;
  let PAYROLL = null;
  let PERIODS = [];
  let ADVANCES = [];
  let INCIDENCES = [];
  let TAB = 'board';
  let BOOTED = false;
  let RANGE = { preset: 'week', from: '', to: '' };
  let PAY_RANGE = { preset: 'biweek', from: '', to: '' };
  let SCHEDULE_DRAFT = [];
  let BADGE_EMPLOYEE = null;
  let LINK_DEVICE = null;
  let OPEN_PERIOD = null;

  /* ═══════════ Formato ═══════════ */
  const currency = (value) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(value) || 0);
  const pad = (n) => String(n).padStart(2, '0');

  function hours(minutes) {
    const total = Math.round(Number(minutes) || 0);
    const sign = total < 0 ? '-' : '';
    const absolute = Math.abs(total);
    return `${sign}${Math.floor(absolute / 60)}:${pad(absolute % 60)}`;
  }

  function dayLabel(isoDate) {
    if (!isoDate) return '—';
    const date = new Date(`${isoDate}T12:00:00`);
    return date.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  function timeLabel(value) {
    if (!value) return '—';
    return new Date(value).toLocaleTimeString('es-MX', {
      hour: '2-digit', minute: '2-digit', timeZone: BASE?.timezone || undefined,
    });
  }

  function dateTimeLabel(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('es-MX', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: BASE?.timezone || undefined,
    });
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).slice(0, 2).map((word) => word[0] || '').join('').toUpperCase();
  }

  function tenantSlug() {
    return String(ME?.tenant?.slug || '').trim();
  }

  function deviceLink(device) {
    return `${location.origin}/checador/${tenantSlug()}/${device.access_token}`;
  }

  function qrImage(data, size = 200) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=6&data=${encodeURIComponent(data)}`;
  }

  function emptyState(icon, title, text) {
    return `<div class="chk-empty"><i class="ph-bold ${icon}"></i><h4>${esc(title)}</h4><p>${esc(text)}</p></div>`;
  }

  function openModal(id) { $c(`#${id}`)?.classList.add('show'); }
  function closeModal(id) { $c(`#${id}`)?.classList.remove('show'); }

  function printDocument(title, body) {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast('Permite las ventanas emergentes para imprimir', true); return; }
    win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8" /><title>${esc(title)}</title>
      <style>
        body{font-family:system-ui,sans-serif;color:#171c2e;padding:26px}
        h1{font-size:19px;margin-bottom:4px}h2{font-size:15px;margin:18px 0 8px}
        .meta{color:#5c6378;font-size:12px;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th,td{border:1px solid #d9dee9;padding:6px 8px;text-align:left}
        th{background:#f3f5fa;font-weight:700}
        td.num,th.num{text-align:right}
        .badge-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
        .badge{border:1px solid #d9dee9;border-radius:12px;padding:14px;text-align:center;page-break-inside:avoid}
        .badge img{width:150px;height:150px}
        .badge b{display:block;font-size:14px;margin-top:8px}
        .badge small{color:#5c6378;font-size:11px}
      </style></head><body>${body}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 450);
  }

  function exportSheet(rows, sheetName, fileName) {
    if (!rows.length) { toast('No hay datos para exportar', true); return; }
    if (typeof XLSX === 'undefined') { toast('El exportador no está disponible', true); return; }
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), sheetName);
    XLSX.writeFile(book, fileName);
  }

  /* ═══════════ Carga de datos ═══════════ */
  function rangeQuery(range) {
    const params = new URLSearchParams();
    if (range.preset === 'custom') {
      if (!range.from || !range.to) return null;
      params.set('from', range.from);
      params.set('to', range.to);
    } else {
      params.set('preset', range.preset);
    }
    return params;
  }

  async function loadBase() {
    const [config, employees] = await Promise.all([
      api('/api/checador/config'),
      api('/api/checador/employees?include_inactive=1'),
    ]);
    BASE = config;
    EMPLOYEES = employees;
    fillSelectors();
  }

  async function loadBoard() {
    OVERVIEW = await api('/api/checador/overview');
    renderKpis();
    renderBoard();
  }

  async function loadAttendance() {
    const params = rangeQuery(RANGE);
    if (!params) { toast('Selecciona las dos fechas del rango', true); return; }
    params.set('group', $c('#chkGroup').value);
    if ($c('#chkBranchFilter').value) params.set('branch_id', $c('#chkBranchFilter').value);
    if ($c('#chkEmployeeFilter').value) params.set('employee_id', $c('#chkEmployeeFilter').value);
    ATTENDANCE = await api(`/api/checador/reports/attendance?${params}`);
    RANGE.from = ATTENDANCE.from;
    RANGE.to = ATTENDANCE.to;
    $c('#chkFrom').value = ATTENDANCE.from;
    $c('#chkTo').value = ATTENDANCE.to;
    renderAttendance();
  }

  async function loadPayroll() {
    const params = rangeQuery(PAY_RANGE);
    if (!params) { toast('Selecciona las dos fechas del periodo', true); return; }
    if ($c('#chkPayBranch').value) params.set('branch_id', $c('#chkPayBranch').value);
    PAYROLL = await api(`/api/checador/payroll/preview?${params}`);
    PAY_RANGE.from = PAYROLL.from;
    PAY_RANGE.to = PAYROLL.to;
    $c('#chkPayFrom').value = PAYROLL.from;
    $c('#chkPayTo').value = PAYROLL.to;
    renderPayroll();
  }

  async function loadPeriods() {
    [PERIODS, ADVANCES] = await Promise.all([api('/api/checador/payroll/periods'), api('/api/checador/payroll/advances')]);
    renderPeriods();
    renderAdvances();
  }

  async function loadIncidences() {
    const data = await api('/api/checador/incidences?preset=month');
    INCIDENCES = data.incidences || [];
    renderIncidences();
  }

  /* ═══════════ Selectores compartidos ═══════════ */
  function branchOptions(selected = '', allLabel = 'Todas las sucursales') {
    return [`<option value="">${allLabel}</option>`]
      .concat((BASE?.branches || []).map((branch) => (
        `<option value="${branch.id}" ${String(selected) === String(branch.id) ? 'selected' : ''}>${esc(branch.name)}</option>`
      ))).join('');
  }

  function employeeOptions(selected = '', allLabel = 'Todos los empleados') {
    return [`<option value="">${allLabel}</option>`]
      .concat(EMPLOYEES.filter((employee) => employee.active).map((employee) => (
        `<option value="${employee.id}" ${String(selected) === String(employee.id) ? 'selected' : ''}>${esc(employee.name)}${employee.emp_code ? ` · ${esc(employee.emp_code)}` : ''}</option>`
      ))).join('');
  }

  function scheduleOptions(selected = '') {
    return ['<option value="">Sin horario asignado</option>']
      .concat((BASE?.schedules || []).map((schedule) => (
        `<option value="${schedule.id}" ${String(selected) === String(schedule.id) ? 'selected' : ''}>${esc(schedule.name)}</option>`
      ))).join('');
  }

  function fillSelectors() {
    $c('#chkBranchFilter').innerHTML = branchOptions($c('#chkBranchFilter').value);
    $c('#chkPayBranch').innerHTML = branchOptions($c('#chkPayBranch').value);
    $c('#chkEmployeeFilter').innerHTML = employeeOptions($c('#chkEmployeeFilter').value);
  }

  /* ═══════════ KPIs ═══════════ */
  function renderKpis() {
    if (!OVERVIEW) return;
    const cards = [
      ['#6c47ff', 'ph-users-three', OVERVIEW.employees_tracked, 'Empleados en el checador'],
      ['#10b981', 'ph-user-check', OVERVIEW.present_now, 'Dentro ahora mismo'],
      ['#f59e0b', 'ph-timer', OVERVIEW.late_today, 'Retardos de hoy'],
      ['#ef4444', 'ph-user-minus', OVERVIEW.absent_today, 'Faltas de hoy'],
      ['#3b82f6', 'ph-hourglass-medium', `${hours(OVERVIEW.totals_week.worked_minutes)} h`, 'Horas de la semana'],
      ['#ec4899', 'ph-arrow-fat-line-up', `${hours(OVERVIEW.totals_week.overtime_minutes)} h`, 'Tiempo extra semanal'],
    ];
    $c('#chkKpis').innerHTML = cards.map(([color, icon, value, label]) => `
      <div class="chk-kpi">
        <span class="chk-kpi-icon" style="background:${color}1f;color:${color}"><i class="ph-fill ${icon}"></i></span>
        <div><b>${esc(String(value))}</b><small>${esc(label)}</small></div>
      </div>`).join('');
  }

  /* ═══════════ Tablero ═══════════ */
  function renderBoard() {
    if (!OVERVIEW) return;
    $c('#chkBoardDate').textContent = `${dayLabel(OVERVIEW.today)} · zona horaria ${BASE?.timezone || ''}`;

    const rows = OVERVIEW.today_rows || [];
    $c('#chkTodayGrid').innerHTML = rows.length
      ? rows.map(({ employee, day }) => {
        const [label, tone] = STATUS_META[day.status] || [day.status, 'rest'];
        const live = day.open_shift;
        return `<article class="chk-today-card ${live ? 'live' : ''}">
          <span class="chk-avatar" style="background:${esc(employee.avatar_color || '#6c47ff')}">${esc(initials(employee.name))}</span>
          <div class="chk-today-info">
            <b>${esc(employee.name)}</b>
            <small>${esc([employee.emp_code && `No. ${employee.emp_code}`, employee.branch_name, employee.schedule_name].filter(Boolean).join(' · ') || 'Sin horario')}</small>
            <div class="chk-today-times">
              <span><i class="ph-bold ph-sign-in"></i> ${timeLabel(day.first_in)}</span>
              <span><i class="ph-bold ph-sign-out"></i> ${timeLabel(day.last_out)}</span>
              <span><i class="ph-bold ph-hourglass-medium"></i> ${hours(day.worked_minutes)} h</span>
            </div>
          </div>
          <div class="chk-today-state">
            <span class="chk-tag ${tone}">${esc(label)}</span>
            ${day.late_minutes ? `<span class="chk-tag warn">+${day.late_minutes} min tarde</span>` : ''}
            ${day.overtime_minutes ? `<span class="chk-tag info">Extra ${hours(day.overtime_minutes)} h</span>` : ''}
          </div>
        </article>`;
      }).join('')
      : emptyState('ph-user-plus', 'Aún no hay empleados en el checador', 'Da de alta a tu personal en la pestaña Empleados y asígnales un horario.');

    const punches = OVERVIEW.recent_punches || [];
    $c('#chkRecentTable').innerHTML = punches.length
      ? `<table class="chk-table">
          <thead><tr><th>Hora</th><th>Empleado</th><th>Movimiento</th><th>Método</th><th>Dispositivo</th><th>Evidencia</th></tr></thead>
          <tbody>${punches.map((punch) => `
            <tr>
              <td><b>${timeLabel(punch.punched_at)}</b></td>
              <td>${esc(punch.employee_name)}${punch.emp_code ? `<small> · ${esc(punch.emp_code)}</small>` : ''}</td>
              <td><span class="chk-tag ${punch.punch_type === 'in' ? 'ok' : punch.punch_type === 'out' ? 'bad' : 'warn'}">${esc(PUNCH_LABELS[punch.punch_type] || punch.punch_type)}</span></td>
              <td>${esc(METHOD_LABELS[punch.method] || punch.method)}</td>
              <td>${esc(punch.device_name || (punch.source === 'admin' ? 'Capturada en el panel' : '—'))}</td>
              <td>${punch.photo_url ? `<a href="${esc(punch.photo_url)}" target="_blank" rel="noopener"><img class="chk-thumb" src="${esc(punch.photo_url)}" alt="" /></a>` : '—'}</td>
            </tr>`).join('')}
          </tbody></table>`
      : emptyState('ph-clock-countdown', 'Sin movimientos hoy', 'Las checadas aparecerán aquí en cuanto el personal use la liga del checador.');
  }

  /* ═══════════ Asistencia ═══════════ */
  function totalsCards(totals, extra = []) {
    const cards = [
      ['#3b82f6', 'ph-hourglass-medium', `${hours(totals.worked_minutes)} h`, 'Horas trabajadas'],
      ['#6c47ff', 'ph-target', `${hours(totals.expected_minutes)} h`, 'Horas esperadas'],
      ['#ec4899', 'ph-arrow-fat-line-up', `${hours(totals.overtime_minutes)} h`, 'Tiempo extra'],
      ['#f59e0b', 'ph-timer', `${totals.late_count}`, 'Retardos'],
      ['#ef4444', 'ph-user-minus', `${totals.absent_days}`, 'Faltas'],
      ['#10b981', 'ph-calendar-check', `${totals.worked_days}`, 'Días laborados'],
      ...extra,
    ];
    return cards.map(([color, icon, value, label]) => `
      <div class="chk-kpi">
        <span class="chk-kpi-icon" style="background:${color}1f;color:${color}"><i class="ph-fill ${icon}"></i></span>
        <div><b>${esc(String(value))}</b><small>${esc(label)}</small></div>
      </div>`).join('');
  }

  function renderAttendance() {
    if (!ATTENDANCE) return;
    $c('#chkAttendanceTotals').innerHTML = totalsCards(ATTENDANCE.totals);
    $c('#chkAttendanceRange').textContent = `${dayLabel(ATTENDANCE.from)} — ${dayLabel(ATTENDANCE.to)} · ${ATTENDANCE.rows.length} empleado(s)`;

    if (!ATTENDANCE.rows.length) {
      $c('#chkAttendanceTable').innerHTML = emptyState('ph-calendar-x', 'Sin datos en el rango', 'Verifica que tu personal tenga el checador habilitado y un horario asignado.');
      return;
    }

    $c('#chkAttendanceTable').innerHTML = `<table class="chk-table">
      <thead><tr>
        <th>Empleado</th><th>Horario</th><th class="num">Días</th><th class="num">Trabajadas</th>
        <th class="num">Esperadas</th><th class="num">Balance</th><th class="num">Extra 2x</th>
        <th class="num">Extra 3x</th><th class="num">Retardos</th><th class="num">Faltas</th><th></th>
      </tr></thead>
      <tbody>${ATTENDANCE.rows.map((row) => {
        const balance = row.totals.worked_minutes - row.totals.expected_minutes;
        return `<tr>
          <td>
            <div class="chk-cell-emp">
              <span class="chk-avatar sm" style="background:${esc(row.employee.avatar_color)}">${esc(initials(row.employee.name))}</span>
              <div><b>${esc(row.employee.name)}</b><small>${esc(row.employee.emp_code ? `No. ${row.employee.emp_code}` : '')} ${esc(row.employee.branch_name || '')}</small></div>
            </div>
          </td>
          <td>${esc(row.employee.schedule_name || 'Sin horario')}</td>
          <td class="num">${row.totals.worked_days}/${row.totals.scheduled_days}</td>
          <td class="num"><b>${hours(row.totals.worked_minutes)}</b></td>
          <td class="num">${hours(row.totals.expected_minutes)}</td>
          <td class="num ${balance < 0 ? 'neg' : 'pos'}">${hours(balance)}</td>
          <td class="num">${hours(row.totals.double_overtime_minutes)}</td>
          <td class="num">${hours(row.totals.triple_overtime_minutes)}</td>
          <td class="num">${row.totals.late_count}${row.totals.late_minutes ? ` <small>(${row.totals.late_minutes}m)</small>` : ''}</td>
          <td class="num ${row.totals.absent_days ? 'neg' : ''}">${row.totals.absent_days}</td>
          <td class="num"><button class="btn btn-ghost btn-sm" type="button" data-chk-detail="${row.employee.id}"><i class="ph-bold ph-list-magnifying-glass"></i> Detalle</button></td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot><tr>
        <td colspan="3"><b>Totales</b></td>
        <td class="num"><b>${hours(ATTENDANCE.totals.worked_minutes)}</b></td>
        <td class="num">${hours(ATTENDANCE.totals.expected_minutes)}</td>
        <td class="num">${hours(ATTENDANCE.totals.worked_minutes - ATTENDANCE.totals.expected_minutes)}</td>
        <td class="num">${hours(ATTENDANCE.totals.double_overtime_minutes)}</td>
        <td class="num">${hours(ATTENDANCE.totals.triple_overtime_minutes)}</td>
        <td class="num">${ATTENDANCE.totals.late_count}</td>
        <td class="num">${ATTENDANCE.totals.absent_days}</td>
        <td></td>
      </tr></tfoot>
    </table>`;
  }

  function renderDetail(employeeId) {
    const row = ATTENDANCE?.rows.find((item) => Number(item.employee.id) === Number(employeeId));
    if (!row) return;
    $c('#chkDetailName').textContent = row.employee.name;
    $c('#chkDetailCard').hidden = false;

    const buckets = row.buckets.length > 1 ? `
      <h4 class="chk-subhead"><i class="ph-bold ph-chart-bar"></i> Distribución por ${{ day: 'día', week: 'semana', biweek: 'quincena', month: 'mes' }[ATTENDANCE.grouping]}</h4>
      <table class="chk-table chk-table-compact">
        <thead><tr><th>Periodo</th><th class="num">Trabajadas</th><th class="num">Esperadas</th><th class="num">Extra</th><th class="num">Retardos</th><th class="num">Faltas</th></tr></thead>
        <tbody>${row.buckets.map((bucket) => `<tr>
          <td>${esc(bucket.label)}</td>
          <td class="num"><b>${hours(bucket.totals.worked_minutes)}</b></td>
          <td class="num">${hours(bucket.totals.expected_minutes)}</td>
          <td class="num">${hours(bucket.totals.overtime_minutes)}</td>
          <td class="num">${bucket.totals.late_count}</td>
          <td class="num">${bucket.totals.absent_days}</td>
        </tr>`).join('')}</tbody>
      </table>` : '';

    $c('#chkDetailTable').innerHTML = `${buckets}
      <h4 class="chk-subhead"><i class="ph-bold ph-calendar-dots"></i> Día por día</h4>
      <table class="chk-table chk-table-compact">
        <thead><tr><th>Fecha</th><th>Horario</th><th>Entrada</th><th>Salida</th><th class="num">Trabajadas</th><th class="num">Comida</th><th class="num">Extra</th><th>Estado</th></tr></thead>
        <tbody>${row.days.map((day) => {
          const [label, tone] = STATUS_META[day.status] || [day.status, 'rest'];
          return `<tr class="${day.counts_absent ? 'is-absent' : ''}">
            <td><b>${dayLabel(day.date)}</b></td>
            <td>${day.schedule ? `${esc(day.schedule.start)}–${esc(day.schedule.end)}` : '—'}</td>
            <td>${timeLabel(day.first_in)}${day.late_minutes ? ` <span class="chk-tag warn">+${day.late_minutes}m</span>` : ''}</td>
            <td>${day.open_shift ? '<span class="chk-tag warn">Turno abierto</span>' : timeLabel(day.last_out)}</td>
            <td class="num"><b>${hours(day.worked_minutes)}</b></td>
            <td class="num">${hours(day.break_minutes)}</td>
            <td class="num">${hours(day.overtime_minutes)}</td>
            <td><span class="chk-tag ${tone}">${esc(day.incidence ? day.incidence.label : label)}</span></td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    $c('#chkDetailCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ═══════════ Empleados ═══════════ */
  function renderEmployees() {
    const grid = $c('#chkEmployeeGrid');
    if (!EMPLOYEES.length) {
      grid.innerHTML = emptyState('ph-user-plus', 'Todavía no hay empleados', 'Crea el primero con “Nuevo empleado”: define su NIP, su horario y su sueldo.');
      return;
    }
    grid.innerHTML = EMPLOYEES.map((employee) => `
      <article class="chk-emp-card ${employee.active ? '' : 'off'}">
        <div class="chk-emp-head">
          <span class="chk-avatar" style="background:${esc(employee.avatar_color || '#6c47ff')}">${esc(initials(employee.name))}</span>
          <div>
            <b>${esc(employee.name)}</b>
            <small>${esc([employee.emp_code && `No. ${employee.emp_code}`, employee.position, employee.branch_name].filter(Boolean).join(' · ') || 'Sin datos')}</small>
          </div>
          <span class="chk-tag ${employee.active ? (employee.clock_enabled ? 'ok' : 'warn') : 'bad'}">
            ${employee.active ? (employee.clock_enabled ? 'Activo' : 'Sin checador') : 'Baja'}
          </span>
        </div>
        <div class="chk-emp-meta">
          <span><i class="ph-bold ph-calendar-dots"></i> ${esc(employee.schedule_name || 'Sin horario')}</span>
          <span><i class="ph-bold ph-money"></i> ${esc(PAY_TYPE_LABELS[employee.pay_type] || employee.pay_type)} · ${currency(employee.pay_rate)}</span>
          <span class="${employee.has_pin ? 'ok' : 'warn'}"><i class="ph-bold ph-password"></i> ${employee.has_pin ? 'NIP configurado' : 'Sin NIP'}</span>
          <span><i class="ph-bold ph-fingerprint"></i> ${employee.credentials.length} huella(s)</span>
        </div>
        <div class="chk-emp-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-chk-emp-edit="${employee.id}"><i class="ph-bold ph-pencil-simple"></i> Editar</button>
          <button class="btn btn-ghost btn-sm" type="button" data-chk-emp-badge="${employee.id}"><i class="ph-bold ph-qr-code"></i> Gafete</button>
          ${employee.credentials.length ? `<button class="btn btn-ghost btn-sm" type="button" data-chk-emp-creds="${employee.id}"><i class="ph-bold ph-trash"></i> Borrar huellas</button>` : ''}
          ${employee.active ? `<button class="btn btn-danger btn-icon btn-sm" type="button" data-chk-emp-del="${employee.id}" title="Dar de baja"><i class="ph-bold ph-user-minus"></i></button>` : ''}
        </div>
      </article>`).join('');
  }

  /* ═══════════ Nómina ═══════════ */
  function renderPayroll() {
    if (!PAYROLL) return;
    const totals = PAYROLL.totals;
    $c('#chkPayrollTotals').innerHTML = [
      ['#10b981', 'ph-money', currency(totals.gross_pay), 'Percepciones'],
      ['#ef4444', 'ph-minus-circle', currency(totals.deductions), 'Deducciones'],
      ['#6c47ff', 'ph-hand-coins', currency(totals.net_pay), 'Neto a pagar'],
      ['#ec4899', 'ph-arrow-fat-line-up', currency(totals.overtime_pay), 'Tiempo extra'],
      ['#3b82f6', 'ph-hourglass-medium', `${hours(totals.worked_minutes)} h`, 'Horas del periodo'],
    ].map(([color, icon, value, label]) => `
      <div class="chk-kpi">
        <span class="chk-kpi-icon" style="background:${color}1f;color:${color}"><i class="ph-fill ${icon}"></i></span>
        <div><b>${esc(value)}</b><small>${esc(label)}</small></div>
      </div>`).join('');

    $c('#chkPayrollRange').textContent = `${dayLabel(PAYROLL.from)} — ${dayLabel(PAYROLL.to)}`;
    $c('#chkPayrollTable').innerHTML = PAYROLL.items.length
      ? `<table class="chk-table">
          <thead><tr>
            <th>Empleado</th><th>Esquema</th><th class="num">Días</th><th class="num">Horas</th>
            <th class="num">Extra</th><th class="num">Sueldo</th><th class="num">Extra $</th>
            <th class="num">Faltas $</th><th class="num">Retardos $</th><th class="num">Adelantos $</th><th class="num">Neto</th><th></th>
          </tr></thead>
          <tbody>${PAYROLL.items.map((item) => `<tr>
            <td><b>${esc(item.employee_name)}</b><small> ${esc(item.emp_code || '')}</small></td>
            <td>${esc(PAY_TYPE_LABELS[item.pay_type])}<small> · ${currency(item.daily_rate)}/día</small></td>
            <td class="num">${item.worked_days}/${item.scheduled_days}</td>
            <td class="num">${hours(item.worked_minutes)}</td>
            <td class="num">${hours(item.overtime_minutes)}</td>
            <td class="num">${currency(item.base_pay)}</td>
            <td class="num">${currency(item.overtime_pay + item.premium_pay)}</td>
            <td class="num ${item.absence_deduction ? 'neg' : ''}">${currency(item.absence_deduction)}</td>
            <td class="num ${item.late_deduction ? 'neg' : ''}">${currency(item.late_deduction)}</td>
            <td class="num ${item.other_deductions ? 'neg' : ''}">${currency(item.other_deductions)}</td>
            <td class="num"><b>${currency(item.net_pay)}</b></td>
            <td class="num"><button class="btn btn-ghost btn-sm" type="button" data-chk-receipt="${item.employee_id}" title="Recibo en PDF"><i class="ph-bold ph-file-pdf"></i> Recibo</button></td>
          </tr>`).join('')}</tbody>
        </table>`
      : emptyState('ph-money', 'Sin empleados en el periodo', 'Habilita el checador en al menos un empleado para calcular su nómina.');
  }

  /* ═══════════ Recibos de nómina (PDF interno) ═══════════ */
  const RECEIPT_STATUS = { draft: 'Borrador', approved: 'Autorizada', paid: 'Pagada' };

  function receiptFileSlug(text) {
    return String(text || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase() || 'empleado';
  }

  /** Dibuja una hoja carta con el recibo de un empleado. */
  function drawPayrollReceipt(doc, item, ctx) {
    const detail = item.detail || {};
    const pick = (key) => item[key] ?? detail[key];
    const width = doc.internal.pageSize.getWidth();
    const margin = 14;
    const business = ME?.tenant?.businessName || 'Negocio';
    const money = (value) => currency(value);
    const adjustments = item.adjustments || [];
    const earnings = adjustments.filter((adjustment) => adjustment.kind === 'earning');
    const deductions = adjustments.filter((adjustment) => adjustment.kind !== 'earning');
    const calendarDays = pick('calendar_days') ?? (Math.round((new Date(`${ctx.to}T12:00:00`) - new Date(`${ctx.from}T12:00:00`)) / 86400000) + 1);
    const folio = ctx.periodId ? `NOM-${ctx.periodId}-${item.emp_code || detail.emp_code || item.employee_id}` : `PRE-${ctx.from.replace(/-/g, '')}-${item.emp_code || item.employee_id}`;
    const tableBase = { theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8, lineColor: [210, 214, 220], lineWidth: 0.2, textColor: [30, 35, 45] }, margin: { left: margin, right: margin } };
    const labelStyle = { fontStyle: 'bold', fillColor: [243, 244, 246], textColor: [75, 85, 99] };
    const heading = (text, y) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(31, 41, 55); doc.text(text.toUpperCase(), margin, y); };

    // Encabezado
    doc.setFillColor(31, 41, 55);
    doc.rect(0, 0, width, 26, 'F');
    let textX = margin;
    if (ctx.logo) {
      // Logo del negocio sobre una placa blanca, escalado sin deformarse.
      const box = 18;
      const scale = Math.min((box - 2) / ctx.logo.width, (box - 2) / ctx.logo.height);
      const logoW = ctx.logo.width * scale;
      const logoH = ctx.logo.height * scale;
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(margin, 4, box, box, 2, 2, 'F');
      doc.addImage(ctx.logo.data, 'PNG', margin + (box - logoW) / 2, 4 + (box - logoH) / 2, logoW, logoH);
      textX = margin + box + 4;
    }
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
    doc.text(business, textX, 12);
    doc.setFontSize(13);
    doc.text('RECIBO DE NÓMINA', width - margin, 12, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    doc.text('Comprobante interno de pago · sin validez fiscal', textX, 19);
    doc.text(`Folio ${folio}`, width - margin, 19, { align: 'right' });

    doc.autoTable({
      ...tableBase, startY: 31, body: [
        ['Periodo', `${ctx.from} al ${ctx.to} (${calendarDays} días)`, 'Estado', ctx.periodId ? (RECEIPT_STATUS[ctx.status] || ctx.status || '—') : 'Periodo sin guardar'],
        ['Nómina', ctx.periodName || '—', 'Fecha de emisión', new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })],
      ],
      columnStyles: { 0: { ...labelStyle, cellWidth: 28 }, 1: { cellWidth: 70 }, 2: { ...labelStyle, cellWidth: 32 } },
    });

    heading('Datos del empleado', doc.lastAutoTable.finalY + 7);
    const salaryText = item.pay_type === 'hourly' ? `${money(item.pay_rate)} por hora` : `${money(item.pay_rate)} ${(PAY_TYPE_LABELS[item.pay_type] || '').toLowerCase()}`;
    doc.autoTable({
      ...tableBase, startY: doc.lastAutoTable.finalY + 9, body: [
        ['Nombre', item.employee_name, 'No. de empleado', item.emp_code || detail.emp_code || '—'],
        ['Puesto', pick('position') || '—', 'Departamento', pick('department') || '—'],
        ['Sucursal', pick('branch_name') || '—', 'Fecha de ingreso', pick('hire_date') || '—'],
        ['Esquema de pago', PAY_TYPE_LABELS[item.pay_type] || '—', 'Sueldo', salaryText],
        ['Salario diario', money(item.daily_rate), 'Valor por hora', money(item.hourly_rate)],
      ],
      columnStyles: { 0: { ...labelStyle, cellWidth: 28 }, 1: { cellWidth: 70 }, 2: { ...labelStyle, cellWidth: 32 } },
    });

    heading('Asistencia del periodo', doc.lastAutoTable.finalY + 7);
    const scheduled = pick('scheduled_days');
    doc.autoTable({
      ...tableBase, startY: doc.lastAutoTable.finalY + 9, body: [
        ['Días laborados', `${item.worked_days}${scheduled != null ? ` de ${scheduled} programados` : ''}`, 'Faltas', String(item.absent_days)],
        ['Descansos', String(item.rest_days), 'Permisos / incidencias pagadas', String(item.paid_leave_days)],
        ['Horas trabajadas', hours(item.worked_minutes), 'Horas esperadas', hours(item.expected_minutes)],
        ['Tiempo extra', hours(item.overtime_minutes), 'Dobles / triples', `${hours(item.double_overtime_minutes)} / ${hours(item.triple_overtime_minutes)}`],
        ['Retardos', `${item.late_count} (${item.late_minutes} min)`, 'Domingos / festivos trabajados', `${detail.sundays_worked || 0} / ${detail.holidays_worked || 0}`],
      ],
      columnStyles: { 0: { ...labelStyle, cellWidth: 28 }, 1: { cellWidth: 70 }, 2: { ...labelStyle, cellWidth: 48 } },
    });

    // Percepciones y deducciones lado a lado
    const top = doc.lastAutoTable.finalY + 7;
    heading('Percepciones', top);
    doc.text('DEDUCCIONES', margin + 96, top);
    const half = (width - margin * 2 - 4) / 2;
    const perceptions = [['Sueldo base', money(item.base_pay)]];
    if (item.overtime_pay) perceptions.push(['Tiempo extra', money(item.overtime_pay)]);
    if (item.premium_pay) perceptions.push(['Primas (dominical / festivos)', money(item.premium_pay)]);
    earnings.forEach((adjustment) => perceptions.push([adjustment.concept, money(adjustment.amount)]));
    const deductionRows = [];
    if (item.absence_deduction) deductionRows.push(['Descuento por faltas', money(item.absence_deduction)]);
    if (item.late_deduction) deductionRows.push(['Descuento por retardos', money(item.late_deduction)]);
    deductions.forEach((adjustment) => deductionRows.push([adjustment.concept, money(adjustment.amount)]));
    const itemized = deductions.reduce((sum, adjustment) => sum + Number(adjustment.amount || 0), 0);
    if (Number(item.other_deductions) - itemized > 0.005) deductionRows.push(['Otras deducciones', money(Number(item.other_deductions) - itemized)]);
    if (!deductionRows.length) deductionRows.push(['Sin deducciones', money(0)]);
    const totalDeductions = Number(item.absence_deduction) + Number(item.late_deduction) + Number(item.other_deductions);
    const sideOptions = (left) => ({ ...tableBase, startY: top + 2, margin: { left, right: width - left - half }, tableWidth: half, columnStyles: { 1: { halign: 'right', cellWidth: 32 } } });
    doc.autoTable({ ...sideOptions(margin), head: [['Concepto', { content: 'Importe', styles: { halign: 'right' } }]], body: perceptions, foot: [['Total percepciones', { content: money(item.gross_pay), styles: { halign: 'right' } }]], headStyles: { fillColor: [22, 101, 52], textColor: [255, 255, 255] }, footStyles: { fillColor: [220, 252, 231], textColor: [22, 101, 52] } });
    const perceptionsEnd = doc.lastAutoTable.finalY;
    doc.autoTable({ ...sideOptions(margin + half + 4), head: [['Concepto', { content: 'Importe', styles: { halign: 'right' } }]], body: deductionRows, foot: [['Total deducciones', { content: money(totalDeductions), styles: { halign: 'right' } }]], headStyles: { fillColor: [185, 28, 28], textColor: [255, 255, 255] }, footStyles: { fillColor: [254, 226, 226], textColor: [185, 28, 28] } });
    const sectionEnd = Math.max(perceptionsEnd, doc.lastAutoTable.finalY);

    // Neto
    const netTop = sectionEnd + 8;
    doc.setFillColor(31, 41, 55);
    doc.roundedRect(margin, netTop, width - margin * 2, 16, 2, 2, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
    doc.setFontSize(11); doc.text('NETO A PAGAR', margin + 6, netTop + 10);
    doc.setFontSize(16); doc.text(money(item.net_pay), width - margin - 6, netTop + 10.5, { align: 'right' });

    // Conformidad y firmas
    doc.setTextColor(75, 85, 99); doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    const legend = doc.splitTextToSize(`Recibí de ${business} la cantidad indicada como neto a pagar por concepto de sueldo y demás percepciones del periodo señalado, y estoy conforme con los descuentos aplicados, incluidos los adelantos de nómina que se me entregaron.`, width - margin * 2);
    doc.text(legend, margin, netTop + 24);
    const signY = netTop + 24 + legend.length * 4 + 22;
    doc.setDrawColor(120, 125, 135); doc.setLineWidth(0.3);
    doc.line(margin + 8, signY, margin + 78, signY);
    doc.line(width - margin - 78, signY, width - margin - 8, signY);
    doc.setFontSize(8.5);
    doc.text(item.employee_name, margin + 43, signY + 5, { align: 'center' });
    doc.text('Firma del empleado', margin + 43, signY + 9.5, { align: 'center' });
    doc.text('Autorizó', width - margin - 43, signY + 5, { align: 'center' });
    doc.text('Recursos humanos / dueño', width - margin - 43, signY + 9.5, { align: 'center' });

    doc.setFontSize(7); doc.setTextColor(150, 155, 165);
    doc.text('Documento interno de control. No es un CFDI ni tiene validez fiscal.', width / 2, doc.internal.pageSize.getHeight() - 8, { align: 'center' });
  }

  let RECEIPT_LOGO = null; // { url, data, width, height } | { url, data: null }

  /**
   * Logo configurado del negocio como PNG reducido para el PDF.
   * Solo se lee del mismo origen de la aplicación; si falla, el recibo sale sin logo.
   */
  async function loadReceiptLogo() {
    const raw = String((typeof SETTINGS !== 'undefined' && SETTINGS?.logo) || ME?.tenant?.logo || '').trim();
    if (!raw) return null;
    let url;
    try { url = new URL(raw, location.origin); } catch { return null; }
    if (url.origin !== location.origin) return null;
    if (RECEIPT_LOGO?.url === url.href) return RECEIPT_LOGO.data ? RECEIPT_LOGO : null;
    RECEIPT_LOGO = { url: url.href, data: null };
    try {
      const response = await fetch(url.href, { credentials: 'same-origin' });
      if (!response.ok || !String(response.headers.get('content-type') || '').startsWith('image/')) return null;
      const bitmap = await createImageBitmap(await response.blob());
      const scale = Math.min(1, 300 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      RECEIPT_LOGO = { url: url.href, data: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
      return RECEIPT_LOGO;
    } catch { return null; }
  }

  /** Genera un PDF con un recibo por hoja y lo descarga. */
  function downloadPayrollReceipts(items, ctx, fileName) {
    const jsPDF = globalThis.jspdf?.jsPDF;
    if (!jsPDF) { toast('El generador de PDF no está disponible', true); return; }
    if (!items.length) { toast('No hay recibos para imprimir', true); return; }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
    items.forEach((item, index) => {
      if (index) doc.addPage();
      drawPayrollReceipt(doc, item, ctx);
    });
    doc.save(fileName);
  }

  function receiptContext(source) {
    if (source === 'period') {
      const { period, items } = OPEN_PERIOD;
      return { from: period.start_date, to: period.end_date, periodId: period.id, periodName: period.name, status: period.status, items };
    }
    return { from: PAYROLL.from, to: PAYROLL.to, periodId: null, periodName: `Nómina ${PAYROLL.from} al ${PAYROLL.to}`, status: '', items: PAYROLL.items };
  }

  /** Recibo de un empleado (`employeeId`) o de todos, del periodo guardado (`period`) o del calculado (`preview`). */
  async function printReceipts(source, employeeId) {
    if (source === 'period' ? !OPEN_PERIOD : !PAYROLL) return;
    const ctx = { ...receiptContext(source), logo: await loadReceiptLogo() };
    const items = employeeId ? ctx.items.filter((item) => Number(item.employee_id) === Number(employeeId)) : ctx.items;
    const name = employeeId && items[0] ? `recibo_nomina_${receiptFileSlug(items[0].employee_name)}` : 'recibos_nomina';
    downloadPayrollReceipts(items, ctx, `${name}_${ctx.from}_${ctx.to}.pdf`);
  }

  function renderAdvances() {
    $c('#chkPayrollAdvances').innerHTML = ADVANCES.length
      ? `<table class="chk-table">
          <thead><tr><th>Fecha</th><th>Empleado</th><th>Sucursal</th><th>Origen</th><th class="num">Monto</th><th>Estado</th></tr></thead>
          <tbody>${ADVANCES.map((advance) => `<tr>
            <td>${dayLabel(advance.advance_date)}</td>
            <td><b>${esc(advance.employee_name)}</b>${advance.note ? `<small> ${esc(advance.note)}</small>` : ''}</td>
            <td>${esc(advance.branch_name || '—')}</td>
            <td>${advance.source === 'pos' ? 'Caja POS' : 'Gasto manual'}</td>
            <td class="num"><b>${currency(advance.amount)}</b></td>
            <td>${advance.period_id
              ? `<span class="chk-tag ok">Descontado · ${esc(advance.period_name || '')}</span>`
              : '<span class="chk-tag warn">Pendiente de descontar</span>'}</td>
          </tr>`).join('')}</tbody>
        </table>`
      : emptyState('ph-hand-coins', 'Sin adelantos de nómina', 'Registra un gasto de categoría NOMINA en caja o en Gastos y elige al empleado: aparecerá aquí y se descontará en su nómina.');
  }

  function renderPeriods() {
    $c('#chkPayrollPeriods').innerHTML = PERIODS.length
      ? `<table class="chk-table">
          <thead><tr><th>Periodo</th><th>Rango</th><th class="num">Empleados</th><th class="num">Percepciones</th><th class="num">Deducciones</th><th class="num">Neto</th><th>Estado</th><th></th></tr></thead>
          <tbody>${PERIODS.map((period) => {
            const tone = period.status === 'paid' ? 'ok' : period.status === 'approved' ? 'info' : 'warn';
            const label = { draft: 'Borrador', approved: 'Autorizada', paid: 'Pagada' }[period.status] || period.status;
            return `<tr>
              <td><b>${esc(period.name)}</b><small> ${esc(period.branch_name || 'Todas las sucursales')}</small></td>
              <td>${dayLabel(period.start_date)} — ${dayLabel(period.end_date)}</td>
              <td class="num">${period.employees_count}</td>
              <td class="num">${currency(period.total_gross)}</td>
              <td class="num">${currency(period.total_deductions)}</td>
              <td class="num"><b>${currency(period.total_net)}</b></td>
              <td><span class="chk-tag ${tone}">${esc(label)}</span></td>
              <td class="num chk-row-actions">
                <button class="btn btn-ghost btn-sm" type="button" data-chk-period="${period.id}"><i class="ph-bold ph-eye"></i> Ver</button>
                ${period.status !== 'paid' ? `<button class="btn btn-danger btn-icon btn-sm" type="button" data-chk-period-del="${period.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>` : ''}
              </td>
            </tr>`;
          }).join('')}</tbody>
        </table>`
      : emptyState('ph-archive', 'Aún no guardas ningún periodo', 'Calcula la nómina y pulsa “Guardar periodo” para conservarla y autorizarla.');
  }

  async function openPeriod(periodId) {
    OPEN_PERIOD = await api(`/api/checador/payroll/periods/${periodId}`);
    renderPeriodDetail();
    openModal('chkPayrollModal');
  }

  function renderPeriodDetail() {
    const { period, items } = OPEN_PERIOD;
    const label = { draft: 'Borrador', approved: 'Autorizada', paid: 'Pagada' }[period.status] || period.status;
    $c('#chkPayrollModalTitle').innerHTML = `<i class="ph-bold ph-receipt"></i> ${esc(period.name)}`;
    $c('#chkPayrollDetail').innerHTML = `
      <div class="chk-period-head">
        <span class="chk-tag ${period.status === 'paid' ? 'ok' : period.status === 'approved' ? 'info' : 'warn'}">${esc(label)}</span>
        <span>${dayLabel(period.start_date)} — ${dayLabel(period.end_date)}</span>
        <span>Neto: <b>${currency(period.total_net)}</b></span>
        <div class="chk-period-actions">
          ${period.status === 'draft' ? '<button class="btn btn-primary btn-sm" type="button" data-chk-period-status="approved"><i class="ph-bold ph-check"></i> Autorizar</button>' : ''}
          ${period.status === 'approved' ? '<button class="btn btn-primary btn-sm" type="button" data-chk-period-status="paid"><i class="ph-bold ph-hand-coins"></i> Marcar pagada</button>' : ''}
          ${period.status === 'paid' ? '' : '<button class="btn btn-ghost btn-sm" type="button" data-chk-period-status="draft"><i class="ph-bold ph-arrow-counter-clockwise"></i> Volver a borrador</button>'}
        </div>
      </div>
      <div class="table-wrap">
        <table class="chk-table chk-table-compact">
          <thead><tr><th>Empleado</th><th class="num">Horas</th><th class="num">Extra</th><th class="num">Sueldo</th><th class="num">Percepciones</th><th class="num">Deducciones</th><th class="num">Neto</th><th></th></tr></thead>
          <tbody>${items.map((item) => `
            <tr>
              <td><b>${esc(item.employee_name)}</b><small> ${esc(PAY_TYPE_LABELS[item.pay_type] || '')}</small></td>
              <td class="num">${hours(item.worked_minutes)}</td>
              <td class="num">${hours(item.overtime_minutes)}</td>
              <td class="num">${currency(item.base_pay)}</td>
              <td class="num">${currency(item.overtime_pay + item.premium_pay + item.other_earnings)}</td>
              <td class="num ${(item.absence_deduction + item.late_deduction + item.other_deductions) ? 'neg' : ''}">${currency(item.absence_deduction + item.late_deduction + item.other_deductions)}</td>
              <td class="num"><b>${currency(item.net_pay)}</b></td>
              <td class="num chk-row-actions"><button class="btn btn-ghost btn-sm" type="button" data-chk-receipt="${item.employee_id}" title="Recibo en PDF"><i class="ph-bold ph-file-pdf"></i></button>${period.status === 'paid' ? '' : `<button class="btn btn-ghost btn-sm" type="button" data-chk-adjust="${item.employee_id}" data-name="${esc(item.employee_name)}" title="Agregar percepción o deducción"><i class="ph-bold ph-plus-minus"></i></button>`}</td>
            </tr>
            ${item.adjustments.length ? `<tr class="chk-adjust-row"><td colspan="8">${item.adjustments.map((adjustment) => `
              <span class="chk-adjust ${adjustment.kind === 'earning' ? 'pos' : 'neg'}">
                ${adjustment.kind === 'earning' ? '+' : '−'} ${esc(adjustment.concept)}: ${currency(adjustment.amount)}
                ${period.status === 'paid' ? '' : `<button type="button" data-chk-adjust-del="${adjustment.id}" title="Quitar"><i class="ph-bold ph-x"></i></button>`}
              </span>`).join('')}</td></tr>` : ''}
          `).join('')}</tbody>
        </table>
      </div>`;
  }

  /* ═══════════ Configuración ═══════════ */
  function renderDevices() {
    const grid = $c('#chkDeviceGrid');
    const devices = BASE?.devices || [];
    grid.innerHTML = devices.length
      ? devices.map((device) => `
        <article class="chk-device-card ${device.active ? '' : 'off'}">
          <div class="chk-device-head">
            <span class="chk-device-icon"><i class="ph-bold ph-clock-user"></i></span>
            <div><b>${esc(device.name)}</b><small>${esc(device.branch_name || 'Todas las sucursales')}</small></div>
            <span class="chk-tag ${device.active ? 'ok' : 'bad'}">${device.active ? 'Activa' : 'Pausada'}</span>
          </div>
          <div class="chk-device-chips">
            ${device.methods.map((method) => `<span class="chk-chip">${esc(METHOD_LABELS[method] || method)}</span>`).join('')}
            ${device.require_photo ? '<span class="chk-chip"><i class="ph-bold ph-camera"></i> Foto</span>' : ''}
            ${device.require_geo ? `<span class="chk-chip"><i class="ph-bold ph-map-pin-area"></i> ${device.geo_radius_m} m</span>` : ''}
            ${device.lock_to_branch ? '<span class="chk-chip"><i class="ph-bold ph-lock-key"></i> Sólo su sucursal</span>' : ''}
          </div>
          <div class="chk-device-link"><code>${esc(deviceLink(device))}</code></div>
          <small class="chk-device-last">${device.last_used_at ? `Último uso: ${dateTimeLabel(device.last_used_at)}` : 'Sin uso todavía'}</small>
          <div class="chk-device-actions">
            <a class="btn btn-primary btn-sm" href="${esc(deviceLink(device))}" target="_blank" rel="noopener"><i class="ph-bold ph-arrow-square-out"></i> Abrir</a>
            <button class="btn btn-ghost btn-sm" type="button" data-chk-dev-link="${device.id}"><i class="ph-bold ph-qr-code"></i> Liga y QR</button>
            <button class="btn btn-ghost btn-sm" type="button" data-chk-dev-edit="${device.id}"><i class="ph-bold ph-gear"></i> Configurar</button>
            <button class="btn btn-danger btn-icon btn-sm" type="button" data-chk-dev-del="${device.id}" title="Eliminar"><i class="ph-bold ph-trash"></i></button>
          </div>
        </article>`).join('')
      : emptyState('ph-device-tablet', 'Crea tu primera liga', 'Con “Nueva liga” generas la dirección que abrirás en la tableta o celular que funcionará como reloj checador.');
  }

  function renderSchedules() {
    const list = $c('#chkScheduleList');
    const schedules = BASE?.schedules || [];
    list.innerHTML = schedules.length
      ? schedules.map((schedule) => {
        const workDays = WEEKDAYS.filter(([weekday]) => schedule.days[weekday] && !schedule.days[weekday].is_rest);
        const sample = workDays[0] ? schedule.days[workDays[0][0]] : null;
        const assigned = EMPLOYEES.filter((employee) => Number(employee.schedule_id) === Number(schedule.id)).length;
        return `<div class="chk-schedule-row" style="--chk-sch:${esc(schedule.color || '#6c47ff')}">
          <div>
            <b>${esc(schedule.name)}</b>
            <small>${workDays.length} día(s) laborables${sample ? ` · ${esc(sample.start_time)}–${esc(sample.end_time)}` : ''} · ${assigned} empleado(s)</small>
          </div>
          <div class="chk-row-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-chk-sch-edit="${schedule.id}"><i class="ph-bold ph-pencil-simple"></i></button>
            <button class="btn btn-danger btn-icon btn-sm" type="button" data-chk-sch-del="${schedule.id}"><i class="ph-bold ph-trash"></i></button>
          </div>
        </div>`;
      }).join('')
      : emptyState('ph-calendar-dots', 'Sin horarios', 'Define al menos un horario para poder medir retardos, faltas y tiempo extra.');
  }

  function renderIncidences() {
    $c('#chkIncidenceTable').innerHTML = INCIDENCES.length
      ? `<table class="chk-table chk-table-compact">
          <thead><tr><th>Empleado</th><th>Tipo</th><th>Rango</th><th class="num">Pago</th><th></th></tr></thead>
          <tbody>${INCIDENCES.map((incidence) => {
            const meta = (BASE?.incidence_types || []).find((type) => type.key === incidence.incidence_type);
            return `<tr>
              <td>${esc(incidence.employee_name || 'Todo el personal')}</td>
              <td>${esc(meta?.label || incidence.incidence_type)}</td>
              <td>${dayLabel(incidence.date_from)} — ${dayLabel(incidence.date_to)}</td>
              <td class="num">${Math.round(Number(incidence.pay_factor) * 100)}%</td>
              <td class="num"><button class="btn btn-danger btn-icon btn-sm" type="button" data-chk-inc-del="${incidence.id}"><i class="ph-bold ph-trash"></i></button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>`
      : emptyState('ph-first-aid-kit', 'Sin incidencias este mes', 'Registra vacaciones, permisos, incapacidades o días festivos para que la nómina los considere.');
  }

  function renderRules() {
    const config = BASE?.config || {};
    $c('#chkStdDaily').value = config.standard_daily_hours;
    $c('#chkStdWeekly').value = config.standard_weekly_hours;
    $c('#chkLateTolerance').value = config.late_tolerance_min;
    $c('#chkEarlyTolerance').value = config.early_leave_tolerance_min;
    $c('#chkOvertimeMode').value = config.overtime_mode;
    $c('#chkOvertimeMultiplier').value = config.overtime_multiplier;
    $c('#chkOvertimeGrace').value = config.overtime_daily_grace_min;
    $c('#chkOvertimeMax').value = config.overtime_max_daily_min;
    $c('#chkLateMode').value = config.late_mode;
    $c('#chkLateAmount').value = config.late_amount;
    $c('#chkAbsenceExtra').value = config.absence_extra_days;
    $c('#chkAutoClose').value = config.auto_close_hours;
    $c('#chkMinGap').value = config.min_punch_gap_min;
    $c('#chkRound').value = String(config.round_minutes);
    $c('#chkSundayPct').value = config.sunday_premium_pct;
    $c('#chkHolidayMultiplier').value = config.holiday_multiplier;
    $c('#chkAbsenceDeduction').checked = Boolean(config.absence_deduction);
    $c('#chkSundayPremium').checked = Boolean(config.sunday_premium);
    $c('#chkRestOvertime').checked = Boolean(config.rest_day_counts_as_overtime);
    $c('#chkOpenShiftPay').checked = Boolean(config.allow_open_shift_pay);
    syncRuleVisibility();
  }

  function syncRuleVisibility() {
    $c('#chkOvertimeMultiplierField').hidden = $c('#chkOvertimeMode').value !== 'flat';
    $c('#chkLateAmountField').hidden = !['per_minute', 'per_incident'].includes($c('#chkLateMode').value);
  }

  async function saveRules() {
    const payload = {
      standard_daily_hours: Number($c('#chkStdDaily').value),
      standard_weekly_hours: Number($c('#chkStdWeekly').value),
      late_tolerance_min: Number($c('#chkLateTolerance').value),
      early_leave_tolerance_min: Number($c('#chkEarlyTolerance').value),
      overtime_mode: $c('#chkOvertimeMode').value,
      overtime_multiplier: Number($c('#chkOvertimeMultiplier').value),
      overtime_daily_grace_min: Number($c('#chkOvertimeGrace').value),
      overtime_max_daily_min: Number($c('#chkOvertimeMax').value),
      late_mode: $c('#chkLateMode').value,
      late_amount: Number($c('#chkLateAmount').value),
      absence_extra_days: Number($c('#chkAbsenceExtra').value),
      auto_close_hours: Number($c('#chkAutoClose').value),
      min_punch_gap_min: Number($c('#chkMinGap').value),
      round_minutes: Number($c('#chkRound').value),
      sunday_premium_pct: Number($c('#chkSundayPct').value),
      holiday_multiplier: Number($c('#chkHolidayMultiplier').value),
      absence_deduction: $c('#chkAbsenceDeduction').checked ? 1 : 0,
      sunday_premium: $c('#chkSundayPremium').checked ? 1 : 0,
      rest_day_counts_as_overtime: $c('#chkRestOvertime').checked ? 1 : 0,
      allow_open_shift_pay: $c('#chkOpenShiftPay').checked ? 1 : 0,
    };
    const result = await api('/api/checador/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    BASE.config = result.config;
    renderRules();
    toast('Reglas de cálculo guardadas');
  }

  /* ═══════════ Modales: dispositivos ═══════════ */
  function openDeviceModal(device = null) {
    $c('#chkDeviceModalTitle').innerHTML = device
      ? '<i class="ph-bold ph-gear"></i> Configurar liga'
      : '<i class="ph-bold ph-device-tablet"></i> Nueva liga de checador';
    $c('#chkDeviceId').value = device?.id || '';
    $c('#chkDeviceName').value = device?.name || '';
    $c('#chkDeviceBranch').innerHTML = branchOptions(device?.branch_id || '', 'Todas / sin sucursal');
    const methods = device?.methods || ['pin'];
    $$c('#chkDeviceModal .chk-method-picker input').forEach((input) => {
      input.checked = methods.includes(input.value);
    });
    $c('#chkDeviceLock').checked = device ? device.lock_to_branch : true;
    $c('#chkDevicePhoto').checked = Boolean(device?.require_photo);
    $c('#chkDeviceGeo').checked = Boolean(device?.require_geo);
    $c('#chkDeviceLat').value = device?.geo_lat ?? '';
    $c('#chkDeviceLng').value = device?.geo_lng ?? '';
    $c('#chkDeviceRadius').value = device?.geo_radius_m || 150;
    $c('#chkDeviceActive').checked = device ? device.active : true;
    $c('#chkDeviceGeoFields').hidden = !$c('#chkDeviceGeo').checked;
    openModal('chkDeviceModal');
    setTimeout(() => $c('#chkDeviceName').focus(), 60);
  }

  function openLinkModal(device) {
    LINK_DEVICE = device;
    const url = deviceLink(device);
    const endpoint = `${url.replace('/checador/', '/api/checador/kiosk/')}/device-punch`;
    $c('#chkLinkUrl').value = url;
    $c('#chkLinkQr').src = qrImage(url, 220);
    $c('#chkApiEndpoint').value = endpoint;
    $c('#chkApiKey').value = device.api_key;
    $c('#chkApiSample').textContent = `curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -H "x-checador-key: ${device.api_key}" \\
  -d '{"employee_ref":"0001","type":"in"}'`;
    openModal('chkLinkModal');
  }

  /* ═══════════ Modales: horarios ═══════════ */
  function renderScheduleDraft() {
    $c('#chkScheduleDays').innerHTML = WEEKDAYS.map(([weekday, name]) => {
      const day = SCHEDULE_DRAFT.find((item) => item.weekday === weekday)
        || { weekday, is_rest: 1, start_time: '09:00', end_time: '18:00', break_minutes: 0 };
      return `<div class="chk-week-row ${day.is_rest ? 'is-rest' : ''}" data-weekday="${weekday}">
        <label class="chk-week-day"><input type="checkbox" data-field="work" ${day.is_rest ? '' : 'checked'} /><span>${name}</span></label>
        <input type="time" data-field="start" value="${esc(day.start_time)}" ${day.is_rest ? 'disabled' : ''} />
        <input type="time" data-field="end" value="${esc(day.end_time)}" ${day.is_rest ? 'disabled' : ''} />
        <input type="number" data-field="break" min="0" max="480" step="5" value="${Number(day.break_minutes) || 0}" ${day.is_rest ? 'disabled' : ''} />
      </div>`;
    }).join('');
  }

  function collectScheduleDraft() {
    return $$c('#chkScheduleDays .chk-week-row').map((row) => ({
      weekday: Number(row.dataset.weekday),
      is_rest: row.querySelector('[data-field="work"]').checked ? 0 : 1,
      start_time: row.querySelector('[data-field="start"]').value || '09:00',
      end_time: row.querySelector('[data-field="end"]').value || '18:00',
      break_minutes: Number(row.querySelector('[data-field="break"]').value) || 0,
    }));
  }

  function openScheduleModal(schedule = null) {
    $c('#chkScheduleModalTitle').innerHTML = schedule
      ? '<i class="ph-bold ph-pencil-simple"></i> Editar horario'
      : '<i class="ph-bold ph-calendar-dots"></i> Nuevo horario';
    $c('#chkScheduleId').value = schedule?.id || '';
    $c('#chkScheduleName').value = schedule?.name || '';
    $c('#chkScheduleNotes').value = schedule?.notes || '';
    $c('#chkScheduleBranch').innerHTML = branchOptions(schedule?.branch_id || '', 'Todas / sin sucursal');
    SCHEDULE_DRAFT = schedule
      ? Object.values(schedule.days).map((day) => ({ ...day, is_rest: day.is_rest ? 1 : 0 }))
      : WEEKDAYS.map(([weekday]) => ({
        weekday,
        is_rest: weekday === 0 ? 1 : 0,
        start_time: '09:00',
        end_time: weekday === 6 ? '14:00' : '18:00',
        break_minutes: weekday === 6 ? 0 : 60,
      }));
    renderScheduleDraft();
    openModal('chkScheduleModal');
    setTimeout(() => $c('#chkScheduleName').focus(), 60);
  }

  /* ═══════════ Modales: empleados ═══════════ */
  function syncRateHint() {
    const labels = {
      monthly: 'Se divide entre 30 días para obtener el salario diario.',
      biweekly: 'Se divide entre 15 días para obtener el salario diario.',
      weekly: 'Se divide entre 7 días para obtener el salario diario.',
      daily: 'Importe por cada día efectivamente laborado.',
      hourly: 'Importe por cada hora ordinaria registrada.',
    };
    $c('#chkEmpRateHint').textContent = labels[$c('#chkEmpPayType').value] || '';
  }

  function openEmployeeModal(employee = null) {
    $c('#chkEmployeeModalTitle').innerHTML = employee
      ? '<i class="ph-bold ph-pencil-simple"></i> Editar empleado'
      : '<i class="ph-bold ph-user-plus"></i> Nuevo empleado';
    $c('#chkEmployeeId').value = employee?.id || '';
    $c('#chkEmpName').value = employee?.name || '';
    $c('#chkEmpCodeInput').value = employee?.emp_code || '';
    $c('#chkEmpPosition').value = employee?.position || '';
    $c('#chkEmpBranch').innerHTML = branchOptions(employee?.branch_id || '', 'Selecciona una sucursal');
    $c('#chkEmpSchedule').innerHTML = scheduleOptions(employee?.schedule_id || '');
    $c('#chkEmpHireDate').value = employee?.hire_date ? String(employee.hire_date).slice(0, 10) : '';
    $c('#chkEmpPayType').value = employee?.pay_type || 'monthly';
    $c('#chkEmpPayRate').value = employee?.pay_rate || '';
    $c('#chkEmpPhone').value = employee?.phone || '';
    $c('#chkEmpEmail').value = employee?.email || '';
    $c('#chkEmpPin').value = '';
    $c('#chkEmpPinHint').textContent = employee?.has_pin
      ? 'Ya tiene NIP. Escribe uno nuevo sólo si quieres reemplazarlo.'
      : 'El empleado usará este NIP junto con su número para checar.';
    $c('#chkEmpClockEnabled').checked = employee ? employee.clock_enabled : true;
    $c('#chkEmpActive').checked = employee ? employee.active : true;
    syncRateHint();
    openModal('chkEmployeeModal');
    setTimeout(() => $c('#chkEmpName').focus(), 60);
  }

  function badgeMarkup(employee) {
    return `<div class="badge">
      <img src="${qrImage(`CBP:${employee.qr_token}`, 200)}" alt="" />
      <b>${esc(employee.name)}</b>
      <small>No. ${esc(employee.emp_code || '—')} · ${esc(employee.branch_name || '')}</small>
      <small>${esc(ME?.tenant?.businessName || '')}</small>
    </div>`;
  }

  function openBadgeModal(employee) {
    BADGE_EMPLOYEE = employee;
    $c('#chkBadgeBody').innerHTML = `
      <img src="${qrImage(`CBP:${employee.qr_token}`, 220)}" alt="Código QR del empleado" />
      <b>${esc(employee.name)}</b>
      <small>No. ${esc(employee.emp_code || '—')}${employee.branch_name ? ` · ${esc(employee.branch_name)}` : ''}</small>
      <p class="hint">Imprime este gafete o guárdalo en el celular del empleado. Cualquier lector de códigos conectado al checador también lo reconoce.</p>`;
    openModal('chkBadgeModal');
  }

  /* ═══════════ Pestañas ═══════════ */
  async function openTab(name) {
    TAB = name;
    $$c('#chkTabs button').forEach((button) => button.classList.toggle('on', button.dataset.chkTab === name));
    $c('#chkPanelBoard').hidden = name !== 'board';
    $c('#chkPanelAttendance').hidden = name !== 'attendance';
    $c('#chkPanelEmployees').hidden = name !== 'employees';
    $c('#chkPanelPayroll').hidden = name !== 'payroll';
    $c('#chkPanelConfig').hidden = name !== 'config';

    try {
      if (name === 'board') await loadBoard();
      if (name === 'attendance' && !ATTENDANCE) await loadAttendance();
      if (name === 'employees') renderEmployees();
      if (name === 'payroll') {
        if (!PAYROLL) await loadPayroll();
        await loadPeriods();
      }
      if (name === 'config') {
        renderDevices();
        renderSchedules();
        renderRules();
        await loadIncidences();
      }
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function refreshCurrentTab() {
    await loadBase();
    if (TAB === 'attendance') await loadAttendance();
    else if (TAB === 'payroll') { await loadPayroll(); await loadPeriods(); }
    else await openTab(TAB);
    toast('Información actualizada');
  }

  /* ═══════════ Punto de entrada ═══════════ */
  async function loadChecador() {
    try {
      await loadBase();
      if (!BOOTED) {
        BOOTED = true;
        const today = BASE.today;
        $c('#chkPunchDate').value = today;
        $c('#chkIncidenceFrom').value = today;
        $c('#chkIncidenceTo').value = today;
        $c('#chkIncidenceType').innerHTML = (BASE.incidence_types || [])
          .map((type) => `<option value="${esc(type.key)}" data-factor="${type.payFactor}">${esc(type.label)}</option>`).join('');
        $c('#chkIncidenceFactor').value = BASE.incidence_types?.[0]?.payFactor ?? 0;
      }
      await openTab(TAB);
    } catch (error) {
      toast(error.message || 'No se pudo cargar el reloj checador', true);
    }
  }

  /* ═══════════ Eventos ═══════════ */
  const guard = (handler) => async (...args) => {
    try { await handler(...args); } catch (error) { toast(error.message, true); }
  };

  $c('#chkTabs')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-chk-tab]');
    if (button) openTab(button.dataset.chkTab);
  });
  $c('#chkRefreshBtn')?.addEventListener('click', guard(refreshCurrentTab));

  /* — Asistencia — */
  $c('#chkPresets')?.addEventListener('click', guard(async (event) => {
    const button = event.target.closest('button[data-preset]');
    if (!button) return;
    $$c('#chkPresets button').forEach((item) => item.classList.toggle('on', item === button));
    RANGE.preset = button.dataset.preset;
    if (RANGE.preset !== 'custom') await loadAttendance();
  }));
  $c('#chkApplyBtn')?.addEventListener('click', guard(async () => {
    RANGE.from = $c('#chkFrom').value;
    RANGE.to = $c('#chkTo').value;
    if (RANGE.from && RANGE.to) {
      RANGE.preset = 'custom';
      $$c('#chkPresets button').forEach((item) => item.classList.toggle('on', item.dataset.preset === 'custom'));
    }
    await loadAttendance();
  }));
  $c('#chkGroup')?.addEventListener('change', guard(loadAttendance));
  $c('#chkAttendanceTable')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chk-detail]');
    if (button) renderDetail(button.dataset.chkDetail);
  });
  $c('#chkDetailClose')?.addEventListener('click', () => { $c('#chkDetailCard').hidden = true; });
  $c('#chkExportBtn')?.addEventListener('click', () => {
    if (!ATTENDANCE) return;
    exportSheet(ATTENDANCE.rows.map((row) => ({
      Empleado: row.employee.name,
      Numero: row.employee.emp_code,
      Sucursal: row.employee.branch_name,
      Horario: row.employee.schedule_name,
      'Dias laborados': row.totals.worked_days,
      'Dias programados': row.totals.scheduled_days,
      'Horas trabajadas': hours(row.totals.worked_minutes),
      'Horas esperadas': hours(row.totals.expected_minutes),
      'Tiempo extra 2x': hours(row.totals.double_overtime_minutes),
      'Tiempo extra 3x': hours(row.totals.triple_overtime_minutes),
      Retardos: row.totals.late_count,
      'Minutos de retardo': row.totals.late_minutes,
      Faltas: row.totals.absent_days,
    })), 'Asistencia', `asistencia_${ATTENDANCE.from}_${ATTENDANCE.to}.xlsx`);
  });

  /* — Empleados — */
  $c('#chkAddEmployeeBtn')?.addEventListener('click', () => {
    if (!BASE?.branches?.length) { toast('Primero crea una sucursal en Mi negocio', true); return; }
    openEmployeeModal();
  });
  $c('#chkEmpPayType')?.addEventListener('change', syncRateHint);
  $c('#chkEmployeeCancel')?.addEventListener('click', () => closeModal('chkEmployeeModal'));
  $c('#chkEmployeeForm')?.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const id = $c('#chkEmployeeId').value;
    const payload = {
      name: $c('#chkEmpName').value,
      emp_code: $c('#chkEmpCodeInput').value,
      position: $c('#chkEmpPosition').value,
      branch_id: $c('#chkEmpBranch').value,
      schedule_id: $c('#chkEmpSchedule').value,
      hire_date: $c('#chkEmpHireDate').value,
      pay_type: $c('#chkEmpPayType').value,
      pay_rate: $c('#chkEmpPayRate').value,
      phone: $c('#chkEmpPhone').value,
      email: $c('#chkEmpEmail').value,
      clock_enabled: $c('#chkEmpClockEnabled').checked,
      active: $c('#chkEmpActive').checked,
    };
    const pin = $c('#chkEmpPin').value.trim();
    if (id) {
      await api(`/api/checador/employees/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (pin) {
        await api(`/api/checador/employees/${id}/pin`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
        });
      }
    } else {
      await api('/api/checador/employees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, pin }),
      });
    }
    closeModal('chkEmployeeModal');
    toast(id ? 'Empleado actualizado' : 'Empleado creado');
    await loadBase();
    renderEmployees();
  }));

  $c('#chkEmployeeGrid')?.addEventListener('click', guard(async (event) => {
    const edit = event.target.closest('[data-chk-emp-edit]');
    if (edit) { openEmployeeModal(EMPLOYEES.find((item) => String(item.id) === edit.dataset.chkEmpEdit)); return; }

    const badge = event.target.closest('[data-chk-emp-badge]');
    if (badge) { openBadgeModal(EMPLOYEES.find((item) => String(item.id) === badge.dataset.chkEmpBadge)); return; }

    const creds = event.target.closest('[data-chk-emp-creds]');
    if (creds) {
      const employee = EMPLOYEES.find((item) => String(item.id) === creds.dataset.chkEmpCreds);
      const ok = await askConfirm('¿Borrar las huellas registradas?', `${employee.name} tendrá que volver a registrar su huella en cada dispositivo.`, { yesLabel: '<i class="ph-bold ph-trash"></i> Sí, borrar' });
      if (!ok) return;
      for (const credential of employee.credentials) {
        await api(`/api/checador/credentials/${credential.id}`, { method: 'DELETE' });
      }
      toast('Huellas eliminadas');
      await loadBase();
      renderEmployees();
      return;
    }

    const remove = event.target.closest('[data-chk-emp-del]');
    if (remove) {
      const employee = EMPLOYEES.find((item) => String(item.id) === remove.dataset.chkEmpDel);
      const ok = await askConfirm('¿Dar de baja al empleado?', `${employee.name} dejará de aparecer en el checador, pero su historial se conserva.`, { yesLabel: '<i class="ph-bold ph-user-minus"></i> Sí, dar de baja' });
      if (!ok) return;
      await api(`/api/checador/employees/${employee.id}`, { method: 'DELETE' });
      toast('Empleado dado de baja');
      await loadBase();
      renderEmployees();
    }
  }));

  $c('#chkBadgeRotate')?.addEventListener('click', guard(async () => {
    const ok = await askConfirm('¿Renovar el código del gafete?', 'El gafete impreso anterior dejará de funcionar.', { yesLabel: '<i class="ph-bold ph-arrows-clockwise"></i> Sí, renovar' });
    if (!ok) return;
    const result = await api(`/api/checador/employees/${BADGE_EMPLOYEE.id}/qr/rotate`, { method: 'POST' });
    BADGE_EMPLOYEE.qr_token = result.qr_token;
    await loadBase();
    openBadgeModal(EMPLOYEES.find((item) => Number(item.id) === Number(BADGE_EMPLOYEE.id)));
    toast('Código renovado');
  }));
  $c('#chkBadgePrint')?.addEventListener('click', () => {
    printDocument(`Gafete ${BADGE_EMPLOYEE.name}`, `<div class="badge-grid">${badgeMarkup(BADGE_EMPLOYEE)}</div>`);
  });
  $c('#chkPrintBadgesBtn')?.addEventListener('click', () => {
    const active = EMPLOYEES.filter((employee) => employee.active && employee.clock_enabled);
    if (!active.length) { toast('No hay empleados activos', true); return; }
    printDocument('Gafetes del checador', `<h1>Gafetes del reloj checador</h1>
      <p class="meta">${esc(ME?.tenant?.businessName || '')} · ${active.length} empleado(s)</p>
      <div class="badge-grid">${active.map(badgeMarkup).join('')}</div>`);
  });

  /* — Nómina — */
  $c('#chkPayrollPresets')?.addEventListener('click', guard(async (event) => {
    const button = event.target.closest('button[data-preset]');
    if (!button) return;
    $$c('#chkPayrollPresets button').forEach((item) => item.classList.toggle('on', item === button));
    PAY_RANGE.preset = button.dataset.preset;
    if (PAY_RANGE.preset !== 'custom') await loadPayroll();
  }));
  $c('#chkPayPreviewBtn')?.addEventListener('click', guard(async () => {
    PAY_RANGE.from = $c('#chkPayFrom').value;
    PAY_RANGE.to = $c('#chkPayTo').value;
    if (PAY_RANGE.from && PAY_RANGE.to) {
      PAY_RANGE.preset = 'custom';
      $$c('#chkPayrollPresets button').forEach((item) => item.classList.toggle('on', item.dataset.preset === 'custom'));
    }
    await loadPayroll();
  }));
  $c('#chkPaySaveBtn')?.addEventListener('click', guard(async () => {
    if (!PAYROLL) { toast('Calcula la nómina antes de guardarla', true); return; }
    const ok = await askConfirm(
      'Guardar periodo de nómina',
      `Se guardarán ${PAYROLL.items.length} recibo(s) del ${PAYROLL.from} al ${PAYROLL.to} por ${currency(PAYROLL.totals.net_pay)}.`,
      { yesLabel: '<i class="ph-bold ph-floppy-disk"></i> Guardar' }
    );
    if (!ok) return;
    await api('/api/checador/payroll/periods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Nómina ${dayLabel(PAYROLL.from)} — ${dayLabel(PAYROLL.to)}`,
        period_type: PAY_RANGE.preset === 'custom' ? 'custom' : (PAY_RANGE.preset.includes('biweek') ? 'biweekly' : PAY_RANGE.preset === 'week' ? 'weekly' : 'monthly'),
        start_date: PAYROLL.from,
        end_date: PAYROLL.to,
        branch_id: $c('#chkPayBranch').value || null,
      }),
    });
    toast('Periodo de nómina guardado');
    await loadPeriods();
  }));
  $c('#chkPayExportBtn')?.addEventListener('click', () => {
    if (!PAYROLL) return;
    exportSheet(PAYROLL.items.map((item) => ({
      Empleado: item.employee_name,
      Numero: item.emp_code,
      Esquema: PAY_TYPE_LABELS[item.pay_type],
      'Salario diario': item.daily_rate,
      'Dias laborados': item.worked_days,
      Faltas: item.absent_days,
      'Horas trabajadas': hours(item.worked_minutes),
      'Tiempo extra': hours(item.overtime_minutes),
      Sueldo: item.base_pay,
      'Tiempo extra $': item.overtime_pay,
      Primas: item.premium_pay,
      'Descuento faltas': item.absence_deduction,
      'Descuento retardos': item.late_deduction,
      'Otras deducciones': item.other_deductions,
      Percepciones: item.gross_pay,
      Neto: item.net_pay,
    })), 'Nomina', `nomina_${PAYROLL.from}_${PAYROLL.to}.xlsx`);
  });

  $c('#chkPayrollPeriods')?.addEventListener('click', guard(async (event) => {
    const open = event.target.closest('[data-chk-period]');
    if (open) { await openPeriod(open.dataset.chkPeriod); return; }
    const remove = event.target.closest('[data-chk-period-del]');
    if (remove) {
      const ok = await askConfirm('¿Eliminar el periodo?', 'Se borrarán sus recibos y los movimientos capturados.', { yesLabel: '<i class="ph-bold ph-trash"></i> Sí, eliminar' });
      if (!ok) return;
      await api(`/api/checador/payroll/periods/${remove.dataset.chkPeriodDel}`, { method: 'DELETE' });
      toast('Periodo eliminado');
      await loadPeriods();
    }
  }));

  $c('#chkPayrollDetail')?.addEventListener('click', guard(async (event) => {
    const status = event.target.closest('[data-chk-period-status]');
    if (status) {
      await api(`/api/checador/payroll/periods/${OPEN_PERIOD.period.id}/status`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status.dataset.chkPeriodStatus }),
      });
      toast('Estado actualizado');
      await openPeriod(OPEN_PERIOD.period.id);
      await loadPeriods();
      return;
    }
    const adjust = event.target.closest('[data-chk-adjust]');
    if (adjust) {
      $c('#chkAdjustPeriodId').value = OPEN_PERIOD.period.id;
      $c('#chkAdjustEmployeeId').value = adjust.dataset.chkAdjust;
      $c('#chkAdjustWho').textContent = `${adjust.dataset.name} · ${OPEN_PERIOD.period.name}`;
      $c('#chkAdjustConcept').value = '';
      $c('#chkAdjustAmount').value = '';
      $c('#chkAdjustNotes').value = '';
      openModal('chkAdjustModal');
      return;
    }
    const remove = event.target.closest('[data-chk-adjust-del]');
    if (remove) {
      await api(`/api/checador/payroll/adjustments/${remove.dataset.chkAdjustDel}`, { method: 'DELETE' });
      toast('Movimiento eliminado');
      await openPeriod(OPEN_PERIOD.period.id);
      await loadPeriods();
    }
  }));

  const receipts = (source, employeeId) => printReceipts(source, employeeId).catch((error) => toast(error.message || 'No se pudo generar el recibo', true));
  $c('#chkPayReceiptsBtn')?.addEventListener('click', () => receipts('preview'));
  $c('#chkPayrollTable')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chk-receipt]');
    if (button) receipts('preview', button.dataset.chkReceipt);
  });
  $c('#chkPayrollReceipts')?.addEventListener('click', () => receipts('period'));
  $c('#chkPayrollDetail')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-chk-receipt]');
    if (button) receipts('period', button.dataset.chkReceipt);
  });
  $c('#chkPayrollDetailClose')?.addEventListener('click', () => closeModal('chkPayrollModal'));
  $c('#chkPayrollPrint')?.addEventListener('click', () => {
    if (!OPEN_PERIOD) return;
    const { period, items } = OPEN_PERIOD;
    printDocument(period.name, `<h1>${esc(period.name)}</h1>
      <p class="meta">${esc(ME?.tenant?.businessName || '')} · ${dayLabel(period.start_date)} al ${dayLabel(period.end_date)} · Neto ${currency(period.total_net)}</p>
      <table><thead><tr><th>Empleado</th><th class="num">Días</th><th class="num">Horas</th><th class="num">Extra</th><th class="num">Sueldo</th><th class="num">Percepciones</th><th class="num">Deducciones</th><th class="num">Neto</th></tr></thead>
      <tbody>${items.map((item) => `<tr>
        <td>${esc(item.employee_name)}</td>
        <td class="num">${item.worked_days}</td>
        <td class="num">${hours(item.worked_minutes)}</td>
        <td class="num">${hours(item.overtime_minutes)}</td>
        <td class="num">${currency(item.base_pay)}</td>
        <td class="num">${currency(item.overtime_pay + item.premium_pay + item.other_earnings)}</td>
        <td class="num">${currency(item.absence_deduction + item.late_deduction + item.other_deductions)}</td>
        <td class="num"><b>${currency(item.net_pay)}</b></td>
      </tr>`).join('')}</tbody></table>`);
  });

  $c('#chkAdjustCancel')?.addEventListener('click', () => closeModal('chkAdjustModal'));
  $c('#chkAdjustForm')?.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    await api(`/api/checador/payroll/periods/${$c('#chkAdjustPeriodId').value}/adjustments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: $c('#chkAdjustEmployeeId').value,
        kind: $c('#chkAdjustKind').value,
        concept: $c('#chkAdjustConcept').value,
        amount: $c('#chkAdjustAmount').value,
        notes: $c('#chkAdjustNotes').value,
      }),
    });
    closeModal('chkAdjustModal');
    toast('Movimiento agregado');
    await openPeriod(OPEN_PERIOD.period.id);
    await loadPeriods();
  }));

  /* — Dispositivos — */
  $c('#chkAddDeviceBtn')?.addEventListener('click', () => openDeviceModal());
  $c('#chkDeviceCancel')?.addEventListener('click', () => closeModal('chkDeviceModal'));
  $c('#chkDeviceGeo')?.addEventListener('change', (event) => {
    $c('#chkDeviceGeoFields').hidden = !event.target.checked;
  });
  $c('#chkDeviceGeoHere')?.addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Tu navegador no comparte la ubicación', true); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        $c('#chkDeviceLat').value = position.coords.latitude.toFixed(6);
        $c('#chkDeviceLng').value = position.coords.longitude.toFixed(6);
        toast('Ubicación capturada');
      },
      () => toast('No se pudo obtener tu ubicación', true),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
  $c('#chkDeviceForm')?.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const methods = $$c('#chkDeviceModal .chk-method-picker input:checked').map((input) => input.value);
    if (!methods.length) { toast('Elige al menos un método de identificación', true); return; }
    const id = $c('#chkDeviceId').value;
    const payload = {
      name: $c('#chkDeviceName').value,
      branch_id: $c('#chkDeviceBranch').value,
      methods,
      require_photo: $c('#chkDevicePhoto').checked,
      require_geo: $c('#chkDeviceGeo').checked,
      geo_lat: $c('#chkDeviceLat').value,
      geo_lng: $c('#chkDeviceLng').value,
      geo_radius_m: $c('#chkDeviceRadius').value,
      lock_to_branch: $c('#chkDeviceLock').checked,
      active: $c('#chkDeviceActive').checked,
    };
    const result = id
      ? await api(`/api/checador/devices/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : await api('/api/checador/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closeModal('chkDeviceModal');
    await loadBase();
    renderDevices();
    toast(id ? 'Liga actualizada' : 'Liga del checador creada');
    if (!id) openLinkModal(BASE.devices.find((device) => Number(device.id) === Number(result.id)));
  }));

  $c('#chkDeviceGrid')?.addEventListener('click', guard(async (event) => {
    const link = event.target.closest('[data-chk-dev-link]');
    if (link) { openLinkModal(BASE.devices.find((device) => String(device.id) === link.dataset.chkDevLink)); return; }

    const edit = event.target.closest('[data-chk-dev-edit]');
    if (edit) { openDeviceModal(BASE.devices.find((device) => String(device.id) === edit.dataset.chkDevEdit)); return; }

    const remove = event.target.closest('[data-chk-dev-del]');
    if (remove) {
      const device = BASE.devices.find((item) => String(item.id) === remove.dataset.chkDevDel);
      const ok = await askConfirm('¿Eliminar la liga?', `El checador «${device.name}» dejará de funcionar de inmediato.`, { yesLabel: '<i class="ph-bold ph-trash"></i> Sí, eliminar' });
      if (!ok) return;
      await api(`/api/checador/devices/${device.id}`, { method: 'DELETE' });
      toast('Liga eliminada');
      await loadBase();
      renderDevices();
    }
  }));

  $c('#chkLinkCopy')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($c('#chkLinkUrl').value);
      toast('Liga copiada');
    } catch { toast('No se pudo copiar la liga', true); }
  });
  $c('#chkLinkClose')?.addEventListener('click', () => closeModal('chkLinkModal'));
  $c('#chkLinkRotate')?.addEventListener('click', guard(async () => {
    const ok = await askConfirm('¿Renovar la liga?', 'La dirección y la API key anteriores dejarán de funcionar.', { yesLabel: '<i class="ph-bold ph-arrows-clockwise"></i> Sí, renovar' });
    if (!ok) return;
    await api(`/api/checador/devices/${LINK_DEVICE.id}/rotate-token`, { method: 'POST' });
    await loadBase();
    renderDevices();
    openLinkModal(BASE.devices.find((device) => Number(device.id) === Number(LINK_DEVICE.id)));
    toast('Liga renovada');
  }));

  /* — Horarios — */
  $c('#chkAddScheduleBtn')?.addEventListener('click', () => openScheduleModal());
  $c('#chkScheduleCancel')?.addEventListener('click', () => closeModal('chkScheduleModal'));
  $c('#chkScheduleDays')?.addEventListener('change', (event) => {
    const input = event.target.closest('[data-field="work"]');
    if (!input) return;
    const row = input.closest('.chk-week-row');
    row.classList.toggle('is-rest', !input.checked);
    row.querySelectorAll('input[type="time"], input[type="number"]').forEach((field) => { field.disabled = !input.checked; });
  });
  $c('#chkScheduleForm')?.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    const id = $c('#chkScheduleId').value;
    const payload = {
      name: $c('#chkScheduleName').value,
      branch_id: $c('#chkScheduleBranch').value,
      notes: $c('#chkScheduleNotes').value,
      days: collectScheduleDraft(),
    };
    if (id) {
      await api(`/api/checador/schedules/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } else {
      await api('/api/checador/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    closeModal('chkScheduleModal');
    toast(id ? 'Horario actualizado' : 'Horario creado');
    await loadBase();
    renderSchedules();
  }));
  $c('#chkScheduleList')?.addEventListener('click', guard(async (event) => {
    const edit = event.target.closest('[data-chk-sch-edit]');
    if (edit) { openScheduleModal(BASE.schedules.find((schedule) => String(schedule.id) === edit.dataset.chkSchEdit)); return; }
    const remove = event.target.closest('[data-chk-sch-del]');
    if (remove) {
      const schedule = BASE.schedules.find((item) => String(item.id) === remove.dataset.chkSchDel);
      const ok = await askConfirm('¿Eliminar el horario?', `Los empleados con «${schedule.name}» quedarán sin horario asignado.`, { yesLabel: '<i class="ph-bold ph-trash"></i> Sí, eliminar' });
      if (!ok) return;
      await api(`/api/checador/schedules/${schedule.id}`, { method: 'DELETE' });
      toast('Horario eliminado');
      await loadBase();
      renderSchedules();
    }
  }));

  /* — Incidencias — */
  $c('#chkAddIncidenceBtn')?.addEventListener('click', () => {
    $c('#chkIncidenceEmployee').innerHTML = employeeOptions('', 'Todo el personal');
    openModal('chkIncidenceModal');
  });
  $c('#chkIncidenceCancel')?.addEventListener('click', () => closeModal('chkIncidenceModal'));
  $c('#chkIncidenceType')?.addEventListener('change', (event) => {
    const option = event.target.selectedOptions[0];
    $c('#chkIncidenceFactor').value = option?.dataset.factor ?? 0;
  });
  $c('#chkIncidenceForm')?.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    await api('/api/checador/incidences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: $c('#chkIncidenceEmployee').value || null,
        incidence_type: $c('#chkIncidenceType').value,
        date_from: $c('#chkIncidenceFrom').value,
        date_to: $c('#chkIncidenceTo').value,
        pay_factor: $c('#chkIncidenceFactor').value,
        notes: $c('#chkIncidenceNotes').value,
      }),
    });
    closeModal('chkIncidenceModal');
    toast('Incidencia registrada');
    await loadIncidences();
    ATTENDANCE = null;
  }));
  $c('#chkIncidenceTable')?.addEventListener('click', guard(async (event) => {
    const remove = event.target.closest('[data-chk-inc-del]');
    if (!remove) return;
    const ok = await askConfirm('¿Eliminar la incidencia?', 'La asistencia y la nómina se recalcularán sin ella.', { yesLabel: '<i class="ph-bold ph-trash"></i> Sí, eliminar' });
    if (!ok) return;
    await api(`/api/checador/incidences/${remove.dataset.chkIncDel}`, { method: 'DELETE' });
    toast('Incidencia eliminada');
    await loadIncidences();
    ATTENDANCE = null;
  }));

  /* — Checadas manuales — */
  $c('#chkAddPunchBtn')?.addEventListener('click', () => {
    $c('#chkPunchEmployee').innerHTML = employeeOptions('', 'Selecciona un empleado');
    $c('#chkPunchDate').value = BASE?.today || '';
    $c('#chkPunchTime').value = '';
    $c('#chkPunchNotes').value = '';
    openModal('chkPunchModal');
  });
  $c('#chkPunchCancel')?.addEventListener('click', () => closeModal('chkPunchModal'));
  $c('#chkPunchForm')?.addEventListener('submit', guard(async (event) => {
    event.preventDefault();
    await api('/api/checador/punches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_id: $c('#chkPunchEmployee').value,
        type: $c('#chkPunchType').value,
        date: $c('#chkPunchDate').value,
        time: $c('#chkPunchTime').value,
        notes: $c('#chkPunchNotes').value,
      }),
    });
    closeModal('chkPunchModal');
    toast('Checada registrada');
    ATTENDANCE = null;
    await loadBoard();
  }));

  /* — Reglas — */
  $c('#chkOvertimeMode')?.addEventListener('change', syncRuleVisibility);
  $c('#chkLateMode')?.addEventListener('change', syncRuleVisibility);
  $c('#chkSaveRulesBtn')?.addEventListener('click', guard(saveRules));
  $c('#chkRulesForm')?.addEventListener('submit', (event) => event.preventDefault());

  // Cerrar modales del módulo al tocar el fondo.
  [
    'chkDeviceModal', 'chkLinkModal', 'chkScheduleModal', 'chkEmployeeModal',
    'chkBadgeModal', 'chkPunchModal', 'chkIncidenceModal', 'chkPayrollModal', 'chkAdjustModal',
  ].forEach((id) => {
    $c(`#${id}`)?.addEventListener('click', (event) => {
      if (event.target.id === id) closeModal(id);
    });
  });

  window.loadChecador = loadChecador;
})();
