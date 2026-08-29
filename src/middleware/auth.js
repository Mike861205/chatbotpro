const jwt = require('jsonwebtoken');
const config = require('../config');
const { q, tdb } = require('../db');
const { normalizeTimeZone } = require('../utils/regional');
const { normalizeModules } = require('../utils/modules');
const { trialState } = require('../utils/trialAccess');

const COOKIE_NAME = 'cbp_token';
const OWNER_COOKIE_NAME = 'cbp_owner_token';
const CASHIER_COOKIE_NAME = 'cbp_cashier_token';
const AUTH_SCOPE_HEADER = 'x-cbp-auth-scope';
const SUPPORT_WHATSAPP = '526241370820';
const SUPPORT_MESSAGE = 'tengo suspendiedo mi servicio y quiero realizar mi pago para activarlo';
const SUBSCRIPTION_URL = '/app#suscripciones';

function supportWhatsappUrl() {
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
}

function signToken(user, tenant, scope = 'owner', context = {}) {
  const normalizedScope = normalizeScope(scope) || 'owner';
  const demoLeadId = Number(context.demoLeadId || 0);
  const extraClaims = {};
  if (Number.isInteger(demoLeadId) && demoLeadId > 0) extraClaims.dlid = demoLeadId;
  if (context.impersonated) extraClaims.imp = true;
  return jwt.sign(
    { uid: user.id, tid: tenant.id, slug: tenant.slug, username: user.username, typ: normalizedScope, ...extraClaims },
    config.JWT_SECRET,
    { expiresIn: '7d', issuer: 'chatbotpro', audience: `cbp:${normalizedScope}` }
  );
}

function normalizeScope(raw) {
  const val = String(raw || '').trim().toLowerCase();
  if (val === 'owner' || val === 'cashier') return val;
  return '';
}

function cookieNameForScope(scope) {
  if (scope === 'cashier') return CASHIER_COOKIE_NAME;
  return OWNER_COOKIE_NAME;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    priority: 'high',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function setAuthCookie(res, token, scope = 'owner') {
  const normalized = normalizeScope(scope) || 'owner';
  res.cookie(cookieNameForScope(normalized), token, cookieOptions());
}

function clearAuthCookie(res, scope = 'all') {
  const normalized = normalizeScope(scope);
  const clearOpts = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  };
  if (!normalized || scope === 'all') {
    res.clearCookie(OWNER_COOKIE_NAME, clearOpts);
    res.clearCookie(CASHIER_COOKIE_NAME, clearOpts);
    // Compatibilidad con sesiones antiguas
    res.clearCookie(COOKIE_NAME, clearOpts);
    return;
  }
  res.clearCookie(cookieNameForScope(normalized), clearOpts);
}

async function requireAuth(req, res, next) {
  const requestedScope = normalizeScope(req.get(AUTH_SCOPE_HEADER));
  let token = '';
  let tokenScope = requestedScope;
  if (requestedScope === 'owner') {
    token = req.cookies[OWNER_COOKIE_NAME] || '';
  } else if (requestedScope === 'cashier') {
    token = req.cookies[CASHIER_COOKIE_NAME] || '';
  } else {
    if (req.cookies[OWNER_COOKIE_NAME]) {
      token = req.cookies[OWNER_COOKIE_NAME];
      tokenScope = 'owner';
    } else if (req.cookies[CASHIER_COOKIE_NAME]) {
      token = req.cookies[CASHIER_COOKIE_NAME];
      tokenScope = 'cashier';
    }
  }
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'chatbotpro',
      audience: `cbp:${tokenScope}`,
    });
    if (payload.typ !== tokenScope) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    const authResult = await q(
      `SELECT row_to_json(u) AS auth_user, row_to_json(t) AS tenant
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id AND t.id = $2
       WHERE u.id = $1
       LIMIT 1`,
      [payload.uid, payload.tid]
    );
    const authUser = authResult.rows[0]?.auth_user;
    const tenant = authResult.rows[0]?.tenant;
    if (!authUser || !Number(authUser.active)) {
      return res.status(401).json({ error: 'Usuario inactivo o no encontrado' });
    }
    if (!tenant) return res.status(401).json({ error: 'Tenant no encontrado' });
    const trial = trialState(tenant);
    let allowExpiredProfile = false;
    if (trial.isExpired && !payload.imp) {
      if (tenant.trial_status !== 'expired') {
        await q("UPDATE tenants SET trial_status = 'expired', account_status = 'inactive' WHERE id = $1 AND trial_status = 'active'", [tenant.id]);
        tenant.trial_status = 'expired';
        tenant.account_status = 'inactive';
      }
      const isOwnProfile = req.baseUrl === '/api/auth' && req.path === '/me';
      allowExpiredProfile = isOwnProfile;
      if (!isOwnProfile) {
        return res.status(403).json({
          error: 'Tu prueba real de 5 días terminó. Tus datos siguen guardados; elige una suscripción o contacta al administrador para reactivar tu cuenta.',
          errorCode: 'TRIAL_EXPIRED',
          supportPhone: SUPPORT_WHATSAPP,
          whatsappUrl: supportWhatsappUrl(),
          subscriptionUrl: SUBSCRIPTION_URL,
        });
      }
    }
    if (tenant.account_status !== 'active' && !allowExpiredProfile) {
      return res.status(403).json({ error: 'La cuenta del negocio está inactiva. Contacta al administrador.' });
    }
    if (tenant.billing_status === 'suspended') {
      return res.status(403).json({
        error: 'Suspendido por falta de pago. Ponte en contacto con tu asesor.',
        errorCode: 'BILLING_SUSPENDED',
        supportPhone: SUPPORT_WHATSAPP,
        whatsappUrl: supportWhatsappUrl(),
      });
    }
    req.tenant = tenant;
    req.tdb = tdb(tenant.slug); // schema aislado del tenant autenticado
    req.timezone = normalizeTimeZone(tenant.timezone);
    req.tdb.timezone = req.timezone;
    let branchName = '';
    const branchId = Number.isInteger(Number(authUser.branch_id)) && Number(authUser.branch_id) > 0 ? Number(authUser.branch_id) : null;
    if (branchId) {
      const branchRow = await req.tdb.get('SELECT id, name FROM {s}.branches WHERE id = $1 LIMIT 1', [branchId]);
      branchName = branchRow?.name || '';
    }
    req.user = {
      uid: authUser.id,
      tid: tenant.id,
      slug: tenant.slug,
      username: authUser.username,
      role: authUser.role || 'owner',
      jobTitle: authUser.job_title || '',
      permissions: normalizeModules(authUser.permissions_json),
      displayName: authUser.display_name || authUser.username,
      branchId,
      branchName,
      cashierSlug: authUser.cashier_slug || '',
      active: Number(authUser.active || 0),
      onboardingCompleted: Number(authUser.onboarding_completed || 0) === 1,
      demoLeadId: Number.isInteger(Number(payload.dlid)) && Number(payload.dlid) > 0 ? Number(payload.dlid) : null,
      impersonated: payload.imp === true,
    };
    next();
  } catch (e) {
    if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión inválida o expirada' });
    }
    next(e);
  }
}

function requireOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });
  if (req.user.role !== 'owner' && req.user.role !== 'staff') {
    return res.status(403).json({ error: 'No tienes permiso para acceder a este módulo' });
  }
  next();
}

function requireModules(...moduleKeys) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (req.user.role === 'cashier' && moduleKeys.some((key) => ['pos', 'pedidos', 'cortes', 'cancelaciones'].includes(key))) return next();
    if (req.user.role === 'owner' || (req.user.role === 'staff' && moduleKeys.some((key) => req.user.permissions.includes(key)))) return next();
    return res.status(403).json({ error: 'No tienes permiso para acceder a este modulo' });
  };
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth, requireOwner, requireModules, COOKIE_NAME };
