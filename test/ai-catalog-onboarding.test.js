const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const auth = read('src', 'routes', 'auth.js');
const products = read('src', 'routes', 'products.js');
const html = read('public', 'app.html');
const script = read('public', 'js', 'app.js');
const css = read('public', 'css', 'styles.css');

test('consulta el catálogo real por tenant y no invita a cajeros, equipo, demos ni sesiones impersonadas', () => {
  assert.match(products, /router\.get\('\/catalog-status', async \(req, res, next\) => \{[\s\S]*FROM \{s\}\.products[\s\S]*hasProducts: total > 0/);
  assert.match(auth, /impersonated: Boolean\(req\.user\.impersonated\)/);
  assert.match(script, /ME\?\.role === 'owner'[\s\S]*!ME\?\.impersonated[\s\S]*!ME\?\.demoSession[\s\S]*PRODUCT_CATALOG_TOTAL === 0[\s\S]*!ME\?\.identityRequired/);
  assert.match(script, /api\('\/api\/products\/catalog-status'\)/);
  assert.match(script, /PRODUCT_CATALOG_TOTAL = PRODUCTS_CACHE\.length/);
});

test('tras completar identidad el catálogo vacío dirige a Productos y abre primero la invitación IA', () => {
  assert.match(script, /function presentStartupJourney\(\)[\s\S]*ME\?\.identityRequired[\s\S]*shouldOfferEmptyCatalogAi\(\)[\s\S]*ME\?\.trial\?\.isActive/);
  assert.match(script, /function openNextInitialSetup\(\)[\s\S]*openEmptyCatalogAiWelcome\(\)[\s\S]*openOnboardingIntro\(\)/);
  assert.match(script, /const view = shouldOfferEmptyCatalogAi\(\) \? 'productos' : normalizeView/);
  assert.match(script, /setTimeout\(presentStartupJourney, 140\)/);
  assert.match(html, /id="emptyCatalogAiModal"[\s\S]*id="emptyCatalogMenuImage"[\s\S]*id="emptyCatalogAiExplore"/);
  assert.match(css, /\.empty-catalog-ai-bg[\s\S]*\.empty-catalog-ai-modal/);
});

test('la foto elegida pasa al importador existente, inicia análisis y permite continuar sin bloquear el panel', () => {
  assert.match(script, /async function launchEmptyCatalogAi\(files = \[\]\)[\s\S]*openAiImportModal\(files\)/);
  assert.match(script, /function openAiImportModal\(files = \[\]\)[\s\S]*transfer\.items\.add\(file\)[\s\S]*requestSubmit\(\)/);
  assert.match(script, /id === 'emptyCatalogAiModal'\) closeEmptyCatalogAiWelcome\(\)/);
  assert.match(script, /function closeEmptyCatalogAiWelcome\([\s\S]*EMPTY_CATALOG_PROMPT_DISMISSED = true[\s\S]*presentStartupJourney/);
  assert.match(script, /function closeAiImportModal\(\)[\s\S]*EMPTY_CATALOG_AI_FLOW_ACTIVE[\s\S]*presentStartupJourney/);
  assert.match(html, /Nada se publica automáticamente: podrás editar todo antes de guardarlo/);
});
