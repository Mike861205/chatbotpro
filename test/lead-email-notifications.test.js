const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const auth = read('src', 'routes', 'auth.js');
const mailer = read('src', 'utils', 'mailer.js');
const server = read('server.js');

test('cada lead demo nuevo y cada prospecto registrado disparan su correo', () => {
  assert.match(auth, /if \(demoLead && demoLead\.demo_count === 1\)[\s\S]+sendLeadNotification\(/);
  assert.match(auth, /initTenantDefaults\([\s\S]+sendRegistrationNotification\(/);
  assert.match(auth, /fire-and-forget lead error/);
  assert.match(auth, /fire-and-forget register error/);
});

test('el arranque verifica credenciales SMTP y destinatario de producción', () => {
  assert.match(mailer, /async function verifyNotificationMailer\(\)/);
  assert.match(mailer, /await transport\.verify\(\)/);
  assert.match(mailer, /config\.NOTIFICATION_EMAIL/);
  assert.match(server, /verifyNotificationMailer\(\)\.catch/);
});

test('los errores de envío llegan al manejador de cada alta', () => {
  assert.doesNotMatch(mailer, /Error enviando notificación/);
  assert.match(mailer, /function requireNotificationTransport\(\)/);
  assert.match(mailer, /throw new Error\('NOTIFICATION_EMAIL no configurado'\)/);
  assert.match(mailer, /await transport\.sendMail\(/);
  assert.match(mailer, /return true/);
});