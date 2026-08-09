const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { ensureCostingSchema, money, preciseCost } = require('../utils/costing');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);
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

function validDate(value) {
  const date = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

router.get('/products', async (req, res, next) => {
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

router.put('/products', async (req, res, next) => {
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

router.get('/expenses', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const now = new Date();
    const year = Math.max(2000, Math.min(2100, Number(req.query.year) || now.getFullYear()));
    const month = Math.max(1, Math.min(12, Number(req.query.month) || now.getMonth() + 1));
    const branch = String(req.query.branch || 'all').trim().toLowerCase();
    const params = [year, month];
    let manualBranch = '';
    let posBranch = '';
    if (branch === 'general') {
      manualBranch = 'AND COALESCE(e.branch_id, 0) = 0';
      posBranch = 'AND COALESCE(ps.branch_id, 0) = 0';
    } else if (/^\d+$/.test(branch) && Number(branch) > 0) {
      params.push(Number(branch));
      manualBranch = `AND e.branch_id = $${params.length}`;
      posBranch = `AND ps.branch_id = $${params.length}`;
    }

    const rows = await req.tdb.all(
      `SELECT * FROM (
         SELECT e.id, 'manual'::text AS source, e.expense_date,
                e.branch_id, COALESCE(NULLIF(e.branch_name, ''), b.name, 'Sin sucursal') AS branch_name,
                e.concept, e.amount::float AS amount, e.notes, e.created_by,
                to_char(e.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.business_expenses e
         LEFT JOIN {s}.branches b ON b.id = e.branch_id
         WHERE EXTRACT(YEAR FROM e.expense_date)::int = $1
           AND EXTRACT(MONTH FROM e.expense_date)::int = $2
           ${manualBranch}
         UNION ALL
         SELECT -m.id AS id, 'pos'::text AS source,
                (m.created_at AT TIME ZONE 'America/Mexico_City')::date AS expense_date,
                ps.branch_id, COALESCE(NULLIF(ps.branch_name, ''), b.name, 'Sin sucursal') AS branch_name,
                COALESCE(NULLIF(m.note, ''), 'Gasto de caja') AS concept,
                m.amount::float AS amount, ''::text AS notes, m.created_by,
                to_char(m.created_at AT TIME ZONE 'America/Mexico_City', 'DD/MM/YYYY HH24:MI') AS created_at
         FROM {s}.pos_cash_movements m
         JOIN {s}.pos_sessions ps ON ps.id = m.session_id
         LEFT JOIN {s}.branches b ON b.id = ps.branch_id
         WHERE m.kind = 'expense'
           AND EXTRACT(YEAR FROM m.created_at AT TIME ZONE 'America/Mexico_City')::int = $1
           AND EXTRACT(MONTH FROM m.created_at AT TIME ZONE 'America/Mexico_City')::int = $2
           ${posBranch}
       ) expenses
       ORDER BY expense_date DESC, id DESC`,
      params
    );
    res.json({
      year,
      month,
      branch,
      total: money(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      expenses: rows.map((row) => ({ ...row, id: Number(row.id), amount: money(row.amount), branch_id: row.branch_id ? Number(row.branch_id) : null })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/expenses', async (req, res, next) => {
  try {
    const branchId = Number(req.body?.branchId || 0) || null;
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

router.delete('/expenses/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Gasto inválido' });
    const result = await req.tdb.run('DELETE FROM {s}.business_expenses WHERE id = $1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Gasto no encontrado o generado desde caja' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
