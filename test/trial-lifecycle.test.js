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

test('el flujo conecta demo, prospecto, prueba, bloqueo, pago y reactivación', () => {
  const auth = fs.readFileSync(path.join(root, 'src', 'routes', 'auth.js'), 'utf8');
  const middleware = fs.readFileSync(path.join(root, 'src', 'middleware', 'auth.js'), 'utf8');
  const superadmin = fs.readFileSync(path.join(root, 'src', 'routes', 'superadmin.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  assert.match(auth, /router\.post\('\/demo-interest'/);
  assert.match(auth, /trial_started_on, trial_ends_on, trial_status/);
  assert.match(middleware, /TRIAL_EXPIRED/);
  assert.match(superadmin, /trial_status = 'converted'/);
  assert.match(superadmin, /trial_status = 'expired' THEN 'unlocked'/);
  assert.match(app, /id="demoJourneyModal"/);
  assert.match(app, /id="trialWelcomeModal"/);
  assert.match(app, /id="trialExpiredModal"/);
  const normalizeViewBody = appJs.match(/function normalizeView\(view\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(normalizeViewBody, /\bres\b|\bdata\?\.errorCode/);
  assert.match(appJs, /res\.status === 403 && data\?\.errorCode === 'TRIAL_EXPIRED'/);
});
