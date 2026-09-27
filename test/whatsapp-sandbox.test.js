const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('WhatsApp presenta ubicación y cuentas bancarias en formatos accionables', () => {
  const route = require('../src/routes/whatsapp');
  const engine = source('src/chatbot/engine.js');
  const location = route.whatsappInteractiveMessages({
    options: [{ label: '📍 Comparte tu ubicación', value: 'share_location' }],
  }).find((message) => message.kind === 'location-request');
  assert.equal(location.bodyText, '📍 *Comparte tu ubicación*');

  const bankText = route.whatsappBankAccountsText([
    { fields: [
      { label: 'Banco', value: 'Bancomer' },
      { label: 'CLABE', value: '012345678901234567' },
    ] },
  ], 'Datos para Transferencia');
  assert.match(bankText, /Mantén presionado/);
  assert.match(bankText, /`012345678901234567`/);
  assert.match(bankText, /Conserva tu comprobante/);
  assert.match(engine, /waLink && String\(runtime\.sourceChannel \|\| ''\)\.toLowerCase\(\) !== 'whatsapp'/);
});

test('WhatsApp conserva el valor interno de botones y listas de Zernio', () => {
  const route = require('../src/routes/whatsapp');
  const parseWebhook = route.webhookMessage;
  assert.equal(typeof parseWebhook, 'function');

  const encoded = `cb${Buffer.from('info_horarios', 'utf8').toString('hex')}`;
  const payloads = [
    { event: 'message.received', metadata: { interactiveId: encoded } },
    { event: 'message.received', message: { interactive: { button_reply: { id: encoded, title: 'Horarios' } } } },
    { event: 'message.received', data: { message: { button: { payload: encoded, title: 'Horarios' } } } },
  ];

  for (const payload of payloads) {
    const parsed = parseWebhook(payload);
    assert.equal(parsed.interactiveId, 'info_horarios');
    assert.equal(parsed.text, 'info_horarios');
  }

  const titleOnly = parseWebhook({
    event: 'message.received',
    message: { interactive: { list_reply: { title: 'Horarios de atención' } } },
  });
  assert.equal(titleOnly.interactiveTitle, 'Horarios de atención');
  assert.equal(titleOnly.text, 'Horarios de atención');
});

test('la bandeja conserva el cliente y no usa el nombre del negocio en mensajes salientes', () => {
  const route = require('../src/routes/whatsapp');
  const customerName = route.whatsappConversationCustomerName;
  assert.equal(typeof customerName, 'function');

  assert.equal(customerName({ incoming: true, senderName: 'Ana López' }, { display_name: 'daddypollo' }), 'Ana López');
  assert.equal(customerName({ incoming: false, senderName: 'Programación y Desarrollo Tecnológicos de Ideas' }, { display_name: 'daddypollo' }), '');
  assert.equal(customerName({ incoming: true, senderName: 'daddypollo' }, { display_name: 'daddypollo' }), '');
});

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
  assert.match(route, /isActive: true/);
  assert.match(route, /setImmediate\(\(\) =>/);
  assert.match(route, /status IN \('active','connected'\)/);
  assert.match(route, /x-late-signature/);
  assert.match(route, /x-late-event-id/);
  assert.match(route, /interactive: \{/);
  assert.match(route, /buttons: chunk\.map/);
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
  assert.match(route, /business-profile\/photo/);
  assert.match(route, /profilePhotoSyncedAt/);
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
  assert.match(html, /whatsappCustomerEntryLogo/);
  assert.match(html, /whatsappSyncProfilePhotoBtn/);
  assert.match(html, /sandbox de Zernio/);
  assert.match(client, /https:\/\/wa\.me\/\$\{number\}\?text=/);
  assert.match(client, /profile-photo/);
  assert.match(client, /whatsappSandboxActivateBtn/);
  assert.match(client, /whatsappSandboxStartBtn/);
  assert.match(client, /whatsappCustomerShareBtn/);
  assert.match(client, /visibleMessages/);
  assert.match(engine, /runtime\.sourceChannel/);
});

test('WhatsApp muestra las acciones como botones completos y separa el catálogo', () => {
  const route = require('../src/routes/whatsapp');
  const buildMessages = route.whatsappInteractiveMessages;
  assert.equal(typeof buildMessages, 'function');

  const actionMessages = buildMessages({
    options: [
      { label: '✅ Sí, confirmar', value: 'confirm_yes' },
      { label: '✏️ Editar productos', value: 'confirm_edit_cart' },
      { label: '📝 Editar nota', value: 'confirm_edit_note' },
      { label: '❌ No, regresar', value: 'confirm_no' },
    ],
  });
  assert.ok(actionMessages.every((message) => message.kind === 'buttons'));
  assert.deepEqual(actionMessages.flatMap((message) => message.buttons.map((button) => button.title)), [
    '👉 ✅ Confirmar', '👉 ✏️ Editar pedido', '👉 📝 Editar nota', '👉 Regresar',
  ]);
  assert.ok(actionMessages.every((message) => message.buttons.length <= 3));

  const catalogMessages = buildMessages({
    products: [
      { id: 1, name: 'Hamburguesa BBQ', priceLabel: '$149.00' },
      { id: 2, name: 'Papas grandes', priceLabel: '$99.00' },
      { id: 3, name: 'Refresco', priceLabel: '$35.00' },
      { id: 4, name: 'Postre', priceLabel: '$59.00' },
    ],
    options: [{ label: '➕ Agregar otro', value: 'more_products' }, { label: '🛒 Ver carrito', value: 'cart' }],
  });
  assert.equal(catalogMessages[0].kind, 'list');
  assert.equal(catalogMessages[1].kind, 'buttons');
  assert.deepEqual(catalogMessages[1].buttons.map((button) => button.title), ['👉 ➕ Agregar otro', '👉 🛒 Ver carrito']);
});

test('WhatsApp separa upsell, acciones de salida y solicitud nativa de ubicación', () => {
  const route = require('../src/routes/whatsapp');
  const buildMessages = route.whatsappInteractiveMessages;
  const messages = buildMessages({
    options: [
      { label: '➕ Aros de Cebolla ($15.00)', value: 'upsell_add|promo-1|21' },
      { label: '➕ Tocino ($25.00)', value: 'upsell_add|promo-1|22' },
      { label: '➡️ Siguiente ofrecimiento', value: 'upsell_next|promo-1' },
      { label: '✅ Sería todo, gracias.', value: 'upsell_continue' },
      { label: '📍 Compartir ubicación', value: 'share_location' },
    ],
  });

  assert.equal(messages.filter((message) => message.kind === 'list').length, 1);
  const list = messages.find((message) => message.kind === 'list');
  assert.equal(list.interactive.action.button, 'Ver complementos');
  assert.equal(list.interactive.action.sections[0].rows.length, 2);
  assert.equal(messages.filter((message) => message.kind === 'location-request').length, 1);
  assert.equal(messages.find((message) => message.kind === 'location-request').interactive.type, 'locationrequestmessage');
  const actionButtons = messages.filter((message) => message.kind === 'buttons').flatMap((message) => message.buttons);
  assert.deepEqual(actionButtons.map((button) => button.title), ['👉 ➡️ Siguiente', '👉 Finalizar']);
});

test('WhatsApp expone un resumen analítico filtrable por fechas', () => {
  const route = source('src/routes/whatsapp.js');
  const html = source('public/app.html');
  const client = source('public/js/whatsapp.js');
  const styles = source('public/css/styles.css');
  assert.match(route, /router\.get\('\/analytics'/);
  assert.match(route, /COUNT\(DISTINCT m\.conversation_id\)/);
  assert.match(route, /messages_with_cost/);
  assert.match(route, /source_channel, ''\)\) = 'whatsapp'/);
  assert.match(html, /data-whatsapp-tab="analytics"/);
  assert.match(html, /whatsappAnalyticsRange/);
  assert.match(html, /whatsappMetricChats/);
  assert.match(html, /whatsappMetricMessages/);
  assert.match(html, /whatsappMetricOrders/);
  assert.match(client, /\/api\/whatsapp\/analytics/);
  assert.match(client, /whatsappAnalyticsLocalKey/);
  assert.match(styles, /whatsapp-analytics-grid/);
  assert.match(styles, /whatsapp-metric-card\.messages/);
});
