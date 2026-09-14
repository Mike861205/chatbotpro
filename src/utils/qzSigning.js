const crypto = require('node:crypto');

const ALLOWED_QZ_CALLS = new Set(['printers.find', 'print']);

function validateQzRequest(request) {
  const value = String(request || '');
  if (!value || Buffer.byteLength(value, 'utf8') > 512 * 1024) {
    throw new Error('Solicitud QZ inválida');
  }
  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    throw new Error('Solicitud QZ inválida');
  }
  if (!ALLOWED_QZ_CALLS.has(String(payload?.call || ''))) {
    throw new Error('Operación QZ no permitida');
  }
  return value;
}

function signQzRequest(request, privateKey) {
  const value = validateQzRequest(request);
  return crypto.sign('RSA-SHA512', Buffer.from(value, 'utf8'), privateKey).toString('base64');
}

module.exports = { signQzRequest, validateQzRequest };
