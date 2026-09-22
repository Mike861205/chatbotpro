const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadTenantOperationResetPreview,
  resetBlockerMessages,
  resetTenantOperations,
} = require('../src/utils/tenantOperationReset');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

function cleanPreviewRow(overrides = {}) {
  return {
    orders: 12,
    sales_total: 1450,
    pos_sessions: 2,
    cash_movements: 3,
    table_accounts: 1,
    table_rounds: 2,
    kds_states: 5,
    self_service_payments: 0,
    sales_audit_entries: 4,
    purchase_orders: 3,
    purchase_items: 8,
    purchase_audit_entries: 6,
    inventory_movements: 9,
    inventory_counts: 2,
    inventory_closures: 1,
    inventory_transfers: 2,
    inventory_transfer_items: 4,
    global_stock_rows: 3,
    branch_stock_rows: 7,
    open_pos_sessions: 0,
    open_table_accounts: 0,
    order_invoices: 0,
    global_invoice_links: 0,
    external_self_service_payments: 0,
    external_order_payments: 0,
    ...overrides,
  };
}

test('SuperAdmin expone el reinicio manual por tenant con confirmación reforzada', () => {
  const route = read('src', 'routes', 'superadmin.js');
  const html = read('public', 'superadmin.html');
  const client = read('public', 'js', 'superadmin.js');
  const database = read('src', 'db', 'index.js');

  assert.match(route, /router\.get\('\/tenants\/:id\/operation-reset-preview'/);
  assert.match(route, /router\.post\('\/tenants\/:id\/operation-reset'/);
  assert.match(route, /REINICIAR \$\{tenant\.slug\}/);
  assert.match(html, /id="saOperationResetModal"/);
  assert.match(html, /todas las ventas, compras e inventario existentes/i);
  assert.match(client, /data-sa-operation-reset/);
  assert.match(client, /acknowledge: true/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS tenant_operation_resets/);
});

test('la vista previa identifica datos operativos y bloqueadores sin modificar información', async () => {
  const preview = await loadTenantOperationResetPreview({ get: async () => cleanPreviewRow() });
  assert.equal(preview.sales.orders, 12);
  assert.equal(preview.purchases.orders, 3);
  assert.equal(preview.inventory.movements, 9);
  assert.deepEqual(resetBlockerMessages(preview), []);

  const blocked = await loadTenantOperationResetPreview({
    get: async () => cleanPreviewRow({ open_pos_sessions: 1, order_invoices: 2, external_order_payments: 1 }),
  });
  const messages = resetBlockerMessages(blocked).join(' ');
  assert.match(messages, /sesiones de caja/i);
  assert.match(messages, /CFDI/);
  assert.match(messages, /pagos externos/i);
});

test('el reinicio es atómico, conserva maestros y deja inventarios en cero', async () => {
  const statements = [];
  const tenant = { id: 42, slug: 'negocio-demo', business_name: 'Negocio Demo' };
  const tx = {
    async get(sql) {
      if (sql.includes('public.tenants')) return { id: tenant.id, slug: tenant.slug, business_name: tenant.business_name };
      return cleanPreviewRow();
    },
    async run(sql, params = []) {
      statements.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return { rowCount: 0 };
    },
  };
  const tenantDb = { tx: async (callback) => callback(tx) };
  const result = await resetTenantOperations(tenantDb, tenant, 'admin');
  const sql = statements.map((item) => item.sql).join('\n');

  assert.equal(result.sales.orders, 12);
  assert.match(sql, /DELETE FROM \{s\}\.orders/);
  assert.match(sql, /DELETE FROM \{s\}\.purchase_orders/);
  assert.match(sql, /DELETE FROM \{s\}\.inventory_movements/);
  assert.match(sql, /UPDATE \{s\}\.inventory_items SET initial_stock=0/);
  assert.match(sql, /UPDATE \{s\}\.branch_inventory SET quantity=0,initial_quantity=0/);
  assert.match(sql, /INSERT INTO public\.tenant_operation_resets/);
  assert.doesNotMatch(sql, /DELETE FROM \{s\}\.(products|customers|branches|settings)/);
});

test('el backend no borra nada cuando existen CFDI vinculados', async () => {
  const statements = [];
  const tenant = { id: 7, slug: 'facturado', business_name: 'Facturado' };
  const tx = {
    async get(sql) {
      if (sql.includes('public.tenants')) return { id: tenant.id, slug: tenant.slug, business_name: tenant.business_name };
      return cleanPreviewRow({ order_invoices: 1 });
    },
    async run(sql) { statements.push(String(sql)); },
  };
  const tenantDb = { tx: async (callback) => callback(tx) };

  await assert.rejects(() => resetTenantOperations(tenantDb, tenant, 'admin'), /CFDI/);
  assert.equal(statements.some((sql) => /DELETE FROM \{s\}/.test(sql)), false);
});
