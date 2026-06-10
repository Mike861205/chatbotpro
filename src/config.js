const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const envPath = path.join(ROOT, '.env');
require('dotenv').config({ path: envPath });

// Genera y persiste secretos si no existen (primer arranque local)
function ensureSecret(name, bytes = 32) {
  if (!process.env[name] || !process.env[name].trim()) {
    const val = crypto.randomBytes(bytes).toString('hex');
    fs.appendFileSync(envPath, `\n${name}=${val}`);
    process.env[name] = val;
    console.log(`[config] Secreto ${name} generado y guardado en .env`);
  }
  return process.env[name];
}

const DATA_DIR = path.join(ROOT, 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
[DATA_DIR, TENANTS_DIR, UPLOADS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: ensureSecret('JWT_SECRET'),
  ENCRYPTION_KEY: ensureSecret('DATA_ENCRYPTION_KEY'),
  OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
  ROOT,
  DATA_DIR,
  TENANTS_DIR,
  UPLOADS_DIR,
};
