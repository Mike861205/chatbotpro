const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/routes/pos');
const bcrypt = require('bcryptjs');
const movementHandler = router.stack.find((layer) => layer.route?.path === '/movements' && layer.route.methods.post).route.stack.at(-1).handle;
const deleteMovementHandler = router.stack.find((layer) => layer.route?.path === '/movements/:id' && layer.route.methods.delete).route.stack.at(-1).handle;

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

test('el POS impide gastos sin categoría o con categoría inactiva antes de mover efectivo', async () => {
  let inserted = false;
  const tdb = {
    async get(sql) {
      if (sql.includes('FROM {s}.pos_sessions')) return { id: 11, opening_amount: 100 };
      if (sql.includes('FROM {s}.expense_categories')) return undefined;
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    async run() { inserted = true; },
  };
  const base = { user: { role: 'cashier', branchId: 7, username: 'caja7' }, tdb };
  for (const body of [{ kind: 'expense', amount: 10, note: 'Gas' }, { kind: 'expense', amount: 10, categoryId: 3, note: 'Gas' }]) {
    const res = response();
    await movementHandler({ ...base, body }, res, (error) => { throw error; });
    assert.equal(res.code, 400);
    assert.match(res.body.error, /categoría/);
  }
  assert.equal(inserted, false);
});

test('un NIP incorrecto impide borrar operaciones antes de abrir la transacción', async () => {
  const hash = bcrypt.hashSync('1234', 4);
  let transactionOpened = false;
  const res = response();
  await deleteMovementHandler({
    user: { role: 'cashier', branchId: 7, username: 'caja7' }, params: { id: '15' }, body: { pin: '9999' },
    tdb: {
      async all() { return [{ key: 'pos_movement_delete_require_pin', value: '1' }, { key: 'pos_authorization_pin_hash', value: hash }]; },
      async get() { return { value: hash }; },
      async tx() { transactionOpened = true; },
    },
  }, res, (error) => { throw error; });
  assert.equal(res.code, 403);
  assert.match(res.body.error, /NIP/);
  assert.equal(transactionOpened, false);
});
