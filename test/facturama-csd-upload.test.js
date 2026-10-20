const test = require('node:test');
const assert = require('node:assert/strict');
const { FacturamaClient } = require('../src/services/facturama');

test('crea un CSD nuevo y actualiza uno ya registrado con la operación de Facturama correspondiente', async () => {
  const client = new FacturamaClient({ username: 'test', password: 'test', baseUrl: 'https://example.test' });
  const calls = [];
  client.request = async (path, options) => { calls.push({ path, options }); return { ok: true }; };
  const csd = { rfc: 'RORD640103RAA', certificate: 'certificate', privateKey: 'private-key', privateKeyPassword: 'password' };

  await client.uploadCsd(csd);
  await client.uploadCsd({ ...csd, replace: true });

  assert.equal(calls[0].path, '/api-lite/csds');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].path, '/api-lite/csds/RORD640103RAA');
  assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(calls[0].options.body, calls[1].options.body);
});
