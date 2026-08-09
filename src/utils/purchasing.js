const ensuredSchemas = new Set();

async function ensurePurchasingSchema(t) {
  if (!t?.schema || ensuredSchemas.has(t.schema)) return;
  await t.run(`
    CREATE TABLE IF NOT EXISTS {s}.suppliers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tax_id TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS {s}.purchase_orders (
      id SERIAL PRIMARY KEY,
      order_number TEXT UNIQUE,
      supplier_id INTEGER,
      supplier_name TEXT NOT NULL,
      branch_id INTEGER,
      branch_name TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      order_date DATE NOT NULL DEFAULT CURRENT_DATE,
      expected_date DATE,
      subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
      total NUMERIC(14,2) NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      received_by TEXT DEFAULT '',
      cancelled_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      received_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS {s}.purchase_order_items (
      id SERIAL PRIMARY KEY,
      purchase_order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity NUMERIC(14,4) NOT NULL,
      unit_cost NUMERIC(14,4) NOT NULL,
      line_total NUMERIC(14,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS {s}.branch_inventory (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity NUMERIC(14,4) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(branch_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS {s}.inventory_transfers (
      id SERIAL PRIMARY KEY,
      transfer_number TEXT UNIQUE,
      from_branch_id INTEGER NOT NULL,
      from_branch_name TEXT NOT NULL,
      to_branch_id INTEGER NOT NULL,
      to_branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      completed_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS {s}.inventory_transfer_items (
      id SERIAL PRIMARY KEY,
      transfer_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      quantity NUMERIC(14,4) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS {s}.purchase_audit_log (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      actor TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE {s}.inventory_movements ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    ALTER TABLE {s}.inventory_movements ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER;
    ALTER TABLE {s}.inventory_movements ADD COLUMN IF NOT EXISTS transfer_id INTEGER;
    ALTER TABLE {s}.inventory_movements ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual';
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_date ON {s}.purchase_orders(order_date);
    CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch ON {s}.purchase_orders(branch_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_items_order ON {s}.purchase_order_items(purchase_order_id);
    CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON {s}.inventory_transfer_items(transfer_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_audit_entity ON {s}.purchase_audit_log(entity_type, entity_id);
  `);
  ensuredSchemas.add(t.schema);
}

async function writePurchaseAudit(t, entityType, entityId, action, payload, actor) {
  await t.run(
    `INSERT INTO {s}.purchase_audit_log (entity_type, entity_id, action, payload, actor)
     VALUES ($1, $2, $3, $4, $5)`,
    [String(entityType), Number(entityId), String(action), JSON.stringify(payload || {}).slice(0, 12000), String(actor || '')]
  );
}

module.exports = { ensurePurchasingSchema, writePurchaseAudit };
