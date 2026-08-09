const { preciseCost } = require('./costing');

const ensuredSchemas = new Set();

function n(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : 0;
}

function parseItems(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function itemTotals(items) {
  const totals = new Map();
  for (const item of parseItems(items)) {
    const productId = Number(item?.id || item?.product_id || 0);
    const quantity = Math.max(0, n(item?.qty || item?.quantity || 0));
    if (productId && quantity) totals.set(productId, n((totals.get(productId) || 0) + quantity));
  }
  return totals;
}

async function ensureBranchStockSchema(t) {
  if (!t?.schema || ensuredSchemas.has(t.schema)) return;
  await t.run(`
    ALTER TABLE {s}.branch_inventory ADD COLUMN IF NOT EXISTS initial_quantity NUMERIC(14,4) NOT NULL DEFAULT 0;
    ALTER TABLE {s}.branch_inventory ADD COLUMN IF NOT EXISTS baseline_started_at TIMESTAMPTZ;
    ALTER TABLE {s}.inventory_counts ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    ALTER TABLE {s}.orders ADD COLUMN IF NOT EXISTS branch_stock_applied INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_branch_inventory_product ON {s}.branch_inventory(product_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_counts_branch ON {s}.inventory_counts(branch_id, product_id, counted_at DESC);
  `);
  ensuredSchemas.add(t.schema);
}

async function isBranchStockInitialized(t) {
  const row = await t.get(`SELECT value FROM {s}.settings WHERE key='branch_inventory_initialized_at'`);
  return Boolean(row?.value);
}

async function calculateGlobalStocks(t) {
  const [products, items, movements, orders, globalBaselineRow] = await Promise.all([
    t.all('SELECT id FROM {s}.products WHERE active=1 ORDER BY id'),
    t.all('SELECT product_id, initial_stock::float AS initial_stock, baseline_started_at FROM {s}.inventory_items'),
    t.all('SELECT product_id, type, quantity::float AS quantity, created_at FROM {s}.inventory_movements'),
    t.all("SELECT items, created_at FROM {s}.orders WHERE status!='cancelado'"),
    t.get(`SELECT value FROM {s}.settings WHERE key='inventory_global_baseline_started_at'`),
  ]);
  const globalBaseline = globalBaselineRow?.value ? new Date(globalBaselineRow.value) : null;
  const itemMap = new Map(items.map((row) => [Number(row.product_id), row]));
  const result = new Map(products.map((row) => [Number(row.id), n(itemMap.get(Number(row.id))?.initial_stock || 0)]));
  const baselineFor = (productId) => {
    const value = itemMap.get(productId)?.baseline_started_at;
    return value ? new Date(value) : globalBaseline;
  };
  for (const movement of movements) {
    const productId = Number(movement.product_id); const baseline = baselineFor(productId);
    if (baseline && new Date(movement.created_at) < baseline) continue;
    const signed = movement.type === 'entrada' ? n(movement.quantity) : -n(movement.quantity);
    result.set(productId, n((result.get(productId) || 0) + signed));
  }
  for (const order of orders) {
    const createdAt = new Date(order.created_at);
    for (const [productId, quantity] of itemTotals(order.items)) {
      const baseline = baselineFor(productId);
      if (baseline && createdAt < baseline) continue;
      result.set(productId, n((result.get(productId) || 0) - quantity));
    }
  }
  return result;
}

async function initializeBranchStock(t, actor = 'system') {
  await ensureBranchStockSchema(t);
  if (await isBranchStockInitialized(t)) return { initialized: false };
  return t.tx(async (tx) => {
    await tx.run(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${t.schema}:branch-stock-init`]);
    if (await isBranchStockInitialized(tx)) return { initialized: false };
    const branches = await tx.all('SELECT id,name FROM {s}.branches WHERE active=1 ORDER BY id');
    if (!branches.length) return { initialized: false, pendingBranch: true };
    const defaultBranch = branches[0];
    const globalStocks = await calculateGlobalStocks(tx);
    const existing = await tx.all('SELECT branch_id,product_id,quantity::float AS quantity FROM {s}.branch_inventory ORDER BY branch_id');
    const byProduct = new Map();
    for (const row of existing) {
      const productId = Number(row.product_id);
      if (!byProduct.has(productId)) byProduct.set(productId, []);
      byProduct.get(productId).push({ branchId: Number(row.branch_id), quantity: Math.max(0, n(row.quantity)) });
    }
    const allocations = [];
    for (const [productId, rawGlobal] of globalStocks) {
      const globalQuantity = Math.max(0, n(rawGlobal));
      const rows = byProduct.get(productId) || [];
      let excess = Math.max(0, n(rows.reduce((sum, row) => sum + row.quantity, 0) - globalQuantity));
      if (excess > 0) {
        for (const row of [...rows].sort((a, b) => b.quantity - a.quantity)) {
          const reduction = Math.min(row.quantity, excess);
          row.quantity = n(row.quantity - reduction); excess = n(excess - reduction);
          if (excess <= 0) break;
        }
      }
      const assigned = n(rows.reduce((sum, row) => sum + row.quantity, 0));
      const remainder = n(globalQuantity - assigned);
      let defaultRow = rows.find((row) => row.branchId === Number(defaultBranch.id));
      if (!defaultRow) { defaultRow = { branchId: Number(defaultBranch.id), quantity: 0 }; rows.push(defaultRow); }
      defaultRow.quantity = n(defaultRow.quantity + remainder);
      for (const row of rows) {
        await tx.run(`INSERT INTO {s}.branch_inventory (branch_id,product_id,quantity,initial_quantity,baseline_started_at,updated_at)
          VALUES ($1,$2,$3,$3,now(),now()) ON CONFLICT(branch_id,product_id) DO UPDATE
          SET quantity=EXCLUDED.quantity,initial_quantity=EXCLUDED.initial_quantity,baseline_started_at=now(),updated_at=now()`,
        [row.branchId, productId, Math.max(0, row.quantity)]);
      }
      allocations.push({ productId, globalQuantity, assignedToDefault: Math.max(0, remainder) });
    }
    await tx.run(`UPDATE {s}.orders SET branch_stock_applied=1 WHERE status!='cancelado' AND COALESCE(service_branch_id,pickup_branch_id) IS NOT NULL`);
    await tx.run(`INSERT INTO {s}.settings(key,value) VALUES('branch_inventory_initialized_at',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [new Date().toISOString()]);
    await tx.run(`INSERT INTO {s}.purchase_audit_log(entity_type,entity_id,action,payload,actor)
      VALUES('branch_stock',$1,'initialized',$2,$3)`, [Number(defaultBranch.id), JSON.stringify({ defaultBranch: defaultBranch.name, allocations }), actor]);
    return { initialized: true, defaultBranchId: Number(defaultBranch.id) };
  });
}

async function applyBranchSaleStock(t, branchId, items) {
  const id = Number(branchId || 0);
  if (!id || !(await isBranchStockInitialized(t))) return false;
  for (const [productId, quantity] of itemTotals(items)) {
    await t.run(`INSERT INTO {s}.branch_inventory(branch_id,product_id,quantity,initial_quantity,baseline_started_at,updated_at)
      VALUES($1,$2,-$3,0,now(),now()) ON CONFLICT(branch_id,product_id) DO UPDATE
      SET quantity={s}.branch_inventory.quantity-$3,updated_at=now()`, [id, productId, quantity]);
  }
  return true;
}

async function restoreBranchSaleStock(t, branchId, items) {
  const id = Number(branchId || 0);
  if (!id || !(await isBranchStockInitialized(t))) return false;
  for (const [productId, quantity] of itemTotals(items)) {
    await t.run(`INSERT INTO {s}.branch_inventory(branch_id,product_id,quantity,initial_quantity,baseline_started_at,updated_at)
      VALUES($1,$2,$3,0,now(),now()) ON CONFLICT(branch_id,product_id) DO UPDATE
      SET quantity={s}.branch_inventory.quantity+EXCLUDED.quantity,updated_at=now()`, [id, productId, quantity]);
  }
  return true;
}

module.exports = { ensureBranchStockSchema, initializeBranchStock, isBranchStockInitialized, applyBranchSaleStock, restoreBranchSaleStock, itemTotals, n, preciseCost };
