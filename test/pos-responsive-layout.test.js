const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('alinea catálogo y checkout del POS y los mantiene cercanos en móvil', () => {
  const html = read('public/app.html');
  const css = read('public/css/styles.css');
  const client = read('public/js/app.js');
  const sessionIndex = html.indexOf('id="posSessionCard"');
  const shellIndex = html.indexOf('class="pos-shell"');

  assert.ok(sessionIndex > 0 && sessionIndex < shellIndex, 'la caja activa debe ocupar una fila antes del grid');
  assert.match(css, /\.pos-shell\s*\{[^}]*height:\s*clamp\(560px, calc\(100dvh - 150px\), 820px\)/s);
  assert.match(css, /\.pos-catalog-card\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.pos-checkout-card\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.pos-catalog-head\s*\{[^}]*position:\s*sticky;/s);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(320px, 38vw\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.pos-catalog-card\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto;/);
  assert.match(css, /body\.sidebar-collapsed \.main\s*\{[^}]*margin-left:\s*0;[^}]*max-width:\s*100vw;/s);
  assert.match(client, /SIDEBAR_COLLAPSED_KEY = 'cbpSidebarCollapsed'/);
  assert.match(css, /@media \(max-width: 360px\)[\s\S]*\.pos-grid\s*\{\s*grid-template-columns:\s*1fr;/);
});