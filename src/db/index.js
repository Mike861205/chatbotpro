// Capa de datos sobre Neon (PostgreSQL serverless).
// Aislamiento multi-tenant: cada negocio tiene su PROPIO SCHEMA en Postgres
// (t_<slug>). La capa pública (public) solo guarda tenants y usuarios.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const config = require('../config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('[pg] error de pool:', err.message));

async function q(sql, params = []) {
  return pool.query(sql, params);
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
    all: async (sql, p = []) => (await pool.query(fix(sql), p)).rows,
    get: async (sql, p = []) => (await pool.query(fix(sql), p)).rows[0],
    run: async (sql, p = []) => pool.query(fix(sql), p),
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
      logo TEXT,
      primary_color TEXT DEFAULT '#ff6b35',
      account_status TEXT DEFAULT 'active',
      billing_status TEXT DEFAULT 'active',
      plan_name TEXT DEFAULT 'starter',
      billing_due_date DATE,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'owner',
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
  `);

  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS account_status TEXT DEFAULT 'active'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status TEXT DEFAULT 'active'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'starter'`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_due_date DATE`);
  await q(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS amount NUMERIC(12,2) NOT NULL DEFAULT 0`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'manual'`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS created_by TEXT DEFAULT ''`);
  await q(`ALTER TABLE tenant_payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ DEFAULT now()`);

  await ensureSuperAdminSeed();
  await ensureFixedSuperAdmin('mike', 'mike1986');

  // Migra/asegura el esquema aislado de tenants existentes.
  const existing = await q('SELECT slug, business_name FROM tenants');
  for (const t of existing.rows) {
    await createTenantSchema(t.slug);
    await ensureTenantDefaults(t.slug, t.business_name);
  }

  console.log('[db] Neon conectado — schema maestro listo');
}

async function ensureFixedSuperAdmin(username, password) {
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();
  if (!cleanUser || !cleanPass) return;
  const hash = await bcrypt.hash(cleanPass, 12);
  await q(
    `INSERT INTO superadmin_users (username, password_hash, active)
     VALUES ($1, $2, 1)
     ON CONFLICT (username)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, active = 1`,
    [cleanUser, hash]
  );
  console.log(`[superadmin] Acceso verificado para ${cleanUser}`);
}

async function ensureSuperAdminSeed() {
  const existing = await q('SELECT id FROM superadmin_users LIMIT 1');
  if (existing.rows.length) return;

  const username = String(process.env.SUPERADMIN_USERNAME || 'superadmin').trim().toLowerCase();
  const envPassword = String(process.env.SUPERADMIN_PASSWORD || '').trim();
  const generated = crypto.randomBytes(9).toString('base64url');
  const password = envPassword || generated;
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
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS "${s}".pos_sessions (
      id SERIAL PRIMARY KEY,
      status TEXT DEFAULT 'open',
      opening_amount NUMERIC(12,2) DEFAULT 0,
      closing_amount NUMERIC(12,2),
      expected_amount NUMERIC(12,2),
      difference_amount NUMERIC(12,2),
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
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT '';
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS payment_breakdown TEXT;
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS cash_received NUMERIC(12,2);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS cash_change NUMERIC(12,2);
    ALTER TABLE "${s}".orders ADD COLUMN IF NOT EXISTS pos_session_id INTEGER;
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
    pos_enabled: '1',
    ticket_width_mm: '80',
    ticket_font_size_px: '14',
    ticket_line_height: '1.45',
    ticket_show_logo: '1',
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
