const test = require('node:test');
const assert = require('node:assert/strict');
process.env.WHATSAPP_BOT_GATEWAY_SECRET = '0123456789abcdef0123456789abcdef';
const { app, incomingContent } = require('../src/whatsapp-bot/gateway');

test('una ubicación compartida se entrega al motor con coordenadas', () => {
  assert.deepEqual(incomingContent({ locationMessage: { degreesLatitude: 28.633, degreesLongitude: -106.069, name: 'Mi casa' } }), {
    text: 'geo:28.633,-106.069|Mi casa', type: 'location', image: undefined,
  });
  assert.equal(incomingContent({ conversation: 'Quiero pedir' }).text, 'Quiero pedir');
});

test('la pasarela local exige secreto y valida identificadores de sesión', async () => {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const unauthorized = await fetch(`${url}/sessions/unknown`);
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${url}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.WHATSAPP_BOT_GATEWAY_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: '../x', tenant: '../x' }),
    });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
