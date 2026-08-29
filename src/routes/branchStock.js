const express = require('express');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const { ensureCostingSchema, money } = require('../utils/costing');
const { ensurePurchasingSchema, writePurchaseAudit } = require('../utils/purchasing');
const { ensureBranchStockSchema, initializeBranchStock, n } = require('../utils/branchStock');
const { stockValuation } = require('../utils/stockValuation');

const router = express.Router();
router.use(requireAuth);
router.use(requireModules('stock-sucursales', 'compras', 'inventarios'));
router.use(requireOwner);
router.use(async (req, res, next) => {
  try {
    await ensureCostingSchema(req.tdb);
    await ensurePurchasingSchema(req.tdb);
    await ensureBranchStockSchema(req.tdb);
    await initializeBranchStock(req.tdb, req.user?.username || 'system');
    next();
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const [branches, products, stocks] = await Promise.all([
      req.tdb.all('SELECT id,name,active FROM {s}.branches ORDER BY active DESC,name'),
      req.tdb.all(`SELECT p.id,p.name,COALESCE(c.name,'Sin categoría') AS category_name,
        COALESCE(p.price,0)::float AS price, COALESCE(p.unit_cost,0)::float AS unit_cost FROM {s}.products p
        LEFT JOIN {s}.categories c ON c.id=p.category_id WHERE p.active=1 ORDER BY p.name`),
      req.tdb.all(`SELECT branch_id,product_id,quantity::float AS quantity,initial_quantity::float AS initial_quantity,
        baseline_started_at FROM {s}.branch_inventory`),
    ]);
    const stockMap = new Map(stocks.map((row) => [`${row.branch_id}:${row.product_id}`, row]));
    const stockBranches = branches;
    const rows = products.map((product) => {
      const locations = stockBranches.map((branch) => {
        const stock = stockMap.get(`${branch.id}:${product.id}`);
        return {
          branchId: Number(branch.id), branchName: branch.name, active: Number(branch.active),
          quantity: n(stock?.quantity), initialQuantity: n(stock?.initial_quantity),
        };
      });
      return {
        productId: Number(product.id), productName: product.name, categoryName: product.category_name,
        price: Number(product.price || 0), unitCost: Number(product.unit_cost || 0),
        globalQuantity: n(locations.reduce((sum, row) => sum + row.quantity, 0)), locations,
      };
    });
    const summaries = stockBranches.map((branch) => {
      const locationRows = rows.map((row) => ({ row, stock: row.locations.find((item) => item.branchId === Number(branch.id)) }));
      const totalUnits = n(locationRows.reduce((sum, item) => sum + item.stock.quantity, 0));
      const valuation = stockValuation(locationRows.map((item) => ({
        quantity: item.stock.quantity,
        salePrice: item.row.price,
        unitCost: item.row.unitCost,
      })));
      return {
        branchId: Number(branch.id), branchName: branch.name, active: Number(branch.active), totalUnits,
        stockValue: valuation.salesValue,
        ...valuation,
        productsWithStock: locationRows.filter((item) => item.stock.quantity > 0).length,
        productsOutOfStock: locationRows.filter((item) => item.stock.quantity <= 0).length,
      };
    });
    res.json({ branches: stockBranches.map((row) => ({ id: Number(row.id), name: row.name, active: Number(row.active) })), summaries, rows });
  } catch (error) { next(error); }
});

router.post('/adjust', async (req, res, next) => {
  try {
    const branchId = Number(req.body?.branchId); const productId = Number(req.body?.productId);
    const physicalQuantity = n(req.body?.physicalQuantity); const reason = String(req.body?.reason || '').trim().slice(0, 240);
    if (!branchId || !productId || physicalQuantity < 0) return res.status(400).json({ error: 'Sucursal, producto y existencia válida son obligatorios' });
    if (reason.length < 3) return res.status(400).json({ error: 'Escribe el motivo del ajuste para la auditoría' });
    const result = await req.tdb.tx(async (tx) => {
      const [branch, product] = await Promise.all([
        tx.get('SELECT id,name FROM {s}.branches WHERE id=$1 AND active=1', [branchId]),
        tx.get('SELECT id,name,COALESCE(unit_cost,0)::float AS unit_cost FROM {s}.products WHERE id=$1 AND active=1', [productId]),
      ]);
      if (!branch || !product) throw Object.assign(new Error('Sucursal o producto no disponible'), { statusCode: 404 });
      let stock = await tx.get('SELECT quantity::float AS quantity FROM {s}.branch_inventory WHERE branch_id=$1 AND product_id=$2 FOR UPDATE', [branchId, productId]);
      if (!stock) {
        await tx.run(`INSERT INTO {s}.branch_inventory(branch_id,product_id,quantity,initial_quantity,baseline_started_at) VALUES($1,$2,0,0,now())`, [branchId, productId]);
        stock = { quantity: 0 };
      }
      const previous = n(stock.quantity); const delta = n(physicalQuantity - previous);
      if (delta) {
        const type = delta > 0 ? 'entrada' : 'merma'; const quantity = Math.abs(delta);
        await tx.run(`INSERT INTO {s}.inventory_movements(product_id,type,quantity,unit_cost,total_cost,notes,created_by,branch_id,source_type)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'branch_adjustment')`,
        [productId, type, quantity, type === 'entrada' ? product.unit_cost : null, type === 'entrada' ? money(quantity * Number(product.unit_cost || 0)) : null, reason, req.user.username, branchId]);
      }
      await tx.run('UPDATE {s}.branch_inventory SET quantity=$1,updated_at=now() WHERE branch_id=$2 AND product_id=$3', [physicalQuantity, branchId, productId]);
      await writePurchaseAudit(tx, 'branch_stock', branchId, 'stock_adjusted', { branch: branch.name, productId, product: product.name, previous, physicalQuantity, delta, reason }, req.user.username);
      return { previous, physicalQuantity, delta, branchName: branch.name, productName: product.name };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.get('/audit', async (req, res, next) => {
  try {
    const params = []; let where = "WHERE entity_type='branch_stock'";
    if (Number(req.query.branch) > 0) { params.push(Number(req.query.branch)); where += ` AND entity_id=$${params.length}`; }
    const rows = await req.tdb.all(`SELECT id,entity_id,action,payload,actor,
      to_char(created_at AT TIME ZONE '${req.timezone}','DD/MM/YYYY HH24:MI') AS created_at
      FROM {s}.purchase_audit_log ${where} ORDER BY id DESC LIMIT 300`, params);
    res.json(rows.map((row) => { let payload = {}; try { payload = JSON.parse(row.payload || '{}'); } catch {} return { id: Number(row.id), branchId: Number(row.entity_id), action: row.action, payload, actor: row.actor, createdAt: row.created_at }; }));
  } catch (error) { next(error); }
});

module.exports = router;
