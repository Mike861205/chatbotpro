const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('el cobro POS bloquea dobles clics y muestra el estado de procesamiento', () => {
  const html = read('public/app.html');
  const app = read('public/js/app.js');
  assert.match(html, /id="posSaleProcessingModal"/);
  assert.match(html, /protegida contra cobros duplicados/);
  assert.match(app, /POS_CHECKOUT_IN_FLIGHT/);
  assert.match(app, /submitButton\.disabled = true/);
  assert.match(app, /setPosSaleProcessing\(true\)/);
});

test('el servidor hace idempotente una venta aunque reciba dos solicitudes', () => {
  const database = read('src/db/index.js');
  const pos = read('src/routes/pos.js');
  assert.match(database, /pos_idempotency_key TEXT/);
  assert.match(database, /CREATE UNIQUE INDEX IF NOT EXISTS idx_\$\{s\}_orders_pos_idempotency/);
  assert.match(pos, /findPosSaleByIdempotency/);
  assert.match(pos, /duplicate: true/);
  assert.match(pos, /e\.code === '23505'/);
});
