const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const config = require('../config');
const { q, tdb, getSuperAdminSetting, setSuperAdminSetting, refreshTenantBillingStatuses } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { signToken, setAuthCookie } = require('../middleware/auth');
const {
  signSuperAdminToken,
  setSuperAdminCookie,
  clearSuperAdminCookie,
  requireSuperAdmin,
} = require('../middleware/superadmin');

const router = express.Router();

const superadminLogoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.UPLOADS_DIR, 'superadmin');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
    cb(null, `logo_superadmin_${Date.now()}${ext}`);
  },
});

const uploadSuperadminLogo = multer({
  storage: superadminLogoStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.mimetype)),
});

function buildTenantSummary(rows) {
  const summary = {
    total: rows.length,
    activeTenants: 0,
    inactiveTenants: 0,
    billingCurrent: 0,
    billingDue: 0,
    billingSuspended: 0,
    dueSoon5: 0,
    inMora: 0,
  };

  for (const row of rows) {
    if (row.account_status === 'active') summary.activeTenants += 1;
    if (row.account_status === 'inactive') summary.inactiveTenants += 1;
    if (row.billing_status === 'active') summary.billingCurrent += 1;
    if (row.billing_status === 'due') summary.billingDue += 1;
    if (row.billing_status === 'suspended') summary.billingSuspended += 1;

    const daysToDue = Number(row.days_to_due);
    const moraDays = Number(row.mora_days || 0);
    if (Number.isFinite(daysToDue) && daysToDue >= 0 && daysToDue <= 5) summary.dueSoon5 += 1;
    if (Number.isFinite(moraDays) && moraDays > 0) summary.inMora += 1;
  }

  return summary;
}

function parseStatusFilter(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'activos' || value === 'active') return { account: 'active' };
  if (value === 'por-pagar' || value === 'due') return { billing: 'due' };
  if (value === 'mora' || value === 'overdue') return { mora: true };
  if (value === 'inactivos' || value === 'inactive') return { account: 'inactive' };
  return null;
}

async function getTenantById(tenantId) {
  const found = await q('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return found.rows[0] || null;
}

async function getTenantOwnerUser(tenantId) {
  const row = await q(
    `SELECT *
     FROM users
     WHERE tenant_id = $1
     ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [tenantId]
  );
  return row.rows[0] || null;
}

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    const found = await q('SELECT * FROM superadmin_users WHERE lower(username) = $1', [String(username).trim().toLowerCase()]);
    const user = found.rows[0];
    if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Credenciales de superadmin inválidas' });
    }
    setSuperAdminCookie(res, signSuperAdminToken(user));
    res.json({ ok: true, username: user.username });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  clearSuperAdminCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireSuperAdmin, (req, res) => {
  res.json({ username: req.superadmin.username, role: 'superadmin' });
});

router.get('/integrations', requireSuperAdmin, async (req, res, next) => {
  try {
    const enabled = await getSuperAdminSetting('openai_enabled', '0');
    const model = await getSuperAdminSetting('openai_model', 'gpt-4o-mini');
    const baseUrl = await getSuperAdminSetting('openai_base_url', '');
    const enc = await getSuperAdminSetting('openai_api_key_enc', '');
    const webhookUrl = await getSuperAdminSetting('chatbot_webhook_url', '');
    const superadminLogoUrl = await getSuperAdminSetting('superadmin_logo_url', '');
    res.json({
      openaiEnabled: enabled === '1',
      openaiModel: model,
      openaiBaseUrl: baseUrl,
      webhookUrl,
      superadminLogoUrl,
      hasOpenAiKey: Boolean(enc && decrypt(enc)),
      openAiKeyMask: enc && decrypt(enc) ? '••••••••••••••••' : '',
    });
  } catch (e) {
    next(e);
  }
});

router.put('/integrations', requireSuperAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.openaiEnabled !== undefined) {
      await setSuperAdminSetting('openai_enabled', body.openaiEnabled ? '1' : '0');
    }
    if (body.openaiModel !== undefined) {
      await setSuperAdminSetting('openai_model', String(body.openaiModel || 'gpt-4o-mini').trim() || 'gpt-4o-mini');
    }
    if (body.openaiBaseUrl !== undefined) {
      await setSuperAdminSetting('openai_base_url', String(body.openaiBaseUrl || '').trim());
    }
    if (body.webhookUrl !== undefined) {
      await setSuperAdminSetting('chatbot_webhook_url', String(body.webhookUrl || '').trim());
    }
    if (body.superadminLogoUrl !== undefined) {
      await setSuperAdminSetting('superadmin_logo_url', String(body.superadminLogoUrl || '').trim().slice(0, 500));
    }
    if (body.openaiApiKey !== undefined) {
      const clean = String(body.openaiApiKey || '').trim();
      await setSuperAdminSetting('openai_api_key_enc', clean ? encrypt(clean) : '');
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/branding/logo', requireSuperAdmin, uploadSuperadminLogo.single('logo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo de imagen' });
    const logoPath = `/uploads/superadmin/${req.file.filename}`;
    await setSuperAdminSetting('superadmin_logo_url', logoPath);
    res.json({ ok: true, superadminLogoUrl: logoPath });
  } catch (e) {
    next(e);
  }
});

router.get('/tenants', requireSuperAdmin, async (req, res, next) => {
  try {
    await refreshTenantBillingStatuses();

    const qText = String(req.query.q || '').trim().toLowerCase();
    const statusFilter = parseStatusFilter(req.query.status);
    const values = [];
    const where = [];

    if (qText) {
      values.push(`%${qText}%`);
      where.push(`(lower(t.slug) LIKE $${values.length} OR lower(t.business_name) LIKE $${values.length} OR lower(t.owner_name) LIKE $${values.length})`);
    }

    if (statusFilter?.account) {
      values.push(statusFilter.account);
      where.push(`t.account_status = $${values.length}`);
    }
    if (statusFilter?.billing) {
      values.push(statusFilter.billing);
      where.push(`t.billing_status = $${values.length}`);
    }
    if (statusFilter?.mora) {
      where.push(`t.billing_due_date IS NOT NULL AND t.billing_due_date < CURRENT_DATE`);
    }

    const sql = `
      SELECT
        t.id,
        t.slug,
        t.business_name,
        t.owner_name,
        t.phone_enc,
        t.logo,
        t.primary_color,
        t.account_status,
        t.billing_status,
        t.plan_name,
        t.billing_due_date,
        CASE
          WHEN t.billing_due_date IS NULL THEN NULL
          ELSE (t.billing_due_date - CURRENT_DATE)::int
        END AS days_to_due,
        CASE
          WHEN t.billing_due_date IS NULL OR t.billing_due_date >= CURRENT_DATE THEN 0
          ELSE (CURRENT_DATE - t.billing_due_date)::int
        END AS mora_days,
        t.notes,
        t.created_at,
        COALESCE(u.username, '') AS owner_username
      FROM tenants t
      LEFT JOIN LATERAL (
        SELECT username FROM users WHERE tenant_id = t.id ORDER BY id ASC LIMIT 1
      ) u ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.created_at DESC
    `;

    const rows = await q(sql, values);
    const mapped = rows.rows.map((row) => ({
        ...row,
        phone: decrypt(row.phone_enc) || '',
        due_alert: Number(row.days_to_due) >= 0 && Number(row.days_to_due) <= 5,
      }));

    res.json({
      tenants: mapped,
      summary: buildTenantSummary(mapped),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/billing/refresh', requireSuperAdmin, async (req, res, next) => {
  try {
    const refreshed = await refreshTenantBillingStatuses();
    const rows = await q(
      `SELECT id, account_status, billing_status, billing_due_date,
              CASE WHEN billing_due_date IS NULL THEN NULL ELSE (billing_due_date - CURRENT_DATE)::int END AS days_to_due,
              CASE WHEN billing_due_date IS NULL OR billing_due_date >= CURRENT_DATE THEN 0 ELSE (CURRENT_DATE - billing_due_date)::int END AS mora_days
       FROM tenants`
    );
    res.json({
      ok: true,
      refreshed,
      summary: buildTenantSummary(rows.rows),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/tenants/:id/stats', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido' });

    const found = await q('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const tenant = found.rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    const t = tdb(tenant.slug);
    const [orders, products, openSessions, sales] = await Promise.all([
      t.get('SELECT COUNT(*)::int AS count, MAX(created_at) AS last_order_at FROM {s}.orders'),
      t.get('SELECT COUNT(*)::int AS count FROM {s}.products WHERE active = 1'),
      t.get("SELECT COUNT(*)::int AS count FROM {s}.pos_sessions WHERE status = 'open'"),
      t.get("SELECT COALESCE(SUM(total),0)::float AS total FROM {s}.orders WHERE channel = 'pos'")
    ]);

    res.json({
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        business_name: tenant.business_name,
        owner_name: tenant.owner_name,
        phone: decrypt(tenant.phone_enc) || '',
        primary_color: tenant.primary_color || '#ff6b35',
        account_status: tenant.account_status,
        billing_status: tenant.billing_status,
        plan_name: tenant.plan_name,
        billing_due_date: tenant.billing_due_date,
        notes: tenant.notes || '',
      },
      stats: {
        orders: Number(orders?.count || 0),
        activeProducts: Number(products?.count || 0),
        openPosSessions: Number(openSessions?.count || 0),
        posSalesTotal: Number(sales?.total || 0),
        lastOrderAt: orders?.last_order_at || null,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.patch('/tenants/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido' });

    const body = req.body || {};
    const updates = [];
    const values = [];

    const push = (column, value) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };

    if (body.business_name !== undefined) push('business_name', String(body.business_name || '').trim());
    if (body.owner_name !== undefined) push('owner_name', String(body.owner_name || '').trim());
    if (body.phone !== undefined) push('phone_enc', encrypt(String(body.phone || '').trim()));
    if (body.primary_color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(body.primary_color || ''))) {
      push('primary_color', String(body.primary_color));
    }
    if (body.account_status !== undefined) {
      const value = String(body.account_status || '').toLowerCase();
      if (!['active', 'inactive'].includes(value)) return res.status(400).json({ error: 'Estado de cuenta inválido' });
      push('account_status', value);
    }
    if (body.billing_status !== undefined) {
      const value = String(body.billing_status || '').toLowerCase();
      if (!['active', 'due', 'suspended'].includes(value)) return res.status(400).json({ error: 'Estado de pago inválido' });
      push('billing_status', value);
    }
    if (body.plan_name !== undefined) push('plan_name', String(body.plan_name || '').trim());
    if (body.billing_due_date !== undefined) push('billing_due_date', body.billing_due_date || null);
    if (body.notes !== undefined) push('notes', String(body.notes || '').trim());

    if (!updates.length) return res.status(400).json({ error: 'Sin cambios para actualizar' });

    values.push(tenantId);
    await q(`UPDATE tenants SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/tenants/:id/access', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido' });

    const tenant = await getTenantById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    const owner = await getTenantOwnerUser(tenantId);
    if (!owner) return res.status(404).json({ error: 'El tenant no tiene usuario de acceso' });

    setAuthCookie(res, signToken(owner, tenant));
    res.json({ ok: true, redirect: '/app' });
  } catch (e) {
    next(e);
  }
});

router.post('/tenants/:id/password', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido' });

    const newPassword = String(req.body?.newPassword || '').trim();
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    }

    const owner = await getTenantOwnerUser(tenantId);
    if (!owner) return res.status(404).json({ error: 'No se encontró usuario para este tenant' });

    const hash = await bcrypt.hash(newPassword, 12);
    await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, owner.id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/tenants/:id/suspend', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido' });

    const suspend = Boolean(req.body?.suspend);
    const modeRaw = String(req.body?.mode || 'account').trim().toLowerCase();
    const mode = modeRaw === 'billing' ? 'billing' : 'account';
    const noteRaw = String(req.body?.note || '').trim().slice(0, 220);

    if (mode === 'billing') {
      const billingStatus = suspend ? 'suspended' : 'active';
      const systemNote = suspend
        ? `[SUSPENSIÓN AUTOMÁTICA COBRANZA] Falta de pago${noteRaw ? ` - ${noteRaw}` : ''}`
        : `[REACTIVACIÓN COBRANZA] Cuenta habilitada por superadmin${noteRaw ? ` - ${noteRaw}` : ''}`;

      await q(
        `UPDATE tenants
         SET billing_status = $1,
             account_status = 'active',
             notes = CASE
               WHEN COALESCE(notes, '') = '' THEN $2
               ELSE notes || E'\n' || $2
             END
         WHERE id = $3`,
        [billingStatus, systemNote, tenantId]
      );
      return res.json({ ok: true, mode, billing_status: billingStatus, account_status: 'active' });
    }

    const nextStatus = suspend ? 'inactive' : 'active';
    await q('UPDATE tenants SET account_status = $1 WHERE id = $2', [nextStatus, tenantId]);
    res.json({ ok: true, mode, account_status: nextStatus });
  } catch (e) {
    next(e);
  }
});

router.post('/tenants/:id/payment', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenantId = Number(req.params.id);
    if (!tenantId) return res.status(400).json({ error: 'Tenant inválido' });

    const amount = Number(req.body?.amount || 0);
    const paidAtRaw = String(req.body?.paidAt || '').trim();
    const paidAt = /^\d{4}-\d{2}-\d{2}$/.test(paidAtRaw)
      ? paidAtRaw
      : new Date().toISOString().slice(0, 10);
    const methodRaw = String(req.body?.method || '').trim().toLowerCase();
    const method = ['stripe', 'transferencia', 'deposito'].includes(methodRaw) ? methodRaw : 'transferencia';
    const note = String(req.body?.note || '').trim().slice(0, 240);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Monto de pago inválido' });
    }

    await q(
      'INSERT INTO tenant_payments (tenant_id, amount, method, note, created_by, paid_at) VALUES ($1, $2, $3, $4, $5, $6::date)',
      [tenantId, amount, method, note, req.superadmin.username, paidAt]
    );

    const dueDateRow = await q('SELECT ($1::date + INTERVAL \'1 month\')::date AS next_due_date', [paidAt]);
    const nextDueDate = dueDateRow.rows[0]?.next_due_date;
    const paymentNote = `[PAGO ${paidAt}] ${amount.toFixed(2)} (${method})${note ? ` - ${note}` : ''}`;

    await q(
      `UPDATE tenants
       SET billing_status = 'active',
           account_status = 'active',
           billing_due_date = $1::date,
           notes = CASE
             WHEN COALESCE(notes, '') = '' THEN $2
             ELSE notes || E'\n' || $2
           END
       WHERE id = $3`,
      [
        nextDueDate,
        paymentNote,
        tenantId,
      ]
    );

    res.json({ ok: true, nextDueDate });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
