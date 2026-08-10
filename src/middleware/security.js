const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function securityHeaders() {
  return helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdn.jsdelivr.net'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://api.qrserver.com'],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: process.env.NODE_ENV === 'production'
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
  });
}

function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    return res.status(403).json({ error: 'Solicitud de otro sitio bloqueada' });
  }

  const rawOrigin = String(req.get('origin') || '').trim();
  if (rawOrigin) {
    let origin;
    try {
      origin = new URL(rawOrigin).origin;
    } catch {
      return res.status(403).json({ error: 'Origen de solicitud no permitido' });
    }
    const expectedOrigin = `${req.protocol}://${String(req.get('host') || '').trim()}`;
    if (origin !== expectedOrigin) {
      return res.status(403).json({ error: 'Origen de solicitud no permitido' });
    }
  }

  next();
}

function apiNoStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

function createRateLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: message || 'Demasiadas solicitudes, intenta mas tarde' },
  });
}

module.exports = { apiNoStore, createRateLimiter, requireSameOrigin, securityHeaders };
