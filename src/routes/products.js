const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

const upload = createImageUpload({
  scopeResolver: (req) => req.tenant.slug,
  allowedMimePattern: /^image\/(png|jpe?g|webp|gif)$/,
  tempPrefix: 'prod',
});

function normalizePublicMediaPath(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value;
  return value.startsWith('/') ? value : `/${value.replace(/^\/+/, '')}`;
}

// ---- Categorías ----
router.get('/categories', async (req, res, next) => {
  try {
    res.json(await req.tdb.all('SELECT * FROM {s}.categories ORDER BY sort, name'));
  } catch (e) { next(e); }
});

router.post('/categories', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const row = await req.tdb.get('INSERT INTO {s}.categories (name) VALUES ($1) RETURNING id, name', [name.trim()]);
    res.json(row);
  } catch (e) { next(e); }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    await req.tdb.run('UPDATE {s}.products SET category_id = NULL WHERE category_id = $1', [req.params.id]);
    await req.tdb.run('DELETE FROM {s}.categories WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Helpers de variantes y modificadores ----
async function getProductExtras(tdb, productIds = []) {
  if (!productIds.length) return { variantsMap: new Map(), groupsMap: new Map() };
  const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
  const variants = await tdb.all(
    `SELECT * FROM {s}.product_variants WHERE product_id IN (${placeholders}) ORDER BY product_id, sort, id`,
    productIds
  );
  const groups = await tdb.all(
    `SELECT * FROM {s}.modifier_groups WHERE product_id IN (${placeholders}) ORDER BY product_id, sort, id`,
    productIds
  );
  const groupIds = groups.map((g) => g.id);
  let options = [];
  if (groupIds.length) {
    const gph = groupIds.map((_, i) => `$${i + 1}`).join(',');
    options = await tdb.all(
      `SELECT * FROM {s}.modifier_options WHERE group_id IN (${gph}) AND active = 1 ORDER BY group_id, sort, id`,
      groupIds
    );
  }
  const variantsMap = new Map();
  for (const v of variants) {
    if (!variantsMap.has(v.product_id)) variantsMap.set(v.product_id, []);
    variantsMap.get(v.product_id).push(v);
  }
  const groupsMap = new Map();
  for (const g of groups) {
    g.options = options.filter((o) => o.group_id === g.id);
    if (!groupsMap.has(g.product_id)) groupsMap.set(g.product_id, []);
    groupsMap.get(g.product_id).push(g);
  }
  return { variantsMap, groupsMap };
}

// ---- Productos ----
router.get('/', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      `SELECT p.id, p.category_id, p.name, p.description, p.price::float AS price, p.image, p.active,
              c.name AS category_name
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id = p.category_id
       ORDER BY p.created_at DESC`
    );
    const ids = rows.map((r) => r.id);
    const { variantsMap, groupsMap } = await getProductExtras(req.tdb, ids);
    const result = rows.map((p) => ({
      ...p,
      image: normalizePublicMediaPath(p.image),
      variants: (variantsMap.get(p.id) || []).map((v) => ({ ...v, price: Number(v.price) })),
      modifierGroups: (groupsMap.get(p.id) || []).map((g) => ({
        ...g,
        min_selections: Number(g.min_selections),
        max_selections: Number(g.max_selections),
        options: (g.options || []).map((o) => ({ ...o, extra_price: Number(o.extra_price) })),
      })),
    }));
    res.json(result);
  } catch (e) { next(e); }
});

// ---- Variantes de precio ----
router.get('/:id/variants', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      'SELECT * FROM {s}.product_variants WHERE product_id = $1 ORDER BY sort, id',
      [req.params.id]
    );
    res.json(rows.map((v) => ({ ...v, price: Number(v.price) })));
  } catch (e) { next(e); }
});

router.post('/:id/variants', async (req, res, next) => {
  try {
    const { name, price, sort } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const row = await req.tdb.get(
      'INSERT INTO {s}.product_variants (product_id, name, price, sort, active) VALUES ($1,$2,$3,$4,1) RETURNING *',
      [req.params.id, name.trim(), Number(price) || 0, Number(sort) || 0]
    );
    res.json({ ...row, price: Number(row.price) });
  } catch (e) { next(e); }
});

router.put('/:id/variants/:vid', async (req, res, next) => {
  try {
    const { name, price, sort, active } = req.body || {};
    const existing = await req.tdb.get('SELECT * FROM {s}.product_variants WHERE id = $1 AND product_id = $2', [req.params.vid, req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Variante no encontrada' });
    await req.tdb.run(
      'UPDATE {s}.product_variants SET name=$1, price=$2, sort=$3, active=$4 WHERE id=$5',
      [
        (name || existing.name).trim(),
        price !== undefined ? Number(price) : Number(existing.price),
        sort !== undefined ? Number(sort) : existing.sort,
        active !== undefined ? (active ? 1 : 0) : existing.active,
        req.params.vid,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/variants/:vid', async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.product_variants WHERE id = $1 AND product_id = $2', [req.params.vid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Grupos de modificadores (ingredientes) ----
router.get('/:id/modifier-groups', async (req, res, next) => {
  try {
    const groups = await req.tdb.all(
      'SELECT * FROM {s}.modifier_groups WHERE product_id = $1 ORDER BY sort, id',
      [req.params.id]
    );
    if (!groups.length) return res.json([]);
    const gIds = groups.map((g) => g.id);
    const gph = gIds.map((_, i) => `$${i + 1}`).join(',');
    const options = await req.tdb.all(
      `SELECT * FROM {s}.modifier_options WHERE group_id IN (${gph}) AND active = 1 ORDER BY group_id, sort, id`,
      gIds
    );
    res.json(groups.map((g) => ({
      ...g,
      min_selections: Number(g.min_selections),
      max_selections: Number(g.max_selections),
      options: options.filter((o) => o.group_id === g.id).map((o) => ({ ...o, extra_price: Number(o.extra_price) })),
    })));
  } catch (e) { next(e); }
});

router.post('/:id/modifier-groups', async (req, res, next) => {
  try {
    const { name, min_selections, max_selections, sort } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const row = await req.tdb.get(
      'INSERT INTO {s}.modifier_groups (product_id, name, min_selections, max_selections, sort) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, name.trim(), Number(min_selections) || 0, Number(max_selections) || 1, Number(sort) || 0]
    );
    res.json({ ...row, options: [] });
  } catch (e) { next(e); }
});

router.put('/:id/modifier-groups/:gid', async (req, res, next) => {
  try {
    const { name, min_selections, max_selections, sort } = req.body || {};
    const existing = await req.tdb.get('SELECT * FROM {s}.modifier_groups WHERE id = $1 AND product_id = $2', [req.params.gid, req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Grupo no encontrado' });
    await req.tdb.run(
      'UPDATE {s}.modifier_groups SET name=$1, min_selections=$2, max_selections=$3, sort=$4 WHERE id=$5',
      [
        (name || existing.name).trim(),
        min_selections !== undefined ? Number(min_selections) : Number(existing.min_selections),
        max_selections !== undefined ? Number(max_selections) : Number(existing.max_selections),
        sort !== undefined ? Number(sort) : existing.sort,
        req.params.gid,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/modifier-groups/:gid', async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.modifier_options WHERE group_id = $1', [req.params.gid]);
    await req.tdb.run('DELETE FROM {s}.modifier_groups WHERE id = $1 AND product_id = $2', [req.params.gid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Opciones dentro de un grupo de modificadores ----
router.post('/:id/modifier-groups/:gid/options', async (req, res, next) => {
  try {
    const { name, extra_price, sort } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
    const row = await req.tdb.get(
      'INSERT INTO {s}.modifier_options (group_id, name, extra_price, sort, active) VALUES ($1,$2,$3,$4,1) RETURNING *',
      [req.params.gid, name.trim(), Number(extra_price) || 0, Number(sort) || 0]
    );
    res.json({ ...row, extra_price: Number(row.extra_price) });
  } catch (e) { next(e); }
});

router.put('/:id/modifier-groups/:gid/options/:oid', async (req, res, next) => {
  try {
    const { name, extra_price, sort, active } = req.body || {};
    const existing = await req.tdb.get('SELECT * FROM {s}.modifier_options WHERE id = $1 AND group_id = $2', [req.params.oid, req.params.gid]);
    if (!existing) return res.status(404).json({ error: 'Opción no encontrada' });
    await req.tdb.run(
      'UPDATE {s}.modifier_options SET name=$1, extra_price=$2, sort=$3, active=$4 WHERE id=$5',
      [
        (name || existing.name).trim(),
        extra_price !== undefined ? Number(extra_price) : Number(existing.extra_price),
        sort !== undefined ? Number(sort) : existing.sort,
        active !== undefined ? (active ? 1 : 0) : existing.active,
        req.params.oid,
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id/modifier-groups/:gid/options/:oid', async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.modifier_options WHERE id = $1 AND group_id = $2', [req.params.oid, req.params.gid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/', upload.single('image'), async (req, res, next) => {
  let img = null;
  try {
    const { name, description, price, categoryId, active } = req.body || {};
    if (!name || !name.trim() || price === undefined || price === '') {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }
    img = req.file ? await optimizeUploadedImage(req.file, { scope: req.tenant.slug, outputPrefix: 'prod' }) : null;
    const row = await req.tdb.get(
      'INSERT INTO {s}.products (name, description, price, category_id, image, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name.trim(), description || '', Number(price) || 0, categoryId || null, img, active === '0' ? 0 : 1]
    );
    res.json(row);
  } catch (e) {
    try {
      if (img) await deleteManagedUpload(img);
      else if (req.file) await safeUnlink(req.file.path);
    } catch {}
    next(e);
  }
});

router.put('/:id', upload.single('image'), async (req, res, next) => {
  let img = null;
  try {
    const existing = await req.tdb.get('SELECT * FROM {s}.products WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });
    const { name, description, price, categoryId, active } = req.body || {};
    img = req.file ? await optimizeUploadedImage(req.file, { scope: req.tenant.slug, outputPrefix: 'prod' }) : existing.image;
    await req.tdb.run(
      'UPDATE {s}.products SET name=$1, description=$2, price=$3, category_id=$4, image=$5, active=$6 WHERE id=$7',
      [
        (name || existing.name).trim(),
        description ?? existing.description,
        price !== undefined && price !== '' ? Number(price) : existing.price,
        categoryId !== undefined ? categoryId || null : existing.category_id,
        img,
        active !== undefined ? (active === '0' ? 0 : 1) : existing.active,
        req.params.id,
      ]
    );
    if (req.file && existing.image && existing.image !== img) {
      const refs = await req.tdb.get('SELECT COUNT(*)::int AS total FROM {s}.products WHERE image = $1', [existing.image]);
      if (!Number(refs?.total || 0)) await deleteManagedUpload(existing.image);
    }
    res.json({ ok: true });
  } catch (e) {
    try {
      if (img && req.file) await deleteManagedUpload(img);
      else if (req.file) await safeUnlink(req.file.path);
    } catch {}
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const existing = await req.tdb.get('SELECT image FROM {s}.products WHERE id = $1', [req.params.id]);
    await req.tdb.run('DELETE FROM {s}.products WHERE id = $1', [req.params.id]);
    if (existing?.image) {
      const refs = await req.tdb.get('SELECT COUNT(*)::int AS total FROM {s}.products WHERE image = $1', [existing.image]);
      if (!Number(refs?.total || 0)) await deleteManagedUpload(existing.image);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
