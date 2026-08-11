const express = require('express');
const crypto = require('node:crypto');
const { q, tdb } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { decrypt } = require('../utils/crypto');
const { operationalOrderNote } = require('../utils/orderNotes');

const router = express.Router();
const KDS_STATUSES = new Set(['pending', 'preparing', 'ready', 'completed']);
const DRINK_WORDS = [
  'bebida', 'refresco', 'soda', 'agua', 'jugo', 'cafe', 'café', 'te', 'té',
  'cerveza', 'vino', 'coctel', 'cóctel', 'licor', 'malteada', 'smoothie', 'barra',
];

function cleanSlug(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function cleanColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#ff6b35';
}

function createToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function parseItems(raw) {
  try {
    const items = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function itemProductId(item) {
  const id = Number(item?.id ?? item?.productId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function publicAreaPath(slug, token) {
  return `/kds/${slug}/${token}`;
}

async function resolvePublicArea(slug, token) {
  const tenantResult = await q(
    `SELECT id, slug, business_name, logo, primary_color, account_status, billing_status
     FROM tenants WHERE slug = $1 LIMIT 1`,
    [cleanSlug(slug)]
  );
  const tenant = tenantResult.rows[0];
  if (!tenant || tenant.account_status !== 'active' || tenant.billing_status === 'suspended') return null;
  const tenantDb = tdb(tenant.slug);
  const area = await tenantDb.get(
    `SELECT a.id, a.name, a.branch_id, a.color, a.active, b.name AS branch_name
     FROM {s}.kds_areas a
     LEFT JOIN {s}.branches b ON b.id = a.branch_id
     WHERE a.access_token = $1 AND a.active = 1
     LIMIT 1`,
    [String(token || '')]
  );
  return area ? { tenant, tenantDb, area } : null;
}

async function getAreaAssignments(tenantDb, areaId) {
  const [categoryRows, productRows] = await Promise.all([
    tenantDb.all('SELECT category_id FROM {s}.kds_area_categories WHERE area_id = $1', [areaId]),
    tenantDb.all('SELECT product_id FROM {s}.kds_area_products WHERE area_id = $1', [areaId]),
  ]);
  return {
    categoryIds: categoryRows.map((row) => Number(row.category_id)),
    productIds: productRows.map((row) => Number(row.product_id)),
  };
}

function itemBelongsToArea(item, productById, assignments) {
  const productId = itemProductId(item);
  if (!productId) return false;
  if (assignments.productIds.has(productId)) return true;
  const categoryId = Number(productById.get(productId)?.category_id);
  return Number.isInteger(categoryId) && assignments.categoryIds.has(categoryId);
}

async function buildKdsPayload(tenant, tenantDb, area) {
  const [categoryAssignments, productAssignments, orderRows, tableRoundRows, settingsRows] = await Promise.all([
    tenantDb.all('SELECT category_id FROM {s}.kds_area_categories WHERE area_id = $1', [area.id]),
    tenantDb.all('SELECT product_id FROM {s}.kds_area_products WHERE area_id = $1', [area.id]),
    tenantDb.all(
      `SELECT o.id, o.customer_id, o.items, o.status AS order_status, o.channel, o.delivery, o.notes, o.order_notes,
              o.service_branch_id, o.service_branch_name, o.pickup_branch_id, o.pickup_branch_name, o.created_at,
              s.status AS kds_status, s.started_at, s.ready_at, s.completed_at, s.updated_at
       FROM {s}.orders o
       LEFT JOIN {s}.kds_ticket_states s ON s.order_id = o.id AND s.area_id = $1
       WHERE o.status <> 'cancelado'
         AND o.table_account_id IS NULL
         AND (o.created_at AT TIME ZONE 'America/Mexico_City')::date = (now() AT TIME ZONE 'America/Mexico_City')::date
         AND ($2::int IS NULL OR o.service_branch_id = $2 OR o.pickup_branch_id = $2)
       ORDER BY o.created_at ASC`,
      [area.id, area.branch_id || null]
    ),
    tenantDb.all(
      `SELECT (-tr.id) AS id, NULL::int AS customer_id, tr.items, 'pendiente' AS order_status,
              'table_round' AS channel, 'mesa' AS delivery, tr.notes, tr.notes AS order_notes,
              NULLIF(ta.branch_id, 0) AS service_branch_id, b.name AS service_branch_name,
              NULL::int AS pickup_branch_id, NULL::text AS pickup_branch_name, tr.created_at,
              s.status AS kds_status, s.started_at, s.ready_at, s.completed_at, s.updated_at,
              ta.table_number, tr.round_number, ta.waiter_name
       FROM {s}.table_rounds tr
       JOIN {s}.table_accounts ta ON ta.id = tr.account_id
       LEFT JOIN {s}.branches b ON b.id = NULLIF(ta.branch_id, 0)
       LEFT JOIN {s}.kds_ticket_states s ON s.order_id = -tr.id AND s.area_id = $1
       WHERE (tr.created_at AT TIME ZONE 'America/Mexico_City')::date = (now() AT TIME ZONE 'America/Mexico_City')::date
         AND ($2::int IS NULL OR ta.branch_id = $2)
       ORDER BY tr.created_at ASC`,
      [area.id, area.branch_id || null]
    ),
    tenantDb.all("SELECT key, value FROM {s}.settings WHERE key IN ('business_name','currency')"),
  ]);

  const parsedOrders = [...orderRows, ...tableRoundRows].map((row) => ({ ...row, parsedItems: parseItems(row.items) }));
  const productIds = [...new Set(parsedOrders.flatMap((order) => order.parsedItems.map(itemProductId).filter(Boolean)))];
  const products = productIds.length
    ? await tenantDb.all(
        `SELECT p.id, p.name, p.category_id, c.name AS category_name
         FROM {s}.products p LEFT JOIN {s}.categories c ON c.id = p.category_id
         WHERE p.id = ANY($1::int[])`,
        [productIds]
      )
    : [];
  const productById = new Map(products.map((product) => [Number(product.id), product]));
  const assignments = {
    categoryIds: new Set(categoryAssignments.map((row) => Number(row.category_id))),
    productIds: new Set(productAssignments.map((row) => Number(row.product_id))),
  };

  const allAssignmentRows = await tenantDb.all(
    `SELECT a.id AS area_id, a.name, a.branch_id,
            COALESCE(array_agg(DISTINCT ac.category_id) FILTER (WHERE ac.category_id IS NOT NULL), '{}') AS category_ids,
            COALESCE(array_agg(DISTINCT ap.product_id) FILTER (WHERE ap.product_id IS NOT NULL), '{}') AS product_ids
     FROM {s}.kds_areas a
     LEFT JOIN {s}.kds_area_categories ac ON ac.area_id = a.id
     LEFT JOIN {s}.kds_area_products ap ON ap.area_id = a.id
     WHERE a.active = 1
     GROUP BY a.id, a.name, a.branch_id`
  );
  const areaRules = allAssignmentRows.map((row) => ({
    id: Number(row.area_id),
    name: row.name,
    branchId: row.branch_id ? Number(row.branch_id) : null,
    categoryIds: new Set((row.category_ids || []).map(Number)),
    productIds: new Set((row.product_ids || []).map(Number)),
  }));

  const customerIds = [...new Set(parsedOrders.map((order) => Number(order.customer_id)).filter(Boolean))];
  const customers = customerIds.length
    ? await tenantDb.all('SELECT id, name_enc FROM {s}.customers WHERE id = ANY($1::int[])', [customerIds])
    : [];
  const customerById = new Map(customers.map((customer) => [Number(customer.id), decrypt(customer.name_enc) || 'Cliente']));

  const tickets = [];
  for (const order of parsedOrders) {
    const areaItems = order.parsedItems.filter((item) => itemBelongsToArea(item, productById, assignments));
    if (!areaItems.length) continue;
    const status = KDS_STATUSES.has(order.kds_status) ? order.kds_status : 'pending';
    if (status === 'completed') continue;
    const orderBranchId = Number(order.service_branch_id || order.pickup_branch_id) || null;
    const applicableAreaRules = areaRules.filter((rule) => !rule.branchId || rule.branchId === orderBranchId);
    const routedAreas = applicableAreaRules
      .filter((rule) => order.parsedItems.some((item) => itemBelongsToArea(item, productById, rule)))
      .map((rule) => ({ id: rule.id, name: rule.name }));
    const otherItems = order.parsedItems.filter((item) =>
      !itemBelongsToArea(item, productById, assignments)
      && applicableAreaRules.some((rule) => rule.id !== Number(area.id) && itemBelongsToArea(item, productById, rule))
    );
    tickets.push({
      id: Number(order.id),
      status,
      orderStatus: order.order_status,
      channel: order.channel,
      delivery: order.delivery,
      notes: operationalOrderNote(order),
      branchName: order.service_branch_name || order.pickup_branch_name || '',
      customerName: customerById.get(Number(order.customer_id)) || '',
      createdAt: order.created_at,
      startedAt: order.started_at,
      readyAt: order.ready_at,
      areaItems,
      otherItems,
      routedAreas,
      isMixed: routedAreas.length > 1,
      tableNumber: order.table_number ? Number(order.table_number) : null,
      roundNumber: order.round_number ? Number(order.round_number) : null,
      waiterName: order.waiter_name || '',
    });
  }

  const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
  return {
    tenant: {
      slug: tenant.slug,
      businessName: settings.business_name || tenant.business_name,
      logo: tenant.logo || '',
      primaryColor: tenant.primary_color || '#ff6b35',
      currency: settings.currency || 'MXN',
    },
    area: {
      id: Number(area.id),
      name: area.name,
      branchId: area.branch_id ? Number(area.branch_id) : null,
      branchName: area.branch_name || '',
      color: area.color || tenant.primary_color || '#ff6b35',
    },
    serverTime: new Date().toISOString(),
    tickets,
  };
}

// Acceso por liga privada. El token funciona como llave de la pantalla KDS.
router.get('/public/:slug/:token', async (req, res, next) => {
  try {
    const found = await resolvePublicArea(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Pantalla KDS no encontrada o desactivada' });
    res.json(await buildKdsPayload(found.tenant, found.tenantDb, found.area));
  } catch (error) {
    next(error);
  }
});

router.patch('/public/:slug/:token/orders/:orderId', async (req, res, next) => {
  try {
    const found = await resolvePublicArea(req.params.slug, req.params.token);
    if (!found) return res.status(404).json({ error: 'Pantalla KDS no encontrada o desactivada' });
    const orderId = Number(req.params.orderId);
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!Number.isInteger(orderId) || orderId === 0 || !KDS_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Estado de comanda inválido' });
    }
    const visible = await buildKdsPayload(found.tenant, found.tenantDb, found.area);
    if (!visible.tickets.some((ticket) => Number(ticket.id) === orderId)) {
      return res.status(404).json({ error: 'La comanda no corresponde a esta área o ya fue retirada' });
    }

    await found.tenantDb.run(
      `INSERT INTO {s}.kds_ticket_states
       (area_id, order_id, status, started_at, ready_at, completed_at, updated_at)
       VALUES ($1, $2, $3,
         CASE WHEN $3 = 'preparing' THEN now() ELSE NULL END,
         CASE WHEN $3 = 'ready' THEN now() ELSE NULL END,
         CASE WHEN $3 = 'completed' THEN now() ELSE NULL END,
         now())
       ON CONFLICT (area_id, order_id) DO UPDATE SET
         status = EXCLUDED.status,
         started_at = CASE WHEN EXCLUDED.status = 'preparing' THEN COALESCE({s}.kds_ticket_states.started_at, now()) ELSE {s}.kds_ticket_states.started_at END,
         ready_at = CASE WHEN EXCLUDED.status = 'ready' THEN now() ELSE {s}.kds_ticket_states.ready_at END,
         completed_at = CASE WHEN EXCLUDED.status = 'completed' THEN now() ELSE {s}.kds_ticket_states.completed_at END,
         updated_at = now()`,
      [found.area.id, orderId, status]
    );
    res.json({ ok: true, orderId, status });
  } catch (error) {
    next(error);
  }
});

router.use(requireAuth);
router.use(requireOwner);

async function listAreas(req) {
  const areas = await req.tdb.all(
    `SELECT a.id, a.name, a.branch_id, a.color, a.access_token, a.active, a.created_at,
            b.name AS branch_name
     FROM {s}.kds_areas a
     LEFT JOIN {s}.branches b ON b.id = a.branch_id
     ORDER BY a.active DESC, a.name`
  );
  return Promise.all(areas.map(async (area) => {
    const assignments = await getAreaAssignments(req.tdb, area.id);
    return {
      id: Number(area.id),
      name: area.name,
      branchId: area.branch_id ? Number(area.branch_id) : null,
      branchName: area.branch_name || '',
      color: area.color,
      active: Boolean(Number(area.active)),
      categoryIds: assignments.categoryIds,
      productIds: assignments.productIds,
      link: publicAreaPath(req.tenant.slug, area.access_token),
    };
  }));
}

router.get('/', async (req, res, next) => {
  try {
    const [areas, categories, products, branches] = await Promise.all([
      listAreas(req),
      req.tdb.all('SELECT id, name, sort FROM {s}.categories ORDER BY sort, name'),
      req.tdb.all('SELECT id, name, category_id FROM {s}.products WHERE active = 1 ORDER BY name'),
      req.tdb.all('SELECT id, name, active FROM {s}.branches WHERE active = 1 ORDER BY name'),
    ]);
    res.json({ areas, categories, products, branches });
  } catch (error) {
    next(error);
  }
});

async function validateAndSaveArea(req, res, areaId = null) {
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 60);
  const branchId = body.branchId ? Number(body.branchId) : null;
  const categoryIds = cleanIds(body.categoryIds);
  const productIds = cleanIds(body.productIds);
  const active = body.active === false || body.active === 0 || body.active === '0' ? 0 : 1;
  if (name.length < 2) return res.status(400).json({ error: 'Escribe el nombre del área de preparación' });
  if (!categoryIds.length && !productIds.length) {
    return res.status(400).json({ error: 'Asigna al menos una categoría o producto al área' });
  }
  if (branchId) {
    const branch = await req.tdb.get('SELECT id FROM {s}.branches WHERE id = $1 AND active = 1', [branchId]);
    if (!branch) return res.status(400).json({ error: 'La sucursal seleccionada no existe o está inactiva' });
  }

  let area;
  if (areaId) {
    area = await req.tdb.get(
      `UPDATE {s}.kds_areas SET name = $1, branch_id = $2, color = $3, active = $4, updated_at = now()
       WHERE id = $5 RETURNING *`,
      [name, branchId, cleanColor(body.color), active, areaId]
    );
    if (!area) return res.status(404).json({ error: 'Área KDS no encontrada' });
  } else {
    area = await req.tdb.get(
      `INSERT INTO {s}.kds_areas (name, branch_id, color, access_token, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, branchId, cleanColor(body.color), createToken(), active]
    );
  }

  await Promise.all([
    req.tdb.run('DELETE FROM {s}.kds_area_categories WHERE area_id = $1', [area.id]),
    req.tdb.run('DELETE FROM {s}.kds_area_products WHERE area_id = $1', [area.id]),
  ]);
  for (const categoryId of categoryIds) {
    await req.tdb.run(
      'INSERT INTO {s}.kds_area_categories (area_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [area.id, categoryId]
    );
  }
  for (const productId of productIds) {
    await req.tdb.run(
      'INSERT INTO {s}.kds_area_products (area_id, product_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [area.id, productId]
    );
  }
  res.json({ ok: true, id: Number(area.id) });
}

router.post('/', async (req, res, next) => {
  try {
    await validateAndSaveArea(req, res);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Área KDS inválida' });
    await validateAndSaveArea(req, res, id);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/rotate-token', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const area = await req.tdb.get(
      'UPDATE {s}.kds_areas SET access_token = $1, updated_at = now() WHERE id = $2 RETURNING access_token',
      [createToken(), id]
    );
    if (!area) return res.status(404).json({ error: 'Área KDS no encontrada' });
    res.json({ ok: true, link: publicAreaPath(req.tenant.slug, area.access_token) });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const found = await req.tdb.get('SELECT id FROM {s}.kds_areas WHERE id = $1', [id]);
    if (!found) return res.status(404).json({ error: 'Área KDS no encontrada' });
    await Promise.all([
      req.tdb.run('DELETE FROM {s}.kds_area_categories WHERE area_id = $1', [id]),
      req.tdb.run('DELETE FROM {s}.kds_area_products WHERE area_id = $1', [id]),
      req.tdb.run('DELETE FROM {s}.kds_ticket_states WHERE area_id = $1', [id]),
    ]);
    await req.tdb.run('DELETE FROM {s}.kds_areas WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.post('/setup/defaults', async (req, res, next) => {
  try {
    const existing = await req.tdb.get('SELECT COUNT(*)::int AS total FROM {s}.kds_areas');
    if (Number(existing?.total || 0) > 0) {
      return res.status(409).json({ error: 'Ya existen áreas KDS; edítalas para ajustar sus asignaciones' });
    }
    const categories = await req.tdb.all('SELECT id, name FROM {s}.categories ORDER BY name');
    if (!categories.length) return res.status(400).json({ error: 'Primero crea categorías de productos' });
    const drinkIds = categories
      .filter((category) => DRINK_WORDS.some((word) => String(category.name || '').toLowerCase().includes(word)))
      .map((category) => Number(category.id));
    const kitchenIds = categories.map((category) => Number(category.id)).filter((id) => !drinkIds.includes(id));

    if (kitchenIds.length) {
      const kitchen = await req.tdb.get(
        `INSERT INTO {s}.kds_areas (name, color, access_token, active)
         VALUES ('Cocina', '#f97316', $1, 1) RETURNING id`,
        [createToken()]
      );
      for (const categoryId of kitchenIds) {
        await req.tdb.run('INSERT INTO {s}.kds_area_categories (area_id, category_id) VALUES ($1, $2)', [kitchen.id, categoryId]);
      }
    }
    if (drinkIds.length) {
      const bar = await req.tdb.get(
        `INSERT INTO {s}.kds_areas (name, color, access_token, active)
         VALUES ('Barra', '#0ea5e9', $1, 1) RETURNING id`,
        [createToken()]
      );
      for (const categoryId of drinkIds) {
        await req.tdb.run('INSERT INTO {s}.kds_area_categories (area_id, category_id) VALUES ($1, $2)', [bar.id, categoryId]);
      }
    }
    res.json({ ok: true, areas: await listAreas(req) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
