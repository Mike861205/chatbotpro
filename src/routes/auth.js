const express = require('express');
const bcrypt = require('bcryptjs');
const { q, initTenantDefaults } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESERVED = new Set(['api', 'app', 'login', 'register', 'admin', 'uploads', 'c', 'static']);

// Registro de un nuevo negocio (tenant) + usuario dueño
router.post('/register', async (req, res, next) => {
  try {
    const { ownerName, phone, businessName, slug, username, password } = req.body || {};
    if (!ownerName || !businessName || !slug || !username || !password) {
      return res.status(400).json({ error: 'Todos los campos marcados son obligatorios' });
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
      [cleanSlug, businessName.trim(), ownerName.trim(), encrypt(phone || '')]
    );
    const tenant = t.rows[0];
    const u = await q(
      'INSERT INTO users (tenant_id, username, password_hash) VALUES ($1, $2, $3) RETURNING *',
      [tenant.id, cleanUser, passwordHash]
    );

    // Crea el SCHEMA AISLADO del tenant en Neon con valores por defecto
    await initTenantDefaults(cleanSlug, businessName.trim());

    setAuthCookie(res, signToken(u.rows[0], tenant));
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
    const t = await q('SELECT * FROM tenants WHERE id = $1', [user.tenant_id]);
    setAuthCookie(res, signToken(user, t.rows[0]));
    res.json({ ok: true, slug: t.rows[0].slug });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
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
