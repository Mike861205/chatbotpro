/**
 * Módulo: Productividad Empleados
 * Rutas: /api/employees
 * Alcance: multi-tenant, solo owner autenticado.
 */
const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

/* ─────────────────────────────────────────────
   Helpers
───────────────────────────────────────────── */
const AVATAR_COLORS = ['#6c47ff','#f59e0b','#10b981','#3b82f6','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316'];

function randColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function sanitizeStr(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function safeMonth(v) {
  const m = parseInt(v, 10);
  return m >= 1 && m <= 12 ? m : new Date().getMonth() + 1;
}

function safeYear(v) {
  const y = parseInt(v, 10);
  return y >= 2020 && y <= 2100 ? y : new Date().getFullYear();
}

function shiftPeriod(year, month, offset) {
  const d = new Date(year, month - 1 + offset, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

async function ensureProductivityHistoryInfra(req) {
  await req.tdb.run(
    `CREATE TABLE IF NOT EXISTS {s}.emp_productivity_history (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL,
      metric_id INTEGER NOT NULL,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      record_date DATE,
      value NUMERIC(12,2) DEFAULT 0,
      notes TEXT DEFAULT '',
      recorded_by TEXT DEFAULT '',
      input_source TEXT DEFAULT 'manual',
      created_at TIMESTAMPTZ DEFAULT now()
    )`
  );
  await req.tdb.run(
    'CREATE INDEX IF NOT EXISTS emp_prod_hist_lookup_idx ON {s}.emp_productivity_history(employee_id, metric_id, period_year, period_month, created_at DESC)'
  );
}

/* ═══════════════════════════════════════════
   EMPLOYEES CRUD
═══════════════════════════════════════════ */
router.get('/', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT id, name, position, department, hire_date, salary_base::float,
              phone, email, avatar_color, notes, active, created_at
       FROM {s}.employees ORDER BY name ASC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, position, department, hire_date, salary_base, phone, email, notes, avatar_color } = req.body || {};
    if (!sanitizeStr(name)) return res.status(400).json({ error: 'El nombre del empleado es obligatorio' });

    const row = await req.tdb.get(
      `INSERT INTO {s}.employees (name, position, department, hire_date, salary_base, phone, email, avatar_color, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        sanitizeStr(name, 120),
        sanitizeStr(position, 100),
        sanitizeStr(department, 100),
        hire_date || null,
        safeNum(salary_base),
        sanitizeStr(phone, 30),
        sanitizeStr(email, 100),
        sanitizeStr(avatar_color, 20) || randColor(),
        sanitizeStr(notes, 500),
      ]
    );
    res.json({ id: row.id });
  } catch (e) { next(e); }
});

router.get('/:id(\\d+)', async (req, res, next) => {
  try {
    const row = await req.tdb.get(
      `SELECT id, name, position, department, hire_date, salary_base::float,
              phone, email, avatar_color, notes, active
       FROM {s}.employees WHERE id = $1`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Empleado no encontrado' });
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/:id(\\d+)', async (req, res, next) => {
  try {
    const { name, position, department, hire_date, salary_base, phone, email, notes, avatar_color, active } = req.body || {};
    if (!sanitizeStr(name)) return res.status(400).json({ error: 'El nombre del empleado es obligatorio' });

    await req.tdb.run(
      `UPDATE {s}.employees SET name=$1, position=$2, department=$3, hire_date=$4,
              salary_base=$5, phone=$6, email=$7, avatar_color=$8, notes=$9, active=$10
       WHERE id=$11`,
      [
        sanitizeStr(name, 120),
        sanitizeStr(position, 100),
        sanitizeStr(department, 100),
        hire_date || null,
        safeNum(salary_base),
        sanitizeStr(phone, 30),
        sanitizeStr(email, 100),
        sanitizeStr(avatar_color, 20) || randColor(),
        sanitizeStr(notes, 500),
        active === 0 || active === '0' ? 0 : 1,
        req.params.id,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id(\\d+)', async (req, res, next) => {
  try {
    await req.tdb.run('UPDATE {s}.employees SET active=0 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════
   METRIC TYPES (configuración del tenant)
═══════════════════════════════════════════ */
router.get('/metrics', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT id, name, key, source, unit, target::float, weight::float,
              higher_is_better, active, sort, period_type, aggregation
       FROM {s}.emp_metric_types ORDER BY sort ASC, id ASC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/metrics', async (req, res, next) => {
  try {
    const { name, key, source, unit, target, weight, higher_is_better, period_type, aggregation } = req.body || {};
    if (!sanitizeStr(name)) return res.status(400).json({ error: 'El nombre de la métrica es obligatorio' });

    const rawKey = sanitizeStr(key || name, 50)
      .toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/__+/g, '_').slice(0, 40);
    const sourceOk = ['manual', 'system_sales', 'both'].includes(source) ? source : 'manual';
    const periodOk = ['monthly', 'biweekly', 'weekly', 'daily'].includes(period_type) ? period_type : 'monthly';
    const aggOk = ['sum', 'avg'].includes(aggregation) ? aggregation : 'sum';

    const row = await req.tdb.get(
      `INSERT INTO {s}.emp_metric_types (name, key, source, unit, target, weight, higher_is_better, period_type, aggregation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, source=EXCLUDED.source,
         unit=EXCLUDED.unit, target=EXCLUDED.target, weight=EXCLUDED.weight,
         higher_is_better=EXCLUDED.higher_is_better, period_type=EXCLUDED.period_type,
         aggregation=EXCLUDED.aggregation
       RETURNING id`,
      [
        sanitizeStr(name, 100), rawKey, sourceOk,
        sanitizeStr(unit, 20), safeNum(target, 100), safeNum(weight, 1),
        higher_is_better === false || higher_is_better === 0 || higher_is_better === '0' ? 0 : 1,
        periodOk, aggOk,
      ]
    );
    res.json({ id: row.id });
  } catch (e) { next(e); }
});

router.put('/metrics/:id(\\d+)', async (req, res, next) => {
  try {
    const { name, source, unit, target, weight, higher_is_better, active, sort, period_type, aggregation } = req.body || {};
    const sourceOk = ['manual', 'system_sales', 'both'].includes(source) ? source : 'manual';
    const periodOk = ['monthly', 'biweekly', 'weekly', 'daily'].includes(period_type) ? period_type : 'monthly';
    const aggOk = ['sum', 'avg'].includes(aggregation) ? aggregation : 'sum';

    await req.tdb.run(
      `UPDATE {s}.emp_metric_types SET name=$1, source=$2, unit=$3, target=$4,
              weight=$5, higher_is_better=$6, active=$7, sort=$8, period_type=$9, aggregation=$10
       WHERE id=$11`,
      [
        sanitizeStr(name, 100), sourceOk, sanitizeStr(unit, 20),
        safeNum(target, 100), safeNum(weight, 1),
        higher_is_better === false || higher_is_better === 0 || higher_is_better === '0' ? 0 : 1,
        active === 0 || active === '0' ? 0 : 1,
        safeNum(sort, 0), periodOk, aggOk, req.params.id,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/metrics/:id(\\d+)', async (req, res, next) => {
  try {
    await req.tdb.run('UPDATE {s}.emp_metric_types SET active=0 WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════
   COMMISSION SCHEMES
═══════════════════════════════════════════ */
router.get('/commission-schemes', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT id, name, type, config_json, description, active, created_at
       FROM {s}.emp_commission_schemes ORDER BY id ASC`
    );
    res.json(rows.map((r) => ({ ...r, config: JSON.parse(r.config_json || '{}') })));
  } catch (e) { next(e); }
});

router.post('/commission-schemes', async (req, res, next) => {
  try {
    const { name, type, config, description } = req.body || {};
    if (!sanitizeStr(name)) return res.status(400).json({ error: 'El nombre del esquema es obligatorio' });
    const typeOk = ['percentage', 'fixed', 'tiered', 'productivity_bonus'].includes(type) ? type : 'percentage';

    const row = await req.tdb.get(
      `INSERT INTO {s}.emp_commission_schemes (name, type, config_json, description)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [sanitizeStr(name, 120), typeOk, JSON.stringify(config || {}), sanitizeStr(description, 300)]
    );
    res.json({ id: row.id });
  } catch (e) { next(e); }
});

router.put('/commission-schemes/:id(\\d+)', async (req, res, next) => {
  try {
    const { name, type, config, description, active } = req.body || {};
    const typeOk = ['percentage', 'fixed', 'tiered', 'productivity_bonus'].includes(type) ? type : 'percentage';

    await req.tdb.run(
      `UPDATE {s}.emp_commission_schemes SET name=$1, type=$2, config_json=$3, description=$4, active=$5
       WHERE id=$6`,
      [
        sanitizeStr(name, 120),
        typeOk,
        JSON.stringify(config || {}),
        sanitizeStr(description, 300),
        active === 0 || active === '0' ? 0 : 1,
        req.params.id,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════
   COMMISSION ASSIGNMENTS
═══════════════════════════════════════════ */
router.get('/commission-assignments', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT ca.id, ca.employee_id, ca.scheme_id, ca.metric_id, ca.active,
              e.name AS employee_name, cs.name AS scheme_name, mt.name AS metric_name
       FROM {s}.emp_commission_assignments ca
       JOIN {s}.employees e ON e.id = ca.employee_id
       JOIN {s}.emp_commission_schemes cs ON cs.id = ca.scheme_id
       LEFT JOIN {s}.emp_metric_types mt ON mt.id = ca.metric_id
       ORDER BY e.name ASC`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/commission-assignments', async (req, res, next) => {
  try {
    const { employee_id, scheme_id, metric_id } = req.body || {};
    if (!employee_id || !scheme_id) return res.status(400).json({ error: 'employee_id y scheme_id son obligatorios' });

    const row = await req.tdb.get(
      `INSERT INTO {s}.emp_commission_assignments (employee_id, scheme_id, metric_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [employee_id, scheme_id, metric_id || null]
    );
    res.json({ id: row.id });
  } catch (e) { next(e); }
});

router.delete('/commission-assignments/:id(\\d+)', async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.emp_commission_assignments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════
   PRODUCTIVITY RECORDS
═══════════════════════════════════════════ */
router.get('/productivity', async (req, res, next) => {
  try {
    const { year, month, employee_id } = req.query;
    const y = safeYear(year);
    const m = safeMonth(month);

    const params = [y, m];
    let where = 'WHERE r.period_year=$1 AND r.period_month=$2';
    if (employee_id) {
      params.push(employee_id);
      where += ` AND r.employee_id=$${params.length}`;
    }

    const rows = await req.tdb.all(
      `SELECT r.id, r.employee_id, r.metric_id, r.period_year, r.period_month,
              r.value::float, r.notes, r.recorded_by, r.updated_at,
              e.name AS employee_name, mt.name AS metric_name,
              mt.unit, mt.target::float, mt.weight::float, mt.source, mt.higher_is_better
       FROM {s}.emp_productivity_records r
       JOIN {s}.employees e ON e.id = r.employee_id
       JOIN {s}.emp_metric_types mt ON mt.id = r.metric_id
       ${where}
       ORDER BY e.name ASC, mt.sort ASC`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/productivity', async (req, res, next) => {
  try {
    const { employee_id, metric_id, year, month, value, notes, record_date, input_source } = req.body || {};
    if (!employee_id || !metric_id) return res.status(400).json({ error: 'employee_id y metric_id son obligatorios' });

    await ensureProductivityHistoryInfra(req);

    const source = ['manual', 'sync_sales', 'pos_chatbot', 'system'].includes(String(input_source || ''))
      ? String(input_source)
      : 'manual';

    const metric = await req.tdb.get('SELECT period_type FROM {s}.emp_metric_types WHERE id=$1', [metric_id]);
    const isMonthly = !metric || metric.period_type === 'monthly';

    if (isMonthly) {
      const y = safeYear(year);
      const m = safeMonth(month);
      const row = await req.tdb.get(
        `INSERT INTO {s}.emp_productivity_records (employee_id, metric_id, period_year, period_month, value, notes, recorded_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (employee_id, metric_id, period_year, period_month) WHERE record_date IS NULL
         DO UPDATE SET value=EXCLUDED.value, notes=EXCLUDED.notes, recorded_by=EXCLUDED.recorded_by, updated_at=now()
         RETURNING id`,
        [employee_id, metric_id, y, m, safeNum(value), sanitizeStr(notes, 300), req.user?.username || 'owner']
      );

      await req.tdb.run(
        `INSERT INTO {s}.emp_productivity_history
           (employee_id, metric_id, period_year, period_month, record_date, value, notes, recorded_by, input_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [employee_id, metric_id, y, m, null, safeNum(value), sanitizeStr(notes, 300), req.user?.username || 'owner', source]
      );

      res.json({ id: row.id });
    } else {
      // Sub-mensual: requiere fecha exacta
      const validDate = record_date && /^\d{4}-\d{2}-\d{2}$/.test(record_date) ? record_date : null;
      if (!validDate) return res.status(400).json({ error: 'record_date (YYYY-MM-DD) es obligatorio para métricas de registro sub-mensual' });
      const parts = validDate.split('-');
      const y2 = parseInt(parts[0], 10);
      const m2 = parseInt(parts[1], 10);
      const row = await req.tdb.get(
        `INSERT INTO {s}.emp_productivity_records (employee_id, metric_id, period_year, period_month, record_date, value, notes, recorded_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (employee_id, metric_id, record_date) WHERE record_date IS NOT NULL
         DO UPDATE SET value=EXCLUDED.value, notes=EXCLUDED.notes, recorded_by=EXCLUDED.recorded_by, updated_at=now()
         RETURNING id`,
        [employee_id, metric_id, y2, m2, validDate, safeNum(value), sanitizeStr(notes, 300), req.user?.username || 'owner']
      );

      await req.tdb.run(
        `INSERT INTO {s}.emp_productivity_history
           (employee_id, metric_id, period_year, period_month, record_date, value, notes, recorded_by, input_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [employee_id, metric_id, y2, m2, validDate, safeNum(value), sanitizeStr(notes, 300), req.user?.username || 'owner', source]
      );

      res.json({ id: row.id });
    }
  } catch (e) { next(e); }
});

/* Historial de registros de una métrica para un empleado */
router.get('/productivity/history', async (req, res, next) => {
  try {
    const { employee_id, metric_id, year, month } = req.query;
    if (!employee_id || !metric_id) return res.status(400).json({ error: 'employee_id y metric_id son obligatorios' });
    const y = safeYear(year);
    const m = safeMonth(month);

    await ensureProductivityHistoryInfra(req);

    const rows = await req.tdb.all(
      `SELECT id, value::float, notes, record_date, recorded_by, input_source, created_at
       FROM {s}.emp_productivity_history
       WHERE employee_id=$1 AND metric_id=$2 AND period_year=$3 AND period_month=$4
       ORDER BY created_at DESC`,
      [employee_id, metric_id, y, m]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.get('/productivity/insights', async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const y = safeYear(year);
    const m = safeMonth(month);

    await ensureProductivityHistoryInfra(req);

    const p1 = shiftPeriod(y, m, -1);
    const p2 = shiftPeriod(y, m, -2);

    const employees = await req.tdb.all('SELECT id, name FROM {s}.employees WHERE active=1 ORDER BY name ASC');
    const metrics = await req.tdb.all(
      `SELECT id, name, unit, target::float, higher_is_better, aggregation
       FROM {s}.emp_metric_types
       WHERE active=1
       ORDER BY sort ASC, id ASC`
    );

    const rows = await req.tdb.all(
      `SELECT r.employee_id, r.metric_id, r.period_year, r.period_month,
              CASE WHEN COALESCE(mt.aggregation,'sum')='avg'
                THEN AVG(r.value)::float
                ELSE SUM(r.value)::float
              END AS agg_value
       FROM {s}.emp_productivity_records r
       JOIN {s}.emp_metric_types mt ON mt.id = r.metric_id
       WHERE (r.period_year=$1 AND r.period_month=$2)
          OR (r.period_year=$3 AND r.period_month=$4)
          OR (r.period_year=$5 AND r.period_month=$6)
       GROUP BY r.employee_id, r.metric_id, r.period_year, r.period_month`,
      [y, m, p1.year, p1.month, p2.year, p2.month]
    );

    const histRows = await req.tdb.all(
      `SELECT employee_id, metric_id, value::float, created_at,
              ROW_NUMBER() OVER (PARTITION BY employee_id, metric_id ORDER BY created_at DESC) AS rn
       FROM {s}.emp_productivity_history
       WHERE period_year=$1 AND period_month=$2`,
      [y, m]
    );

    const monthKey = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
    const valMap = {};
    for (const r of rows) {
      const k = `${r.employee_id}_${r.metric_id}_${monthKey(r.period_year, r.period_month)}`;
      valMap[k] = Number(r.agg_value);
    }

    const histMap = {};
    for (const hr of histRows) {
      const k = `${hr.employee_id}_${hr.metric_id}`;
      if (!histMap[k]) histMap[k] = {};
      if (Number(hr.rn) === 1) histMap[k].latest = Number(hr.value);
      if (Number(hr.rn) === 2) histMap[k].previous = Number(hr.value);
    }

    const insights = [];
    const summaryByEmployee = {};
    const kCurrent = monthKey(y, m);
    const kPrev = monthKey(p1.year, p1.month);
    const kPrev2 = monthKey(p2.year, p2.month);

    for (const emp of employees) {
      let improved = 0;
      let declined = 0;
      let stable = 0;

      for (const mt of metrics) {
        const hm = histMap[`${emp.id}_${mt.id}`] || {};
        const current = valMap[`${emp.id}_${mt.id}_${kCurrent}`];
        const previous = valMap[`${emp.id}_${mt.id}_${kPrev}`];
        const prev2 = valMap[`${emp.id}_${mt.id}_${kPrev2}`];

        const currentForTrend = Number.isFinite(hm.latest) ? hm.latest : current;

        let baseline = null;
        let trendScope = 'month';
        if (Number.isFinite(hm.previous)) {
          baseline = hm.previous;
          trendScope = 'capture';
        } else if (Number.isFinite(previous)) {
          baseline = previous;
        } else if (Number.isFinite(prev2)) {
          baseline = prev2;
        }

        const avgValues = [currentForTrend, baseline, prev2].filter((v) => Number.isFinite(v));
        const avgRecent = avgValues.length ? (avgValues.reduce((s, v) => s + v, 0) / avgValues.length) : null;

        const delta = Number.isFinite(currentForTrend) && Number.isFinite(baseline) ? currentForTrend - baseline : null;
        const deltaPct = Number.isFinite(delta) && Number.isFinite(baseline) && baseline !== 0
          ? (delta / baseline) * 100
          : null;

        let trend = 'none';
        let improvement_state = 'none';
        if (Number.isFinite(delta)) {
          const threshold = Math.max(Math.abs(baseline || 0) * 0.03, 0.01);
          if (Math.abs(delta) <= threshold) {
            trend = 'stable';
            improvement_state = 'stable';
            stable += 1;
          } else {
            const higherIsBetter = mt.higher_is_better !== 0;
            const improvedNow = higherIsBetter ? delta > 0 : delta < 0;
            trend = improvedNow ? 'up' : 'down';
            improvement_state = improvedNow ? 'improved' : 'declined';
            if (improvedNow) improved += 1;
            else declined += 1;
          }
        }

        insights.push({
          employee_id: emp.id,
          employee_name: emp.name,
          metric_id: mt.id,
          metric_name: mt.name,
          unit: mt.unit,
          target: Number(mt.target || 0),
          higher_is_better: mt.higher_is_better !== 0,
          current_value: Number.isFinite(currentForTrend) ? currentForTrend : null,
          previous_value: Number.isFinite(baseline) ? baseline : null,
          avg_recent: Number.isFinite(avgRecent) ? Math.round(avgRecent * 100) / 100 : null,
          delta_value: Number.isFinite(delta) ? Math.round(delta * 100) / 100 : null,
          delta_pct: Number.isFinite(deltaPct) ? Math.round(deltaPct * 100) / 100 : null,
          trend,
          improvement_state,
          trend_scope: trendScope,
        });
      }

      summaryByEmployee[emp.id] = { employee_id: emp.id, employee_name: emp.name, improved, declined, stable };
    }

    res.json({
      period: {
        year: y,
        month: m,
        previous_year: p1.year,
        previous_month: p1.month,
      },
      insights,
      employee_summary: Object.values(summaryByEmployee),
    });
  } catch (e) { next(e); }
});

/* Sincronizar ventas del sistema para una métrica tipo system_sales/both */
router.post('/productivity/sync-sales', async (req, res, next) => {
  try {
    const { metric_id, year, month } = req.body || {};
    if (!metric_id) return res.status(400).json({ error: 'metric_id es obligatorio' });

    const y = safeYear(year);
    const m = safeMonth(month);

    const metric = await req.tdb.get('SELECT * FROM {s}.emp_metric_types WHERE id=$1', [metric_id]);
    if (!metric) return res.status(404).json({ error: 'Métrica no encontrada' });
    if (!['system_sales', 'both'].includes(metric.source)) {
      return res.status(400).json({ error: 'Esta métrica no usa ventas del sistema' });
    }

    // Sumar todas las ventas NO canceladas del periodo (chatbot + POS)
    const totals = await req.tdb.get(
      `SELECT
         COALESCE(SUM(total),0)::float AS total,
         COUNT(*)::int AS order_count
       FROM {s}.orders
       WHERE status NOT IN ('cancelado')
         AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'America/Mexico_City') = $1
         AND EXTRACT(MONTH FROM created_at AT TIME ZONE 'America/Mexico_City') = $2`,
      [y, m]
    );

    res.json({
      total_sales: totals.total,
      order_count: totals.order_count,
      year: y,
      month: m,
    });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════
   COMMISSION RECORDS (cálculo y estado)
═══════════════════════════════════════════ */
router.get('/commission-records', async (req, res, next) => {
  try {
    const { year, month, employee_id } = req.query;
    const y = safeYear(year);
    const m = safeMonth(month);

    const params = [y, m];
    let where = 'WHERE cr.period_year=$1 AND cr.period_month=$2';
    if (employee_id) {
      params.push(employee_id);
      where += ` AND cr.employee_id=$${params.length}`;
    }

    const rows = await req.tdb.all(
      `SELECT cr.id, cr.employee_id, cr.scheme_id, cr.period_year, cr.period_month,
              cr.base_value::float, cr.commission_amount::float, cr.productivity_index::float,
              cr.status, cr.notes, cr.calculated_at,
              e.name AS employee_name, cs.name AS scheme_name
       FROM {s}.emp_commission_records cr
       JOIN {s}.employees e ON e.id = cr.employee_id
       LEFT JOIN {s}.emp_commission_schemes cs ON cs.id = cr.scheme_id
       ${where}
       ORDER BY e.name ASC`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/commission-records/calculate', async (req, res, next) => {
  try {
    const { year, month } = req.body || {};
    const y = safeYear(year);
    const m = safeMonth(month);

    // Limpiar cálculos previos del periodo antes de recalcular
    await req.tdb.run(
      'DELETE FROM {s}.emp_commission_records WHERE period_year=$1 AND period_month=$2',
      [y, m]
    );

    const employees = await req.tdb.all('SELECT * FROM {s}.employees WHERE active=1');
    const metrics = await req.tdb.all('SELECT * FROM {s}.emp_metric_types WHERE active=1');
    const schemes = await req.tdb.all('SELECT * FROM {s}.emp_commission_schemes WHERE active=1');
    const assignments = await req.tdb.all('SELECT * FROM {s}.emp_commission_assignments WHERE active=1');
    const records = await req.tdb.all(
      'SELECT * FROM {s}.emp_productivity_records WHERE period_year=$1 AND period_month=$2',
      [y, m]
    );

    // Pre-agrupar y agregar registros por empleado+métrica (soporte para registros sub-mensuales)
    const recGroups = {};
    for (const r of records) {
      const key = `${r.employee_id}_${r.metric_id}`;
      if (!recGroups[key]) recGroups[key] = [];
      recGroups[key].push(Number(r.value));
    }
    const metricAggMap = {};
    metrics.forEach((mt) => { metricAggMap[mt.id] = mt.aggregation || 'sum'; });

    function getAggValue(empId, metricId) {
      const key = `${empId}_${metricId}`;
      const vals = recGroups[key];
      if (!vals || vals.length === 0) return 0;
      if (metricAggMap[metricId] === 'avg') return vals.reduce((s, v) => s + v, 0) / vals.length;
      return vals.reduce((s, v) => s + v, 0); // sum
    }

    const results = [];

    for (const emp of employees) {
      let totalWeight = 0;
      let weightedScore = 0;

      for (const metric of metrics) {
        const val = getAggValue(emp.id, metric.id);
        const target = Number(metric.target) || 1;
        const weight = Number(metric.weight) || 1;
        const higher = metric.higher_is_better !== 0;

        let score;
        if (higher) {
          score = Math.min(100, (val / target) * 100);
        } else {
          score = Math.max(0, 100 - (val / target) * 100);
        }

        totalWeight += weight;
        weightedScore += score * weight;
      }

      const productivityIndex = totalWeight > 0 ? weightedScore / totalWeight : 0;
      const empAssignments = assignments.filter((a) => a.employee_id === emp.id);

      if (empAssignments.length === 0) {
        // Sin esquema asignado: guardar solo el índice de productividad
        await req.tdb.run(
          `INSERT INTO {s}.emp_commission_records
             (employee_id, scheme_id, period_year, period_month, base_value, commission_amount, productivity_index, status, calculated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [emp.id, null, y, m, 0, 0, Math.round(productivityIndex * 100) / 100, req.user?.username || 'system']
        );
        results.push({ employee_id: emp.id, employee_name: emp.name, productivity_index: productivityIndex, commission_amount: 0 });
        continue;
      }

      for (const assignment of empAssignments) {
        const scheme = schemes.find((s) => s.id === assignment.scheme_id);
        if (!scheme) continue;

        const config = JSON.parse(scheme.config_json || '{}');
        let baseValue = 0;
        let commissionAmount = 0;

        if (assignment.metric_id) {
          baseValue = getAggValue(emp.id, assignment.metric_id);
        } else {
          baseValue = productivityIndex;
        }

        switch (scheme.type) {
          case 'percentage':
            commissionAmount = baseValue * (Number(config.percentage || 0) / 100);
            break;
          case 'fixed':
            commissionAmount = productivityIndex >= (Number(config.min_productivity || 0))
              ? Number(config.fixed_amount || 0)
              : 0;
            break;
          case 'tiered': {
            const tiers = Array.isArray(config.tiers) ? config.tiers : [];
            for (const tier of tiers) {
              if (baseValue >= (tier.min || 0) && baseValue <= (tier.max !== undefined ? tier.max : Infinity)) {
                commissionAmount = baseValue * (Number(tier.percentage || 0) / 100);
                break;
              }
            }
            break;
          }
          case 'productivity_bonus':
            commissionAmount = productivityIndex >= (Number(config.min_index || 0))
              ? Number(config.bonus_amount || 0) * (productivityIndex / 100)
              : 0;
            break;
        }

        await req.tdb.run(
          `INSERT INTO {s}.emp_commission_records
             (employee_id, scheme_id, period_year, period_month, base_value, commission_amount, productivity_index, status, calculated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [
            emp.id, scheme.id, y, m,
            Math.round(baseValue * 100) / 100,
            Math.round(commissionAmount * 100) / 100,
            Math.round(productivityIndex * 100) / 100,
            req.user?.username || 'system',
          ]
        );

        results.push({
          employee_id: emp.id,
          employee_name: emp.name,
          scheme_name: scheme.name,
          productivity_index: Math.round(productivityIndex * 100) / 100,
          base_value: Math.round(baseValue * 100) / 100,
          commission_amount: Math.round(commissionAmount * 100) / 100,
        });
      }
    }

    res.json({ results, year: y, month: m });
  } catch (e) { next(e); }
});

router.patch('/commission-records/:id(\\d+)/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['pending', 'approved', 'paid'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido: pending | approved | paid' });
    }
    await req.tdb.run('UPDATE {s}.emp_commission_records SET status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ═══════════════════════════════════════════
   REPORTS
═══════════════════════════════════════════ */

// Reporte individual de un empleado
router.get('/reports/individual/:id(\\d+)', async (req, res, next) => {
  try {
    const { year } = req.query;
    const y = safeYear(year);
    const empId = req.params.id;

    const emp = await req.tdb.get('SELECT * FROM {s}.employees WHERE id=$1', [empId]);
    if (!emp) return res.status(404).json({ error: 'Empleado no encontrado' });

    // Registros por mes del año
    const records = await req.tdb.all(
      `SELECT r.period_month, r.value::float, r.notes,
              mt.name AS metric_name, mt.unit, mt.target::float, mt.weight::float, mt.higher_is_better
       FROM {s}.emp_productivity_records r
       JOIN {s}.emp_metric_types mt ON mt.id = r.metric_id
       WHERE r.employee_id=$1 AND r.period_year=$2
       ORDER BY r.period_month ASC, mt.sort ASC`,
      [empId, y]
    );

    const commissions = await req.tdb.all(
      `SELECT cr.period_month, cr.commission_amount::float, cr.productivity_index::float,
              cr.base_value::float, cr.status, cs.name AS scheme_name
       FROM {s}.emp_commission_records cr
       LEFT JOIN {s}.emp_commission_schemes cs ON cs.id = cr.scheme_id
       WHERE cr.employee_id=$1 AND cr.period_year=$2
       ORDER BY cr.period_month ASC`,
      [empId, y]
    );

    // Serie mensual: índice de productividad por mes
    const monthlyIndex = Array.from({ length: 12 }, (_, i) => {
      const month = i + 1;
      const monthComm = commissions.find((c) => c.period_month === month);
      return {
        month,
        productivity_index: monthComm ? monthComm.productivity_index : null,
        commission_amount: monthComm ? monthComm.commission_amount : 0,
        status: monthComm ? monthComm.status : null,
      };
    });

    res.json({
      employee: { id: emp.id, name: emp.name, position: emp.position, department: emp.department, salary_base: Number(emp.salary_base || 0) },
      year: y,
      records,
      commissions,
      monthly_series: monthlyIndex,
    });
  } catch (e) { next(e); }
});

// Reporte de equipo por mes
router.get('/reports/team', async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const y = safeYear(year);
    const m = safeMonth(month);

    const employees = await req.tdb.all('SELECT id, name, position, department, avatar_color FROM {s}.employees WHERE active=1 ORDER BY name ASC');
    const metrics = await req.tdb.all('SELECT * FROM {s}.emp_metric_types WHERE active=1 ORDER BY sort ASC');

    const records = await req.tdb.all(
      `SELECT r.employee_id, r.metric_id, r.value::float, mt.name AS metric_name,
              mt.unit, mt.target::float, mt.weight::float, mt.higher_is_better
       FROM {s}.emp_productivity_records r
       JOIN {s}.emp_metric_types mt ON mt.id = r.metric_id
       WHERE r.period_year=$1 AND r.period_month=$2`,
      [y, m]
    );

    const commissions = await req.tdb.all(
      `SELECT cr.employee_id, cr.commission_amount::float, cr.productivity_index::float, cr.status
       FROM {s}.emp_commission_records cr
       WHERE cr.period_year=$1 AND cr.period_month=$2`,
      [y, m]
    );

    // Construir resumen por empleado
    const summary = employees.map((emp) => {
      const empRecords = records.filter((r) => r.employee_id === emp.id);
      const empComm = commissions.filter((c) => c.employee_id === emp.id);
      const prodIndex = empComm.length ? empComm[0].productivity_index : null;
      const totalComm = empComm.reduce((s, c) => s + (c.commission_amount || 0), 0);

      const metricValues = metrics.map((mt) => {
        const rec = empRecords.find((r) => r.metric_id === mt.id);
        return { metric_id: mt.id, metric_name: mt.name, unit: mt.unit, target: Number(mt.target), value: rec ? rec.value : null };
      });

      return {
        employee: emp,
        productivity_index: prodIndex,
        total_commission: Math.round(totalComm * 100) / 100,
        metrics: metricValues,
      };
    });

    // Serie histórica de productividad promedio del equipo por mes
    const teamHistory = await req.tdb.all(
      `SELECT cr.period_month, AVG(cr.productivity_index)::float AS avg_index
       FROM {s}.emp_commission_records cr
       WHERE cr.period_year=$1
       GROUP BY cr.period_month ORDER BY cr.period_month ASC`,
      [y]
    );

    res.json({ year: y, month: m, summary, team_history: teamHistory, metrics });
  } catch (e) { next(e); }
});

// Stats rápidas para el dashboard del módulo
router.get('/reports/quick-stats', async (req, res, next) => {
  try {
    const { year, month } = req.query;
    const y = safeYear(year);
    const m = safeMonth(month);

    const totalEmp = await req.tdb.get('SELECT COUNT(*)::int AS total FROM {s}.employees WHERE active=1');
    const commStats = await req.tdb.get(
      `SELECT AVG(cr.productivity_index)::float AS avg_index,
              SUM(cr.commission_amount)::float AS total_commissions,
              COUNT(DISTINCT cr.employee_id)::int AS evaluated_count
       FROM {s}.emp_commission_records cr
       WHERE cr.period_year=$1 AND cr.period_month=$2`,
      [y, m]
    );

    const topPerformer = await req.tdb.get(
      `SELECT e.name, AVG(cr.productivity_index)::float AS avg_index
       FROM {s}.emp_commission_records cr
       JOIN {s}.employees e ON e.id = cr.employee_id
       WHERE cr.period_year=$1 AND cr.period_month=$2
       GROUP BY e.id, e.name ORDER BY avg_index DESC LIMIT 1`,
      [y, m]
    );

    res.json({
      total_employees: totalEmp?.total || 0,
      avg_productivity_index: commStats?.avg_index || 0,
      total_commissions: commStats?.total_commissions || 0,
      evaluated_count: commStats?.evaluated_count || 0,
      top_performer: topPerformer || null,
    });
  } catch (e) { next(e); }
});

module.exports = router;
