const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeConversionSettings,
  fetchAutomaticRate,
  convertedAmount,
  convertedMoney,
  formatCurrencyAmount,
  conversionRateLabel,
} = require('../src/utils/currencyConversion');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('convierte importes sin alterar el valor base', () => {
  const conversion = normalizeConversionSettings({
    currency: 'USD',
    currency_conversion_enabled: '1',
    currency_conversion_target: 'VES',
    currency_conversion_mode: 'manual',
    currency_conversion_rate: '750',
    currency_conversion_chatbot_enabled: '1',
  }, 'chatbot');
  assert.equal(conversion.enabled, true);
  assert.equal(convertedAmount(10, conversion), 7500);
  assert.match(convertedMoney(10, conversion), /7[.,]500/);
  assert.match(convertedMoney(10, conversion), /^Bs /);
  assert.equal(formatCurrencyAmount(12.5, 'VES'), 'Bs 12,50');
  assert.match(conversionRateLabel(conversion), /^1 USD = Bs 750,00$/);
});

test('respeta el alcance independiente para chatbot y punto de venta', () => {
  const raw = {
    currency: 'USD', currency_conversion_enabled: '1', currency_conversion_target: 'VES',
    currency_conversion_mode: 'manual', currency_conversion_rate: '750',
    currency_conversion_chatbot_enabled: '1', currency_conversion_pos_enabled: '0',
  };
  assert.equal(normalizeConversionSettings(raw, 'chatbot').enabled, true);
  assert.equal(normalizeConversionSettings(raw, 'pos').enabled, false);
});

test('consulta la tasa automática y valida la respuesta del proveedor', async () => {
  const result = await fetchAutomaticRate('USD', 'VES', async (url) => ({
    ok: true,
    async json() { return { result: 'success', rates: { VES: 750 } }; },
  }));
  assert.equal(result.rate, 750);
  assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('Mi negocio permite elegir tasa, moneda destino y alcance', () => {
  const html = read('public', 'app.html');
  const app = read('public', 'js', 'app.js');
  const settings = read('src', 'routes', 'settings.js');
  for (const id of ['cfgCurrencyConversionEnabled', 'cfgCurrencyConversionTarget', 'cfgCurrencyConversionRate', 'cfgCurrencyConversionChatbot', 'cfgCurrencyConversionPos']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(app, /currency_conversion_chatbot_enabled/);
  assert.match(app, /currency_conversion_pos_enabled/);
  assert.match(settings, /currency-conversion\/refresh/);
  assert.match(settings, /fetchAutomaticRate\(baseCurrency, targetCurrency\)/);
  assert.match(app, /baseCurrency: \$\('#cfgCurrency'\)\.value/);
  assert.match(app, /button\.dataset\.conversionMode === 'automatic'/);
});

test('chatbot y POS muestran el equivalente sólo como información', () => {
  const engine = read('src', 'chatbot', 'engine.js');
  const app = read('public', 'js', 'app.js');
  assert.match(engine, /Equivalente informativo/);
  assert.match(engine, /Tasa de cambio/);
  assert.match(engine, /Equivalente informativo: \*\$\{label\}\*/);
  assert.match(engine, /convertedTotalLabel/);
  assert.match(engine, /exchangeRateLabel/);
  assert.match(read('public', 'chat.html'), /class="cart-rate">Tasa de cambio/);
  assert.match(app, /convertedMoneyHtml\(total, 'pos'\)/);
  assert.match(app, /Equivalente informativo/);
  assert.match(app, /currencyConversionRateLabel\('pos'\)/);
  assert.match(app, /<b>\$\{esc\(fmtConvertedMoney\(total, 'pos'\)\)\}<\/b><br><small>Tasa de cambio:/);
});
