const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const db = fs.readFileSync(path.join(root, 'src', 'db', 'index.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src', 'routes', 'superadmin.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'superadmin.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public', 'js', 'superadmin.js'), 'utf8');

test('persiste etapas, próximas fechas y bitácora para prospectos y leads demo', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS sales_followup_activities/);
  assert.match(db, /ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sales_stage/);
  assert.match(db, /ALTER TABLE demo_leads ADD COLUMN IF NOT EXISTS sales_stage/);
  assert.match(db, /next_follow_up_at TIMESTAMPTZ/);
});

test('expone gestión individual y masiva con eliminación protegida por etapa', () => {
  assert.match(routes, /router\.patch\('\/follow-up\/item\/:type\/:id'/);
  assert.match(routes, /router\.patch\('\/follow-up\/bulk\/update'/);
  assert.match(routes, /router\.delete\('\/follow-up\/bulk'/);
  assert.match(routes, /BULK_DELETE_STAGES = new Set\(\['not_interested', 'lost'\]\)/);
  assert.match(routes, /sales_stage = 'won'/);
  assert.match(routes, /activity_type, note, stage_from, stage_to/);
});

test('superadmin incluye selección, etapas, notas y módulo unificado de seguimiento', () => {
  assert.match(html, /data-sa-view="follow-up"/);
  assert.match(html, /id="saFollowUpModal"/);
  assert.match(html, /id="saTenantBulkBar"/);
  assert.match(html, /id="saDemoBulkBar"/);
  assert.match(script, /Potencial a compra/);
  assert.match(script, /data-sa-sales-select/);
  assert.match(script, /Cierre no exitoso/);
  assert.match(script, /loadFollowUp\(\)/);
});
