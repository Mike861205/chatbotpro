const test = require('node:test');
const assert = require('node:assert/strict');

const notificationsPath = require.resolve('../src/notifications');
const configPath = require.resolve('../src/config');
const dbPath = require.resolve('../src/db');
const webpushPath = require.resolve('web-push');

function stubModule(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [], paths: [] };
}

function loadNotifications({ subscriptions = [], queryError = null, sendError = null } = {}) {
  const originals = new Map([
    [configPath, require.cache[configPath]],
    [dbPath, require.cache[dbPath]],
    [webpushPath, require.cache[webpushPath]],
  ]);
  const calls = { sends: [], deletes: [], queries: [] };

  require.cache[configPath] = stubModule(configPath, {
    VAPID_PUBLIC_KEY: 'public-key',
    VAPID_PRIVATE_KEY: 'private-key',
    VAPID_SUBJECT: 'mailto:test@example.com',
  });
  require.cache[dbPath] = stubModule(dbPath, {
    tdb: () => ({
      all: async (sql, params) => {
        calls.queries.push({ sql, params });
        if (queryError) throw queryError;
        return subscriptions;
      },
      run: async (sql, params) => calls.deletes.push({ sql, params }),
    }),
  });
  require.cache[webpushPath] = stubModule(webpushPath, {
    setVapidDetails: () => {},
    sendNotification: async (subscription, payload, options) => {
      calls.sends.push({ subscription, payload: JSON.parse(payload), options });
      if (sendError) throw sendError;
    },
  });

  delete require.cache[notificationsPath];
  const notifications = require(notificationsPath);
  delete require.cache[notificationsPath];
  for (const [id, original] of originals) {
    if (original) require.cache[id] = original;
    else delete require.cache[id];
  }

  return { notifications, calls };
}

test('sendTenantPush procesa el arreglo devuelto por tdb.all', async () => {
  const subscription = {
    endpoint: 'https://push.example/subscription-1',
    p256dh: 'p256dh-key',
    auth: 'auth-key',
  };
  const { notifications, calls } = loadNotifications({ subscriptions: [subscription] });

  const result = await notifications.sendTenantPush('demo', { title: 'Pedido nuevo' });

  assert.deepEqual(result, { sent: 1, dead: 0, invalid: 0 });
  assert.equal(calls.sends.length, 1);
  assert.deepEqual(calls.sends[0].subscription, {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
  });
});

test('sendTenantPush termina sin error cuando no hay suscripciones', async () => {
  const { notifications, calls } = loadNotifications();

  const result = await notifications.sendTenantPush('demo', { title: 'Pedido nuevo' });

  assert.deepEqual(result, { sent: 0, skipped: 'no_subscriptions' });
  assert.equal(calls.sends.length, 0);
});

test('sendTenantPush omite registros inválidos y elimina endpoints expirados', async () => {
  const subscriptions = [
    { endpoint: '', p256dh: 'key', auth: 'auth' },
    { endpoint: 'https://push.example/expired', p256dh: 'key', auth: 'auth' },
  ];
  const { notifications, calls } = loadNotifications({
    subscriptions,
    sendError: { statusCode: 410, message: 'Gone' },
  });

  const result = await notifications.sendTenantPush('demo', { title: 'Pedido nuevo' });

  assert.deepEqual(result, { sent: 0, dead: 1, invalid: 1 });
  assert.equal(calls.sends.length, 1);
  assert.deepEqual(calls.deletes[0].params, ['https://push.example/expired']);
});
test('sendTenantPush entrega cada evento sólo a los dispositivos de su tema', async () => {
  const { notifications, calls } = loadNotifications();

  await notifications.sendTenantPush('demo', { title: 'Pedido nuevo' });
  await notifications.sendTenantPush('demo', { title: 'Mensaje' }, { topic: 'whatsapp' });

  assert.deepEqual(calls.queries[0].params, [['orders', 'all']]);
  assert.deepEqual(calls.queries[1].params, [['whatsapp', 'all']]);
  assert.match(calls.queries[0].sql, /WHERE topic = ANY\(\$1\)/);
});
