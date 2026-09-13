const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildProductImagePrompt, normalizeImageStyle } = require('../src/utils/productImageGeneration');

const root = path.join(__dirname, '..');

test('el prompt visual respeta componentes fijos y prohíbe texto e ingredientes inventados', () => {
  const prompt = buildProductImagePrompt({
    name: 'Alitas',
    categoryName: 'Alitas',
    description: '8 piezas; incluye papas',
    imageInstruction: 'Plato negro y fondo oscuro',
  }, { businessType: 'restaurant', style: 'dark' });
  assert.match(prompt, /Alitas/);
  assert.match(prompt, /incluye papas/);
  assert.match(prompt, /Plato negro y fondo oscuro/);
  assert.match(prompt, /No inventes ingredientes/);
  assert.match(prompt, /Sin palabras, letras, precios, promociones, logotipos/);
  assert.equal(normalizeImageStyle('desconocido'), 'clean');
});

test('la carga IA integra recortes, generación bajo demanda y aprobación antes de importar', () => {
  const routes = fs.readFileSync(path.join(root, 'src/routes/products.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/app.html'), 'utf8');
  assert.match(routes, /router\.post\('\/ai\/images\/generate'/);
  assert.match(routes, /attachMenuImageCandidates/);
  assert.match(routes, /client\.images\.generate/);
  assert.match(ui, /initializeAiDraftImages/);
  assert.match(ui, /acceptAiDraftImage/);
  assert.match(ui, /Sólo las aceptadas se importarán/);
  assert.match(html, /id="aiGenerateMissingImages"/);
  assert.match(html, /id="aiAcceptSuggestedImages"/);
});

test('SuperAdmin permite configurar por separado el modelo de generación de imágenes', () => {
  const routes = fs.readFileSync(path.join(root, 'src/routes/superadmin.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'public/js/superadmin.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/superadmin.html'), 'utf8');
  assert.match(routes, /openai_image_model/);
  assert.match(routes, /openaiImageModel/);
  assert.match(ui, /saOpenAiImageModel/);
  assert.match(html, /id="saOpenAiImageModel"/);
});
