// Index names are scoped to each tenant's own schema.
const PERFORMANCE_INDEXES = [
  ['idx_compute_orders_service_date', 'orders', '(COALESCE(scheduled_for, created_at)) DESC, id DESC'],
  ['idx_compute_orders_paid_date', 'orders', '(COALESCE(credit_paid_at, created_at))'],
  ['idx_compute_orders_session', 'orders', 'pos_session_id', 'pos_session_id IS NOT NULL'],
  ['idx_compute_rounds_date', 'table_rounds', 'created_at'],
  ['idx_compute_kds_order', 'kds_ticket_states', 'order_id, area_id'],
  ['idx_compute_cash_session', 'pos_cash_movements', 'session_id'],
];

function indexStatement(schema, definition, concurrently = false) {
  if (!/^t_[a-z0-9_]+$/.test(schema)) throw new Error('Invalid tenant schema');
  const [name, table, columns, predicate] = definition;
  return `CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS "${name}" ON "${schema}"."${table}" (${columns})${predicate ? ` WHERE ${predicate}` : ''}`;
}

async function ensurePerformanceIndexes(t) {
  // Used only while provisioning a tenant, before it accepts traffic.
  for (const definition of PERFORMANCE_INDEXES) await t.run(indexStatement(t.schema, definition));
}

module.exports = { PERFORMANCE_INDEXES, indexStatement, ensurePerformanceIndexes };
