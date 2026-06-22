const express = require('express');
const bcrypt = require('bcryptjs');
const { q } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

function cleanUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanSlug(value) {
  return String(value || '').trim().toLowerCase();
}

async function resolveActiveBranch(req, branchIdRaw) {
  const branchId = Number(branchIdRaw);
  if (!Number.isInteger(branchId) || branchId <= 0) {
    const err = new Error('Selecciona una sucursal válida');
    err.statusCode = 400;
    throw err;
  }
  const branch = await req.tdb.get('SELECT id, name, active FROM {s}.branches WHERE id = $1 LIMIT 1', [branchId]);
  if (!branch || !Number(branch.active)) {
    const err = new Error('La sucursal asignada no existe o está inactiva');
    err.statusCode = 400;
    throw err;
  }
  return branch;
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await q(
      `SELECT id, username, role, display_name, branch_id, cashier_slug, active
       FROM users
       WHERE tenant_id = $1 AND role = 'cashier'
       ORDER BY active DESC, id ASC`,
      [req.tenant.id]
    );

    const out = [];
    for (const row of rows.rows) {
      const branchName = row.branch_id
        ? (await req.tdb.get('SELECT name FROM {s}.branches WHERE id = $1 LIMIT 1', [row.branch_id]))?.name || ''
        : '';
      out.push({
        id: row.id,
        username: row.username,
        displayName: row.display_name || row.username,
        branchId: row.branch_id ? Number(row.branch_id) : null,
        branchName,
        cashierSlug: row.cashier_slug || '',
        active: Number(row.active || 0),
      });
    }
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const username = cleanUsername(body.username);
    const displayName = String(body.displayName || '').trim().slice(0, 100);
    const password = String(body.password || '');
    const cashierSlug = cleanSlug(body.cashierSlug);
    if (displayName.length < 2) return res.status(400).json({ error: 'El nombre del cajero es obligatorio' });
    if (!username || username.length < 3) return res.status(400).json({ error: 'El usuario del cajero es obligatorio' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    if (!SLUG_RE.test(cashierSlug)) return res.status(400).json({ error: 'La liga de caja debe tener 3-40 caracteres con letras, números y guiones' });

    const branch = await resolveActiveBranch(req, body.branchId);
    const dupUser = await q('SELECT 1 FROM users WHERE lower(username) = $1', [username]);
    if (dupUser.rows.length) return res.status(409).json({ error: 'Ese usuario ya existe' });
    const dupSlug = await q('SELECT 1 FROM users WHERE cashier_slug = $1', [cashierSlug]);
    if (dupSlug.rows.length) return res.status(409).json({ error: 'Esa liga de caja ya existe' });

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await q(
      `INSERT INTO users (tenant_id, username, password_hash, role, display_name, branch_id, cashier_slug, active)
       VALUES ($1, $2, $3, 'cashier', $4, $5, $6, $7)
       RETURNING id, username, display_name, branch_id, cashier_slug, active`,
      [req.tenant.id, username, passwordHash, displayName, branch.id, cashierSlug, body.active === 0 || body.active === '0' ? 0 : 1]
    );
    const row = result.rows[0];
    res.json({
      id: row.id,
      username: row.username,
      displayName: row.display_name || row.username,
      branchId: Number(row.branch_id),
      branchName: branch.name,
      cashierSlug: row.cashier_slug,
      active: Number(row.active || 0),
    });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Cajero inválido' });
    const body = req.body || {};
    const username = cleanUsername(body.username);
    const displayName = String(body.displayName || '').trim().slice(0, 100);
    const cashierSlug = cleanSlug(body.cashierSlug);
    if (displayName.length < 2) return res.status(400).json({ error: 'El nombre del cajero es obligatorio' });
    if (!username || username.length < 3) return res.status(400).json({ error: 'El usuario del cajero es obligatorio' });
    if (!SLUG_RE.test(cashierSlug)) return res.status(400).json({ error: 'La liga de caja debe tener 3-40 caracteres con letras, números y guiones' });

    const existing = await q('SELECT * FROM users WHERE id = $1 AND tenant_id = $2 AND role = $3', [id, req.tenant.id, 'cashier']);
    const cashier = existing.rows[0];
    if (!cashier) return res.status(404).json({ error: 'Cajero no encontrado' });
    const branch = await resolveActiveBranch(req, body.branchId);

    const dupUser = await q('SELECT 1 FROM users WHERE lower(username) = $1 AND id <> $2', [username, id]);
    if (dupUser.rows.length) return res.status(409).json({ error: 'Ese usuario ya existe' });
    const dupSlug = await q('SELECT 1 FROM users WHERE cashier_slug = $1 AND id <> $2', [cashierSlug, id]);
    if (dupSlug.rows.length) return res.status(409).json({ error: 'Esa liga de caja ya existe' });

    await q(
      `UPDATE users
       SET username = $1,
           display_name = $2,
           branch_id = $3,
           cashier_slug = $4,
           active = $5
       WHERE id = $6 AND tenant_id = $7 AND role = 'cashier'`,
      [username, displayName, branch.id, cashierSlug, body.active === 0 || body.active === '0' ? 0 : 1, id, req.tenant.id]
    );

    const nextPassword = String(body.password || '');
    if (nextPassword.trim()) {
      if (nextPassword.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
      const passwordHash = await bcrypt.hash(nextPassword, 12);
      await q('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
    }

    res.json({ ok: true });
  } catch (e) {
    if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Cajero inválido' });
    const result = await q('DELETE FROM users WHERE id = $1 AND tenant_id = $2 AND role = $3', [id, req.tenant.id, 'cashier']);
    if (!result.rowCount) return res.status(404).json({ error: 'Cajero no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
