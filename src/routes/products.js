const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.UPLOADS_DIR, req.tenant.slug);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `prod_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype));
  },
});

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
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', upload.single('image'), async (req, res, next) => {
  try {
    const { name, description, price, categoryId, active } = req.body || {};
    if (!name || !name.trim() || price === undefined || price === '') {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }
    const img = req.file ? `/uploads/${req.tenant.slug}/${req.file.filename}` : null;
    const row = await req.tdb.get(
      'INSERT INTO {s}.products (name, description, price, category_id, image, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name.trim(), description || '', Number(price) || 0, categoryId || null, img, active === '0' ? 0 : 1]
    );
    res.json(row);
  } catch (e) { next(e); }
});

router.put('/:id', upload.single('image'), async (req, res, next) => {
  try {
    const existing = await req.tdb.get('SELECT * FROM {s}.products WHERE id = $1', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });
    const { name, description, price, categoryId, active } = req.body || {};
    const img = req.file ? `/uploads/${req.tenant.slug}/${req.file.filename}` : existing.image;
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
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await req.tdb.run('DELETE FROM {s}.products WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
