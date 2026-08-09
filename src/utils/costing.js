const ensuredSchemas = new Set();

async function ensureCostingSchema(t) {
  if (!t?.schema || ensuredSchemas.has(t.schema)) return;
  await t.run(`
    ALTER TABLE {s}.products ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,4) DEFAULT 0;
    ALTER TABLE {s}.inventory_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,4);
    ALTER TABLE {s}.inventory_movements ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,4);
    ALTER TABLE {s}.orders ADD COLUMN IF NOT EXISTS cogs_total NUMERIC(14,4);
    CREATE TABLE IF NOT EXISTS {s}.business_expenses (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER,
      branch_name TEXT DEFAULT '',
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      concept TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_business_expenses_date ON {s}.business_expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_business_expenses_branch ON {s}.business_expenses(branch_id);
  `);
  ensuredSchemas.add(t.schema);
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function preciseCost(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(4)) : 0;
}

function itemsCost(items) {
  const rows = Array.isArray(items) ? items : [];
  return money(rows.reduce((sum, item) => {
    const qty = Math.max(0, Number(item?.qty || item?.quantity || 0));
    return sum + preciseCost(item?.unitCost ?? item?.unit_cost) * qty;
  }, 0));
}

module.exports = { ensureCostingSchema, money, preciseCost, itemsCost };
