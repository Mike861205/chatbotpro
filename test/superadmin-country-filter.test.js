const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('filtra prospectos del SuperAdmin por país normalizado', () => {
  const html = read('public/superadmin.html');
  const client = read('public/js/superadmin.js');

  assert.match(html, /id="saTenantCountryFilter"/);
  assert.match(html, /Todos los países/);
  assert.match(client, /function renderTenantCountryFilter\(\)/);
  assert.match(client, /String\(t\.phone_country \|\| ''\)\.toUpperCase\(\) !== country/);
  assert.match(client, /#saTenantCountryFilter.*addEventListener\('change'/);
});

test('filtra leads demo del SuperAdmin por país normalizado', () => {
  const html = read('public/superadmin.html');
  const client = read('public/js/superadmin.js');

  assert.match(html, /id="saDemoCountryFilter"/);
  assert.match(client, /renderCountryFilter\('#saDemoCountryFilter', SA_DEMO_LEADS\)/);
  assert.match(client, /String\(lead\.phone_country \|\| ''\)\.toUpperCase\(\) !== country/);
  assert.match(client, /#saDemoCountryFilter.*addEventListener\('change'/);
});