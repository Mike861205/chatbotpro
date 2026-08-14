const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { ensureCostingSchema, money, preciseCost } = require('../utils/costing');
const { ensurePurchasingSchema, writePurchaseAudit } = require('../utils/purchasing');
const { ensureBranchStockSchema, initializeBranchStock, n } = require('../utils/branchStock');

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
  } catch (error) { next(error); }
});

const TZ = 'America/Mexico_City';
const safe = (value, max = 240) => String(value || '').trim().slice(0, max);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function serializeOrder(row, items = []) {
  return {
    id: Number(row.id), orderNumber: row.order_number, supplierId: row.supplier_id ? Number(row.supplier_id) : null,
    supplierName: row.supplier_name, branchId: row.branch_id ? Number(row.branch_id) : null, branchName: row.branch_name,
    status: row.status, orderDate: String(row.order_date || '').slice(0, 10), expectedDate: row.expected_date ? String(row.expected_date).slice(0, 10) : '',
    subtotal: money(row.subtotal), total: money(row.total), notes: row.notes || '', createdBy: row.created_by || '',
    receivedBy: row.received_by || '', createdAt: row.created_at || '', receivedAt: row.received_at || '', items,
  };
}

async function currentProductStock(t, productId) {
  const branchStock = await t.get(
    `SELECT COUNT(*)::int AS locations, COALESCE(SUM(quantity),0)::float AS quantity
     FROM {s}.branch_inventory WHERE product_id=$1`,
    [productId]
  );
  if (Number(branchStock?.locations || 0) > 0) return Math.max(0, Number(Number(branchStock.quantity || 0).toFixed(4)));
  const item = await t.get('SELECT COALESCE(initial_stock, 0)::float AS initial_stock FROM {s}.inventory_items WHERE product_id = $1', [productId]);
  const movements = await t.all(`SELECT type, COALESCE(SUM(quantity),0)::float AS quantity FROM {s}.inventory_movements WHERE product_id=$1 GROUP BY type`, [productId]);
  const orders = await t.all(`SELECT items FROM {s}.orders WHERE status != 'cancelado'`);
  let stock = Number(item?.initial_stock || 0);
  for (const movement of movements) stock += movement.type === 'entrada' ? Number(movement.quantity || 0) : -Number(movement.quantity || 0);
  for (const order of orders) {
    let rows = [];
    try { rows = JSON.parse(order.items || '[]'); } catch {}
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (Number(row?.id || row?.product_id || 0) === productId) stock -= Number(row?.qty || row?.quantity || 0);
  }
  return Math.max(0, Number(stock.toFixed(4)));
}

async function loadOrderItems(t, orderIds) {
  if (!orderIds.length) return new Map();
  const rows = await t.all(
    `SELECT id, purchase_order_id, product_id, product_name, quantity::float AS quantity,
            unit_cost::float AS unit_cost, line_total::float AS line_total
     FROM {s}.purchase_order_items WHERE purchase_order_id = ANY($1::int[]) ORDER BY id`,
    [orderIds]
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(Number(row.purchase_order_id))) map.set(Number(row.purchase_order_id), []);
    map.get(Number(row.purchase_order_id)).push({
      id: Number(row.id), productId: Number(row.product_id), productName: row.product_name,
      quantity: Number(row.quantity), unitCost: preciseCost(row.unit_cost), lineTotal: money(row.line_total),
    });
  }
  return map;
}

router.get('/bootstrap', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const [suppliers, branches, products, stock] = await Promise.all([
      req.tdb.all('SELECT * FROM {s}.suppliers ORDER BY active DESC, name'),
      req.tdb.all('SELECT id, name, active FROM {s}.branches ORDER BY active DESC, name'),
      req.tdb.all(`SELECT p.id, p.name, p.price::float AS price, COALESCE(p.unit_cost,0)::float AS unit_cost, COALESCE(c.name,'Sin categoría') AS category_name FROM {s}.products p LEFT JOIN {s}.categories c ON c.id=p.category_id WHERE p.active=1 ORDER BY p.name`),
      req.tdb.all(`SELECT bi.branch_id, bi.product_id, bi.quantity::float AS quantity FROM {s}.branch_inventory bi ORDER BY bi.branch_id, bi.product_id`),
    ]);
    res.json({
      suppliers: suppliers.map((row) => ({ ...row, id: Number(row.id), active: Number(row.active) })),
      branches: branches.map((row) => ({ id: Number(row.id), name: row.name, active: Number(row.active) })),
      products: products.map((row) => ({ id: Number(row.id), name: row.name, price: money(row.price), unitCost: preciseCost(row.unit_cost), categoryName: row.category_name })),
      branchStock: stock.map((row) => ({ branchId: Number(row.branch_id), productId: Number(row.product_id), quantity: Number(row.quantity) })),
    });
  } catch (error) { next(error); }
});

router.post('/suppliers', async (req, res, next) => {
  try {
    const name = safe(req.body?.name, 120);
    if (name.length < 2) return res.status(400).json({ error: 'Escribe el nombre del proveedor' });
    const row = await req.tdb.get(
      `INSERT INTO {s}.suppliers (name,tax_id,contact_name,phone,email,address,notes,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name, safe(req.body?.taxId, 30), safe(req.body?.contactName, 100), safe(req.body?.phone, 30), safe(req.body?.email, 120), safe(req.body?.address, 220), safe(req.body?.notes, 300), req.body?.active === false ? 0 : 1]
    );
    await writePurchaseAudit(req.tdb, 'supplier', row.id, 'created', { name }, req.user.username);
    res.json({ ok: true, id: Number(row.id) });
  } catch (error) { next(error); }
});

router.put('/suppliers/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id); const name = safe(req.body?.name, 120);
    if (!id || name.length < 2) return res.status(400).json({ error: 'Proveedor inválido' });
    const result = await req.tdb.run(
      `UPDATE {s}.suppliers SET name=$1,tax_id=$2,contact_name=$3,phone=$4,email=$5,address=$6,notes=$7,active=$8,updated_at=now() WHERE id=$9`,
      [name, safe(req.body?.taxId,30), safe(req.body?.contactName,100), safe(req.body?.phone,30), safe(req.body?.email,120), safe(req.body?.address,220), safe(req.body?.notes,300), req.body?.active === false ? 0 : 1, id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Proveedor no encontrado' });
    await writePurchaseAudit(req.tdb, 'supplier', id, 'updated', { name, active: req.body?.active !== false }, req.user.username);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete('/suppliers/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await req.tdb.run('UPDATE {s}.suppliers SET active=0,updated_at=now() WHERE id=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Proveedor no encontrado' });
    await writePurchaseAudit(req.tdb, 'supplier', id, 'deactivated', {}, req.user.username);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/orders', async (req, res, next) => {
  try {
    const supplierId = Number(req.body?.supplierId); const branchId = Number(req.body?.branchId);
    const orderDate = validDate(req.body?.orderDate); const expectedDate = validDate(req.body?.expectedDate) || null;
    const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!supplierId || !branchId || !orderDate) return res.status(400).json({ error: 'Proveedor, sucursal y fecha son obligatorios' });
    if (!inputItems.length) return res.status(400).json({ error: 'Agrega al menos un producto' });
    const result = await req.tdb.tx(async (tx) => {
      const supplier = await tx.get('SELECT id,name FROM {s}.suppliers WHERE id=$1 AND active=1', [supplierId]);
      const branch = await tx.get('SELECT id,name FROM {s}.branches WHERE id=$1 AND active=1', [branchId]);
      if (!supplier || !branch) throw badRequest('Proveedor o sucursal no disponible');
      const ids = [...new Set(inputItems.map((row) => Number(row.productId)).filter(Boolean))];
      const products = await tx.all('SELECT id,name FROM {s}.products WHERE id=ANY($1::int[]) AND active=1', [ids]);
      const productMap = new Map(products.map((row) => [Number(row.id), row]));
      const items = inputItems.map((row) => {
        const product = productMap.get(Number(row.productId)); const quantity = Number(row.quantity); const unitCost = Number(row.unitCost);
        if (!product || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) throw badRequest('Revisa productos, cantidades y costos de la orden');
        return { productId: Number(product.id), productName: product.name, quantity: Number(quantity.toFixed(4)), unitCost: preciseCost(unitCost), lineTotal: money(quantity * unitCost) };
      });
      const total = money(items.reduce((sum, row) => sum + row.lineTotal, 0));
      const order = await tx.get(
        `INSERT INTO {s}.purchase_orders (supplier_id,supplier_name,branch_id,branch_name,status,order_date,expected_date,subtotal,total,notes,created_by)
         VALUES ($1,$2,$3,$4,'ordered',$5::date,$6::date,$7,$7,$8,$9) RETURNING id`,
        [supplier.id, supplier.name, branch.id, branch.name, orderDate, expectedDate, total, safe(req.body?.notes,300), req.user.username]
      );
      const number = `OC-${orderDate.replaceAll('-','')}-${String(order.id).padStart(5,'0')}`;
      await tx.run('UPDATE {s}.purchase_orders SET order_number=$1 WHERE id=$2', [number, order.id]);
      for (const item of items) await tx.run(
        `INSERT INTO {s}.purchase_order_items (purchase_order_id,product_id,product_name,quantity,unit_cost,line_total) VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id,item.productId,item.productName,item.quantity,item.unitCost,item.lineTotal]
      );
      await writePurchaseAudit(tx, 'purchase_order', order.id, 'created', { orderNumber:number,supplier:supplier.name,branch:branch.name,total,items }, req.user.username);
      return { id:Number(order.id), orderNumber:number };
    });
    res.json({ ok:true, ...result });
  } catch (error) { if (error.statusCode) return res.status(error.statusCode).json({ error:error.message }); next(error); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const TZ = req.timezone;
    res.set('Cache-Control','no-store');
    const params=[]; const where=[];
    const start=validDate(req.query.startDate); const end=validDate(req.query.endDate);
    if(start){params.push(start);where.push(`po.order_date >= $${params.length}::date`);} if(end){params.push(end);where.push(`po.order_date <= $${params.length}::date`);}
    if(Number(req.query.branch)>0){params.push(Number(req.query.branch));where.push(`po.branch_id=$${params.length}`);} if(Number(req.query.supplier)>0){params.push(Number(req.query.supplier));where.push(`po.supplier_id=$${params.length}`);}
    if(['ordered','received','cancelled'].includes(req.query.status)){params.push(req.query.status);where.push(`po.status=$${params.length}`);}
    const rows=await req.tdb.all(`SELECT po.*,to_char(po.created_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') AS created_at,to_char(po.received_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') AS received_at FROM {s}.purchase_orders po ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY po.order_date DESC,po.id DESC LIMIT 500`,params);
    const itemMap=await loadOrderItems(req.tdb,rows.map(row=>Number(row.id)));
    res.json(rows.map(row=>serializeOrder(row,itemMap.get(Number(row.id))||[])));
  } catch(error){next(error);}
});

router.put('/orders/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const supplierId = Number(req.body?.supplierId); const branchId = Number(req.body?.branchId);
    const orderDate = validDate(req.body?.orderDate); const expectedDate = validDate(req.body?.expectedDate) || null;
    const inputItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!id || !supplierId || !branchId || !orderDate) return res.status(400).json({ error: 'Proveedor, sucursal y fecha son obligatorios' });
    if (!inputItems.length) return res.status(400).json({ error: 'Agrega al menos un producto' });

    const result = await req.tdb.tx(async (tx) => {
      const existing = await tx.get('SELECT * FROM {s}.purchase_orders WHERE id=$1 FOR UPDATE', [id]);
      if (!existing) throw Object.assign(new Error('Orden no encontrada'), { statusCode: 404 });
      if (existing.status !== 'ordered') throw conflict('Sólo puedes editar órdenes pendientes que todavía no afectan inventario');
      const supplier = await tx.get('SELECT id,name FROM {s}.suppliers WHERE id=$1', [supplierId]);
      const branch = await tx.get('SELECT id,name FROM {s}.branches WHERE id=$1', [branchId]);
      if (!supplier || !branch) throw badRequest('Proveedor o sucursal no disponible');
      const ids = [...new Set(inputItems.map((row) => Number(row.productId)).filter(Boolean))];
      const products = await tx.all('SELECT id,name FROM {s}.products WHERE id=ANY($1::int[]) AND active=1', [ids]);
      const productMap = new Map(products.map((row) => [Number(row.id), row]));
      const items = inputItems.map((row) => {
        const product = productMap.get(Number(row.productId)); const quantity = Number(row.quantity); const unitCost = Number(row.unitCost);
        if (!product || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) throw badRequest('Revisa productos, cantidades y costos de la orden');
        return { productId: Number(product.id), productName: product.name, quantity: Number(quantity.toFixed(4)), unitCost: preciseCost(unitCost), lineTotal: money(quantity * unitCost) };
      });
      const total = money(items.reduce((sum, row) => sum + row.lineTotal, 0));
      await tx.run(
        `UPDATE {s}.purchase_orders
         SET supplier_id=$1,supplier_name=$2,branch_id=$3,branch_name=$4,order_date=$5::date,
             expected_date=$6::date,subtotal=$7,total=$7,notes=$8,updated_at=now()
         WHERE id=$9`,
        [supplier.id, supplier.name, branch.id, branch.name, orderDate, expectedDate, total, safe(req.body?.notes, 300), id]
      );
      await tx.run('DELETE FROM {s}.purchase_order_items WHERE purchase_order_id=$1', [id]);
      for (const item of items) await tx.run(
        `INSERT INTO {s}.purchase_order_items (purchase_order_id,product_id,product_name,quantity,unit_cost,line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, item.productId, item.productName, item.quantity, item.unitCost, item.lineTotal]
      );
      await writePurchaseAudit(tx, 'purchase_order', id, 'updated', {
        orderNumber: existing.order_number, supplier: supplier.name, branch: branch.name, total, items,
      }, req.user.username);
      return { orderNumber: existing.order_number };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.delete('/orders/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const result = await req.tdb.tx(async (tx) => {
      const order = await tx.get('SELECT id,order_number,status,total FROM {s}.purchase_orders WHERE id=$1 FOR UPDATE', [id]);
      if (!order) throw Object.assign(new Error('Orden no encontrada'), { statusCode: 404 });
      if (order.status === 'received') throw conflict('Una orden recibida no puede borrarse porque ya modificó inventario y costos');
      await tx.run('DELETE FROM {s}.purchase_order_items WHERE purchase_order_id=$1', [id]);
      await tx.run('DELETE FROM {s}.purchase_orders WHERE id=$1', [id]);
      await writePurchaseAudit(tx, 'purchase_order', id, 'deleted', {
        orderNumber: order.order_number, previousStatus: order.status, total: money(order.total),
      }, req.user.username);
      return { orderNumber: order.order_number };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.post('/orders/:id/receive', async (req,res,next)=>{
  try{
    const id=Number(req.params.id);
    const result=await req.tdb.tx(async(tx)=>{
      const order=await tx.get(`SELECT * FROM {s}.purchase_orders WHERE id=$1 FOR UPDATE`,[id]);
      if(!order)throw Object.assign(new Error('Orden no encontrada'),{statusCode:404});
      if(order.status!=='ordered')throw Object.assign(new Error('La orden ya fue recibida o cancelada'),{statusCode:409});
      const items=(await loadOrderItems(tx,[id])).get(id)||[];
      const costUpdates=[];
      for(const item of items){
        const product=await tx.get('SELECT id,COALESCE(unit_cost,0)::float AS unit_cost FROM {s}.products WHERE id=$1 FOR UPDATE',[item.productId]);
        if(!product)throw badRequest(`El producto ${item.productName} ya no existe`);
        const stock=await currentProductStock(tx,item.productId); const oldCost=preciseCost(product.unit_cost);
        const weighted=preciseCost(((stock*oldCost)+(item.quantity*item.unitCost))/(stock+item.quantity));
        await tx.run('UPDATE {s}.products SET unit_cost=$1 WHERE id=$2',[weighted,item.productId]);
        await tx.run(`INSERT INTO {s}.inventory_movements (product_id,type,quantity,unit_cost,total_cost,notes,created_by,branch_id,purchase_order_id,source_type) VALUES ($1,'entrada',$2,$3,$4,$5,$6,$7,$8,'purchase')`,[item.productId,item.quantity,item.unitCost,item.lineTotal,`Compra ${order.order_number}`,req.user.username,order.branch_id,id]);
        await tx.run(`INSERT INTO {s}.branch_inventory (branch_id,product_id,quantity,initial_quantity,baseline_started_at,updated_at) VALUES ($1,$2,$3,0,now(),now()) ON CONFLICT(branch_id,product_id) DO UPDATE SET quantity={s}.branch_inventory.quantity+EXCLUDED.quantity,updated_at=now()`,[order.branch_id,item.productId,item.quantity]);
        costUpdates.push({productId:item.productId,productName:item.productName,previousStock:stock,previousCost:oldCost,purchasedQuantity:item.quantity,purchaseCost:item.unitCost,weightedCost:weighted});
      }
      await tx.run(`UPDATE {s}.purchase_orders SET status='received',received_by=$1,received_at=now(),updated_at=now() WHERE id=$2`,[req.user.username,id]);
      await writePurchaseAudit(tx,'purchase_order',id,'received',{orderNumber:order.order_number,total:Number(order.total),items,costUpdates},req.user.username);
      return {orderNumber:order.order_number,items:items.length,total:money(order.total),costUpdates};
    });
    res.json({ok:true,...result});
  }catch(error){if(error.statusCode)return res.status(error.statusCode).json({error:error.message});next(error);}
});

router.post('/orders/:id/cancel',async(req,res,next)=>{
  try{const id=Number(req.params.id);const order=await req.tdb.get(`UPDATE {s}.purchase_orders SET status='cancelled',cancelled_by=$1,cancelled_at=now(),updated_at=now() WHERE id=$2 AND status='ordered' RETURNING id,order_number`,[req.user.username,id]);if(!order)return res.status(409).json({error:'La orden ya fue recibida, cancelada o no existe'});await writePurchaseAudit(req.tdb,'purchase_order',id,'cancelled',{reason:safe(req.body?.reason,200)},req.user.username);res.json({ok:true});}catch(error){next(error);}
});

router.get('/transfer-stock', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const fromId = Number(req.query.fromBranchId);
    const toId = Number(req.query.toBranchId);
    if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0 || fromId === toId) return res.status(400).json({ error: 'Selecciona sucursales de origen y destino diferentes' });

    const branches = await req.tdb.all(
      'SELECT id,name FROM {s}.branches WHERE id=ANY($1::int[]) AND active=1 ORDER BY id',
      [[fromId, toId]]
    );
    const from = branches.find((row) => Number(row.id) === fromId);
    const to = branches.find((row) => Number(row.id) === toId);
    if (!from || !to) return res.status(404).json({ error: 'Una sucursal ya no está disponible' });

    const products = await req.tdb.all(
      `SELECT p.id,p.name,COALESCE(c.name,'Sin categoría') AS category_name,
              COALESCE(source.quantity,0)::float AS from_quantity,
              COALESCE(destination.quantity,0)::float AS to_quantity
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id=p.category_id
       LEFT JOIN {s}.branch_inventory source ON source.product_id=p.id AND source.branch_id=$1
       LEFT JOIN {s}.branch_inventory destination ON destination.product_id=p.id AND destination.branch_id=$2
       WHERE p.active=1
       ORDER BY p.name`,
      [fromId, toId]
    );
    const rows = products.map((row) => ({
      productId: Number(row.id),
      productName: row.name,
      categoryName: row.category_name,
      fromQuantity: n(row.from_quantity),
      availableFrom: Math.max(0, n(row.from_quantity)),
      toQuantity: n(row.to_quantity),
    }));
    const summaryFor = (key) => ({
      totalUnits: n(rows.reduce((sum, row) => sum + row[key], 0)),
      productsWithStock: rows.filter((row) => row[key] > 0).length,
    });
    res.json({
      generatedAt: new Date().toISOString(),
      from: { id: fromId, name: from.name, ...summaryFor('fromQuantity') },
      to: { id: toId, name: to.name, ...summaryFor('toQuantity') },
      products: rows,
    });
  } catch (error) { next(error); }
});

router.get('/transfers',async(req,res,next)=>{
  try{const TZ=req.timezone;const rows=await req.tdb.all(`SELECT it.*,to_char(it.created_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') AS created_at FROM {s}.inventory_transfers it ORDER BY it.id DESC LIMIT 300`);const ids=rows.map(r=>Number(r.id));const itemRows=ids.length?await req.tdb.all(`SELECT * FROM {s}.inventory_transfer_items WHERE transfer_id=ANY($1::int[]) ORDER BY id`,[ids]):[];const map=new Map();for(const item of itemRows){if(!map.has(Number(item.transfer_id)))map.set(Number(item.transfer_id),[]);map.get(Number(item.transfer_id)).push({productId:Number(item.product_id),productName:item.product_name,quantity:Number(item.quantity)});}res.json(rows.map(row=>({...row,id:Number(row.id),from_branch_id:Number(row.from_branch_id),to_branch_id:Number(row.to_branch_id),items:map.get(Number(row.id))||[]})));}catch(error){next(error);}
});

router.post('/transfers', async (req, res, next) => {
  try {
    const fromId = Number(req.body?.fromBranchId);
    const toId = Number(req.body?.toBranchId);
    const input = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!Number.isInteger(fromId) || fromId <= 0 || !Number.isInteger(toId) || toId <= 0 || fromId === toId || !input.length) return res.status(400).json({ error: 'Selecciona sucursales diferentes y al menos un producto' });
    if (input.length > 500) return res.status(400).json({ error: 'Sólo puedes trasladar hasta 500 productos por operación' });

    const result = await req.tdb.tx(async (tx) => {
      const branches = await tx.all('SELECT id,name FROM {s}.branches WHERE id=ANY($1::int[]) AND active=1', [[fromId, toId]]);
      const from = branches.find((branch) => Number(branch.id) === fromId);
      const to = branches.find((branch) => Number(branch.id) === toId);
      if (!from || !to) throw badRequest('Una sucursal no está disponible');

      const ids = [...new Set(input.map((row) => Number(row.productId)).filter((id) => Number.isInteger(id) && id > 0))];
      const products = await tx.all('SELECT id,name FROM {s}.products WHERE id=ANY($1::int[]) AND active=1', [ids]);
      const productMap = new Map(products.map((product) => [Number(product.id), product]));
      const grouped = new Map();
      for (const row of input) {
        const product = productMap.get(Number(row.productId));
        const rawQuantity = Number(row.quantity);
        const quantity = n(rawQuantity);
        if (!product || !Number.isFinite(rawQuantity) || quantity <= 0 || quantity > 9999999999) throw badRequest('Revisa los productos y cantidades del traslado');
        const current = grouped.get(Number(product.id)) || { productId: Number(product.id), productName: product.name, quantity: 0 };
        current.quantity = n(current.quantity + quantity);
        if (current.quantity > 9999999999) throw badRequest(`La cantidad de ${product.name} excede el máximo permitido`);
        grouped.set(Number(product.id), current);
      }
      const items = [...grouped.values()].sort((a, b) => a.productId - b.productId);
      if (!items.length) throw badRequest('Agrega al menos un producto válido');

      const [firstBranchId, secondBranchId] = [fromId, toId].sort((a, b) => a - b);
      for (const item of items) {
        await tx.run(
          `INSERT INTO {s}.branch_inventory (branch_id,product_id,quantity,initial_quantity,baseline_started_at,updated_at)
           VALUES ($1,$2,0,0,now(),now()),($3,$2,0,0,now(),now())
           ON CONFLICT(branch_id,product_id) DO NOTHING`,
          [firstBranchId, item.productId, secondBranchId]
        );
      }
      const stockRows = await tx.all(
        `SELECT branch_id,product_id,quantity::float AS quantity
         FROM {s}.branch_inventory
         WHERE branch_id=ANY($1::int[]) AND product_id=ANY($2::int[])
         ORDER BY branch_id,product_id
         FOR UPDATE`,
        [[fromId, toId], items.map((item) => item.productId)]
      );
      const stockMap = new Map(stockRows.map((row) => [`${row.branch_id}:${row.product_id}`, n(row.quantity)]));
      const movements = items.map((item) => {
        const fromBefore = stockMap.get(`${fromId}:${item.productId}`) || 0;
        const toBefore = stockMap.get(`${toId}:${item.productId}`) || 0;
        if (fromBefore < item.quantity) throw conflict(`Existencia actual insuficiente de ${item.productName} en ${from.name}. Disponible: ${Math.max(0, fromBefore)}`);
        return {
          ...item,
          fromBefore,
          fromAfter: n(fromBefore - item.quantity),
          toBefore,
          toAfter: n(toBefore + item.quantity),
        };
      });

      const transfer = await tx.get(
        `INSERT INTO {s}.inventory_transfers (from_branch_id,from_branch_name,to_branch_id,to_branch_name,notes,created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,created_at`,
        [fromId, from.name, toId, to.name, safe(req.body?.notes, 300), req.user.username]
      );
      const number = `TR-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${String(transfer.id).padStart(5, '0')}`;
      await tx.run('UPDATE {s}.inventory_transfers SET transfer_number=$1 WHERE id=$2', [number, transfer.id]);
      for (const item of movements) {
        await tx.run('UPDATE {s}.branch_inventory SET quantity=$1,updated_at=now() WHERE branch_id=$2 AND product_id=$3', [item.fromAfter, fromId, item.productId]);
        await tx.run('UPDATE {s}.branch_inventory SET quantity=$1,updated_at=now() WHERE branch_id=$2 AND product_id=$3', [item.toAfter, toId, item.productId]);
        await tx.run(
          'INSERT INTO {s}.inventory_transfer_items (transfer_id,product_id,product_name,quantity) VALUES ($1,$2,$3,$4)',
          [transfer.id, item.productId, item.productName, item.quantity]
        );
      }
      await writePurchaseAudit(tx, 'transfer', transfer.id, 'completed', { transferNumber: number, from: from.name, to: to.name, items: movements }, req.user.username);
      return { id: Number(transfer.id), transferNumber: number, fromBranch: from.name, toBranch: to.name, items: movements };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    next(error);
  }
});

router.get('/report',async(req,res,next)=>{
  try{const TZ=req.timezone;res.set('Cache-Control','no-store');const start=validDate(req.query.startDate),end=validDate(req.query.endDate);if(!start||!end||start>end)return res.status(400).json({error:'Rango de fechas inválido'});const params=[start,end];let branchClause='';if(Number(req.query.branch)>0){params.push(Number(req.query.branch));branchClause=`AND po.branch_id=$${params.length}`;}
    const rows=await req.tdb.all(`SELECT po.id,po.order_number,po.supplier_name,po.branch_name,po.total::float AS total,to_char(po.received_at AT TIME ZONE '${TZ}','YYYY-MM-DD') AS purchase_date,poi.product_id,poi.product_name,poi.quantity::float AS quantity,poi.unit_cost::float AS unit_cost,poi.line_total::float AS line_total FROM {s}.purchase_orders po JOIN {s}.purchase_order_items poi ON poi.purchase_order_id=po.id WHERE po.status='received' AND (po.received_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date ${branchClause} ORDER BY po.received_at,po.id,poi.id`,params);
    const seriesMap=new Map(),productMap=new Map(),orderSet=new Set();for(const row of rows){orderSet.add(Number(row.id));const day=row.purchase_date;const series=seriesMap.get(day)||{date:day,total:0,quantity:0,orders:new Set()};series.total+=Number(row.line_total);series.quantity+=Number(row.quantity);series.orders.add(Number(row.id));seriesMap.set(day,series);const key=Number(row.product_id);const product=productMap.get(key)||{productId:key,productName:row.product_name,quantity:0,total:0,orders:new Set()};product.quantity+=Number(row.quantity);product.total+=Number(row.line_total);product.orders.add(Number(row.id));productMap.set(key,product);}
    const total=money(rows.reduce((sum,row)=>sum+Number(row.line_total),0));const quantity=Number(rows.reduce((sum,row)=>sum+Number(row.quantity),0).toFixed(4));res.json({filters:{startDate:start,endDate:end,branch:String(req.query.branch||'all')},summary:{total,quantity,orders:orderSet.size,products:productMap.size,averageOrder:orderSet.size?money(total/orderSet.size):0},series:[...seriesMap.values()].map(r=>({date:r.date,total:money(r.total),quantity:Number(r.quantity.toFixed(4)),orders:r.orders.size})),products:[...productMap.values()].map(r=>({productId:r.productId,productName:r.productName,quantity:Number(r.quantity.toFixed(4)),total:money(r.total),orders:r.orders.size})).sort((a,b)=>b.total-a.total)});
  }catch(error){next(error);}
});

router.get('/audit/:entity/:id',async(req,res,next)=>{try{const TZ=req.timezone;const entity=['purchase_order','supplier','transfer'].includes(req.params.entity)?req.params.entity:'';if(!entity)return res.status(400).json({error:'Entidad inválida'});const rows=await req.tdb.all(`SELECT id,action,payload,actor,to_char(created_at AT TIME ZONE '${TZ}','DD/MM/YYYY HH24:MI') AS created_at FROM {s}.purchase_audit_log WHERE entity_type=$1 AND entity_id=$2 ORDER BY id DESC`,[entity,Number(req.params.id)]);res.json(rows.map(row=>({...row,id:Number(row.id),payload:(()=>{try{return JSON.parse(row.payload||'{}')}catch{return{}}})()})));}catch(error){next(error);}});

module.exports=router;
