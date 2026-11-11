/**
 * Módulo: Reloj checador (asistencia, horarios y nómina).
 *
 * Expone dos superficies muy distintas sobre el mismo router:
 *  - `/api/checador/kiosk/:slug/:token` es PÚBLICA: la consume la liga externa
 *    que el admin genera para cada dispositivo (tableta, celular, TV o lector).
 *    No usa cookies de sesión; la autoridad es el token del dispositivo más la
 *    credencial del empleado (NIP, QR o huella WebAuthn).
 *  - el resto exige sesión de owner/staff con el módulo `checador` habilitado.
 *
 * Las rutas públicas se declaran ANTES de `requireAuth` a propósito.
 */
const express = require('express');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { q, tdb, getSetting, setSetting } = require('../db');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/security');
const { normalizeTimeZone } = require('../utils/regional');
const { saveImageBuffer, deleteManagedUpload } = require('../utils/uploads');
const { randomChallenge, rpIdFromHost, verifyAssertion, verifyRegistration } = require('../utils/webauthn');
const { pendingAdvanceAdjustments } = require('../utils/payrollAdvances');
const {
  INCIDENCE_TYPES,
  buildAttendance,
  buildDaySessions,
  computePayroll,
  daysBetween,
  isIsoDate,
  normalizeConfig,
  normalizeGrouping,
  normalizePayType,
  normalizePunchMethod,
  normalizePunchType,
  periodPreset,
  timeToMinutes,
} = require('../utils/timeClock');

const router = express.Router();

const CONFIG_SETTING_KEY = 'time_clock_config';
const SESSION_AUDIENCE = 'cbp:timeclock';
const SESSION_TTL_SECONDS = 180;
const CHALLENGE_TTL_SECONDS = 120;
const MAX_RANGE_DAYS = 370;
const MAX_PHOTO_BASE64 = 900 * 1024;
const KIOSK_METHODS = ['pin', 'qr', 'biometric'];
const PAYROLL_PERIOD_TYPES = ['weekly', 'biweekly', 'monthly', 'custom'];

/* ═══════════════════════════════════════════
   Helpers compartidos
═══════════════════════════════════════════ */
const cleanSlug = (value) => String(value || '').trim().toLowerCase();
const sanitizeStr = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
};
const safeNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function requireNumericId(req, res, next) {
  if (!/^\d+$/.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Registro no encontrado' });
  next();
}

function createToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Token del gafete QR: hexadecimal para que cualquier lector lo transmita sin ambigüedad. */
function createQrToken() {
  return crypto.randomBytes(18).toString('hex');
}

function badRequest(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeColor(value, fallback = '#6c47ff') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

/** Distancia entre dos coordenadas en metros (fórmula del semiverseno). */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function normalizeDeviceMethods(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw || '[]'); } catch { value = []; }
  }
  const methods = Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim().toLowerCase()).filter((item) => KIOSK_METHODS.includes(item)))]
    : [];
  return methods.length ? methods : ['pin'];
}

/** Hoy en la zona horaria del negocio, como texto YYYY-MM-DD. */
async function businessToday(tenantDb, timezone) {
  const row = await tenantDb.get('SELECT ((now() AT TIME ZONE $1)::date)::text AS today', [timezone]);
  return row?.today || new Date().toISOString().slice(0, 10);
}

function parseRange(query, today, cfg) {
  if (query?.preset) {
    const preset = periodPreset(query.preset, today, cfg);
    return preset;
  }
  const from = isIsoDate(query?.from) ? query.from : null;
  const to = isIsoDate(query?.to) ? query.to : null;
  if (from && to) {
    if (daysBetween(from, to) < 0) throw badRequest('La fecha inicial no puede ser posterior a la final');
    if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest(`El rango no puede exceder ${MAX_RANGE_DAYS} días`);
    return { from, to };
  }
  return periodPreset('month', today, cfg);
}

async function loadConfig(tenantDb) {
  const raw = await getSetting(tenantDb, CONFIG_SETTING_KEY, '');
  return normalizeConfig(raw);
}

/* ─────────────────────────────────────────────
   Carga de catálogos para los cálculos
───────────────────────────────────────────── */
async function loadSchedules(tenantDb) {
  const [schedules, days] = await Promise.all([
    tenantDb.all(
      `SELECT s.id, s.name, s.branch_id, s.color, s.notes, s.active, b.name AS branch_name
       FROM {s}.work_schedules s
       LEFT JOIN {s}.branches b ON b.id = s.branch_id
       ORDER BY s.name ASC`
    ),
    tenantDb.all('SELECT schedule_id, weekday, is_rest, start_time, end_time, break_minutes FROM {s}.work_schedule_days'),
  ]);
  const bySchedule = new Map();
  for (const day of days) {
    const id = Number(day.schedule_id);
    if (!bySchedule.has(id)) bySchedule.set(id, {});
    bySchedule.get(id)[Number(day.weekday)] = {
      weekday: Number(day.weekday),
      is_rest: Number(day.is_rest) === 1,
      start_time: day.start_time,
      end_time: day.end_time,
      break_minutes: Number(day.break_minutes) || 0,
    };
  }
  return schedules.map((schedule) => ({
    ...schedule,
    active: Number(schedule.active) === 1,
    days: bySchedule.get(Number(schedule.id)) || {},
  }));
}

async function loadEmployees(tenantDb, { branchId = 0, employeeId = 0, includeInactive = false } = {}) {
  const params = [];
  const where = [];
  if (!includeInactive) where.push('e.active = 1');
  if (positiveInt(branchId)) {
    params.push(positiveInt(branchId));
    where.push(`e.branch_id = $${params.length}`);
  }
  if (positiveInt(employeeId)) {
    params.push(positiveInt(employeeId));
    where.push(`e.id = $${params.length}`);
  }
  return tenantDb.all(
    `SELECT e.id, e.name, e.emp_code, e.position, e.department, e.branch_id, e.avatar_color, e.photo_url,
            e.schedule_id, e.pay_type, e.pay_rate::float AS pay_rate, e.clock_enabled, e.active,
            e.hire_date, e.phone, e.email, e.notes, e.salary_base::float AS salary_base,
            (e.pin_hash <> '') AS has_pin, e.qr_token,
            b.name AS branch_name, w.name AS schedule_name, w.color AS schedule_color
     FROM {s}.employees e
     LEFT JOIN {s}.branches b ON b.id = e.branch_id
     LEFT JOIN {s}.work_schedules w ON w.id = e.schedule_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.name ASC`,
    params
  );
}

/**
 * Checadas del rango con los dos formatos que necesita el motor de cálculo:
 * epoch absoluto (para duraciones) y minutos locales (para comparar horarios).
 */
async function loadPunches(tenantDb, timezone, { from, to, employeeId = 0, branchId = 0 }) {
  const params = [from, to, timezone];
  const where = ['p.business_date BETWEEN $1::date AND $2::date'];
  if (positiveInt(employeeId)) {
    params.push(positiveInt(employeeId));
    where.push(`p.employee_id = $${params.length}`);
  }
  if (positiveInt(branchId)) {
    params.push(positiveInt(branchId));
    where.push(`e.branch_id = $${params.length}`);
  }
  return tenantDb.all(
    `SELECT p.id, p.employee_id, p.device_id, p.branch_id, p.punch_type, p.method, p.status,
            p.punched_at, (p.business_date)::text AS business_date,
            EXTRACT(EPOCH FROM p.punched_at)::bigint AS epoch,
            (EXTRACT(HOUR FROM p.punched_at AT TIME ZONE $3) * 60
             + EXTRACT(MINUTE FROM p.punched_at AT TIME ZONE $3))::int AS local_minutes,
            p.photo_url, p.notes, p.latitude::float AS latitude, p.longitude::float AS longitude,
            p.distance_m, p.source, p.created_by,
            e.name AS employee_name, e.emp_code, d.name AS device_name
     FROM {s}.time_clock_punches p
     JOIN {s}.employees e ON e.id = p.employee_id
     LEFT JOIN {s}.time_clock_devices d ON d.id = p.device_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.punched_at ASC`,
    params
  );
}

async function loadIncidences(tenantDb, { from, to, employeeId = 0 }) {
  const params = [from, to];
  const where = ['i.date_to >= $1::date AND i.date_from <= $2::date'];
  if (positiveInt(employeeId)) {
    params.push(positiveInt(employeeId));
    where.push(`(i.employee_id = $${params.length} OR i.employee_id IS NULL)`);
  }
  return tenantDb.all(
    `SELECT i.id, i.employee_id, i.incidence_type, (i.date_from)::text AS date_from, (i.date_to)::text AS date_to,
            i.paid, i.pay_factor::float AS pay_factor, i.notes, i.created_by, i.created_at,
            e.name AS employee_name
     FROM {s}.attendance_incidences i
     LEFT JOIN {s}.employees e ON e.id = i.employee_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.date_from DESC, i.id DESC`,
    params
  );
}

/** Resumen de asistencia listo para reportes y nómina. */
async function buildRangeAttendance(tenantDb, timezone, { from, to, employeeId = 0, branchId = 0, grouping = 'day' }) {
  const cfg = await loadConfig(tenantDb);
  const [employees, punches, schedules, incidences] = await Promise.all([
    loadEmployees(tenantDb, { branchId, employeeId }),
    loadPunches(tenantDb, timezone, { from, to, employeeId, branchId }),
    loadSchedules(tenantDb),
    loadIncidences(tenantDb, { from, to, employeeId }),
  ]);
  return buildAttendance({
    employees: employees.filter((employee) => Number(employee.clock_enabled) === 1),
    punches,
    schedules,
    incidences,
    config: cfg,
    from,
    to,
    grouping: normalizeGrouping(grouping),
  });
}

/* ═══════════════════════════════════════════
   SUPERFICIE PÚBLICA — kiosco del checador
═══════════════════════════════════════════ */
const kiosk = express.Router({ mergeParams: true });

const kioskLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'Demasiadas solicitudes al checador. Espera un momento.',
});
const identifyLimiter = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 40,
  message: 'Demasiados intentos de identificación. Espera unos minutos.',
});

function kioskOrigin(req) {
  return `${req.protocol}://${String(req.get('host') || '').trim()}`;
}

function signKioskToken(payload, ttlSeconds) {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: ttlSeconds,
    issuer: 'chatbotpro',
    audience: SESSION_AUDIENCE,
  });
}

function verifyKioskToken(token) {
  try {
    return jwt.verify(String(token || ''), config.JWT_SECRET, {
      issuer: 'chatbotpro',
      audience: SESSION_AUDIENCE,
    });
  } catch {
    return null;
  }
}

/** Resuelve tenant + dispositivo a partir de la liga pública. */
async function resolveDevice(slug, token) {
  const tenantResult = await q(
    `SELECT id, slug, business_name, logo, primary_color, account_status, billing_status, timezone
     FROM tenants WHERE slug = $1 LIMIT 1`,
    [cleanSlug(slug)]
  );
  const tenant = tenantResult.rows[0];
  if (!tenant || tenant.account_status !== 'active' || tenant.billing_status === 'suspended') return null;

  const tenantDb = tdb(tenant.slug);
  const timezone = normalizeTimeZone(tenant.timezone);
  tenantDb.timezone = timezone;

  const device = await tenantDb.get(
    `SELECT d.id, d.name, d.branch_id, d.methods_json, d.require_photo, d.require_geo,
            d.geo_lat::float AS geo_lat, d.geo_lng::float AS geo_lng, d.geo_radius_m,
            d.lock_to_branch, d.active, b.name AS branch_name
     FROM {s}.time_clock_devices d
     LEFT JOIN {s}.branches b ON b.id = d.branch_id
     WHERE d.access_token = $1 AND d.active = 1
     LIMIT 1`,
    [String(token || '')]
  );
  if (!device) return null;

  return { tenant, tenantDb, timezone, device };
}

async function kioskContext(req, res, next) {
  try {
    if (!/^[a-z0-9-]{3,40}$/.test(cleanSlug(req.params.slug))) return res.status(404).json({ error: 'Checador no disponible' });
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(String(req.params.token || ''))) return res.status(404).json({ error: 'Checador no disponible' });
    const resolved = await resolveDevice(req.params.slug, req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Este checador no existe o fue desactivado' });
    req.kiosk = resolved;
    req.kiosk.config = await loadConfig(resolved.tenantDb);
    next();
  } catch (error) { next(error); }
}

function publicDevicePayload(context) {
  const { tenant, device } = context;
  return {
    business: {
      name: tenant.business_name,
      logo: tenant.logo || '',
      color: tenant.primary_color || '#ff6b35',
      slug: tenant.slug,
    },
    device: {
      id: Number(device.id),
      name: device.name,
      branch_id: device.branch_id ? Number(device.branch_id) : null,
      branch_name: device.branch_name || '',
      methods: normalizeDeviceMethods(device.methods_json),
      require_photo: Number(device.require_photo) === 1,
      require_geo: Number(device.require_geo) === 1,
      geo_radius_m: Number(device.geo_radius_m) || 0,
      has_geofence: Number(device.require_geo) === 1 && device.geo_lat !== null && device.geo_lng !== null,
    },
    timezone: context.timezone,
  };
}

/**
 * Estado del empleado al momento de identificarse: checadas del día, turno
 * abierto y siguiente acción sugerida.
 */
async function employeeClockState(context, employee) {
  const { tenantDb, timezone, config: cfg } = context;
  const today = await businessToday(tenantDb, timezone);

  // Se miran dos días para no perder turnos nocturnos abiertos de ayer.
  const punches = await tenantDb.all(
    `SELECT id, punch_type, punched_at, (business_date)::text AS business_date,
            EXTRACT(EPOCH FROM punched_at)::bigint AS epoch,
            (EXTRACT(HOUR FROM punched_at AT TIME ZONE $3) * 60
             + EXTRACT(MINUTE FROM punched_at AT TIME ZONE $3))::int AS local_minutes,
            method, status
     FROM {s}.time_clock_punches
     WHERE employee_id = $1 AND business_date >= ($2::date - 1) AND status = 'valid'
     ORDER BY punched_at ASC`,
    [employee.id, today, timezone]
  );

  const todayPunches = punches.filter((punch) => punch.business_date === today);
  const last = punches[punches.length - 1] || null;
  const lastType = last ? normalizePunchType(last.punch_type) : '';
  const nowEpoch = Math.floor(Date.now() / 1000);
  const shiftOpen = ['in', 'break_end'].includes(lastType)
    && (nowEpoch - Number(last.epoch)) < cfg.auto_close_hours * 3600;
  const onBreak = lastType === 'break_start'
    && (nowEpoch - Number(last.epoch)) < cfg.auto_close_hours * 3600;

  let next = 'in';
  if (onBreak) next = 'break_end';
  else if (shiftOpen) next = 'out';

  const available = onBreak
    ? ['break_end', 'out']
    : shiftOpen
      ? ['out', 'break_start']
      : ['in'];

  // Minutos trabajados hoy, con el mismo motor que usan los reportes.
  const todaySummary = buildDaySessions(todayPunches, cfg, nowEpoch);

  return {
    today,
    next,
    available,
    shift_open: shiftOpen,
    on_break: onBreak,
    worked_minutes_today: todaySummary.worked_minutes,
    break_minutes_today: todaySummary.break_minutes,
    punches_today: todayPunches.map((punch) => ({
      id: punch.id,
      type: normalizePunchType(punch.punch_type),
      at: punch.punched_at,
      local_minutes: Number(punch.local_minutes),
      method: punch.method,
    })),
    open_business_date: shiftOpen || onBreak ? last.business_date : today,
  };
}

function publicEmployeePayload(employee) {
  return {
    id: Number(employee.id),
    name: employee.name,
    emp_code: employee.emp_code || '',
    position: employee.position || '',
    photo_url: employee.photo_url || '',
    avatar_color: employee.avatar_color || '#6c47ff',
    branch_name: employee.branch_name || '',
    schedule_name: employee.schedule_name || '',
  };
}

/** Busca al empleado respetando el candado de sucursal del dispositivo. */
async function findKioskEmployee(context, { where, params }) {
  const { tenantDb, device } = context;
  const scoped = [...params];
  let branchClause = '';
  if (Number(device.lock_to_branch) === 1 && positiveInt(device.branch_id)) {
    scoped.push(positiveInt(device.branch_id));
    branchClause = ` AND e.branch_id = $${scoped.length}`;
  }
  return tenantDb.get(
    `SELECT e.id, e.name, e.emp_code, e.position, e.photo_url, e.avatar_color, e.pin_hash,
            e.branch_id, e.clock_enabled, e.active, b.name AS branch_name, w.name AS schedule_name
     FROM {s}.employees e
     LEFT JOIN {s}.branches b ON b.id = e.branch_id
     LEFT JOIN {s}.work_schedules w ON w.id = e.schedule_id
     WHERE ${where} AND e.active = 1 AND e.clock_enabled = 1${branchClause}
     LIMIT 1`,
    scoped
  );
}

/** El QR del gafete trae el prefijo CBP: pero también se acepta pelado. */
function normalizeQrPayload(raw) {
  const value = String(raw || '').trim();
  const match = /^(?:CBP[:|-])?([A-Za-z0-9_-]{8,64})$/.exec(value);
  return match ? match[1] : '';
}

kiosk.use(kioskLimiter);

/* Configuración pública del kiosco */
kiosk.get('/:slug/:token', kioskContext, async (req, res, next) => {
  try {
    await req.kiosk.tenantDb.run('UPDATE {s}.time_clock_devices SET last_used_at = now() WHERE id = $1', [req.kiosk.device.id]);
    res.json({
      ...publicDevicePayload(req.kiosk),
      server_time: new Date().toISOString(),
      today: await businessToday(req.kiosk.tenantDb, req.kiosk.timezone),
    });
  } catch (error) { next(error); }
});

/* Identificación por NIP o QR */
kiosk.post('/:slug/:token/identify', identifyLimiter, kioskContext, async (req, res, next) => {
  try {
    const methods = normalizeDeviceMethods(req.kiosk.device.methods_json);
    const method = String(req.body?.method || 'pin').trim().toLowerCase();
    if (!methods.includes(method)) return res.status(400).json({ error: 'Este checador no acepta ese método' });

    let employee = null;
    if (method === 'pin') {
      const code = sanitizeStr(req.body?.code, 24);
      const pin = String(req.body?.pin || '').trim();
      if (!code || !pin) return res.status(400).json({ error: 'Escribe tu número de empleado y tu NIP' });
      employee = await findKioskEmployee(req.kiosk, { where: 'lower(e.emp_code) = lower($1)', params: [code] });
      const matches = employee?.pin_hash ? await bcrypt.compare(pin, employee.pin_hash) : false;
      if (!employee || !matches) {
        // Mensaje único para no revelar qué códigos existen.
        return res.status(401).json({ error: 'Número de empleado o NIP incorrecto' });
      }
    } else if (method === 'qr') {
      const token = normalizeQrPayload(req.body?.qr);
      if (!token) return res.status(400).json({ error: 'El código escaneado no es válido' });
      employee = await findKioskEmployee(req.kiosk, { where: 'e.qr_token = $1', params: [token] });
      if (!employee) return res.status(401).json({ error: 'Credencial no reconocida en este checador' });
    } else {
      return res.status(400).json({ error: 'Usa el botón de huella para este método' });
    }

    const state = await employeeClockState(req.kiosk, employee);
    res.json({
      session: signKioskToken(
        { slug: req.kiosk.tenant.slug, did: Number(req.kiosk.device.id), eid: Number(employee.id), mth: method },
        SESSION_TTL_SECONDS
      ),
      expires_in: SESSION_TTL_SECONDS,
      employee: publicEmployeePayload(employee),
      state,
    });
  } catch (error) { next(error); }
});

/* Reto WebAuthn: alta (con sesión previa) o identificación */
kiosk.post('/:slug/:token/webauthn/options', identifyLimiter, kioskContext, async (req, res, next) => {
  try {
    const methods = normalizeDeviceMethods(req.kiosk.device.methods_json);
    if (!methods.includes('biometric')) return res.status(400).json({ error: 'Este checador no tiene huella habilitada' });

    const mode = String(req.body?.mode || 'login').trim().toLowerCase() === 'register' ? 'register' : 'login';
    const challenge = randomChallenge();
    const rpId = rpIdFromHost(req.get('host'));

    if (mode === 'register') {
      const session = verifyKioskToken(req.body?.session);
      if (!session || session.slug !== req.kiosk.tenant.slug || Number(session.did) !== Number(req.kiosk.device.id)) {
        return res.status(401).json({ error: 'Identifícate con tu NIP antes de registrar tu huella' });
      }
      const employee = await req.kiosk.tenantDb.get(
        'SELECT id, name, emp_code FROM {s}.employees WHERE id = $1 AND active = 1 AND clock_enabled = 1',
        [Number(session.eid)]
      );
      if (!employee) return res.status(404).json({ error: 'Empleado no disponible' });

      const existing = await req.kiosk.tenantDb.all(
        'SELECT credential_id FROM {s}.time_clock_credentials WHERE employee_id = $1 AND active = 1',
        [employee.id]
      );
      return res.json({
        mode,
        challenge_token: signKioskToken(
          { slug: req.kiosk.tenant.slug, did: Number(req.kiosk.device.id), eid: Number(employee.id), chl: challenge, mode },
          CHALLENGE_TTL_SECONDS
        ),
        publicKey: {
          challenge,
          rp: { id: rpId, name: req.kiosk.tenant.business_name || 'ChatBotPro' },
          user: {
            id: Buffer.from(`emp-${employee.id}`, 'utf8').toString('base64url'),
            name: employee.emp_code || `emp-${employee.id}`,
            displayName: employee.name,
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
          excludeCredentials: existing.map((row) => ({ type: 'public-key', id: row.credential_id })),
          timeout: CHALLENGE_TTL_SECONDS * 1000,
          attestation: 'none',
        },
      });
    }

    // Identificación: se ofrecen las credenciales dadas de alta en este equipo.
    const credentials = await req.kiosk.tenantDb.all(
      `SELECT c.credential_id
       FROM {s}.time_clock_credentials c
       JOIN {s}.employees e ON e.id = c.employee_id
       WHERE c.active = 1 AND e.active = 1 AND e.clock_enabled = 1
         AND (c.device_id = $1 OR c.device_id IS NULL)
       ORDER BY c.last_used_at DESC NULLS LAST
       LIMIT 20`,
      [Number(req.kiosk.device.id)]
    );
    res.json({
      mode,
      challenge_token: signKioskToken(
        { slug: req.kiosk.tenant.slug, did: Number(req.kiosk.device.id), chl: challenge, mode },
        CHALLENGE_TTL_SECONDS
      ),
      publicKey: {
        challenge,
        rpId,
        allowCredentials: credentials.map((row) => ({ type: 'public-key', id: row.credential_id })),
        userVerification: 'required',
        timeout: CHALLENGE_TTL_SECONDS * 1000,
      },
    });
  } catch (error) { next(error); }
});

/* Alta de huella en este dispositivo */
kiosk.post('/:slug/:token/webauthn/register', identifyLimiter, kioskContext, async (req, res, next) => {
  try {
    const claims = verifyKioskToken(req.body?.challenge_token);
    if (!claims || claims.mode !== 'register' || claims.slug !== req.kiosk.tenant.slug
      || Number(claims.did) !== Number(req.kiosk.device.id)) {
      return res.status(401).json({ error: 'El registro de huella expiró, vuelve a intentarlo' });
    }
    const employeeId = Number(claims.eid);
    const employee = await req.kiosk.tenantDb.get(
      'SELECT id, name FROM {s}.employees WHERE id = $1 AND active = 1 AND clock_enabled = 1',
      [employeeId]
    );
    if (!employee) return res.status(404).json({ error: 'Empleado no disponible' });

    const verified = verifyRegistration({
      credentialId: req.body?.credential_id,
      clientDataJSON: req.body?.client_data,
      publicKey: req.body?.public_key,
      algorithm: req.body?.algorithm,
      expectedChallenge: claims.chl,
      expectedOrigin: kioskOrigin(req),
    });

    await req.kiosk.tenantDb.run(
      `INSERT INTO {s}.time_clock_credentials (employee_id, device_id, kind, credential_id, public_key, algorithm, label)
       VALUES ($1,$2,'webauthn',$3,$4,$5,$6)
       ON CONFLICT (credential_id) DO UPDATE SET employee_id = EXCLUDED.employee_id,
         device_id = EXCLUDED.device_id, public_key = EXCLUDED.public_key,
         algorithm = EXCLUDED.algorithm, active = 1`,
      [
        employeeId,
        Number(req.kiosk.device.id),
        verified.credential_id,
        verified.public_key,
        verified.algorithm,
        sanitizeStr(req.body?.label || req.kiosk.device.name, 80),
      ]
    );
    res.json({ ok: true, employee: { id: employeeId, name: employee.name } });
  } catch (error) { next(error); }
});

/* Identificación por huella */
kiosk.post('/:slug/:token/webauthn/login', identifyLimiter, kioskContext, async (req, res, next) => {
  try {
    const claims = verifyKioskToken(req.body?.challenge_token);
    if (!claims || claims.mode !== 'login' || claims.slug !== req.kiosk.tenant.slug
      || Number(claims.did) !== Number(req.kiosk.device.id)) {
      return res.status(401).json({ error: 'El reto biométrico expiró, vuelve a intentarlo' });
    }
    const credentialId = sanitizeStr(req.body?.credential_id, 500);
    const credential = await req.kiosk.tenantDb.get(
      `SELECT c.id, c.employee_id, c.public_key, c.algorithm, c.sign_count
       FROM {s}.time_clock_credentials c
       WHERE c.credential_id = $1 AND c.active = 1 LIMIT 1`,
      [credentialId]
    );
    if (!credential) return res.status(401).json({ error: 'Huella no registrada en este sistema' });

    const result = verifyAssertion({
      clientDataJSON: req.body?.client_data,
      authenticatorData: req.body?.authenticator_data,
      signature: req.body?.signature,
      publicKey: credential.public_key,
      algorithm: credential.algorithm,
      expectedChallenge: claims.chl,
      expectedOrigin: kioskOrigin(req),
      rpId: rpIdFromHost(req.get('host')),
      storedSignCount: Number(credential.sign_count) || 0,
      requireUserVerification: true,
    });

    const employee = await findKioskEmployee(req.kiosk, { where: 'e.id = $1', params: [Number(credential.employee_id)] });
    if (!employee) return res.status(403).json({ error: 'El empleado no está habilitado en este checador' });

    await req.kiosk.tenantDb.run(
      'UPDATE {s}.time_clock_credentials SET sign_count = $1, last_used_at = now() WHERE id = $2',
      [result.sign_count, credential.id]
    );

    const state = await employeeClockState(req.kiosk, employee);
    res.json({
      session: signKioskToken(
        { slug: req.kiosk.tenant.slug, did: Number(req.kiosk.device.id), eid: Number(employee.id), mth: 'biometric' },
        SESSION_TTL_SECONDS
      ),
      expires_in: SESSION_TTL_SECONDS,
      employee: publicEmployeePayload(employee),
      state,
    });
  } catch (error) { next(error); }
});

/**
 * Inserta la checada tras validar reglas de negocio (geocerca, foto, repetición).
 * Se reutiliza desde el kiosco web y desde la integración de hardware.
 */
async function registerPunch(context, {
  employee, punchType, method, photoDataUrl = '', latitude = null, longitude = null,
  accuracy = null, ip = '', userAgent = '', source = 'kiosk', notes = '', createdBy = '',
}) {
  const { tenantDb, timezone, device, config: cfg, tenant } = context;
  const type = normalizePunchType(punchType);

  // Geocerca: la distancia se valida contra el punto configurado del dispositivo.
  let distance = null;
  const geoRequired = Number(device?.require_geo) === 1 && device?.geo_lat !== null && device?.geo_lng !== null;
  if (geoRequired) {
    if (latitude === null || longitude === null) {
      throw badRequest('Activa la ubicación del dispositivo para poder checar');
    }
    distance = haversineMeters(device.geo_lat, device.geo_lng, latitude, longitude);
    const radius = Math.max(20, Number(device.geo_radius_m) || 150);
    if (distance > radius) {
      throw badRequest(`Estás a ${distance} m del punto autorizado (máximo ${radius} m)`, 403);
    }
  }

  if (Number(device?.require_photo) === 1 && !photoDataUrl) {
    throw badRequest('Este checador requiere tomar la foto de evidencia');
  }

  const last = await tenantDb.get(
    `SELECT id, punch_type, (business_date)::text AS business_date,
            EXTRACT(EPOCH FROM punched_at)::bigint AS epoch
     FROM {s}.time_clock_punches
     WHERE employee_id = $1 AND status = 'valid'
     ORDER BY punched_at DESC LIMIT 1`,
    [employee.id]
  );

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (last && cfg.min_punch_gap_min > 0 && (nowEpoch - Number(last.epoch)) < cfg.min_punch_gap_min * 60) {
    throw badRequest(`Ya registraste un movimiento hace menos de ${cfg.min_punch_gap_min} min`, 409);
  }
  if (last && normalizePunchType(last.punch_type) === type && type !== 'in') {
    throw badRequest('Ese movimiento ya está registrado');
  }

  const today = await businessToday(tenantDb, timezone);
  // Un turno nocturno abierto conserva la fecha de negocio en que inició,
  // así la jornada no se parte en dos al cruzar la medianoche.
  const lastOpen = last && ['in', 'break_start', 'break_end'].includes(normalizePunchType(last.punch_type))
    && (nowEpoch - Number(last.epoch)) < cfg.auto_close_hours * 3600;
  const businessDate = type === 'in' || !lastOpen ? today : last.business_date;

  let photoUrl = '';
  if (photoDataUrl) photoUrl = await savePunchPhoto(photoDataUrl, tenant.slug);

  try {
    const row = await tenantDb.get(
      `INSERT INTO {s}.time_clock_punches
         (employee_id, device_id, branch_id, punch_type, business_date, method, photo_url,
          latitude, longitude, accuracy_m, distance_m, ip, user_agent, notes, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, punched_at`,
      [
        employee.id,
        device?.id ? Number(device.id) : null,
        positiveInt(employee.branch_id) || (device?.branch_id ? Number(device.branch_id) : null),
        type,
        businessDate,
        normalizePunchMethod(method),
        photoUrl,
        latitude,
        longitude,
        accuracy === null ? null : Math.round(Math.max(0, Math.min(99999, Number(accuracy) || 0))),
        distance,
        sanitizeStr(ip, 60),
        sanitizeStr(userAgent, 200),
        sanitizeStr(notes, 200),
        source,
        sanitizeStr(createdBy, 60),
      ]
    );
    return { id: row.id, punched_at: row.punched_at, business_date: businessDate, photo_url: photoUrl, distance_m: distance };
  } catch (error) {
    // No dejar la foto huérfana si la inserción falla.
    if (photoUrl) await deleteManagedUpload(photoUrl).catch(() => {});
    throw error;
  }
}

async function savePunchPhoto(dataUrl, slug) {
  const match = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim());
  if (!match) throw badRequest('La foto de evidencia no tiene un formato válido');
  if (match[2].length > MAX_PHOTO_BASE64) throw badRequest('La foto de evidencia es demasiado grande');
  return saveImageBuffer(Buffer.from(match[2], 'base64'), {
    scope: cleanSlug(slug),
    outputPrefix: 'checada',
    maxWidth: 640,
    quality: 70,
  });
}

/* Registro de la checada */
kiosk.post('/:slug/:token/punch', kioskContext, async (req, res, next) => {
  try {
    const session = verifyKioskToken(req.body?.session);
    if (!session || session.slug !== req.kiosk.tenant.slug || Number(session.did) !== Number(req.kiosk.device.id)) {
      return res.status(401).json({ error: 'Tu sesión expiró, identifícate de nuevo' });
    }
    const employee = await findKioskEmployee(req.kiosk, { where: 'e.id = $1', params: [Number(session.eid)] });
    if (!employee) return res.status(403).json({ error: 'El empleado ya no está habilitado en este checador' });

    const latitude = req.body?.latitude === undefined || req.body?.latitude === null ? null : safeNum(req.body.latitude, null);
    const longitude = req.body?.longitude === undefined || req.body?.longitude === null ? null : safeNum(req.body.longitude, null);

    const punch = await registerPunch(req.kiosk, {
      employee,
      punchType: req.body?.type,
      method: session.mth || 'pin',
      photoDataUrl: req.body?.photo || '',
      latitude,
      longitude,
      accuracy: req.body?.accuracy ?? null,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      source: 'kiosk',
    });

    const state = await employeeClockState(req.kiosk, employee);
    res.json({
      ok: true,
      punch: { ...punch, type: normalizePunchType(req.body?.type) },
      employee: publicEmployeePayload(employee),
      state,
    });
  } catch (error) { next(error); }
});

/**
 * Integración para hardware externo (lectores de huella, torniquetes, apps de
 * terceros). Autentica con la API key del dispositivo e identifica al empleado
 * por su token de credencial o su número de empleado.
 */
kiosk.post('/:slug/:token/device-punch', kioskContext, async (req, res, next) => {
  try {
    const apiKey = String(req.get('x-checador-key') || req.body?.api_key || '').trim();
    const device = await req.kiosk.tenantDb.get(
      'SELECT api_key FROM {s}.time_clock_devices WHERE id = $1',
      [req.kiosk.device.id]
    );
    const expected = String(device?.api_key || '');
    const provided = apiKey;
    const valid = expected.length > 0 && provided.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!valid) return res.status(401).json({ error: 'API key del dispositivo inválida' });

    const externalId = sanitizeStr(req.body?.employee_ref || req.body?.external_id, 64);
    if (!externalId) return res.status(400).json({ error: 'Falta employee_ref (número de empleado o token de credencial)' });

    const employee = await findKioskEmployee(req.kiosk, {
      where: '(lower(e.emp_code) = lower($1) OR e.qr_token = $1)',
      params: [externalId],
    });
    if (!employee) return res.status(404).json({ error: 'Empleado no encontrado para este dispositivo' });

    const before = await employeeClockState(req.kiosk, employee);
    const punch = await registerPunch(req.kiosk, {
      employee,
      punchType: req.body?.type || before.next,
      method: 'device',
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      source: 'device',
      notes: sanitizeStr(req.body?.notes, 120),
    });
    res.json({ ok: true, employee: publicEmployeePayload(employee), punch, state: await employeeClockState(req.kiosk, employee) });
  } catch (error) { next(error); }
});

router.use('/kiosk', kiosk);

/* ═══════════════════════════════════════════
   SUPERFICIE PRIVADA — panel del administrador
═══════════════════════════════════════════ */
router.use(requireAuth);
router.use(requireModules('checador'));
router.use(requireOwner);

/* ─────────────── Configuración general ─────────────── */
router.get('/config', async (req, res, next) => {
  try {
    const [cfg, branches, schedules, devices] = await Promise.all([
      loadConfig(req.tdb),
      req.tdb.all('SELECT id, name FROM {s}.branches WHERE active = 1 ORDER BY name ASC'),
      loadSchedules(req.tdb),
      req.tdb.all(
        `SELECT d.id, d.name, d.branch_id, d.access_token, d.api_key, d.methods_json, d.require_photo,
                d.require_geo, d.geo_lat::float AS geo_lat, d.geo_lng::float AS geo_lng, d.geo_radius_m,
                d.lock_to_branch, d.active, d.last_used_at, b.name AS branch_name
         FROM {s}.time_clock_devices d
         LEFT JOIN {s}.branches b ON b.id = d.branch_id
         ORDER BY d.id ASC`
      ),
    ]);
    res.json({
      config: cfg,
      branches,
      schedules,
      devices: devices.map(serializeDevice),
      incidence_types: Object.entries(INCIDENCE_TYPES).map(([key, meta]) => ({ key, ...meta })),
      timezone: req.timezone,
      today: await businessToday(req.tdb, req.timezone),
    });
  } catch (error) { next(error); }
});

router.put('/config', async (req, res, next) => {
  try {
    const merged = normalizeConfig({ ...(await loadConfig(req.tdb)), ...(req.body || {}) });
    await setSetting(req.tdb, CONFIG_SETTING_KEY, JSON.stringify(merged));
    res.json({ ok: true, config: merged });
  } catch (error) { next(error); }
});

/* ─────────────── Dispositivos / ligas externas ─────────────── */
function serializeDevice(device) {
  return {
    id: Number(device.id),
    name: device.name,
    branch_id: device.branch_id ? Number(device.branch_id) : null,
    branch_name: device.branch_name || '',
    access_token: device.access_token,
    api_key: device.api_key,
    methods: normalizeDeviceMethods(device.methods_json),
    require_photo: Number(device.require_photo) === 1,
    require_geo: Number(device.require_geo) === 1,
    geo_lat: device.geo_lat,
    geo_lng: device.geo_lng,
    geo_radius_m: Number(device.geo_radius_m) || 150,
    lock_to_branch: Number(device.lock_to_branch) === 1,
    active: Number(device.active) === 1,
    last_used_at: device.last_used_at,
  };
}

function deviceBodyValues(body = {}) {
  const geoLat = body.geo_lat === '' || body.geo_lat === null || body.geo_lat === undefined ? null : safeNum(body.geo_lat, null);
  const geoLng = body.geo_lng === '' || body.geo_lng === null || body.geo_lng === undefined ? null : safeNum(body.geo_lng, null);
  return {
    name: sanitizeStr(body.name, 80) || 'Reloj checador',
    branchId: positiveInt(body.branch_id) || null,
    methods: JSON.stringify(normalizeDeviceMethods(body.methods)),
    requirePhoto: body.require_photo ? 1 : 0,
    requireGeo: body.require_geo ? 1 : 0,
    geoLat: geoLat !== null && Math.abs(geoLat) <= 90 ? geoLat : null,
    geoLng: geoLng !== null && Math.abs(geoLng) <= 180 ? geoLng : null,
    geoRadius: Math.max(20, Math.min(5000, Math.round(safeNum(body.geo_radius_m, 150)))),
    lockToBranch: body.lock_to_branch === false || body.lock_to_branch === 0 ? 0 : 1,
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

router.post('/devices', async (req, res, next) => {
  try {
    const values = deviceBodyValues(req.body);
    if (values.requireGeo && (values.geoLat === null || values.geoLng === null)) {
      return res.status(400).json({ error: 'Define la ubicación autorizada para activar la geocerca' });
    }
    const row = await req.tdb.get(
      `INSERT INTO {s}.time_clock_devices
         (name, branch_id, access_token, api_key, methods_json, require_photo, require_geo,
          geo_lat, geo_lng, geo_radius_m, lock_to_branch, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, access_token, api_key`,
      [
        values.name, values.branchId, createToken(), crypto.randomBytes(24).toString('hex'),
        values.methods, values.requirePhoto, values.requireGeo,
        values.geoLat, values.geoLng, values.geoRadius, values.lockToBranch, values.active,
      ]
    );
    res.json({ id: row.id, access_token: row.access_token, api_key: row.api_key });
  } catch (error) { next(error); }
});

router.put('/devices/:id', requireNumericId, async (req, res, next) => {
  try {
    const values = deviceBodyValues(req.body);
    if (values.requireGeo && (values.geoLat === null || values.geoLng === null)) {
      return res.status(400).json({ error: 'Define la ubicación autorizada para activar la geocerca' });
    }
    const result = await req.tdb.run(
      `UPDATE {s}.time_clock_devices SET name=$1, branch_id=$2, methods_json=$3, require_photo=$4,
              require_geo=$5, geo_lat=$6, geo_lng=$7, geo_radius_m=$8, lock_to_branch=$9,
              active=$10, updated_at=now()
       WHERE id=$11`,
      [
        values.name, values.branchId, values.methods, values.requirePhoto, values.requireGeo,
        values.geoLat, values.geoLng, values.geoRadius, values.lockToBranch, values.active, req.params.id,
      ]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/devices/:id/rotate-token', requireNumericId, async (req, res, next) => {
  try {
    const row = await req.tdb.get(
      `UPDATE {s}.time_clock_devices SET access_token=$1, api_key=$2, updated_at=now()
       WHERE id=$3 RETURNING access_token, api_key`,
      [createToken(), crypto.randomBytes(24).toString('hex'), req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Dispositivo no encontrado' });
    res.json({ ok: true, access_token: row.access_token, api_key: row.api_key });
  } catch (error) { next(error); }
});

router.delete('/devices/:id', requireNumericId, async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.time_clock_devices WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ─────────────── Horarios ─────────────── */
const DEFAULT_WEEK = [
  { weekday: 1, is_rest: 0, start_time: '09:00', end_time: '18:00', break_minutes: 60 },
  { weekday: 2, is_rest: 0, start_time: '09:00', end_time: '18:00', break_minutes: 60 },
  { weekday: 3, is_rest: 0, start_time: '09:00', end_time: '18:00', break_minutes: 60 },
  { weekday: 4, is_rest: 0, start_time: '09:00', end_time: '18:00', break_minutes: 60 },
  { weekday: 5, is_rest: 0, start_time: '09:00', end_time: '18:00', break_minutes: 60 },
  { weekday: 6, is_rest: 0, start_time: '09:00', end_time: '14:00', break_minutes: 0 },
  { weekday: 0, is_rest: 1, start_time: '09:00', end_time: '18:00', break_minutes: 0 },
];

function normalizeScheduleDays(raw) {
  const source = Array.isArray(raw) && raw.length ? raw : DEFAULT_WEEK;
  const byWeekday = new Map();
  for (const day of source) {
    const weekday = Number(day?.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    const isRest = day.is_rest === true || day.is_rest === 1 || day.is_rest === '1' ? 1 : 0;
    const start = timeToMinutes(day.start_time) === null ? '09:00' : String(day.start_time).padStart(5, '0');
    const end = timeToMinutes(day.end_time) === null ? '18:00' : String(day.end_time).padStart(5, '0');
    byWeekday.set(weekday, {
      weekday,
      is_rest: isRest,
      start_time: start,
      end_time: end,
      break_minutes: Math.max(0, Math.min(480, Math.round(safeNum(day.break_minutes, 0)))),
    });
  }
  for (let weekday = 0; weekday <= 6; weekday++) {
    if (!byWeekday.has(weekday)) byWeekday.set(weekday, { weekday, is_rest: 1, start_time: '09:00', end_time: '18:00', break_minutes: 0 });
  }
  return [...byWeekday.values()].sort((a, b) => a.weekday - b.weekday);
}

async function writeScheduleDays(tenantDb, scheduleId, days) {
  await tenantDb.run('DELETE FROM {s}.work_schedule_days WHERE schedule_id = $1', [scheduleId]);
  for (const day of days) {
    await tenantDb.run(
      `INSERT INTO {s}.work_schedule_days (schedule_id, weekday, is_rest, start_time, end_time, break_minutes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [scheduleId, day.weekday, day.is_rest, day.start_time, day.end_time, day.break_minutes]
    );
  }
}

router.get('/schedules', async (req, res, next) => {
  try {
    res.json(await loadSchedules(req.tdb));
  } catch (error) { next(error); }
});

router.post('/schedules', async (req, res, next) => {
  try {
    const name = sanitizeStr(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: 'El nombre del horario es obligatorio' });
    const days = normalizeScheduleDays(req.body?.days);
    const row = await req.tdb.get(
      `INSERT INTO {s}.work_schedules (name, branch_id, color, notes, active)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, positiveInt(req.body?.branch_id) || null, normalizeColor(req.body?.color), sanitizeStr(req.body?.notes, 300), req.body?.active === false ? 0 : 1]
    );
    await writeScheduleDays(req.tdb, row.id, days);
    res.json({ id: row.id });
  } catch (error) { next(error); }
});

router.put('/schedules/:id', requireNumericId, async (req, res, next) => {
  try {
    const name = sanitizeStr(req.body?.name, 80);
    if (!name) return res.status(400).json({ error: 'El nombre del horario es obligatorio' });
    const result = await req.tdb.run(
      `UPDATE {s}.work_schedules SET name=$1, branch_id=$2, color=$3, notes=$4, active=$5, updated_at=now()
       WHERE id=$6`,
      [
        name, positiveInt(req.body?.branch_id) || null, normalizeColor(req.body?.color),
        sanitizeStr(req.body?.notes, 300), req.body?.active === false ? 0 : 1, req.params.id,
      ]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Horario no encontrado' });
    if (Array.isArray(req.body?.days)) await writeScheduleDays(req.tdb, Number(req.params.id), normalizeScheduleDays(req.body.days));
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete('/schedules/:id', requireNumericId, async (req, res, next) => {
  try {
    await req.tdb.run('UPDATE {s}.employees SET schedule_id = NULL WHERE schedule_id = $1', [req.params.id]);
    await req.tdb.run('DELETE FROM {s}.work_schedule_days WHERE schedule_id = $1', [req.params.id]);
    await req.tdb.run('DELETE FROM {s}.work_schedules WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ─────────────── Empleados del checador ─────────────── */
const AVATAR_COLORS = ['#6c47ff', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

function employeeBodyValues(body = {}) {
  return {
    name: sanitizeStr(body.name, 120),
    empCode: sanitizeStr(body.emp_code, 24),
    position: sanitizeStr(body.position, 100),
    department: sanitizeStr(body.department, 100),
    branchId: positiveInt(body.branch_id) || null,
    scheduleId: positiveInt(body.schedule_id) || null,
    payType: normalizePayType(body.pay_type),
    payRate: Math.max(0, safeNum(body.pay_rate, 0)),
    phone: sanitizeStr(body.phone, 30),
    email: sanitizeStr(body.email, 100),
    hireDate: isIsoDate(body.hire_date) ? body.hire_date : null,
    notes: sanitizeStr(body.notes, 500),
    clockEnabled: body.clock_enabled === false || body.clock_enabled === 0 ? 0 : 1,
    active: body.active === false || body.active === 0 ? 0 : 1,
    avatarColor: normalizeColor(body.avatar_color, AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]),
  };
}

function validatePin(raw) {
  const pin = String(raw ?? '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw badRequest('El NIP debe tener entre 4 y 8 dígitos');
  if (/^(\d)\1+$/.test(pin)) throw badRequest('El NIP no puede ser un mismo dígito repetido');
  return pin;
}

router.get('/employees', async (req, res, next) => {
  try {
    const employees = await loadEmployees(req.tdb, {
      branchId: req.query?.branch_id,
      includeInactive: String(req.query?.include_inactive || '') === '1',
    });
    const credentials = await req.tdb.all(
      `SELECT id, employee_id, device_id, kind, label, active, last_used_at, created_at
       FROM {s}.time_clock_credentials WHERE active = 1 ORDER BY created_at DESC`
    );
    const byEmployee = new Map();
    for (const credential of credentials) {
      const key = Number(credential.employee_id);
      if (!byEmployee.has(key)) byEmployee.set(key, []);
      byEmployee.get(key).push(credential);
    }
    res.json(employees.map((employee) => ({
      ...employee,
      active: Number(employee.active) === 1,
      clock_enabled: Number(employee.clock_enabled) === 1,
      has_pin: Boolean(employee.has_pin),
      credentials: byEmployee.get(Number(employee.id)) || [],
    })));
  } catch (error) { next(error); }
});

router.post('/employees', async (req, res, next) => {
  try {
    const values = employeeBodyValues(req.body);
    if (!values.name) return res.status(400).json({ error: 'El nombre del empleado es obligatorio' });
    if (!values.branchId) return res.status(400).json({ error: 'Selecciona la sucursal del empleado' });
    const branch = await req.tdb.get('SELECT id FROM {s}.branches WHERE id=$1 AND active=1', [values.branchId]);
    if (!branch) return res.status(400).json({ error: 'La sucursal seleccionada no está disponible' });

    const pin = req.body?.pin ? validatePin(req.body.pin) : '';
    const pinHash = pin ? await bcrypt.hash(pin, 10) : '';

    const row = await req.tdb.get(
      `INSERT INTO {s}.employees
         (name, emp_code, position, department, hire_date, salary_base, phone, email, branch_id,
          avatar_color, notes, schedule_id, pay_type, pay_rate, clock_enabled, pin_hash, qr_token, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$18,$17)
       RETURNING id, emp_code, qr_token`,
      [
        values.name, values.empCode, values.position, values.department, values.hireDate,
        values.payRate, values.phone, values.email, values.branchId, values.avatarColor,
        values.notes, values.scheduleId, values.payType, values.payRate, values.clockEnabled,
        pinHash, values.active, createQrToken(),
      ]
    );
    // Sin número capturado, el propio id sirve de folio y nunca colisiona.
    if (!values.empCode) {
      const numbered = await req.tdb.get(
        "UPDATE {s}.employees SET emp_code = lpad(id::text, 4, '0') WHERE id = $1 RETURNING emp_code",
        [row.id]
      );
      row.emp_code = numbered?.emp_code || row.emp_code;
    }
    res.json({ id: row.id, emp_code: row.emp_code, qr_token: row.qr_token });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Ese número de empleado ya está en uso' });
    next(error);
  }
});

router.put('/employees/:id', requireNumericId, async (req, res, next) => {
  try {
    const values = employeeBodyValues(req.body);
    if (!values.name) return res.status(400).json({ error: 'El nombre del empleado es obligatorio' });
    if (!values.branchId) return res.status(400).json({ error: 'Selecciona la sucursal del empleado' });
    const result = await req.tdb.run(
      `UPDATE {s}.employees SET name=$1, emp_code=COALESCE(NULLIF($2,''), emp_code), position=$3, department=$4,
              hire_date=$5, phone=$6, email=$7, branch_id=$8, avatar_color=$9, notes=$10,
              schedule_id=$11, pay_type=$12, pay_rate=$13, salary_base=$13, clock_enabled=$14, active=$15
       WHERE id=$16`,
      [
        values.name, values.empCode, values.position, values.department, values.hireDate,
        values.phone, values.email, values.branchId, values.avatarColor, values.notes,
        values.scheduleId, values.payType, values.payRate, values.clockEnabled, values.active, req.params.id,
      ]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true });
  } catch (error) {
    if (error?.code === '23505') return res.status(409).json({ error: 'Ese número de empleado ya está en uso' });
    next(error);
  }
});

router.delete('/employees/:id', requireNumericId, async (req, res, next) => {
  try {
    await req.tdb.run('UPDATE {s}.employees SET active=0, clock_enabled=0 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/employees/:id/pin', requireNumericId, async (req, res, next) => {
  try {
    const pin = validatePin(req.body?.pin);
    const result = await req.tdb.run(
      'UPDATE {s}.employees SET pin_hash=$1 WHERE id=$2',
      [await bcrypt.hash(pin, 10), req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/employees/:id/qr/rotate', requireNumericId, async (req, res, next) => {
  try {
    const row = await req.tdb.get(
      'UPDATE {s}.employees SET qr_token = $1 WHERE id=$2 RETURNING qr_token',
      [createQrToken(), req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json({ ok: true, qr_token: row.qr_token });
  } catch (error) { next(error); }
});

router.delete('/credentials/:id', requireNumericId, async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.time_clock_credentials WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ─────────────── Checadas ─────────────── */
router.get('/punches', async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.tdb);
    const today = await businessToday(req.tdb, req.timezone);
    const { from, to } = parseRange(req.query, today, cfg);
    const punches = await loadPunches(req.tdb, req.timezone, {
      from,
      to,
      employeeId: req.query?.employee_id,
      branchId: req.query?.branch_id,
    });
    res.json({ from, to, punches });
  } catch (error) { next(error); }
});

router.post('/punches', async (req, res, next) => {
  try {
    const employeeId = positiveInt(req.body?.employee_id);
    if (!employeeId) return res.status(400).json({ error: 'Selecciona al empleado' });
    const type = normalizePunchType(req.body?.type);
    const date = isIsoDate(req.body?.date) ? req.body.date : null;
    const time = timeToMinutes(req.body?.time) === null ? null : String(req.body.time);
    if (!date || !time) return res.status(400).json({ error: 'Indica la fecha y la hora del movimiento' });

    const employee = await req.tdb.get('SELECT id, branch_id FROM {s}.employees WHERE id=$1 AND active=1', [employeeId]);
    if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });

    // La hora capturada es hora local del negocio; Postgres la ancla al huso.
    const row = await req.tdb.get(
      `INSERT INTO {s}.time_clock_punches
         (employee_id, branch_id, punch_type, punched_at, business_date, method, notes, source, created_by)
       VALUES ($1,$2,$3, (($4::text || ' ' || $5::text)::timestamp AT TIME ZONE $6), $4::date, 'manual', $7, 'admin', $8)
       RETURNING id, punched_at`,
      [
        employeeId, employee.branch_id, type, date, time, req.timezone,
        sanitizeStr(req.body?.notes, 200), req.user?.username || 'owner',
      ]
    );
    res.json({ id: row.id, punched_at: row.punched_at });
  } catch (error) { next(error); }
});

router.put('/punches/:id', requireNumericId, async (req, res, next) => {
  try {
    const type = normalizePunchType(req.body?.type);
    const date = isIsoDate(req.body?.date) ? req.body.date : null;
    const time = timeToMinutes(req.body?.time) === null ? null : String(req.body.time);
    if (!date || !time) return res.status(400).json({ error: 'Indica la fecha y la hora del movimiento' });
    const result = await req.tdb.run(
      `UPDATE {s}.time_clock_punches
       SET punch_type=$1, punched_at=(($2::text || ' ' || $3::text)::timestamp AT TIME ZONE $4), business_date=$2::date,
           notes=$5, created_by=$6
       WHERE id=$7`,
      [type, date, time, req.timezone, sanitizeStr(req.body?.notes, 200), req.user?.username || 'owner', req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Checada no encontrada' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/punches/:id/void', requireNumericId, async (req, res, next) => {
  try {
    const reason = sanitizeStr(req.body?.reason, 200);
    const result = await req.tdb.run(
      `UPDATE {s}.time_clock_punches
       SET status='voided', notes = CASE WHEN $1 = '' THEN notes ELSE $1 END
       WHERE id=$2 AND status='valid'`,
      [reason, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Checada no encontrada o ya invalidada' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ─────────────── Incidencias ─────────────── */
router.get('/incidences', async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.tdb);
    const today = await businessToday(req.tdb, req.timezone);
    const { from, to } = parseRange(req.query, today, cfg);
    res.json({ from, to, incidences: await loadIncidences(req.tdb, { from, to, employeeId: req.query?.employee_id }) });
  } catch (error) { next(error); }
});

router.post('/incidences', async (req, res, next) => {
  try {
    const type = String(req.body?.incidence_type || 'falta').trim().toLowerCase();
    const meta = INCIDENCE_TYPES[type];
    if (!meta) return res.status(400).json({ error: 'Tipo de incidencia no válido' });
    const from = isIsoDate(req.body?.date_from) ? req.body.date_from : null;
    const to = isIsoDate(req.body?.date_to) ? req.body.date_to : from;
    if (!from || !to) return res.status(400).json({ error: 'Indica el rango de fechas de la incidencia' });
    if (daysBetween(from, to) < 0) return res.status(400).json({ error: 'La fecha inicial no puede ser posterior a la final' });
    if (daysBetween(from, to) + 1 > 400) return res.status(400).json({ error: 'El rango de la incidencia es demasiado largo' });

    const employeeId = positiveInt(req.body?.employee_id) || null;
    const payFactor = req.body?.pay_factor === undefined || req.body?.pay_factor === ''
      ? meta.payFactor
      : Math.max(0, Math.min(2, safeNum(req.body.pay_factor, meta.payFactor)));

    const row = await req.tdb.get(
      `INSERT INTO {s}.attendance_incidences
         (employee_id, incidence_type, date_from, date_to, paid, pay_factor, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [employeeId, type, from, to, payFactor > 0 ? 1 : 0, payFactor, sanitizeStr(req.body?.notes, 300), req.user?.username || 'owner']
    );
    res.json({ id: row.id });
  } catch (error) { next(error); }
});

router.delete('/incidences/:id', requireNumericId, async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.attendance_incidences WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/* ─────────────── Reportes ─────────────── */
router.get('/reports/attendance', async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.tdb);
    const today = await businessToday(req.tdb, req.timezone);
    const { from, to } = parseRange(req.query, today, cfg);
    const attendance = await buildRangeAttendance(req.tdb, req.timezone, {
      from,
      to,
      employeeId: req.query?.employee_id,
      branchId: req.query?.branch_id,
      grouping: req.query?.group,
    });
    res.json({ ...attendance, today });
  } catch (error) { next(error); }
});

/** Tablero del módulo: quién está dentro ahora mismo y cómo va la semana. */
router.get('/overview', async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.tdb);
    const today = await businessToday(req.tdb, req.timezone);
    const week = periodPreset('week', today, cfg);

    const [todayAttendance, weekAttendance, devices, lastPunches] = await Promise.all([
      buildRangeAttendance(req.tdb, req.timezone, { from: today, to: today, grouping: 'day' }),
      buildRangeAttendance(req.tdb, req.timezone, { from: week.from, to: week.to, grouping: 'day' }),
      req.tdb.get('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active=1)::int AS active FROM {s}.time_clock_devices'),
      loadPunches(req.tdb, req.timezone, { from: today, to: today }),
    ]);

    const present = todayAttendance.rows.filter((row) => row.days[0]?.open_shift).length;
    const lateToday = todayAttendance.rows.filter((row) => (row.days[0]?.late_minutes || 0) > 0).length;
    const absentToday = todayAttendance.rows.filter((row) => row.days[0]?.counts_absent).length;

    res.json({
      today,
      week,
      totals_today: todayAttendance.totals,
      totals_week: weekAttendance.totals,
      employees_tracked: todayAttendance.rows.length,
      present_now: present,
      late_today: lateToday,
      absent_today: absentToday,
      devices: devices || { total: 0, active: 0 },
      recent_punches: lastPunches.slice(-25).reverse(),
      today_rows: todayAttendance.rows.map((row) => ({ employee: row.employee, day: row.days[0] })),
    });
  } catch (error) { next(error); }
});

/* ─────────────── Nómina ─────────────── */
async function adjustmentsMap(tenantDb, periodId) {
  const rows = await tenantDb.all(
    `SELECT id, employee_id, concept, kind, amount::float AS amount, notes, created_by, created_at
     FROM {s}.payroll_adjustments WHERE period_id = $1 ORDER BY id ASC`,
    [periodId]
  );
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.employee_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

router.get('/payroll/preview', async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.tdb);
    const today = await businessToday(req.tdb, req.timezone);
    const { from, to } = parseRange(req.query, today, cfg);
    const attendance = await buildRangeAttendance(req.tdb, req.timezone, {
      from,
      to,
      branchId: req.query?.branch_id,
      employeeId: req.query?.employee_id,
      grouping: 'day',
    });
    const adjustmentsByEmployee = await pendingAdvanceAdjustments(req.tdb, to);
    res.json({ ...computePayroll({ attendance, from, to, adjustmentsByEmployee }), config: attendance.config, today });
  } catch (error) { next(error); }
});

router.get('/payroll/periods', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT p.id, p.name, p.period_type, (p.start_date)::text AS start_date, (p.end_date)::text AS end_date,
              p.branch_id, p.status, p.total_gross::float AS total_gross, p.total_deductions::float AS total_deductions,
              p.total_net::float AS total_net, p.notes, p.created_by, p.created_at, p.approved_at, p.paid_at,
              b.name AS branch_name,
              (SELECT COUNT(*)::int FROM {s}.payroll_items i WHERE i.period_id = p.id) AS employees_count
       FROM {s}.payroll_periods p
       LEFT JOIN {s}.branches b ON b.id = p.branch_id
       ORDER BY p.start_date DESC, p.id DESC
       LIMIT 60`
    );
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/payroll/periods', async (req, res, next) => {
  try {
    const cfg = await loadConfig(req.tdb);
    const from = isIsoDate(req.body?.start_date) ? req.body.start_date : null;
    const to = isIsoDate(req.body?.end_date) ? req.body.end_date : null;
    if (!from || !to) return res.status(400).json({ error: 'Indica el rango del periodo de nómina' });
    if (daysBetween(from, to) < 0) return res.status(400).json({ error: 'La fecha inicial no puede ser posterior a la final' });
    if (daysBetween(from, to) + 1 > 93) return res.status(400).json({ error: 'Un periodo de nómina no puede exceder 93 días' });

    const periodType = PAYROLL_PERIOD_TYPES.includes(req.body?.period_type) ? req.body.period_type : 'custom';
    const branchId = positiveInt(req.body?.branch_id) || null;
    const attendance = await buildRangeAttendance(req.tdb, req.timezone, { from, to, branchId, grouping: 'day' });
    const payroll = computePayroll({ attendance, from, to, adjustmentsByEmployee: await pendingAdvanceAdjustments(req.tdb, to) });
    if (!payroll.items.length) return res.status(400).json({ error: 'No hay empleados con checador activo en ese periodo' });

    const periodId = await req.tdb.tx(async (trx) => {
      const period = await trx.get(
        `INSERT INTO {s}.payroll_periods
           (name, period_type, start_date, end_date, branch_id, status, total_gross, total_deductions, total_net, config_json, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          sanitizeStr(req.body?.name, 120) || `Nómina ${from} a ${to}`,
          periodType, from, to, branchId,
          payroll.totals.gross_pay, payroll.totals.deductions, payroll.totals.net_pay,
          JSON.stringify(cfg), sanitizeStr(req.body?.notes, 300), req.user?.username || 'owner',
        ]
      );
      for (const item of payroll.items) {
        await trx.run(
          `INSERT INTO {s}.payroll_items
             (period_id, employee_id, employee_name, pay_type, pay_rate, daily_rate, hourly_rate,
              worked_minutes, expected_minutes, overtime_minutes, double_overtime_minutes, triple_overtime_minutes,
              late_minutes, late_count, worked_days, absent_days, paid_leave_days, rest_days,
              base_pay, overtime_pay, premium_pay, other_earnings, absence_deduction, late_deduction,
              other_deductions, gross_pay, net_pay, detail_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [
            period.id, item.employee_id, item.employee_name, item.pay_type, item.pay_rate,
            item.daily_rate, item.hourly_rate, item.worked_minutes, item.expected_minutes,
            item.overtime_minutes, item.double_overtime_minutes, item.triple_overtime_minutes,
            item.late_minutes, item.late_count, item.worked_days, item.absent_days,
            item.paid_leave_days, item.rest_days, item.base_pay, item.overtime_pay,
            item.premium_pay, item.other_earnings, item.absence_deduction, item.late_deduction,
            item.other_deductions, item.gross_pay, item.net_pay,
            JSON.stringify({
              ...item.detail, branch_name: item.branch_name, emp_code: item.emp_code, position: item.position,
              department: item.department, hire_date: item.hire_date, scheduled_days: item.scheduled_days, calendar_days: item.calendar_days,
            }),
          ]
        );
        // Los adelantos de nómina pendientes se vuelven deducciones de este periodo.
        for (const advance of item.adjustments.filter((adjustment) => adjustment.advance_id)) {
          const adjustment = await trx.get(
            `INSERT INTO {s}.payroll_adjustments (period_id, employee_id, concept, kind, amount, notes, created_by)
             VALUES ($1,$2,$3,'deduction',$4,$5,$6) RETURNING id`,
            [period.id, item.employee_id, advance.concept, advance.amount, sanitizeStr(advance.notes, 200), req.user?.username || 'owner']
          );
          const claimed = await trx.run(
            'UPDATE {s}.payroll_advances SET period_id=$1, adjustment_id=$2 WHERE id=$3 AND period_id IS NULL',
            [period.id, adjustment.id, advance.advance_id]
          );
          if (!claimed.rowCount) throw Object.assign(new Error('Los adelantos de nómina cambiaron. Vuelve a calcular la nómina.'), { statusCode: 409 });
        }
      }
      return period.id;
    });

    res.json({ id: periodId, totals: payroll.totals });
  } catch (error) { next(error); }
});

router.get('/payroll/periods/:id', requireNumericId, async (req, res, next) => {
  try {
    const period = await req.tdb.get(
      `SELECT p.id, p.name, p.period_type, (p.start_date)::text AS start_date, (p.end_date)::text AS end_date,
              p.branch_id, p.status, p.total_gross::float AS total_gross, p.total_deductions::float AS total_deductions,
              p.total_net::float AS total_net, p.config_json, p.notes, p.created_by, p.created_at,
              p.approved_at, p.paid_at, b.name AS branch_name
       FROM {s}.payroll_periods p
       LEFT JOIN {s}.branches b ON b.id = p.branch_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (!period) return res.status(404).json({ error: 'Periodo de nómina no encontrado' });

    const items = await req.tdb.all(
      `SELECT i.*, i.pay_rate::float AS pay_rate, i.daily_rate::float AS daily_rate,
              i.hourly_rate::float AS hourly_rate, i.absent_days::float AS absent_days,
              i.paid_leave_days::float AS paid_leave_days, i.base_pay::float AS base_pay,
              i.overtime_pay::float AS overtime_pay, i.premium_pay::float AS premium_pay,
              i.other_earnings::float AS other_earnings, i.absence_deduction::float AS absence_deduction,
              i.late_deduction::float AS late_deduction, i.other_deductions::float AS other_deductions,
              i.gross_pay::float AS gross_pay, i.net_pay::float AS net_pay
       FROM {s}.payroll_items i WHERE i.period_id = $1 ORDER BY i.employee_name ASC`,
      [req.params.id]
    );
    const adjustments = await adjustmentsMap(req.tdb, Number(req.params.id));

    res.json({
      period: { ...period, config: normalizeConfig(period.config_json) },
      items: items.map((item) => ({
        ...item,
        detail: (() => { try { return JSON.parse(item.detail_json || '{}'); } catch { return {}; } })(),
        adjustments: adjustments.get(Number(item.employee_id)) || [],
      })),
    });
  } catch (error) { next(error); }
});

router.patch('/payroll/periods/:id/status', requireNumericId, async (req, res, next) => {
  try {
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!['draft', 'approved', 'paid'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido: draft | approved | paid' });
    }
    const result = await req.tdb.run(
      `UPDATE {s}.payroll_periods
       SET status=$1,
           approved_at = CASE WHEN $1 IN ('approved','paid') THEN COALESCE(approved_at, now()) ELSE NULL END,
           paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, now()) ELSE NULL END
       WHERE id=$2`,
      [status, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Periodo de nómina no encontrado' });
    res.json({ ok: true, status });
  } catch (error) { next(error); }
});

router.delete('/payroll/periods/:id', requireNumericId, async (req, res, next) => {
  try {
    const period = await req.tdb.get('SELECT status FROM {s}.payroll_periods WHERE id=$1', [req.params.id]);
    if (!period) return res.status(404).json({ error: 'Periodo de nómina no encontrado' });
    if (period.status === 'paid') return res.status(409).json({ error: 'No se puede eliminar una nómina ya pagada' });
    await req.tdb.tx(async (trx) => {
      await trx.run('UPDATE {s}.payroll_advances SET period_id=NULL, adjustment_id=NULL WHERE period_id=$1', [req.params.id]);
      await trx.run('DELETE FROM {s}.payroll_adjustments WHERE period_id=$1', [req.params.id]);
      await trx.run('DELETE FROM {s}.payroll_items WHERE period_id=$1', [req.params.id]);
      await trx.run('DELETE FROM {s}.payroll_periods WHERE id=$1', [req.params.id]);
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/**
 * Recalcula el recibo del empleado y los totales del periodo tras mover
 * percepciones o deducciones manuales.
 */
async function recalcPayroll(tenantDb, periodId, employeeId) {
  const sums = await tenantDb.get(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE kind='earning'),0)::float AS earnings,
            COALESCE(SUM(amount) FILTER (WHERE kind<>'earning'),0)::float AS deductions
     FROM {s}.payroll_adjustments WHERE period_id=$1 AND employee_id=$2`,
    [periodId, employeeId]
  );
  await tenantDb.run(
    `UPDATE {s}.payroll_items
     SET other_earnings = $1,
         other_deductions = $2,
         gross_pay = base_pay + overtime_pay + premium_pay + $1,
         net_pay = base_pay + overtime_pay + premium_pay + $1 - absence_deduction - late_deduction - $2
     WHERE period_id = $3 AND employee_id = $4`,
    [round2(sums.earnings), round2(sums.deductions), periodId, employeeId]
  );
  await tenantDb.run(
    `UPDATE {s}.payroll_periods p
     SET total_gross = t.gross, total_net = t.net,
         total_deductions = t.deductions
     FROM (
       SELECT COALESCE(SUM(gross_pay),0) AS gross, COALESCE(SUM(net_pay),0) AS net,
              COALESCE(SUM(absence_deduction + late_deduction + other_deductions),0) AS deductions
       FROM {s}.payroll_items WHERE period_id = $1
     ) t
     WHERE p.id = $1`,
    [periodId]
  );
}

router.post('/payroll/periods/:id/adjustments', requireNumericId, async (req, res, next) => {
  try {
    const periodId = Number(req.params.id);
    const period = await req.tdb.get('SELECT id, status FROM {s}.payroll_periods WHERE id=$1', [periodId]);
    if (!period) return res.status(404).json({ error: 'Periodo de nómina no encontrado' });
    if (period.status === 'paid') return res.status(409).json({ error: 'La nómina ya fue pagada y no admite cambios' });

    const employeeId = positiveInt(req.body?.employee_id);
    const concept = sanitizeStr(req.body?.concept, 120);
    const amount = Math.abs(safeNum(req.body?.amount, 0));
    if (!employeeId || !concept || !amount) {
      return res.status(400).json({ error: 'Indica empleado, concepto e importe' });
    }
    const item = await req.tdb.get('SELECT id FROM {s}.payroll_items WHERE period_id=$1 AND employee_id=$2', [periodId, employeeId]);
    if (!item) return res.status(404).json({ error: 'El empleado no forma parte de este periodo' });

    const kind = String(req.body?.kind || 'deduction').trim().toLowerCase() === 'earning' ? 'earning' : 'deduction';
    const row = await req.tdb.get(
      `INSERT INTO {s}.payroll_adjustments (period_id, employee_id, concept, kind, amount, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [periodId, employeeId, concept, kind, round2(amount), sanitizeStr(req.body?.notes, 200), req.user?.username || 'owner']
    );
    await recalcPayroll(req.tdb, periodId, employeeId);
    res.json({ id: row.id });
  } catch (error) { next(error); }
});

router.get('/payroll/advances', async (req, res, next) => {
  try {
    const status = ['pending', 'applied'].includes(req.query?.status) ? req.query.status : 'all';
    const employeeId = positiveInt(req.query?.employee_id);
    const params = [];
    const where = [];
    if (status === 'pending') where.push('a.period_id IS NULL');
    if (status === 'applied') where.push('a.period_id IS NOT NULL');
    if (employeeId) { params.push(employeeId); where.push(`a.employee_id = $${params.length}`); }
    const rows = await req.tdb.all(
      `SELECT a.id, a.employee_id, a.employee_name, a.amount::float AS amount, (a.advance_date)::text AS advance_date,
              a.branch_name, a.source, a.note, a.created_by, a.period_id, p.name AS period_name, p.status AS period_status
       FROM {s}.payroll_advances a
       LEFT JOIN {s}.payroll_periods p ON p.id = a.period_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (a.period_id IS NULL) DESC, a.advance_date DESC, a.id DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (error) { next(error); }
});

router.delete('/payroll/adjustments/:id', requireNumericId, async (req, res, next) => {
  try {
    const advance = await req.tdb.get(
      `SELECT p.status FROM {s}.payroll_advances a JOIN {s}.payroll_periods p ON p.id = a.period_id WHERE a.adjustment_id=$1`,
      [req.params.id]
    );
    if (advance?.status === 'paid') return res.status(409).json({ error: 'La nómina ya fue pagada y no admite cambios' });
    // Un adelanto cuyo descuento se quita vuelve a quedar pendiente para el siguiente periodo.
    await req.tdb.run('UPDATE {s}.payroll_advances SET period_id=NULL, adjustment_id=NULL WHERE adjustment_id=$1', [req.params.id]);
    const row = await req.tdb.get(
      'DELETE FROM {s}.payroll_adjustments WHERE id=$1 RETURNING period_id, employee_id',
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Movimiento no encontrado' });
    await recalcPayroll(req.tdb, Number(row.period_id), Number(row.employee_id));
    res.json({ ok: true });
  } catch (error) { next(error); }
});

module.exports = router;
