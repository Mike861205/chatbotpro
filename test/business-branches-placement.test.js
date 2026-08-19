const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');

test('sucursales se administra en Mi negocio entre identidad y cajeros', () => {
  const businessView = html.slice(html.indexOf('id="view-config"'));
  const identityIndex = businessView.indexOf('Identidad del negocio');
  const branchesIndex = businessView.indexOf('id="branchTable"');
  const cashiersIndex = businessView.indexOf('Cajeros y cajas');

  assert.ok(identityIndex >= 0);
  assert.ok(branchesIndex > identityIndex);
  assert.ok(cashiersIndex > branchesIndex);
  assert.equal((html.match(/id="branchTable"/g) || []).length, 1);
});

test('Mi negocio carga sucursales antes de renderizar cajeros', () => {
  assert.match(script, /async function fillConfigForm\(\)[\s\S]+await loadBranches\(\);\s+await loadCashiers\(\);/);
});