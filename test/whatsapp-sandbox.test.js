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
  assert.match(route, /callbackUrl\.searchParams\.set\('state', state\)/);
  assert.match(route, /metadata\.oauthState === state/);
  assert.match(route, /legacyCallbackIsValid/);
  assert.match(route, /profile_id=COALESCE\(NULLIF\(\$1,''\),profile_id\)/);
  assert.match(route, /interactive: \{/);
  assert.match(route, /buttons: rows\.map/);
  assert.match(route, /metadata\.interactiveId/);
  assert.match(route, /metadata\.location/);
  assert.match(route, /sharelocation: 'share_location'/);
  assert.match(route, /geo:\$\{location\.lat\}/);
  assert.match(route, /parsed\.location \? 'location'/);
  assert.match(route, /whatsappTransportId/);
  assert.match(route, /whatsappEngineInput/);
  assert.match(route, /cat\|prod\|variant\|branch\|modifier/);
  assert.match(route, /const text = interactiveId \|\| locationText \|\| textValue \|\| interactiveTitle/);
  assert.match(route, /attachmentType: 'image'/);
  assert.match(route, /whatsappProductIdFromInput/);
  assert.match(route, /variants\.length > 1/);
  assert.match(engine, /product_variants WHERE product_id = ANY/);
  assert.match(engine, /variants: variantsByProduct\.get/);
  assert.match(route, /sendBotReply/);
  assert.match(route, /mode='sandbox'/);
  assert.match(route, /source_channel='whatsapp'/);
  assert.match(html, /id="whatsappSandboxPanel"/);
  assert.match(html, /value="sandbox"/);
  assert.match(html, /class="optional-label">OPCIONAL/);
  assert.match(html, /class="required-label">OBLIGATORIA/);
  assert.match(html, /whatsapp-setup-guide/);
  assert.match(html, /whatsappCustomerEntryCard/);
  assert.match(html, /whatsappCustomerQr/);
  assert.match(html, /sandbox de Zernio/);
  assert.match(client, /whatsappSandboxActivateBtn/);
  assert.match(client, /whatsappSandboxStartBtn/);
  assert.match(client, /whatsappCustomerShareBtn/);
  assert.match(client, /visibleMessages/);
  assert.match(engine, /runtime\.sourceChannel/);
});
