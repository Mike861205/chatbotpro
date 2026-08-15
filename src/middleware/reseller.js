const jwt = require('jsonwebtoken');
const config = require('../config');
const { q } = require('../db');

const RESELLER_COOKIE = 'cbp_reseller_token';

function signResellerToken(reseller) {
  return jwt.sign(
    { rid: reseller.id, slug: reseller.slug, username: reseller.username, role: 'reseller' },
    config.SUPERADMIN_JWT_SECRET,
    { expiresIn: '12h', issuer: 'chatbotpro', audience: 'cbp:reseller' }
  );
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    priority: 'high',
    maxAge: 12 * 60 * 60 * 1000,
  };
}

function setResellerCookie(res, token) {
  res.cookie(RESELLER_COOKIE, token, cookieOptions());
}

function clearResellerCookie(res) {
  const options = cookieOptions();
  delete options.maxAge;
  res.clearCookie(RESELLER_COOKIE, options);
}

async function requireReseller(req, res, next) {
  const token = req.cookies[RESELLER_COOKIE];
  if (!token) return res.status(401).json({ error: 'No autenticado como reseller' });
  try {
    const payload = jwt.verify(token, config.SUPERADMIN_JWT_SECRET, {
      issuer: 'chatbotpro',
      audience: 'cbp:reseller',
    });
    if (payload.role !== 'reseller') return res.status(401).json({ error: 'Sesión de reseller inválida' });
    const found = await q(
      'SELECT id, slug, display_name, username, contact_name, active FROM resellers WHERE id = $1',
      [payload.rid]
    );
    const reseller = found.rows[0];
    if (!reseller || !Number(reseller.active)) return res.status(401).json({ error: 'Reseller inválido o inactivo' });
    req.reseller = reseller;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión de reseller inválida o expirada' });
    }
    next(error);
  }
}

module.exports = {
  RESELLER_COOKIE,
  signResellerToken,
  setResellerCookie,
  clearResellerCookie,
  requireReseller,
};
