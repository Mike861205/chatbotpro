const storage = require('../utils/objectStorage');
const { pipeline } = require('node:stream/promises');

async function servePublicAsset(req, res, next) {
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
  try {
    const reference = `/assets${decodeURIComponent(req.path)}`;
    // Same-origin delivery also works in tabs opened before the S3 rollout,
    // whose existing CSP does not allow a redirect to the storage domain.
    // Stream bytes without buffering large media or querying PostgreSQL.
    storage.publicKey(reference);
    const object = await storage.openPublic(reference, { range: req.get('range'), ifNoneMatch: req.get('if-none-match') });
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (object.$metadata?.httpStatusCode === 304) return res.status(304).end();
    res.setHeader('Content-Type', object.ContentType || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    if (object.ContentLength !== undefined) res.setHeader('Content-Length', String(object.ContentLength));
    if (object.ContentRange) res.setHeader('Content-Range', object.ContentRange);
    if (object.ETag) res.setHeader('ETag', object.ETag);
    if (object.LastModified) res.setHeader('Last-Modified', object.LastModified.toUTCString());
    res.status(object.$metadata?.httpStatusCode === 206 ? 206 : 200);
    if (req.method === 'HEAD') { object.Body?.destroy?.(); return res.end(); }
    await pipeline(object.Body, res);
  } catch (error) {
    if (error instanceof URIError || error.status === 400) return res.status(404).end();
    if (res.destroyed) return;
    next(error);
  }
}

module.exports = { servePublicAsset };
