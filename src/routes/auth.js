const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { q, tdb, initTenantDefaults } = require('../db');
const { encrypt, decrypt, lookupHash } = require('../utils/crypto');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESERVED = new Set(['api', 'app', 'login', 'register', 'admin', 'uploads', 'c', 'static']);
const SUPPORT_WHATSAPP = '526241370820';
const SUPPORT_MESSAGE = 'tengo suspendiedo mi servicio y quiero realizar mi pago para activarlo';

function supportWhatsappUrl() {
  return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

function normalizeLeadText(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

async function saveDemoLead({ contactName, phone, businessGiro, sourcePage, tenantSlug }) {
  const cleanName = normalizeLeadText(contactName);
  const cleanPhone = normalizePhone(phone);
  const cleanGiro = normalizeLeadText(businessGiro);
  const cleanSource = ['landing', 'login'].includes(String(sourcePage || '').trim().toLowerCase())
    ? String(sourcePage).trim().toLowerCase()
    : 'landing';

  if (!cleanName || !cleanPhone || !cleanGiro) {
    const err = new Error('Nombre, telefono y giro del negocio son obligatorios');
    err.status = 400;
    throw err;
  }

  const phoneHash = lookupHash(cleanPhone);
  const phoneEnc = encrypt(cleanPhone);
  const existing = await q('SELECT id, demo_count, first_seen_at FROM demo_leads WHERE phone_hash = $1 LIMIT 1', [phoneHash]);
  const row = existing.rows[0];

  if (row) {
    await q(
      `UPDATE demo_leads
       SET contact_name = $1,
           phone_enc = $2,
           business_giro = $3,
           source_page = $4,
           demo_count = COALESCE(demo_count, 0) + 1,
           last_seen_at = now(),
           last_demo_tenant_slug = $5
       WHERE id = $6`,
      [cleanName, phoneEnc, cleanGiro, cleanSource, tenantSlug || '', row.id]
    );
    return { id: row.id, demo_count: Number(row.demo_count || 1) + 1 };
  }

  const inserted = await q(
    `INSERT INTO demo_leads (contact_name, phone_enc, phone_hash, business_giro, source_page, demo_count, first_seen_at, last_seen_at, last_demo_tenant_slug)
     VALUES ($1, $2, $3, $4, $5, 1, now(), now(), $6)
     RETURNING id, demo_count`,
    [cleanName, phoneEnc, phoneHash, cleanGiro, cleanSource, tenantSlug || '']
  );
  return inserted.rows[0] || { id: null, demo_count: 1 };
}

function getDemoCredentials() {
  return {
    username: String(config.DEMO_USERNAME || 'demo').trim().toLowerCase() || 'demo',
    password: String(config.DEMO_PASSWORD || 'demo') || 'demo',
    tenantSlug: String(config.DEMO_TENANT_SLUG || '').trim().toLowerCase(),
  };
}

async function resolveDemoTenant(preferredSlug) {
  const slug = String(preferredSlug || '').trim().toLowerCase();
  if (slug) {
    const bySlug = await q('SELECT * FROM tenants WHERE slug = $1 LIMIT 1', [slug]);
    return bySlug.rows[0] || null;
  }
  const firstActive = await q(
    `SELECT *
     FROM tenants
     WHERE account_status = 'active'
       AND billing_status <> 'suspended'
     ORDER BY id ASC
     LIMIT 1`
  );
  return firstActive.rows[0] || null;
}

async function ensureDemoUser(username, password, tenant) {
  const found = await q('SELECT * FROM users WHERE lower(username) = $1 LIMIT 1', [username]);
  const existing = found.rows[0];
  if (existing) return existing;
  const hash = await bcrypt.hash(password, 12);
  const created = await q(
    `INSERT INTO users (tenant_id, username, password_hash, role, display_name, active)
     VALUES ($1, $2, $3, 'owner', $4, 1)
     RETURNING *`,
    [tenant.id, username, hash, 'Demo']
  );
  return created.rows[0];
}

// Registro de un nuevo negocio (tenant) + usuario dueño
router.post('/register', async (req, res, next) => {
  try {
    const { ownerName, phone, businessName, slug, username, password } = req.body || {};
    if (!ownerName || !phone || !businessName || !slug || !username || !password) {
      return res.status(400).json({ error: 'Todos los campos marcados son obligatorios' });
    }
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Ingresa un telefono valido de 10 a 15 digitos' });
    }
    const cleanSlug = String(slug).trim().toLowerCase();
    const cleanUser = String(username).trim().toLowerCase();
    if (!SLUG_RE.test(cleanSlug) || RESERVED.has(cleanSlug)) {
      return res.status(400).json({ error: 'El slug debe tener 3-40 caracteres: letras minúsculas, números y guiones' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    const dupSlug = await q('SELECT 1 FROM tenants WHERE slug = $1', [cleanSlug]);
    if (dupSlug.rows.length) return res.status(409).json({ error: 'Ese slug ya está registrado, elige otro' });
    const dupUser = await q('SELECT 1 FROM users WHERE lower(username) = $1', [cleanUser]);
    if (dupUser.rows.length) return res.status(409).json({ error: 'Ese usuario ya existe' });

    const passwordHash = await bcrypt.hash(password, 12);
    const t = await q(
      'INSERT INTO tenants (slug, business_name, owner_name, phone_enc) VALUES ($1, $2, $3, $4) RETURNING *',
      [cleanSlug, businessName.trim(), ownerName.trim(), encrypt(cleanPhone)]
    );
    const tenant = t.rows[0];
    const u = await q(
      'INSERT INTO users (tenant_id, username, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [tenant.id, cleanUser, passwordHash]
    );

    // Crea el SCHEMA AISLADO del tenant en Neon con valores por defecto
    await initTenantDefaults(cleanSlug, businessName.trim());

    setAuthCookie(res, signToken(u.rows[0], tenant), 'owner');
    res.json({ ok: true, slug: cleanSlug });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    const u = await q('SELECT * FROM users WHERE lower(username) = $1', [String(username).trim().toLowerCase()]);
    const user = u.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
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

router.post('/demo-login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const contactName = body.contactName ?? body.name ?? body.ownerName;
    const phone = body.phone ?? body.contactPhone;
    const businessGiro = body.businessGiro ?? body.giro ?? body.businessType;
    const sourcePage = body.sourcePage ?? body.source ?? 'landing';

    try {
      await saveDemoLead({
        contactName,
        phone,
        businessGiro,
        sourcePage,
        tenantSlug: String(config.DEMO_TENANT_SLUG || '').trim().toLowerCase(),
      });
    } catch (e) {
      if (e?.status === 400) {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }

    if (!config.DEMO_LOGIN_ENABLED) {
      return res.status(404).json({ error: 'Acceso demo no disponible' });
    }

    const { username: demoUsername, password: demoPassword, tenantSlug: demoTenantSlug } = getDemoCredentials();

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

    // Si el usuario demo ya existía con otra contraseña, la forzamos a demo para acceso rápido.
    if (!(await bcrypt.compare(demoPassword, user.password_hash))) {
      const newHash = await bcrypt.hash(demoPassword, 12);
      const updated = await q('UPDATE users SET password_hash = $2, active = 1 WHERE id = $1 RETURNING *', [user.id, newHash]);
      user = updated.rows[0] || user;
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

    setAuthCookie(res, signToken(user, tenant), 'owner');
    res.json({ ok: true, slug: tenant.slug, demo: true });
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

router.post('/cashier-login', async (req, res, next) => {
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
      { id: row.tid, slug: row.tenant_slug }
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

router.get('/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    displayName: req.user.displayName,
    branchId: req.user.branchId,
    branchName: req.user.branchName,
    cashierSlug: req.user.cashierSlug,
    tenant: {
      slug: req.tenant.slug,
      businessName: req.tenant.business_name,
      ownerName: req.tenant.owner_name,
      phone: decrypt(req.tenant.phone_enc) || '',
      logo: req.tenant.logo,
      primaryColor: req.tenant.primary_color,
    },
  });
});

module.exports = router;
