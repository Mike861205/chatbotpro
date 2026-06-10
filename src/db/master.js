// Base de datos maestra: tenants (negocios) y usuarios. Los datos operativos
// de cada negocio viven en su PROPIA base de datos aislada (ver tenant.js).
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

const db = new Database(path.join(config.DATA_DIR, 'master.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  business_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone_enc TEXT,
  logo TEXT,
  primary_color TEXT DEFAULT '#ff6b35',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'owner',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

module.exports = db;
