const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeStoredPhone,
  normalizeInternationalPhone,
  phoneCountries,
} = require('../src/utils/phone');

test('normaliza un teléfono mexicano a E.164 y conserva país/lada', () => {
  const phone = normalizeInternationalPhone('624 137 0820', 'mx');
  assert.equal(phone.country, 'MX');
  assert.equal(phone.callingCode, '52');
  assert.equal(phone.e164, '+526241370820');
  assert.equal(phone.digits, '526241370820');
});

test('acepta números internacionales válidos de otros países', () => {
  const usa = normalizeInternationalPhone('(202) 555-0123', 'US');
  const spain = normalizeInternationalPhone('612 34 56 78', 'ES');
  assert.equal(usa.e164, '+12025550123');
  assert.equal(spain.e164, '+34612345678');
});

test('acepta un número pegado con lada completa o prefijo 00', () => {
  assert.equal(normalizeInternationalPhone('526241370820', 'MX').e164, '+526241370820');
  assert.equal(normalizeInternationalPhone('0034612345678', 'ES').e164, '+34612345678');
});

test('rechaza números repetidos, incompletos y secuenciales', () => {
  assert.throws(() => normalizeInternationalPhone('1111111111', 'MX'), /teléfono real|válido/);
  assert.throws(() => normalizeInternationalPhone('62413', 'MX'), /válido|incompleto/);
  assert.throws(() => normalizeInternationalPhone('1234567890', 'MX'), /teléfono real|válido/);
});

test('rechaza una lada internacional que no corresponde al país', () => {
  assert.throws(() => normalizeInternationalPhone('+526241370820', 'US'), /no corresponde/);
});

test('interpreta teléfonos históricos sin país como México', () => {
  const phone = describeStoredPhone('6241370820');
  assert.equal(phone.country, 'MX');
  assert.equal(phone.callingCode, '52');
  assert.equal(phone.e164, '+526241370820');
  assert.equal(phone.valid, true);
});

test('reconoce ladas internacionales en teléfonos históricos largos', () => {
  const phone = describeStoredPhone('59161311114');
  assert.equal(phone.country, 'BO');
  assert.equal(phone.callingCode, '591');
  assert.equal(phone.e164, '+59161311114');
  assert.equal(phone.valid, true);
});

test('el catálogo contiene país, nombre y lada', () => {
  const mexico = phoneCountries().find((country) => country.code === 'MX');
  assert.deepEqual(mexico, { code: 'MX', name: 'México', callingCode: '52' });
});
