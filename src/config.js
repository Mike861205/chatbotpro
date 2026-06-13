const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const defaultEnvByNodeEnv = {
  production: '.env.production',
  test: '.env.test',
};
const selectedEnvFile = (process.env.ENV_FILE || '').trim() || defaultEnvByNodeEnv[process.env.NODE_ENV] || '.env';
const envPath = path.join(ROOT, selectedEnvFile);

// Carga base + override por entorno para permitir defaults locales.
const baseEnvPath = path.join(ROOT, '.env');
if (fs.existsSync(baseEnvPath)) require('dotenv').config({ path: baseEnvPath });
if (envPath !== baseEnvPath && fs.existsSync(envPath)) require('dotenv').config({ path: envPath, override: true });
if (envPath === baseEnvPath && fs.existsSync(envPath)) require('dotenv').config({ path: envPath });

// Genera y persiste secretos si no existen (primer arranque local)
function ensureSecret(name, bytes = 32) {
  if (!process.env[name] || !process.env[name].trim()) {
    const val = crypto.randomBytes(bytes).toString('hex');
    if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, '', 'utf8');
    fs.appendFileSync(envPath, `\n${name}=${val}`);
    process.env[name] = val;
    console.log(`[config] Secreto ${name} generado y guardado en ${selectedEnvFile}`);
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
  DATABASE_URL: (() => {
    const url = (process.env.DATABASE_URL || '').trim();
    if (!url) {
      console.error('\n[config] Falta DATABASE_URL en .env (cadena de conexión de Neon).');
      process.exit(1);
    }
    // pg no entiende channel_binding; lo quitamos si viene en la URL
    return url.replace(/[?&]channel_binding=[^&]*/i, '');
  })(),
  ROOT,
  DATA_DIR,
  TENANTS_DIR,
  UPLOADS_DIR,
};
