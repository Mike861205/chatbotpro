// Aislamiento por tenant: cada negocio tiene su propio archivo SQLite.
// En producción (Neon/PostgreSQL) esto se traduce a un schema por tenant.
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

const cache = new Map();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  image TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_enc TEXT,
  phone_enc TEXT,
  phone_hash TEXT,
  address_enc TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_hash);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  items TEXT NOT NULL,
  subtotal REAL DEFAULT 0,
  total REAL DEFAULT 0,
  status TEXT DEFAULT 'pendiente',
  channel TEXT DEFAULT 'chatbot',
  delivery TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  state TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

function getTenantDb(slug) {
  if (cache.has(slug)) return cache.get(slug);
  const file = path.join(config.TENANTS_DIR, `${slug}.db`);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  cache.set(slug, db);
  return db;
}

function getSetting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value ?? ''));
}

function initTenantDefaults(slug, businessName) {
  const db = getTenantDb(slug);
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
    if (!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k)) setSetting(db, k, v);
  }
  return db;
}

module.exports = { getTenantDb, getSetting, setSetting, initTenantDefaults };
