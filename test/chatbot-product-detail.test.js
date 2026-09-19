const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chat = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');

test('chatbot exposes an accessible responsive product detail from product photos', () => {
  assert.match(chat, /id="productDetailModal" role="dialog" aria-modal="true"/);
  assert.match(chat, /button class="pimg"[\s\S]*?aria-label="Ver foto ampliada de/);
  assert.match(chat, /openProductDetail\(p,[\s\S]*?event\.currentTarget/);
  assert.match(chat, /@media \(max-width: 519px\)[\s\S]*?\.product-detail-card \{ width: 100%; height: 100dvh/);
  assert.match(chat, /event\.key === 'Escape'[\s\S]*?closeProductDetail/);
});

test('expanded product detail includes synchronized product data and quantity controls', () => {
  assert.match(chat, /id="productDetailImage"/);
  assert.match(chat, /id="productDetailDescription"/);
  assert.match(chat, /id="productDetailPrice"/);
  assert.match(chat, /id="productDetailMinus"/);
  assert.match(chat, /id="productDetailPlus"/);
  assert.match(chat, /syncProductDetailQuantity\(p\.id, draftQty, serverQty\)/);
  assert.match(chat, /controls\.setQuantity/);
  assert.match(chat, /controls\.sendQuantity\(\)/);
});
