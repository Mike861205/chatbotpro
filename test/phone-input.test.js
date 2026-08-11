const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'phone-input.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const { filterCountries, findCountry } = context.window.CBPPhoneInput;

const countries = [
  { code: 'MX', name: 'México', callingCode: '52' },
  { code: 'AR', name: 'Argentina', callingCode: '54' },
  { code: 'US', name: 'Estados Unidos', callingCode: '1' },
  { code: 'CA', name: 'Canadá', callingCode: '1' },
];

test('encuentra un país por nombre, ISO, lada o etiqueta completa', () => {
  assert.equal(findCountry(countries, 'México')?.code, 'MX');
  assert.equal(findCountry(countries, 'mexico')?.code, 'MX');
  assert.equal(findCountry(countries, 'MX')?.code, 'MX');
  assert.equal(findCountry(countries, '+52')?.code, 'MX');
  assert.equal(findCountry(countries, 'Argentina (+54)')?.code, 'AR');
});

test('no elige automáticamente una lada compartida o texto parcial', () => {
  assert.equal(findCountry(countries, '+1'), null);
  assert.equal(findCountry(countries, 'mex'), null);
  assert.equal(findCountry(countries, 'país inexistente'), null);
});

test('sugiere países mientras se escriben las primeras letras o la lada', () => {
  assert.deepEqual(Array.from(filterCountries(countries, 'mex')).map((item) => item.code), ['MX']);
  assert.deepEqual(Array.from(filterCountries(countries, 'arg')).map((item) => item.code), ['AR']);
  assert.deepEqual(Array.from(filterCountries(countries, '+52')).map((item) => item.code), ['MX']);
  assert.deepEqual(Array.from(filterCountries(countries, 'est')).map((item) => item.code), ['US']);
  assert.equal(filterCountries(countries, 'AR')[0]?.code, 'AR');
});
