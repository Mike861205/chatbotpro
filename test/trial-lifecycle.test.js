const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TRIAL_DAYS, calendarDayDifference, trialState } = require('../src/utils/trialAccess');

const root = path.join(__dirname, '..');

test('la prueba dura cinco días calendario y muestra la cuenta regresiva correcta', () => {
  assert.equal(TRIAL_DAYS, 5);
  assert.equal(calendarDayDifference('2026-09-03', '2026-08-29'), 5);
  assert.equal(calendarDayDifference('2026-09-03', '2026-08-30'), 4);
  const active = trialState({
    trial_status: 'active',
    trial_started_on: '2026-08-29',
    trial_ends_on: '2026-09-03',
    timezone: 'America/Chihuahua',
  }, new Date('2026-08-30T18:00:00Z'));
  assert.equal(active.isActive, true);
  assert.equal(active.daysRemaining, 4);
});

test('vence al iniciar el sexto día y no afecta tenants históricos o clientes', () => {
  const expired = trialState({ trial_status: 'active', trial_ends_on: '2026-09-03', timezone: 'UTC' }, new Date('2026-09-03T00:01:00Z'));
  assert.equal(expired.isExpired, true);
  assert.equal(expired.daysRemaining, 0);
  assert.equal(trialState({ trial_status: 'not_applicable' }).isExpired, false);
  assert.equal(trialState({ trial_status: 'expired', trial_ends_on: '2026-01-01', customer_since: '2026-01-01' }).isExpired, false);
});

test('el flujo conecta demo, prospecto, prueba, aviso comercial y conversión sin bloquear la operación', () => {
  const auth = fs.readFileSync(path.join(root, 'src', 'routes', 'auth.js'), 'utf8');
  const middleware = fs.readFileSync(path.join(root, 'src', 'middleware', 'auth.js'), 'utf8');
  const database = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const chatbot = fs.readFileSync(path.join(root, 'src', 'routes', 'chatbot.js'), 'utf8');
  const superadmin = fs.readFileSync(path.join(root, 'src', 'routes', 'superadmin.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  assert.match(auth, /router\.post\('\/demo-interest'/);
  assert.match(auth, /trial_started_on, trial_ends_on, trial_status/);
  assert.match(middleware, /SET trial_status = 'expired' WHERE id = \$1/);
  assert.doesNotMatch(middleware, /SET trial_status = 'expired', account_status = 'inactive'/);
  assert.doesNotMatch(auth, /errorCode: 'TRIAL_EXPIRED'/);
  assert.match(database, /SET trial_status = 'expired'\s+WHERE trial_status = 'active'/);
  assert.match(database, /migration_trial_expiration_is_advisory_v1/);
  assert.doesNotMatch(server, /AND NOT \(trial_status IN \('active', 'expired'\)/);
  assert.doesNotMatch(chatbot, /trialState\(rows\[0\]\)\.isExpired/);
  assert.match(superadmin, /trial_status = 'converted'/);
  assert.match(superadmin, /trial_status = 'expired' THEN 'unlocked'/);
  assert.match(app, /id="demoJourneyModal"/);
  assert.match(app, /id="trialWelcomeModal"/);
  assert.match(app, /id="trialWelcomeEyebrow"/);
  assert.match(app, /id="trialBusinessLogo"/);
  assert.match(app, /id="trialBusinessModel"/);
  assert.match(app, /id="trialBusinessCurrency"/);
  assert.match(app, /id="trialBusinessTimezone"/);
  assert.match(app, /id="trialExpiredModal"/);
  assert.match(app, /Tu periodo de prueba de 5 días ha finalizado/);
  assert.match(app, /Tu sistema continúa disponible/);
  assert.match(app, /id="trialExpiredSupportName"/);
  assert.match(app, /id="trialExpiredClose"/);
  assert.match(app, /id="trialExpiredContinue"/);
  assert.match(app, /id="trialExpiredWhatsapp"[^>]+wa\.me\/526241370820/);
  assert.match(app, /id="trialExpiredCopyPhone"[^>]+data-phone="\+526241370820"/);
  assert.match(app, /id="trialExpiredPlans"/);
  assert.match(appJs, /navigator\.clipboard\.writeText\(phone\)/);
  assert.match(appJs, /function closeTrialExpiredModal/);
  assert.match(appJs, /isErr && \$\('#trialExpiredModal'\)\?\.classList\.contains\('show'\)/);
  const normalizeViewBody = appJs.match(/function normalizeView\(view\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(normalizeViewBody, /\bres\b|\bdata\?\.errorCode/);
  assert.doesNotMatch(appJs, /errorCode === 'TRIAL_EXPIRED'/);
  assert.doesNotMatch(appJs, /ME\?\.trial\?\.isExpired \? 'suscripciones'/);
  assert.match(appJs, /¡Felicidades por tu registro, \$\{ownerName\}!/);
  assert.match(appJs, /\$\{businessName\} ya tiene su sistema listo/);
});
