const storage = require('./objectStorage');

function scopeFor(tenantDb) {
  const scope = String(tenantDb?.schema || '');
  if (!/^t_[a-z0-9_]{1,100}$/.test(scope)) throw new Error('Negocio de documento no válido');
  return scope;
}

async function storeDocument(bytes, { scope, namespace = 'documents', extension = 'pdf', contentType = 'application/pdf' }) {
  if (!bytes) return bytes;
  if (!storage.enabled) return bytes;
  const reference = await storage.put({ scope, namespace, extension, contentType, body: bytes });
  // A small, versioned reference fits existing BYTEA columns. Old PDF bytes are
  // never changed; there is no table rewrite or backfill on production startup.
  return Buffer.from(reference, 'utf8');
}

async function readDocument(value, scope) {
  if (!value) return value;
  if (!storage.privateKey(value, scope)) return value;
  return storage.readPrivate(value, scope);
}

async function storeBase64Document(content, tenantDb, extension) {
  if (!content || !storage.enabled) return content;
  const bytes = await storeDocument(Buffer.from(content, 'base64'), {
    scope: scopeFor(tenantDb), namespace: 'invoicing', extension,
    contentType: extension === 'xml' ? 'application/xml' : 'application/pdf',
  });
  return bytes.toString('utf8');
}

async function readBase64Document(content, tenantDb) {
  if (!content || !content.startsWith(storage.PRIVATE_PREFIX)) return content;
  return (await storage.readPrivate(content, scopeFor(tenantDb))).toString('base64');
}

module.exports = { storeDocument, readDocument, storeBase64Document, readBase64Document, scopeFor };
