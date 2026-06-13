const jwt = require('jsonwebtoken');
const config = require('../config');
const { q, tdb } = require('../db');

const COOKIE_NAME = 'cbp_token';
const SUPPORT_WHATSAPP = '526241370820';
const SUPPORT_MESSAGE = 'tengo suspendiedo mi servicio y quiero realizar mi pago para activarlo';

function supportWhatsappUrl() {
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
}

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

async function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const { rows } = await q('SELECT * FROM tenants WHERE id = $1', [payload.tid]);
    if (!rows[0]) return res.status(401).json({ error: 'Tenant no encontrado' });
    if (rows[0].account_status !== 'active') {
      return res.status(403).json({ error: 'La cuenta del negocio está inactiva. Contacta al administrador.' });
    }
    if (rows[0].billing_status === 'suspended') {
      return res.status(403).json({
        error: 'Suspendido por falta de pago. Ponte en contacto con tu asesor.',
        errorCode: 'BILLING_SUSPENDED',
        supportPhone: SUPPORT_WHATSAPP,
        whatsappUrl: supportWhatsappUrl(),
      });
    }
    req.user = payload;
    req.tenant = rows[0];
    req.tdb = tdb(rows[0].slug); // schema aislado del tenant autenticado
    next();
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    next(e);
  }
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth, COOKIE_NAME };
