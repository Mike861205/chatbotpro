// Capa de datos sobre Neon (PostgreSQL serverless).
// Aislamiento multi-tenant: cada negocio tiene su PROPIO SCHEMA en Postgres
// (t_<slug>). La capa pública (public) solo guarda tenants y usuarios.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const config = require('../config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: config.PG_SSL_REJECT_UNAUTHORIZED },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[pg] error de pool:', err.message));

// Reintenta la consulta hasta 3 veces con espera exponencial.
// Necesario porque Neon (serverless) pausa la BD tras inactividad
// y la primera conexión al despertar puede fallar o tardar demasiado.
async function q(sql, params = [], retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      const isRetryable =
        err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' ||
        err.code === '57P01' || // admin_shutdown (Neon pausa)
        err.message?.includes('Connection terminated') ||
        err.message?.includes('connect ETIMEDOUT') ||
        err.message?.includes('timeout');
      if (isRetryable && attempt < retries) {
        const wait = attempt * 800;
        console.warn(`[pg] intento ${attempt} fallido (${err.code || err.message}), reintentando en ${wait}ms…`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

function schemaName(slug) {
  return 't_' + String(slug).toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// Acceso a la BD aislada de un tenant: las consultas usan {s} como
// marcador del schema, que se sustituye por el identificador citado.
function tdb(slug) {
  const s = schemaName(slug);
  const fix = (sql) => sql.split('{s}').join(`"${s}"`);
  return {
    schema: s,
    all: async (sql, p = []) => (await q(fix(sql), p)).rows,
    get: async (sql, p = []) => (await q(fix(sql), p)).rows[0],
    run: async (sql, p = []) => q(fix(sql), p),
    tx: async (callback) => {
      const client = await pool.connect();
      const scoped = {
        schema: s,
        all: async (sql, p = []) => (await client.query(fix(sql), p)).rows,
        get: async (sql, p = []) => (await client.query(fix(sql), p)).rows[0],
        run: async (sql, p = []) => client.query(fix(sql), p),
      };
      try {
        await client.query('BEGIN');
        const result = await callback(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function initMaster() {
  await q(`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      business_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      phone_enc TEXT,
      phone_country TEXT DEFAULT '',
      phone_calling_code TEXT DEFAULT '',
      logo TEXT,
      primary_color TEXT DEFAULT '#ff6b35',
      account_status TEXT DEFAULT 'active',
      billing_status TEXT DEFAULT 'active',
      plan_name TEXT DEFAULT 'starter',
      billing_due_date DATE,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demo_leads (
      id SERIAL PRIMARY KEY,
      contact_name TEXT NOT NULL,
      phone_enc TEXT NOT NULL,
      phone_hash TEXT UNIQUE NOT NULL,
      phone_country TEXT DEFAULT '',
      phone_calling_code TEXT DEFAULT '',
      business_giro TEXT NOT NULL,
      source_page TEXT DEFAULT 'landing',
      demo_count INTEGER DEFAULT 1,
      first_seen_at TIMESTAMPTZ DEFAULT now(),
      last_seen_at TIMESTAMPTZ DEFAULT now(),
      last_demo_tenant_slug TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'owner',
      display_name TEXT DEFAULT '',
      branch_id INTEGER,
      cashier_slug TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS superadmin_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS superadmin_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS tenant_payments (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      method TEXT DEFAULT 'manual',
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      paid_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS module_usage (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      demo_lead_id INTEGER REFERENCES demo_leads(id) ON DELETE CASCADE,
      module_key TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status TEXT DEFAULT 'active'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'starter'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_due_date DATE`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_country TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_calling_code TEXT DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS contact_name TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS phone_enc TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS phone_hash TEXT`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS phone_country TEXT DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS phone_calling_code TEXT DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS business_giro TEXT NOT NULL DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS source_page TEXT DEFAULT 'landing'`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS demo_count INTEGER DEFAULT 1`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT now()`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now()`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS last_demo_tenant_slug TEXT DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now()`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_leads_phone_hash_unique ON demo_leads (phone_hash)`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'manual'`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ DEFAULT now()`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cashier_slug TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cashier_slug_unique ON users (cashier_slug) WHERE cashier_slug IS NOT NULL AND cashier_slug <> ''`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_module_usage_tenant_module ON module_usage (tenant_id, module_key) WHERE demo_lead_id IS NULL`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_module_usage_lead_module ON module_usage (demo_lead_id, module_key) WHERE demo_lead_id IS NOT NULL`);
  await q(`CREATE INDEX IF NOT EXISTS idx_module_usage_tenant_last_seen ON module_usage (tenant_id, last_seen_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_module_usage_lead_last_seen ON module_usage (demo_lead_id, last_seen_at DESC) WHERE demo_lead_id IS NOT NULL`);

  await ensureSuperAdminSeed();

  // Migra/asegura el esquema aislado de tenants existentes.
  const existing = await q('SELECT slug, business_name FROM tenants');
  for (const t of existing.rows) {
    await createTenantSchema(t.slug);
    await ensureTenantDefaults(t.slug, t.business_name);
  }

  console.log('[db] Neon conectado — schema maestro listo');
}

async function ensureSuperAdminSeed() {
  const username = String(process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase();
  const envPassword = String(process.env.SUPERADMIN_PASSWORD || '').trim();
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
    throw new Error('SUPERADMIN_USERNAME debe tener de 3 a 60 caracteres seguros');
  }
  if (envPassword) {
    if (envPassword.length < 12 || envPassword.length > 128) {
      throw new Error('SUPERADMIN_PASSWORD debe tener entre 12 y 128 caracteres');
    }
    const hash = await bcrypt.hash(envPassword, 12);
    await q(
      `INSERT INTO superadmin_users (username, password_hash, active)
       VALUES ($1, $2, 1)
       ON CONFLICT (username)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, active = 1`,
      [username, hash]
    );
    // Retira la cuenta heredada que versiones anteriores recreaban con una clave fija.
    await q(`UPDATE superadmin_users SET active = 0 WHERE username = 'mike' AND username <> $1`, [username]);
    console.log(`[superadmin] Credenciales administradas por entorno para ${username}`);
    return;
  }

  const existing = await q('SELECT id FROM superadmin_users LIMIT 1');
  if (existing.rows.length) {
    // Compatibilidad segura con instalaciones existentes: la credencial ya está
    // almacenada como hash bcrypt en Neon y no debe reemplazarse en cada deploy.
    console.log('[superadmin] Se conserva la cuenta administrativa existente');
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('SUPERADMIN_PASSWORD debe configurarse con al menos 12 caracteres para crear la cuenta inicial');
  }

  const generated = crypto.randomBytes(9).toString('base64url');
  const password = generated;
  const hash = await bcrypt.hash(password, 12);

  await q('INSERT INTO superadmin_users (username, password_hash, active) VALUES ($1, $2, 1)', [username, hash]);

  console.log('[superadmin] Usuario inicial creado');
  console.log(`[superadmin] Login: ${username}`);
  if (!envPassword) {
    console.log(`[superadmin] Password temporal generado: ${password}`);
    console.log('[superadmin] Define SUPERADMIN_PASSWORD en .env para fijar una contraseña permanente.');
  }
}

// Crea el schema aislado del tenant con todas sus tablas
async function createTenantSchema(slug) {
  const s = schemaName(slug);
  await q(`
    CREATE SCHEMA IF NOT EXISTS "${s}";
    CREATE TABLE IF NOT EXISTS "${s}".settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS "${s}".categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sort INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "${s}".products (
      id SERIAL PRIMARY KEY,
      category_id INTEGER,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      image TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".customers (
      id SERIAL PRIMARY KEY,
      name_enc TEXT,
      phone_enc TEXT,
      phone_hash TEXT,
      address_enc TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_cust_phone ON "${s}".customers(phone_hash);
    CREATE TABLE IF NOT EXISTS "${s}".orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER,
      items TEXT NOT NULL,
      subtotal NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      status TEXT DEFAULT 'pendiente',
      channel TEXT DEFAULT 'chatbot',
      delivery TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      order_notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".pos_sessions (
      id SERIAL PRIMARY KEY,
      status TEXT DEFAULT 'open',
      opening_amount NUMERIC(12,2) DEFAULT 0,
      closing_amount NUMERIC(12,2),
      expected_amount NUMERIC(12,2),
      difference_amount NUMERIC(12,2),
      branch_id INTEGER,
      branch_name TEXT,
      notes TEXT DEFAULT '',
      opened_by TEXT DEFAULT '',
      closed_by TEXT DEFAULT '',
      opened_at TIMESTAMPTZ DEFAULT now(),
      closed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS "${s}".pos_cash_movements (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".branches (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      reference TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,4) DEFAULT 0;
    CREATE TABLE IF NOT EXISTS "${s}".restaurant_tables (
      id SERIAL PRIMARY KEY,
      table_number INTEGER NOT NULL,
      label TEXT DEFAULT '',
      branch_id INTEGER NOT NULL DEFAULT 0,
      position_x INTEGER NOT NULL DEFAULT 50,
      position_y INTEGER NOT NULL DEFAULT 50,
      shape TEXT NOT NULL DEFAULT 'round',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_restaurant_tables_number
      ON "${s}".restaurant_tables(branch_id, table_number);
    CREATE TABLE IF NOT EXISTS "${s}".table_accounts (
      id SERIAL PRIMARY KEY,
      table_id INTEGER NOT NULL,
      table_number INTEGER NOT NULL,
      table_label TEXT DEFAULT '',
      branch_id INTEGER NOT NULL DEFAULT 0,
      waiter_name TEXT NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open',
      opened_session_id INTEGER,
      closed_session_id INTEGER,
      order_id INTEGER,
      opened_by TEXT DEFAULT '',
      closed_by TEXT DEFAULT '',
      opened_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      closed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS "${s}".table_rounds (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      items TEXT NOT NULL DEFAULT '[]',
      subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(account_id, round_number)
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_table_rounds_account
      ON "${s}".table_rounds(account_id, round_number);
    DROP INDEX IF EXISTS "${s}".idx_${s}_table_accounts_one_open;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_table_accounts_one_open_branch
      ON "${s}".table_accounts(table_id, branch_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_${s}_table_accounts_session
      ON "${s}".table_accounts(closed_session_id, status, closed_at DESC);
    INSERT INTO "${s}".table_rounds (account_id, round_number, items, subtotal, notes, created_by, created_at)
    SELECT ta.id, 1, ta.items, ta.subtotal, 'Ronda inicial migrada', ta.opened_by, COALESCE(ta.updated_at, ta.opened_at)
    FROM "${s}".table_accounts ta
    WHERE ta.status = 'open'
      AND COALESCE(ta.items, '[]') <> '[]'
      AND NOT EXISTS (SELECT 1 FROM "${s}".table_rounds tr WHERE tr.account_id = ta.id);
    CREATE TABLE IF NOT EXISTS "${s}".kds_areas (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      branch_id INTEGER,
      color TEXT DEFAULT '#ff6b35',
      access_token TEXT UNIQUE NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".kds_area_categories (
      area_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      PRIMARY KEY (area_id, category_id)
    );
    CREATE TABLE IF NOT EXISTS "${s}".kds_area_products (
      area_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      PRIMARY KEY (area_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS "${s}".kds_ticket_states (
      area_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TIMESTAMPTZ,
      ready_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (area_id, order_id)
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_kds_areas_token ON "${s}".kds_areas(access_token);
    CREATE INDEX IF NOT EXISTS idx_${s}_kds_ticket_status ON "${s}".kds_ticket_states(area_id, status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS "${s}".chat_sessions (
      id TEXT PRIMARY KEY,
      state TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS pickup_branch_id INTEGER;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS pickup_branch_name TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS customer_location_lat NUMERIC(10,7);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS customer_location_lng NUMERIC(10,7);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS customer_location_text TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS customer_location_resolved TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12,2) DEFAULT 0;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS delivery_zone_name TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS cancel_note TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS order_notes TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS payment_breakdown TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS cash_received NUMERIC(12,2);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS cash_change NUMERIC(12,2);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS pos_session_id INTEGER;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS service_branch_id INTEGER;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS service_branch_name TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS table_account_id INTEGER;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS table_number INTEGER;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS waiter_name TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS cogs_total NUMERIC(14,4);
    ALTER TABLE "${s}".pos_sessions ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    ALTER TABLE "${s}".pos_sessions ADD COLUMN IF NOT EXISTS branch_name TEXT;
    CREATE TABLE IF NOT EXISTS "${s}".product_variants (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL DEFAULT 0,
      sort INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS "${s}".modifier_groups (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      min_selections INTEGER DEFAULT 0,
      max_selections INTEGER DEFAULT 1,
      sort INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS "${s}".modifier_options (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      extra_price NUMERIC(12,2) DEFAULT 0,
      sort INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS "${s}".push_subscriptions (
      id SERIAL PRIMARY KEY,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".inventory_items (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL UNIQUE,
      initial_stock NUMERIC(12,2) DEFAULT 0,
      unit TEXT DEFAULT 'pcs',
      notes TEXT DEFAULT '',
      baseline_started_at TIMESTAMPTZ DEFAULT now(),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".inventory_movements (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      quantity NUMERIC(12,2) NOT NULL,
      notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".inventory_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,4);
    ALTER TABLE "${s}".inventory_movements ADD COLUMN IF NOT EXISTS total_cost NUMERIC(14,4);
    CREATE TABLE IF NOT EXISTS "${s}".business_expenses (
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
    CREATE INDEX IF NOT EXISTS idx_${s}_business_expenses_date ON "${s}".business_expenses(expense_date);
    CREATE INDEX IF NOT EXISTS idx_${s}_business_expenses_branch ON "${s}".business_expenses(branch_id);
    CREATE TABLE IF NOT EXISTS "${s}".suppliers (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, tax_id TEXT DEFAULT '', contact_name TEXT DEFAULT '',
      phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '', notes TEXT DEFAULT '', active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".purchase_orders (
      id SERIAL PRIMARY KEY, order_number TEXT UNIQUE, supplier_id INTEGER, supplier_name TEXT NOT NULL,
      branch_id INTEGER, branch_name TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      order_date DATE NOT NULL DEFAULT CURRENT_DATE, expected_date DATE, subtotal NUMERIC(14,2) DEFAULT 0,
      total NUMERIC(14,2) DEFAULT 0, notes TEXT DEFAULT '', created_by TEXT DEFAULT '', received_by TEXT DEFAULT '',
      cancelled_by TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
      received_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS "${s}".purchase_order_items (
      id SERIAL PRIMARY KEY, purchase_order_id INTEGER NOT NULL, product_id INTEGER NOT NULL, product_name TEXT NOT NULL,
      quantity NUMERIC(14,4) NOT NULL, unit_cost NUMERIC(14,4) NOT NULL, line_total NUMERIC(14,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "${s}".branch_inventory (
      id SERIAL PRIMARY KEY, branch_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      quantity NUMERIC(14,4) NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now(), UNIQUE(branch_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS "${s}".inventory_transfers (
      id SERIAL PRIMARY KEY, transfer_number TEXT UNIQUE, from_branch_id INTEGER NOT NULL, from_branch_name TEXT NOT NULL,
      to_branch_id INTEGER NOT NULL, to_branch_name TEXT NOT NULL, status TEXT DEFAULT 'completed', notes TEXT DEFAULT '',
      created_by TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), completed_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".inventory_transfer_items (
      id SERIAL PRIMARY KEY, transfer_id INTEGER NOT NULL, product_id INTEGER NOT NULL, product_name TEXT NOT NULL,
      quantity NUMERIC(14,4) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "${s}".purchase_audit_log (
      id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL,
      payload TEXT DEFAULT '{}', actor TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".inventory_movements ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    ALTER TABLE "${s}".inventory_movements ADD COLUMN IF NOT EXISTS purchase_order_id INTEGER;
    ALTER TABLE "${s}".inventory_movements ADD COLUMN IF NOT EXISTS transfer_id INTEGER;
    ALTER TABLE "${s}".inventory_movements ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual';
    ALTER TABLE "${s}".branch_inventory ADD COLUMN IF NOT EXISTS initial_quantity NUMERIC(14,4) NOT NULL DEFAULT 0;
    ALTER TABLE "${s}".branch_inventory ADD COLUMN IF NOT EXISTS baseline_started_at TIMESTAMPTZ;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS branch_stock_applied INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS "${s}".inventory_counts (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      physical_qty NUMERIC(12,2) NOT NULL,
      notes TEXT DEFAULT '',
      counted_by TEXT DEFAULT '',
      counted_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".inventory_counts ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    CREATE TABLE IF NOT EXISTS "${s}".inventory_closure_logs (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL,
      previous_initial_stock NUMERIC(12,2) NOT NULL,
      applied_physical_qty NUMERIC(12,2) NOT NULL,
      delta_qty NUMERIC(12,2) NOT NULL,
      period_key TEXT DEFAULT 'all',
      period_start_date TEXT DEFAULT '',
      period_end_date TEXT DEFAULT '',
      closure_note TEXT DEFAULT '',
      applied_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".inventory_items ADD COLUMN IF NOT EXISTS baseline_started_at TIMESTAMPTZ DEFAULT now();

    -- ═══════ Módulo: Productividad Empleados ═══════
    CREATE TABLE IF NOT EXISTS "${s}".employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      position TEXT DEFAULT '',
      department TEXT DEFAULT '',
      hire_date DATE,
      salary_base NUMERIC(12,2) DEFAULT 0,
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      branch_id INTEGER,
      avatar_color TEXT DEFAULT '#6c47ff',
      notes TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".employees ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_${s}_employees_branch ON "${s}".employees(branch_id);
    CREATE TABLE IF NOT EXISTS "${s}".emp_metric_types (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT DEFAULT 'manual',
      unit TEXT DEFAULT '',
      target NUMERIC(12,2) DEFAULT 100,
      weight NUMERIC(5,2) DEFAULT 1,
      higher_is_better INTEGER DEFAULT 1,
      active INTEGER DEFAULT 1,
      sort INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_emp_metric_key ON "${s}".emp_metric_types(key);
    CREATE TABLE IF NOT EXISTS "${s}".emp_productivity_records (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      metric_id INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      record_date DATE,
      value NUMERIC(12,2) DEFAULT 0,
      notes TEXT DEFAULT '',
      recorded_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE "${s}".emp_productivity_records ADD COLUMN IF NOT EXISTS record_date DATE;
    ALTER TABLE "${s}".emp_productivity_records ADD COLUMN IF NOT EXISTS input_source TEXT DEFAULT 'manual';
    ALTER TABLE "${s}".emp_metric_types ADD COLUMN IF NOT EXISTS period_type TEXT DEFAULT 'monthly';
    ALTER TABLE "${s}".emp_metric_types ADD COLUMN IF NOT EXISTS aggregation TEXT DEFAULT 'sum';
    DROP INDEX IF EXISTS "${s}".idx_${s}_emp_prod_uq;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_emp_prod_monthly ON "${s}".emp_productivity_records(employee_id, metric_id, period_year, period_month) WHERE record_date IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_emp_prod_date ON "${s}".emp_productivity_records(employee_id, metric_id, record_date) WHERE record_date IS NOT NULL;
    CREATE TABLE IF NOT EXISTS "${s}".emp_productivity_history (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      metric_id INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      record_date DATE,
      value NUMERIC(12,2) DEFAULT 0,
      notes TEXT DEFAULT '',
      recorded_by TEXT DEFAULT '',
      input_source TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_emp_prod_hist_lookup ON "${s}".emp_productivity_history(employee_id, metric_id, period_year, period_month, created_at DESC);
    CREATE TABLE IF NOT EXISTS "${s}".emp_commission_schemes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'percentage',
      config_json TEXT DEFAULT '{}',
      description TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".emp_commission_assignments (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      scheme_id INTEGER NOT NULL,
      metric_id INTEGER,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".emp_commission_records (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      scheme_id INTEGER,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      base_value NUMERIC(12,2) DEFAULT 0,
      commission_amount NUMERIC(12,2) DEFAULT 0,
      productivity_index NUMERIC(5,2) DEFAULT 0,
      status TEXT DEFAULT 'pending',
      notes TEXT DEFAULT '',
      calculated_by TEXT DEFAULT '',
      calculated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_emp_comm_rec_uq ON "${s}".emp_commission_records(employee_id, COALESCE(scheme_id,-1), period_year, period_month);
  `);
}

async function ensureTenantDefaults(slug, businessName = slug) {
  const t = tdb(slug);
  const defaults = {
    business_name: businessName,
    welcome_message: `¡Hola! 👋 Bienvenido a ${businessName}. Soy tu asistente virtual y estoy aquí para tomar tu pedido.`,
    whatsapp: '',
    currency: 'MXN',
    address: '',
    hours: '',
    delivery_enabled: '1',
    pickup_enabled: '1',
    location_enabled: '1',
    chatbot_payment_delivery_cash: '1',
    chatbot_payment_delivery_transfer: '0',
    chatbot_payment_delivery_card: '0',
    chatbot_payment_pickup_cash: '1',
    chatbot_payment_pickup_transfer: '0',
    chatbot_payment_pickup_card: '0',
    chatbot_upsell_enabled: '0',
    chatbot_upsell_question: '¿Deseas agregar alguno de estos productos a tu pedido?',
    chatbot_upsell_product_ids: '[]',
    chatbot_upsell_offers_json: '[]',
    chatbot_extra_options_json: '[]',
    chatbot_pos_integration_enabled: '0',
    delivery_zones_geojson: '[]',
    delivery_fee_rules: '',
    pos_enabled: '1',
    ticket_width_mm: '80',
    ticket_font_size_px: '14',
    ticket_line_height: '1.45',
    ticket_show_logo: '1',
    ticket_print_mode: 'thermal',
    ticket_mobile_zoom_percent: '100',
    pos_catalog_sort_mode: 'top_sold',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await t.run('INSERT INTO {s}.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}

async function getSetting(t, key, fallback = '') {
  const row = await t.get('SELECT value FROM {s}.settings WHERE key = $1', [key]);
  return row ? row.value : fallback;
}

async function setSetting(t, key, value) {
  await t.run(
    'INSERT INTO {s}.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value ?? '')]
  );
}

async function getSuperAdminSetting(key, fallback = '') {
  const row = await q('SELECT value FROM superadmin_settings WHERE key = $1', [String(key)]);
  if (!row.rows[0]) return fallback;
  return row.rows[0].value ?? fallback;
}

async function setSuperAdminSetting(key, value) {
  await q(
    `INSERT INTO superadmin_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(key), String(value ?? '')]
  );
}

async function refreshTenantBillingStatuses() {
  const dueUpdated = await q(
    `UPDATE tenants
     SET billing_status = 'due'
     WHERE billing_due_date IS NOT NULL
       AND billing_due_date < CURRENT_DATE
       AND billing_status = 'active'`
  );

  const suspendedUpdated = await q(
    `UPDATE tenants
     SET billing_status = 'suspended'
     WHERE billing_due_date IS NOT NULL
       AND billing_due_date < (CURRENT_DATE - INTERVAL '7 days')
       AND billing_status = 'due'`
  );

  return {
    movedToDue: Number(dueUpdated.rowCount || 0),
    movedToSuspended: Number(suspendedUpdated.rowCount || 0),
  };
}

async function initTenantDefaults(slug, businessName) {
  await createTenantSchema(slug);
  await ensureTenantDefaults(slug, businessName);
  const t = tdb(slug);
  return t;
}

module.exports = {
  pool,
  q,
  tdb,
  schemaName,
  initMaster,
  createTenantSchema,
  initTenantDefaults,
  getSetting,
  setSetting,
  getSuperAdminSetting,
  setSuperAdminSetting,
  refreshTenantBillingStatuses,
};
