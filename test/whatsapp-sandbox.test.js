const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('WhatsApp ofrece sandbox Zernio y conserva el flujo real de pedidos', () => {
  const route = source('src/routes/whatsapp.js');
  const html = source('public/app.html');
  const client = source('public/js/whatsapp.js');
  const engine = source('src/chatbot/engine.js');

  assert.match(route, /\/v1\/phone-numbers/);
  assert.match(route, /\/v1\/whatsapp\/sandbox\/sessions/);
  assert.match(route, /\/v1\/inbox\/conversations/);
  assert.match(route, /mode='sandbox'/);
  assert.match(route, /source_channel='whatsapp'/);
  assert.match(html, /id="whatsappSandboxPanel"/);
  assert.match(html, /value="sandbox"/);
  assert.match(client, /whatsappSandboxActivateBtn/);
  assert.match(client, /whatsappSandboxStartBtn/);
  assert.match(engine, /runtime\.sourceChannel/);
});
