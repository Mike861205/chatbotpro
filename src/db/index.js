// Capa de datos sobre Neon (PostgreSQL serverless).
// Aislamiento multi-tenant: cada negocio tiene su PROPIO SCHEMA en Postgres
// (t_<slug>). La capa pública (public) solo guarda tenants y usuarios.
const { Pool } = require('pg');
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
  `);
  console.log('[db] Neon conectado — schema maestro listo');
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
    CREATE TABLE IF NOT EXISTS "${s}".chat_sessions (
      id TEXT PRIMARY KEY,
      state TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
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

async function initTenantDefaults(slug, businessName) {
  await createTenantSchema(slug);
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
  };
  for (const [k, v] of Object.entries(defaults)) {
    await t.run('INSERT INTO {s}.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  return t;
}

module.exports = { pool, q, tdb, schemaName, initMaster, createTenantSchema, initTenantDefaults, getSetting, setSetting };
