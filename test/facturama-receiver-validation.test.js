const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src/routes/invoicing.js'), 'utf8');
const start = source.indexOf('function withoutFiscalVowelAccents(');
const end = source.indexOf('function relationFromInput(', start);
assert.ok(start >= 0 && end > start);
const context = {};
vm.runInNewContext(`${source.slice(start, end)}\nthis.validate = validateReceiverWithFacturama;`, context);

const receiver = (name) => ({ rfc: 'ROMD950110432', name, postalCode: '23456', fiscalRegime: '626' });

test('reintenta sin acentos sólo tras rechazo del nombre y conserva la forma aceptada por Facturama', async () => {
  const calls = [];
  const facturama = { validateReceiver: async (input) => {
    calls.push(input.name);
    return { ExistRfc: true, MatchName: input.name === 'DIANA GUADALUPE RODRIGUEZ MACIAS', MatchZipCode: true, MatchFiscalRegime: true };
  } };
  const fiscalReceiver = receiver('DIANA GUADALUPE RODRÍGUEZ MACÍAS');
  await context.validate(facturama, fiscalReceiver);
  assert.deepEqual(calls, ['DIANA GUADALUPE RODRÍGUEZ MACÍAS', 'DIANA GUADALUPE RODRIGUEZ MACIAS']);
  assert.equal(fiscalReceiver.name, 'DIANA GUADALUPE RODRIGUEZ MACIAS');
});

test('no altera nombres con Ñ ni inventa coincidencias que Facturama rechaza', async () => {
  assert.equal(context.withoutFiscalVowelAccents('MUÑOZ MARÍA'), 'MUÑOZ MARIA');
  const calls = [];
  const facturama = { validateReceiver: async (input) => {
    calls.push(input.name);
    return { ExistRfc: true, MatchName: false, MatchZipCode: true, MatchFiscalRegime: true };
  } };
  const fiscalReceiver = receiver('GUADALUPE RODRÍGUEZ MACÍAS');
  await assert.rejects(context.validate(facturama, fiscalReceiver), /nombre o razón social no coincide/);
  assert.deepEqual(calls, ['GUADALUPE RODRÍGUEZ MACÍAS', 'GUADALUPE RODRIGUEZ MACIAS']);
  assert.equal(fiscalReceiver.name, 'GUADALUPE RODRÍGUEZ MACÍAS');
});

test('no reintenta cuando el nombre original ya coincide', async () => {
  let calls = 0;
  const facturama = { validateReceiver: async () => {
    calls += 1;
    return { ExistRfc: true, MatchName: true, MatchZipCode: true, MatchFiscalRegime: true };
  } };
  await context.validate(facturama, receiver('DIANA GUADALUPE RODRIGUEZ MACIAS'));
  assert.equal(calls, 1);
});
