const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../config');
const { q, tdb, getSuperAdminSetting, setSuperAdminSetting, refreshTenantBillingStatuses } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');
const { signToken, setAuthCookie } = require('../middleware/auth');
const {
  signSuperAdminToken,
  setSuperAdminCookie,
  clearSuperAdminCookie,
  requireSuperAdmin,
} = require('../middleware/superadmin');

const router = express.Router();

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : '';
}

const deployState = {
  running: false,
  startedAt: null,
  completedAt: null,
  exitCode: null,
  mode: 'deploy',
  force: false,
  command: '',
  logs: [],
};

function appendDeployLog(raw) {
  const text = String(raw || '').replaceAll('\r', '');
  if (!text) return;
  const lines = text.split('\n').filter(Boolean);
  const ts = new Date().toISOString();
  for (const line of lines) {
    deployState.logs.push(`[${ts}] ${line}`);
  }
  if (deployState.logs.length > 300) {
    deployState.logs = deployState.logs.slice(-300);
  }
}

function getDeployStatus() {
  return {
    running: deployState.running,
    startedAt: deployState.startedAt,
    completedAt: deployState.completedAt,
    exitCode: deployState.exitCode,
    mode: deployState.mode,
    force: deployState.force,
    command: deployState.command,
    logs: deployState.logs,
  };
}

function beginDeploySession({ force, mode, command }) {
  deployState.running = true;
  deployState.startedAt = new Date().toISOString();
  deployState.completedAt = null;
  deployState.exitCode = null;
  deployState.mode = mode || 'deploy';
  deployState.force = Boolean(force);
  deployState.command = String(command || '').trim();
  deployState.logs = [];
}

function endDeploySession(code) {
  deployState.running = false;
  deployState.exitCode = Number.isFinite(code) ? code : -1;
  deployState.completedAt = new Date().toISOString();
}

function getRemoteDeployArgs(force) {
  const scriptPath = path.join(config.ROOT, 'deploy', 'remote-deploy.ps1');
  const host = String(process.env.DEPLOY_SSH_HOST || '').trim();
  const user = String(process.env.DEPLOY_SSH_USER || '').trim();
  const appDir = String(process.env.DEPLOY_REMOTE_APP_DIR || '').trim();
  const identityFile = String(process.env.DEPLOY_SSH_IDENTITY_FILE || '').trim();
  const portRaw = Number(process.env.DEPLOY_SSH_PORT || 0);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 0;

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  if (host) args.push('-RemoteHost', host);
  if (user) args.push('-User', user);
  if (port) args.push('-Port', String(port));
  if (appDir) args.push('-AppDir', appDir);
  if (identityFile) args.push('-IdentityFile', identityFile);
  if (force) args.push('-Force');
  return args;
}

function spawnAndCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || config.ROOT,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const txt = String(chunk || '');
      stdout += txt;
      if (options.captureToDeployLog !== false) appendDeployLog(txt);
    });
    child.stderr.on('data', (chunk) => {
      const txt = String(chunk || '');
      stderr += txt;
      if (options.captureToDeployLog !== false) appendDeployLog(txt);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ code: Number.isFinite(code) ? code : -1, stdout, stderr });
    });
  });
}

async function runGitAndDeploySequence({ commitMessage, forceDeploy, username }) {
  try {
    appendDeployLog(`[deploy] Flujo push+deploy iniciado por ${username}`);
    const remote = String(process.env.DEPLOY_GIT_REMOTE || 'origin').trim() || 'origin';
    const branch = String(process.env.DEPLOY_GIT_BRANCH || 'main').trim() || 'main';

    appendDeployLog(`[git] add -A`);
    let out = await spawnAndCapture('git', ['add', '-A'], { cwd: config.ROOT });
    if (out.code !== 0) throw new Error('No se pudo ejecutar git add -A');

    appendDeployLog('[git] diff --cached --name-only');
    out = await spawnAndCapture('git', ['diff', '--cached', '--name-only'], { cwd: config.ROOT });
    if (out.code !== 0) throw new Error('No se pudo leer el estado del staging');
    const stagedFiles = String(out.stdout || '')
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);

    if (!stagedFiles.length) {
      appendDeployLog('[git] No hay cambios locales para commit. Continuando con push/deploy.');
    } else {
      appendDeployLog(`[git] Archivos en commit: ${stagedFiles.length}`);
      appendDeployLog(`[git] commit -m "${commitMessage}"`);
      out = await spawnAndCapture('git', ['commit', '-m', commitMessage], { cwd: config.ROOT });
      if (out.code !== 0) throw new Error('Falló git commit. Revisa el log para más detalle.');
    }

    appendDeployLog(`[git] push ${remote} HEAD:${branch}`);
    out = await spawnAndCapture('git', ['push', remote, `HEAD:${branch}`], { cwd: config.ROOT });
    if (out.code !== 0) throw new Error('Falló git push. Revisa credenciales o permisos del repo.');

    const deployArgs = getRemoteDeployArgs(forceDeploy);
    appendDeployLog('[deploy] Ejecutando deploy remoto...');
    out = await spawnAndCapture('powershell.exe', deployArgs, { cwd: config.ROOT });
    if (out.code !== 0) throw new Error('Deploy remoto finalizó con error.');

    appendDeployLog('[deploy] Push + deploy completado correctamente.');
    endDeploySession(0);
  } catch (err) {
    appendDeployLog(`[deploy] Error: ${err.message}`);
    endDeploySession(1);
  }
}

async function getGitDeployStatus() {
  const remote = String(process.env.DEPLOY_GIT_REMOTE || 'origin').trim() || 'origin';
  const branch = String(process.env.DEPLOY_GIT_BRANCH || 'main').trim() || 'main';
  const branchResult = await spawnAndCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: config.ROOT, captureToDeployLog: false });
  const statusResult = await spawnAndCapture('git', ['status', '--porcelain'], { cwd: config.ROOT, captureToDeployLog: false });
  const lines = String(statusResult.stdout || '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    remote,
    branch,
    currentBranch: String(branchResult.stdout || '').trim() || '(desconocida)',
    dirtyCount: lines.length,
    dirtyFiles: lines.slice(0, 50),
  };
}

const uploadSuperadminLogo = createImageUpload({
  scopeResolver: () => 'superadmin',
  allowedMimePattern: /^image\/(png|jpe?g|webp|svg\+xml)$/i,
  tempPrefix: 'logo_superadmin',
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

function buildDemoLeadSummary(rows) {
  const summary = {
    total: rows.length,
    landing: 0,
    login: 0,
    today: 0,
    week: 0,
  };
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    if (String(row.source_page || '').toLowerCase() === 'login') summary.login += 1;
    else summary.landing += 1;

    const lastSeen = new Date(row.last_seen_at || row.created_at || 0);
    if (!Number.isNaN(lastSeen.getTime())) {
      if (lastSeen.toISOString().slice(0, 10) === todayKey) summary.today += 1;
      if (lastSeen.getTime() >= weekAgo) summary.week += 1;
    }
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
    const decryptedKey = decrypt(enc || '');
    const webhookUrl = await getSuperAdminSetting('chatbot_webhook_url', '');
    const superadminLogoUrl = await getSuperAdminSetting('superadmin_logo_url', '');
    res.json({
      openaiEnabled: enabled === '1',
      openaiModel: model,
      openaiBaseUrl: baseUrl,
      webhookUrl,
      superadminLogoUrl,
      hasEncryptedOpenAiKey: Boolean(enc),
      openAiKeyReadable: Boolean(decryptedKey),
      hasOpenAiKey: Boolean(decryptedKey),
      openAiKeyMask: decryptedKey ? '••••••••••••••••' : '',
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
  let nextLogoPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo de imagen' });
    const currentLogoPath = await getSuperAdminSetting('superadmin_logo_url', '');
    nextLogoPath = await optimizeUploadedImage(req.file, { scope: 'superadmin', outputPrefix: 'logo_superadmin', maxWidth: 1200, quality: 82 });
    await setSuperAdminSetting('superadmin_logo_url', nextLogoPath);
    if (currentLogoPath && currentLogoPath !== nextLogoPath) await deleteManagedUpload(currentLogoPath);
    res.json({ ok: true, superadminLogoUrl: nextLogoPath });
  } catch (e) {
    try {
      if (nextLogoPath) await deleteManagedUpload(nextLogoPath);
      else if (req.file) await safeUnlink(req.file.path);
    } catch {}
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

router.get('/demo-leads', requireSuperAdmin, async (req, res, next) => {
  try {
    const qText = String(req.query.q || '').trim().toLowerCase();
    const values = [];
    const where = [];

    if (qText) {
      values.push(`%${qText}%`);
      where.push(`(
        lower(dl.contact_name) LIKE $${values.length}
        OR lower(dl.business_giro) LIKE $${values.length}
        OR lower(dl.source_page) LIKE $${values.length}
        OR lower(dl.last_demo_tenant_slug) LIKE $${values.length}
      )`);
    }

    const sql = `
      SELECT
        dl.id,
        dl.contact_name,
        dl.phone_enc,
        dl.business_giro,
        dl.source_page,
        dl.demo_count,
        dl.first_seen_at,
        dl.last_seen_at,
        dl.last_demo_tenant_slug,
        dl.notes
      FROM demo_leads dl
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY dl.last_seen_at DESC, dl.id DESC
    `;

    const rows = await q(sql, values);
    const mapped = rows.rows.map((row) => ({
      ...row,
      phone: decrypt(row.phone_enc) || '',
      source_label: String(row.source_page || '').toLowerCase() === 'login' ? 'Login' : 'Landing',
    }));

    res.json({
      demoLeads: mapped,
      summary: buildDemoLeadSummary(mapped),
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
    if (body.phone !== undefined) {
      const cleanPhone = normalizePhone(body.phone);
      if (!cleanPhone) return res.status(400).json({ error: 'Telefono invalido: debe tener de 10 a 15 digitos' });
      push('phone_enc', encrypt(cleanPhone));
    }
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

router.get('/deploy/status', requireSuperAdmin, (req, res) => {
  res.json({ ok: true, deploy: getDeployStatus() });
});

router.get('/deploy/git-status', requireSuperAdmin, async (req, res, next) => {
  try {
    const git = await getGitDeployStatus();
    res.json({ ok: true, git });
  } catch (e) {
    next(e);
  }
});

router.post('/deploy/run', requireSuperAdmin, async (req, res, next) => {
  try {
    if (deployState.running) {
      return res.status(409).json({ error: 'Ya hay un deploy en ejecución' });
    }

    const force = Boolean(req.body?.force);
    const args = getRemoteDeployArgs(force);
    beginDeploySession({ force, mode: 'deploy', command: `powershell.exe ${args.join(' ')}` });
    appendDeployLog(`[deploy] Iniciado por ${req.superadmin.username}`);

    const child = spawn('powershell.exe', args, {
      cwd: config.ROOT,
      windowsHide: true,
    });

    const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
    const killTimer = setTimeout(() => {
      appendDeployLog('[deploy] Timeout de 5 minutos alcanzado. Cancelando proceso.');
      child.kill('SIGTERM');
    }, DEPLOY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => appendDeployLog(chunk));
    child.stderr.on('data', (chunk) => appendDeployLog(chunk));

    child.on('error', (err) => {
      clearTimeout(killTimer);
      appendDeployLog(`[deploy] Error al ejecutar script: ${err.message}`);
      endDeploySession(-1);
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      endDeploySession(code);
      appendDeployLog(`[deploy] Finalizado con código ${deployState.exitCode}`);
    });

    res.json({ ok: true, message: 'Deploy lanzado', deploy: getDeployStatus() });
  } catch (e) {
    next(e);
  }
});

router.post('/deploy/push-run', requireSuperAdmin, async (req, res, next) => {
  try {
    if (deployState.running) {
      return res.status(409).json({ error: 'Ya hay un proceso de release en ejecución' });
    }

    const commitMessage = String(req.body?.commitMessage || '').trim();
    if (commitMessage.length < 5) {
      return res.status(400).json({ error: 'El mensaje de commit debe tener al menos 5 caracteres' });
    }

    const forceDeploy = Boolean(req.body?.forceDeploy);
    beginDeploySession({
      force: forceDeploy,
      mode: 'push-deploy',
      command: `git add -A && git commit -m "${commitMessage}" && git push && remote-deploy${forceDeploy ? ' --force' : ''}`,
    });

    runGitAndDeploySequence({
      commitMessage,
      forceDeploy,
      username: req.superadmin.username,
    }).catch((err) => {
      appendDeployLog(`[deploy] Error inesperado: ${err.message}`);
      endDeploySession(1);
    });

    res.json({ ok: true, message: 'Push + deploy lanzado', deploy: getDeployStatus() });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
