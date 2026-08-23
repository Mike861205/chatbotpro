const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function envEnabled(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return Boolean(fallback);
  return !['0', 'false', 'off', 'no'].includes(raw);
}

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
  if (String(process.env[name]).trim().length < 32) {
    throw new Error(`${name} debe tener al menos 32 caracteres`);
  }
  return process.env[name];
}

// Auto-genera claves VAPID (Web Push) si no existen — se guardan en el .env del servidor
function ensureVapidKeys() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    try {
      const webpush = require('web-push');
      const keys = webpush.generateVAPIDKeys();
      const lines = [
        `\nVAPID_PUBLIC_KEY=${keys.publicKey}`,
        `\nVAPID_PRIVATE_KEY=${keys.privateKey}`,
        `\nVAPID_SUBJECT=mailto:admin@chatbotpro.app`,
      ].join('');
      if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, '', 'utf8');
      fs.appendFileSync(envPath, lines);
      process.env.VAPID_PUBLIC_KEY = keys.publicKey;
      process.env.VAPID_PRIVATE_KEY = keys.privateKey;
      process.env.VAPID_SUBJECT = 'mailto:admin@chatbotpro.app';
      console.log(`[config] Claves VAPID generadas y guardadas en ${selectedEnvFile}`);
    } catch (e) {
      console.warn('[config] No se pudieron generar claves VAPID:', e.message);
    }
  }
}
ensureVapidKeys();

const DATA_DIR = path.join(ROOT, 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
[DATA_DIR, TENANTS_DIR, UPLOADS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

module.exports = {
  PORT: process.env.PORT || 3000,
  HOST: String(process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0')).trim(),
  JWT_SECRET: ensureSecret('JWT_SECRET'),
  SUPERADMIN_JWT_SECRET: ensureSecret('SUPERADMIN_JWT_SECRET'),
  ENCRYPTION_KEY: ensureSecret('DATA_ENCRYPTION_KEY'),
  DEMO_LOGIN_ENABLED: envEnabled('DEMO_LOGIN_ENABLED', false),
  DEMO_USERNAME: String(process.env.DEMO_USERNAME || 'demo').trim().toLowerCase(),
  DEMO_PASSWORD: String(process.env.DEMO_PASSWORD || ''),
  DEMO_TENANT_SLUG: String(process.env.DEMO_TENANT_SLUG || '').trim().toLowerCase(),
  PG_SSL_REJECT_UNAUTHORIZED: envEnabled('PG_SSL_REJECT_UNAUTHORIZED', true),
  OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
  FACTURAMA_ENVIRONMENT: String(process.env.FACTURAMA_ENVIRONMENT || 'sandbox').trim().toLowerCase() === 'production' ? 'production' : 'sandbox',
  FACTURAMA_USERNAME: String(process.env.FACTURAMA_USERNAME || '').trim(),
  FACTURAMA_PASSWORD: String(process.env.FACTURAMA_PASSWORD || ''),
  FACTURAMA_BASE_URL: String(process.env.FACTURAMA_BASE_URL || (
    String(process.env.FACTURAMA_ENVIRONMENT || 'sandbox').trim().toLowerCase() === 'production'
      ? 'https://api.facturama.mx'
      : 'https://apisandbox.facturama.mx'
  )).trim().replace(/\/+$/, ''),
  FACTURAMA_TIMEOUT_MS: Math.min(60000, Math.max(5000, Number(process.env.FACTURAMA_TIMEOUT_MS) || 25000)),
  FACTURAMA_SANDBOX_SHARED_ISSUER: envEnabled('FACTURAMA_SANDBOX_SHARED_ISSUER', true),
  FACTURAMA_SANDBOX_RFC: String(process.env.FACTURAMA_SANDBOX_RFC || 'EKU9003173C9').trim().toUpperCase(),
  FACTURAMA_SANDBOX_NAME: String(process.env.FACTURAMA_SANDBOX_NAME || 'ESCUELA KEMPER URGATE').trim().toUpperCase(),
  FACTURAMA_SANDBOX_REGIME: String(process.env.FACTURAMA_SANDBOX_REGIME || '601').trim(),
  FACTURAMA_SANDBOX_POSTAL_CODE: String(process.env.FACTURAMA_SANDBOX_POSTAL_CODE || '78240').trim(),
  INVOICING_PORTAL_ORIGIN: String(process.env.INVOICING_PORTAL_ORIGIN || 'https://facturacion.chatbotpro.systemdem.online').trim().replace(/\/+$/, ''),
  DATABASE_URL: (() => {
    const url = (process.env.DATABASE_URL || '').trim();
    if (!url) {
      console.error('\n[config] Falta DATABASE_URL en .env (cadena de conexión de Neon).');
      process.exit(1);
    }
    // pg no entiende channel_binding; lo quitamos si viene en la URL
    let cleanUrl = url.replace(/[?&]channel_binding=[^&]*/i, '');
    if (envEnabled('PG_SSL_REJECT_UNAUTHORIZED', true)) {
      cleanUrl = cleanUrl.replace(/([?&]sslmode=)require(?=&|$)/i, '$1verify-full');
    }
    return cleanUrl;
  })(),
  ROOT,
  DATA_DIR,
  TENANTS_DIR,
  UPLOADS_DIR,
  // SMTP — notificaciones de leads y registros nuevos
  SMTP_HOST: (process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: (process.env.SMTP_USER || '').trim(),
  SMTP_PASS: (process.env.SMTP_PASS || '').trim(),
  NOTIFICATION_EMAIL: (process.env.NOTIFICATION_EMAIL || '').trim(),
  // Leídos después de ensureVapidKeys() — ya están garantizados
  get VAPID_PUBLIC_KEY()  { return (process.env.VAPID_PUBLIC_KEY  || '').trim(); },
  get VAPID_PRIVATE_KEY() { return (process.env.VAPID_PRIVATE_KEY || '').trim(); },
  get VAPID_SUBJECT()     { return (process.env.VAPID_SUBJECT     || 'mailto:admin@chatbotpro.app').trim(); },
};
