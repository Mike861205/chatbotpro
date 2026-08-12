const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');

test('todos los módulos del sidebar conservan icono y color propios', () => {
  const moduleLinks = appHtml.match(/<a[^>]+data-view="[^"]+"[^>]*>.*?<\/a>/g) || [];
  assert.ok(moduleLinks.length >= 14, 'debe encontrar todos los módulos principales');
  for (const link of moduleLinks) {
    assert.match(link, /data-color="[^"]+"/);
    assert.match(link, /class="nav-ic"/);
    assert.match(link, /class="ph-duotone /);
  }
  assert.match(appHtml, /href="\/notificaciones"[^>]+data-color="violet"/);
  for (const icon of [
    'ph-squares-four',
    'ph-clipboard-text',
    'ph-cash-register',
    'ph-cooking-pot',
    'ph-warehouse',
    'ph-robot',
    'ph-seal-check',
    'ph-broadcast',
  ]) {
    assert.match(appHtml, new RegExp(icon));
  }
});

test('los iconos duotono incluyen profundidad, doble color y estado activo', () => {
  assert.match(styles, /2026 duotone module icon system/);
  assert.match(styles, /--nav-accent:/);
  assert.match(styles, /\.nav-ic \.ph-duotone::before/);
  assert.match(styles, /\.sidebar nav a\.active \.nav-ic \.ph-duotone/);
  assert.match(styles, /a\[data-color="teal"\]/);
});
