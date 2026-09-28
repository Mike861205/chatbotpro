const test = require('node:test');
const assert = require('node:assert/strict');
const { connectionChoices, selectConnectionChoice } = require('../src/utils/zernioSetup');
const router = require('../src/routes/whatsapp');
const { encrypt, decrypt } = require('../src/utils/crypto');

test('detecta el número comprado sin confundir su ID con la cuenta de WhatsApp', () => {
  const choices = connectionChoices({ numbers: [{
    _id: 'purchased-number', socialAccountId: 'account-1', phoneNumber: '+16462174144',
    profileId: { _id: 'profile-1', name: 'Daddy Pollo' }, status: 'active',
  }] }, { accounts: [{
    _id: 'account-1', platform: 'whatsapp', profileId: { _id: 'profile-1', name: 'Daddy Pollo' },
    displayName: 'Daddy Pollo', accessToken: 'private-token',
  }] }, { profiles: [{ _id: 'profile-1', name: 'Daddy Pollo' }] });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].zernioAccountId, 'account-1');
  assert.equal(choices[0].profileId, 'profile-1');
  assert.equal(choices[0].phoneNumber, '+16462174144');
  assert.match(choices[0].label, /Daddy Pollo/);
  assert.doesNotMatch(JSON.stringify(choices), /private-token|accessToken|purchased-number/);
});

test('incluye números externos y perfiles disponibles, pero no el sandbox ni números liberados', () => {
  const choices = connectionChoices({ data: {
    connected: [{ accountId: 'external-account', phoneNumber: '+525512345678', profileId: 'profile-1' }],
    numbers: [{ socialAccountId: 'sandbox-account', phoneNumber: '+12029087457' },
      { socialAccountId: 'released-account', status: 'released', profileId: 'released-profile' }],
    sandbox: { accountId: 'sandbox-account' },
  } }, { accounts: [{ _id: 'instagram-account', platform: 'instagram', profileId: 'instagram-profile' }] },
  { profiles: [{ _id: 'profile-1', name: 'Negocio uno' }, { _id: 'profile-2', name: 'Negocio nuevo' },
    { _id: 'over-limit', isOverLimit: true }] });
  assert.deepEqual(choices.map((choice) => choice.channelId), ['account:external-account', 'profile:profile-2']);
  assert.match(choices[1].label, /Negocio nuevo.*Conectar WhatsApp/);
  assert.doesNotThrow(() => connectionChoices({ connected: {}, numbers: null }, {}, {}));
});

test('sólo selecciona automáticamente una cuenta y nunca elige otra si el identificador no coincide', () => {
  const choices = [{ channelId: 'account:a', zernioAccountId: 'a', profileId: 'p1' },
    { channelId: 'account:b', zernioAccountId: 'b', profileId: 'p2' }];
  assert.equal(selectConnectionChoice(choices), null);
  assert.equal(selectConnectionChoice([choices[0]]), choices[0]);
  assert.equal(selectConnectionChoice(choices, { channelId: 'account:b' }), choices[1]);
  assert.equal(selectConnectionChoice(choices, { profileId: 'p2' }), choices[1]);
  assert.equal(selectConnectionChoice(choices, { zernioAccountId: 'unrelated' }), null);
  assert.equal(selectConnectionChoice([choices[0]], { channelId: 'invalid' }), null);
});

test('dos cuentas del mismo perfil siguen requiriendo una elección explícita', () => {
  const choices = connectionChoices({}, { accounts: [
    { _id: 'a', platform: 'whatsapp', profileId: 'p1' },
    { _id: 'b', platform: 'whatsapp', profileId: 'p1' },
  ] }, { profiles: [{ _id: 'p1', name: 'Compartido' }] });
  assert.equal(choices.length, 2);
  assert.equal(selectConnectionChoice(choices), null);
});

function savedConnection(overrides = {}) {
  return { id: 10, profile_id: 'profile-1', zernio_account_id: 'account-1',
    waba_id: 'meta-waba', phone_number_id: 'meta-phone', phone_number: '+16462174144',
    display_name: 'Daddy Pollo', mode: 'api', status: 'active', enabled: 1,
    api_key_enc: encrypt('sk_test-private'), webhook_token_enc: encrypt('test-webhook-token'),
    webhook_secret_enc: encrypt('existing-signature'), last_error: '',
    metadata_json: JSON.stringify({ zernioWebhookId: 'webhook-1', profilePhotoSyncedAt: 'retained' }),
    ...overrides };
}

function tenantDatabase(initial) {
  let row = { ...initial };
  const writes = [];
  return { writes, current: () => row, async get(sql, values) {
    if (sql.startsWith('SELECT')) return Number(values[0]) === row.id ? row : null;
    writes.push({ sql, values });
    if (sql.includes('profile_id=$1,zernio_account_id=$2')) {
      row = { ...row, profile_id: values[0], zernio_account_id: values[1], waba_id: values[2],
        phone_number_id: values[3], phone_number: values[4], display_name: values[5], mode: values[6],
        api_key_enc: values[7] ? values[8] : row.api_key_enc,
        meta_access_token_enc: values[9] ? values[10] : row.meta_access_token_enc,
        webhook_secret_enc: values[11] ? values[12] : row.webhook_secret_enc,
        metadata_json: values[13], last_error: '',
        status: values[15] ? 'pending' : row.status, enabled: values[15] ? 0 : row.enabled };
    } else if (sql.includes('webhook_secret_enc=$1')) {
      row = { ...row, webhook_secret_enc: values[0], metadata_json: values[1],
        last_error: row.last_error === values[3] ? '' : row.last_error };
    } else if (sql.includes("status='active'")) {
      row = { ...row, status: 'active', enabled: 1 };
    } else if (sql.includes("status='pending'")) {
      row = { ...row, status: 'pending', enabled: 0, last_error: values[0] };
    } else if (sql.includes('metadata_json=$1,last_error=$2')) {
      row = { ...row, metadata_json: values[0], last_error: values[1] };
    } else throw new Error('Unexpected SQL in test');
    return row;
  } };
}

async function invoke(path, body, tdb) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods.post).route;
  let status = 200, data, error;
  const req = { body, tdb, user: { role: 'owner' }, tenant: { slug: 'test-tenant', business_name: 'Daddy Pollo' },
    protocol: 'https', get: () => 'chatbotpro.example.com' };
  const res = { status(value) { status = value; return this; }, json(value) { data = value; return this; } };
  await route.stack.at(-1).handle(req, res, (value) => { error = value; });
  return { status, data, error };
}

function provider(t, { multiple = false, healthError = '', webhookError = '', authError = false } = {}) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    let data = {}, status = 200;
    if (authError) { status = 401; data = { error: 'Invalid API key' }; }
    else if (path.endsWith('/phone-numbers')) data = {
      numbers: [{ socialAccountId: 'account-1', phoneNumber: '+16462174144', profileId: 'profile-1' }],
      sandbox: { accountId: 'sandbox-account', phoneNumber: '+12029087457', template: { name: 'sandbox_start' } },
    };
    else if (path.endsWith('/accounts')) data = { accounts: [
      { _id: 'account-1', platform: 'whatsapp', displayName: 'Daddy Pollo', profileId: 'profile-1', accessToken: 'private-provider-token' },
      ...(multiple ? [{ _id: 'account-2', platform: 'whatsapp', profileId: 'profile-2' }] : []),
    ] };
    else if (path.endsWith('/profiles')) data = { profiles: [{ _id: 'profile-1', name: 'Default' }] };
    else if (path.endsWith('/number-info')) {
      data = healthError ? { error: healthError } : { phoneNumber: '+16462174144' };
      status = healthError ? 400 : 200;
    } else if (path.endsWith('/webhooks/settings')) {
      data = options.method === 'GET' ? { webhooks: [{ _id: 'webhook-1' }] }
        : { webhook: { _id: 'webhook-1', secret: 'private-provider-signature' } };
      if (webhookError) { data = { error: webhookError }; status = 500; }
    } else throw new Error('Unexpected Zernio URL in test');
    return new Response(JSON.stringify(data), { status });
  };
  t.after(() => { global.fetch = originalFetch; });
  return requests;
}

test('consulta las cuentas con la clave cifrada guardada del tenant sin devolver credenciales', async (t) => {
  const requests = provider(t);
  const db = tenantDatabase(savedConnection());
  const result = await invoke('/connections/discover', { id: 10, mode: 'api' }, db);
  assert.equal(result.error, undefined);
  assert.equal(result.data.choices[0].zernioAccountId, 'account-1');
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer sk_test-private'));
  assert.doesNotMatch(JSON.stringify(result.data), /sk_test-private|accessToken|private-provider-token/);
  assert.equal(db.writes.length, 0);
});

test('un ID de conexión ajeno al tenant no puede reutilizar su API key', async (t) => {
  const requests = provider(t);
  const result = await invoke('/connections/discover', { id: 999, mode: 'api' }, tenantDatabase(savedConnection()));
  assert.equal(result.error.status, 404);
  assert.equal(requests.length, 0);
});

test('guardar conserva IDs de Meta y secretos existentes, valida el número y registra el webhook', async (t) => {
  const requests = provider(t);
  const db = tenantDatabase(savedConnection());
  const result = await invoke('/connections', { id: 10, mode: 'api', channelId: 'account:account-1' }, db);
  assert.equal(result.error, undefined);
  assert.equal(result.data.connection.enabled, true);
  assert.equal(db.current().waba_id, 'meta-waba');
  assert.equal(db.current().phone_number_id, 'meta-phone');
  assert.equal(decrypt(db.current().api_key_enc), 'sk_test-private');
  assert.equal(decrypt(db.current().webhook_secret_enc), 'existing-signature');
  assert.equal(JSON.parse(db.current().metadata_json).profilePhotoSyncedAt, 'retained');
  assert.equal(result.data.webhookSetup.registered, true);
  const hook = requests.find(({ options }) => options.method === 'PUT');
  assert.deepEqual(JSON.parse(hook.options.body).accountIds, ['account-1']);
  assert.doesNotMatch(JSON.stringify(result.data), /api_key_enc|webhook_secret_enc|private-provider-signature|existing-signature|sk_test-private/);
});

test('no crea ni cambia la conexión cuando hay varias cuentas y falta elegir', async (t) => {
  provider(t, { multiple: true });
  const db = tenantDatabase(savedConnection());
  const result = await invoke('/connections', { apiKey: 'sk_test-private', mode: 'api' }, db);
  assert.equal(result.status, 409);
  assert.equal(result.data.choices.length, 2);
  assert.equal(db.writes.length, 0);
});

test('el registro correcto del webhook no oculta un número aún pendiente de activar', async (t) => {
  provider(t, { healthError: 'Number not connected' });
  const result = await invoke('/connections', { id: 10, mode: 'api' }, tenantDatabase(savedConnection()));
  assert.equal(result.error, undefined);
  assert.equal(result.data.webhookSetup.registered, true);
  assert.equal(result.data.connection.enabled, false);
  assert.equal(result.data.connection.status, 'pending');
  assert.equal(result.data.connection.lastError, 'Number not connected');
});

test('los fallos de webhook se devuelven como pendientes y no como éxito de recepción', async (t) => {
  provider(t, { webhookError: 'Webhook setup unavailable' });
  const result = await invoke('/connections', { id: 10, mode: 'api' }, tenantDatabase(savedConnection()));
  assert.equal(result.error, undefined);
  assert.equal(result.data.webhookSetup.registered, false);
  assert.equal(result.data.connection.webhookError, 'Webhook setup unavailable');
});

test('sandbox detecta su cuenta automáticamente y no solicita IDs de producción', async (t) => {
  const requests = provider(t);
  const db = tenantDatabase(savedConnection({ mode: 'sandbox', profile_id: '', zernio_account_id: 'sandbox-account',
    phone_number: '+12029087457', metadata_json: JSON.stringify({ sandbox: { phone: '+525512345678', status: 'active' } }) }));
  const result = await invoke('/connections', { id: 10, mode: 'sandbox' }, db);
  assert.equal(result.error, undefined);
  assert.equal(result.data.connection.sandbox.phone, '+525512345678');
  assert.equal(result.data.connection.zernioAccountId, 'sandbox-account');
  assert.equal(result.data.connection.enabled, true);
  assert.equal(requests.filter(({ url }) => url.includes('/accounts') || url.includes('/profiles')).length, 0);
  const hook = requests.find(({ options }) => options.method === 'POST');
  const body = JSON.parse(hook.options.body);
  assert.equal(body.accountIds, undefined);
  assert.equal(body.profileIds, undefined);
});

test('una API key inválida no guarda cambios y una clave pegada como Profile ID se rechaza', async (t) => {
  provider(t, { authError: true });
  const db = tenantDatabase(savedConnection());
  const failed = await invoke('/connections', { id: 10, mode: 'api', apiKey: 'sk_wrong' }, db);
  assert.equal(failed.error.providerStatus, 401);
  const misplaced = await invoke('/connections', { id: 10, profileId: 'sk_misplaced' }, db);
  assert.equal(misplaced.status, 400);
  assert.equal(db.writes.length, 0);
});
