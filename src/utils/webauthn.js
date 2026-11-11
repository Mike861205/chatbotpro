/**
 * Verificación WebAuthn mínima para el reloj checador.
 *
 * El alta se hace desde el propio kiosco con una sesión ya validada por NIP,
 * así que no se exige attestation: basta con guardar la llave pública que el
 * navegador entrega en `response.getPublicKey()` (formato SPKI DER) y, en cada
 * checada, verificar la firma contra esa llave.
 */
const crypto = require('node:crypto');

const SUPPORTED_ALGORITHMS = new Map([
  [-7, { name: 'ES256', hash: 'sha256' }],
  [-35, { name: 'ES384', hash: 'sha384' }],
  [-36, { name: 'ES512', hash: 'sha512' }],
  [-8, { name: 'EdDSA', hash: null }],
  [-257, { name: 'RS256', hash: 'sha256' }],
  [-258, { name: 'RS384', hash: 'sha384' }],
  [-259, { name: 'RS512', hash: 'sha512' }],
]);

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

function fromBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
}

function randomChallenge() {
  return crypto.randomBytes(32).toString('base64url');
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'WEBAUTHN_INVALID' });
}

/** El rpId es el dominio registrable: debe coincidir con el host que sirve la liga. */
function rpIdFromHost(host) {
  return String(host || '').trim().toLowerCase().split(':')[0] || 'localhost';
}

function parseClientData(clientDataJSON, { expectedType, expectedChallenge, expectedOrigin }) {
  let clientData;
  try {
    clientData = JSON.parse(fromBase64Url(clientDataJSON).toString('utf8'));
  } catch {
    return { error: invalid('Los datos de la credencial no son válidos') };
  }
  if (clientData.type !== expectedType) return { error: invalid('Tipo de operación biométrica inesperado') };
  if (String(clientData.challenge || '') !== String(expectedChallenge || '')) {
    return { error: invalid('El reto biométrico expiró, intenta de nuevo') };
  }
  if (expectedOrigin && String(clientData.origin || '') !== expectedOrigin) {
    return { error: invalid('La credencial proviene de otro sitio') };
  }
  return { clientData };
}

/**
 * Valida el alta de una huella/rostro y devuelve lo que hay que persistir.
 * `publicKey` llega en base64 (SPKI DER) desde `getPublicKey()`.
 */
function verifyRegistration({ credentialId, clientDataJSON, publicKey, algorithm, expectedChallenge, expectedOrigin }) {
  if (!String(credentialId || '').trim()) throw invalid('Falta el identificador de la credencial');
  const spki = Buffer.from(String(publicKey || ''), 'base64');
  if (!spki.length) {
    throw invalid('Este navegador no entregó la llave pública de la huella. Usa Chrome, Edge o Safari actualizados.');
  }
  const algorithmId = Number(algorithm);
  if (!SUPPORTED_ALGORITHMS.has(algorithmId)) throw invalid('Algoritmo biométrico no soportado');

  const { error } = parseClientData(clientDataJSON, {
    expectedType: 'webauthn.create',
    expectedChallenge,
    expectedOrigin,
  });
  if (error) throw error;

  try {
    crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  } catch {
    throw invalid('La llave pública de la huella no es válida');
  }

  return {
    credential_id: String(credentialId).trim().slice(0, 500),
    public_key: spki.toString('base64'),
    algorithm: algorithmId,
  };
}

/**
 * Verifica una checada biométrica. Devuelve el nuevo contador de firmas para
 * detectar autenticadores clonados en usos posteriores.
 */
function verifyAssertion({
  clientDataJSON,
  authenticatorData,
  signature,
  publicKey,
  algorithm,
  expectedChallenge,
  expectedOrigin,
  rpId,
  storedSignCount = 0,
  requireUserVerification = false,
}) {
  const { clientData, error } = parseClientData(clientDataJSON, {
    expectedType: 'webauthn.get',
    expectedChallenge,
    expectedOrigin,
  });
  if (error) throw error;

  const authData = fromBase64Url(authenticatorData);
  if (authData.length < 37) throw invalid('Los datos del autenticador están incompletos');
  if (!authData.subarray(0, 32).equals(sha256(Buffer.from(rpId, 'utf8')))) {
    throw invalid('La credencial pertenece a otro dominio');
  }

  const flags = authData[32];
  if (!(flags & FLAG_USER_PRESENT)) throw invalid('No se detectó la presencia del empleado');
  if (requireUserVerification && !(flags & FLAG_USER_VERIFIED)) {
    throw invalid('Este dispositivo requiere confirmar la huella o el rostro');
  }
  const signCount = authData.readUInt32BE(33);

  const algorithmId = Number(algorithm);
  const spec = SUPPORTED_ALGORITHMS.get(algorithmId);
  if (!spec) throw invalid('Algoritmo biométrico no soportado');

  let keyObject;
  try {
    keyObject = crypto.createPublicKey({ key: Buffer.from(String(publicKey || ''), 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw invalid('La credencial registrada ya no es utilizable, vuelve a darla de alta');
  }

  const payload = Buffer.concat([authData, sha256(fromBase64Url(clientDataJSON))]);
  const signatureBytes = fromBase64Url(signature);
  const verified = crypto.verify(spec.hash, payload, keyObject, signatureBytes);
  if (!verified) throw invalid('La firma biométrica no coincide');

  // Un contador que no avanza delata una credencial duplicada. Los
  // autenticadores que no llevan contador reportan siempre 0 y se exentan.
  if (storedSignCount > 0 && signCount > 0 && signCount <= storedSignCount) {
    throw Object.assign(new Error('Se detectó una credencial biométrica duplicada'), { status: 409, code: 'WEBAUTHN_CLONED' });
  }

  return {
    sign_count: signCount,
    user_verified: Boolean(flags & FLAG_USER_VERIFIED),
    origin: clientData.origin,
  };
}

module.exports = {
  SUPPORTED_ALGORITHMS,
  randomChallenge,
  rpIdFromHost,
  verifyAssertion,
  verifyRegistration,
};
