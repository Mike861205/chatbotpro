const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../config');
const { pool, q, tdb, schemaName, getSuperAdminSetting, setSuperAdminSetting, refreshTenantBillingStatuses } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');
const { signToken, setAuthCookie } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/security');
const { describeStoredPhone, normalizeInternationalPhone } = require('../utils/phone');
const { buildClientSummary } = require('../utils/customerLifecycle');
const { isMexicoIdentity } = require('../utils/invoicing');
const {
  signSuperAdminToken,
  setSuperAdminCookie,
  clearSuperAdminCookie,
  requireSuperAdmin,
} = require('../middleware/superadmin');

const router = express.Router();
const SALES_STAGES = new Set(['new', 'contacted', 'interested', 'potential', 'follow_up', 'won', 'not_interested', 'lost']);
const SALES_ACTIVITY_TYPES = new Set(['note', 'contact', 'follow_up', 'close_won', 'close_lost', 'stage_change']);
const BULK_DELETE_STAGES = new Set(['not_interested', 'lost']);
const RESELLER_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESELLER_USERNAME_RE = /^[a-z0-9._-]{3,60}$/;
const superadminLoginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos de acceso administrativo.',
});

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
  const branch = String(process.env.DEPLOY_GIT_BRANCH || 'main').trim() || 'main';
  const pm2App = String(process.env.DEPLOY_PM2_APP || 'chatbotpro').trim() || 'chatbotpro';
  const healthUrl = String(process.env.DEPLOY_HEALTH_URL || 'http://127.0.0.1:3003/').trim() || 'http://127.0.0.1:3003/';
  const portRaw = Number(process.env.DEPLOY_SSH_PORT || 0);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : 0;

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  if (host) args.push('-RemoteHost', host);
  if (user) args.push('-User', user);
  if (port) args.push('-Port', String(port));
  if (appDir) args.push('-AppDir', appDir);
  args.push('-Branch', branch);
  args.push('-Pm2App', pm2App);
  args.push('-HealthUrl', healthUrl);
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
  const pm2App = String(process.env.DEPLOY_PM2_APP || 'chatbotpro').trim() || 'chatbotpro';
  const healthUrl = String(process.env.DEPLOY_HEALTH_URL || 'http://127.0.0.1:3003/').trim() || 'http://127.0.0.1:3003/';
  const branchResult = await spawnAndCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: config.ROOT, captureToDeployLog: false });
  const statusResult = await spawnAndCapture('git', ['status', '--porcelain'], { cwd: config.ROOT, captureToDeployLog: false });
  const lines = String(statusResult.stdout || '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    remote,
    branch,
    pm2App,
    healthUrl,
    currentBranch: String(branchResult.stdout || '').trim() || '(desconocida)',
    dirtyCount: lines.length,
    dirtyFiles: lines.slice(0, 50),
  };
}

const uploadSuperadminLogo = createImageUpload({
  scopeResolver: () => 'superadmin',
  allowedMimePattern: /^image\/(png|jpe?g|webp|gif)$/i,
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

function parseSalesSubject(rawType, rawId) {
  const type = String(rawType || '').trim().toLowerCase();
  const id = Number(rawId);
  if (!['tenant', 'demo_lead'].includes(type) || !Number.isInteger(id) || id <= 0) return null;
  return { type, id };
}

function parseOptionalFollowUp(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return undefined;
  return value.toISOString();
}

function followupSubjectConfig(type) {
  return type === 'tenant'
    ? { table: 'tenants', foreignKey: 'tenant_id', extraWhere: 'AND customer_since IS NULL', label: 'business_name' }
    : { table: 'demo_leads', foreignKey: 'demo_lead_id', extraWhere: '', label: 'contact_name' };
}

async function updateSalesSubject(client, subject, input, username) {
  const cfg = followupSubjectConfig(subject.type);
  const found = await client.query(
    `SELECT id, ${cfg.label} AS name, sales_stage FROM ${cfg.table} WHERE id = $1 ${cfg.extraWhere} FOR UPDATE`,
    [subject.id]
  );
  const current = found.rows[0];
  if (!current) return null;

  let stage = input.stage === undefined ? current.sales_stage : String(input.stage || '').trim().toLowerCase();
  if (!SALES_STAGES.has(stage)) throw Object.assign(new Error('Etapa comercial inválida'), { status: 400 });
  const activityType = String(input.activityType || (stage !== current.sales_stage ? 'stage_change' : 'note')).trim().toLowerCase();
  if (!SALES_ACTIVITY_TYPES.has(activityType)) throw Object.assign(new Error('Tipo de gestión inválido'), { status: 400 });
  if (activityType === 'close_won') stage = 'won';
  if (activityType === 'close_lost') stage = 'lost';
  const note = String(input.note || '').trim().slice(0, 4000);
  let nextFollowUpAt = parseOptionalFollowUp(input.nextFollowUpAt);
  if (input.nextFollowUpAt !== undefined && nextFollowUpAt === undefined) {
    throw Object.assign(new Error('Fecha de seguimiento inválida'), { status: 400 });
  }
  if (nextFollowUpAt === undefined && ['won', 'not_interested', 'lost'].includes(stage)) nextFollowUpAt = null;
  if (!note && stage === current.sales_stage && nextFollowUpAt === undefined) {
    throw Object.assign(new Error('Agrega una nota, cambia la etapa o programa una fecha'), { status: 400 });
  }

  const values = [stage, subject.id];
  let followUpSql = '';
  if (nextFollowUpAt !== undefined) {
    values.push(nextFollowUpAt);
    followUpSql = `, next_follow_up_at = $${values.length}`;
  }
  await client.query(
    `UPDATE ${cfg.table} SET sales_stage = $1, sales_updated_at = now()${followUpSql} WHERE id = $2`,
    values
  );
  await client.query(
    `INSERT INTO sales_followup_activities
      (${cfg.foreignKey}, activity_type, note, stage_from, stage_to, follow_up_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [subject.id, activityType, note, current.sales_stage, stage, nextFollowUpAt === undefined ? null : nextFollowUpAt, username]
  );
  return { ...subject, name: current.name, stage };
}

function parseClientStatusFilter(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'active') return { active: true };
  if (value === 'due') return { billing: 'due' };
  if (value === 'mora' || value === 'overdue') return { mora: true };
  if (value === 'suspended') return { billing: 'suspended' };
  return null;
}

function mapBusinessRows(rows) {
  return rows.map((row) => {
    const phone = describeStoredPhone(decrypt(row.phone_enc) || '', row.phone_country, row.phone_calling_code);
    return {
      ...row,
      phone: phone.international,
      phone_e164: phone.e164,
      phone_digits: phone.digits,
      phone_valid: phone.valid,
      phone_country: phone.country,
      phone_country_name: phone.countryName,
      phone_calling_code: phone.callingCode,
      due_alert: Number(row.days_to_due) >= 0 && Number(row.days_to_due) <= 5,
    };
  });
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

router.post('/login', superadminLoginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }
    const cleanUsername = String(username).trim().toLowerCase();
    const cleanPassword = String(password);
    if (!/^[a-z0-9._-]{3,60}$/.test(cleanUsername) || cleanPassword.length > 128) {
      return res.status(401).json({ error: 'Credenciales de superadmin inválidas' });
    }
    const found = await q('SELECT * FROM superadmin_users WHERE lower(username) = $1', [cleanUsername]);
    const user = found.rows[0];
    if (!user || !user.active || !(await bcrypt.compare(cleanPassword, user.password_hash))) {
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

router.get('/resellers', requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await q(`
      SELECT r.id, r.slug, r.display_name, r.username, r.contact_name, r.contact_phone,
             r.active, r.notes, r.created_at, r.updated_at,
             COUNT(DISTINCT t.id) FILTER (WHERE t.customer_since IS NULL)::int AS prospect_count,
             COUNT(DISTINCT t.id) FILTER (WHERE t.customer_since IS NOT NULL)::int AS client_count,
             COUNT(DISTINCT dl.id)::int AS demo_lead_count
      FROM resellers r
      LEFT JOIN tenants t ON t.reseller_id = r.id
      LEFT JOIN demo_leads dl ON dl.reseller_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC, r.id DESC`);
    res.json({ resellers: rows.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/resellers', requireSuperAdmin, async (req, res, next) => {
  try {
    const slug = String(req.body?.slug || '').trim().toLowerCase();
    const displayName = String(req.body?.displayName || '').trim().slice(0, 120);
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const contactName = String(req.body?.contactName || '').trim().slice(0, 120);
    const contactPhone = String(req.body?.contactPhone || '').trim().slice(0, 40);
    const notes = String(req.body?.notes || '').trim().slice(0, 2000);
    if (!RESELLER_SLUG_RE.test(slug) || ['api', 'app', 'login', 'register', 'superadmin', 'resellers', 'static', 'uploads'].includes(slug)) {
      return res.status(400).json({ error: 'Clave de enlace inválida o reservada' });
    }
    if (!displayName || !RESELLER_USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Nombre y usuario válidos son obligatorios' });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres' });
    }
    const tenantConflict = await q('SELECT id FROM tenants WHERE slug = $1 LIMIT 1', [slug]);
    if (tenantConflict.rows[0]) return res.status(409).json({ error: 'La clave del enlace ya pertenece a un tenant' });
    const hash = await bcrypt.hash(password, 12);
    const inserted = await q(
      `INSERT INTO resellers (slug, display_name, username, password_hash, contact_name, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, slug, display_name, username, contact_name, contact_phone, active, notes, created_at`,
      [slug, displayName, username, hash, contactName, contactPhone, notes]
    );
    res.status(201).json({ ok: true, reseller: inserted.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'La clave de enlace o el usuario ya existen' });
    next(error);
  }
});

router.patch('/resellers/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const resellerId = Number(req.params.id);
    if (!Number.isInteger(resellerId) || resellerId <= 0) return res.status(400).json({ error: 'Reseller inválido' });
    const updates = [];
    const values = [];
    const push = (column, value) => { values.push(value); updates.push(`${column} = $${values.length}`); };
    if (req.body?.displayName !== undefined) {
      const value = String(req.body.displayName || '').trim().slice(0, 120);
      if (!value) return res.status(400).json({ error: 'El nombre es obligatorio' });
      push('display_name', value);
    }
    if (req.body?.contactName !== undefined) push('contact_name', String(req.body.contactName || '').trim().slice(0, 120));
    if (req.body?.contactPhone !== undefined) push('contact_phone', String(req.body.contactPhone || '').trim().slice(0, 40));
    if (req.body?.notes !== undefined) push('notes', String(req.body.notes || '').trim().slice(0, 2000));
    if (req.body?.active !== undefined) push('active', req.body.active ? 1 : 0);
    if (req.body?.password) {
      const password = String(req.body.password);
      if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres' });
      push('password_hash', await bcrypt.hash(password, 12));
    }
    if (!updates.length) return res.status(400).json({ error: 'Sin cambios para actualizar' });
    updates.push('updated_at = now()');
    values.push(resellerId);
    const updated = await q(
      `UPDATE resellers SET ${updates.join(', ')} WHERE id = $${values.length}
       RETURNING id, slug, display_name, username, contact_name, contact_phone, active, notes, created_at, updated_at`,
      values
    );
    if (!updated.rows[0]) return res.status(404).json({ error: 'Reseller no encontrado' });
    res.json({ ok: true, reseller: updated.rows[0] });
  } catch (error) {
    next(error);
  }
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
    const where = ['t.customer_since IS NULL'];

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
        t.phone_country,
        t.phone_calling_code,
        t.logo,
        t.primary_color,
        t.account_status,
        t.billing_status,
        t.plan_name,
        t.branch_limit,
        t.invoicing_enabled,
        t.invoicing_activated_at,
        t.invoicing_trial_granted_at,
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
        t.sales_stage,
        t.next_follow_up_at,
        t.sales_updated_at,
        t.created_at,
        t.reseller_id,
        COALESCE(r.display_name, '') AS reseller_name,
        COALESCE(r.slug, '') AS reseller_slug,
        COALESCE(u.username, '') AS owner_username,
        COALESCE(usage_stats.module_count, 0)::int AS module_count,
        COALESCE(usage_stats.module_views, 0)::int AS module_views,
        usage_stats.module_first_seen,
        usage_stats.module_last_seen,
        COALESCE(usage_stats.modules, '[]'::json) AS modules,
        COALESCE(followup_stats.activity_count, 0)::int AS activity_count,
        followup_stats.last_activity_at,
        COALESCE(followup_stats.last_note, '') AS last_note
      FROM tenants t
      LEFT JOIN resellers r ON r.id = t.reseller_id
      LEFT JOIN LATERAL (
        SELECT username FROM users WHERE tenant_id = t.id ORDER BY id ASC LIMIT 1
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS module_count,
          COALESCE(SUM(mu.view_count), 0)::int AS module_views,
          MIN(mu.first_seen_at) AS module_first_seen,
          MAX(mu.last_seen_at) AS module_last_seen,
          json_agg(
            json_build_object(
              'key', mu.module_key,
              'count', mu.view_count,
              'firstSeenAt', mu.first_seen_at,
              'lastSeenAt', mu.last_seen_at
            ) ORDER BY mu.view_count DESC, mu.last_seen_at DESC
          ) AS modules
        FROM module_usage mu
        WHERE mu.tenant_id = t.id AND mu.demo_lead_id IS NULL
      ) usage_stats ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS activity_count, MAX(a.created_at) AS last_activity_at,
          (ARRAY_AGG(a.note ORDER BY a.created_at DESC) FILTER (WHERE a.note <> ''))[1] AS last_note
        FROM sales_followup_activities a WHERE a.tenant_id = t.id
      ) followup_stats ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.created_at DESC
    `;

    const rows = await q(sql, values);
    const mapped = mapBusinessRows(rows.rows);

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
        dl.phone_country,
        dl.phone_calling_code,
        dl.business_giro,
        dl.source_page,
        dl.demo_count,
        dl.first_seen_at,
        dl.last_seen_at,
        dl.last_demo_tenant_slug,
        dl.notes,
        dl.sales_stage,
        dl.next_follow_up_at,
        dl.sales_updated_at,
        dl.reseller_id,
        COALESCE(r.display_name, '') AS reseller_name,
        COALESCE(r.slug, '') AS reseller_slug,
        COALESCE(usage_stats.module_count, 0)::int AS module_count,
        COALESCE(usage_stats.module_views, 0)::int AS module_views,
        usage_stats.module_first_seen,
        usage_stats.module_last_seen,
        COALESCE(usage_stats.modules, '[]'::json) AS modules,
        COALESCE(followup_stats.activity_count, 0)::int AS activity_count,
        followup_stats.last_activity_at,
        COALESCE(followup_stats.last_note, '') AS last_note
      FROM demo_leads dl
      LEFT JOIN resellers r ON r.id = dl.reseller_id
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS module_count,
          COALESCE(SUM(mu.view_count), 0)::int AS module_views,
          MIN(mu.first_seen_at) AS module_first_seen,
          MAX(mu.last_seen_at) AS module_last_seen,
          json_agg(
            json_build_object(
              'key', mu.module_key,
              'count', mu.view_count,
              'firstSeenAt', mu.first_seen_at,
              'lastSeenAt', mu.last_seen_at
            ) ORDER BY mu.view_count DESC, mu.last_seen_at DESC
          ) AS modules
        FROM module_usage mu
        WHERE mu.demo_lead_id = dl.id
      ) usage_stats ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS activity_count, MAX(a.created_at) AS last_activity_at,
          (ARRAY_AGG(a.note ORDER BY a.created_at DESC) FILTER (WHERE a.note <> ''))[1] AS last_note
        FROM sales_followup_activities a WHERE a.demo_lead_id = dl.id
      ) followup_stats ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY dl.last_seen_at DESC, dl.id DESC
    `;

    const rows = await q(sql, values);
    const mapped = rows.rows.map((row) => {
      const phone = describeStoredPhone(decrypt(row.phone_enc) || '', row.phone_country, row.phone_calling_code);
      return {
        ...row,
        phone: phone.international,
        phone_e164: phone.e164,
        phone_digits: phone.digits,
        phone_valid: phone.valid,
        phone_country: phone.country,
        phone_country_name: phone.countryName,
        phone_calling_code: phone.callingCode,
        source_label: String(row.source_page || '').toLowerCase() === 'login' ? 'Login' : 'Landing',
      };
    });

    res.json({
      demoLeads: mapped,
      summary: buildDemoLeadSummary(mapped),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/clients', requireSuperAdmin, async (req, res, next) => {
  try {
    await refreshTenantBillingStatuses();

    const qText = String(req.query.q || '').trim().toLowerCase();
    const statusFilter = parseClientStatusFilter(req.query.status);
    const values = [];
    const where = ['t.customer_since IS NOT NULL'];

    if (qText) {
      values.push(`%${qText}%`);
      where.push(`(lower(t.slug) LIKE $${values.length} OR lower(t.business_name) LIKE $${values.length} OR lower(t.owner_name) LIKE $${values.length})`);
    }
    if (statusFilter?.active) where.push(`t.account_status = 'active' AND t.billing_status = 'active'`);
    if (statusFilter?.billing) {
      values.push(statusFilter.billing);
      where.push(`t.billing_status = $${values.length}`);
    }
    if (statusFilter?.mora) where.push(`t.billing_due_date IS NOT NULL AND t.billing_due_date < CURRENT_DATE`);

    const rows = await q(
      `SELECT
        t.id,
        t.slug,
        t.business_name,
        t.owner_name,
        t.phone_enc,
        t.phone_country,
        t.phone_calling_code,
        t.logo,
        t.primary_color,
        t.account_status,
        t.billing_status,
        t.plan_name,
        t.branch_limit,
        t.invoicing_enabled,
        t.invoicing_activated_at,
        t.invoicing_trial_granted_at,
        t.billing_due_date,
        t.customer_since,
        t.license_count,
        t.notes,
        t.created_at,
        t.reseller_id,
        COALESCE(r.display_name, '') AS reseller_name,
        COALESCE(r.slug, '') AS reseller_slug,
        CASE WHEN t.billing_due_date IS NULL THEN NULL ELSE (t.billing_due_date - CURRENT_DATE)::int END AS days_to_due,
        CASE WHEN t.billing_due_date IS NULL OR t.billing_due_date >= CURRENT_DATE THEN 0 ELSE (CURRENT_DATE - t.billing_due_date)::int END AS mora_days,
        COALESCE(u.username, '') AS owner_username,
        COALESCE(payments.payment_count, 0)::int AS payment_count,
        COALESCE(payments.total_paid, 0)::float AS total_paid,
        payments.last_payment_at,
        COALESCE(payments.last_payment_amount, 0)::float AS last_payment_amount,
        COALESCE(payments.last_payment_method, '') AS last_payment_method,
        COALESCE(usage_stats.module_count, 0)::int AS module_count,
        COALESCE(usage_stats.module_views, 0)::int AS module_views,
        usage_stats.module_first_seen,
        usage_stats.module_last_seen,
        COALESCE(usage_stats.modules, '[]'::json) AS modules
      FROM tenants t
      LEFT JOIN resellers r ON r.id = t.reseller_id
      LEFT JOIN LATERAL (
        SELECT username FROM users WHERE tenant_id = t.id ORDER BY id ASC LIMIT 1
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS payment_count,
          COALESCE(SUM(tp.amount), 0) AS total_paid,
          MAX(tp.paid_at) AS last_payment_at,
          (ARRAY_AGG(tp.amount ORDER BY tp.paid_at DESC, tp.id DESC))[1] AS last_payment_amount,
          (ARRAY_AGG(tp.method ORDER BY tp.paid_at DESC, tp.id DESC))[1] AS last_payment_method
        FROM tenant_payments tp
        WHERE tp.tenant_id = t.id
      ) payments ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::int AS module_count,
          COALESCE(SUM(mu.view_count), 0)::int AS module_views,
          MIN(mu.first_seen_at) AS module_first_seen,
          MAX(mu.last_seen_at) AS module_last_seen,
          json_agg(
            json_build_object(
              'key', mu.module_key,
              'count', mu.view_count,
              'firstSeenAt', mu.first_seen_at,
              'lastSeenAt', mu.last_seen_at
            ) ORDER BY mu.view_count DESC, mu.last_seen_at DESC
          ) AS modules
        FROM module_usage mu
        WHERE mu.tenant_id = t.id AND mu.demo_lead_id IS NULL
      ) usage_stats ON true
      WHERE ${where.join(' AND ')}
      ORDER BY t.customer_since DESC, t.created_at DESC`,
      values
    );

    const clients = mapBusinessRows(rows.rows);
    res.json({ clients, summary: buildClientSummary(clients) });
  } catch (e) {
    next(e);
  }
});

router.get('/clients/:id/payments', requireSuperAdmin, async (req, res, next) => {
  try {
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId) || clientId <= 0) return res.status(400).json({ error: 'Cliente inválido' });

    const found = await q(
      'SELECT id, business_name, customer_since FROM tenants WHERE id = $1 AND customer_since IS NOT NULL',
      [clientId]
    );
    if (!found.rows[0]) return res.status(404).json({ error: 'Cliente no encontrado' });

    const payments = await q(
      `SELECT id, amount::float AS amount, method, note, created_by, paid_at
       FROM tenant_payments
       WHERE tenant_id = $1
       ORDER BY paid_at DESC, id DESC`,
      [clientId]
    );
    res.json({ client: found.rows[0], payments: payments.rows });
  } catch (e) {
    next(e);
  }
});

router.get('/follow-up', requireSuperAdmin, async (req, res, next) => {
  try {
    const [tenants, leads] = await Promise.all([
      q(`SELECT t.id, t.business_name AS name, t.owner_name AS contact_name, t.phone_enc,
                t.phone_country, t.phone_calling_code, t.plan_name AS detail, t.sales_stage,
                t.next_follow_up_at, t.sales_updated_at, t.created_at,
                t.reseller_id, COALESCE(r.display_name, '') AS reseller_name, COALESCE(r.slug, '') AS reseller_slug,
                COALESCE(s.activity_count, 0)::int AS activity_count, s.last_activity_at,
                COALESCE(s.last_note, '') AS last_note
         FROM tenants t
         LEFT JOIN resellers r ON r.id = t.reseller_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS activity_count, MAX(a.created_at) AS last_activity_at,
             (ARRAY_AGG(a.note ORDER BY a.created_at DESC) FILTER (WHERE a.note <> ''))[1] AS last_note
           FROM sales_followup_activities a WHERE a.tenant_id = t.id
         ) s ON true
         WHERE t.customer_since IS NULL
         ORDER BY COALESCE(t.next_follow_up_at, t.sales_updated_at, t.created_at) DESC`),
      q(`SELECT dl.id, dl.business_giro AS name, dl.contact_name, dl.phone_enc,
                dl.phone_country, dl.phone_calling_code, dl.business_giro AS detail, dl.sales_stage,
                dl.next_follow_up_at, dl.sales_updated_at, dl.created_at,
                dl.reseller_id, COALESCE(r.display_name, '') AS reseller_name, COALESCE(r.slug, '') AS reseller_slug,
                COALESCE(s.activity_count, 0)::int AS activity_count, s.last_activity_at,
                COALESCE(s.last_note, '') AS last_note
         FROM demo_leads dl
         LEFT JOIN resellers r ON r.id = dl.reseller_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS activity_count, MAX(a.created_at) AS last_activity_at,
             (ARRAY_AGG(a.note ORDER BY a.created_at DESC) FILTER (WHERE a.note <> ''))[1] AS last_note
           FROM sales_followup_activities a WHERE a.demo_lead_id = dl.id
         ) s ON true
         ORDER BY COALESCE(dl.next_follow_up_at, dl.sales_updated_at, dl.created_at) DESC`),
    ]);

    const mapRows = (rows, entityType) => rows.map((row) => {
      const phone = describeStoredPhone(decrypt(row.phone_enc) || '', row.phone_country, row.phone_calling_code);
      return {
        ...row,
        entity_type: entityType,
        phone: phone.international,
        phone_e164: phone.e164,
        phone_digits: phone.digits,
        phone_valid: phone.valid,
        phone_country: phone.country,
        phone_country_name: phone.countryName,
        phone_calling_code: phone.callingCode,
      };
    });
    const items = [...mapRows(tenants.rows, 'tenant'), ...mapRows(leads.rows, 'demo_lead')];
    res.json({ items });
  } catch (e) {
    next(e);
  }
});

router.get('/follow-up/:type/:id/activities', requireSuperAdmin, async (req, res, next) => {
  try {
    const subject = parseSalesSubject(req.params.type, req.params.id);
    if (!subject) return res.status(400).json({ error: 'Contacto inválido' });
    const cfg = followupSubjectConfig(subject.type);
    const rows = await q(
      `SELECT id, activity_type, note, stage_from, stage_to, follow_up_at, created_by, created_at
       FROM sales_followup_activities WHERE ${cfg.foreignKey} = $1 ORDER BY created_at DESC, id DESC`,
      [subject.id]
    );
    res.json({ activities: rows.rows });
  } catch (e) {
    next(e);
  }
});

router.patch('/follow-up/item/:type/:id', requireSuperAdmin, async (req, res, next) => {
  const subject = parseSalesSubject(req.params.type, req.params.id);
  if (!subject) return res.status(400).json({ error: 'Contacto inválido' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await updateSalesSubject(client, subject, req.body || {}, req.superadmin.username);
    if (!updated) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Contacto no encontrado' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally {
    client.release();
  }
});

router.patch('/follow-up/bulk/update', requireSuperAdmin, async (req, res, next) => {
  const rawSubjects = Array.isArray(req.body?.subjects) ? req.body.subjects : [];
  const subjects = [...new Map(rawSubjects.map((item) => {
    const parsed = parseSalesSubject(item?.type, item?.id);
    return parsed ? [`${parsed.type}:${parsed.id}`, parsed] : null;
  }).filter(Boolean)).values()];
  if (!subjects.length || subjects.length > 200) return res.status(400).json({ error: 'Selecciona entre 1 y 200 contactos válidos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = [];
    for (const subject of subjects) {
      const result = await updateSalesSubject(client, subject, req.body || {}, req.superadmin.username);
      if (!result) throw Object.assign(new Error(`No se encontró ${subject.type} #${subject.id}`), { status: 404 });
      updated.push(result);
    }
    await client.query('COMMIT');
    res.json({ ok: true, updated, count: updated.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally {
    client.release();
  }
});

router.delete('/follow-up/bulk', requireSuperAdmin, async (req, res, next) => {
  const rawSubjects = Array.isArray(req.body?.subjects) ? req.body.subjects : [];
  const subjects = [...new Map(rawSubjects.map((item) => {
    const parsed = parseSalesSubject(item?.type, item?.id);
    return parsed ? [`${parsed.type}:${parsed.id}`, parsed] : null;
  }).filter(Boolean)).values()];
  if (!subjects.length || subjects.length > 200) return res.status(400).json({ error: 'Selecciona entre 1 y 200 contactos válidos' });

  const tenantIds = subjects.filter((item) => item.type === 'tenant').map((item) => item.id);
  const leadIds = subjects.filter((item) => item.type === 'demo_lead').map((item) => item.id);
  const client = await pool.connect();
  const removedUploads = [];
  try {
    await client.query('BEGIN');
    let tenantRows = [];
    let leadRows = [];
    if (tenantIds.length) {
      const found = await client.query(
        `SELECT id, slug, logo, sales_stage FROM tenants
         WHERE id = ANY($1::int[]) AND customer_since IS NULL FOR UPDATE`,
        [tenantIds]
      );
      tenantRows = found.rows;
    }
    if (leadIds.length) {
      const found = await client.query(
        'SELECT id, sales_stage FROM demo_leads WHERE id = ANY($1::int[]) FOR UPDATE',
        [leadIds]
      );
      leadRows = found.rows;
    }
    if (tenantRows.length !== tenantIds.length || leadRows.length !== leadIds.length) {
      throw Object.assign(new Error('Uno o más contactos ya no existen o ya son clientes'), { status: 409 });
    }
    const unsafe = [...tenantRows, ...leadRows].find((row) => !BULK_DELETE_STAGES.has(row.sales_stage));
    if (unsafe) throw Object.assign(new Error('La eliminación masiva solo permite contactos en No interesado o Cierre no exitoso'), { status: 409 });

    if (tenantIds.length) {
      await client.query('DELETE FROM tenant_payments WHERE tenant_id = ANY($1::int[])', [tenantIds]);
      await client.query('DELETE FROM users WHERE tenant_id = ANY($1::int[])', [tenantIds]);
      await client.query('DELETE FROM tenants WHERE id = ANY($1::int[])', [tenantIds]);
      for (const tenant of tenantRows) {
        await client.query(`DROP SCHEMA IF EXISTS "${schemaName(tenant.slug)}" CASCADE`);
        if (tenant.logo) removedUploads.push(tenant.logo);
      }
    }
    if (leadIds.length) await client.query('DELETE FROM demo_leads WHERE id = ANY($1::int[])', [leadIds]);
    await client.query('COMMIT');
    for (const upload of removedUploads) {
      try { await deleteManagedUpload(upload); } catch {}
    }
    res.json({ ok: true, deleted: subjects.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  } finally {
    client.release();
  }
});

router.delete('/demo-leads/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const leadId = Number(req.params.id);
    if (!Number.isInteger(leadId) || leadId <= 0) return res.status(400).json({ error: 'Lead demo inválido' });
    const deleted = await q('DELETE FROM demo_leads WHERE id = $1 RETURNING id, contact_name', [leadId]);
    if (!deleted.rows[0]) return res.status(404).json({ error: 'Lead demo no encontrado' });
    res.json({ ok: true, deleted: deleted.rows[0] });
  } catch (e) {
    next(e);
  }
});

router.delete('/tenants/:id', requireSuperAdmin, async (req, res, next) => {
  const tenantId = Number(req.params.id);
  if (!Number.isInteger(tenantId) || tenantId <= 0) return res.status(400).json({ error: 'Tenant inválido' });

  const client = await pool.connect();
  let tenant = null;
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id, slug, business_name, logo FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    tenant = found.rows[0] || null;
    if (!tenant) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }

    await client.query('DELETE FROM tenant_payments WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM users WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    await client.query(`DROP SCHEMA IF EXISTS "${schemaName(tenant.slug)}" CASCADE`);
    await client.query('COMMIT');

    if (tenant.logo) {
      try { await deleteManagedUpload(tenant.logo); } catch {}
    }
    res.json({ ok: true, deleted: { id: tenant.id, slug: tenant.slug, business_name: tenant.business_name } });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
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
    const [orders, products, openSessions, sales, branches] = await Promise.all([
      t.get('SELECT COUNT(*)::int AS count, MAX(created_at) AS last_order_at FROM {s}.orders'),
      t.get('SELECT COUNT(*)::int AS count FROM {s}.products WHERE active = 1'),
      t.get("SELECT COUNT(*)::int AS count FROM {s}.pos_sessions WHERE status = 'open'"),
      t.get("SELECT COALESCE(SUM(total),0)::float AS total FROM {s}.orders WHERE channel = 'pos'"),
      t.get('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active = 1)::int AS active FROM {s}.branches')
    ]);

    res.json({
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        business_name: tenant.business_name,
        owner_name: tenant.owner_name,
        ...(() => {
          const phone = describeStoredPhone(decrypt(tenant.phone_enc) || '', tenant.phone_country, tenant.phone_calling_code);
          return {
            phone: phone.international,
            phone_e164: phone.e164,
            phone_valid: phone.valid,
            phone_country: phone.country,
            phone_country_name: phone.countryName,
            phone_calling_code: phone.callingCode,
          };
        })(),
        primary_color: tenant.primary_color || '#ff6b35',
        account_status: tenant.account_status,
        billing_status: tenant.billing_status,
        plan_name: tenant.plan_name,
        branch_limit: Number(tenant.branch_limit || 2),
        billing_due_date: tenant.billing_due_date,
        notes: tenant.notes || '',
      },
      stats: {
        orders: Number(orders?.count || 0),
        activeProducts: Number(products?.count || 0),
        openPosSessions: Number(openSessions?.count || 0),
        posSalesTotal: Number(sales?.total || 0),
        activeBranches: Number(branches?.active || 0),
        totalBranches: Number(branches?.total || 0),
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
      const phone = normalizeInternationalPhone(body.phone, body.phone_country || body.phoneCountry);
      push('phone_enc', encrypt(phone.e164));
      push('phone_country', phone.country);
      push('phone_calling_code', phone.callingCode);
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
    if (body.branch_limit !== undefined) {
      const branchLimit = Number(body.branch_limit);
      if (!Number.isInteger(branchLimit) || branchLimit < 1 || branchLimit > 1000) {
        return res.status(400).json({ error: 'El límite de sucursales debe estar entre 1 y 1000' });
      }
      const tenant = await getTenantById(tenantId);
      if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });
      const activeBranches = await tdb(tenant.slug).get('SELECT COUNT(*)::int AS count FROM {s}.branches WHERE active = 1');
      if (Number(activeBranches?.count || 0) > branchLimit) {
        return res.status(409).json({
          error: `Este negocio tiene ${Number(activeBranches.count)} sucursales activas. Desactiva algunas antes de reducir el límite.`,
        });
      }
      push('branch_limit', branchLimit);
    }
    if (body.billing_due_date !== undefined) push('billing_due_date', body.billing_due_date || null);
    if (body.license_count !== undefined) {
      const licenseCount = Number(body.license_count);
      if (!Number.isInteger(licenseCount) || licenseCount < 1 || licenseCount > 100000) {
        return res.status(400).json({ error: 'Número de licencias inválido' });
      }
      push('license_count', licenseCount);
    }
    if (body.notes !== undefined) push('notes', String(body.notes || '').trim());

    if (!updates.length) return res.status(400).json({ error: 'Sin cambios para actualizar' });

    values.push(tenantId);
    await q(`UPDATE tenants SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

function serializeStampWallet(wallet) {
  const balance = Number(wallet?.balance || 0);
  const reserved = Number(wallet?.reserved || 0);
  const unlimited = Boolean(Number(wallet?.unlimited));
  return {
    unlimited,
    balance,
    reserved,
    available: unlimited ? null : Math.max(0, balance - reserved),
    lowBalanceThreshold: Number(wallet?.low_balance_threshold || 20),
  };
}

router.get('/tenants/:id/stamps', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenant = await getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });
    if (!isMexicoIdentity(tenant) && tenant.slug !== config.DEMO_TENANT_SLUG) return res.status(403).json({ error: 'Los timbres sólo aplican a tenants de México' });
    const tenantDb = tdb(tenant.slug);
    const [wallet, movements, emitters, totals] = await Promise.all([
      tenantDb.get('SELECT * FROM {s}.stamp_wallet WHERE id=1'),
      tenantDb.all('SELECT * FROM {s}.stamp_ledger ORDER BY id DESC LIMIT 50'),
      tenantDb.all(`SELECT id,label,rfc,legal_name,series,enabled,csd_uploaded,sandbox_shared,environment
                    FROM {s}.fiscal_emitters ORDER BY enabled DESC,id`),
      tenantDb.get(`SELECT
        COUNT(*) FILTER (WHERE movement_type='consumed')::int AS consumed,
        COALESCE(SUM(quantity) FILTER (WHERE movement_type IN ('credit','trial_grant')),0)::int AS granted
        FROM {s}.stamp_ledger`),
    ]);
    res.json({
      tenant: {
        id: Number(tenant.id), slug: tenant.slug, businessName: tenant.business_name,
        enabled: Boolean(Number(tenant.invoicing_enabled)),
        activatedAt: tenant.invoicing_activated_at,
        trialGrantedAt: tenant.invoicing_trial_granted_at,
        activatedBy: tenant.invoicing_activated_by || '',
      },
      wallet: serializeStampWallet(wallet),
      totals: { consumed: Number(totals?.consumed || 0), granted: Number(totals?.granted || 0) },
      emitters: emitters.map((row) => ({
        id: Number(row.id), label: row.label || '', rfc: row.rfc || '', legalName: row.legal_name || '',
        series: row.series || '', enabled: Boolean(Number(row.enabled)), csdUploaded: Boolean(Number(row.csd_uploaded)),
        sandboxShared: Boolean(Number(row.sandbox_shared)), environment: row.environment || 'sandbox',
      })),
      movements,
    });
  } catch (error) { next(error); }
});

router.post('/tenants/:id/invoicing', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenant = await getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });
    if (!isMexicoIdentity(tenant) && tenant.slug !== config.DEMO_TENANT_SLUG) return res.status(403).json({ error: 'La facturación sólo puede activarse para tenants de México (+52)' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Indica si deseas activar o desactivar la facturación' });
    const enabled = req.body?.enabled === true;
    const tenantDb = tdb(tenant.slug);
    const result = await tenantDb.tx(async (tx) => {
      const lockedTenant = await tx.get('SELECT * FROM public.tenants WHERE id=$1 FOR UPDATE', [tenant.id]);
      await tx.run(`INSERT INTO {s}.stamp_wallet(id,unlimited,balance,reserved)
                    VALUES(1,0,0,0) ON CONFLICT(id) DO NOTHING`);
      const wallet = await tx.get('SELECT * FROM {s}.stamp_wallet WHERE id=1 FOR UPDATE');
      const trialGrant = enabled && !lockedTenant.invoicing_trial_granted_at ? 2 : 0;
      const nextBalance = Number(wallet.balance || 0) + trialGrant;
      const updatedWallet = await tx.get(
        'UPDATE {s}.stamp_wallet SET unlimited=0,balance=$1,updated_at=now() WHERE id=1 RETURNING *',
        [nextBalance]
      );
      const updatedTenant = await tx.get(
        `UPDATE public.tenants SET
          invoicing_enabled=$1,
          invoicing_activated_at=CASE WHEN $1=1 THEN COALESCE(invoicing_activated_at,now()) ELSE invoicing_activated_at END,
          invoicing_trial_granted_at=CASE WHEN $2=1 THEN COALESCE(invoicing_trial_granted_at,now()) ELSE invoicing_trial_granted_at END,
          invoicing_activated_by=$3
         WHERE id=$4 RETURNING *`,
        [enabled ? 1 : 0, trialGrant ? 1 : 0, req.superadmin.username, tenant.id]
      );
      if (trialGrant) {
        await tx.run(
          `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,detail,actor)
           VALUES('courtesy_grant',$1,$2,'2 timbres de cortesía para pruebas de Facturación MX',$3)`,
          [trialGrant, nextBalance, req.superadmin.username]
        );
      }
      await tx.run(
        `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,detail,actor)
         VALUES($1,0,$2,$3,$4)`,
        [enabled ? 'invoicing_enabled' : 'invoicing_disabled', nextBalance,
          enabled ? 'Facturación habilitada por SuperAdmin' : 'Facturación deshabilitada por SuperAdmin', req.superadmin.username]
      );
      return { updatedTenant, updatedWallet, trialGrant };
    });
    res.json({
      ok: true,
      enabled: Boolean(Number(result.updatedTenant.invoicing_enabled)),
      trialGrant: result.trialGrant,
      trialGrantedAt: result.updatedTenant.invoicing_trial_granted_at,
      wallet: serializeStampWallet(result.updatedWallet),
    });
  } catch (error) { next(error); }
});

router.post('/tenants/:id/stamps', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenant = await getTenantById(Number(req.params.id));
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });
    if (!isMexicoIdentity(tenant) && tenant.slug !== config.DEMO_TENANT_SLUG) return res.status(403).json({ error: 'Los timbres sólo aplican a tenants de México' });
    if (!Number(tenant.invoicing_enabled)) return res.status(409).json({ error: 'Activa primero la facturación del tenant' });
    const quantity = Number(req.body?.quantity || 0);
    if (!Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 1000000) {
      return res.status(400).json({ error: 'Indica una cantidad entera distinta de cero' });
    }
    const tenantDb = tdb(tenant.slug);
    const result = await tenantDb.tx(async (tx) => {
      const wallet = await tx.get('SELECT * FROM {s}.stamp_wallet WHERE id=1 FOR UPDATE');
      const nextBalance = Number(wallet.balance || 0) + quantity;
      if (nextBalance < Number(wallet.reserved || 0)) throw Object.assign(new Error('El saldo no puede quedar por debajo de los timbres reservados'), { status: 409 });
      const updated = await tx.get(
        'UPDATE {s}.stamp_wallet SET unlimited=0,balance=$1,updated_at=now() WHERE id=1 RETURNING *',
        [nextBalance]
      );
      await tx.run(
        `INSERT INTO {s}.stamp_ledger(movement_type,quantity,balance_after,detail,actor)
         VALUES($1,$2,$3,$4,$5)`,
        [quantity > 0 ? 'credit' : 'adjustment', quantity, nextBalance,
          String(req.body?.note || (quantity > 0 ? 'Recarga manual de timbres' : 'Ajuste por superadministrador')).slice(0,300), req.superadmin.username]
      );
      return updated;
    });
    res.json({ ok: true, wallet: serializeStampWallet(result) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
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

    setAuthCookie(res, signToken(owner, tenant, 'owner', { impersonated: true }));
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
  const client = await pool.connect();
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

    await client.query('BEGIN');
    const tenantResult = await client.query('SELECT id, customer_since, sales_stage FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    const tenant = tenantResult.rows[0];
    if (!tenant) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Tenant no encontrado' });
    }

    await client.query(
      'INSERT INTO tenant_payments (tenant_id, amount, method, note, created_by, paid_at) VALUES ($1, $2, $3, $4, $5, $6::date)',
      [tenantId, amount, method, note, req.superadmin.username, paidAt]
    );

    const dueDateRow = await client.query('SELECT ($1::date + INTERVAL \'1 month\')::date AS next_due_date', [paidAt]);
    const nextDueDate = dueDateRow.rows[0]?.next_due_date;
    const paymentNote = `[PAGO ${paidAt}] ${amount.toFixed(2)} (${method})${note ? ` - ${note}` : ''}`;

    await client.query(
      `UPDATE tenants
       SET billing_status = 'active',
           account_status = 'active',
           billing_due_date = $1::date,
           customer_since = COALESCE(customer_since, $2::date),
           sales_stage = 'won',
           next_follow_up_at = NULL,
           sales_updated_at = now(),
           notes = CASE
             WHEN COALESCE(notes, '') = '' THEN $3
             ELSE notes || E'\n' || $3
           END
       WHERE id = $4`,
      [
        nextDueDate,
        paidAt,
        paymentNote,
        tenantId,
      ]
    );

    if (!tenant.customer_since) {
      await client.query(
        `INSERT INTO sales_followup_activities
          (tenant_id, activity_type, note, stage_from, stage_to, created_by)
         VALUES ($1, 'close_won', $2, $3, 'won', $4)`,
        [tenantId, `Cierre exitoso por primer pago de ${amount.toFixed(2)} (${method})`, tenant.sales_stage || 'new', req.superadmin.username]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, nextDueDate, becameClient: !tenant.customer_since });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    next(e);
  } finally {
    client.release();
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
