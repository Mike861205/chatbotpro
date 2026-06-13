const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const rows = await req.tdb.all(
      'SELECT id, name, address, reference, active FROM {s}.branches ORDER BY active DESC, name ASC'
    );
    res.json(rows.map((r) => ({ ...r, active: Number(r.active) })));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 100);
    const address = String(body.address || '').trim().slice(0, 200);
    const reference = String(body.reference || '').trim().slice(0, 200);
    if (name.length < 2) return res.status(400).json({ error: 'El nombre de la sucursal es obligatorio' });
    if (address.length < 5) return res.status(400).json({ error: 'La dirección de la sucursal es obligatoria' });

    const row = await req.tdb.get(
      'INSERT INTO {s}.branches (name, address, reference, active) VALUES ($1, $2, $3, $4) RETURNING id, name, address, reference, active',
      [name, address, reference, body.active === '0' || body.active === 0 ? 0 : 1]
    );
    res.json({ ...row, active: Number(row.active) });
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 100);
    const address = String(body.address || '').trim().slice(0, 200);
    const reference = String(body.reference || '').trim().slice(0, 200);
    if (name.length < 2) return res.status(400).json({ error: 'El nombre de la sucursal es obligatorio' });
    if (address.length < 5) return res.status(400).json({ error: 'La dirección de la sucursal es obligatoria' });

    const r = await req.tdb.run(
      'UPDATE {s}.branches SET name = $1, address = $2, reference = $3, active = $4 WHERE id = $5',
      [name, address, reference, body.active === '0' || body.active === 0 ? 0 : 1, req.params.id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const r = await req.tdb.run('DELETE FROM {s}.branches WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Sucursal no encontrada' });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
