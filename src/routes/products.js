const express = require('express');
const fs = require('node:fs/promises');
const OpenAI = require('openai');
const { requireAuth, requireOwner } = require('../middleware/auth');
const config = require('../config');
const { getSuperAdminSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

const upload = createImageUpload({
  scopeResolver: (req) => req.tenant.slug,
  allowedMimePattern: /^image\/(png|jpe?g|webp|gif)$/,
  tempPrefix: 'prod',
});

const uploadAiMenu = createImageUpload({
  scopeResolver: (req) => req.tenant.slug,
  allowedMimePattern: /^image\/(png|jpe?g|webp|gif)$/,
  tempPrefix: 'prod-ai',
});

const aiClientCache = new Map();

function normalizeCategoryName(name) {
  return String(name || '').trim().toLowerCase();
}

function normalizeLooseText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWordForMatch(word) {
  const w = normalizeLooseText(word);
  if (w.length <= 3) return w;
  if (w.endsWith('es') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 4) return w.slice(0, -1);
  return w;
}

function categoryMatchKey(name) {
  const tokens = normalizeLooseText(name)
    .split(' ')
    .map(normalizeWordForMatch)
    .filter(Boolean)
    .sort();
  return tokens.join(' ');
}

function pickExistingCategory(categoryMap, rawName) {
  const cleanName = String(rawName || '').trim();
  if (!cleanName) return null;

  const exact = categoryMap.get(categoryMatchKey(cleanName));
  if (exact) return exact;

  const loose = normalizeLooseText(cleanName).replace(/\s/g, '');
  if (!loose) return null;
  for (const cat of categoryMap.values()) {
    const target = normalizeLooseText(cat.name).replace(/\s/g, '');
    if (!target) continue;
    if (target.includes(loose) || loose.includes(target)) return cat;
  }
  return null;
}

function detectVariantMeta(row) {
  const rawName = String(row?.name || '').trim();
  if (!rawName) return { baseName: '', variantName: '' };

  const explicitBase = String(row?.variantGroup || '').trim();
  const explicitVariant = String(row?.variantName || '').trim();
  if (explicitBase && explicitVariant) {
    return { baseName: explicitBase, variantName: explicitVariant };
  }

  const paren = rawName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    return { baseName: paren[1].trim(), variantName: paren[2].trim() };
  }

  const suffix = rawName.match(/^(.+?)\s+(chica|mediana|grande|jumbo|familiar|personal|individual|doble|triple|litro|2 litros|500ml|1l|1 kg|1\/2 kg|medio kilo|kilo|combo [0-9]+)$/i);
  if (suffix) {
    return { baseName: suffix[1].trim(), variantName: suffix[2].trim() };
  }

  const hyphen = rawName.match(/^(.+?)\s*[-:]\s*(chica|mediana|grande|jumbo|familiar|personal|individual|doble|triple|litro|2 litros|500ml|1l|1 kg|1\/2 kg|medio kilo|kilo)$/i);
  if (hyphen) {
    return { baseName: hyphen[1].trim(), variantName: hyphen[2].trim() };
  }

  return { baseName: rawName, variantName: explicitVariant };
}

function buildVariantLabel(rowName, baseName, fallback) {
  const fromRow = String(rowName || '').trim();
  const fromBase = String(baseName || '').trim();
  if (fromRow && fromBase) {
    const rowNorm = normalizeLooseText(fromRow);
    const baseNorm = normalizeLooseText(fromBase);
    if (rowNorm.startsWith(baseNorm)) {
      const rest = fromRow.slice(fromBase.length).replace(/^\s*[-:()\s]+/, '').trim();
      if (rest) return rest;
    }
  }
  return String(fallback || 'Presentacion').trim() || 'Presentacion';
}

function buildAiClient(apiKey, baseUrl) {
  const cacheKey = `${apiKey}::${baseUrl || ''}`;
  if (aiClientCache.has(cacheKey)) return aiClientCache.get(cacheKey);
  const client = new OpenAI(baseUrl ? { apiKey, baseURL: baseUrl } : { apiKey });
  aiClientCache.set(cacheKey, client);
  return client;
}

function parseJsonFromModel(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const cleanFence = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleanFence);
  } catch {}

  const first = cleanFence.indexOf('{');
  const last = cleanFence.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleanFence.slice(first, last + 1));
    } catch {}
  }
  return null;
}

async function getOpenAiRuntimeConfig() {
  const [modelRaw, baseUrlRaw, keyEncRaw] = await Promise.all([
    getSuperAdminSetting('openai_model', 'gpt-4o-mini'),
    getSuperAdminSetting('openai_base_url', ''),
    getSuperAdminSetting('openai_api_key_enc', ''),
  ]);
  const keyFromSuperAdmin = decrypt(keyEncRaw || '') || '';
  const key = keyFromSuperAdmin || config.OPENAI_API_KEY || '';
  const model = String(modelRaw || 'gpt-4o-mini').trim() || 'gpt-4o-mini';
  const baseUrl = String(baseUrlRaw || '').trim();
  return { key, model, baseUrl };
}

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

async function listSoldQtyByProduct(tdb) {
  const rows = await tdb.all(
    `SELECT product_id, SUM(qty)::int AS sold_qty
     FROM (
       SELECT
         CASE
           WHEN (it.item->>'productId') ~ '^[0-9]+$' THEN (it.item->>'productId')::int
           WHEN (it.item->>'id') ~ '^[0-9]+$' THEN (it.item->>'id')::int
           ELSE NULL
         END AS product_id,
         CASE
           WHEN (it.item->>'qty') ~ '^[0-9]+$' THEN GREATEST((it.item->>'qty')::int, 1)
           ELSE 1
         END AS qty
       FROM {s}.orders o
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.items::jsonb, '[]'::jsonb)) AS it(item)
       WHERE o.status <> 'cancelado' AND o.channel IN ('pos', 'chatbot')
     ) sold
     WHERE product_id IS NOT NULL
     GROUP BY product_id`
  );
  return new Map(rows.map((row) => [Number(row.product_id), Number(row.sold_qty || 0)]));
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
    const soldQtyByProduct = await listSoldQtyByProduct(req.tdb);
    const { variantsMap, groupsMap } = await getProductExtras(req.tdb, ids);
    const result = rows.map((p) => ({
      ...p,
      image: normalizePublicMediaPath(p.image),
      soldQty: Number(soldQtyByProduct.get(Number(p.id)) || 0),
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

router.post('/ai/suggest', uploadAiMenu.single('menuImage'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Sube una imagen del menu para analizar.' });
    }

    const aiCfg = await getOpenAiRuntimeConfig();
    if (!aiCfg.key) {
      return res.status(400).json({
        error: 'No hay API key de OpenAI configurada. Actívala en SuperAdmin o en OPENAI_API_KEY.',
      });
    }

    const categories = await req.tdb.all('SELECT id, name FROM {s}.categories ORDER BY sort, name');
    const categoryNames = categories.map((c) => c.name).filter(Boolean);

    const content = [
      {
        type: 'text',
        text: [
          'Analiza este menu de restaurante y regresa SOLO JSON valido.',
          'Genera productos listos para cargar en el sistema POS/chatbot.',
          'Formato JSON requerido:',
          '{"products":[{"name":"string","description":"string","price":123.45,"categoryName":"string","variantGroup":"string opcional","variantName":"string opcional"}],"notes":["string"]}',
          'Reglas:',
          '- Incluye solo productos vendibles, no encabezados ni subtotales.',
          '- price debe ser numero mayor o igual a 0.',
          '- categoryName debe ser breve (ej. Hamburguesas, Bebidas).',
          '- Agrega description breve del platillo en cada producto (ingredientes o preparacion).',
          '- Si un platillo tiene tamanos/presentaciones, usa variantGroup con el nombre base y variantName con el tamano (ej. Chica, Mediana).',
          '- Si falta precio, usa 0 y agrega una nota.',
          '- Maximo 60 productos.',
          `Categorias existentes del tenant: ${categoryNames.join(', ') || 'Ninguna'}`,
        ].join('\n'),
      },
    ];

    if (req.file) {
      const bytes = await fs.readFile(req.file.path);
      const base64 = bytes.toString('base64');
      const mime = req.file.mimetype || 'image/jpeg';
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${base64}` },
      });
    }

    const client = buildAiClient(aiCfg.key, aiCfg.baseUrl);
    const completion = await client.chat.completions.create({
      model: aiCfg.model,
      temperature: 0.15,
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente experto en estructurar menus de comida para sistemas de catalogo. Responde estrictamente en JSON.',
        },
        { role: 'user', content },
      ],
    });

    const raw = completion?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonFromModel(raw);
    if (!parsed || !Array.isArray(parsed.products)) {
      return res.status(422).json({ error: 'No se pudo interpretar una lista de productos valida desde IA.' });
    }

    const products = parsed.products
      .slice(0, 60)
      .map((row) => ({
        name: String(row?.name || '').trim(),
        description: String(row?.description || '').trim(),
        price: Number(row?.price),
        categoryName: String(row?.categoryName || '').trim(),
        variantGroup: String(row?.variantGroup || '').trim(),
        variantName: String(row?.variantName || '').trim(),
      }))
      .filter((row) => row.name)
      .map((row) => ({
        ...row,
        price: Number.isFinite(row.price) && row.price >= 0 ? Number(row.price.toFixed(2)) : 0,
      }));

    const normalizedExisting = new Set(categoryNames.map(normalizeCategoryName).filter(Boolean));
    const suggestedCategories = [...new Set(products.map((p) => p.categoryName).filter(Boolean))];
    const variantGroupsDetected = [...new Set(products.map((p) => String(p.variantGroup || '').trim()).filter(Boolean))];

    res.json({
      products,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map((n) => String(n || '').trim()).filter(Boolean) : [],
      categoryHints: suggestedCategories.map((name) => ({
        name,
        exists: normalizedExisting.has(normalizeCategoryName(name)),
      })),
      variantGroupsDetected,
      model: aiCfg.model,
    });
  } catch (e) {
    next(e);
  } finally {
    if (req.file?.path) {
      try { await safeUnlink(req.file.path); } catch {}
    }
  }
});

router.post('/ai/import', async (req, res, next) => {
  try {
    const body = req.body || {};
    const inputProducts = Array.isArray(body.products) ? body.products : [];
    if (!inputProducts.length) {
      return res.status(400).json({ error: 'No hay productos para importar.' });
    }

    const createMissingCategories = body.createMissingCategories !== false;
    const defaultActive = body.defaultActive === false ? 0 : 1;

    const categories = await req.tdb.all('SELECT id, name FROM {s}.categories ORDER BY sort, name');
    const categoryMap = new Map(
      categories.map((cat) => [categoryMatchKey(cat.name), { id: cat.id, name: cat.name }]).filter((entry) => entry[0])
    );

    const createdProducts = [];
    const skipped = [];
    let createdCategories = 0;

    const normalizedRows = inputProducts.slice(0, 200).map((raw) => {
      const name = String(raw?.name || '').trim();
      const description = String(raw?.description || '').trim();
      const priceVal = Number(raw?.price);
      const price = Number.isFinite(priceVal) && priceVal >= 0 ? Number(priceVal.toFixed(2)) : 0;
      const categoryName = String(raw?.categoryName || '').trim();
      const detected = detectVariantMeta(raw);
      return {
        raw,
        name,
        description,
        price,
        categoryName,
        baseName: detected.baseName || name,
        variantName: detected.variantName || '',
      };
    });

    const grouped = new Map();
    for (const row of normalizedRows) {
      if (!row.name) {
        skipped.push({ reason: 'name_missing', item: row.raw });
        continue;
      }
      const key = `${categoryMatchKey(row.categoryName)}::${normalizeLooseText(row.baseName)}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    for (const rows of grouped.values()) {
      if (!rows.length) continue;
      const sample = rows[0];
      const categoryCandidate = sample.categoryName;

      let categoryId = null;
      if (categoryCandidate) {
        const existingCat = pickExistingCategory(categoryMap, categoryCandidate);
        if (existingCat) {
          categoryId = existingCat.id;
        } else if (createMissingCategories) {
          const createdCat = await req.tdb.get(
            'INSERT INTO {s}.categories (name, sort) VALUES ($1, 0) RETURNING id, name',
            [categoryCandidate]
          );
          categoryId = createdCat.id;
          categoryMap.set(categoryMatchKey(createdCat.name), createdCat);
          createdCategories += 1;
        }
      }

      const hasVariantSignal = rows.some((r) => r.variantName) || rows.length > 1;
      if (!hasVariantSignal) {
        const only = rows[0];
        const insertedSingle = await req.tdb.get(
          'INSERT INTO {s}.products (name, description, price, category_id, image, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [only.name, only.description, only.price, categoryId, null, defaultActive]
        );
        createdProducts.push({ id: insertedSingle.id, name: only.name, price: only.price, categoryId, variants: 0 });
        continue;
      }

      const baseName = sample.baseName || sample.name;
      const mergedDescription = rows
        .map((r) => String(r.description || '').trim())
        .sort((a, b) => b.length - a.length)[0] || '';
      const basePrice = Math.min(...rows.map((r) => Number(r.price) || 0));

      const inserted = await req.tdb.get(
        'INSERT INTO {s}.products (name, description, price, category_id, image, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [baseName, mergedDescription, basePrice, categoryId, null, defaultActive]
      );

      const usedLabels = new Set();
      let variantSort = 0;
      for (const row of rows) {
        let label = row.variantName || buildVariantLabel(row.name, baseName, 'Presentacion');
        if (!label) label = `Presentacion ${variantSort + 1}`;
        let uniqueLabel = label;
        let seq = 2;
        while (usedLabels.has(normalizeLooseText(uniqueLabel))) {
          uniqueLabel = `${label} ${seq++}`;
        }
        usedLabels.add(normalizeLooseText(uniqueLabel));

        await req.tdb.run(
          'INSERT INTO {s}.product_variants (product_id, name, price, sort, active) VALUES ($1,$2,$3,$4,1)',
          [inserted.id, uniqueLabel, row.price, variantSort++]
        );
      }

      createdProducts.push({ id: inserted.id, name: baseName, price: basePrice, categoryId, variants: rows.length });
    }

    res.json({
      ok: true,
      created: createdProducts.length,
      createdCategories,
      skippedCount: skipped.length,
      skipped,
      products: createdProducts,
    });
  } catch (e) {
    next(e);
  }
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
