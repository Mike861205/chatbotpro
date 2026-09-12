const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyPromotions,
  isPromotionActive,
  normalizePromotion,
} = require('../src/utils/promotions');
const { buildFacturamaItems } = require('../src/utils/invoicing');

function promo(overrides = {}) {
  return normalizePromotion({
    id: 1,
    name: 'Oferta',
    type: 'percentage',
    value: 10,
    buy_qty: 0,
    pay_qty: 0,
    buy_pay_rule: 'same_product',
    all_products: 0,
    days_of_week: '[]',
    start_time: '00:00',
    end_time: '23:59',
    pos_enabled: 1,
    chatbot_enabled: 1,
    active: 1,
    priority: 0,
    ...overrides,
  }, overrides.productIds || [7]);
}

test('calcula porcentaje, monto fijo y precio especial sin descontar modificadores', () => {
  const line = { id: 7, name: 'Hamburguesa', price: 120, modifiersExtraPrice: 20, qty: 2 };
  const percentage = applyPromotions([line], [promo({ value: 25 })])[0];
  assert.equal(percentage.lineSubtotal, 240);
  assert.equal(percentage.discountAmount, 50);
  assert.equal(percentage.lineTotal, 190);
  assert.equal(percentage.price, 95);

  const fixed = applyPromotions([line], [promo({ type: 'fixed_amount', value: 15 })])[0];
  assert.equal(fixed.lineTotal, 210);

  const special = applyPromotions([line], [promo({ type: 'fixed_price', value: 80 })])[0];
  assert.equal(special.lineTotal, 200);
});

test('2x1 y 3x2 descuentan sólo grupos completos y conservan snapshot auditable', () => {
  const twoForOne = applyPromotions(
    [{ id: 7, name: 'Taco', price: 30, qty: 5 }],
    [promo({ type: 'buy_x_pay_y', buy_qty: 2, pay_qty: 1 })]
  )[0];
  assert.equal(twoForOne.lineSubtotal, 150);
  assert.equal(twoForOne.discountAmount, 60);
  assert.equal(twoForOne.lineTotal, 90);
  assert.equal(twoForOne.promotion.label, '2x1');

  const threeForTwo = applyPromotions(
    [{ id: 7, price: 30, qty: 4 }],
    [promo({ type: 'buy_x_pay_y', buy_qty: 3, pay_qty: 2 })]
  )[0];
  assert.equal(threeForTwo.discountAmount, 30);
  assert.equal(threeForTwo.lineTotal, 90);
});

test('compra X paga Y puede cobrar el mayor y bonificar el menor entre productos distintos', () => {
  const promotion = promo({
    type: 'buy_x_pay_y', buy_qty: 2, pay_qty: 1,
    buy_pay_rule: 'lowest_price_free', productIds: [7, 8],
  });
  const result = applyPromotions([
    { id: 7, name: 'Premium', price: 120, qty: 1 },
    { id: 8, name: 'Clásico', price: 70, qty: 1 },
  ], [promotion]);
  assert.equal(result.reduce((sum, item) => sum + item.lineTotal, 0), 120);
  assert.equal(result[0].discountAmount, 0);
  assert.equal(result[1].discountAmount, 70);
  assert.equal(result[1].promotion.buyPayRule, 'lowest_price_free');
  assert.match(result[1].promotion.label, /menor precio/);
});

test('compra X paga Y permite bonificar el mayor como beneficio agresivo', () => {
  const promotion = promo({
    type: 'buy_x_pay_y', buy_qty: 2, pay_qty: 1,
    buy_pay_rule: 'highest_price_free', productIds: [7, 8],
  });
  const result = applyPromotions([
    { id: 7, price: 120, qty: 1 },
    { id: 8, price: 70, qty: 1 },
  ], [promotion]);
  assert.equal(result.reduce((sum, item) => sum + item.lineTotal, 0), 70);
  assert.equal(result[0].discountAmount, 120);
  assert.equal(result[1].discountAmount, 0);
});

test('las reglas mixtas cobran extras y no se acumulan con otra promoción', () => {
  const mixed = promo({
    id: 10, type: 'buy_x_pay_y', buy_qty: 2, pay_qty: 1,
    buy_pay_rule: 'lowest_price_free', productIds: [7, 8],
  });
  const percentage = promo({ id: 11, value: 20, productIds: [7, 8] });
  const result = applyPromotions([
    { id: 7, price: 120, qty: 1 },
    { id: 8, price: 70, modifiersExtraPrice: 20, qty: 1 },
  ], [mixed, percentage]);
  assert.equal(result.reduce((sum, item) => sum + item.lineTotal, 0), 140);
  assert.equal(result[0].discountAmount, 0);
  assert.equal(result[1].discountAmount, 50);
  assert.equal(result[0].promotion.id, 10);
  assert.equal(result[1].promotion.id, 10);
});

test('la opción histórica conserva grupos separados por producto', () => {
  const promotion = promo({
    type: 'buy_x_pay_y', buy_qty: 2, pay_qty: 1,
    buy_pay_rule: 'same_product', productIds: [7, 8],
  });
  const result = applyPromotions([
    { id: 7, price: 120, qty: 1 },
    { id: 8, price: 70, qty: 1 },
  ], [promotion]);
  assert.equal(result.reduce((sum, item) => sum + item.lineTotal, 0), 190);
  assert.equal(result.some((item) => item.promotion), false);
});

test('si coinciden promociones aplica automáticamente la de mayor ahorro', () => {
  const result = applyPromotions(
    [{ id: 7, price: 100, qty: 2 }],
    [promo({ id: 1, value: 10 }), promo({ id: 2, value: 30, priority: 1 })]
  )[0];
  assert.equal(result.discountAmount, 60);
  assert.equal(result.promotion.id, 2);
});

test('una promoción por categoría cubre sus productos actuales y futuros sin afectar otras categorías', () => {
  const categoryPromotion = promo({ productIds: [], category_ids: '[4]', value: 20 });
  const [covered, excluded] = applyPromotions(
    [{ id: 101, categoryId: 4, price: 100, qty: 1 }, { id: 102, categoryId: 9, price: 100, qty: 1 }],
    [categoryPromotion]
  );
  assert.equal(covered.lineTotal, 80);
  assert.equal(covered.promotion.id, 1);
  assert.equal(excluded.lineTotal, 100);
  assert.equal(excluded.promotion, undefined);
});

test('en ahorro idéntico desempata por prioridad y después por actualización más reciente', () => {
  const lowerPriority = promo({ id: 1, value: 20, priority: 2, updated_at: '2026-09-09T12:00:00Z' });
  const higherPriority = promo({ id: 2, value: 20, priority: 5, updated_at: '2026-09-08T12:00:00Z' });
  const priorityWinner = applyPromotions([{ id: 7, price: 100, qty: 1 }], [lowerPriority, higherPriority])[0];
  assert.equal(priorityWinner.promotion.id, 2);

  const older = promo({ id: 3, value: 20, priority: 5, updated_at: '2026-09-08T12:00:00Z' });
  const newer = promo({ id: 4, value: 20, priority: 5, updated_at: '2026-09-09T12:00:00Z' });
  const recentWinner = applyPromotions([{ id: 7, price: 100, qty: 1 }], [older, newer])[0];
  assert.equal(recentWinner.promotion.id, 4);
});

test('respeta canal, fechas, días y horarios del huso del tenant', () => {
  const mondayNoonUtc = new Date('2026-09-07T18:30:00.000Z'); // 12:30 Chihuahua
  const scheduled = promo({
    days_of_week: '[1]', starts_on: '2026-09-01', ends_on: '2026-09-30',
    start_time: '12:00', end_time: '13:00', chatbot_enabled: 0,
  });
  assert.equal(isPromotionActive(scheduled, 'pos', mondayNoonUtc, 'America/Chihuahua'), true);
  assert.equal(isPromotionActive(scheduled, 'chatbot', mondayNoonUtc, 'America/Chihuahua'), false);
  assert.equal(isPromotionActive(scheduled, 'pos', new Date('2026-09-07T20:30:00.000Z'), 'America/Chihuahua'), false);
});

test('el precio promocional guardado cuadra con los conceptos de facturación', () => {
  const line = applyPromotions([{ id: 7, name: 'Combo', price: 100, qty: 2 }], [promo({ value: 25 })])[0];
  const profile = {
    default_product_code: '90101501', default_unit_code: 'E48', default_unit_name: 'Unidad de servicio',
    default_tax_object: '02', default_iva_rate: 0.16, default_isr_rate: 0,
  };
  const items = buildFacturamaItems({ items: [line], total: 150, delivery_fee: 0 }, new Map(), profile);
  assert.equal(Math.round(items.reduce((sum, item) => sum + item.Total, 0) * 100) / 100, 150);
});

test('el módulo está montado, es responsivo y aparece en permisos y navegación', () => {
  const root = path.join(__dirname, '..');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'public', 'chat.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');
  const modules = fs.readFileSync(path.join(root, 'src', 'utils', 'modules.js'), 'utf8');
  const promotionRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'promotions.js'), 'utf8');
  assert.match(server, /app\.use\('\/api\/promotions'/);
  assert.match(html, /data-view="promociones"/);
  assert.match(html, /id="view-promociones"/);
  assert.match(html, /id="promoPosEnabled"/);
  assert.match(html, /id="promoChatbotEnabled"/);
  assert.match(html, /id="promoCategoryPicker"/);
  assert.match(html, /Primero se aplica siempre el mayor ahorro/);
  assert.match(chat, /promo-subtitle[\s\S]*PROMOCIÓN/);
  assert.match(chat, /has-promotion[\s\S]*chatPromoNeon/);
  assert.match(chat, /@media \(max-width: 430px\)[\s\S]*\.prod \.pright/s);
  assert.match(chat, /value === 'menu' \|\| value === 'promotions'/);
  assert.match(appJs, /pos-promo-subtitle[\s\S]*PROMOCIÓN/);
  assert.match(appJs, /pos-prod \$\{product\.activePromotion \? 'has-promotion'/);
  assert.match(appJs, /categoryIds/);
  assert.match(appJs, /name="promoBuyPayRule"/);
  assert.match(appJs, /Cobra el de mayor precio/);
  const engine = fs.readFileSync(path.join(root, 'src', 'chatbot', 'engine.js'), 'utf8');
  assert.match(engine, /🔥 Promociones[\s\S]*value: 'promotions'/);
  assert.match(engine, /showPromotions/);
  assert.match(css, /@media\(max-width:720px\).*\.promo-grid\{grid-template-columns:1fr\}/s);
  assert.match(css, /posPromoNeon/);
  assert.match(css, /@media\(max-width:480px\).*\.pos-promo-kind/s);
  assert.match(modules, /\['promociones', 'Promociones'\]/);
  const schema = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
  assert.match(schema, /buy_pay_rule TEXT NOT NULL DEFAULT 'same_product'/);
  assert.match(promotionRoute, /buy_pay_rule/);
  assert.match(promotionRoute, /BUY_PAY_RULES/);
});
