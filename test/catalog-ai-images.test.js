const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'products.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'styles.css'), 'utf8');

test('el catálogo genera y guarda imágenes IA sin sobrescribir fotos existentes', () => {
  assert.match(routes, /router\.post\('\/ai\/images\/catalog'/);
  assert.match(routes, /resolveExistingPublicMediaPath\(product\.image\)/);
  assert.match(routes, /if \(currentImage\)[\s\S]*?already_has_image/);
  assert.match(routes, /image IS NOT DISTINCT FROM \$3/);
  assert.match(routes, /saveImageBuffer\(generated\.buffer/);
  assert.match(routes, /categoryName: product\.category_name/);
});

test('el lote global limita a cinco y procesa en serie para no saturar la IA', () => {
  assert.match(routes, /productIds[\s\S]*?\.slice\(0, 5\)/);
  assert.match(routes, /catalogImageGenerationLocks\.has/);
  assert.match(routes, /for \(const product of products\)/);
  assert.doesNotMatch(routes, /Promise\.all\(products\.map/);
  assert.match(routes, /limit: 5/);
});

test('Productos ofrece generación individual y global sólo para imágenes faltantes', () => {
  assert.match(html, /id="generateCatalogImagesBtn"/);
  assert.match(html, /id="catalogAiImageStatus"[\s\S]*?aria-live="polite"/);
  assert.match(app, /data-generate-product-image/);
  assert.match(app, /if \(productHasCatalogImage\(product\)\) return ''/);
  assert.match(app, /\.slice\(0, 5\)/);
  assert.match(app, /\/api\/products\/ai\/images\/catalog/);
  assert.match(app, /Generando \$\{selected\.length\}[\s\S]*?selected\.map\(\(product\) => \(\{ id: Number\(product\.id\), name: product\.name, status: 'running' \}\)\)/);
  assert.match(app, /stateLabels = \{ running: 'Generando', generated: 'Imagen creada', skipped: 'Omitido', error: 'No generada' \}/);
  assert.match(css, /\.catalog-ai-image-btn/);
  assert.match(css, /\.btn-ai-images\.is-generating/);
  assert.match(css, /\.catalog-ai-image-products/);
});
