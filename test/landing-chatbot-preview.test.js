const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleMessage } = require('../src/chatbot/engine');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('la landing ofrece un botón flotante que abre el asistente de prueba en primer plano', () => {
  const landing = read('public', 'index.html');
  const styles = read('public', 'css', 'styles.css');
  assert.match(landing, /id="orderDemoFab"[\s\S]*Haz tu pedido de prueba/);
  assert.match(landing, /class="signup-promo-try" id="signupPromoLater"[\s\S]*Haz tu pedido de prueba/);
  assert.match(landing, /id="orderDemoModal"[\s\S]*id="orderDemoFrame"/);
  assert.match(landing, /chatbotPreviewUrl[\s\S]*openOrderDemo/);
  assert.match(styles, /\.order-demo-fab[\s\S]*\.order-demo-bg[\s\S]*\.order-demo-shell/);
  assert.match(styles, /\.signup-promo-try[\s\S]*\.signup-promo-try-icon/);
});

test('la vista de prueba conserva el flujo del chat y muestra el registro al finalizar', () => {
  const chat = read('public', 'chat.html');
  const route = read('src', 'routes', 'chatbot.js');
  const auth = read('src', 'routes', 'auth.js');
  assert.match(chat, /preview: isPreview/);
  assert.match(chat, /preview-signup-card/);
  assert.match(chat, /Crear mi cuenta/);
  assert.match(chat, /Enviar pedido de prueba por WhatsApp/);
  assert.match(chat, /target="_top"/);
  assert.match(route, /req\.tenant\.slug === config\.DEMO_TENANT_SLUG/);
  assert.match(auth, /chatbotPreviewUrl:[\s\S]*\/c\/\$\{encodeURIComponent\(config\.DEMO_TENANT_SLUG\)\}/);
});

test('confirmar un pedido de prueba no crea pedidos, clientes, stock ni notificaciones', async () => {
  let state = {
    step: 'confirm',
    cart: [{ id: 1, name: 'Hamburguesa demo', qty: 1, price: 80 }],
    customer: { name: 'Cliente prueba', phone: '6141234567', paymentMethod: 'cash', cashChangePreference: 'exact' },
    delivery: 'recoger',
    receivingMode: { behavior: 'branch', label: 'Recoger en sucursal' },
    currency: 'MXN',
    aiHistory: [],
  };
  const db = {
    async get(sql, params = []) {
      if (sql.includes('chat_sessions')) return { state: JSON.stringify(state) };
      if (sql.includes('settings')) return params[0] === 'whatsapp' ? { value: '526141234567' } : null;
      throw new Error(`La prueba no debe consultar datos operativos: ${sql}`);
    },
    async all(sql) {
      if (sql.includes('settings')) return [];
      throw new Error(`La prueba no debe consultar catálogos operativos: ${sql}`);
    },
    async run(sql, params) {
      if (!sql.includes('chat_sessions')) throw new Error(`La prueba no debe escribir datos operativos: ${sql}`);
      state = JSON.parse(params[1]);
      return { changes: 1 };
    },
  };

  const reply = await handleMessage(db, 'demo', 'preview-session', 'confirm_yes', {
    previewOrder: true,
    registrationUrl: '/register?source=chatbot-demo',
  });

  assert.equal(reply.previewComplete, true);
  assert.equal(reply.order.preview, true);
  assert.match(reply.order.whatsappLink, /^https:\/\/wa\.me\/526141234567\?text=/);
  assert.match(decodeURIComponent(reply.order.whatsappLink), /PEDIDO DE PRUEBA PRUEBA-PREVIEWS/);
  assert.equal(reply.registrationUrl, '/register?source=chatbot-demo');
  assert.equal(state.step, 'order_complete');
  assert.match(reply.messages.join(' '), /pedido de prueba está listo/i);
});
