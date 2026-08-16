const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('el backend de configuración expone endpoint POST /ai-promo-texts con OpenAI y fallback estructurado', () => {
  const settingsJs = fs.readFileSync(path.join(__dirname, '../src/routes/settings.js'), 'utf8');
  assert.match(settingsJs, /router\.post\('\/ai-promo-texts'/);
  assert.match(settingsJs, /buildFallbackPromoTexts/);
  assert.match(settingsJs, /getSuperAdminSetting\('openai_model'/);
  assert.match(settingsJs, /openai\.chat\.completions\.create/);
});

test('la interfaz de chatbot incluye el disparador de IA y el modal de generación de copies para redes y WhatsApp', () => {
  const appHtml = fs.readFileSync(path.join(__dirname, '../public/app.html'), 'utf8');
  assert.match(appHtml, /id="openAiPromoBtn"/);
  assert.match(appHtml, /id="aiPromoModal"/);
  assert.match(appHtml, /id="aiPromoGoal"/);
  assert.match(appHtml, /id="aiPromoResults"/);

  const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(appJs, /openAiPromoModal/);
  assert.match(appJs, /generateAiPromoTexts/);
  assert.match(appJs, /renderAiPromoResults/);
  assert.match(appJs, /\/api\/settings\/ai-promo-texts/);
});
