/**
 * Núcleo de cálculo del reloj checador.
 *
 * Todo el módulo razona con dos magnitudes distintas y nunca las mezcla:
 *  - duraciones: diferencia de epoch (segundos) entre checadas, exacta y
 *    ajena a husos horarios o cambios de horario de verano;
 *  - comparaciones contra el horario (entradas tarde, salidas antes):
 *    minutos transcurridos desde la medianoche local, que Postgres ya
 *    entrega convertidos a la zona horaria del negocio.
 *
 * Así no hace falta convertir husos horarios en JavaScript.
 */

const PUNCH_TYPES = ['in', 'out', 'break_start', 'break_end'];
const PUNCH_METHODS = ['pin', 'qr', 'biometric', 'photo', 'device', 'manual'];
const PAY_TYPES = ['monthly', 'biweekly', 'weekly', 'daily', 'hourly'];
const GROUPINGS = ['day', 'week', 'biweek', 'month'];

const INCIDENCE_TYPES = Object.freeze({
  falta: { label: 'Falta injustificada', payFactor: 0, countsAbsent: true },
  permiso_sin_goce: { label: 'Permiso sin goce', payFactor: 0, countsAbsent: false },
  permiso_con_goce: { label: 'Permiso con goce', payFactor: 1, countsAbsent: false },
  vacaciones: { label: 'Vacaciones', payFactor: 1, countsAbsent: false },
  incapacidad: { label: 'Incapacidad', payFactor: 0.6, countsAbsent: false },
  descanso: { label: 'Descanso otorgado', payFactor: 0, countsAbsent: false },
  festivo: { label: 'Día festivo', payFactor: 1, countsAbsent: false },
  suspension: { label: 'Suspensión', payFactor: 0, countsAbsent: false },
});

const DEFAULT_CONFIG = Object.freeze({
  standard_daily_hours: 8,
  standard_weekly_hours: 48,
  week_starts_on: 1,                 // 0 domingo … 6 sábado
  late_tolerance_min: 10,
  early_leave_tolerance_min: 10,
  overtime_mode: 'mx_lft',           // mx_lft | flat | none
  overtime_multiplier: 2,            // solo para overtime_mode = flat
  overtime_double_weekly_hours: 9,   // LFT: las primeras 9 h extra semanales van al doble
  overtime_daily_grace_min: 15,      // minutos de cortesía antes de contar tiempo extra
  overtime_max_daily_min: 240,
  rest_day_counts_as_overtime: 1,
  late_mode: 'none',                 // none | per_minute | per_incident | per_day_each_three
  late_amount: 0,
  absence_deduction: 1,              // descontar los días no laborados al personal asalariado
  absence_extra_days: 0,             // días adicionales castigados por cada falta
  sunday_premium: 0,
  sunday_premium_pct: 25,
  holiday_multiplier: 2,
  auto_close_hours: 14,              // cierra turnos olvidados tras N horas
  min_punch_gap_min: 1,              // evita dobles checadas accidentales
  round_minutes: 0,                  // redondeo de la jornada (0 = sin redondeo)
  default_payroll_period: 'biweekly',
  allow_open_shift_pay: 0,           // pagar turnos sin salida registrada
});

/* ─────────────────────────────────────────────
   Helpers básicos
───────────────────────────────────────────── */
const clampNumber = (value, min, max, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

function normalizePunchType(value) {
  const type = String(value || '').trim().toLowerCase();
  return PUNCH_TYPES.includes(type) ? type : 'in';
}

function normalizePunchMethod(value) {
  const method = String(value || '').trim().toLowerCase();
  return PUNCH_METHODS.includes(method) ? method : 'pin';
}

function normalizePayType(value) {
  const type = String(value || '').trim().toLowerCase();
  return PAY_TYPES.includes(type) ? type : 'monthly';
}

function normalizeGrouping(value) {
  const group = String(value || '').trim().toLowerCase();
  return GROUPINGS.includes(group) ? group : 'day';
}

/** 'HH:MM' → minutos desde medianoche. Devuelve null si no es una hora válida. */
function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const total = ((Math.round(Number(minutes) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/** Fechas de negocio: siempre se manipulan como texto YYYY-MM-DD en UTC puro. */
function dateToUtc(dateStr) {
  const [year, month, day] = String(dateStr).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function utcToDate(ms) {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dateStr, days) {
  return utcToDate(dateToUtc(dateStr) + days * 86400000);
}

function weekdayOf(dateStr) {
  return new Date(dateToUtc(dateStr)).getUTCDay();
}

function daysBetween(fromDate, toDate) {
  return Math.round((dateToUtc(toDate) - dateToUtc(fromDate)) / 86400000);
}

/** Lista inclusiva de fechas entre dos extremos; tope duro para no explotar en memoria. */
function dateRange(fromDate, toDate, maxDays = 400) {
  const out = [];
  const span = daysBetween(fromDate, toDate);
  if (span < 0) return out;
  for (let i = 0; i <= Math.min(span, maxDays - 1); i++) out.push(addDays(fromDate, i));
  return out;
}

/* ─────────────────────────────────────────────
   Configuración del módulo
───────────────────────────────────────────── */
function normalizeConfig(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
  }
  if (!parsed || typeof parsed !== 'object') parsed = {};

  const overtimeMode = ['mx_lft', 'flat', 'none'].includes(parsed.overtime_mode) ? parsed.overtime_mode : DEFAULT_CONFIG.overtime_mode;
  const lateMode = ['none', 'per_minute', 'per_incident', 'per_day_each_three'].includes(parsed.late_mode)
    ? parsed.late_mode
    : DEFAULT_CONFIG.late_mode;

  return {
    standard_daily_hours: clampNumber(parsed.standard_daily_hours, 1, 24, DEFAULT_CONFIG.standard_daily_hours),
    standard_weekly_hours: clampNumber(parsed.standard_weekly_hours, 1, 168, DEFAULT_CONFIG.standard_weekly_hours),
    week_starts_on: clampNumber(parsed.week_starts_on, 0, 6, DEFAULT_CONFIG.week_starts_on),
    late_tolerance_min: clampNumber(parsed.late_tolerance_min, 0, 240, DEFAULT_CONFIG.late_tolerance_min),
    early_leave_tolerance_min: clampNumber(parsed.early_leave_tolerance_min, 0, 240, DEFAULT_CONFIG.early_leave_tolerance_min),
    overtime_mode: overtimeMode,
    overtime_multiplier: clampNumber(parsed.overtime_multiplier, 1, 5, DEFAULT_CONFIG.overtime_multiplier),
    overtime_double_weekly_hours: clampNumber(parsed.overtime_double_weekly_hours, 0, 40, DEFAULT_CONFIG.overtime_double_weekly_hours),
    overtime_daily_grace_min: clampNumber(parsed.overtime_daily_grace_min, 0, 240, DEFAULT_CONFIG.overtime_daily_grace_min),
    overtime_max_daily_min: clampNumber(parsed.overtime_max_daily_min, 0, 1440, DEFAULT_CONFIG.overtime_max_daily_min),
    rest_day_counts_as_overtime: parsed.rest_day_counts_as_overtime ? 1 : 0,
    late_mode: lateMode,
    late_amount: clampNumber(parsed.late_amount, 0, 1000000, DEFAULT_CONFIG.late_amount),
    absence_deduction: parsed.absence_deduction === 0 || parsed.absence_deduction === false ? 0 : 1,
    absence_extra_days: clampNumber(parsed.absence_extra_days, 0, 5, DEFAULT_CONFIG.absence_extra_days),
    sunday_premium: parsed.sunday_premium ? 1 : 0,
    sunday_premium_pct: clampNumber(parsed.sunday_premium_pct, 0, 100, DEFAULT_CONFIG.sunday_premium_pct),
    holiday_multiplier: clampNumber(parsed.holiday_multiplier, 1, 5, DEFAULT_CONFIG.holiday_multiplier),
    auto_close_hours: clampNumber(parsed.auto_close_hours, 1, 48, DEFAULT_CONFIG.auto_close_hours),
    min_punch_gap_min: clampNumber(parsed.min_punch_gap_min, 0, 120, DEFAULT_CONFIG.min_punch_gap_min),
    round_minutes: [0, 5, 10, 15, 30].includes(Number(parsed.round_minutes)) ? Number(parsed.round_minutes) : 0,
    default_payroll_period: ['weekly', 'biweekly', 'monthly'].includes(parsed.default_payroll_period)
      ? parsed.default_payroll_period
      : DEFAULT_CONFIG.default_payroll_period,
    allow_open_shift_pay: parsed.allow_open_shift_pay ? 1 : 0,
  };
}

/* ─────────────────────────────────────────────
   Tarifas
───────────────────────────────────────────── */
/**
 * Convierte el sueldo contratado a tarifa diaria y por hora.
 * Convención mexicana: el sueldo mensual se divide entre 30 días.
 */
function payRates(employee, config) {
  const payType = normalizePayType(employee?.pay_type);
  const rate = Math.max(0, Number(employee?.pay_rate) || 0);
  const dailyHours = config.standard_daily_hours || 8;

  let dailyRate = 0;
  let hourlyRate = 0;
  switch (payType) {
    case 'hourly':
      hourlyRate = rate;
      dailyRate = rate * dailyHours;
      break;
    case 'daily':
      dailyRate = rate;
      hourlyRate = rate / dailyHours;
      break;
    case 'weekly':
      dailyRate = rate / 7;
      hourlyRate = dailyRate / dailyHours;
      break;
    case 'biweekly':
      dailyRate = rate / 15;
      hourlyRate = dailyRate / dailyHours;
      break;
    case 'monthly':
    default:
      dailyRate = rate / 30;
      hourlyRate = dailyRate / dailyHours;
      break;
  }
  return { payType, rate, dailyRate: round2(dailyRate), hourlyRate: round2(hourlyRate), isSalaried: ['monthly', 'biweekly', 'weekly'].includes(payType) };
}

/* ─────────────────────────────────────────────
   Horarios
───────────────────────────────────────────── */
/**
 * Minutos esperados de un día de horario.
 * Un turno que termina antes de la hora de entrada se interpreta nocturno
 * (cruza la medianoche) y suma 24 h.
 */
function scheduledMinutes(day) {
  if (!day || day.is_rest) return 0;
  const start = timeToMinutes(day.start_time);
  const end = timeToMinutes(day.end_time);
  if (start === null || end === null) return 0;
  const span = end > start ? end - start : end + 1440 - start;
  return Math.max(0, span - Math.max(0, Number(day.break_minutes) || 0));
}

function scheduleDayFor(scheduleMap, scheduleId, dateStr) {
  const schedule = scheduleMap.get(positiveInt(scheduleId));
  if (!schedule) return null;
  return schedule.days[weekdayOf(dateStr)] || null;
}

/* ─────────────────────────────────────────────
   Jornada: emparejado de checadas
───────────────────────────────────────────── */
/**
 * Convierte la secuencia cronológica de checadas de un día en minutos
 * trabajados y de descanso. Tolera secuencias incompletas (salida sin
 * entrada, turnos sin cerrar) porque en campo siempre ocurren.
 *
 * `punches` deben venir ordenadas ascendentemente y traer `epoch` (segundos).
 */
function buildDaySessions(punches, config, nowEpoch = Math.floor(Date.now() / 1000)) {
  const sessions = [];
  const autoCloseSeconds = config.auto_close_hours * 3600;
  let workedSeconds = 0;
  let breakSeconds = 0;
  let openIn = null;
  let openBreak = null;
  let openShift = false;
  let missingOut = false;

  for (const punch of punches) {
    if (punch.status && punch.status !== 'valid') continue;
    const epoch = Number(punch.epoch);
    if (!Number.isFinite(epoch)) continue;

    switch (normalizePunchType(punch.punch_type)) {
      case 'in':
        // Dos entradas seguidas: la segunda abre un turno nuevo y la primera
        // queda sin salida, así que se cierra con el tope de auto-cierre.
        if (openIn !== null) {
          const capped = Math.min(epoch, openIn + autoCloseSeconds);
          workedSeconds += Math.max(0, capped - openIn);
          sessions.push({ in: openIn, out: capped, auto_closed: true });
          missingOut = true;
        }
        openIn = epoch;
        break;
      case 'out':
        if (openIn !== null) {
          workedSeconds += Math.max(0, epoch - openIn);
          sessions.push({ in: openIn, out: epoch, auto_closed: false });
          openIn = null;
        }
        if (openBreak !== null) {
          breakSeconds += Math.max(0, epoch - openBreak);
          openBreak = null;
        }
        break;
      case 'break_start':
        if (openIn !== null) {
          workedSeconds += Math.max(0, epoch - openIn);
          sessions.push({ in: openIn, out: epoch, auto_closed: false });
          openIn = null;
        }
        if (openBreak === null) openBreak = epoch;
        break;
      case 'break_end':
        if (openBreak !== null) {
          breakSeconds += Math.max(0, epoch - openBreak);
          openBreak = null;
        }
        if (openIn === null) openIn = epoch;
        break;
      default:
        break;
    }
  }

  if (openIn !== null) {
    openShift = true;
    const limit = Math.min(nowEpoch, openIn + autoCloseSeconds);
    if (limit > openIn && config.allow_open_shift_pay) {
      workedSeconds += limit - openIn;
      sessions.push({ in: openIn, out: limit, auto_closed: true });
    } else {
      sessions.push({ in: openIn, out: null, auto_closed: false });
      missingOut = true;
    }
  }
  if (openBreak !== null) {
    const limit = Math.min(nowEpoch, openBreak + autoCloseSeconds);
    breakSeconds += Math.max(0, limit - openBreak);
  }

  let workedMinutes = Math.round(workedSeconds / 60);
  if (config.round_minutes > 0) {
    workedMinutes = Math.round(workedMinutes / config.round_minutes) * config.round_minutes;
  }

  return {
    sessions,
    worked_minutes: workedMinutes,
    break_minutes: Math.round(breakSeconds / 60),
    open_shift: openShift,
    missing_out: missingOut,
  };
}

/* ─────────────────────────────────────────────
   Resumen diario
───────────────────────────────────────────── */
/**
 * Estado del día: trabajado, falta, descanso, incidencia o sin horario.
 * Devuelve siempre la misma forma para que el front renderice sin ramificar.
 */
function summarizeDay({ date, punches = [], scheduleDay = null, incidence = null, config, nowEpoch }) {
  const sessionData = buildDaySessions(punches, config, nowEpoch);
  const expectedMinutes = scheduledMinutes(scheduleDay);
  const isRest = !scheduleDay || Boolean(scheduleDay.is_rest);
  const validPunches = punches.filter((punch) => !punch.status || punch.status === 'valid');
  const firstIn = validPunches.find((punch) => normalizePunchType(punch.punch_type) === 'in') || null;
  const lastOut = [...validPunches].reverse().find((punch) => normalizePunchType(punch.punch_type) === 'out') || null;

  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  if (!isRest && scheduleDay) {
    const startMinutes = timeToMinutes(scheduleDay.start_time);
    const endMinutes = timeToMinutes(scheduleDay.end_time);
    if (startMinutes !== null && firstIn && Number.isFinite(Number(firstIn.local_minutes))) {
      const delta = Number(firstIn.local_minutes) - startMinutes;
      // Una entrada muy anterior a la hora pactada no es retardo negativo.
      if (delta > config.late_tolerance_min) lateMinutes = Math.round(delta);
    }
    if (endMinutes !== null && lastOut && Number.isFinite(Number(lastOut.local_minutes)) && !sessionData.open_shift) {
      // En turnos nocturnos la salida cae en el día siguiente: no es salida anticipada.
      const crossesMidnight = startMinutes !== null && endMinutes <= startMinutes;
      if (!crossesMidnight) {
        const delta = endMinutes - Number(lastOut.local_minutes);
        if (delta > config.early_leave_tolerance_min) earlyLeaveMinutes = Math.round(delta);
      }
    }
  }

  // Tiempo extra diario: lo que excede la jornada pactada más la cortesía.
  let overtimeMinutes = 0;
  if (config.overtime_mode !== 'none') {
    if (expectedMinutes > 0) {
      const excess = sessionData.worked_minutes - expectedMinutes - config.overtime_daily_grace_min;
      if (excess > 0) overtimeMinutes = excess;
    } else if (isRest && config.rest_day_counts_as_overtime && sessionData.worked_minutes > 0) {
      overtimeMinutes = sessionData.worked_minutes;
    }
    if (config.overtime_max_daily_min > 0) overtimeMinutes = Math.min(overtimeMinutes, config.overtime_max_daily_min);
  }

  const incidenceType = incidence ? String(incidence.incidence_type || 'falta') : '';
  const incidenceMeta = INCIDENCE_TYPES[incidenceType] || null;
  const payFactor = incidence
    ? clampNumber(incidence.pay_factor, 0, 2, incidenceMeta?.payFactor ?? 0)
    : 0;

  let status = 'sin_horario';
  if (sessionData.worked_minutes > 0) status = 'trabajado';
  else if (incidence) status = incidenceType;
  else if (isRest) status = 'descanso';
  else if (expectedMinutes > 0) status = 'falta';

  return {
    date,
    weekday: weekdayOf(date),
    is_rest: isRest,
    expected_minutes: expectedMinutes,
    worked_minutes: sessionData.worked_minutes,
    break_minutes: sessionData.break_minutes,
    overtime_minutes: overtimeMinutes,
    regular_minutes: Math.max(0, sessionData.worked_minutes - overtimeMinutes),
    late_minutes: lateMinutes,
    early_leave_minutes: earlyLeaveMinutes,
    balance_minutes: sessionData.worked_minutes - expectedMinutes,
    first_in: firstIn ? firstIn.punched_at : null,
    first_in_minutes: firstIn ? Number(firstIn.local_minutes) : null,
    last_out: lastOut ? lastOut.punched_at : null,
    last_out_minutes: lastOut ? Number(lastOut.local_minutes) : null,
    open_shift: sessionData.open_shift,
    missing_out: sessionData.missing_out,
    punch_count: validPunches.length,
    schedule: scheduleDay ? { start: scheduleDay.start_time, end: scheduleDay.end_time, break_minutes: Number(scheduleDay.break_minutes) || 0 } : null,
    incidence: incidence
      ? { id: incidence.id, type: incidenceType, label: incidenceMeta?.label || incidenceType, pay_factor: payFactor, notes: incidence.notes || '' }
      : null,
    counts_absent: Boolean(!isRest && expectedMinutes > 0 && sessionData.worked_minutes === 0 && (!incidence || incidenceMeta?.countsAbsent)),
    status,
  };
}

/* ─────────────────────────────────────────────
   Tiempo extra semanal (LFT: 9 h al doble, el resto al triple)
───────────────────────────────────────────── */
function weekKeyFor(dateStr, weekStartsOn) {
  const weekday = weekdayOf(dateStr);
  const offset = (weekday - weekStartsOn + 7) % 7;
  return addDays(dateStr, -offset);
}

/**
 * Reparte el tiempo extra de cada día entre tarifa doble y triple según el
 * acumulado de su semana. En modo `flat` todo se paga al mismo múltiplo.
 */
function splitOvertime(days, config) {
  const doubleCapMinutes = config.overtime_double_weekly_hours * 60;
  const weeklyUsed = new Map();
  let doubleMinutes = 0;
  let tripleMinutes = 0;

  for (const day of days) {
    if (!day.overtime_minutes) {
      day.double_overtime_minutes = 0;
      day.triple_overtime_minutes = 0;
      continue;
    }
    if (config.overtime_mode === 'flat') {
      day.double_overtime_minutes = day.overtime_minutes;
      day.triple_overtime_minutes = 0;
      doubleMinutes += day.overtime_minutes;
      continue;
    }
    const key = weekKeyFor(day.date, config.week_starts_on);
    const used = weeklyUsed.get(key) || 0;
    const atDouble = Math.max(0, Math.min(day.overtime_minutes, doubleCapMinutes - used));
    const atTriple = day.overtime_minutes - atDouble;
    weeklyUsed.set(key, used + day.overtime_minutes);
    day.double_overtime_minutes = atDouble;
    day.triple_overtime_minutes = atTriple;
    doubleMinutes += atDouble;
    tripleMinutes += atTriple;
  }

  return { doubleMinutes, tripleMinutes };
}

/* ─────────────────────────────────────────────
   Agrupación de horas por periodo
───────────────────────────────────────────── */
function bucketFor(dateStr, grouping, config) {
  switch (grouping) {
    case 'week': {
      const start = weekKeyFor(dateStr, config.week_starts_on);
      return { key: start, label: `Semana del ${formatShort(start)}`, start, end: addDays(start, 6) };
    }
    case 'biweek': {
      const [year, month, day] = dateStr.split('-').map(Number);
      const firstHalf = day <= 15;
      const start = `${year}-${String(month).padStart(2, '0')}-${firstHalf ? '01' : '16'}`;
      const end = firstHalf
        ? `${year}-${String(month).padStart(2, '0')}-15`
        : utcToDate(Date.UTC(year, month, 0));
      return { key: start, label: `${firstHalf ? '1ª' : '2ª'} quincena ${monthLabel(month)} ${year}`, start, end };
    }
    case 'month': {
      const [year, month] = dateStr.split('-').map(Number);
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      return { key: start, label: `${monthLabel(month)} ${year}`, start, end: utcToDate(Date.UTC(year, month, 0)) };
    }
    case 'day':
    default:
      return { key: dateStr, label: formatShort(dateStr), start: dateStr, end: dateStr };
  }
}

const MONTH_LABELS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function monthLabel(month) {
  return MONTH_LABELS[Math.max(0, Math.min(11, Number(month) - 1))];
}
function formatShort(dateStr) {
  const [year, month, day] = String(dateStr).split('-');
  return `${day}/${month}/${year}`;
}

function emptyTotals() {
  return {
    expected_minutes: 0,
    worked_minutes: 0,
    regular_minutes: 0,
    break_minutes: 0,
    overtime_minutes: 0,
    double_overtime_minutes: 0,
    triple_overtime_minutes: 0,
    late_minutes: 0,
    early_leave_minutes: 0,
    late_count: 0,
    worked_days: 0,
    scheduled_days: 0,
    absent_days: 0,
    rest_days: 0,
    incidence_days: 0,
    open_shifts: 0,
  };
}

function accumulate(totals, day) {
  totals.expected_minutes += day.expected_minutes;
  totals.worked_minutes += day.worked_minutes;
  totals.regular_minutes += day.regular_minutes;
  totals.break_minutes += day.break_minutes;
  totals.overtime_minutes += day.overtime_minutes;
  totals.double_overtime_minutes += day.double_overtime_minutes || 0;
  totals.triple_overtime_minutes += day.triple_overtime_minutes || 0;
  totals.late_minutes += day.late_minutes;
  totals.early_leave_minutes += day.early_leave_minutes;
  if (day.late_minutes > 0) totals.late_count += 1;
  if (day.worked_minutes > 0) totals.worked_days += 1;
  if (day.expected_minutes > 0) totals.scheduled_days += 1;
  if (day.counts_absent) totals.absent_days += 1;
  if (day.is_rest) totals.rest_days += 1;
  if (day.incidence) totals.incidence_days += 1;
  if (day.open_shift) totals.open_shifts += 1;
  return totals;
}

/**
 * Construye la asistencia completa de un rango: días, cubetas de agrupación y
 * totales por empleado. Es la fuente única que alimentan reportes y nómina.
 */
function buildAttendance({
  employees = [],
  punches = [],
  schedules = [],
  incidences = [],
  config,
  from,
  to,
  grouping = 'day',
  nowEpoch = Math.floor(Date.now() / 1000),
}) {
  const cfg = normalizeConfig(config);
  const group = normalizeGrouping(grouping);
  const dates = dateRange(from, to);

  const scheduleMap = new Map();
  for (const schedule of schedules) {
    scheduleMap.set(Number(schedule.id), {
      id: Number(schedule.id),
      name: schedule.name,
      color: schedule.color,
      days: schedule.days || {},
    });
  }

  const punchesByEmployeeDate = new Map();
  for (const punch of punches) {
    const key = `${punch.employee_id}|${punch.business_date}`;
    if (!punchesByEmployeeDate.has(key)) punchesByEmployeeDate.set(key, []);
    punchesByEmployeeDate.get(key).push(punch);
  }
  for (const list of punchesByEmployeeDate.values()) list.sort((a, b) => Number(a.epoch) - Number(b.epoch));

  // Una incidencia cubre un rango; se expande a un índice por empleado y día.
  const incidenceByEmployeeDate = new Map();
  for (const incidence of incidences) {
    for (const date of dateRange(incidence.date_from, incidence.date_to, 400)) {
      if (date < from || date > to) continue;
      const employeeKey = positiveInt(incidence.employee_id) || 'all';
      incidenceByEmployeeDate.set(`${employeeKey}|${date}`, incidence);
    }
  }

  const rows = employees.map((employee) => {
    const employeeId = Number(employee.id);
    const days = dates.map((date) => {
      const incidence = incidenceByEmployeeDate.get(`${employeeId}|${date}`)
        || incidenceByEmployeeDate.get(`all|${date}`)
        || null;
      return summarizeDay({
        date,
        punches: punchesByEmployeeDate.get(`${employeeId}|${date}`) || [],
        scheduleDay: scheduleDayFor(scheduleMap, employee.schedule_id, date),
        incidence,
        config: cfg,
        nowEpoch,
      });
    });

    const overtime = splitOvertime(days, cfg);
    const totals = days.reduce(accumulate, emptyTotals());

    const bucketMap = new Map();
    for (const day of days) {
      const bucket = bucketFor(day.date, group, cfg);
      if (!bucketMap.has(bucket.key)) {
        bucketMap.set(bucket.key, { ...bucket, totals: emptyTotals(), days: [] });
      }
      const entry = bucketMap.get(bucket.key);
      accumulate(entry.totals, day);
      entry.days.push(day.date);
    }

    return {
      employee: {
        id: employeeId,
        name: employee.name,
        emp_code: employee.emp_code || '',
        position: employee.position || '',
        branch_id: employee.branch_id || null,
        branch_name: employee.branch_name || '',
        avatar_color: employee.avatar_color || '#6c47ff',
        photo_url: employee.photo_url || '',
        schedule_id: employee.schedule_id || null,
        schedule_name: scheduleMap.get(positiveInt(employee.schedule_id))?.name || '',
        pay_type: normalizePayType(employee.pay_type),
        pay_rate: Number(employee.pay_rate) || 0,
      },
      days,
      buckets: [...bucketMap.values()],
      totals: { ...totals, double_overtime_minutes: overtime.doubleMinutes, triple_overtime_minutes: overtime.tripleMinutes },
    };
  });

  const grandTotals = rows.reduce((acc, row) => {
    for (const key of Object.keys(acc)) acc[key] += row.totals[key] || 0;
    return acc;
  }, emptyTotals());

  return { from, to, grouping: group, config: cfg, rows, totals: grandTotals };
}

/* ─────────────────────────────────────────────
   Nómina
───────────────────────────────────────────── */
/**
 * Calcula el recibo de un empleado a partir de su asistencia ya resumida.
 *
 * Asalariados (mensual/quincenal/semanal): se paga el periodo completo
 * —incluidos descansos— y las faltas se descuentan.
 * Por día: se pagan únicamente los días efectivamente laborados o cubiertos
 * por una incidencia pagada, así que no hay descuento adicional.
 * Por hora: se pagan las horas ordinarias registradas.
 */
/** DATE de pg llega como Date a medianoche local; se formatea sin pasar por UTC. */
function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return String(value).slice(0, 10);
}

function computePayrollItem({ row, config, from, to, adjustments = [] }) {
  const cfg = normalizeConfig(config);
  const rates = payRates(row.employee, cfg);
  const totals = row.totals;
  const calendarDays = daysBetween(from, to) + 1;

  const paidLeaveDays = row.days.reduce((sum, day) => {
    if (!day.incidence || day.worked_minutes > 0) return sum;
    return sum + (Number(day.incidence.pay_factor) || 0);
  }, 0);
  const absentDays = totals.absent_days;

  let basePay = 0;
  let absenceDeduction = 0;
  if (rates.isSalaried) {
    basePay = rates.dailyRate * calendarDays;
    if (cfg.absence_deduction) {
      absenceDeduction = rates.dailyRate * absentDays * (1 + cfg.absence_extra_days);
    }
  } else if (rates.payType === 'daily') {
    basePay = rates.dailyRate * (totals.worked_days + paidLeaveDays);
  } else {
    basePay = rates.hourlyRate * (totals.regular_minutes / 60) + rates.dailyRate * paidLeaveDays;
  }

  const doubleHours = totals.double_overtime_minutes / 60;
  const tripleHours = totals.triple_overtime_minutes / 60;
  const flatMultiplier = cfg.overtime_mode === 'flat' ? cfg.overtime_multiplier : 2;
  const overtimePay = cfg.overtime_mode === 'none'
    ? 0
    : cfg.overtime_mode === 'flat'
      ? rates.hourlyRate * doubleHours * flatMultiplier
      : rates.hourlyRate * (doubleHours * 2 + tripleHours * 3);

  // Prima dominical y días festivos trabajados.
  let premiumPay = 0;
  const sundaysWorked = row.days.filter((day) => day.weekday === 0 && day.worked_minutes > 0).length;
  if (cfg.sunday_premium && sundaysWorked) {
    premiumPay += rates.dailyRate * (cfg.sunday_premium_pct / 100) * sundaysWorked;
  }
  const holidaysWorked = row.days.filter((day) => day.incidence?.type === 'festivo' && day.worked_minutes > 0).length;
  if (holidaysWorked) {
    premiumPay += rates.dailyRate * Math.max(0, cfg.holiday_multiplier - 1) * holidaysWorked;
  }

  let lateDeduction = 0;
  switch (cfg.late_mode) {
    case 'per_minute':
      lateDeduction = cfg.late_amount * totals.late_minutes;
      break;
    case 'per_incident':
      lateDeduction = cfg.late_amount * totals.late_count;
      break;
    case 'per_day_each_three':
      lateDeduction = rates.dailyRate * Math.floor(totals.late_count / 3);
      break;
    default:
      lateDeduction = 0;
  }

  const otherEarnings = adjustments
    .filter((adjustment) => adjustment.kind === 'earning')
    .reduce((sum, adjustment) => sum + (Number(adjustment.amount) || 0), 0);
  const otherDeductions = adjustments
    .filter((adjustment) => adjustment.kind !== 'earning')
    .reduce((sum, adjustment) => sum + (Number(adjustment.amount) || 0), 0);

  const grossPay = basePay + overtimePay + premiumPay + otherEarnings;
  const netPay = grossPay - absenceDeduction - lateDeduction - otherDeductions;

  return {
    employee_id: row.employee.id,
    employee_name: row.employee.name,
    emp_code: row.employee.emp_code,
    branch_name: row.employee.branch_name,
    position: row.employee.position || '',
    department: row.employee.department || '',
    hire_date: dateOnly(row.employee.hire_date),
    pay_type: rates.payType,
    pay_rate: round2(rates.rate),
    daily_rate: rates.dailyRate,
    hourly_rate: rates.hourlyRate,
    worked_minutes: totals.worked_minutes,
    expected_minutes: totals.expected_minutes,
    overtime_minutes: totals.overtime_minutes,
    double_overtime_minutes: totals.double_overtime_minutes,
    triple_overtime_minutes: totals.triple_overtime_minutes,
    late_minutes: totals.late_minutes,
    late_count: totals.late_count,
    worked_days: totals.worked_days,
    scheduled_days: totals.scheduled_days,
    absent_days: round2(absentDays),
    paid_leave_days: round2(paidLeaveDays),
    rest_days: totals.rest_days,
    calendar_days: calendarDays,
    base_pay: round2(basePay),
    overtime_pay: round2(overtimePay),
    premium_pay: round2(premiumPay),
    other_earnings: round2(otherEarnings),
    absence_deduction: round2(absenceDeduction),
    late_deduction: round2(lateDeduction),
    other_deductions: round2(otherDeductions),
    gross_pay: round2(grossPay),
    net_pay: round2(netPay),
    adjustments,
    detail: {
      sundays_worked: sundaysWorked,
      holidays_worked: holidaysWorked,
      open_shifts: totals.open_shifts,
      early_leave_minutes: totals.early_leave_minutes,
    },
  };
}

function computePayroll({ attendance, from, to, adjustmentsByEmployee = new Map() }) {
  const items = attendance.rows.map((row) => computePayrollItem({
    row,
    config: attendance.config,
    from,
    to,
    adjustments: adjustmentsByEmployee.get(Number(row.employee.id)) || [],
  }));

  const totals = items.reduce((acc, item) => ({
    gross_pay: round2(acc.gross_pay + item.gross_pay),
    net_pay: round2(acc.net_pay + item.net_pay),
    base_pay: round2(acc.base_pay + item.base_pay),
    overtime_pay: round2(acc.overtime_pay + item.overtime_pay),
    premium_pay: round2(acc.premium_pay + item.premium_pay),
    other_earnings: round2(acc.other_earnings + item.other_earnings),
    deductions: round2(acc.deductions + item.absence_deduction + item.late_deduction + item.other_deductions),
    worked_minutes: acc.worked_minutes + item.worked_minutes,
    overtime_minutes: acc.overtime_minutes + item.overtime_minutes,
    absent_days: round2(acc.absent_days + item.absent_days),
  }), {
    gross_pay: 0, net_pay: 0, base_pay: 0, overtime_pay: 0, premium_pay: 0,
    other_earnings: 0, deductions: 0, worked_minutes: 0, overtime_minutes: 0, absent_days: 0,
  });

  return { from, to, items, totals };
}

/* ─────────────────────────────────────────────
   Periodos sugeridos (atajos del panel)
───────────────────────────────────────────── */
function periodPreset(preset, todayDate, config = DEFAULT_CONFIG) {
  const cfg = normalizeConfig(config);
  const [year, month, day] = todayDate.split('-').map(Number);
  switch (String(preset || '').toLowerCase()) {
    case 'today':
      return { from: todayDate, to: todayDate };
    case 'yesterday': {
      const yesterday = addDays(todayDate, -1);
      return { from: yesterday, to: yesterday };
    }
    case 'week': {
      const start = weekKeyFor(todayDate, cfg.week_starts_on);
      return { from: start, to: addDays(start, 6) };
    }
    case 'last_week': {
      const start = addDays(weekKeyFor(todayDate, cfg.week_starts_on), -7);
      return { from: start, to: addDays(start, 6) };
    }
    case 'biweek': {
      const firstHalf = day <= 15;
      return {
        from: `${year}-${String(month).padStart(2, '0')}-${firstHalf ? '01' : '16'}`,
        to: firstHalf ? `${year}-${String(month).padStart(2, '0')}-15` : utcToDate(Date.UTC(year, month, 0)),
      };
    }
    case 'last_biweek': {
      const firstHalf = day <= 15;
      if (firstHalf) {
        const prevMonthEnd = utcToDate(Date.UTC(year, month - 1, 0));
        return { from: `${prevMonthEnd.slice(0, 7)}-16`, to: prevMonthEnd };
      }
      return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: `${year}-${String(month).padStart(2, '0')}-15` };
    }
    case 'last_month': {
      const start = utcToDate(Date.UTC(year, month - 2, 1));
      return { from: start, to: utcToDate(Date.UTC(year, month - 1, 0)) };
    }
    case 'month':
    default:
      return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: utcToDate(Date.UTC(year, month, 0)) };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  INCIDENCE_TYPES,
  PUNCH_TYPES,
  PUNCH_METHODS,
  PAY_TYPES,
  GROUPINGS,
  addDays,
  buildAttendance,
  buildDaySessions,
  computePayroll,
  computePayrollItem,
  dateRange,
  daysBetween,
  isIsoDate,
  minutesToTime,
  normalizeConfig,
  normalizeGrouping,
  normalizePayType,
  normalizePunchMethod,
  normalizePunchType,
  payRates,
  periodPreset,
  scheduledMinutes,
  summarizeDay,
  timeToMinutes,
  weekdayOf,
  weekKeyFor,
};
