const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  businessStatusAt,
  findNextOpening,
  normalizeBusinessHours,
  parseRequestedDateTime,
  validateScheduledDate,
} = require('../src/utils/businessHours');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const closedWeek = () => Array.from({ length: 7 }, (_, day) => ({ day, enabled: false, open: '09:00', close: '18:00' }));

test('detecta cierre y encuentra la siguiente apertura en la zona horaria del tenant', () => {
  const schedule = closedWeek();
  schedule[5] = { day: 5, enabled: true, open: '09:00', close: '18:00' };
  const mondayNoonMexico = new Date('2026-09-21T18:00:00.000Z');

  assert.equal(businessStatusAt(schedule, mondayNoonMexico, 'America/Mexico_City').open, false);
  assert.equal(findNextOpening(schedule, mondayNoonMexico, 'America/Mexico_City').toISOString(), '2026-09-25T15:00:00.000Z');
});

test('interpreta viernes a las 10am y valida que caiga dentro del horario', () => {
  const schedule = closedWeek();
  schedule[5] = { day: 5, enabled: true, open: '09:00', close: '18:00' };
  const now = new Date('2026-09-21T18:00:00.000Z');
  const parsed = parseRequestedDateTime('Lo quiero para el viernes a las 10am', now, 'America/Mexico_City');

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.date.toISOString(), '2026-09-25T16:00:00.000Z');
  assert.equal(validateScheduledDate(schedule, parsed.date, 'America/Mexico_City').valid, true);
});

test('acepta horas con punto y formatos de 12 o 24 horas', () => {
  const now = new Date('2026-09-21T18:00:00.000Z');
  const options = { fixedDateKey: '2026-09-25' };

  assert.equal(parseRequestedDateTime('9.30 am', now, 'America/Mexico_City', options).date.toISOString(), '2026-09-25T15:30:00.000Z');
  assert.equal(parseRequestedDateTime('1 pm', now, 'America/Mexico_City', options).date.toISOString(), '2026-09-25T19:00:00.000Z');
  assert.equal(parseRequestedDateTime('13:00', now, 'America/Mexico_City', options).date.toISOString(), '2026-09-25T19:00:00.000Z');
  for (const hour of [9, 10, 11, 12, 13]) {
    const parsed = parseRequestedDateTime(String(hour), now, 'America/Mexico_City', options);
    assert.equal(parsed.hour, hour);
    assert.equal(parsed.minute, 0);
  }
});

test('el día elegido permanece fijo aunque el texto mencione mañana', () => {
  const now = new Date('2026-09-21T18:00:00.000Z');
  const parsed = parseRequestedDateTime('mañana a las 10', now, 'America/Mexico_City', { fixedDateKey: '2026-09-25' });

  assert.equal(parsed.dateKey, '2026-09-25');
  assert.equal(parsed.date.toISOString(), '2026-09-25T16:00:00.000Z');
});

test('rechaza una reservación en un día cerrado', () => {
  const schedule = closedWeek();
  schedule[2] = { day: 2, enabled: true, open: '10:00', close: '15:00' };
  const now = new Date('2026-09-21T18:00:00.000Z');
  const parsed = parseRequestedDateTime('mañana a las 8am', now, 'America/Mexico_City');

  assert.equal(validateScheduledDate(schedule, parsed.date, 'America/Mexico_City').valid, false);
});

test('normaliza siempre los siete días con horas válidas', () => {
  const schedule = normalizeBusinessHours('[]');
  assert.equal(schedule.length, 7);
  assert.deepEqual(schedule.filter((entry) => entry.enabled).map((entry) => entry.day), [1, 2, 3, 4, 5]);
});

test('los flags son opcionales por tenant y el pedido conserva scheduled_for', () => {
  const settings = read('src/routes/settings.js');
  const database = read('src/db/index.js');
  const engine = read('src/chatbot/engine.js');
  const html = read('public/app.html');
  const app = read('public/js/app.js');

  assert.match(settings, /'chatbot_full_menu_enabled'/);
  assert.match(settings, /'business_hours_enabled'/);
  assert.match(settings, /'chatbot_preorders_enabled'/);
  assert.match(database, /business_hours_enabled: '0'/);
  assert.match(database, /chatbot_preorders_enabled: '0'/);
  assert.match(database, /chatbot_full_menu_enabled: '0'/);
  assert.match(database, /scheduled_for TIMESTAMPTZ/);
  assert.match(engine, /if \(showFullMenu\)/);
  assert.match(engine, /state\.step = 'ask_scheduled_datetime'/);
  assert.match(engine, /state\.step = 'ask_scheduled_time'/);
  assert.match(engine, /fixedDateKey: state\.scheduledDateKey/);
  assert.match(engine, /Días y horarios disponibles/);
  assert.doesNotMatch(engine, /mañana a las 11:30am/);
  const nextOpeningBranch = engine.match(/if \(lower === 'schedule_next_open'[\s\S]*?if \(lower === 'schedule_custom'\)/)?.[0] || '';
  assert.doesNotMatch(nextOpeningBranch, /state\.customer\.scheduledFor\s*=/);
  assert.match(engine, /scheduled_for\)/);
  assert.match(html, /id="cfgBusinessHoursGrid"/);
  assert.match(html, /id="cfgChatbotFullMenu"/);
  assert.match(app, /fd\.append\('business_hours_json'/);
});

test('Pedidos incluye una bandeja separada para reservas futuras', () => {
  const ordersRoute = read('src/routes/orders.js');
  const html = read('public/app.html');
  const app = read('public/js/app.js');

  assert.match(html, /data-view="scheduled"[^>]*>[\s\S]*?Programados/);
  assert.match(ordersRoute, /scheduled_for > now\(\)/);
  assert.match(ordersRoute, /ORDER BY scheduled_for ASC/);
  assert.match(app, /if \(orderScheduledOnly\) params\.set\('scheduled', 'upcoming'\)/);
  assert.match(app, /if \(!orderScheduledOnly && orderTodayOnly\) params\.set\('todayOnly', '1'\)/);
  assert.match(app, /Los pedidos anticipados futuros aparecerán aquí automáticamente/);
});
