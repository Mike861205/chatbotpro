const RESET_SCOPE = 'sales_purchases_inventory';

const RESET_SEQUENCE_TABLES = Object.freeze([
  'orders',
  'pos_sessions',
  'pos_cash_movements',
  'pos_close_approvals',
  'table_accounts',
  'table_rounds',
  'sales_audit_log',
  'self_service_payments',
  'purchase_orders',
  'purchase_order_items',
  'purchase_audit_log',
  'inventory_movements',
  'inventory_counts',
  'inventory_closure_logs',
  'inventory_transfers',
  'inventory_transfer_items',
]);

function numberRow(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value || 0)]));
}

async function loadTenantOperationResetPreview(db) {
  const row = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM {s}.orders) AS orders,
      (SELECT COALESCE(SUM(total),0) FROM {s}.orders WHERE status <> 'cancelado') AS sales_total,
      (SELECT COUNT(*) FROM {s}.pos_sessions) AS pos_sessions,
      (SELECT COUNT(*) FROM {s}.pos_cash_movements) AS cash_movements,
      (SELECT COUNT(*) FROM {s}.table_accounts) AS table_accounts,
      (SELECT COUNT(*) FROM {s}.table_rounds) AS table_rounds,
      (SELECT COUNT(*) FROM {s}.kds_ticket_states) AS kds_states,
      (SELECT COUNT(*) FROM {s}.self_service_payments) AS self_service_payments,
      (SELECT COUNT(*) FROM {s}.sales_audit_log) AS sales_audit_entries,
      (SELECT COUNT(*) FROM {s}.purchase_orders) AS purchase_orders,
      (SELECT COUNT(*) FROM {s}.purchase_order_items) AS purchase_items,
      (SELECT COUNT(*) FROM {s}.purchase_audit_log) AS purchase_audit_entries,
      (SELECT COUNT(*) FROM {s}.inventory_movements) AS inventory_movements,
      (SELECT COUNT(*) FROM {s}.inventory_counts) AS inventory_counts,
      (SELECT COUNT(*) FROM {s}.inventory_closure_logs) AS inventory_closures,
      (SELECT COUNT(*) FROM {s}.inventory_transfers) AS inventory_transfers,
      (SELECT COUNT(*) FROM {s}.inventory_transfer_items) AS inventory_transfer_items,
      (SELECT COUNT(*) FROM {s}.inventory_items WHERE COALESCE(initial_stock,0) <> 0) AS global_stock_rows,
      (SELECT COUNT(*) FROM {s}.branch_inventory WHERE COALESCE(quantity,0) <> 0 OR COALESCE(initial_quantity,0) <> 0) AS branch_stock_rows,
      (SELECT COUNT(*) FROM {s}.pos_sessions WHERE status = 'open') AS open_pos_sessions,
      (SELECT COUNT(*) FROM {s}.table_accounts WHERE status = 'open') AS open_table_accounts,
      (SELECT COUNT(*) FROM {s}.invoices) AS order_invoices,
      (SELECT COUNT(*) FROM {s}.global_invoice_orders) AS global_invoice_links,
      (SELECT COUNT(*) FROM {s}.self_service_payments
        WHERE COALESCE(provider_order_id,'') <> '' OR COALESCE(payment_reference,'') <> '') AS external_self_service_payments,
      (SELECT COUNT(*) FROM {s}.orders
        WHERE COALESCE(payment_provider,'') <> '' OR COALESCE(payment_reference,'') <> '') AS external_order_payments
  `);
  const values = numberRow(row);
  return {
    scope: RESET_SCOPE,
    sales: {
      orders: values.orders,
      total: values.sales_total,
      posSessions: values.pos_sessions,
      cashMovements: values.cash_movements,
      tableAccounts: values.table_accounts,
      tableRounds: values.table_rounds,
      kdsStates: values.kds_states,
      selfServicePayments: values.self_service_payments,
      auditEntries: values.sales_audit_entries,
    },
    purchases: {
      orders: values.purchase_orders,
      items: values.purchase_items,
      auditEntries: values.purchase_audit_entries,
    },
    inventory: {
      movements: values.inventory_movements,
      counts: values.inventory_counts,
      closures: values.inventory_closures,
      transfers: values.inventory_transfers,
      transferItems: values.inventory_transfer_items,
      globalStockRows: values.global_stock_rows,
      branchStockRows: values.branch_stock_rows,
    },
    blockers: {
      openPosSessions: values.open_pos_sessions,
      openTableAccounts: values.open_table_accounts,
      orderInvoices: values.order_invoices,
      globalInvoiceLinks: values.global_invoice_links,
      externalPayments: Math.max(values.external_self_service_payments, values.external_order_payments),
    },
  };
}

function resetBlockerMessages(preview) {
  const blockers = preview?.blockers || {};
  const messages = [];
  if (Number(blockers.openPosSessions || 0)) messages.push('Cierra todas las sesiones de caja antes de reiniciar.');
  if (Number(blockers.openTableAccounts || 0)) messages.push('Cierra todas las cuentas de mesa antes de reiniciar.');
  if (Number(blockers.orderInvoices || 0) || Number(blockers.globalInvoiceLinks || 0)) {
    messages.push('Hay ventas vinculadas con CFDI. No se pueden borrar desde este reinicio.');
  }
  if (Number(blockers.externalPayments || 0)) {
    messages.push('Hay pagos externos o referencias de cobro. Deben revisarse antes de borrar las ventas.');
  }
  return messages;
}

async function resetSerialSequences(tx) {
  for (const table of RESET_SEQUENCE_TABLES) {
    await tx.run(`SELECT setval(pg_get_serial_sequence('{s}.${table}','id'),1,false)`);
  }
}

async function resetTenantOperations(tenantDb, tenant, actor) {
  return tenantDb.tx(async (tx) => {
    await tx.run('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await tx.run('SELECT pg_advisory_xact_lock($1,$2)', [73421, Number(tenant.id)]);
    const lockedTenant = await tx.get(
      'SELECT id,slug,business_name FROM public.tenants WHERE id=$1 FOR UPDATE',
      [tenant.id]
    );
    if (!lockedTenant || lockedTenant.slug !== tenant.slug) {
      throw Object.assign(new Error('El tenant cambió o ya no existe. Actualiza SuperAdmin.'), { status: 409 });
    }

    const preview = await loadTenantOperationResetPreview(tx);
    const blockerMessages = resetBlockerMessages(preview);
    if (blockerMessages.length) {
      throw Object.assign(new Error(blockerMessages.join(' ')), { status: 409, blockers: preview.blockers });
    }

    await tx.run('DELETE FROM {s}.self_service_payments');
    await tx.run('DELETE FROM {s}.kds_ticket_states');
    await tx.run('DELETE FROM {s}.sales_audit_log');
    await tx.run('DELETE FROM {s}.table_rounds');
    await tx.run('DELETE FROM {s}.table_accounts');
    await tx.run('DELETE FROM {s}.pos_cash_movements');
    await tx.run('DELETE FROM {s}.pos_close_approvals');
    await tx.run('DELETE FROM {s}.pos_sessions');
    await tx.run('DELETE FROM {s}.orders');

    await tx.run('DELETE FROM {s}.purchase_order_items');
    await tx.run('DELETE FROM {s}.purchase_orders');
    await tx.run('DELETE FROM {s}.purchase_audit_log');

    await tx.run('DELETE FROM {s}.inventory_transfer_items');
    await tx.run('DELETE FROM {s}.inventory_transfers');
    await tx.run('DELETE FROM {s}.inventory_movements');
    await tx.run('DELETE FROM {s}.inventory_counts');
    await tx.run('DELETE FROM {s}.inventory_closure_logs');
    await tx.run('UPDATE {s}.inventory_items SET initial_stock=0,baseline_started_at=now(),updated_at=now()');
    await tx.run('UPDATE {s}.branch_inventory SET quantity=0,initial_quantity=0,baseline_started_at=now(),updated_at=now()');

    await resetSerialSequences(tx);
    await tx.run(
      `INSERT INTO public.tenant_operation_resets
       (tenant_id,tenant_slug,business_name,scope,summary_json,created_by)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [tenant.id, tenant.slug, tenant.business_name, RESET_SCOPE, JSON.stringify(preview), String(actor || 'superadmin').slice(0, 120)]
    );
    return preview;
  });
}

module.exports = {
  RESET_SCOPE,
  loadTenantOperationResetPreview,
  resetBlockerMessages,
  resetTenantOperations,
};
