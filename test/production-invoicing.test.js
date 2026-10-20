const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { productionFilters, productionDocumentSql } = require('../src/utils/productionInvoicing');

test('filtros fiscales rechazan fechas y tipos inválidos antes de consultar', () => {
  assert.throws(() => productionFilters({ from: '2026-02-30' }), /fecha válida/);
  assert.throws(() => productionFilters({ from: '2026-11-01', to: '2026-10-01' }), /fecha inicial/);
  assert.throws(() => productionFilters({ type: 'sandbox' }), /Tipo de CFDI/);
  assert.throws(() => productionFilters({ tenantId: '1 OR 1=1' }), /Tenant inválido/);
});

test('consulta todos los tipos de CFDI sólo en Producción y liga consumo al documento', () => {
  const filters = productionFilters({ type: 'credit_note', status: 'active', from: '2026-10-01', to: '2026-10-31', search: 'RORD' });
  const built = productionDocumentSql([{ id: 7, slug: 'asadero-la-joya' }], filters);
  assert.match(built.cte, /"t_asadero_la_joya"\.invoices/);
  assert.match(built.cte, /"t_asadero_la_joya"\.global_invoices/);
  assert.match(built.cte, /"t_asadero_la_joya"\.direct_invoices/);
  assert.match(built.cte, /"t_asadero_la_joya"\.payment_complements/);
  assert.equal((built.cte.match(/environment='production'/g) || []).length, 4);
  assert.match(built.cte, /sl\.movement_type='consumed'/);
  assert.match(built.cte, /sl\.invoice_type=CASE WHEN di\.document_kind/);
  assert.deepEqual(built.params, ['credit_note', 'active', '2026-10-01', '2026-10-31', '%RORD%']);
  assert.equal(productionDocumentSql([], filters), null);
});

test('SuperAdmin expone un módulo propio y restringe el endpoint', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'public/superadmin.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'public/js/superadmin.js'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'src/routes/superadmin.js'), 'utf8');
  assert.match(html, /data-sa-view="production-invoicing"/);
  assert.match(html, /id="saViewProductionInvoicing"/);
  assert.match(script, /loadProductionInvoicing\(\)/);
  assert.match(route, /router\.get\('\/production-invoicing', requireSuperAdmin/);
});
