const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeProductSaleDays,
  weekdayInTimeZone,
  isProductAvailableToday,
  productAvailabilityFields,
} = require('../src/utils/productAvailability');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('normaliza la programación semanal y conserva todos los días como valor predeterminado', () => {
  assert.deepEqual(normalizeProductSaleDays(undefined), []);
  assert.deepEqual(normalizeProductSaleDays('[5,1,1,3]'), [1, 3, 5]);
  assert.throws(() => normalizeProductSaleDays('[8]', { strict: true }), /entre domingo y sábado/);
  assert.throws(() => normalizeProductSaleDays('no-json', { strict: true }), /formato válido/);
});

test('calcula el día usando la zona horaria del tenant', () => {
  const instant = new Date('2026-09-15T05:30:00.000Z');
  assert.equal(weekdayInTimeZone(instant, 'America/Chihuahua'), 1);
  assert.equal(weekdayInTimeZone(instant, 'Asia/Tokyo'), 2);
  assert.equal(isProductAvailableToday({ sale_days: '[1,3,5]' }, instant, 'America/Chihuahua'), true);
  assert.equal(isProductAvailableToday({ sale_days: '[2,4]' }, instant, 'America/Chihuahua'), false);
  assert.equal(isProductAvailableToday({ sale_days: '[]' }, instant, 'America/Chihuahua'), true);
  assert.deepEqual(productAvailabilityFields({ sale_days: '[1,3,5]' }, instant, 'America/Chihuahua'), {
    saleDays: [1, 3, 5], availableToday: true,
  });
});

test('la programación se persiste y se aplica en POS, chatbot y autoservicio', () => {
  const db = read('src', 'db', 'index.js');
  const products = read('src', 'routes', 'products.js');
  const pos = read('src', 'routes', 'pos.js');
  const chatbot = read('src', 'chatbot', 'engine.js');
  const selfService = read('src', 'routes', 'selfService.js');

  assert.match(db, /products ADD COLUMN IF NOT EXISTS sale_days TEXT NOT NULL DEFAULT '\[\]'/);
  assert.match(products, /JSON\.stringify\(saleDays\)/);
  assert.match(products, /productAvailabilityFields\(p, new Date\(\), req\.timezone\)/);
  assert.match(pos, /availableProducts = products\.filter\(\(product\) => isProductAvailableToday/);
  assert.match(pos, /no está disponible para venta hoy/);
  assert.match(chatbot, /filter\(\(product\) => isProductAvailableToday/);
  assert.match(chatbot, /Al cambiar el día/);
  assert.match(selfService, /availableProducts = products\.filter\(\(product\) => isProductAvailableToday/);
});

test('Productos ofrece configuración responsiva y muestra los días en sus tarjetas', () => {
  const html = read('public', 'app.html');
  const app = read('public', 'js', 'app.js');
  const css = read('public', 'css', 'styles.css');

  assert.match(html, /id="pSaleScheduleEnabled"/);
  assert.match(html, /name="pSaleDay" value="1"/);
  assert.match(html, /name="pSaleDay" value="0"/);
  assert.match(app, /fd\.append\('saleDays', JSON\.stringify\(saleDays\)\)/);
  assert.match(app, /function productSaleScheduleBadge\(product, compact = false\)/);
  assert.match(app, /No se vende hoy/);
  assert.match(css, /\.product-sale-days \{ display: grid; grid-template-columns: repeat\(7/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]+\.product-sale-days \{ grid-template-columns: repeat\(4/);
});
