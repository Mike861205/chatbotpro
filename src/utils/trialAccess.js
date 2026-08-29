const TRIAL_DAYS = 5;

function dateKeyInTimeZone(date = new Date(), timeZone = 'America/Mexico_City') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function normalizeDateKey(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return '';
}

function calendarDayDifference(later, earlier) {
  const end = normalizeDateKey(later);
  const start = normalizeDateKey(earlier);
  if (!end || !start) return null;
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const startMs = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return null;
  return Math.round((endMs - startMs) / 86400000);
}

function trialState(tenant, now = new Date()) {
  const status = String(tenant?.trial_status || 'not_applicable').toLowerCase();
  const endsOn = normalizeDateKey(tenant?.trial_ends_on);
  const today = dateKeyInTimeZone(now, tenant?.timezone || 'America/Mexico_City');
  const rawDays = calendarDayDifference(endsOn, today);
  const isManagedTrial = ['active', 'expired'].includes(status) && Boolean(endsOn) && !tenant?.customer_since;
  const isExpired = isManagedTrial && (status === 'expired' || Number(rawDays) <= 0);
  return {
    status: isExpired ? 'expired' : status,
    startedOn: normalizeDateKey(tenant?.trial_started_on) || null,
    endsOn: endsOn || null,
    daysRemaining: isManagedTrial ? Math.max(0, Number(rawDays) || 0) : null,
    isActive: isManagedTrial && !isExpired,
    isExpired,
  };
}

module.exports = { TRIAL_DAYS, dateKeyInTimeZone, calendarDayDifference, trialState };
