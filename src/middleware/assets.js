const storage = require('../utils/objectStorage');

async function servePublicAsset(req, res, next) {
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();
  try {
    const reference = `/assets${decodeURIComponent(req.path)}`;
    // Only the public/ prefix can be signed by this route. Private files are
    // read through the existing authenticated routes for each tenant.
    storage.publicKey(reference);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(302, await storage.signedPublicUrl(reference));
  } catch (error) {
    if (error instanceof URIError || error.status === 400) return res.status(404).end();
    next(error);
  }
}

module.exports = { servePublicAsset };
