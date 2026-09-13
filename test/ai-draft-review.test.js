const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/styles.css'), 'utf8');

test('la vista previa abre desde el análisis los productos con variantes u opciones', () => {
  assert.match(app, /_expanded: Boolean\(item\?\.variants\?\.length \|\| item\?\.modifierGroups\?\.length\)/);
  assert.match(app, /aria-expanded="\$\{Boolean\(item\._expanded\)\}"/);
  assert.match(app, /item\._expanded \? '' : 'hidden'/);
});

test('muestra los precios de cada variante junto al precio de referencia y los actualiza al editar', () => {
  assert.match(html, /<th>Precio \/ variantes<\/th>/);
  assert.match(app, /Precio de referencia/);
  assert.match(app, /ai-variant-price-list/);
  assert.match(app, /Al vender se cobra la variante elegida/);
  assert.match(app, /summary\.innerHTML = AI_PRODUCTS_DRAFT\[i\]\.variants\.map/);
  assert.match(css, /\.ai-variant-price-chip/);
});
