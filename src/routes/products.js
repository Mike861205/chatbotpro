const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const OpenAI = require('openai');
const sharp = require('sharp');
const { requireAuth, requireOwner, requireModules } = require('../middleware/auth');
const config = require('../config');
const { getSetting, getSuperAdminSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const { buildAiCatalogPrompt, normalizeAiCatalogProducts } = require('../utils/businessCatalog');
const { createImageUpload, deleteManagedUpload, optimizeUploadedImage, safeUnlink } = require('../utils/uploads');

const router = express.Router();
router.use(requireAuth);
router.use(requireModules('productos', 'pos', 'costos', 'inventarios', 'compras', 'chatbot'));
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
  maxFiles: 8,
  maxFields: 10,
});

const uploadAiProductImages = createImageUpload({
  scopeResolver: (req) => req.tenant.slug,
  allowedMimePattern: /^image\/(png|jpe?g|webp|gif)$/,
  tempPrefix: 'prod-ai-image',
  maxFiles: 60,
  maxFields: 10,
  fieldSize: 2 * 1024 * 1024,
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

async function buildAiImageDataUrl(file) {
  const bytes = await fs.readFile(file.path);
  const originalMime = String(file?.mimetype || '').trim().toLowerCase() || 'image/jpeg';
  let outMime = originalMime;
  let outBytes = bytes;

  // Reducimos peso/dimensiones para evitar rechazos del proveedor IA por payloads grandes.
  try {
    outBytes = await sharp(bytes, { failOn: 'none' })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    outMime = 'image/jpeg';
  } catch {
    outBytes = bytes;
    outMime = originalMime;
  }

  return {
    dataUrl: `data:${outMime};base64,${outBytes.toString('base64')}`,
    bytes: outBytes.length,
  };
}

function normalizeAiProviderError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  const code = String(err?.code || err?.error?.code || '').trim();
  const headers = err?.response?.headers || err?.headers || {};
  const retryAfterRaw = typeof headers?.get === 'function'
    ? headers.get('retry-after')
    : (headers['retry-after'] || headers['Retry-After'] || '');
  const message = String(
    err?.error?.message ||
    err?.response?.data?.error?.message ||
    err?.message ||
    ''
  ).trim();
  const retryFromHeader = Number.parseInt(String(retryAfterRaw || '').trim(), 10);
  let retryAfterSec = Number.isFinite(retryFromHeader) && retryFromHeader > 0 ? retryFromHeader : 0;
  if (!retryAfterSec) {
    const match = /try again in\s+(\d+(?:\.\d+)?)s/i.exec(message);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) retryAfterSec = Math.ceil(parsed);
    }
  }
  return { status, code, message, retryAfterSec };
}

function mapAiProviderErrorToClient(aiErr) {
  const msg = String(aiErr?.message || '').toLowerCase();
  if (aiErr.status === 401 || aiErr.status === 403) {
    return {
      status: 400,
      error: 'La API key de OpenAI es inválida o no tiene permisos. Revísala en SuperAdmin.',
    };
  }
  if (aiErr.status === 429) {
    const retryAfterSec = aiErr.retryAfterSec > 0 ? aiErr.retryAfterSec : 30;
    return {
      status: 429,
      error: 'El proveedor de IA alcanzó su límite de uso. Inténtalo de nuevo en unos segundos.',
      retryAfterSec,
    };
  }
  if (msg.includes('model') && (msg.includes('vision') || msg.includes('image') || msg.includes('multimodal'))) {
    return {
      status: 400,
      error: 'El modelo configurado no soporta análisis de imágenes. Usa uno multimodal (por ejemplo gpt-4o-mini).',
    };
  }
  if (msg.includes('payload') || msg.includes('too large') || msg.includes('content length') || msg.includes('context length')) {
    return {
      status: 400,
      error: 'La imagen del menú es demasiado pesada para analizarse. Prueba con una imagen más ligera.',
    };
  }
  return {
    status: aiErr.status >= 400 && aiErr.status < 500 ? 400 : 502,
    error: 'No se pudo analizar el menú con IA en este momento. Inténtalo nuevamente.',
  };
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

async function resolveExistingPublicMediaPath(raw) {
  const normalized = normalizePublicMediaPath(raw);
  if (!normalized) return '';
  if (!normalized.startsWith('/uploads/')) return normalized;

  const rel = normalized.slice('/uploads/'.length);
  if (!rel || rel.includes('..')) return '';
  const diskPath = path.join(config.UPLOADS_DIR, rel.replaceAll('/', path.sep));
  try {
    await fs.access(diskPath);
    return normalized;
  } catch {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAiModelCandidates(primaryModel) {
  const defaults = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];
  const configured = String(process.env.OPENAI_MENU_MODEL_FALLBACKS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const all = [String(primaryModel || '').trim(), ...configured, ...defaults].filter(Boolean);
  return [...new Set(all)];
}

function shouldTryNextModel(aiErr) {
  const msg = String(aiErr?.message || '').toLowerCase();
  return (
    aiErr.status === 404 ||
    msg.includes('model') ||
    msg.includes('not found') ||
    msg.includes('does not exist') ||
    msg.includes('unsupported')
  );
}

function shouldRetrySameModel(aiErr) {
  return aiErr.status === 429 || aiErr.status >= 500;
}

async function createMenuSuggestionCompletion(client, content, model) {
  let lastNormalizedError = null;
  let useJsonResponseFormat = true;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const request = {
        model,
        temperature: 0.15,
        messages: [
          {
            role: 'system',
            content:
              'Eres un asistente experto en estructurar menus de comida para sistemas de catalogo. Responde estrictamente en JSON.',
          },
          { role: 'user', content },
        ],
      };
      if (useJsonResponseFormat) request.response_format = { type: 'json_object' };
      const completion = await client.chat.completions.create(request);
      return { completion, model, attempts: attempt };
    } catch (err) {
      const aiErr = normalizeAiProviderError(err);
      lastNormalizedError = aiErr;
      const message = String(aiErr.message || '').toLowerCase();
      if (useJsonResponseFormat && aiErr.status === 400
          && (message.includes('response_format') || message.includes('json mode'))) {
        useJsonResponseFormat = false;
        continue;
      }
      if (!shouldRetrySameModel(aiErr) || attempt >= 3) break;
      const waitSec = aiErr.retryAfterSec > 0 ? Math.min(aiErr.retryAfterSec, 12) : attempt * 2;
      await sleep(waitSec * 1000);
    }
  }
  const wrapped = new Error(lastNormalizedError?.message || 'AI provider error');
  wrapped.normalized = lastNormalizedError || normalizeAiProviderError(wrapped);
  throw wrapped;
}

async function requestAiMenuSuggestion(aiCfg, content) {
  const client = buildAiClient(aiCfg.key, aiCfg.baseUrl);
  const models = buildAiModelCandidates(aiCfg.model);
  let lastErr = null;

  for (const model of models) {
    try {
      return await createMenuSuggestionCompletion(client, content, model);
    } catch (err) {
      const aiErr = err?.normalized || normalizeAiProviderError(err);
      lastErr = aiErr;
      if (shouldTryNextModel(aiErr)) continue;
      if (!shouldRetrySameModel(aiErr)) break;
    }
  }

  const finalErr = new Error(lastErr?.message || 'AI provider error');
  finalErr.normalized = lastErr || normalizeAiProviderError(finalErr);
  throw finalErr;
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
              p.sat_product_code, p.sat_unit_code, p.sat_unit_name, p.tax_object,
              p.iva_rate::float AS iva_rate, p.isr_rate::float AS isr_rate,
              c.name AS category_name
       FROM {s}.products p
       LEFT JOIN {s}.categories c ON c.id = p.category_id
       ORDER BY p.created_at DESC`
    );
    const ids = rows.map((r) => r.id);
    const soldQtyByProduct = await listSoldQtyByProduct(req.tdb);
    const { variantsMap, groupsMap } = await getProductExtras(req.tdb, ids);
    const result = await Promise.all(rows.map(async (p) => ({
      ...p,
      image: await resolveExistingPublicMediaPath(p.image),
      soldQty: Number(soldQtyByProduct.get(Number(p.id)) || 0),
      variants: (variantsMap.get(p.id) || []).map((v) => ({ ...v, price: Number(v.price) })),
      modifierGroups: (groupsMap.get(p.id) || []).map((g) => ({
        ...g,
        min_selections: Number(g.min_selections),
        max_selections: Number(g.max_selections),
        options: (g.options || []).map((o) => ({ ...o, extra_price: Number(o.extra_price) })),
      })),
    })));
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/ai/suggest', uploadAiMenu.array('menuImages', 8), async (req, res, next) => {
  try {
    const menuFiles = Array.isArray(req.files) ? req.files : [];
    if (!menuFiles.length) {
      return res.status(400).json({ error: 'Sube al menos una imagen del catálogo para analizar.' });
    }

    const aiCfg = await getOpenAiRuntimeConfig();
    if (!aiCfg.key) {
      return res.status(400).json({
        error: 'No hay API key de OpenAI configurada. Actívala en SuperAdmin o en OPENAI_API_KEY.',
      });
    }

    const categories = await req.tdb.all('SELECT id, name FROM {s}.categories ORDER BY sort, name');
    const categoryNames = categories.map((c) => c.name).filter(Boolean);
    const businessType = await getSetting(req.tdb, 'business_type', 'restaurant');

    const content = [
      {
        type: 'text',
        text: buildAiCatalogPrompt(businessType, categoryNames),
      },
    ];

    const imagePayloads = [];
    for (const file of menuFiles) {
      const payload = await buildAiImageDataUrl(file);
      imagePayloads.push(payload);
      content.push({ type: 'image_url', image_url: { url: payload.dataUrl, detail: 'high' } });
    }

    let completion;
    let usedModel;
    let usedAttempts;
    try {
      const aiResult = await requestAiMenuSuggestion(aiCfg, content);
      completion = aiResult.completion;
      usedModel = aiResult.model;
      usedAttempts = aiResult.attempts;
    } catch (aiError) {
      const aiErr = aiError?.normalized || normalizeAiProviderError(aiError);
      const mapped = mapAiProviderErrorToClient(aiErr);
      console.error('[ai/suggest] provider error', {
        status: aiErr.status,
        code: aiErr.code,
        message: aiErr.message,
        retryAfterSec: aiErr.retryAfterSec,
        model: aiCfg.model,
        imageBytes: imagePayloads.reduce((total, image) => total + image.bytes, 0),
      });
      if (mapped.status === 429 && mapped.retryAfterSec) {
        res.setHeader('Retry-After', String(mapped.retryAfterSec));
      }
      return res.status(mapped.status).json({ error: mapped.error, retryAfterSec: mapped.retryAfterSec || 0 });
    }

    const rawContent = completion?.choices?.[0]?.message?.content;
    const raw = Array.isArray(rawContent)
      ? rawContent.map((chunk) => (typeof chunk === 'string' ? chunk : String(chunk?.text || ''))).join('\n')
      : String(rawContent || '');
    const parsed = parseJsonFromModel(raw);
    if (!parsed || !Array.isArray(parsed.products)) {
      return res.status(422).json({ error: 'No se pudo interpretar una lista de productos valida desde IA.' });
    }

    const products = normalizeAiCatalogProducts(parsed.products);

    const normalizedExisting = new Set(categoryNames.map(normalizeCategoryName).filter(Boolean));
    const suggestedCategories = [...new Set(products.map((p) => p.categoryName).filter(Boolean))];
    const variantGroupsDetected = products.filter((p) => p.variants.length).map((p) => p.name);
    const modifierGroupsDetected = products.filter((p) => p.modifierGroups.length).map((p) => p.name);

    res.json({
      products,
      notes: Array.isArray(parsed.notes) ? parsed.notes.map((n) => String(n || '').trim()).filter(Boolean) : [],
      categoryHints: suggestedCategories.map((name) => ({
        name,
        exists: normalizedExisting.has(normalizeCategoryName(name)),
      })),
      variantGroupsDetected,
      modifierGroupsDetected,
      imageCount: menuFiles.length,
      model: usedModel,
      retries: Math.max(0, Number(usedAttempts || 1) - 1),
    });
  } catch (e) {
    next(e);
  } finally {
    for (const file of (Array.isArray(req.files) ? req.files : [])) {
      if (file?.path) {
        try { await safeUnlink(file.path); } catch {}
      }
    }
  }
});

router.post('/ai/import', uploadAiProductImages.array('productImages', 60), async (req, res, next) => {
  const optimizedImages = new Map();
  try {
    const body = req.body || {};
    let inputProducts = body.products;
    if (typeof inputProducts === 'string') {
      try { inputProducts = JSON.parse(inputProducts); } catch { inputProducts = []; }
    }
    const products = normalizeAiCatalogProducts(inputProducts);
    if (!products.length) return res.status(400).json({ error: 'No hay productos válidos para importar.' });

    const createMissingCategories = body.createMissingCategories !== false && body.createMissingCategories !== 'false';
    const defaultActive = body.defaultActive === false || body.defaultActive === 'false' ? 0 : 1;
    const skipExisting = body.skipExisting !== false && body.skipExisting !== 'false';
    const files = Array.isArray(req.files) ? req.files : [];

    for (let index = 0; index < files.length; index += 1) {
      const image = await optimizeUploadedImage(files[index], {
        scope: req.tenant.slug,
        outputPrefix: 'prod',
        maxWidth: 1600,
        quality: 80,
      });
      optimizedImages.set(index, image);
    }

    const result = await req.tdb.tx(async (tx) => {
      const categories = await tx.all('SELECT id, name FROM {s}.categories ORDER BY sort, name');
      const categoryMap = new Map(
        categories.map((cat) => [categoryMatchKey(cat.name), { id: cat.id, name: cat.name }]).filter((entry) => entry[0])
      );
      const existingRows = await tx.all('SELECT id, name, category_id FROM {s}.products');
      const existingKeys = new Set(existingRows.map((row) => `${Number(row.category_id) || 0}::${normalizeLooseText(row.name)}`));
      const createdProducts = [];
      const skipped = [];
      const usedImages = new Set();
      let createdCategories = 0;
      let createdVariants = 0;
      let createdModifierGroups = 0;
      let createdModifierOptions = 0;

      for (const product of products) {
        let categoryId = null;
        if (product.categoryName) {
          const existingCat = pickExistingCategory(categoryMap, product.categoryName);
          if (existingCat) categoryId = existingCat.id;
          else if (createMissingCategories) {
            const createdCat = await tx.get(
              'INSERT INTO {s}.categories (name, sort) VALUES ($1, 0) RETURNING id, name',
              [product.categoryName]
            );
            categoryId = createdCat.id;
            categoryMap.set(categoryMatchKey(createdCat.name), createdCat);
            createdCategories += 1;
          }
        }

        const duplicateKey = `${Number(categoryId) || 0}::${normalizeLooseText(product.name)}`;
        if (skipExisting && existingKeys.has(duplicateKey)) {
          skipped.push({ reason: 'already_exists', name: product.name, categoryName: product.categoryName });
          continue;
        }

        const variantPrices = product.variants.map((variant) => Number(variant.price)).filter((price) => price >= 0);
        const basePrice = product.price > 0 || !variantPrices.length ? product.price : Math.min(...variantPrices);
        const image = optimizedImages.get(product.imageIndex) || null;
        if (image) usedImages.add(image);

        const inserted = await tx.get(
          'INSERT INTO {s}.products (name, description, price, category_id, image, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [product.name, product.description, basePrice, categoryId, image, defaultActive]
        );

        for (let index = 0; index < product.variants.length; index += 1) {
          const variant = product.variants[index];
          await tx.run(
            'INSERT INTO {s}.product_variants (product_id, name, price, sort, active) VALUES ($1,$2,$3,$4,1)',
            [inserted.id, variant.name, variant.price, index]
          );
          createdVariants += 1;
        }

        for (let groupIndex = 0; groupIndex < product.modifierGroups.length; groupIndex += 1) {
          const group = product.modifierGroups[groupIndex];
          const insertedGroup = await tx.get(
            'INSERT INTO {s}.modifier_groups (product_id, name, min_selections, max_selections, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [inserted.id, group.name, group.minSelections, group.maxSelections, groupIndex]
          );
          createdModifierGroups += 1;
          for (let optionIndex = 0; optionIndex < group.options.length; optionIndex += 1) {
            const option = group.options[optionIndex];
            await tx.run(
              'INSERT INTO {s}.modifier_options (group_id, name, extra_price, sort, active) VALUES ($1,$2,$3,$4,1)',
              [insertedGroup.id, option.name, option.extraPrice, optionIndex]
            );
            createdModifierOptions += 1;
          }
        }

        existingKeys.add(duplicateKey);
        createdProducts.push({
          id: inserted.id,
          name: product.name,
          price: basePrice,
          categoryId,
          variants: product.variants.length,
          modifierGroups: product.modifierGroups.length,
          modifierOptions: product.modifierGroups.reduce((total, group) => total + group.options.length, 0),
          image: Boolean(image),
        });
      }

      return {
        createdProducts,
        createdCategories,
        createdVariants,
        createdModifierGroups,
        createdModifierOptions,
        skipped,
        usedImages,
      };
    });

    for (const image of optimizedImages.values()) {
      if (!result.usedImages.has(image)) await deleteManagedUpload(image);
    }

    res.json({
      ok: true,
      created: result.createdProducts.length,
      createdCategories: result.createdCategories,
      createdVariants: result.createdVariants,
      createdModifierGroups: result.createdModifierGroups,
      createdModifierOptions: result.createdModifierOptions,
      skippedCount: result.skipped.length,
      skipped: result.skipped,
      products: result.createdProducts,
    });
  } catch (e) {
    for (const image of optimizedImages.values()) {
      try { await deleteManagedUpload(image); } catch {}
    }
    next(e);
  } finally {
    for (const file of (Array.isArray(req.files) ? req.files : [])) {
      if (file?.path) {
        try { await safeUnlink(file.path); } catch {}
      }
    }
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

function normalizeProductFiscal(body = {}, existing = {}) {
  const read = (key, column) => Object.prototype.hasOwnProperty.call(body, key) ? body[key] : existing[column];
  const productCode = String(read('satProductCode', 'sat_product_code') ?? '').trim() || null;
  const unitCode = String(read('satUnitCode', 'sat_unit_code') ?? '').trim().toUpperCase() || null;
  const unitName = String(read('satUnitName', 'sat_unit_name') ?? '').trim().slice(0, 40) || null;
  const taxObject = String(read('taxObject', 'tax_object') ?? '').trim() || null;
  const ivaRaw = read('ivaRate', 'iva_rate');
  const isrRaw = read('isrRate', 'isr_rate');
  const ivaRate = ivaRaw === '' || ivaRaw === null || ivaRaw === undefined ? null : Number(ivaRaw);
  const isrRate = isrRaw === '' || isrRaw === null || isrRaw === undefined ? null : Number(isrRaw);
  if (productCode && !/^\d{8}$/.test(productCode)) throw Object.assign(new Error('La clave SAT debe tener 8 dígitos'), { status: 400 });
  if (unitCode && !/^[A-Z0-9]{2,3}$/.test(unitCode)) throw Object.assign(new Error('La clave de unidad SAT no es válida'), { status: 400 });
  if (taxObject && !['01','02','03','04','05','06','07','08'].includes(taxObject)) throw Object.assign(new Error('El objeto de impuesto no es válido'), { status: 400 });
  if (ivaRate !== null && (!Number.isFinite(ivaRate) || ivaRate < 0 || ivaRate > 1)) throw Object.assign(new Error('La tasa de IVA no es válida'), { status: 400 });
  if (isrRate !== null && (!Number.isFinite(isrRate) || isrRate < 0 || isrRate > 1)) throw Object.assign(new Error('La tasa de ISR no es válida'), { status: 400 });
  if (ivaRate !== null && isrRate !== null && 1 + ivaRate - isrRate <= 0) throw Object.assign(new Error('La combinación de IVA e ISR no es válida'), { status: 400 });
  return { productCode, unitCode, unitName, taxObject, ivaRate, isrRate };
}

router.post('/', upload.single('image'), async (req, res, next) => {
  let img = null;
  try {
    const { name, description, price, categoryId, active } = req.body || {};
    const fiscal = normalizeProductFiscal(req.body || {});
    if (!name || !name.trim() || price === undefined || price === '') {
      return res.status(400).json({ error: 'Nombre y precio son obligatorios' });
    }
    img = req.file ? await optimizeUploadedImage(req.file, { scope: req.tenant.slug, outputPrefix: 'prod' }) : null;
    const row = await req.tdb.get(
      `INSERT INTO {s}.products
       (name,description,price,category_id,image,active,sat_product_code,sat_unit_code,sat_unit_name,tax_object,iva_rate,isr_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [name.trim(), description || '', Number(price) || 0, categoryId || null, img, active === '0' ? 0 : 1,
        fiscal.productCode, fiscal.unitCode, fiscal.unitName, fiscal.taxObject, fiscal.ivaRate, fiscal.isrRate]
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
    const fiscal = normalizeProductFiscal(req.body || {}, existing);
    img = req.file ? await optimizeUploadedImage(req.file, { scope: req.tenant.slug, outputPrefix: 'prod' }) : existing.image;
    await req.tdb.run(
      `UPDATE {s}.products SET name=$1,description=$2,price=$3,category_id=$4,image=$5,active=$6,
       sat_product_code=$7,sat_unit_code=$8,sat_unit_name=$9,tax_object=$10,iva_rate=$11,isr_rate=$12 WHERE id=$13`,
      [
        (name || existing.name).trim(),
        description ?? existing.description,
        price !== undefined && price !== '' ? Number(price) : existing.price,
        categoryId !== undefined ? categoryId || null : existing.category_id,
        img,
        active !== undefined ? (active === '0' ? 0 : 1) : existing.active,
        fiscal.productCode, fiscal.unitCode, fiscal.unitName, fiscal.taxObject, fiscal.ivaRate, fiscal.isrRate,
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
