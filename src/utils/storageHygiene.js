const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const fsPromises = fs.promises;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_RETENTION_DAYS = 7;
const RESERVED_SCOPES = new Set(['superadmin']);
const SAFE_SCOPE_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

function assertSafeScope(scope) {
  const normalized = String(scope || '').trim().toLowerCase();
  if (!SAFE_SCOPE_RE.test(normalized) || RESERVED_SCOPES.has(normalized)) {
    throw Object.assign(new Error('Carpeta de almacenamiento no permitida'), { status: 400 });
  }
  return normalized;
}

function isInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function scopeDirectory(scope, uploadsDir = config.UPLOADS_DIR) {
  const safeScope = assertSafeScope(scope);
  const target = path.resolve(uploadsDir, safeScope);
  if (!isInside(uploadsDir, target) || target === path.resolve(uploadsDir)) {
    throw Object.assign(new Error('Ruta de almacenamiento fuera del directorio permitido'), { status: 400 });
  }
  return target;
}

function publicUploadToAbsolute(publicPath, uploadsDir = config.UPLOADS_DIR) {
  const value = String(publicPath || '').trim();
  if (!value.startsWith('/uploads/')) return null;
  const relative = value.slice('/uploads/'.length).split('/').filter(Boolean);
  if (!relative.length) return null;
  const target = path.resolve(uploadsDir, ...relative);
  return isInside(uploadsDir, target) && target !== path.resolve(uploadsDir) ? target : null;
}

async function walkDirectory(root) {
  const files = [];
  const warnings = [];
  let totalBytes = 0;
  let newestMtime = 0;

  async function visit(current) {
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const stat = await fsPromises.lstat(target);
      newestMtime = Math.max(newestMtime, stat.mtimeMs || 0);
      if (stat.isSymbolicLink()) {
        warnings.push(`Enlace simbólico omitido: ${path.relative(root, target)}`);
        continue;
      }
      if (stat.isDirectory()) {
        await visit(target);
        continue;
      }
      if (!stat.isFile()) continue;
      totalBytes += Number(stat.size || 0);
      files.push({
        absolutePath: path.resolve(target),
        relativePath: path.relative(root, target).split(path.sep).join('/'),
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    }
  }

  await visit(root);
  return { files, fileCount: files.length, totalBytes, newestMtime, warnings };
}

async function inspectScope(scope, referencedPublicPaths = [], options = {}) {
  const uploadsDir = options.uploadsDir || config.UPLOADS_DIR;
  const nowMs = options.nowMs || Date.now();
  const root = scopeDirectory(scope, uploadsDir);
  const exists = await fsPromises.lstat(root).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch((error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!exists) {
    return { scope, exists: false, fileCount: 0, totalBytes: 0, referencedCount: 0, orphanCount: 0, orphanBytes: 0, recentUnreferencedCount: 0, newestMtime: null, warnings: [], files: [], orphanFiles: [] };
  }

  const walked = await walkDirectory(root);
  const referenced = new Set(referencedPublicPaths.map((item) => publicUploadToAbsolute(item, uploadsDir)).filter(Boolean).map((item) => path.resolve(item)));
  const unreferenced = walked.files.filter((file) => !referenced.has(file.absolutePath));
  const orphanFiles = unreferenced.filter((file) => nowMs - file.mtimeMs >= ORPHAN_GRACE_MS);
  const recentUnreferencedCount = unreferenced.length - orphanFiles.length;
  return {
    scope,
    exists: true,
    fileCount: walked.fileCount,
    totalBytes: walked.totalBytes,
    referencedCount: walked.files.filter((file) => referenced.has(file.absolutePath)).length,
    orphanCount: orphanFiles.length,
    orphanBytes: orphanFiles.reduce((sum, file) => sum + file.size, 0),
    recentUnreferencedCount,
    newestMtime: walked.newestMtime ? new Date(walked.newestMtime).toISOString() : null,
    warnings: walked.warnings,
    files: walked.files,
    orphanFiles,
  };
}

async function loadTenantReferences(tenant, tenantDbFactory) {
  const references = [];
  if (tenant.logo) references.push(tenant.logo);
  const tenantDb = tenantDbFactory(tenant.slug);
  const rows = await tenantDb.all("SELECT image FROM {s}.products WHERE image IS NOT NULL AND image <> ''");
  for (const row of rows) if (row.image) references.push(row.image);
  return [...new Set(references)];
}

function tenantIsProtected(tenant) {
  return Boolean(tenant.customer_since) || Number(tenant.payment_count || 0) > 0;
}

function tenantRecommendation(tenant, nowMs = Date.now()) {
  const lastActivity = tenant.module_last_seen || tenant.sales_updated_at || tenant.created_at;
  const inactiveDays = lastActivity ? Math.max(0, Math.floor((nowMs - new Date(lastActivity).getTime()) / 86400000)) : null;
  const discarded = ['not_interested', 'lost'].includes(String(tenant.sales_stage || ''));
  const expired = String(tenant.trial_status || '') === 'expired';
  return {
    inactiveDays,
    recommended: discarded || expired || (inactiveDays !== null && inactiveDays >= 30),
    reason: discarded ? 'Prospecto descartado' : expired ? 'Prueba vencida' : inactiveDays !== null && inactiveDays >= 30 ? `Sin actividad por ${inactiveDays} días` : 'Revisión manual',
  };
}

async function inspectProspectTenant(tenant, tenantDbFactory, options = {}) {
  const recommendation = tenantRecommendation(tenant, options.nowMs);
  if (tenantIsProtected(tenant)) {
    return { id: Number(tenant.id), slug: tenant.slug, businessName: tenant.business_name, protected: true, scanComplete: true, ...recommendation };
  }
  try {
    const references = await loadTenantReferences(tenant, tenantDbFactory);
    const storage = await inspectScope(tenant.slug, references, options);
    return {
      id: Number(tenant.id),
      slug: tenant.slug,
      businessName: tenant.business_name,
      accountStatus: tenant.account_status,
      trialStatus: tenant.trial_status,
      salesStage: tenant.sales_stage,
      createdAt: tenant.created_at,
      lastActivityAt: tenant.module_last_seen || tenant.sales_updated_at || tenant.created_at,
      protected: false,
      scanComplete: storage.warnings.length === 0,
      scanError: storage.warnings.length ? storage.warnings.join('. ') : '',
      references: references.length,
      storage: {
        exists: storage.exists,
        files: storage.fileCount,
        bytes: storage.totalBytes,
        referencedFiles: storage.referencedCount,
        orphanFiles: storage.orphanCount,
        orphanBytes: storage.orphanBytes,
        recentUnreferencedFiles: storage.recentUnreferencedCount,
        newestMtime: storage.newestMtime,
      },
      ...recommendation,
      _inspection: storage,
    };
  } catch (error) {
    return {
      id: Number(tenant.id), slug: tenant.slug, businessName: tenant.business_name,
      accountStatus: tenant.account_status, trialStatus: tenant.trial_status, salesStage: tenant.sales_stage,
      createdAt: tenant.created_at, lastActivityAt: tenant.module_last_seen || tenant.sales_updated_at || tenant.created_at,
      protected: false, scanComplete: false, scanError: error.message || 'No se pudo revisar el esquema privado',
      storage: null, ...recommendation,
    };
  }
}

async function loadStorageTenants(query) {
  const result = await query(`
    SELECT t.id,t.slug,t.business_name,t.logo,t.account_status,t.trial_status,t.sales_stage,
           t.sales_updated_at,t.created_at,t.customer_since,
           COALESCE(p.payment_count,0)::int AS payment_count,
           mu.module_last_seen
    FROM tenants t
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS payment_count FROM tenant_payments tp WHERE tp.tenant_id=t.id
    ) p ON true
    LEFT JOIN LATERAL (
      SELECT MAX(last_seen_at) AS module_last_seen FROM module_usage m WHERE m.tenant_id=t.id
    ) mu ON true
    ORDER BY t.customer_since NULLS FIRST, t.created_at DESC
  `);
  return result.rows || [];
}

async function scanStorageHygiene({ query, tenantDbFactory, uploadsDir = config.UPLOADS_DIR, nowMs = Date.now() }) {
  const tenants = await loadStorageTenants(query);
  const knownScopes = new Set(tenants.map((tenant) => String(tenant.slug || '').toLowerCase()));
  const clients = tenants.filter(tenantIsProtected);
  const rawProspects = tenants.filter((tenant) => !tenantIsProtected(tenant));
  const prospects = [];
  for (const tenant of rawProspects) prospects.push(await inspectProspectTenant(tenant, tenantDbFactory, { uploadsDir, nowMs }));

  const orphanScopes = [];
  const warnings = [];
  const entries = await fsPromises.readdir(uploadsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const scope = String(entry.name || '').toLowerCase();
    if (knownScopes.has(scope) || RESERVED_SCOPES.has(scope)) continue;
    if (entry.name !== scope || !SAFE_SCOPE_RE.test(scope)) {
      warnings.push(`Carpeta no reconocida omitida: ${entry.name}`);
      continue;
    }
    const storage = await inspectScope(scope, [], { uploadsDir, nowMs });
    orphanScopes.push({ scope, files: storage.fileCount, bytes: storage.totalBytes, newestMtime: storage.newestMtime, scanComplete: storage.warnings.length === 0, scanError: storage.warnings.join('. ') });
  }

  const jobsResult = await query(`SELECT id,subject_type,tenant_slug,business_name,action,status,file_count,total_bytes,created_by,created_at,quarantined_at,purge_after,purged_at,error FROM storage_cleanup_jobs ORDER BY created_at DESC LIMIT 25`);
  const prospectBytes = prospects.reduce((sum, item) => sum + Number(item.storage?.bytes || 0), 0);
  const recoverableBytes = prospects.reduce((sum, item) => sum + Number(item.storage?.orphanBytes || 0), 0) + orphanScopes.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
  return {
    scannedAt: new Date(nowMs).toISOString(),
    summary: {
      protectedClients: clients.length,
      prospects: prospects.length,
      recommendedProspects: prospects.filter((item) => item.recommended).length,
      prospectBytes,
      orphanScopes: orphanScopes.length,
      recoverableBytes,
      incompleteScans: prospects.filter((item) => !item.scanComplete).length + orphanScopes.filter((item) => !item.scanComplete).length,
    },
    prospects: prospects.map(({ _inspection, ...item }) => item),
    orphanScopes,
    warnings,
    jobs: jobsResult.rows || [],
  };
}

function quarantineKey(jobId, scope) {
  return `job_${Number(jobId)}_${assertSafeScope(scope)}`;
}

function quarantineDirectory(key, quarantineDir = config.STORAGE_QUARANTINE_DIR) {
  const safe = String(key || '').trim();
  if (!/^job_[1-9]\d*_[a-z0-9][a-z0-9_-]{0,63}$/.test(safe)) throw Object.assign(new Error('Destino de cuarentena inválido'), { status: 400 });
  const target = path.resolve(quarantineDir, safe);
  if (!isInside(quarantineDir, target) || target === path.resolve(quarantineDir)) throw Object.assign(new Error('Destino fuera de cuarentena'), { status: 400 });
  return target;
}

async function moveScopeToQuarantine(scope, jobId, options = {}) {
  const uploadsDir = options.uploadsDir || config.UPLOADS_DIR;
  const quarantineDir = options.quarantineDir || config.STORAGE_QUARANTINE_DIR;
  const source = scopeDirectory(scope, uploadsDir);
  const key = quarantineKey(jobId, scope);
  const destination = quarantineDirectory(key, quarantineDir);
  await fsPromises.mkdir(quarantineDir, { recursive: true });
  const exists = await fsPromises.lstat(source).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!exists) return { moved: false, key: '' };
  await fsPromises.rename(source, destination);
  return { moved: true, key };
}

async function moveOrphanFilesToQuarantine(scope, jobId, orphanFiles, options = {}) {
  const quarantineDir = options.quarantineDir || config.STORAGE_QUARANTINE_DIR;
  const key = quarantineKey(jobId, scope);
  const destinationRoot = quarantineDirectory(key, quarantineDir);
  const moved = [];
  try {
    for (const file of orphanFiles) {
      const destination = path.resolve(destinationRoot, file.relativePath);
      if (!isInside(destinationRoot, destination)) throw new Error('Archivo fuera del destino de cuarentena');
      await fsPromises.mkdir(path.dirname(destination), { recursive: true });
      await fsPromises.rename(file.absolutePath, destination);
      moved.push({ source: file.absolutePath, destination });
    }
    return { moved: moved.length, key };
  } catch (error) {
    for (const file of moved.reverse()) {
      try {
        await fsPromises.mkdir(path.dirname(file.source), { recursive: true });
        await fsPromises.rename(file.destination, file.source);
      } catch {}
    }
    throw error;
  }
}

async function restoreQuarantinedScope(scope, key, options = {}) {
  const source = quarantineDirectory(key, options.quarantineDir || config.STORAGE_QUARANTINE_DIR);
  const destination = scopeDirectory(scope, options.uploadsDir || config.UPLOADS_DIR);
  const exists = await fsPromises.lstat(source).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!exists) return false;
  await fsPromises.rename(source, destination);
  return true;
}

async function restoreQuarantinedFiles(scope, key, options = {}) {
  const sourceRoot = quarantineDirectory(key, options.quarantineDir || config.STORAGE_QUARANTINE_DIR);
  const destinationRoot = scopeDirectory(scope, options.uploadsDir || config.UPLOADS_DIR);
  const exists = await fsPromises.lstat(sourceRoot).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!exists) return false;
  const contents = await walkDirectory(sourceRoot);
  for (const file of contents.files) {
    const destination = path.resolve(destinationRoot, file.relativePath);
    if (!isInside(destinationRoot, destination)) throw new Error('Archivo fuera del almacenamiento del prospecto');
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    await fsPromises.rename(file.absolutePath, destination);
  }
  await fsPromises.rm(sourceRoot, { recursive: true, force: true });
  return true;
}

async function purgeQuarantine(key, options = {}) {
  const target = quarantineDirectory(key, options.quarantineDir || config.STORAGE_QUARANTINE_DIR);
  const exists = await fsPromises.lstat(target).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
  if (!exists) return false;
  await fsPromises.rm(target, { recursive: true, force: false });
  return true;
}

function purgeAfterDate(now = new Date()) {
  return new Date(now.getTime() + QUARANTINE_RETENTION_DAYS * 86400000);
}

module.exports = {
  ORPHAN_GRACE_MS,
  QUARANTINE_RETENTION_DAYS,
  RESERVED_SCOPES,
  assertSafeScope,
  inspectScope,
  inspectProspectTenant,
  loadStorageTenants,
  scanStorageHygiene,
  tenantIsProtected,
  moveScopeToQuarantine,
  moveOrphanFilesToQuarantine,
  restoreQuarantinedScope,
  restoreQuarantinedFiles,
  purgeQuarantine,
  purgeAfterDate,
};
