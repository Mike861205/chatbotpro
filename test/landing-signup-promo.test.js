const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const landing = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'styles.css'), 'utf8');

test('la landing abre una invitación de registro gratuito con los cinco días y pruebas reales', () => {
  assert.match(landing, /id="signupPromoModal"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(landing, /Regístrate <em>GRATIS<\/em>/);
  assert.match(landing, /Productos[\s\S]+Imágenes[\s\S]+Pedidos[\s\S]+Ventas[\s\S]+Impresiones/);
  assert.match(landing, /5 días/);
  assert.match(landing, /INNOVAR es parte del éxito de tu negocio/);
  assert.match(landing, /openSignupPromo\(\);/);
});

test('la invitación dirige al registro y conserva la referencia del reseller', () => {
  assert.match(landing, /id="signupPromoRegister" href="\/register"/);
  assert.match(landing, /signupPromoRegister'\)\.href = `\/register\?reseller=\$\{encodeURIComponent\(resellerRef\)\}`/);
  assert.match(styles, /\.signup-promo-card/);
  assert.match(styles, /@media \(max-width: 700px\)/);
});
