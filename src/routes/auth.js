const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const config = require('../config');
const { q, tdb, initTenantDefaults } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth, requireOwner } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/security');
const { normalizeInternationalPhone, phoneCountries } = require('../utils/phone');
const { regionalDefaults, isSupportedTimeZone } = require('../utils/regional');
const { isMexicoIdentity, invoicingPortalUrl } = require('../utils/invoicing');
const { sendLeadNotification, sendRegistrationNotification } = require('../utils/mailer');

const router = express.Router();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const USERNAME_RE = /^[a-z0-9._-]{3,60}$/;
const RESERVED = new Set(['api', 'app', 'login', 'register', 'admin', 'superadmin', 'resellers', 'uploads', 'c', 'static']);
const SUPPORT_WHATSAPP = '526241370820';
const SUPPORT_MESSAGE = 'tengo suspendiedo mi servicio y quiero realizar mi pago para activarlo';
const authAttemptLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: 'Demasiados intentos de acceso. Espera 15 minutos.',
});

const TRACKABLE_MODULES = new Set([
  'dashboard',
  'pedidos',
  'clientes',
  'pos',
  'facturacion',
  'kds',
  'ventas',
  'productos',
  'costos',
  'inventarios',
  'stock-sucursales',
  'compras',
  'empleados',
  'chatbot',
  'config',
  'suscripciones',
  'instrucciones',
]);

function supportWhatsappUrl() {
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
}

function normalizeLeadText(raw, maxLength = 120) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

async function resolveActiveResellerId(rawSlug) {
  const slug = String(rawSlug || '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return null;
  const found = await q('SELECT id FROM resellers WHERE slug = $1 AND active = 1 LIMIT 1', [slug]);
  return found.rows[0]?.id || null;
}

async function saveDemoLead({ contactName, phone, phoneCountry, businessGiro, sourcePage, tenantSlug, resellerSlug }) {
  const cleanName = normalizeLeadText(contactName, 120);
  const normalizedPhone = normalizeInternationalPhone(phone, phoneCountry);
  const cleanGiro = normalizeLeadText(businessGiro, 120);
  const cleanSource = ['landing', 'login'].includes(String(sourcePage || '').trim().toLowerCase())
    ? String(sourcePage).trim().toLowerCase()
    : 'landing';

  if (!cleanName || !cleanGiro) {
    const err = new Error('Nombre, teléfono y giro del negocio son obligatorios');
    err.status = 400;
    throw err;
  }

  const phoneHash = lookupHash(normalizedPhone.digits);
  const phoneEnc = encrypt(normalizedPhone.e164);
  const resellerId = await resolveActiveResellerId(resellerSlug);
  const legacyHashes = [...new Set([
    phoneHash,
    lookupHash(normalizedPhone.nationalNumber),
    lookupHash(String(phone || '').replace(/\D/g, '')),
  ])];
  const existing = await q(
    `SELECT id, demo_count, first_seen_at
     FROM demo_leads
     WHERE phone_hash = ANY($1::text[])
     ORDER BY CASE WHEN phone_hash = $2 THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [legacyHashes, phoneHash]
  );
  const row = existing.rows[0];

  if (row) {
    await q(
      `UPDATE demo_leads
       SET contact_name = $1,
           phone_enc = $2,
           phone_hash = $3,
           phone_country = $4,
           phone_calling_code = $5,
           business_giro = $6,
           source_page = $7,
           demo_count = COALESCE(demo_count, 0) + 1,
           last_seen_at = now(),
           last_demo_tenant_slug = $8,
           reseller_id = COALESCE(reseller_id, $9)
       WHERE id = $10`,
      [cleanName, phoneEnc, phoneHash, normalizedPhone.country, normalizedPhone.callingCode, cleanGiro, cleanSource, tenantSlug || '', resellerId, row.id]
    );
    return { id: row.id, demo_count: Number(row.demo_count || 1) + 1 };
  }

  const inserted = await q(
    `INSERT INTO demo_leads (contact_name, phone_enc, phone_hash, phone_country, phone_calling_code, business_giro, source_page, demo_count, first_seen_at, last_seen_at, last_demo_tenant_slug, reseller_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, now(), now(), $8, $9)
     RETURNING id, demo_count`,
    [cleanName, phoneEnc, phoneHash, normalizedPhone.country, normalizedPhone.callingCode, cleanGiro, cleanSource, tenantSlug || '', resellerId]
  );
  return inserted.rows[0] || { id: null, demo_count: 1 };
}

function getDemoCredentials() {
  return {
    username: String(config.DEMO_USERNAME || 'demo').trim().toLowerCase() || 'demo',
    password: String(config.DEMO_PASSWORD || ''),
    tenantSlug: String(config.DEMO_TENANT_SLUG || '').trim().toLowerCase(),
  };
}

function isSecureDemoConfigured() {
  const { password, tenantSlug } = getDemoCredentials();
  const optionalPasswordIsSafe = !password || (password.length >= 12 && password.toLowerCase() !== 'demo');
  return Boolean(config.DEMO_LOGIN_ENABLED && SLUG_RE.test(tenantSlug) && optionalPasswordIsSafe);
}

async function resolveDemoTenant(preferredSlug) {
  const slug = String(preferredSlug || '').trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) return null;
  const bySlug = await q('SELECT * FROM tenants WHERE slug = $1 LIMIT 1', [slug]);
  return bySlug.rows[0] || null;
}

async function ensureDemoUser(username, password, tenant) {
  const found = await q('SELECT * FROM users WHERE tenant_id = $1 AND lower(username) = $2 LIMIT 1', [tenant.id, username]);
  const existing = found.rows[0];
  if (existing) return existing;
  const conflict = await q('SELECT id FROM users WHERE lower(username) = $1 LIMIT 1', [username]);
  if (conflict.rows[0]) {
    throw Object.assign(new Error('El usuario demo está asignado a otro negocio'), { status: 503 });
  }
  // La contraseña es interna: el visitante entra sólo mediante el formulario
  // público de leads. Si no se configura una, se genera una aleatoria que no
  // se muestra ni habilita un acceso convencional predecible.
  const internalPassword = password || crypto.randomBytes(32).toString('base64url');
  const hash = await bcrypt.hash(internalPassword, 12);
  const created = await q(
    `INSERT INTO users (tenant_id, username, password_hash, role, display_name, active)
     VALUES ($1, $2, $3, 'owner', $4, 1)
     RETURNING *`,
    [tenant.id, username, hash, 'Demo']
  );
  return created.rows[0];
}

// Registro de un nuevo negocio (tenant) + usuario dueño
router.get('/phone-countries', (req, res) => {
  res.json({ countries: phoneCountries(), defaultCountry: 'MX' });
});

// Despierta la conexión serverless mientras el usuario completa el formulario.
router.get('/register-ready', async (req, res, next) => {
  try {
    await q('SELECT 1');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/register', authAttemptLimiter, async (req, res, next) => {
  try {
    const { ownerName, phone, phoneCountry, businessName, slug, username, password, timezone, reseller } = req.body || {};
    if (!ownerName || !phone || !phoneCountry || !businessName || !slug || !username || !password) {
      return res.status(400).json({ error: 'Todos los campos marcados son obligatorios' });
    }
    const normalizedPhone = normalizeInternationalPhone(phone, phoneCountry);
    const regional = regionalDefaults(normalizedPhone.country);
    if (isSupportedTimeZone(timezone)) regional.timezone = String(timezone).trim();
    const cleanSlug = String(slug).trim().toLowerCase();
    const cleanUser = String(username).trim().toLowerCase();
    const cleanOwnerName = normalizeLeadText(ownerName, 120);
    const cleanBusinessName = normalizeLeadText(businessName, 160);
    const cleanPassword = String(password || '');
    if (!cleanOwnerName || !cleanBusinessName || !USERNAME_RE.test(cleanUser)) {
      return res.status(400).json({ error: 'Revisa nombre, negocio y usuario (3 a 60 caracteres)' });
    }
    if (!SLUG_RE.test(cleanSlug) || RESERVED.has(cleanSlug)) {
      return res.status(400).json({ error: 'El slug debe tener 3-40 caracteres: letras minúsculas, números y guiones' });
    }
    if (cleanPassword.length < 8 || cleanPassword.length > 128) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres' });
    }
    const [conflictResult, passwordHash] = await Promise.all([
      q(
        `SELECT
           (EXISTS (SELECT 1 FROM tenants WHERE slug = $1)
             OR EXISTS (SELECT 1 FROM resellers WHERE slug = $1)) AS slug_exists,
           EXISTS (SELECT 1 FROM users WHERE lower(username) = $2) AS user_exists,
           (SELECT id FROM resellers WHERE slug = $3 AND active = 1 LIMIT 1) AS reseller_id`,
        [cleanSlug, cleanUser, String(reseller || '').trim().toLowerCase()]
      ),
      bcrypt.hash(cleanPassword, 12),
    ]);
    const conflicts = conflictResult.rows[0] || {};
    const resellerId = conflicts.reseller_id || null;
    if (conflicts.slug_exists) return res.status(409).json({ error: 'Ese slug ya está registrado, elige otro' });
    if (conflicts.user_exists) return res.status(409).json({ error: 'Ese usuario ya existe' });

    // Tenant y propietario se crean de forma atómica y en un solo viaje a Neon.
    const created = await q(
      `WITH new_tenant AS (
         INSERT INTO tenants (slug, business_name, owner_name, phone_enc, phone_country, phone_calling_code, timezone, reseller_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $10)
         RETURNING *
       ), new_user AS (
         INSERT INTO users (tenant_id, username, password_hash, onboarding_completed)
         SELECT id, $8, $9, 0 FROM new_tenant
         RETURNING *
       )
       SELECT row_to_json(new_tenant) AS tenant, row_to_json(new_user) AS owner
       FROM new_tenant CROSS JOIN new_user`,
      [
        cleanSlug,
        cleanBusinessName,
        cleanOwnerName,
        encrypt(normalizedPhone.e164),
        normalizedPhone.country,
        normalizedPhone.callingCode,
        regional.timezone,
        cleanUser,
        passwordHash,
        resellerId,
      ]
    );
    const tenant = created.rows[0].tenant;
    const owner = created.rows[0].owner;

    // Crea el SCHEMA AISLADO del tenant en Neon con valores por defecto
    await initTenantDefaults(cleanSlug, cleanBusinessName, regional, tenant.id);

    // Notificación por email del nuevo registro
    sendRegistrationNotification({
      ownerName: cleanOwnerName,
      phone: normalizedPhone.e164,
      phoneCountry: normalizedPhone.country,
      callingCode: normalizedPhone.callingCode,
      businessName: cleanBusinessName,
      slug: cleanSlug,
      username: cleanUser,
      timezone: regional.timezone,
    }).catch(err => console.error('[mailer] fire-and-forget register error:', err.message));

    setAuthCookie(res, signToken(owner, tenant), 'owner');
    res.json({ ok: true, slug: cleanSlug });
  } catch (e) {
    next(e);
  }
});

router.post('/login', authAttemptLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    const cleanUsername = String(username).trim().toLowerCase();
    const cleanPassword = String(password);
    if (!USERNAME_RE.test(cleanUsername) || cleanPassword.length > 128) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const u = await q('SELECT * FROM users WHERE lower(username) = $1', [cleanUsername]);
    const user = u.rows[0];
    if (!user || !(await bcrypt.compare(cleanPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    if (!Number(user.active)) {
      return res.status(403).json({ error: 'Este usuario está inactivo' });
    }
    const t = await q('SELECT * FROM tenants WHERE id = $1', [user.tenant_id]);
    const tenant = t.rows[0];
    if (!tenant) return res.status(401).json({ error: 'Tenant no encontrado' });
    if (tenant.account_status !== 'active') {
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
    setAuthCookie(res, signToken(user, tenant), 'owner');
    res.json({ ok: true, slug: tenant.slug });
  } catch (e) {
    next(e);
  }
});

router.get('/demo-status', (req, res) => {
  res.json({ enabled: isSecureDemoConfigured() });
});

router.post('/demo-login', authAttemptLimiter, async (req, res, next) => {
  try {
    if (!isSecureDemoConfigured()) {
      return res.status(404).json({ error: 'Acceso demo no disponible' });
    }

    const body = req.body || {};
    const contactName = body.contactName ?? body.name ?? body.ownerName;
    const phone = body.phone ?? body.contactPhone;
    const phoneCountry = body.phoneCountry ?? body.country;
    const businessGiro = body.businessGiro ?? body.giro ?? body.businessType;
    const sourcePage = body.sourcePage ?? body.source ?? 'landing';

    let demoLead;
    try {
      demoLead = await saveDemoLead({
        contactName,
        phone,
        phoneCountry,
        businessGiro,
        sourcePage,
        tenantSlug: String(config.DEMO_TENANT_SLUG || '').trim().toLowerCase(),
        resellerSlug: body.reseller ?? body.referrer ?? '',
      });
    } catch (e) {
      if (e?.status === 400) {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }

    // Notificación por email solo para leads NUEVOS (primera vez)
    if (demoLead && demoLead.demo_count === 1) {
      const normalized = normalizeInternationalPhone(phone, phoneCountry);
      sendLeadNotification({
        contactName: normalizeLeadText(contactName, 120),
        phone: normalized.e164,
        phoneCountry: normalized.country,
        callingCode: normalized.callingCode,
        businessGiro: normalizeLeadText(businessGiro, 120),
        sourcePage: sourcePage || 'landing',
      }).catch(err => console.error('[mailer] fire-and-forget lead error:', err.message));
    }

    const { username: demoUsername, password: demoPassword, tenantSlug: demoTenantSlug } = getDemoCredentials();
    if (!demoTenantSlug || (demoPassword && (demoPassword.length < 12 || demoPassword.toLowerCase() === 'demo'))) {
      return res.status(503).json({ error: 'El acceso demo no está configurado de forma segura' });
    }

    const targetTenant = await resolveDemoTenant(demoTenantSlug);
    if (!targetTenant) {
      return res.status(503).json({ error: 'No hay un tenant activo disponible para demo' });
    }
    if (targetTenant.account_status !== 'active') {
      return res.status(403).json({ error: 'La cuenta demo está inactiva. Contacta al administrador.' });
    }
    if (targetTenant.billing_status === 'suspended') {
      return res.status(403).json({
        error: 'Suspendido por falta de pago. Ponte en contacto con tu asesor.',
        errorCode: 'BILLING_SUSPENDED',
        supportPhone: SUPPORT_WHATSAPP,
        whatsappUrl: supportWhatsappUrl(),
      });
    }

    let user = await ensureDemoUser(
      demoUsername,
      demoPassword,
      targetTenant
    );

    if (demoPassword && !(await bcrypt.compare(demoPassword, user.password_hash))) {
      return res.status(503).json({ error: 'Las credenciales del usuario demo no coinciden con la configuración' });
    }

    if (!Number(user.active)) {
      return res.status(403).json({ error: 'La cuenta demo está inactiva' });
    }

    const t = await q('SELECT * FROM tenants WHERE id = $1', [user.tenant_id]);
    const tenant = t.rows[0];
    if (!tenant) return res.status(503).json({ error: 'Tenant demo no encontrado' });
    if (demoTenantSlug && tenant.slug !== demoTenantSlug) {
      return res.status(503).json({ error: 'El tenant demo configurado no coincide con el usuario demo' });
    }
    if (tenant.account_status !== 'active') {
      return res.status(403).json({ error: 'La cuenta demo está inactiva. Contacta al administrador.' });
    }
    if (tenant.billing_status === 'suspended') {
      return res.status(403).json({
        error: 'Suspendido por falta de pago. Ponte en contacto con tu asesor.',
        errorCode: 'BILLING_SUSPENDED',
        supportPhone: SUPPORT_WHATSAPP,
        whatsappUrl: supportWhatsappUrl(),
      });
    }

    setAuthCookie(res, signToken(user, tenant, 'owner', { demoLeadId: demoLead?.id }), 'owner');
    res.json({ ok: true, slug: tenant.slug, demo: true });
  } catch (e) {
    next(e);
  }
});

router.post('/module-usage', requireAuth, async (req, res, next) => {
  try {
    const moduleKey = String(req.body?.module || '').trim().toLowerCase();
    if (!TRACKABLE_MODULES.has(moduleKey)) {
      return res.status(400).json({ error: 'Módulo no válido' });
    }

    // Las sesiones abiertas desde SuperAdmin son soporte técnico y no deben
    // contaminar las métricas reales de uso del tenant.
    if (req.user.impersonated) return res.json({ ok: true, tracked: false });

    const tenantId = Number(req.tenant.id);
    const demoLeadId = Number(req.user.demoLeadId || 0);
    let result;

    if (Number.isInteger(demoLeadId) && demoLeadId > 0) {
      result = await q(
        `INSERT INTO module_usage (tenant_id, demo_lead_id, module_key, view_count, first_seen_at, last_seen_at)
         SELECT $1, dl.id, $3, 1, now(), now()
         FROM demo_leads dl
         WHERE dl.id = $2
         ON CONFLICT (demo_lead_id, module_key) WHERE demo_lead_id IS NOT NULL
         DO UPDATE SET view_count = module_usage.view_count + 1, last_seen_at = now()
         RETURNING view_count`,
        [tenantId, demoLeadId, moduleKey]
      );
      await q('UPDATE demo_leads SET last_seen_at = now() WHERE id = $1', [demoLeadId]);
    } else {
      result = await q(
        `INSERT INTO module_usage (tenant_id, demo_lead_id, module_key, view_count, first_seen_at, last_seen_at)
         VALUES ($1, NULL, $2, 1, now(), now())
         ON CONFLICT (tenant_id, module_key) WHERE demo_lead_id IS NULL
         DO UPDATE SET view_count = module_usage.view_count + 1, last_seen_at = now()
         RETURNING view_count`,
        [tenantId, moduleKey]
      );
    }

    res.json({ ok: true, tracked: Boolean(result.rowCount), count: Number(result.rows[0]?.view_count || 0) });
  } catch (e) {
    next(e);
  }
});

router.get('/cashier-info/:slug', async (req, res, next) => {
  try {
    const cashierSlug = String(req.params.slug || '').trim().toLowerCase();
    const found = await q(
      `SELECT u.id AS uid, u.username, u.display_name, u.branch_id, u.cashier_slug, u.active,
              t.id AS tid, t.slug AS tenant_slug, t.business_name, t.logo, t.primary_color,
              t.account_status, t.billing_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.cashier_slug = $1 AND u.role = 'cashier'
       LIMIT 1`,
      [cashierSlug]
    );
    const cashier = found.rows[0];
    if (!cashier || !Number(cashier.active)) return res.status(404).json({ error: 'Caja no encontrada' });
    if (cashier.account_status !== 'active' || cashier.billing_status === 'suspended') {
      return res.status(403).json({ error: 'Esta caja no está disponible actualmente' });
    }
    const tenantDb = tdb(cashier.tenant_slug);
    const branch = cashier.branch_id ? await tenantDb.get('SELECT id, name FROM {s}.branches WHERE id = $1 LIMIT 1', [Number(cashier.branch_id)]) : null;
    res.json({
      cashierSlug: cashier.cashier_slug,
      username: cashier.username,
      displayName: cashier.display_name || cashier.username,
      branchId: branch?.id || null,
      branchName: branch?.name || '',
      tenant: {
        slug: cashier.tenant_slug,
        businessName: cashier.business_name,
        logo: cashier.logo,
        primaryColor: cashier.primary_color,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/cashier-login', authAttemptLimiter, async (req, res, next) => {
  try {
    const cashierSlug = String(req.body?.cashierSlug || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!cashierSlug || !password) return res.status(400).json({ error: 'La clave de acceso es obligatoria' });
    const found = await q(
      `SELECT u.id AS uid, u.username, u.password_hash, u.active, u.role, u.cashier_slug,
              t.id AS tid, t.slug AS tenant_slug, t.business_name, t.account_status, t.billing_status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.cashier_slug = $1 AND u.role = 'cashier'
       LIMIT 1`,
      [cashierSlug]
    );
    const row = found.rows[0];
    if (!row || !Number(row.active) || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Acceso incorrecto' });
    }
    if (row.account_status !== 'active') {
      return res.status(403).json({ error: 'La cuenta del negocio está inactiva. Contacta al administrador.' });
    }
    if (row.billing_status === 'suspended') {
      return res.status(403).json({
        error: 'Suspendido por falta de pago. Ponte en contacto con tu asesor.',
        errorCode: 'BILLING_SUSPENDED',
        supportPhone: SUPPORT_WHATSAPP,
        whatsappUrl: supportWhatsappUrl(),
      });
    }
    // Usamos ids correctos: uid del usuario y tid del tenant (evita conflicto de columna id en join)
    setAuthCookie(res, signToken(
      { id: row.uid, username: row.username },
      { id: row.tid, slug: row.tenant_slug },
      'cashier'
    ), 'cashier');
    res.json({ ok: true, redirectTo: '/app#pos' });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  const scope = String(req.get('x-cbp-auth-scope') || 'all').trim().toLowerCase();
  clearAuthCookie(res, scope || 'all');
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    let phoneCountry = req.tenant.phone_country || '';
    let phoneCallingCode = req.tenant.phone_calling_code || '';
    const isDemoTenant = req.tenant.slug === config.DEMO_TENANT_SLUG;
    let invoicingEligible = isDemoTenant || (isMexicoIdentity(req.tenant) && Boolean(Number(req.tenant.invoicing_enabled)));
    const demoLeadId = Number(req.user.demoLeadId || 0);
    if (!invoicingEligible && Number.isInteger(demoLeadId) && demoLeadId > 0) {
      const lead = await q('SELECT phone_country, phone_calling_code FROM demo_leads WHERE id = $1 LIMIT 1', [demoLeadId]);
      if (isMexicoIdentity(lead.rows[0])) {
        invoicingEligible = true;
        phoneCountry = lead.rows[0].phone_country || phoneCountry;
        phoneCallingCode = lead.rows[0].phone_calling_code || phoneCallingCode;
      }
    }
    res.json({
    username: req.user.username,
    role: req.user.role,
    displayName: req.user.displayName,
    branchId: req.user.branchId,
    branchName: req.user.branchName,
    cashierSlug: req.user.cashierSlug,
    onboardingCompleted: req.user.onboardingCompleted,
    onboardingRequired: req.user.role === 'owner' && !req.user.onboardingCompleted && !req.user.impersonated,
    tenant: {
      slug: req.tenant.slug,
      businessName: req.tenant.business_name,
      ownerName: req.tenant.owner_name,
      phone: decrypt(req.tenant.phone_enc) || '',
      logo: req.tenant.logo,
      primaryColor: req.tenant.primary_color,
      phoneCountry,
      phoneCallingCode,
      invoicingEligible,
      invoicingActivated: Boolean(Number(req.tenant.invoicing_enabled)),
      invoicingPortalUrl: invoicingPortalUrl(req, config.INVOICING_PORTAL_ORIGIN, req.tenant.slug),
    },
  });
  } catch (error) {
    next(error);
  }
});

router.post('/onboarding/complete', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await q('UPDATE users SET onboarding_completed = 1 WHERE id = $1', [req.user.uid]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
