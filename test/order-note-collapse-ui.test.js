const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');

test('las notas largas de pedidos se muestran compactas y permiten ver el contenido completo', () => {
  assert.match(appJs, /data-collapsible-note/);
  assert.match(appJs, /class="order-note-toggle"/);
  assert.match(appJs, /expanded \? 'Ver menos' : 'Ver más'/);
  assert.match(styles, /-webkit-line-clamp:\s*3/);
  assert.match(styles, /\.order-note-callout\.is-expanded \.order-note-text/);
});
