const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'superadmin.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'superadmin.js'), 'utf8');

test('prospectos y leads ofrecen filtros por profundidad de módulos', () => {
  assert.match(html, /id="saTenantModuleFilter"[\s\S]+1–2 módulos[\s\S]+3–4 módulos[\s\S]+5–9 módulos[\s\S]+10\+ módulos/);
  assert.match(html, /id="saDemoModuleFilter"[\s\S]+1–2 módulos[\s\S]+3–4 módulos[\s\S]+5–9 módulos[\s\S]+10\+ módulos/);
  assert.match(script, /function matchesModuleFilter\(entity, filter\)/);
  assert.match(script, /saTenantModuleFilter[\s\S]+renderTenantTable/);
  assert.match(script, /saDemoModuleFilter[\s\S]+renderDemoLeadsTable/);
});

test('la búsqueda admite identificadores y métricas y ordena con paginación', () => {
  assert.match(script, /t\.id[\s\S]+t\.module_count, t\.module_views/);
  assert.match(script, /lead\.id[\s\S]+lead\.module_count, lead\.module_views/);
  assert.match(script, /compareBySortKey/);
  assert.match(script, /paginateArray/);
  assert.match(script, /sortableHeader/);
  assert.match(script, /renderPaginationBar/);
});