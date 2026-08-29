const express = require('express');
const bcrypt = require('bcryptjs');
const { q } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { MODULES, normalizeModules } = require('../utils/modules');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);
router.use((req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Solo el administrador puede gestionar usuarios' }));

const USERNAME_RE = /^[a-z0-9._-]{3,60}$/;
const clean = (value, max) => String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);

function mapUser(row) {
  return {
    id: Number(row.id), username: row.username, displayName: row.display_name || row.username,
    jobTitle: row.job_title || 'Auxiliar', permissions: normalizeModules(row.permissions_json),
    active: Boolean(Number(row.active)), createdAt: row.created_at,
  };
}

router.get('/modules', (req, res) => res.json(MODULES.map(([key, label]) => ({ key, label }))));

router.get('/', async (req, res, next) => {
  try {
    const result = await q(`SELECT id,username,display_name,job_title,permissions_json,active,created_at
      FROM users WHERE tenant_id=$1 AND role='staff' ORDER BY active DESC, display_name, id`, [req.tenant.id]);
    res.json(result.rows.map(mapUser));
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const displayName = clean(body.displayName, 100);
    const jobTitle = clean(body.jobTitle, 60);
    const permissions = normalizeModules(body.permissions);
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'El usuario debe tener de 3 a 60 caracteres validos' });
    if (displayName.length < 2 || jobTitle.length < 2) return res.status(400).json({ error: 'Nombre y puesto son obligatorios' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'La contrasena debe tener entre 8 y 128 caracteres' });
    if (!permissions.length) return res.status(400).json({ error: 'Asigna al menos un modulo' });
    const duplicate = await q('SELECT 1 FROM users WHERE lower(username)=$1 LIMIT 1', [username]);
    if (duplicate.rows[0]) return res.status(409).json({ error: 'Ese usuario ya existe' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await q(`INSERT INTO users
      (tenant_id,username,password_hash,role,display_name,job_title,permissions_json,active)
      VALUES($1,$2,$3,'staff',$4,$5,$6,$7)
      RETURNING id,username,display_name,job_title,permissions_json,active,created_at`,
      [req.tenant.id, username, passwordHash, displayName, jobTitle, JSON.stringify(permissions), body.active === false || body.active === 0 ? 0 : 1]);
    res.status(201).json(mapUser(result.rows[0]));
  } catch (error) { next(error); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = clean(body.displayName, 100);
    const jobTitle = clean(body.jobTitle, 60);
    const permissions = normalizeModules(body.permissions);
    const password = String(body.password || '');
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Usuario invalido' });
    if (!USERNAME_RE.test(username) || displayName.length < 2 || jobTitle.length < 2) return res.status(400).json({ error: 'Revisa nombre, usuario y puesto' });
    if (!permissions.length) return res.status(400).json({ error: 'Asigna al menos un modulo' });
    if (password && (password.length < 8 || password.length > 128)) return res.status(400).json({ error: 'La contrasena debe tener entre 8 y 128 caracteres' });
    const duplicate = await q('SELECT 1 FROM users WHERE lower(username)=$1 AND id<>$2 LIMIT 1', [username, id]);
    if (duplicate.rows[0]) return res.status(409).json({ error: 'Ese usuario ya existe' });
    const result = await q(`UPDATE users SET username=$1,display_name=$2,job_title=$3,permissions_json=$4,active=$5
      WHERE id=$6 AND tenant_id=$7 AND role='staff'
      RETURNING id,username,display_name,job_title,permissions_json,active,created_at`,
      [username, displayName, jobTitle, JSON.stringify(permissions), body.active === false || body.active === 0 ? 0 : 1, id, req.tenant.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (password) {
      await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(password, 12), id]);
    }
    res.json(mapUser(result.rows[0]));
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const result = await q("DELETE FROM users WHERE id=$1 AND tenant_id=$2 AND role='staff'", [Number(req.params.id), req.tenant.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.put('/preferences/modules', async (req, res, next) => {
  try {
    const hiddenModules = normalizeModules(req.body?.hiddenModules).filter((key) => key !== 'config');
    await q('UPDATE tenants SET hidden_modules_json=$1 WHERE id=$2', [JSON.stringify(hiddenModules), req.tenant.id]);
    res.json({ ok: true, hiddenModules });
  } catch (error) { next(error); }
});

module.exports = router;
