const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { ensureCostingSchema, money, preciseCost } = require('../utils/costing');
const { getSetting } = require('../db');
const { createRateLimiter } = require('../middleware/security');

const router = express.Router();
const expenseDeleteLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 12, message: 'Demasiados intentos. Espera unos minutos.' });
router.use(requireAuth);
router.use(async (req, res, next) => {
  try {
    await ensureCostingSchema(req.tdb);
    next();
  } catch (error) {
    next(error);
  }
});

function safeText(value, max = 180) {
  return String(value || '').trim().slice(0, max);
}

function matchesExpenseSearch(row, query) {
  if (!query) return true;
  const text = [row.concept, row.notes, row.branch_name, row.created_by, row.deleted_by]
    .map((value) => String(value || ''))
    .join(' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return text.includes(query);
}

function validDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : '';
}

router.get('/products', requireModules('costos'), requireOwner, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const sort = String(req.query.sort || 'alphabetical') === 'category' ? 'category' : 'alphabetical';
    const order = sort === 'category'
      ? `COALESCE(c.name, 'Sin categoría') ASC, p.name ASC`
      : 'p.name ASC';
    const [products, categories, branches] = await Promise.all([
      req.tdb.all(
        `SELECT p.id, p.name, p.category_id, COALESCE(c.name, 'Sin categoría') AS category_name,
                p.price::float AS sale_price, COALESCE(p.unit_cost, 0)::float AS unit_cost, p.active
         FROM {s}.products p
         LEFT JOIN {s}.categories c ON c.id = p.category_id
         ORDER BY ${order}`
      ),
      req.tdb.all('SELECT id, name FROM {s}.categories ORDER BY sort, name'),
      req.tdb.all('SELECT id, name, active FROM {s}.branches ORDER BY active DESC, name'),
    ]);
    res.json({
      products: products.map((product) => {
        const salePrice = money(product.sale_price);
        const unitCost = preciseCost(product.unit_cost);
        const margin = money(salePrice - unitCost);
        return {
          id: Number(product.id),
          name: product.name,
          categoryId: product.category_id ? Number(product.category_id) : null,
          categoryName: product.category_name,
          salePrice,
          unitCost,
          margin,
          marginPercent: salePrice ? Number(((margin / salePrice) * 100).toFixed(2)) : 0,
          active: Number(product.active),
        };
      }),
      categories: categories.map((row) => ({ id: Number(row.id), name: row.name })),
      branches: branches.map((row) => ({ id: Number(row.id), name: row.name, active: Number(row.active) })),
    });
  } catch (error) {
    next(error);
  }
});

router.put('/products', requireModules('costos'), requireOwner, async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No hay costos para guardar' });
    if (items.length > 500) return res.status(400).json({ error: 'Solo puedes guardar 500 productos por operación' });

    await req.tdb.tx(async (tx) => {
      for (const item of items) {
        const id = Number(item.id);
        const unitCost = Number(item.unitCost);
        const salePrice = Number(item.salePrice);
        if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Producto inválido'), { statusCode: 400 });
        if (!Number.isFinite(unitCost) || unitCost < 0) throw Object.assign(new Error('El costo no puede ser negativo'), { statusCode: 400 });
        if (!Number.isFinite(salePrice) || salePrice < 0) throw Object.assign(new Error('El precio de venta no puede ser negativo'), { statusCode: 400 });
        const result = await tx.run(
          'UPDATE {s}.products SET unit_cost = $1, price = $2 WHERE id = $3',
          [preciseCost(unitCost), money(salePrice), id]
        );
        if (!result.rowCount) throw Object.assign(new Error('Uno de los productos ya no existe'), { statusCode: 404 });
      }
    });
    const ids = items.map((item) => Number(item.id));
    const savedRows = await req.tdb.all(
      `SELECT id, COALESCE(unit_cost, 0)::float AS unit_cost, price::float AS sale_price
       FROM {s}.products WHERE id = ANY($1::int[]) ORDER BY id`,
      [ids]
    );
    res.json({
      ok: true,
      updated: items.length,
      saved: savedRows.map((row) => ({ id: Number(row.id), unitCost: preciseCost(row.unit_cost), salePrice: money(row.sale_price) })),
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.get('/expenses', requireModules('gastos'), async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const branchRestricted = req.user.role !== 'owner';
    const userBranchId = Number(req.user.branchId || 0);
    if (branchRestricted && !userBranchId) return res.status(403).json({ error: 'El usuario no tiene una sucursal asignada' });
    const search = safeText(req.query.q, 120);
    const normalizedSearch = search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const now = new Date();
    const year = Math.max(2000, Math.min(2100, Number(req.query.year) || now.getFullYear()));
    const month = Math.max(1, Math.min(12, Number(req.query.month) || now.getMonth() + 1));
    const allDates = req.query.period === 'all';
    const customRange = req.query.from !== undefined || req.query.to !== undefined;
    let from = '';
    let to = '';
    if (!allDates && customRange) {
      from = validDate(req.query.from);
      to = validDate(req.query.to);
      if (!from || !to || from > to) return res.status(400).json({ error: 'Selecciona un rango de fechas válido' });
    } else if (!allDates) {
      from = `${year}-${String(month).padStart(2, '0')}-01`;
      to = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    }
    const branch = branchRestricted ? String(userBranchId) : String(req.query.branch || 'all').trim().toLowerCase();
    const params = allDates ? [] : [from, to];
    const manualDates = allDates ? '' : 'AND e.expense_date BETWEEN $1::date AND $2::date';
    const posDates = allDates ? '' : `AND (m.created_at AT TIME ZONE '${req.timezone}')::date BETWEEN $1::date AND $2::date`;
    const deletedDates = allDates ? '' : 'AND d.expense_date BETWEEN $1::date AND $2::date';
    let manualBranch = '';
    let posBranch = '';
    let deletedBranch = '';
    if (branchRestricted) {
      params.push(userBranchId);
      manualBranch = `AND e.branch_id = $${params.length}`;
      posBranch = `AND ps.branch_id = $${params.length}`;
      deletedBranch = `AND d.branch_id = $${params.length}`;
    }

    const [rows, branches, deletedRows] = await Promise.all([req.tdb.all(
      `SELECT * FROM (
         SELECT e.id, 'manual'::text AS source, e.expense_date,
                e.branch_id, COALESCE(NULLIF(e.branch_name, ''), b.name, 'Sin sucursal') AS branch_name,
                e.concept, e.amount::float AS amount, e.notes, e.created_by,
                to_char(e.created_at AT TIME ZONE '${req.timezone}', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.business_expenses e
         LEFT JOIN {s}.branches b ON b.id = e.branch_id
         WHERE TRUE
           ${manualDates}
           ${manualBranch}
         UNION ALL
         SELECT -m.id AS id, 'pos'::text AS source,
                (m.created_at AT TIME ZONE '${req.timezone}')::date AS expense_date,
                ps.branch_id, COALESCE(NULLIF(ps.branch_name, ''), b.name, 'Sin sucursal') AS branch_name,
                COALESCE(NULLIF(m.note, ''), 'Gasto de caja') AS concept,
                m.amount::float AS amount, ''::text AS notes, m.created_by,
                to_char(m.created_at AT TIME ZONE '${req.timezone}', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.pos_cash_movements m
         JOIN {s}.pos_sessions ps ON ps.id = m.session_id
         LEFT JOIN {s}.branches b ON b.id = ps.branch_id
         WHERE m.kind = 'expense'
           ${posDates}
           ${posBranch}
       ) expenses
       ORDER BY expense_date DESC, id DESC`,
      params
    ), req.tdb.all(
      branchRestricted
        ? 'SELECT id, name, active FROM {s}.branches WHERE id = $1 ORDER BY name'
        : 'SELECT id, name, active FROM {s}.branches ORDER BY active DESC, name',
      branchRestricted ? [userBranchId] : []
    ), req.tdb.all(
      `SELECT d.id, d.source, d.source_id, d.branch_id, d.branch_name, d.session_id,
              d.expense_date, d.concept, d.amount::float AS amount, d.notes, d.created_by,
              d.deleted_by, d.deleted_role, d.authorized_by,
              to_char(d.deleted_at AT TIME ZONE '${req.timezone}', 'DD/MM/YYYY HH24:MI') AS deleted_at
       FROM {s}.deleted_expenses d
       WHERE TRUE ${deletedDates} ${deletedBranch}
       ORDER BY d.deleted_at DESC, d.id DESC`,
      params
    )]);
    const scopedRows = (branchRestricted ? rows.filter((row) => Number(row.branch_id) === userBranchId) : rows)
      .filter((row) => matchesExpenseSearch(row, normalizedSearch));
    const scopedDeletedRows = (branchRestricted ? deletedRows.filter((row) => Number(row.branch_id) === userBranchId) : deletedRows)
      .filter((row) => matchesExpenseSearch(row, normalizedSearch));
    const visibleRows = branchRestricted || branch === 'all' ? scopedRows : scopedRows.filter((row) =>
      branch === 'general' ? !row.branch_id : /^\d+$/.test(branch) && Number(row.branch_id) === Number(branch)
    );
    const visibleDeletedRows = branchRestricted || branch === 'all' ? scopedDeletedRows : scopedDeletedRows.filter((row) =>
      branch === 'general' ? !row.branch_id : /^\d+$/.test(branch) && Number(row.branch_id) === Number(branch)
    );
    const branchTotals = branches.map((row) => {
      const expenseRows = scopedRows.filter((expense) => Number(expense.branch_id) === Number(row.id));
      return { id: Number(row.id), name: row.name, active: Number(row.active), total: money(expenseRows.reduce((sum, expense) => sum + Number(expense.amount || 0), 0)), count: expenseRows.length };
    });
    const generalRows = branchRestricted ? [] : scopedRows.filter((row) => !row.branch_id);
    res.json({
      year,
      month,
      from,
      to,
      allDates,
      branch,
      branchRestricted,
      search,
      branches: branches.map((row) => ({ id: Number(row.id), name: row.name, active: Number(row.active) })),
      globalTotal: money(scopedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      globalCount: scopedRows.length,
      branchTotals,
      generalTotal: money(generalRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      generalCount: generalRows.length,
      total: money(visibleRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      expenses: visibleRows.map((row) => ({ ...row, id: Number(row.id), amount: money(row.amount), branch_id: row.branch_id ? Number(row.branch_id) : null })),
      deletedExpenses: visibleDeletedRows.map((row) => ({ ...row, amount: money(row.amount) })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/expenses', requireModules('gastos'), async (req, res, next) => {
  try {
    const branchId = Number(req.body?.branchId || 0) || null;
    if (req.user.role !== 'owner' && (!req.user.branchId || branchId !== Number(req.user.branchId))) {
      return res.status(403).json({ error: 'Solo puedes registrar gastos de tu sucursal' });
    }
    const expenseDate = validDate(req.body?.expenseDate);
    const concept = safeText(req.body?.concept, 120);
    const amount = Number(req.body?.amount);
    const notes = safeText(req.body?.notes, 240);
    if (!expenseDate) return res.status(400).json({ error: 'Selecciona una fecha válida' });
    if (concept.length < 2) return res.status(400).json({ error: 'Escribe el concepto del gasto' });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'El gasto debe ser mayor a cero' });
    let branchName = '';
    if (branchId) {
      const branch = await req.tdb.get('SELECT id, name FROM {s}.branches WHERE id = $1', [branchId]);
      if (!branch) return res.status(400).json({ error: 'La sucursal no es válida' });
      branchName = branch.name;
    }
    const row = await req.tdb.get(
      `INSERT INTO {s}.business_expenses
       (branch_id, branch_name, expense_date, concept, amount, notes, created_by)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7)
       RETURNING id`,
      [branchId, branchName, expenseDate, concept, money(amount), notes, req.user.username]
    );
    res.json({ ok: true, id: Number(row.id) });
  } catch (error) {
    next(error);
  }
});

router.delete('/expenses/:id', requireModules('gastos'), expenseDeleteLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id === 0) return res.status(400).json({ error: 'Gasto inválido' });
    const cashier = req.user.role === 'cashier';
    if (!cashier && req.user.role !== 'owner') return res.status(403).json({ error: 'Solo el dueño o un cajero autorizado puede borrar gastos' });
    if (cashier && !req.user.branchId) return res.status(403).json({ error: 'El cajero no tiene una sucursal asignada' });
    let authorizedBy = 'Dueño';
    if (cashier) {
      const pinHash = await getSetting(req.tdb, 'pos_authorization_pin_hash', '');
      if (!pinHash) return res.status(409).json({ error: 'Configura primero el NIP de autorización en Mi negocio' });
      if (!(await bcrypt.compare(String(req.body?.pin || ''), pinHash))) return res.status(403).json({ error: 'NIP de autorización incorrecto' });
      authorizedBy = 'NIP del negocio';
    }
    const source = id < 0 ? 'pos' : 'manual';
    const sourceId = Math.abs(id);
    await req.tdb.tx(async (tx) => {
      let expense;
      if (source === 'manual') {
        expense = await tx.get(
          `SELECT e.id, e.branch_id, e.branch_name, NULL::int AS session_id,
                  e.expense_date, e.concept, e.amount, e.notes, e.created_by, e.created_at
           FROM {s}.business_expenses e WHERE e.id=$1 ${cashier ? 'AND e.branch_id=$2' : ''} FOR UPDATE`,
          cashier ? [sourceId, req.user.branchId] : [sourceId]
        );
      } else {
        expense = await tx.get(
          `SELECT m.id, ps.branch_id, ps.branch_name, ps.id AS session_id,
                  (m.created_at AT TIME ZONE $2)::date AS expense_date,
                  COALESCE(NULLIF(m.note, ''), 'Gasto de caja') AS concept,
                  m.amount, ''::text AS notes, m.created_by, m.created_at
           FROM {s}.pos_cash_movements m
           JOIN {s}.pos_sessions ps ON ps.id=m.session_id
           WHERE m.id=$1 AND m.kind='expense' ${cashier ? 'AND ps.branch_id=$3' : ''}
           FOR UPDATE OF m`,
          cashier ? [sourceId, req.timezone, req.user.branchId] : [sourceId, req.timezone]
        );
      }
      if (!expense) throw Object.assign(new Error('Gasto no encontrado en la sucursal autorizada'), { statusCode: 404 });
      if (source === 'pos') await tx.get('SELECT id FROM {s}.pos_sessions WHERE id=$1 FOR UPDATE', [expense.session_id]);
      await tx.run(
        `INSERT INTO {s}.deleted_expenses
         (source, source_id, branch_id, branch_name, session_id, expense_date, concept,
          amount, notes, created_by, original_created_at, deleted_by, deleted_role, authorized_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [source, sourceId, expense.branch_id, expense.branch_name || '', expense.session_id,
          expense.expense_date, expense.concept, expense.amount, expense.notes || '',
          expense.created_by || '', expense.created_at, req.user.username, req.user.role, authorizedBy]
      );
      if (source === 'manual') {
        await tx.run('DELETE FROM {s}.business_expenses WHERE id=$1', [sourceId]);
      } else {
        await tx.run("DELETE FROM {s}.pos_cash_movements WHERE id=$1 AND kind='expense'", [sourceId]);
        await tx.run("UPDATE {s}.pos_close_approvals SET status='stale' WHERE session_id=$1 AND status='approved'", [expense.session_id]);
        await tx.run(
          `UPDATE {s}.pos_sessions
           SET expected_amount = expected_amount + $2,
               difference_amount = closing_amount - (expected_amount + $2)
           WHERE id=$1 AND status='closed'`,
          [expense.session_id, expense.amount]
        );
      }
    });
    res.json({ ok: true });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

module.exports = router;
