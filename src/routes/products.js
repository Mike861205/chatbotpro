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
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype));
  },
});

// ---- Categorías ----
router.get('/categories', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM categories ORDER BY sort, name').all());
});

router.post('/categories', (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nombre requerido' });
  const r = req.tdb.prepare('INSERT INTO categories (name) VALUES (?)').run(name.trim());
  res.json({ id: r.lastInsertRowid, name: name.trim() });
});

router.delete('/categories/:id', (req, res) => {
  req.tdb.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').run(req.params.id);
  req.tdb.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Productos ----
router.get('/', (req, res) => {
  const rows = req.tdb
    .prepare(
      `SELECT p.*, c.name AS category_name FROM products p
       LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.created_at DESC`
    )
    .all();
  res.json(rows);
});

router.post('/', upload.single('image'), (req, res) => {
  const { name, description, price, categoryId, active } = req.body || {};
  if (!name || !name.trim() || price === undefined) {
    return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
  }
  const img = req.file ? `/uploads/${req.tenant.slug}/${req.file.filename}` : null;
  const r = req.tdb
    .prepare('INSERT INTO products (name, description, price, category_id, image, active) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name.trim(), description || '', Number(price) || 0, categoryId || null, img, active === '0' ? 0 : 1);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', upload.single('image'), (req, res) => {
  const existing = req.tdb.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });
  const { name, description, price, categoryId, active } = req.body || {};
  const img = req.file ? `/uploads/${req.tenant.slug}/${req.file.filename}` : existing.image;
  req.tdb
    .prepare('UPDATE products SET name=?, description=?, price=?, category_id=?, image=?, active=? WHERE id=?')
    .run(
      (name || existing.name).trim(),
      description ?? existing.description,
      price !== undefined ? Number(price) : existing.price,
      categoryId !== undefined ? categoryId || null : existing.category_id,
      img,
      active !== undefined ? (active === '0' ? 0 : 1) : existing.active,
      req.params.id
    );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
