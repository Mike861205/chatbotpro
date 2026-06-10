const express = require('express');
const bcrypt = require('bcryptjs');
const master = require('../db/master');
const { initTenantDefaults } = require('../db/tenant');
const { encrypt, decrypt } = require('../utils/crypto');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESERVED = new Set(['api', 'app', 'login', 'register', 'admin', 'uploads', 'c', 'static']);

// Registro de un nuevo negocio (tenant) + usuario dueño
router.post('/register', async (req, res) => {
  try {
    const { ownerName, phone, businessName, slug, username, password } = req.body || {};
    if (!ownerName || !businessName || !slug || !username || !password) {
      return res.status(400).json({ error: 'Todos los campos marcados son obligatorios' });
    }
    const cleanSlug = String(slug).trim().toLowerCase();
    if (!SLUG_RE.test(cleanSlug) || RESERVED.has(cleanSlug)) {
      return res.status(400).json({ error: 'El slug debe tener 3-40 caracteres: letras minúsculas, números y guiones' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }
    if (master.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(cleanSlug)) {
      return res.status(409).json({ error: 'Ese slug ya está registrado, elige otro' });
    }
    if (master.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'Ese usuario ya existe' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const tx = master.transaction(() => {
      const t = master
        .prepare('INSERT INTO tenants (slug, business_name, owner_name, phone_enc) VALUES (?, ?, ?, ?)')
        .run(cleanSlug, businessName.trim(), ownerName.trim(), encrypt(phone || ''));
      const u = master
        .prepare('INSERT INTO users (tenant_id, username, password_hash) VALUES (?, ?, ?)')
        .run(t.lastInsertRowid, username.trim(), passwordHash);
      return { tenantId: t.lastInsertRowid, userId: u.lastInsertRowid };
    });
    const ids = tx();

    // Crea la base de datos AISLADA del tenant con valores por defecto
    initTenantDefaults(cleanSlug, businessName.trim());

    const tenant = master.prepare('SELECT * FROM tenants WHERE id = ?').get(ids.tenantId);
    const user = master.prepare('SELECT * FROM users WHERE id = ?').get(ids.userId);
    setAuthCookie(res, signToken(user, tenant));
    res.json({ ok: true, slug: cleanSlug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al registrar el negocio' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  const user = master.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const tenant = master.prepare('SELECT * FROM tenants WHERE id = ?').get(user.tenant_id);
  setAuthCookie(res, signToken(user, tenant));
  res.json({ ok: true, slug: tenant.slug });
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
