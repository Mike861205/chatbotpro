const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildClientSummary } = require('../src/utils/customerLifecycle');

test('resume clientes, ingresos y licencias con estados de cobranza', () => {
  const summary = buildClientSummary([
    { account_status: 'active', billing_status: 'active', mora_days: 0, total_paid: 1250, license_count: 3 },
    { account_status: 'active', billing_status: 'due', mora_days: 4, total_paid: 800, license_count: 2 },
    { account_status: 'inactive', billing_status: 'suspended', mora_days: 12, total_paid: 400, license_count: 1 },
  ]);

  assert.deepEqual(summary, {
    totalClients: 3,
    activeClients: 1,
    billingDue: 1,
    inMora: 2,
    incomeTotal: 2450,
    licenseCount: 6,
  });
});

test('el primer pago promueve al tenant y las vistas separan prospectos de clientes', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'superadmin.js'), 'utf8');
  assert.match(route, /customer_since = COALESCE\(customer_since, \$2::date\)/);
  assert.match(route, /const where = \['t\.customer_since IS NULL'\]/);
  assert.match(route, /const where = \['t\.customer_since IS NOT NULL'\]/);
  assert.match(route, /becameClient: !tenant\.customer_since/);
});

test('el superadmin incluye módulo de clientes, indicadores e historial de pagos', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'superadmin.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'superadmin.js'), 'utf8');
  assert.match(html, /data-sa-view="clients"/);
  assert.match(html, /id="saClientSummary"/);
  assert.match(html, /id="saPaymentsModal"/);
  assert.match(script, /Número de licencias/);
});
