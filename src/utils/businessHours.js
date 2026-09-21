const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAY_ALIASES = [
  ['domingo', 'dom'],
  ['lunes', 'lun'],
  ['martes', 'mar'],
  ['miercoles', 'miércoles', 'mie', 'mié'],
  ['jueves', 'jue'],
  ['viernes', 'vie'],
  ['sabado', 'sábado', 'sab', 'sáb'],
];

const DEFAULT_WEEKLY_HOURS = DAY_NAMES.map((_, day) => ({
  day,
  enabled: day >= 1 && day <= 5,
  open: '09:00',
  close: '18:00',
}));

function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function validTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function normalizeBusinessHours(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw || '[]'); } catch { parsed = []; }
  }
  const byDay = new Map((Array.isArray(parsed) ? parsed : []).map((entry) => [Number(entry?.day), entry]));
  return DEFAULT_WEEKLY_HOURS.map((fallback) => {
    const entry = byDay.get(fallback.day);
    const open = validTime(entry?.open) ? entry.open : fallback.open;
    const close = validTime(entry?.close) ? entry.close : fallback.close;
    return {
      day: fallback.day,
      enabled: entry ? entry.enabled !== false : fallback.enabled,
      open,
      close,
    };
  });
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: weekdays[values.weekday],
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localDateKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function dateKeyAddDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function weekdayForDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function timeMinutes(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return hours * 60 + minutes;
}

function localDateTimeToDate(dateKey, time, timeZone) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = new Date(desiredUtc);
  for (let index = 0; index < 3; index += 1) {
    const actual = localParts(candidate, timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate = new Date(candidate.getTime() + desiredUtc - actualUtc);
  }
  return candidate;
}

function isLocalTimeOpen(schedule, dateKey, minuteOfDay) {
  const weekday = weekdayForDateKey(dateKey);
  const today = schedule[weekday];
  if (today?.enabled) {
    const open = timeMinutes(today.open);
    const close = timeMinutes(today.close);
    if (open < close && minuteOfDay >= open && minuteOfDay < close) return true;
    if (open > close && minuteOfDay >= open) return true;
  }
  const previous = schedule[(weekday + 6) % 7];
  if (previous?.enabled && timeMinutes(previous.open) > timeMinutes(previous.close)
      && minuteOfDay < timeMinutes(previous.close)) return true;
  return false;
}

function businessStatusAt(rawSchedule, now = new Date(), timeZone = 'America/Mexico_City') {
  const schedule = normalizeBusinessHours(rawSchedule);
  const local = localParts(now, timeZone);
  const dateKey = localDateKey(local);
  const minuteOfDay = local.hour * 60 + local.minute;
  return {
    open: isLocalTimeOpen(schedule, dateKey, minuteOfDay),
    local,
    nextOpening: findNextOpening(schedule, now, timeZone),
  };
}

function findNextOpening(rawSchedule, now = new Date(), timeZone = 'America/Mexico_City') {
  const schedule = normalizeBusinessHours(rawSchedule);
  const local = localParts(now, timeZone);
  const todayKey = localDateKey(local);
  for (let offset = 0; offset < 14; offset += 1) {
    const dateKey = dateKeyAddDays(todayKey, offset);
    const entry = schedule[weekdayForDateKey(dateKey)];
    if (!entry?.enabled) continue;
    const candidate = localDateTimeToDate(dateKey, entry.open, timeZone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return null;
}

function parseRequestedDateTime(input, now = new Date(), timeZone = 'America/Mexico_City', options = {}) {
  const source = normalizeText(input).replace(/\s+/g, ' ').trim();
  const timeMatch = [...source.matchAll(/(?:^|\s|a las\s+)(\d{1,2})(?:[.:,](\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?(?=\s|$)/g)].pop();
  if (!timeMatch) return { error: 'Incluye una hora; por ejemplo: “9.30 am”, “1 pm” o “13:00”.' };
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || 0);
  const meridiem = String(timeMatch[3] || '').replace(/[.\s]/g, '');
  if (minute > 59 || hour > (meridiem ? 12 : 23) || hour < 0 || (meridiem && hour < 1)) {
    return { error: 'La hora no es válida.' };
  }
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const localNow = localParts(now, timeZone);
  const todayKey = localDateKey(localNow);
  let dateKey = '';
  const isoMatch = source.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const slashMatch = source.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
  if (options.fixedDateKey) {
    dateKey = String(options.fixedDateKey);
  } else if (isoMatch) {
    dateKey = isoMatch[0];
  } else if (slashMatch) {
    const year = Number(slashMatch[3] || localNow.year);
    dateKey = `${year}-${String(Number(slashMatch[2])).padStart(2, '0')}-${String(Number(slashMatch[1])).padStart(2, '0')}`;
  } else if (/\bpasado manana\b/.test(source)) {
    dateKey = dateKeyAddDays(todayKey, 2);
  } else if (/\bmanana\b/.test(source)) {
    dateKey = dateKeyAddDays(todayKey, 1);
  } else if (/\bhoy\b/.test(source)) {
    dateKey = todayKey;
  } else if (options.defaultDateKey) {
    dateKey = String(options.defaultDateKey);
  } else {
    const requestedDay = DAY_ALIASES.findIndex((aliases) => aliases.some((alias) => new RegExp(`\\b${normalizeText(alias)}\\b`).test(source)));
    if (requestedDay < 0) return { error: 'Incluye uno de los días disponibles además de la hora.' };
    let offset = (requestedDay - localNow.weekday + 7) % 7;
    const requestedMinutes = hour * 60 + minute;
    if (offset === 0 && requestedMinutes <= localNow.hour * 60 + localNow.minute) offset = 7;
    dateKey = dateKeyAddDays(todayKey, offset);
  }
  const requested = localDateTimeToDate(dateKey, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, timeZone);
  if (!Number.isFinite(requested.getTime())) return { error: 'La fecha no es válida.' };
  if (requested.getTime() <= now.getTime()) return { error: 'El horario debe ser posterior a la hora actual.' };
  return { date: requested, dateKey, hour, minute };
}

function businessDateKey(date, timeZone = 'America/Mexico_City') {
  return localDateKey(localParts(date, timeZone));
}

function formatBusinessDate(date, timeZone = 'America/Mexico_City') {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(date);
}

function validateScheduledDate(rawSchedule, date, timeZone = 'America/Mexico_City') {
  const schedule = normalizeBusinessHours(rawSchedule);
  const local = localParts(date, timeZone);
  const dateKey = localDateKey(local);
  if (!isLocalTimeOpen(schedule, dateKey, local.hour * 60 + local.minute)) {
    return { valid: false, error: `El negocio está cerrado el ${DAY_NAMES[local.weekday]} a esa hora.` };
  }
  return { valid: true };
}

function formatBusinessDateTime(date, timeZone = 'America/Mexico_City') {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

function hoursSummary(rawSchedule) {
  const schedule = normalizeBusinessHours(rawSchedule);
  return schedule.map((entry) => `${DAY_NAMES[entry.day]}: ${entry.enabled ? `${entry.open}-${entry.close}` : 'cerrado'}`).join(' · ');
}

module.exports = {
  DAY_NAMES,
  DEFAULT_WEEKLY_HOURS,
  businessDateKey,
  businessStatusAt,
  findNextOpening,
  formatBusinessDate,
  formatBusinessDateTime,
  hoursSummary,
  normalizeBusinessHours,
  parseRequestedDateTime,
  validateScheduledDate,
};
