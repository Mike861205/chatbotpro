const express = require('express');
const bcrypt = require('bcryptjs');
const { q, tdb, initTenantDefaults } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
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
