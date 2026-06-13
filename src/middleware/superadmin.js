const jwt = require('jsonwebtoken');
const config = require('../config');
const { q } = require('../db');

const SUPERADMIN_COOKIE = 'cbp_sa_token';

function signSuperAdminToken(user) {
  return jwt.sign(
    { sid: user.id, username: user.username, role: 'superadmin' },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function setSuperAdminCookie(res, token) {
  res.cookie(SUPERADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSuperAdminCookie(res) {
  res.clearCookie(SUPERADMIN_COOKIE);
}

async function requireSuperAdmin(req, res, next) {
  const token = req.cookies[SUPERADMIN_COOKIE];
  if (!token) return res.status(401).json({ error: 'No autenticado como superadmin' });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const row = await q('SELECT id, username, active FROM superadmin_users WHERE id = $1', [payload.sid]);
    const user = row.rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'Superadmin inválido o inactivo' });
    req.superadmin = user;
    next();
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión de superadmin inválida o expirada' });
    }
    next(e);
  }
}

module.exports = {
  SUPERADMIN_COOKIE,
  signSuperAdminToken,
  setSuperAdminCookie,
  clearSuperAdminCookie,
  requireSuperAdmin,
};
