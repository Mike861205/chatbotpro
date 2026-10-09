const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

test('la bandeja instalable expone página, manifest propio y vínculo desde el panel', () => {
  const server = read('server.js');
  const html = read('public', 'inbox.html');
  const manifest = JSON.parse(read('public', 'manifest-inbox.json'));
  const panel = read('public', 'app.html');

  assert.match(server, /app\.get\('\/bandeja', page\('inbox\.html'\)\)/);
  assert.match(html, /rel="manifest" href="\/static\/manifest-inbox\.json"/);
  assert.match(html, /\/static\/js\/inbox\.js/);
  assert.equal(manifest.start_url, '/bandeja');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
  assert.match(panel, /href="\/bandeja"/);
  assert.match(panel, /id="whatsappInboxAppCopyBtn"/);
});

test('la app de bandeja usa la API existente para responder, tomar control y recibir en vivo', () => {
  const client = read('public', 'js', 'inbox.js');

  assert.match(client, /\/api\/whatsapp\/conversations\/\$\{id\}\/messages/);
  assert.match(client, /\/api\/whatsapp\/conversations\/\$\{id\}\/send/);
  assert.match(client, /\/takeover/);
  assert.match(client, /whatsapp_update/);
  assert.match(client, /topic: 'whatsapp'/);
  assert.match(client, /open-conversation/);
  assert.match(client, /class="loc"/);
});

test('el service worker avisa mensajes de WhatsApp y abre el chat correcto', () => {
  const worker = read('public', 'sw.js');

  assert.match(worker, /whatsapp_message/);
  assert.match(worker, /conversationId/);
  assert.match(worker, /visibilityState === 'visible'/);
  assert.match(worker, /type: 'open-conversation'/);
});

test('los mensajes entrantes se envían por push al tema whatsapp', () => {
  const route = read('src', 'routes', 'whatsapp.js');
  const notifications = read('src', 'routes', 'notifications.js');
  const db = read('src', 'db', 'index.js');

  assert.match(route, /pushInboundMessage\(\{ tenantSlug, conversation, parsed \}\)/);
  assert.match(route, /topic: 'whatsapp'/);
  assert.match(route, /url: `\/bandeja\?c=/);
  assert.match(notifications, /requireModules\('pedidos', 'pos', 'whatsapp'\)/);
  assert.match(db, /push_subscriptions ADD COLUMN IF NOT EXISTS topic/);
});
