function buildClientSummary(rows = []) {
  const summary = {
    totalClients: rows.length,
    activeClients: 0,
    billingDue: 0,
    inMora: 0,
    incomeTotal: 0,
    licenseCount: 0,
  };

  for (const row of rows) {
    if (row.account_status === 'active' && row.billing_status === 'active') summary.activeClients += 1;
    if (row.billing_status === 'due') summary.billingDue += 1;
    if (Number(row.mora_days || 0) > 0) summary.inMora += 1;
    summary.incomeTotal += Number(row.total_paid || 0);
    summary.licenseCount += Math.max(0, Number(row.license_count || 0));
  }

  return summary;
}

module.exports = { buildClientSummary };
