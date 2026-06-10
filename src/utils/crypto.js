// Cifrado AES-256-GCM para datos sensibles de clientes (nombre, teléfono, dirección)
const crypto = require('crypto');
const config = require('../config');

const KEY = crypto.createHash('sha256').update(config.ENCRYPTION_KEY).digest(); // 32 bytes

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload) {
  if (!payload) return null;
  try {
    const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Hash determinístico para búsquedas (ej. localizar cliente por teléfono sin descifrar)
function lookupHash(value) {
  return crypto.createHmac('sha256', KEY).update(String(value)).digest('hex');
}

module.exports = { encrypt, decrypt, lookupHash };
