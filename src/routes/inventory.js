const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { ensureCostingSchema, preciseCost } = require('../utils/costing');
const { ensurePurchasingSchema } = require('../utils/purchasing');
const { ensureBranchStockSchema, initializeBranchStock } = require('../utils/branchStock');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);
router.use(async (req, res, next) => {
  try {
    await ensureCostingSchema(req.tdb);
    await ensurePurchasingSchema(req.tdb);
    await ensureBranchStockSchema(req.tdb);
    await initializeBranchStock(req.tdb, req.user?.username || 'system');
    next();
  } catch (error) {
    next(error);
  }
});

/* ─── helpers ─── */
function n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : 0;
}

function safe(v, max = 300) {
  return String(v || '').trim().slice(0, max);
}

async function currentProductStock(t, productId) {
  const item = await t.get('SELECT COALESCE(initial_stock, 0)::float AS initial_stock FROM {s}.inventory_items WHERE product_id = $1', [productId]);
  const movements = await t.all(
    `SELECT type, COALESCE(SUM(quantity), 0)::float AS quantity
     FROM {s}.inventory_movements WHERE product_id = $1 GROUP BY type`,
    [productId]
  );
  const orders = await t.all(`SELECT items FROM {s}.orders WHERE status != 'cancelado'`);
  let stock = Number(item?.initial_stock || 0);
  for (const movement of movements) {
    stock += movement.type === 'entrada' ? Number(movement.quantity || 0) : -Number(movement.quantity || 0);
  }
  for (const order of orders) {
    let items = [];
    try { items = JSON.parse(order.items || '[]'); } catch {}
    if (!Array.isArray(items)) continue;
    for (const row of items) {
      if (Number(row?.id || row?.product_id || 0) === productId) stock -= Number(row?.qty || row?.quantity || 0);
    }
  }
  return Math.max(0, n(stock));
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
async function buildSalesMap(t, range, baselineMap, branchId = 0) {
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
  if (Number(branchId) > 0) {
    params.push(Number(branchId));
    sql += ` AND COALESCE(service_branch_id,pickup_branch_id) = $${params.length}`;
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
    if (!map.has(pid)) map.set(pid, { entradas: 0, compras: 0, mermas: 0 });
    if (m.type === 'entrada' && m.source_type === 'purchase') map.get(pid).compras += n(m.quantity);
    else if (m.type === 'entrada') map.get(pid).entradas += n(m.quantity);
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

function calcRow(product, invItem, mots, salesMap, lastCount, scope = {}) {
  const initial = n(scope.initialStock ?? (invItem?.initial_stock || 0));
  const entradas = n(mots?.entradas || 0);
  const compras = n(mots?.compras || 0);
  const mermas = n(mots?.mermas || 0);
  const ventas = n(salesMap.get(product.id) || 0);
  const traslados = n(scope.transfers || 0);
  const calculatedStock = Number((initial + entradas + compras + traslados - mermas - ventas).toFixed(4));
  const fisico_sistema = scope.systemStock === undefined ? calculatedStock : n(scope.systemStock);
  const fisico_real = lastCount ? n(lastCount.physical_qty) : null;
  const diferencia = fisico_real !== null ? Number((fisico_real - fisico_sistema).toFixed(4)) : null;
  return {
    product_id: product.id,
    product_name: product.name,
    unit: invItem?.unit || 'pcs',
    initial_stock: initial,
    entradas,
    compras,
    traslados,
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
    const branchId = Number(req.query.branch || 0) > 0 ? Number(req.query.branch) : 0;
    let movQuery = `SELECT * FROM {s}.inventory_movements WHERE 1=1`;
    let movParams = [];
    if (range.from && range.to) {
      movQuery += ` AND created_at >= $1::timestamptz AND created_at <= $2::timestamptz`;
      movParams = [range.from, range.to];
    }
    if (branchId) { movParams.push(branchId); movQuery += ` AND branch_id = $${movParams.length}`; }
    movQuery += ` ORDER BY created_at DESC`;
    const countBranchClause = branchId ? 'WHERE branch_id=$1' : 'WHERE branch_id IS NULL';
    const [products, items, movements, counts, globalBaseline, branches, branchStocks, transfers] = await Promise.all([
      t.all(`SELECT id, name FROM {s}.products WHERE active = 1 ORDER BY name`),
      t.all(`SELECT * FROM {s}.inventory_items`),
      t.all(movQuery, movParams),
      t.all(
        `SELECT DISTINCT ON (product_id) id, product_id, physical_qty, notes, counted_by, counted_at
         FROM {s}.inventory_counts ${countBranchClause} ORDER BY product_id, counted_at DESC`, branchId ? [branchId] : []
      ),
      getInventoryGlobalBaseline(t),
      t.all('SELECT id,name,active FROM {s}.branches ORDER BY active DESC,name'),
      t.all('SELECT branch_id,product_id,quantity::float AS quantity,initial_quantity::float AS initial_quantity,baseline_started_at FROM {s}.branch_inventory'),
      branchId ? t.all(`SELECT iti.product_id,it.completed_at,
        (CASE WHEN it.to_branch_id=$1 THEN iti.quantity ELSE -iti.quantity END)::float AS net
        FROM {s}.inventory_transfer_items iti JOIN {s}.inventory_transfers it ON it.id=iti.transfer_id
        WHERE it.status='completed' ${range.from && range.to ? 'AND it.completed_at >= $2::timestamptz AND it.completed_at <= $3::timestamptz' : ''}
        AND (it.to_branch_id=$1 OR it.from_branch_id=$1)`, range.from && range.to ? [branchId, range.from, range.to] : [branchId]) : [],
    ]);

    const baselineMap = new Map();
    if (range.period === 'all') {
      for (const item of items) {
        if (!item?.product_id || !item?.baseline_started_at) continue;
        baselineMap.set(Number(item.product_id), new Date(item.baseline_started_at));
      }
      ensureBaselineMapForProducts(products, baselineMap, globalBaseline);
    }

    const selectedBranchStocks = branchStocks.filter((row) => !branchId || Number(row.branch_id) === branchId);
    const branchBaselineMap = new Map(selectedBranchStocks
      .filter((row) => row.baseline_started_at)
      .map((row) => [Number(row.product_id), new Date(row.baseline_started_at)]));
    const activeBaselineMap = range.period === 'all' ? (branchId ? branchBaselineMap : baselineMap) : null;
    const salesMap = await buildSalesMap(t, range, activeBaselineMap, branchId);
    const itemMap = new Map(items.map((i) => [i.product_id, i]));
    const countMap = new Map(counts.map((c) => [c.product_id, c]));
    const movMap = buildMovementMap(movements, activeBaselineMap);
    const branchStockMap = new Map(selectedBranchStocks.map((row) => [Number(row.product_id), row]));
    const globalStockMap = new Map();
    for (const row of branchStocks) globalStockMap.set(Number(row.product_id), n((globalStockMap.get(Number(row.product_id)) || 0) + n(row.quantity)));
    const transferMap = new Map();
    for (const row of transfers) {
      const productId = Number(row.product_id); const baseline = activeBaselineMap?.get(productId);
      if (baseline && new Date(row.completed_at) < baseline) continue;
      transferMap.set(productId, n((transferMap.get(productId) || 0) + n(row.net)));
    }

    const rows = products.map((p) =>
      calcRow(p, itemMap.get(p.id), movMap.get(p.id), salesMap, countMap.get(p.id), branchId
        ? { initialStock: branchStockMap.get(p.id)?.initial_quantity || 0, systemStock: branchStockMap.get(p.id)?.quantity || 0, transfers: transferMap.get(p.id) || 0 }
        : { systemStock: globalStockMap.get(p.id) || 0, transfers: 0 })
    );
    res.json({
      rows,
      branches: branches.map((row) => ({ id: Number(row.id), name: row.name, active: Number(row.active) })),
      scope: { branch: branchId ? String(branchId) : 'all', branchName: branchId ? (branches.find((row) => Number(row.id) === branchId)?.name || '') : 'Todas las sucursales' },
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
    const branchId = Number(req.body?.branch_id || 0);

    if (branchId) {
      const result = await t.tx(async (tx) => {
        const branch = await tx.get('SELECT id,name FROM {s}.branches WHERE id=$1 AND active=1', [branchId]);
        if (!branch) throw Object.assign(new Error('Sucursal no disponible'), { statusCode: 400 });
        const params = [branchId]; let productClause = '';
        if (pid) { params.push(pid); productClause = 'AND product_id=$2'; }
        const latest = await tx.all(`SELECT DISTINCT ON(product_id) product_id,physical_qty::float AS physical_qty
          FROM {s}.inventory_counts WHERE branch_id=$1 ${productClause} ORDER BY product_id,counted_at DESC`, params);
        if (!latest.length) throw Object.assign(new Error('No hay conteos físicos de esta sucursal para aplicar'), { statusCode: 400 });
        let updated = 0;
        for (const count of latest) {
          const productId = Number(count.product_id); const target = n(count.physical_qty);
          const product = await tx.get('SELECT name,COALESCE(unit_cost,0)::float AS unit_cost FROM {s}.products WHERE id=$1', [productId]);
          let stock = await tx.get('SELECT quantity::float AS quantity FROM {s}.branch_inventory WHERE branch_id=$1 AND product_id=$2 FOR UPDATE', [branchId,productId]);
          if (!stock) { await tx.run('INSERT INTO {s}.branch_inventory(branch_id,product_id,quantity,initial_quantity,baseline_started_at) VALUES($1,$2,0,0,now())', [branchId,productId]); stock={quantity:0}; }
          const previous=n(stock.quantity),delta=n(target-previous);
          if (delta) await tx.run(`INSERT INTO {s}.inventory_movements(product_id,type,quantity,unit_cost,total_cost,notes,created_by,branch_id,source_type)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'branch_adjustment')`, [productId,delta>0?'entrada':'merma',Math.abs(delta),delta>0?product.unit_cost:null,delta>0?preciseCost(Math.abs(delta)*Number(product.unit_cost||0)):null,closureNote||'Aplicación de conteo físico',req.user?.username||'',branchId]);
          await tx.run('UPDATE {s}.branch_inventory SET quantity=$1,updated_at=now() WHERE branch_id=$2 AND product_id=$3', [target,branchId,productId]);
          await tx.run(`INSERT INTO {s}.purchase_audit_log(entity_type,entity_id,action,payload,actor) VALUES('branch_stock',$1,'physical_count_applied',$2,$3)`, [branchId,JSON.stringify({branch:branch.name,productId,product:product?.name,previous,physicalQuantity:target,delta,note:closureNote}),req.user?.username||'']);
          updated += 1;
        }
        return updated;
      });
      return res.json({ ok:true, updated:result, reconciled:true });
    }

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
    let branchId = Number(req.body?.branch_id || 0);
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: 'product_id requerido' });
    const stock = Math.max(0, n(initial_stock));
    const result = await req.tdb.tx(async (tx) => {
      if (!branchId) branchId = Number((await tx.get('SELECT id FROM {s}.branches WHERE active=1 ORDER BY id LIMIT 1'))?.id || 0);
      if (!branchId) throw Object.assign(new Error('Configura una sucursal antes de asignar inventario'), { statusCode: 400 });
      const branch = await tx.get('SELECT id,name FROM {s}.branches WHERE id=$1 AND active=1', [branchId]);
      if (!branch) throw Object.assign(new Error('Sucursal no disponible'), { statusCode: 400 });
      let branchStock = await tx.get('SELECT quantity::float AS quantity,initial_quantity::float AS initial_quantity FROM {s}.branch_inventory WHERE branch_id=$1 AND product_id=$2 FOR UPDATE', [branchId,pid]);
      if (!branchStock) { await tx.run('INSERT INTO {s}.branch_inventory(branch_id,product_id,quantity,initial_quantity,baseline_started_at) VALUES($1,$2,0,0,now())', [branchId,pid]); branchStock={quantity:0,initial_quantity:0}; }
      const previousInitial = n(branchStock.initial_quantity); const delta = n(stock - previousInitial);
      if (n(branchStock.quantity + delta) < 0) throw Object.assign(new Error('El nuevo inventario inicial dejaría existencias negativas; usa un ajuste de stock'), { statusCode: 409 });
      const nextQuantity = n(branchStock.quantity + delta);
      await tx.run('UPDATE {s}.branch_inventory SET initial_quantity=$1,quantity=$2,updated_at=now() WHERE branch_id=$3 AND product_id=$4', [stock,nextQuantity,branchId,pid]);
      const existing = await tx.get('SELECT id,initial_stock::float AS initial_stock FROM {s}.inventory_items WHERE product_id=$1 FOR UPDATE', [pid]);
      if (existing) await tx.run('UPDATE {s}.inventory_items SET initial_stock=GREATEST(0,initial_stock+$1),unit=$2,notes=$3,updated_at=now() WHERE product_id=$4', [delta,safe(unit||'pcs',30),safe(notes),pid]);
      else await tx.run('INSERT INTO {s}.inventory_items(product_id,initial_stock,unit,notes) VALUES($1,$2,$3,$4)', [pid,stock,safe(unit||'pcs',30),safe(notes)]);
      await tx.run(`INSERT INTO {s}.purchase_audit_log(entity_type,entity_id,action,payload,actor) VALUES('branch_stock',$1,'initial_stock_updated',$2,$3)`, [branchId,JSON.stringify({branch:branch.name,productId:pid,previousInitial,initialStock:stock,delta}),req.user?.username||'']);
      return { branchId, branchName: branch.name };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

/* ─── POST /movements — agregar entrada o merma ─── */
router.post('/movements', async (req, res, next) => {
  try {
    const { product_id, type, quantity, notes, unit_cost } = req.body || {};
    let branchId = Number(req.body?.branch_id || 0);
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: 'product_id requerido' });
    if (!['entrada', 'merma'].includes(type)) return res.status(400).json({ error: 'type debe ser entrada o merma' });
    const qty = n(quantity);
    if (qty <= 0) return res.status(400).json({ error: 'quantity debe ser mayor a 0' });
    const requestedCost = unit_cost === '' || unit_cost === null || unit_cost === undefined ? null : Number(unit_cost);
    if (type === 'entrada' && requestedCost !== null && (!Number.isFinite(requestedCost) || requestedCost < 0)) {
      return res.status(400).json({ error: 'El costo unitario no es válido' });
    }
    const result = await req.tdb.tx(async (tx) => {
      if (!branchId) {
        const defaultBranch = await tx.get('SELECT id FROM {s}.branches WHERE active=1 ORDER BY id LIMIT 1');
        branchId = Number(defaultBranch?.id || 0);
      }
      if (!branchId) throw Object.assign(new Error('Configura una sucursal antes de registrar movimientos'), { statusCode: 400 });
      const branch = await tx.get('SELECT id,name FROM {s}.branches WHERE id=$1 AND active=1', [branchId]);
      if (!branch) throw Object.assign(new Error('La sucursal seleccionada no está disponible'), { statusCode: 400 });
      const product = await tx.get(
        'SELECT id, COALESCE(unit_cost, 0)::float AS unit_cost FROM {s}.products WHERE id = $1 FOR UPDATE',
        [pid]
      );
      if (!product) throw Object.assign(new Error('Producto no encontrado'), { statusCode: 404 });
      const entryCost = type === 'entrada' ? preciseCost(requestedCost ?? product.unit_cost) : null;
      const currentStock = type === 'entrada' ? await currentProductStock(tx, pid) : 0;
      const totalCost = type === 'entrada' ? preciseCost(entryCost * qty) : null;
      const branchStock = await tx.get('SELECT quantity::float AS quantity FROM {s}.branch_inventory WHERE branch_id=$1 AND product_id=$2 FOR UPDATE', [branchId, pid]);
      if (type === 'merma' && n(branchStock?.quantity || 0) < qty) throw Object.assign(new Error(`Existencia insuficiente en ${branch.name}`), { statusCode: 409 });
      const row = await tx.get(
        `INSERT INTO {s}.inventory_movements (product_id, type, quantity, unit_cost, total_cost, notes, created_by,branch_id,source_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual') RETURNING id, created_at`,
        [pid, type, qty, entryCost, totalCost, safe(notes), req.user?.username || '',branchId]
      );
      await tx.run(`INSERT INTO {s}.branch_inventory(branch_id,product_id,quantity,initial_quantity,baseline_started_at,updated_at)
        VALUES($1,$2,$3,0,now(),now()) ON CONFLICT(branch_id,product_id) DO UPDATE
        SET quantity=GREATEST(0,{s}.branch_inventory.quantity+$4),updated_at=now()`,
      [branchId,pid,type==='entrada'?qty:0,type==='entrada'?qty:-qty]);
      let weightedCost = preciseCost(product.unit_cost);
      if (type === 'entrada') {
        weightedCost = preciseCost(((currentStock * weightedCost) + (qty * entryCost)) / (currentStock + qty));
        await tx.run('UPDATE {s}.products SET unit_cost = $1 WHERE id = $2', [weightedCost, pid]);
      }
      return { row, entryCost, totalCost, weightedCost, branchId, branchName: branch.name };
    });
    res.json({
      ok: true,
      id: result.row.id,
      created_at: result.row.created_at,
      unit_cost: result.entryCost,
      total_cost: result.totalCost,
      weighted_unit_cost: result.weightedCost,
      branch_id: result.branchId,
      branch_name: result.branchName,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

/* ─── GET /movements — listar movimientos ─── */
router.get('/movements', async (req, res, next) => {
  try {
    const { product_id } = req.query;
    const branchId = Number(req.query.branch || 0);
    const range = parsePeriodRange(req.query);
    const t = req.tdb;
    let rows;
    if (product_id && Number(product_id)) {
      let query =
        `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity::float AS quantity,
                m.unit_cost::float AS unit_cost, m.total_cost::float AS total_cost,
                m.notes, m.created_by, COALESCE(m.source_type, 'manual') AS source_type,
                m.purchase_order_id, m.branch_id, COALESCE(b.name, '') AS branch_name,
                to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.inventory_movements m
         JOIN {s}.products p ON p.id = m.product_id
         LEFT JOIN {s}.branches b ON b.id = m.branch_id
         WHERE m.product_id = $1`;
      let params = [Number(product_id)];
      if (range.from && range.to) {
        query += ` AND m.created_at >= $2::timestamptz AND m.created_at <= $3::timestamptz`;
        params.push(range.from, range.to);
      }
      if (branchId) { params.push(branchId); query += ` AND m.branch_id=$${params.length}`; }
      query += ` ORDER BY m.created_at DESC LIMIT 200`;
      rows = await t.all(query, params);
    } else {
      let query =
        `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity::float AS quantity,
                m.unit_cost::float AS unit_cost, m.total_cost::float AS total_cost,
                m.notes, m.created_by, COALESCE(m.source_type, 'manual') AS source_type,
                m.purchase_order_id, m.branch_id, COALESCE(b.name, '') AS branch_name,
                to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.inventory_movements m
         JOIN {s}.products p ON p.id = m.product_id
         LEFT JOIN {s}.branches b ON b.id = m.branch_id
         WHERE 1=1`;
      const params = [];
      if (range.from && range.to) {
        query += ` AND m.created_at >= $1::timestamptz AND m.created_at <= $2::timestamptz`;
        params.push(range.from, range.to);
      }
      if (branchId) { params.push(branchId); query += ` AND m.branch_id=$${params.length}`; }
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
    await req.tdb.tx(async (tx) => {
      const movement = await tx.get(`SELECT source_type,type,quantity::float AS quantity,branch_id FROM {s}.inventory_movements WHERE id=$1 FOR UPDATE`, [id]);
      if (!movement) throw Object.assign(new Error('Movimiento no encontrado'), { statusCode: 404 });
      if (['purchase','branch_adjustment'].includes(movement.source_type)) throw Object.assign(new Error('Este movimiento auditado no puede eliminarse desde inventario'), { statusCode: 409 });
      if (movement.branch_id) {
        const delta = movement.type === 'entrada' ? -n(movement.quantity) : n(movement.quantity);
        const stock = await tx.get('SELECT quantity::float AS quantity FROM {s}.branch_inventory WHERE branch_id=$1 AND product_id=(SELECT product_id FROM {s}.inventory_movements WHERE id=$2) FOR UPDATE', [movement.branch_id,id]);
        if (n(stock?.quantity || 0) + delta < 0) throw Object.assign(new Error('No se puede eliminar: dejaría stock negativo en la sucursal'), { statusCode: 409 });
        await tx.run('UPDATE {s}.branch_inventory SET quantity=quantity+$1,updated_at=now() WHERE branch_id=$2 AND product_id=(SELECT product_id FROM {s}.inventory_movements WHERE id=$3)', [delta,movement.branch_id,id]);
      }
      await tx.run('DELETE FROM {s}.inventory_movements WHERE id=$1', [id]);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

/* ─── POST /count — guardar conteo físico ─── */
router.post('/count', async (req, res, next) => {
  try {
    const { product_id, physical_qty, notes } = req.body || {};
    const branchId = Number(req.body?.branch_id || 0) || null;
    const pid = Number(product_id);
    if (!pid) return res.status(400).json({ error: 'product_id requerido' });
    const qty = Number(physical_qty);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'physical_qty inválido' });
    const t = req.tdb;
    if (branchId && !(await t.get('SELECT id FROM {s}.branches WHERE id=$1 AND active=1', [branchId]))) {
      return res.status(400).json({ error: 'La sucursal no está disponible para nuevos conteos' });
    }
    await t.run(
      `INSERT INTO {s}.inventory_counts (product_id, physical_qty, notes, counted_by,branch_id) VALUES ($1,$2,$3,$4,$5)`,
      [pid, qty, safe(notes), req.user?.username || '',branchId]
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
    const branchId = Number(req.query.branch || 0);
    const rows = await t.all(
      `SELECT ic.id, ic.product_id, p.name AS product_name, ic.physical_qty::float AS physical_qty,
              ic.notes, ic.counted_by,
              to_char(ic.counted_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS counted_at
       FROM {s}.inventory_counts ic
       JOIN {s}.products p ON p.id = ic.product_id
       WHERE ic.product_id = $1 ${branchId ? 'AND ic.branch_id=$2' : 'AND ic.branch_id IS NULL'} ORDER BY ic.counted_at DESC LIMIT 50`,
      branchId ? [Number(product_id),branchId] : [Number(product_id)]
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
    const branchId = Number(req.query.branch || 0) > 0 ? Number(req.query.branch) : 0;
    let movSql =
      `SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity::float AS quantity,
              m.notes, m.created_by, COALESCE(m.source_type, 'manual') AS source_type,
              to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
       FROM {s}.inventory_movements m
       JOIN {s}.products p ON p.id = m.product_id
       WHERE 1=1`;
    const movParams = [];
      if (range.from && range.to) {
      movSql += ` AND m.created_at >= $1::timestamptz AND m.created_at <= $2::timestamptz`;
      movParams.push(range.from, range.to);
    }
    if (branchId) { movParams.push(branchId); movSql += ` AND m.branch_id=$${movParams.length}`; }
    movSql += ` ORDER BY m.created_at DESC`;
    const [products, items, movements, allCounts, globalBaseline, branchStocks] = await Promise.all([
      t.all(`SELECT id, name FROM {s}.products WHERE active = 1 ORDER BY name`),
      t.all(`SELECT * FROM {s}.inventory_items`),
      t.all(movSql, movParams),
      t.all(
        `SELECT DISTINCT ON (product_id) id, product_id, physical_qty::float AS physical_qty, notes, counted_by,
                to_char(counted_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS counted_at
         FROM {s}.inventory_counts ${branchId?'WHERE branch_id=$1':'WHERE branch_id IS NULL'} ORDER BY product_id, counted_at DESC`, branchId?[branchId]:[]
      ),
      getInventoryGlobalBaseline(t),
      t.all('SELECT branch_id,product_id,quantity::float AS quantity,initial_quantity::float AS initial_quantity,baseline_started_at FROM {s}.branch_inventory'),
    ]);
    const baselineMap = new Map();
    if (range.period === 'all') {
      for (const item of items) {
        if (!item?.product_id || !item?.baseline_started_at) continue;
        baselineMap.set(Number(item.product_id), new Date(item.baseline_started_at));
      }
      ensureBaselineMapForProducts(products, baselineMap, globalBaseline);
    }
    const scopedStocks=branchStocks.filter((row)=>!branchId||Number(row.branch_id)===branchId);
    const branchBaselineMap=new Map(scopedStocks.filter((row)=>row.baseline_started_at).map((row)=>[Number(row.product_id),new Date(row.baseline_started_at)]));
    const activeBaseline=range.period==='all'?(branchId?branchBaselineMap:baselineMap):null;
    const salesMap = await buildSalesMap(t, range, activeBaseline,branchId);
    const itemMap = new Map(items.map((i) => [i.product_id, i]));
    const countMap = new Map(allCounts.map((c) => [c.product_id, c]));
    const movMap = buildMovementMap(movements, activeBaseline);
    const stockMap=new Map(scopedStocks.map((row)=>[Number(row.product_id),row]));const globalStockMap=new Map();for(const row of branchStocks)globalStockMap.set(Number(row.product_id),n((globalStockMap.get(Number(row.product_id))||0)+n(row.quantity)));

    const summary = products.map((p) =>
      calcRow(p,itemMap.get(p.id),movMap.get(p.id),salesMap,countMap.get(p.id),branchId?{initialStock:stockMap.get(p.id)?.initial_quantity||0,systemStock:stockMap.get(p.id)?.quantity||0}:{systemStock:globalStockMap.get(p.id)||0})
    );

    res.json({
      summary,
      movements,
      period: {
        key: range.period,
        startDate: range.from,
        endDate: range.to,
      },
      scope: { branch: branchId?String(branchId):'all' },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
