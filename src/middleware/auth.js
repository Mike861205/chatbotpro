const jwt = require('jsonwebtoken');
const config = require('../config');
const master = require('../db/master');
const { getTenantDb } = require('../db/tenant');

const COOKIE_NAME = 'cbp_token';

function signToken(user, tenant) {
  return jwt.sign(
    { uid: user.id, tid: tenant.id, slug: tenant.slug, username: user.username },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const tenant = master.prepare('SELECT * FROM tenants WHERE id = ?').get(payload.tid);
    if (!tenant) return res.status(401).json({ error: 'Tenant no encontrado' });
    req.user = payload;
    req.tenant = tenant;
    req.tdb = getTenantDb(tenant.slug); // BD aislada del tenant autenticado
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth, COOKIE_NAME };
