const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const db = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src', 'routes', 'auth.js'), 'utf8');
const middleware = fs.readFileSync(path.join(root, 'src', 'middleware', 'auth.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

test('solo los propietarios registrados desde ahora reciben el onboarding inicial', () => {
  assert.match(db, /onboarding_completed INTEGER NOT NULL DEFAULT 1/);
  assert.match(auth, /INSERT INTO users \(tenant_id, username, password_hash, onboarding_completed\)[\s\S]{0,100}SELECT id, \$8, \$9, 0 FROM new_tenant/);
  assert.match(middleware, /onboardingCompleted: Number\(authUser\.onboarding_completed \|\| 0\) === 1/);
  assert.match(auth, /onboardingRequired: req\.user\.role === 'owner'.*!req\.user\.impersonated/);
});

test('el estado se guarda al cerrar o comenzar la capacitación', () => {
  assert.match(auth, /router\.post\('\/onboarding\/complete', requireAuth, requireOwner/);
  assert.match(auth, /UPDATE users SET onboarding_completed = 1 WHERE id = \$1/);
  assert.match(script, /async function completeOnboarding\(\)/);
  assert.match(script, /ME\.onboardingRequired = false/);
});

test('el panel incluye el módulo permanente debajo de Pedidos en vivo y los seis pasos', () => {
  const liveOrdersIndex = html.indexOf('Pedidos en vivo');
  const instructionsIndex = html.indexOf('data-view="instrucciones"');
  assert.ok(liveOrdersIndex >= 0 && instructionsIndex > liveOrdersIndex);
  assert.match(html, /id="view-instrucciones"/);
  assert.match(html, /id="onboardingIntro"/);
  assert.match(html, /¡Bienvenido!.*módulo <b>Instrucciones<\/b>/);
  assert.match(script, /const ONBOARDING_STEPS = \[/);
  assert.match(script, /onboarding-action-btn action-\$\{step\.action\}/);
  assert.equal((script.match(/number: [1-6],/g) || []).length, 6);
  for (const destination of ['config', 'chatbot', 'productos', 'chatbot-preview', 'pos', 'kds']) {
    assert.match(script, new RegExp(`action: '${destination}'`));
  }
});
