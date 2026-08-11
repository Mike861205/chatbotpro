const { money } = require('./costing');

function stockValuation(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  let rawSalesValue = 0;
  let rawCostValue = 0;

  for (const entry of rows) {
    const quantity = Math.max(0, Number(entry?.quantity) || 0);
    const salePrice = Math.max(0, Number(entry?.salePrice ?? entry?.price) || 0);
    const unitCost = Math.max(0, Number(entry?.unitCost ?? entry?.unit_cost) || 0);
    rawSalesValue += quantity * salePrice;
    rawCostValue += quantity * unitCost;
  }

  const salesValue = money(rawSalesValue);
  const costValue = money(rawCostValue);
  const profitValue = money(rawSalesValue - rawCostValue);
  const profitPercent = rawSalesValue > 0
    ? Number((((rawSalesValue - rawCostValue) / rawSalesValue) * 100).toFixed(2))
    : 0;

  return { salesValue, costValue, profitValue, profitPercent };
}

module.exports = { stockValuation };
