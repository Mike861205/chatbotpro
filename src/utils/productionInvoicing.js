const { schemaName } = require('../db');

const DOCUMENT_TYPES = new Set(['individual', 'global', 'direct', 'manual_global', 'credit_note', 'payment']);
const DOCUMENT_STATUSES = new Set(['pending', 'unknown', 'active', 'cancel_pending', 'canceled', 'failed']);

function dateFilter(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw Object.assign(new Error('Selecciona una fecha válida'), { status: 400 });
  }
  return text;
}

function productionFilters(input = {}) {
  const type = String(input.type || 'all');
  const status = String(input.status || 'all');
  const scope = String(input.scope || 'all');
  if (type !== 'all' && !DOCUMENT_TYPES.has(type)) throw Object.assign(new Error('Tipo de CFDI inválido'), { status: 400 });
  if (status !== 'all' && !DOCUMENT_STATUSES.has(status)) throw Object.assign(new Error('Estado de CFDI inválido'), { status: 400 });
  if (!['all', 'active'].includes(scope)) throw Object.assign(new Error('Filtro de tenants inválido'), { status: 400 });
  const from = dateFilter(input.from);
  const to = dateFilter(input.to);
  if (from && to && from > to) throw Object.assign(new Error('La fecha inicial debe ser anterior a la final'), { status: 400 });
  const tenantId = input.tenantId ? Number(input.tenantId) : null;
  if (tenantId !== null && (!Number.isSafeInteger(tenantId) || tenantId < 1)) throw Object.assign(new Error('Tenant inválido'), { status: 400 });
  const page = Math.max(1, Math.min(10000, Number.parseInt(input.page, 10) || 1));
  const search = String(input.search || '').trim().slice(0, 80);
  return { type, status, scope, from, to, tenantId, page, search };
}

function productionDocumentSql(tenants, filters) {
  if (!tenants.length) return null;
  const branches = tenants.flatMap((tenant) => {
    const id = Number(tenant.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('ID de tenant inválido');
    const schema = `"${schemaName(tenant.slug)}"`;
    const stamp = (type, alias) => `EXISTS (SELECT 1 FROM ${schema}.stamp_ledger sl WHERE sl.invoice_type=${type} AND sl.invoice_id=${alias}.id AND sl.movement_type='consumed')`;
    const common = (type, alias, total, stampType) =>
      `${id}::int AS tenant_id, ${type} AS document_type, ${alias}.id AS document_id, ${alias}.status, ${alias}.uuid, ${alias}.series, ${alias}.folio, COALESCE(${alias}.issuer_rfc,(SELECT e.rfc FROM ${schema}.fiscal_emitters e WHERE e.id=${alias}.fiscal_emitter_id),(SELECT e.rfc FROM ${schema}.fiscal_emitters e WHERE e.id=1)) AS issuer_rfc, ${alias}.api_mode, ${total}::float AS total, ${alias}.issued_at, ${alias}.created_at, COALESCE(${alias}.issued_at,${alias}.created_at) AS activity_at, ${stamp(stampType, alias)} AS stamp_consumed`;
    return [
      `SELECT ${common("'individual'::text", 'i', 'o.total', "'individual'")} FROM ${schema}.invoices i JOIN ${schema}.orders o ON o.id=i.order_id WHERE i.environment='production'`,
      `SELECT ${common("'global'::text", 'gi', 'gi.total', "'global'")} FROM ${schema}.global_invoices gi WHERE gi.environment='production'`,
      `SELECT ${common("CASE WHEN di.document_kind IN ('manual_global','credit_note') THEN di.document_kind ELSE 'direct' END", 'di', 'di.total', "CASE WHEN di.document_kind IN ('manual_global','credit_note') THEN di.document_kind ELSE 'direct' END")} FROM ${schema}.direct_invoices di WHERE di.environment='production'`,
      `SELECT ${common("'payment'::text", 'pc', 'pc.amount', "'payment'")} FROM ${schema}.payment_complements pc WHERE pc.environment='production'`,
    ];
  });
  const params = [];
  const where = [];
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  if (filters.type !== 'all') where.push(`document_type=${bind(filters.type)}`);
  if (filters.status !== 'all') where.push(`status=${bind(filters.status)}`);
  if (filters.from) where.push(`activity_at >= ${bind(filters.from)}::date`);
  if (filters.to) where.push(`activity_at < (${bind(filters.to)}::date + interval '1 day')`);
  if (filters.search) {
    const term = bind(`%${filters.search}%`);
    where.push(`(COALESCE(uuid,'') ILIKE ${term} OR COALESCE(issuer_rfc,'') ILIKE ${term} OR COALESCE(series,'') ILIKE ${term} OR COALESCE(folio,'') ILIKE ${term})`);
  }
  const cte = `WITH documents AS (${branches.join(' UNION ALL ')}), filtered AS (SELECT * FROM documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''})`;
  return { cte, params };
}

module.exports = { productionFilters, productionDocumentSql };
