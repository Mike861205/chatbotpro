const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');

test('Productos mantiene visibles las altas manual, de categoría y por IA en móvil', () => {
  const toolbar = html.match(/<div class="prod-toolbar">([\s\S]*?)<div class="prod-grid"/i)?.[1] || '';

  assert.match(toolbar, /class="prod-toolbar-actions"/);
  assert.match(toolbar, /id="addCatBtn"[^>]*type="button"|type="button"[^>]*id="addCatBtn"/);
  assert.match(toolbar, /id="aiImportBtn"[^>]*aria-label="Cargar productos por IA"/);
  assert.match(toolbar, /id="addProdBtn"[^>]*aria-label="Nuevo producto"/);
  assert.doesNotMatch(toolbar, /style="display:flex;gap:10px"/);

  assert.match(css, /@media \(max-width: 920px\)[\s\S]*?\.prod-toolbar-actions\s*{[\s\S]*?grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.prod-view-switch\s*{[\s\S]*?grid-column:\s*1\s*\/\s*-1/);
  assert.match(css, /\.prod-action-label-full\s*{\s*display:\s*none/);
  assert.match(css, /\.prod-action-label-short\s*{\s*display:\s*inline/);
});

test('Los modales de producto manual e IA se contienen dentro del viewport móvil', () => {
  assert.match(html, /class="modal product-edit-modal"/);
  assert.match(html, /class="modal ai-product-modal"/);
  assert.match(css, /\.product-edit-modal,\s*\n\s*\.ai-product-modal\s*{[\s\S]*?width:\s*100%;[\s\S]*?overflow-x:\s*hidden/);
  assert.match(css, /\.product-edit-modal \.prod-modal-tabs\s*{[\s\S]*?overflow-x:\s*auto/);
  assert.match(css, /\.ai-product-modal \.ai-product-table-wrap\s*{[^}]*overflow-x:\s*auto/);
});
