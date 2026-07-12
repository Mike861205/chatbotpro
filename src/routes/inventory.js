const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

/* ─── helpers ─── */
function n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : 0;
}

function safe(v, max = 300) {
  return String(v || '').trim().slice(0, max);
}

function normalizeIsoDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

function parsePeriodRange(query) {
  const safeQuery = query && typeof query === 'object' ? query : {};
  const periodRaw = String(safeQuery.period || '').trim().toLowerCase();
  const period = ['today', 'week', 'month', 'custom'].includes(periodRaw) ? periodRaw : 'all';
  if (period === 'all') return { period, from: null, to: null };

  if (period === 'custom') {
    const start = normalizeIsoDate(safeQuery.startDate);
    const end = normalizeIsoDate(safeQuery.endDate);
    if (!start || !end) return { period: 'all', from: null, to: null };
    return {
      period,
      from: `${start}T00:00:00-06:00`,
      to: `${end}T23:59:59.999-06:00`,
    };
  }

  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${m}-${d}`;
  if (period === 'today') {
    return { period, from: `${today}T00:00:00-06:00`, to: `${today}T23:59:59.999-06:00` };
  }

  if (period === 'week') {
    const jsDay = now.getDay();
    const mondayOffset = jsDay === 0 ? -6 : (1 - jsDay);
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const mY = monday.getFullYear();
    const mM = String(monday.getMonth() + 1).padStart(2, '0');
    const mD = String(monday.getDate()).padStart(2, '0');
    const sY = sunday.getFullYear();
    const sM = String(sunday.getMonth() + 1).padStart(2, '0');
    const sD = String(sunday.getDate()).padStart(2, '0');
    return {
      period,
      from: `${mY}-${mM}-${mD}T00:00:00-06:00`,
      to: `${sY}-${sM}-${sD}T23:59:59.999-06:00`,
    };
  }

  const first = `${y}-${m}-01`;
  const lastDate = new Date(y, now.getMonth() + 1, 0).getDate();
  const last = `${y}-${m}-${String(lastDate).padStart(2, '0')}`;
  return { period, from: `${first}T00:00:00-06:00`, to: `${last}T23:59:59.999-06:00` };
}

const EMPTY_RANGE = Object.freeze({ from: null, to: null });

/**
 * Parse orders.items JSON and accumulate qty-per-product_id.
 * Only counts non-cancelled orders; since chatbot→POS import just updates
 * the same row (channel changes to 'pos'), there is no duplication.
 */
async function buildSalesMap(t, range, baselineMap) {
  const safeRange = range && typeof range === 'object' ? range : EMPTY_RANGE;
  let sql = `SELECT items FROM {s}.orders WHERE status != 'cancelado'`;
  if (baselineMap) {
    sql = `SELECT items, created_at FROM {s}.orders WHERE status != 'cancelado'`;
  }
  let params = [];
  if (safeRange.from && safeRange.to) {
    sql += ` AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz`;
    params = [safeRange.from, safeRange.to];
  }
  const orders = await t.all(sql, params);
  const map = new Map();
  for (const o of orders) {
    const orderCreatedAt = o.created_at ? new Date(o.created_at) : null;
    let items;
    try { items = JSON.parse(o.items || '[]'); } catch { continue; }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const pid = Number(it.id || it.product_id || 0);
      if (!pid) continue;
      if (baselineMap && orderCreatedAt) {
        const baseAt = baselineMap.get(pid);
        if (baseAt && orderCreatedAt < baseAt) continue;
      }
      const qty = n(it.qty || it.quantity || 0);
      map.set(pid, (map.get(pid) || 0) + qty);
    }
  }
  return map;
}

function buildMovementMap(movements, baselineMap = null) {
  const map = new Map();
  for (const m of movements) {
    const pid = m.product_id;
    if (baselineMap) {
      const baseAt = baselineMap.get(pid);
      const moveAt = m.created_at ? new Date(m.created_at) : null;
      if (baseAt && moveAt && moveAt < baseAt) continue;
    }
    if (!map.has(pid)) map.set(pid, { entradas: 0, mermas: 0 });
    if (m.type === 'entrada') map.get(pid).entradas += n(m.quantity);
    else map.get(pid).mermas += n(m.quantity);
  }
  return map;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function getInventoryGlobalBaseline(t) {
  const row = await t.get('SELECT value FROM {s}.settings WHERE key = $1', ['inventory_global_baseline_started_at']);
  return parseDateOrNull(row?.value);
}

function ensureBaselineMapForProducts(products, baselineMap, globalBaseline) {
  if (!globalBaseline) return baselineMap;
  for (const p of products) {
    const pid = Number(p?.id || 0);
    if (!pid) continue;
    if (!baselineMap.has(pid)) baselineMap.set(pid, globalBaseline);
  }
  return baselineMap;
}

function calcRow(product, invItem, mots, salesMap, lastCount) {
  const initial = n(invItem?.initial_stock || 0);
  const entradas = n(mots?.entradas || 0);
  const mermas = n(mots?.mermas || 0);
  const ventas = n(salesMap.get(product.id) || 0);
  const fisico_sistema = Number((initial + entradas - mermas - ventas).toFixed(4));
  const fisico_real = lastCount ? n(lastCount.physical_qty) : null;
  const diferencia = fisico_real !== null ? Number((fisico_real - fisico_sistema).toFixed(4)) : null;
  return {
    product_id: product.id,
    product_name: product.name,
    unit: invItem?.unit || 'pcs',
    initial_stock: initial,
    entradas,
    mermas,
    ventas,
    fisico_sistema,
    fisico_real,
    diferencia,
    last_count_at: lastCount?.counted_at || null,
    inventory_item_id: invItem?.id || null,
  };
}

/* ─── GET / — resumen completo de inventario ─── */
router.get('/', async (req, res, next) => {
  try {
    const t = req.tdb;
    const range = parsePeriodRange(req.query);
    let movQuery = `SELECT * FROM {s}.inventory_movements WHERE 1=1`;
    let movParams = [];
    if (range.from && range.to) {
      movQuery += ` AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz`;
      movParams = [range.from, range.to];
    }
    movQuery += ` ORDER BY created_at DESC`;
    const [products, items, movements, counts, globalBaseline] = await Promise.all([
      t.all(`SELECT id, name FROM {s}.products WHERE active = 1 ORDER BY name`),
      t.all(`SELECT * FROM {s}.inventory_items`),
      t.all(movQuery, movParams),
      t.all(
        `SELECT DISTINCT ON (product_id) id, product_id, physical_qty, notes, counted_by, counted_at
         FROM {s}.inventory_counts ORDER BY product_id, counted_at DESC`
      ),
      getInventoryGlobalBaseline(t),
    ]);

    const baselineMap = new Map();
    if (range.period === 'all') {
      for (const item of items) {
        if (!item?.product_id || !item?.baseline_started_at) continue;
        baselineMap.set(Number(item.product_id), new Date(item.baseline_started_at));
      }
      ensureBaselineMapForProducts(products, baselineMap, globalBaseline);
    }

    const salesMap = await buildSalesMap(t, range, range.period === 'all' ? baselineMap : null);
    const itemMap = new Map(items.map((i) => [i.product_id, i]));
    const countMap = new Map(counts.map((c) => [c.product_id, c]));
    const movMap = buildMovementMap(movements, range.period === 'all' ? baselineMap : null);

    const rows = products.map((p) =>
      calcRow(p, itemMap.get(p.id), movMap.get(p.id), salesMap, countMap.get(p.id))
    );
    res.json({
      rows,
      period: {
        key: range.period,
        startDate: range.from,
        endDate: range.to,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /apply-real-to-initial — pasar físico real a inventario inicial ─── */
router.post('/apply-real-to-initial', async (req, res, next) => {
  try {
    const t = req.tdb;
    const shouldLogAdjustment = Boolean(req.body?.logAdjustment);
    const closureNote = safe(req.body?.closure_note || '', 220);
    const closureRange = parsePeriodRange(req.body || {});
    const pid = Number(req.body?.product_id || 0);

    async function writeClosureLog(productId, previousInitial, appliedPhysical) {
      if (!shouldLogAdjustment) return;
      const prev = n(previousInitial);
      const applied = n(appliedPhysical);
      const delta = Number((applied - prev).toFixed(4));
      await t.run(
        `INSERT INTO {s}.inventory_closure_logs (
          product_id, previous_initial_stock, applied_physical_qty, delta_qty,
          period_key, period_start_date, period_end_date,
          closure_note, applied_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          Number(productId),
          prev,
          applied,
          delta,
          closureRange.period || 'all',
          closureRange.from || '',
          closureRange.to || '',
          closureNote,
          req.user?.username || '',
        ]
      );
    }

    if (pid) {
      const latest = await t.get(
        `SELECT product_id, physical_qty::float AS physical_qty
         FROM {s}.inventory_counts
         WHERE product_id = $1
         ORDER BY counted_at DESC
         LIMIT 1`,
        [pid]
      );
      if (!latest) return res.status(400).json({ error: 'Ese producto no tiene conteo físico registrado' });
      const prevItem = await t.get('SELECT initial_stock::float AS initial_stock FROM {s}.inventory_items WHERE product_id = $1', [pid]);
      const prevInitial = prevItem?.initial_stock || 0;
      await t.run(
        `INSERT INTO {s}.inventory_items (product_id, initial_stock, unit, notes, updated_at)
         VALUES ($1, $2, 'pcs', '', now())
         ON CONFLICT (product_id)
         DO UPDATE SET initial_stock = EXCLUDED.initial_stock, baseline_started_at = now(), updated_at = now()`,
        [pid, n(latest.physical_qty)]
      );
      await writeClosureLog(pid, prevInitial, latest.physical_qty);
      return res.json({ ok: true, updated: 1, logged: shouldLogAdjustment ? 1 : 0 });
    }

    const latestCounts = await t.all(
      `SELECT DISTINCT ON (product_id) product_id, physical_qty::float AS physical_qty
       FROM {s}.inventory_counts
       ORDER BY product_id, counted_at DESC`
    );
    if (!latestCounts.length) {
      return res.status(400).json({ error: 'No hay conteos físicos para aplicar' });
    }

    const existingItems = await t.all('SELECT product_id, initial_stock::float AS initial_stock FROM {s}.inventory_items');
    const initialMap = new Map(existingItems.map((it) => [Number(it.product_id), n(it.initial_stock || 0)]));

    let logged = 0;
    const baselineNow = new Date().toISOString();

    for (const row of latestCounts) {
      const productId = Number(row.product_id);
      const prevInitial = initialMap.get(productId) || 0;
      await t.run(
        `INSERT INTO {s}.inventory_items (product_id, initial_stock, unit, notes, updated_at)
         VALUES ($1, $2, 'pcs', '', now())
         ON CONFLICT (product_id)
         DO UPDATE SET initial_stock = EXCLUDED.initial_stock, baseline_started_at = now(), updated_at = now()`,
        [productId, n(row.physical_qty)]
      );
      if (shouldLogAdjustment) {
        await writeClosureLog(productId, prevInitial, row.physical_qty);
        logged += 1;
      }
    }

    await t.run(
      `INSERT INTO {s}.settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['inventory_global_baseline_started_at', baselineNow]
    );

    res.json({ ok: true, updated: latestCounts.length, logged });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /items — crear o actualizar inventario inicial ─── */
router.post('/items', async (req, res, next) => {
  try {
    const { product_id, initial_stock, unit, notes } = req.body || {};
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: 'product_id requerido' });
    const stock = Math.max(0, n(initial_stock));
    const t = req.tdb;
    const existing = await t.get(`SELECT id FROM {s}.inventory_items WHERE product_id = $1`, [pid]);
    if (existing) {
      await t.run(
        `UPDATE {s}.inventory_items SET initial_stock=$1, unit=$2, notes=$3, updated_at=now() WHERE product_id=$4`,
        [stock, safe(unit || 'pcs', 30), safe(notes), pid]
      );
    } else {
      await t.run(
        `INSERT INTO {s}.inventory_items (product_id, initial_stock, unit, notes) VALUES ($1,$2,$3,$4)`,
        [pid, stock, safe(unit || 'pcs', 30), safe(notes)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /movements — agregar entrada o merma ─── */
router.post('/movements', async (req, res, next) => {
  try {
    const { product_id, type, quantity, notes } = req.body || {};
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: 'product_id requerido' });
    if (!['entrada', 'merma'].includes(type)) return res.status(400).json({ error: 'type debe ser entrada o merma' });
    const qty = n(quantity);
    if (qty <= 0) return res.status(400).json({ error: 'quantity debe ser mayor a 0' });
    const t = req.tdb;
    const row = await t.get(
      `INSERT INTO {s}.inventory_movements (product_id, type, quantity, notes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [pid, type, qty, safe(notes), req.user?.username || '']
    );
    res.json({ ok: true, id: row.id, created_at: row.created_at });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /movements — listar movimientos ─── */
router.get('/movements', async (req, res, next) => {
  try {
    const { product_id } = req.query;
    const range = parsePeriodRange(req.query);
    const t = req.tdb;
    let rows;
    if (product_id && Number(product_id)) {
      let query =
        `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity::float AS quantity,
                m.notes, m.created_by,
                to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.inventory_movements m
         JOIN {s}.products p ON p.id = m.product_id
         WHERE m.product_id = $1`;
      let params = [Number(product_id)];
      if (range.from && range.to) {
        query += ` AND m.created_at >= $2::timestamptz AND m.created_at <= $3::timestamptz`;
        params.push(range.from, range.to);
      }
      query += ` ORDER BY m.created_at DESC LIMIT 200`;
      rows = await t.all(query, params);
    } else {
      let query =
        `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity::float AS quantity,
                m.notes, m.created_by,
                to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.inventory_movements m
         JOIN {s}.products p ON p.id = m.product_id
         WHERE 1=1`;
      const params = [];
      if (range.from && range.to) {
        query += ` AND m.created_at >= $1::timestamptz AND m.created_at <= $2::timestamptz`;
        params.push(range.from, range.to);
      }
      query += ` ORDER BY m.created_at DESC LIMIT 500`;
      rows = await t.all(query, params);
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ─── DELETE /movements/:id — eliminar movimiento ─── */
router.delete('/movements/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'ID inválido' });
    const t = req.tdb;
    const r = await t.run(`DELETE FROM {s}.inventory_movements WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Movimiento no encontrado' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ─── POST /count — guardar conteo físico ─── */
router.post('/count', async (req, res, next) => {
  try {
    const { product_id, physical_qty, notes } = req.body || {};
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: 'product_id requerido' });
    const qty = Number(physical_qty);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'physical_qty inválido' });
    const t = req.tdb;
    await t.run(
      `INSERT INTO {s}.inventory_counts (product_id, physical_qty, notes, counted_by) VALUES ($1,$2,$3,$4)`,
      [pid, qty, safe(notes), req.user?.username || '']
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ─── GET /count-history?product_id=N — historial de conteos ─── */
router.get('/count-history', async (req, res, next) => {
  try {
    const { product_id } = req.query;
    if (!product_id || !Number(product_id)) return res.status(400).json({ error: 'product_id requerido' });
    const t = req.tdb;
    const rows = await t.all(
      `SELECT ic.id, ic.product_id, p.name AS product_name, ic.physical_qty::float AS physical_qty,
              ic.notes, ic.counted_by,
              to_char(ic.counted_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS counted_at
       FROM {s}.inventory_counts ic
       JOIN {s}.products p ON p.id = ic.product_id
       WHERE ic.product_id = $1 ORDER BY ic.counted_at DESC LIMIT 50`,
      [Number(product_id)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ─── GET /export — datos para exportar ─── */
router.get('/export', async (req, res, next) => {
  try {
    const t = req.tdb;
    const range = parsePeriodRange(req.query);
    let movSql =
      `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity::float AS quantity,
              m.notes, m.created_by,
              to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
       FROM {s}.inventory_movements m
       JOIN {s}.products p ON p.id = m.product_id
       WHERE 1=1`;
    const movParams = [];
    if (range.from && range.to) {
      movSql += ` AND m.created_at >= $1::timestamptz AND m.created_at <= $2::timestamptz`;
      movParams.push(range.from, range.to);
    }
    movSql += ` ORDER BY m.created_at DESC`;
    const [products, items, movements, allCounts, globalBaseline] = await Promise.all([
      t.all(`SELECT id, name FROM {s}.products WHERE active = 1 ORDER BY name`),
      t.all(`SELECT * FROM {s}.inventory_items`),
      t.all(movSql, movParams),
      t.all(
        `SELECT DISTINCT ON (product_id) id, product_id, physical_qty::float AS physical_qty, notes, counted_by,
                to_char(counted_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS counted_at
         FROM {s}.inventory_counts ORDER BY product_id, counted_at DESC`
      ),
      getInventoryGlobalBaseline(t),
    ]);
    const baselineMap = new Map();
    if (range.period === 'all') {
      for (const item of items) {
        if (!item?.product_id || !item?.baseline_started_at) continue;
        baselineMap.set(Number(item.product_id), new Date(item.baseline_started_at));
      }
      ensureBaselineMapForProducts(products, baselineMap, globalBaseline);
    }
    const salesMap = await buildSalesMap(t, range, range.period === 'all' ? baselineMap : null);
    const itemMap = new Map(items.map((i) => [i.product_id, i]));
    const countMap = new Map(allCounts.map((c) => [c.product_id, c]));
    const movMap = buildMovementMap(movements, range.period === 'all' ? baselineMap : null);

    const summary = products.map((p) =>
      calcRow(p, itemMap.get(p.id), movMap.get(p.id), salesMap, countMap.get(p.id))
    );

    res.json({
      summary,
      movements,
      period: {
        key: range.period,
        startDate: range.from,
        endDate: range.to,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
