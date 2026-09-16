const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const appHtml = read('public', 'app.html');
const app = read('public', 'js', 'app.js');

test('la integración chatbot POS se guarda al cambiar el interruptor', () => {
  assert.match(app, /cfgPosChatIntegration'[\s\S]+addEventListener\('change'/);
  assert.match(app, /fd\.append\('chatbot_pos_integration_enabled', value\)[\s\S]+api\('\/api\/settings', \{ method: 'PUT', body: fd \}\)/);
  assert.match(app, /checkbox\.checked = previousValue === '1'/);
});

test('el interruptor queda separado del guardado de cuentas y medios de pago', () => {
  assert.match(appHtml, /id="savePaymentAccountsBtn"[\s\S]+<\/form>[\s\S]+id="cfgPosChatIntegration"/);

  const contactFormSubmit = app.match(/\$\('#contactForm'\)\.addEventListener\('submit'[\s\S]+?\n\}\);/u)?.[0] || '';
  assert.doesNotMatch(contactFormSubmit, /chatbot_pos_integration_enabled/);
});
