const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const schema = read('src', 'db', 'index.js');
const settings = read('src', 'routes', 'settings.js');
const pos = read('src', 'routes', 'pos.js');
const html = read('public', 'app.html');
const app = read('public', 'js', 'app.js');

test('guarda una bitácora tenant de cancelaciones y correcciones', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS "\$\{s\}"\.sales_audit_log/);
  assert.match(schema, /actor_username TEXT NOT NULL/);
  assert.match(schema, /authorized_by TEXT NOT NULL/);
  assert.match(pos, /eventType: 'sale_cancelled'/);
  assert.match(pos, /eventType: nextItems\.length \? 'table_round_edited' : 'table_round_deleted'/);
  assert.match(pos, /eventType: 'sale_payment_edited'/);
});

test('el tenant controla operaciones sensibles con un NIP que nunca se expone', () => {
  assert.match(settings, /bcrypt\.hash\(pin, 12\)/);
  assert.match(settings, /authorization_pin_configured = Boolean\(pinSetting\)/);
  assert.doesNotMatch(settings.match(/const SETTING_KEYS = \[[\s\S]+?\];/)?.[0] || '', /pos_authorization_pin_hash/);
  assert.match(pos, /bcrypt\.compare\(String\(pin \|\| ''\), policy\.pinHash\)/);
  assert.match(html, /id="operationPolicyForm"/);
  assert.match(app, /pos_round_edit_require_pin/);
  assert.match(app, /pos_cancel_require_pin/);
});

test('sólo cancela ventas POS del mismo día y restaura inventario atómicamente', () => {
  assert.match(pos, /AS is_today/);
  assert.match(pos, /Sólo se pueden cancelar ventas del mismo día/);
  assert.match(pos, /req\.tdb\.tx\(async \(tx\) =>/);
  assert.match(pos, /restoreBranchStockForCancelledSale\(tx/);
  assert.match(pos, /insertSalesAudit\(tx, req/);
});

test('permite corregir rondas y muestra módulos owner de auditoría y cortes', () => {
  assert.match(pos, /router\.put\('\/table-accounts\/:accountId\/rounds\/:roundId'/);
  assert.match(pos, /remainingRounds\.flatMap/);
  assert.match(pos, /router\.get\('\/audit-log', requireOwner/);
  assert.match(pos, /router\.get\('\/cuts', requireOwner/);
  assert.match(html, /data-view="cancelaciones"/);
  assert.match(html, /data-view="cortes"/);
  assert.match(app, /openPosRoundEditModal/);
  assert.match(app, /POS_PAYMENT_METHOD === 'cash'\) POS_PAYMENT_FORM\.cashReceived = String\(posGrandTotal\(\)\)/);
  assert.match(app, /loadAuditLog/);
  assert.match(app, /loadCutsHistory/);
});

test('cortes permite buscar, filtrar, paginar e imprimir reportes generales', () => {
  assert.match(pos, /\[10, 20, 40, 60\]\.includes\(requestedPageSize\)/);
  assert.match(pos, /String\(req\.query\.search \|\| ''\)/);
  assert.match(pos, /branchId === 'general'/);
  assert.match(pos, /Promise\.all\(rows\.map/);
  assert.match(html, /id="cutsBranchFilter"/);
  assert.match(html, /<option value="60">60 por página<\/option>/);
  assert.match(html, /id="cutsDetailModal"/);
  assert.match(app, /data-print-cut/);
  assert.match(app, /printPosCloseReport\(historicalCutResult/);
});

test('auditoría permite periodos, sucursal, resumen, paginación e impresión de evidencia', () => {
  assert.match(pos, /\[10, 20, 50\]\.includes\(requestedPageSize\)/);
  assert.match(pos, /filter === 'today'/);
  assert.match(pos, /filter === 'week'/);
  assert.match(pos, /filter === 'custom'/);
  assert.match(pos, /AS cancellations/);
  assert.match(pos, /AS round_edits/);
  assert.match(html, /id="auditSummaryCards"/);
  assert.match(html, /id="auditBranchFilter"/);
  assert.match(html, /<option value="50">50 por página<\/option>/);
  assert.match(html, /id="auditDetailModal"/);
  assert.match(app, /auditSnapshotHtml/);
  assert.match(app, /data-print-audit/);
  assert.match(app, /function printAuditEvent/);
});