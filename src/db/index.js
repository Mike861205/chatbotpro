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
  const tenantDb = {
    schema: s,
    all: async (sql, p = []) => (await q(fix(sql), p)).rows,
    get: async (sql, p = []) => (await q(fix(sql), p)).rows[0],
    run: async (sql, p = []) => q(fix(sql), p),
    tx: async (callback) => {
      const client = await pool.connect();
      const scoped = {
        schema: s,
        timezone: tenantDb.timezone,
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
  return tenantDb;
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
      timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
      logo TEXT,
      primary_color TEXT DEFAULT '#ff6b35',
      account_status TEXT DEFAULT 'active',
      billing_status TEXT DEFAULT 'active',
      plan_name TEXT DEFAULT 'starter',
      billing_due_date DATE,
      customer_since TIMESTAMPTZ,
      license_count INTEGER NOT NULL DEFAULT 1,
      branch_limit INTEGER NOT NULL DEFAULT 2,
      invoicing_enabled INTEGER NOT NULL DEFAULT 0,
      invoicing_environment TEXT NOT NULL DEFAULT 'sandbox',
      invoicing_activated_at TIMESTAMPTZ,
      invoicing_trial_granted_at TIMESTAMPTZ,
      invoicing_plan_bonus_granted_at TIMESTAMPTZ,
      invoicing_activated_by TEXT DEFAULT '',
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
      onboarding_completed INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE IF NOT EXISTS resellers (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      contact_name TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    CREATE TABLE IF NOT EXISTS sales_followup_activities (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
      demo_lead_id INTEGER REFERENCES demo_leads(id) ON DELETE CASCADE,
      activity_type TEXT NOT NULL DEFAULT 'note',
      note TEXT NOT NULL DEFAULT '',
      stage_from TEXT,
      stage_to TEXT,
      follow_up_at TIMESTAMPTZ,
      created_by TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT sales_followup_single_subject CHECK (
        (tenant_id IS NOT NULL AND demo_lead_id IS NULL)
        OR (tenant_id IS NULL AND demo_lead_id IS NOT NULL)
      )
    );
  `);

  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status TEXT DEFAULT 'active'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'starter'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_due_date DATE`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS customer_since TIMESTAMPTZ`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS license_count INTEGER NOT NULL DEFAULT 1`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS branch_limit INTEGER NOT NULL DEFAULT 2`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoicing_enabled INTEGER`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoicing_environment TEXT NOT NULL DEFAULT 'sandbox'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoicing_activated_at TIMESTAMPTZ`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoicing_trial_granted_at TIMESTAMPTZ`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoicing_plan_bonus_granted_at TIMESTAMPTZ`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invoicing_activated_by TEXT DEFAULT ''`);
  await q(`
    UPDATE tenants
    SET invoicing_enabled = CASE
      WHEN upper(COALESCE(phone_country, '')) = 'MX'
        OR regexp_replace(COALESCE(phone_calling_code, ''), '[^0-9]', '', 'g') = '52'
        OR slug = $1
      THEN 1 ELSE 0 END
    WHERE invoicing_enabled IS NULL
  `, [config.DEMO_TENANT_SLUG]);
  await q(`ALTER TABLE tenants ALTER COLUMN invoicing_enabled SET DEFAULT 0`);
  await q(`ALTER TABLE tenants ALTER COLUMN invoicing_enabled SET NOT NULL`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reseller_id INTEGER REFERENCES resellers(id) ON DELETE SET NULL`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_country TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_calling_code TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT`);
  await q(`
    UPDATE tenants SET timezone = CASE phone_country
      WHEN 'GT' THEN 'America/Guatemala' WHEN 'BZ' THEN 'America/Belize'
      WHEN 'SV' THEN 'America/El_Salvador' WHEN 'HN' THEN 'America/Tegucigalpa'
      WHEN 'NI' THEN 'America/Managua' WHEN 'CR' THEN 'America/Costa_Rica'
      WHEN 'PA' THEN 'America/Panama' WHEN 'CU' THEN 'America/Havana'
      WHEN 'DO' THEN 'America/Santo_Domingo' WHEN 'PR' THEN 'America/Puerto_Rico'
      WHEN 'HT' THEN 'America/Port-au-Prince' WHEN 'CO' THEN 'America/Bogota'
      WHEN 'VE' THEN 'America/Caracas' WHEN 'EC' THEN 'America/Guayaquil'
      WHEN 'PE' THEN 'America/Lima' WHEN 'BO' THEN 'America/La_Paz'
      WHEN 'PY' THEN 'America/Asuncion' WHEN 'CL' THEN 'America/Santiago'
      WHEN 'AR' THEN 'America/Argentina/Buenos_Aires' WHEN 'UY' THEN 'America/Montevideo'
      WHEN 'BR' THEN 'America/Sao_Paulo' WHEN 'ES' THEN 'Europe/Madrid'
      WHEN 'US' THEN 'America/New_York' ELSE 'America/Mexico_City' END
    WHERE timezone IS NULL OR timezone = ''
  `);
  await q(`ALTER TABLE tenants ALTER COLUMN timezone SET DEFAULT 'America/Mexico_City'`);
  await q(`ALTER TABLE tenants ALTER COLUMN timezone SET NOT NULL`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sales_stage TEXT NOT NULL DEFAULT 'new'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sales_updated_at TIMESTAMPTZ DEFAULT now()`);
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
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS sales_stage TEXT NOT NULL DEFAULT 'new'`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS sales_updated_at TIMESTAMPTZ DEFAULT now()`);
  await q(`ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS reseller_id INTEGER REFERENCES resellers(id) ON DELETE SET NULL`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_leads_phone_hash_unique ON demo_leads (phone_hash)`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'manual'`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ DEFAULT now()`);
  await q(`
    UPDATE tenants t
    SET customer_since = first_payment.first_paid_at
    FROM (
      SELECT tenant_id, MIN(paid_at) AS first_paid_at
      FROM tenant_payments
      GROUP BY tenant_id
    ) first_payment
    WHERE t.id = first_payment.tenant_id
      AND t.customer_since IS NULL
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_tenants_customer_since ON tenants (customer_since)`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS cashier_slug TEXT`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1`);
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed INTEGER NOT NULL DEFAULT 1`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cashier_slug_unique ON users (cashier_slug) WHERE cashier_slug IS NOT NULL AND cashier_slug <> ''`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_module_usage_tenant_module ON module_usage (tenant_id, module_key) WHERE demo_lead_id IS NULL`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_module_usage_lead_module ON module_usage (demo_lead_id, module_key) WHERE demo_lead_id IS NOT NULL`);
  await q(`CREATE INDEX IF NOT EXISTS idx_module_usage_tenant_last_seen ON module_usage (tenant_id, last_seen_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_module_usage_lead_last_seen ON module_usage (demo_lead_id, last_seen_at DESC) WHERE demo_lead_id IS NOT NULL`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tenants_sales_stage ON tenants (sales_stage, next_follow_up_at) WHERE customer_since IS NULL`);
  await q(`CREATE INDEX IF NOT EXISTS idx_demo_leads_sales_stage ON demo_leads (sales_stage, next_follow_up_at)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tenants_reseller ON tenants (reseller_id, created_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_demo_leads_reseller ON demo_leads (reseller_id, last_seen_at DESC)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sales_followup_tenant ON sales_followup_activities (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL`);
  await q(`CREATE INDEX IF NOT EXISTS idx_sales_followup_demo_lead ON sales_followup_activities (demo_lead_id, created_at DESC) WHERE demo_lead_id IS NOT NULL`);

  await ensureSuperAdminSeed();

  // Migra/asegura el esquema aislado de tenants existentes.
  const existing = await q('SELECT id, slug, business_name FROM tenants');
  for (const t of existing.rows) {
    await createTenantSchema(t.slug);
    await ensureTenantDefaults(t.slug, t.business_name);
    await ensureTenantCourtesyStamps(t.slug, t.id, 'system:migration');
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
      receiving_mode_label TEXT DEFAULT '',
      receiving_mode_behavior TEXT DEFAULT '',
      delivery_address TEXT DEFAULT '',
      delivery_neighborhood TEXT DEFAULT '',
      delivery_reference TEXT DEFAULT '',
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
      customer_name TEXT DEFAULT '',
      customer_phone TEXT DEFAULT '',
      source_channel TEXT DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS "${s}".sales_audit_log (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      order_id INTEGER,
      table_account_id INTEGER,
      table_round_id INTEGER,
      session_id INTEGER,
      branch_id INTEGER,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      actor_username TEXT NOT NULL DEFAULT '',
      actor_role TEXT NOT NULL DEFAULT '',
      authorized_by TEXT NOT NULL DEFAULT '',
      before_data TEXT NOT NULL DEFAULT '{}',
      after_data TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_sales_audit_created
      ON "${s}".sales_audit_log(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_${s}_sales_audit_order
      ON "${s}".sales_audit_log(order_id, table_account_id);
    ALTER TABLE "${s}".table_accounts ADD COLUMN IF NOT EXISTS customer_name TEXT DEFAULT '';
    ALTER TABLE "${s}".table_accounts ADD COLUMN IF NOT EXISTS customer_phone TEXT DEFAULT '';
    ALTER TABLE "${s}".table_accounts ADD COLUMN IF NOT EXISTS source_channel TEXT DEFAULT '';
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
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS receiving_mode_label TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS receiving_mode_behavior TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS delivery_address TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS delivery_neighborhood TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS delivery_reference TEXT DEFAULT '';
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

    -- FacturaciÃ³n electrÃ³nica MÃ©xico (CFDI 4.0)
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS sat_product_code TEXT;
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS sat_unit_code TEXT;
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS sat_unit_name TEXT;
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS tax_object TEXT;
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS iva_rate NUMERIC(8,6);
    ALTER TABLE "${s}".products ADD COLUMN IF NOT EXISTS isr_rate NUMERIC(8,6);
    ALTER TABLE "${s}".branches ADD COLUMN IF NOT EXISTS fiscal_postal_code TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS invoice_token UUID DEFAULT gen_random_uuid();
    UPDATE "${s}".orders SET invoice_token = gen_random_uuid() WHERE invoice_token IS NULL;
    ALTER TABLE "${s}".orders ALTER COLUMN invoice_token SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_orders_invoice_token ON "${s}".orders(invoice_token);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS invoice_code TEXT;
    UPDATE "${s}".orders
       SET invoice_code = upper(substr(md5(invoice_token::text || ':' || id::text), 1, 8))
     WHERE invoice_code IS NULL OR invoice_code = '';
    ALTER TABLE "${s}".orders ALTER COLUMN invoice_code SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    ALTER TABLE "${s}".orders ALTER COLUMN invoice_code SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_orders_invoice_code ON "${s}".orders(invoice_code);

    CREATE TABLE IF NOT EXISTS "${s}".fiscal_profiles (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT 'facturama',
      environment TEXT NOT NULL DEFAULT 'sandbox',
      api_mode TEXT NOT NULL DEFAULT 'multi',
      sandbox_shared INTEGER NOT NULL DEFAULT 0,
      rfc TEXT NOT NULL DEFAULT '',
      legal_name TEXT NOT NULL DEFAULT '',
      fiscal_regime TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      series TEXT NOT NULL DEFAULT 'FAC',
      next_folio BIGINT NOT NULL DEFAULT 1,
      default_product_code TEXT NOT NULL DEFAULT '01010101',
      default_unit_code TEXT NOT NULL DEFAULT 'E48',
      default_unit_name TEXT NOT NULL DEFAULT 'Unidad de servicio',
      default_tax_object TEXT NOT NULL DEFAULT '02',
      default_iva_rate NUMERIC(8,6) NOT NULL DEFAULT 0.160000,
      default_isr_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
      delivery_product_code TEXT NOT NULL DEFAULT '',
      prices_include_tax INTEGER NOT NULL DEFAULT 1,
      default_card_payment_form TEXT NOT NULL DEFAULT '04',
      csd_uploaded INTEGER NOT NULL DEFAULT 0,
      csd_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS api_mode TEXT NOT NULL DEFAULT 'multi';
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS sandbox_shared INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS delivery_product_code TEXT NOT NULL DEFAULT '';
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS default_card_payment_form TEXT NOT NULL DEFAULT '04';
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS csd_uploaded INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS csd_updated_at TIMESTAMPTZ;
    ALTER TABLE "${s}".fiscal_profiles ADD COLUMN IF NOT EXISTS default_isr_rate NUMERIC(8,6) NOT NULL DEFAULT 0;
    ALTER TABLE "${s}".fiscal_profiles ALTER COLUMN series SET DEFAULT 'FAC';
    ALTER TABLE "${s}".fiscal_profiles ALTER COLUMN default_product_code SET DEFAULT '01010101';

    CREATE TABLE IF NOT EXISTS "${s}".fiscal_emitters (
      id BIGSERIAL PRIMARY KEY,
      label TEXT NOT NULL DEFAULT 'Emisor principal',
      enabled INTEGER NOT NULL DEFAULT 1,
      environment TEXT NOT NULL DEFAULT 'sandbox',
      api_mode TEXT NOT NULL DEFAULT 'multi',
      sandbox_shared INTEGER NOT NULL DEFAULT 0,
      rfc TEXT NOT NULL,
      legal_name TEXT NOT NULL,
      fiscal_regime TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      series TEXT NOT NULL DEFAULT 'FAC',
      next_folio BIGINT NOT NULL DEFAULT 1,
      default_product_code TEXT NOT NULL DEFAULT '01010101',
      default_unit_code TEXT NOT NULL DEFAULT 'E48',
      default_unit_name TEXT NOT NULL DEFAULT 'Unidad de servicio',
      default_tax_object TEXT NOT NULL DEFAULT '02',
      default_iva_rate NUMERIC(8,6) NOT NULL DEFAULT 0.16,
      default_isr_rate NUMERIC(8,6) NOT NULL DEFAULT 0,
      delivery_product_code TEXT NOT NULL DEFAULT '',
      prices_include_tax INTEGER NOT NULL DEFAULT 1,
      default_card_payment_form TEXT NOT NULL DEFAULT '04',
      csd_uploaded INTEGER NOT NULL DEFAULT 0,
      csd_updated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE "${s}".fiscal_emitters ALTER COLUMN series SET DEFAULT 'FAC';
    ALTER TABLE "${s}".fiscal_emitters ADD COLUMN IF NOT EXISTS api_mode TEXT NOT NULL DEFAULT 'multi';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_fiscal_emitters_rfc ON "${s}".fiscal_emitters(rfc);
    INSERT INTO "${s}".fiscal_emitters
      (id,label,enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,next_folio,
       default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,default_isr_rate,
       delivery_product_code,prices_include_tax,default_card_payment_form,csd_uploaded,csd_updated_at)
    SELECT 1,'Emisor principal',enabled,environment,api_mode,sandbox_shared,rfc,legal_name,fiscal_regime,postal_code,series,next_folio,
       default_product_code,default_unit_code,default_unit_name,default_tax_object,default_iva_rate,default_isr_rate,
       delivery_product_code,prices_include_tax,default_card_payment_form,csd_uploaded,csd_updated_at
      FROM "${s}".fiscal_profiles WHERE id=1
    ON CONFLICT (id) DO NOTHING;
    SELECT setval(pg_get_serial_sequence('"${s}".fiscal_emitters','id'),GREATEST(COALESCE((SELECT max(id) FROM "${s}".fiscal_emitters),1),1));

    ALTER TABLE "${s}".branches ADD COLUMN IF NOT EXISTS fiscal_emitter_id BIGINT;
    UPDATE "${s}".branches SET fiscal_emitter_id=1 WHERE fiscal_emitter_id IS NULL AND EXISTS (SELECT 1 FROM "${s}".fiscal_emitters WHERE id=1);

    CREATE TABLE IF NOT EXISTS "${s}".stamp_wallet (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id=1),
      unlimited INTEGER NOT NULL DEFAULT 0,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance>=0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved>=0),
      low_balance_threshold INTEGER NOT NULL DEFAULT 20,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO "${s}".stamp_wallet(id,unlimited,balance,reserved) VALUES(1,0,0,0) ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS "${s}".stamp_ledger (
      id BIGSERIAL PRIMARY KEY,
      movement_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      balance_after INTEGER,
      invoice_type TEXT,
      invoice_id BIGINT,
      fiscal_emitter_id BIGINT,
      detail TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_stamp_ledger_invoice_reservation ON "${s}".stamp_ledger(invoice_type,invoice_id) WHERE movement_type='reserved';
    CREATE INDEX IF NOT EXISTS idx_${s}_stamp_ledger_created ON "${s}".stamp_ledger(created_at DESC,id DESC);

    CREATE TABLE IF NOT EXISTS "${s}".fiscal_customers (
      id BIGSERIAL PRIMARY KEY,
      rfc_hash TEXT NOT NULL UNIQUE,
      fiscal_data_enc TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "${s}".invoices (
      id BIGSERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES "${s}".orders(id),
      request_key UUID NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'facturama',
      environment TEXT NOT NULL DEFAULT 'sandbox',
      provider_id TEXT,
      uuid TEXT,
      series TEXT NOT NULL DEFAULT '',
      folio TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      receiver_data_enc TEXT NOT NULL,
      fiscal_snapshot_enc TEXT NOT NULL,
      provider_response_enc TEXT,
      xml_enc TEXT,
      pdf_enc TEXT,
      certificate_number TEXT,
      error_message TEXT NOT NULL DEFAULT '',
      cancellation_motive TEXT,
      replacement_uuid TEXT,
      cancellation_status TEXT,
      cancellation_message TEXT,
      cancellation_receipt_enc TEXT,
      issued_by TEXT NOT NULL DEFAULT '',
      issued_at TIMESTAMPTZ,
      cancel_requested_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE "${s}".invoices ADD COLUMN IF NOT EXISTS fiscal_emitter_id BIGINT;
    ALTER TABLE "${s}".invoices ADD COLUMN IF NOT EXISTS issuer_rfc TEXT;
    ALTER TABLE "${s}".invoices ADD COLUMN IF NOT EXISTS api_mode TEXT;
    UPDATE "${s}".invoices i SET api_mode=COALESCE((SELECT e.api_mode FROM "${s}".fiscal_emitters e WHERE e.id=i.fiscal_emitter_id),'multi') WHERE i.api_mode IS NULL;
    ALTER TABLE "${s}".invoices ALTER COLUMN api_mode SET DEFAULT 'multi';
    ALTER TABLE "${s}".invoices ALTER COLUMN api_mode SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_invoices_uuid ON "${s}".invoices(uuid) WHERE uuid IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_invoices_order_live ON "${s}".invoices(order_id) WHERE status IN ('pending','unknown','active','cancel_pending');
    CREATE INDEX IF NOT EXISTS idx_${s}_invoices_created ON "${s}".invoices(created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS "${s}".invoice_events (
      id BIGSERIAL PRIMARY KEY,
      invoice_id BIGINT NOT NULL REFERENCES "${s}".invoices(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_invoice_events_invoice ON "${s}".invoice_events(invoice_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS "${s}".global_invoices (
      id BIGSERIAL PRIMARY KEY,
      request_key UUID NOT NULL UNIQUE,
      provider TEXT NOT NULL DEFAULT 'facturama',
      environment TEXT NOT NULL DEFAULT 'sandbox',
      api_mode TEXT NOT NULL DEFAULT 'multi',
      provider_id TEXT,
      uuid TEXT,
      series TEXT NOT NULL DEFAULT '',
      folio TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      service_branch_id INTEGER,
      business_date DATE NOT NULL,
      periodicity TEXT NOT NULL DEFAULT '01',
      concept_mode TEXT NOT NULL DEFAULT 'detailed',
      order_count INTEGER NOT NULL DEFAULT 0,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      payment_form TEXT NOT NULL DEFAULT '01',
      receiver_data_enc TEXT NOT NULL,
      fiscal_snapshot_enc TEXT NOT NULL,
      provider_response_enc TEXT,
      xml_enc TEXT,
      pdf_enc TEXT,
      certificate_number TEXT,
      error_message TEXT NOT NULL DEFAULT '',
      issued_by TEXT NOT NULL DEFAULT '',
      issued_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS fiscal_emitter_id BIGINT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS issuer_rfc TEXT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS api_mode TEXT;
    UPDATE "${s}".global_invoices gi SET api_mode=COALESCE((SELECT e.api_mode FROM "${s}".fiscal_emitters e WHERE e.id=gi.fiscal_emitter_id),'multi') WHERE gi.api_mode IS NULL;
    ALTER TABLE "${s}".global_invoices ALTER COLUMN api_mode SET DEFAULT 'multi';
    ALTER TABLE "${s}".global_invoices ALTER COLUMN api_mode SET NOT NULL;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS cancellation_motive TEXT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS replacement_uuid TEXT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS cancellation_status TEXT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS cancellation_message TEXT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS cancellation_receipt_enc TEXT;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_global_invoices_uuid ON "${s}".global_invoices(uuid) WHERE uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_${s}_global_invoices_date ON "${s}".global_invoices(business_date DESC, service_branch_id, id DESC);
    ALTER TABLE "${s}".global_invoices ADD COLUMN IF NOT EXISTS concept_mode TEXT NOT NULL DEFAULT 'detailed';

    CREATE TABLE IF NOT EXISTS "${s}".global_invoice_orders (
      global_invoice_id BIGINT NOT NULL REFERENCES "${s}".global_invoices(id) ON DELETE CASCADE,
      order_id INTEGER NOT NULL REFERENCES "${s}".orders(id),
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (global_invoice_id, order_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${s}_global_invoice_orders_live ON "${s}".global_invoice_orders(order_id) WHERE active=1;
    CREATE INDEX IF NOT EXISTS idx_${s}_global_invoice_orders_batch ON "${s}".global_invoice_orders(global_invoice_id, order_id);

    CREATE TABLE IF NOT EXISTS "${s}".global_invoice_events (
      id BIGSERIAL PRIMARY KEY,
      global_invoice_id BIGINT NOT NULL REFERENCES "${s}".global_invoices(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_${s}_global_invoice_events_invoice ON "${s}".global_invoice_events(global_invoice_id, created_at DESC);
  `);
  if (config.FACTURAMA_PRODUCTION_RFC) {
    await q(
      `UPDATE "${s}".fiscal_profiles
          SET api_mode=CASE WHEN environment='production' AND upper(rfc)=$1 THEN 'web' WHEN environment='production' THEN 'multi' ELSE api_mode END`,
      [config.FACTURAMA_PRODUCTION_RFC]
    );
    await q(
      `UPDATE "${s}".fiscal_emitters
          SET api_mode=CASE WHEN environment='production' AND upper(rfc)=$1 THEN 'web' WHEN environment='production' THEN 'multi' ELSE api_mode END`,
      [config.FACTURAMA_PRODUCTION_RFC]
    );
  }
}

async function ensureTenantDefaults(slug, businessName = slug, regional = {}) {
  const t = tdb(slug);
  const defaults = {
    business_name: businessName,
    welcome_message: `¡Hola! 👋 Bienvenido a ${businessName}. Soy tu asistente virtual y estoy aquí para tomar tu pedido.`,
    whatsapp: '',
    currency: regional.currency || 'MXN',
    timezone: regional.timezone || 'America/Mexico_City',
    address: '',
    hours: '',
    delivery_enabled: '1',
    pickup_enabled: '1',
    dine_in_enabled: '1',
    chatbot_receiving_modes_json: '[]',
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
    chatbot_pos_global_orders_enabled: '0',
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
  const entries = Object.entries(defaults);
  await t.run(
    `INSERT INTO {s}.settings (key, value)
     SELECT default_key, default_value
     FROM unnest($1::text[], $2::text[]) AS defaults(default_key, default_value)
     ON CONFLICT (key) DO NOTHING`,
    [entries.map(([key]) => key), entries.map(([, value]) => value)]
  );
}

async function ensureTenantCourtesyStamps(slug, tenantId = null, actor = 'system:registration') {
  const tenantDb = tdb(slug);
  const resolvedTenantId = Number(tenantId || 0) || Number((await q('SELECT id FROM tenants WHERE slug=$1 LIMIT 1', [slug])).rows[0]?.id || 0);
  if (!resolvedTenantId) throw new Error('No se encontró el tenant para asignar sus timbres de cortesía');
  return tenantDb.tx(async (tx) => {
    const tenant = await tx.get('SELECT invoicing_trial_granted_at FROM public.tenants WHERE id=$1 FOR UPDATE', [resolvedTenantId]);
    if (!tenant) throw new Error('Tenant no encontrado');
    await tx.run(`INSERT INTO {s}.stamp_wallet(id,unlimited,balance,reserved) VALUES(1,0,0,0) ON CONFLICT(id) DO NOTHING`);
    const wallet = await tx.get('SELECT * FROM {s}.stamp_wallet WHERE id=1 FOR UPDATE');
    if (tenant.invoicing_trial_granted_at) {
      const priorTrial = await tx.get("SELECT COALESCE(SUM(quantity),0)::int AS quantity FROM {s}.stamp_ledger WHERE movement_type='trial_grant'");
      const priorAdjustment = await tx.get("SELECT id FROM {s}.stamp_ledger WHERE movement_type='courtesy_policy_adjustment' LIMIT 1");
      if (Number(priorTrial?.quantity || 0) > 2 && !priorAdjustment) {
        const reduction = Number(priorTrial.quantity) - 2;
        const nextBalance = Math.max(Number(wallet.reserved || 0), Number(wallet.balance || 0) - reduction);
        const quantity = nextBalance - Number(wallet.balance || 0);
        const updated = await tx.get('UPDATE {s}.stamp_wallet SET unlimited=0,balance=$1,updated_at=now() WHERE id=1 RETURNING *', [nextBalance]);
        if (quantity) {
          await tx.run(
            `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,detail,actor)
             VALUES('courtesy_policy_adjustment',$1,$2,'Ajuste de cortesía inicial de 10 a 2 timbres',$3)`,
            [quantity, nextBalance, actor]
          );
        }
        return updated;
      }
      if (Number(wallet.unlimited)) {
        return tx.get('UPDATE {s}.stamp_wallet SET unlimited=0,updated_at=now() WHERE id=1 RETURNING *');
      }
      return wallet;
    }
    const courtesy = 2;
    const nextBalance = (Number(wallet.unlimited) ? 0 : Number(wallet.balance || 0)) + courtesy;
    const updated = await tx.get(
      'UPDATE {s}.stamp_wallet SET unlimited=0,balance=$1,updated_at=now() WHERE id=1 RETURNING *',
      [nextBalance]
    );
    await tx.run(
      `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,detail,actor)
       VALUES('courtesy_grant',$1,$2,'2 timbres de cortesía para pruebas de Facturación MX',$3)`,
      [courtesy, nextBalance, actor]
    );
    await tx.run(
      'UPDATE public.tenants SET invoicing_trial_granted_at=COALESCE(invoicing_trial_granted_at,now()) WHERE id=$1',
      [resolvedTenantId]
    );
    return updated;
  });
}

async function ensureTenantSubscriptionStampBonus(slug, tenantId, planCode, actor = 'system:subscription') {
  if (String(planCode || '').toLowerCase() !== 'invoicing_sat') return { granted: false, quantity: 0 };
  const tenantDb = tdb(slug);
  return tenantDb.tx(async (tx) => {
    const tenant = await tx.get(
      'SELECT invoicing_plan_bonus_granted_at FROM public.tenants WHERE id=$1 FOR UPDATE',
      [Number(tenantId)]
    );
    if (!tenant) throw new Error('Tenant no encontrado para acreditar timbres');
    if (tenant.invoicing_plan_bonus_granted_at) return { granted: false, quantity: 0 };

    await tx.run(`INSERT INTO {s}.stamp_wallet(id,unlimited,balance,reserved) VALUES(1,0,0,0) ON CONFLICT(id) DO NOTHING`);
    const wallet = await tx.get('SELECT * FROM {s}.stamp_wallet WHERE id=1 FOR UPDATE');
    const quantity = 100;
    const nextBalance = (Number(wallet.unlimited) ? 0 : Number(wallet.balance || 0)) + quantity;
    const updated = await tx.get(
      'UPDATE {s}.stamp_wallet SET unlimited=0,balance=$1,updated_at=now() WHERE id=1 RETURNING *',
      [nextBalance]
    );
    await tx.run(
      `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,detail,actor)
       VALUES('subscription_bonus',$1,$2,'100 timbres de bienvenida del Plan Facturación Electrónica SAT',$3)`,
      [quantity, nextBalance, actor]
    );
    await tx.run(
      `UPDATE public.tenants
       SET plan_name='invoicing_sat',
           invoicing_enabled=1,
           invoicing_activated_at=COALESCE(invoicing_activated_at,now()),
           invoicing_plan_bonus_granted_at=now(),
           invoicing_activated_by=$2
       WHERE id=$1`,
      [Number(tenantId), actor]
    );
    return { granted: true, quantity, wallet: updated };
  });
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

async function initTenantDefaults(slug, businessName, regional = {}, tenantId = null) {
  await createTenantSchema(slug);
  await ensureTenantDefaults(slug, businessName, regional);
  await ensureTenantCourtesyStamps(slug, tenantId, 'system:registration');
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
  ensureTenantCourtesyStamps,
  ensureTenantSubscriptionStampBonus,
  getSetting,
  setSetting,
  getSuperAdminSetting,
  setSuperAdminSetting,
  refreshTenantBillingStatuses,
};
