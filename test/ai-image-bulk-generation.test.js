const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
const start = app.indexOf('async function generateAiDraftImages(items) {');
const end = app.indexOf('\nlet AI_ANALYZE_PROGRESS_TIMER', start);
assert.ok(start >= 0 && end > start);
const generationSource = app.slice(start, end);

test('un clic genera todos los faltantes con máximo dos solicitudes simultáneas', async () => {
  const items = Array.from({ length: 11 }, (_, index) => ({
    _draftId: `draft-${index}`,
    name: `Producto ${index}`,
    description: '',
    categoryName: 'Comida',
    imageStatus: 'none',
    imagePreviewUrl: '',
  }));
  let active = 0;
  let peak = 0;
  let calls = 0;
  const progress = [];
  const context = {
    AI_IMAGE_BULK_RUNNING: false,
    AI_IMAGE_BULK_PROGRESS: null,
    AI_IMAGE_GENERATE_REST_QUEUED: false,
    AI_PRODUCTS_DRAFT: items,
    $: () => ({ value: 'clean' }),
    renderAiDraftRows: () => {},
    updateAiImageWorkflowStatus: () => progress.push(context.AI_IMAGE_BULK_PROGRESS?.done),
    releaseAiDraftImage: () => {},
    toast: () => {},
    api: async (_path, options) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      const product = JSON.parse(options.body).products[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { images: [{ id: product.id, dataUrl: 'data:image/webp;base64,QQ==' }] };
    },
  };
  vm.runInNewContext(`${generationSource}\nthis.generate = generateAiDraftImages;`, context);
  await context.generate(items);

  assert.equal(calls, 11);
  assert.equal(peak, 2);
  assert.equal(progress.at(-1), 11);
  assert.ok(items.every((item) => item.imageStatus === 'suggested'));
  assert.ok(items.every((item) => item.imageSource === 'ai_generated'));
  assert.equal(context.AI_IMAGE_BULK_PROGRESS, null);
  assert.equal(context.AI_IMAGE_BULK_RUNNING, false);
});

test('un fallo individual no interrumpe las demás imágenes del lote', async () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    _draftId: `draft-${index}`,
    name: `Producto ${index}`,
    imageStatus: 'none',
    imagePreviewUrl: '',
  }));
  const context = {
    AI_IMAGE_BULK_RUNNING: false,
    AI_IMAGE_BULK_PROGRESS: null,
    AI_IMAGE_GENERATE_REST_QUEUED: false,
    AI_PRODUCTS_DRAFT: items,
    $: () => ({ value: 'clean' }),
    renderAiDraftRows: () => {},
    updateAiImageWorkflowStatus: () => {},
    releaseAiDraftImage: () => {},
    toast: () => {},
    api: async (_path, options) => {
      const product = JSON.parse(options.body).products[0];
      if (product.id === 'draft-1') throw new Error('Límite temporal del proveedor');
      return { images: [{ id: product.id, dataUrl: 'data:image/webp;base64,QQ==' }] };
    },
  };
  vm.runInNewContext(`${generationSource}\nthis.generate = generateAiDraftImages;`, context);
  await context.generate(items);

  assert.equal(items[0].imageStatus, 'suggested');
  assert.equal(items[1].imageStatus, 'error');
  assert.match(items[1].warnings[0], /Límite temporal/);
  assert.equal(items[2].imageStatus, 'suggested');
});

test('permite poner los demás productos en cola durante una generación individual', async () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    _draftId: `draft-${index}`,
    name: `Producto ${index}`,
    imageStatus: 'none',
    imagePreviewUrl: '',
  }));
  let calls = 0;
  const context = {
    AI_IMAGE_BULK_RUNNING: false,
    AI_IMAGE_BULK_PROGRESS: null,
    AI_IMAGE_GENERATE_REST_QUEUED: false,
    AI_PRODUCTS_DRAFT: items,
    $: () => ({ value: 'clean' }),
    renderAiDraftRows: () => {},
    updateAiImageWorkflowStatus: () => {},
    releaseAiDraftImage: () => {},
    toast: () => {},
    api: async (_path, options) => {
      calls += 1;
      if (calls === 1) context.AI_IMAGE_GENERATE_REST_QUEUED = true;
      const product = JSON.parse(options.body).products[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { images: [{ id: product.id, dataUrl: 'data:image/webp;base64,QQ==' }] };
    },
  };
  vm.runInNewContext(`${generationSource}\nthis.generate = generateAiDraftImages;`, context);
  await context.generate([items[0]]);
  for (let attempt = 0; attempt < 50 && items.some((item) => item.imageStatus !== 'suggested'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(calls, 3);
  assert.ok(items.every((item) => item.imageStatus === 'suggested'));
});
