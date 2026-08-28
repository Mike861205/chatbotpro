const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { ensureCostingSchema, money } = require('../utils/costing');
const { ensurePurchasingSchema } = require('../utils/purchasing');
const { getSetting } = require('../db');
const { parseCustomPaymentMethods, isCustomPaymentMethod } = require('../utils/paymentMethods');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);
router.use(async (req, res, next) => {
  try {
    await ensureCostingSchema(req.tdb);
    await ensurePurchasingSchema(req.tdb);
    next();
  } catch (error) {
    next(error);
  }
});

const TZ = 'America/Mexico_City';
const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseIsoDate(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const date = new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : raw;
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '') : value;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function branchSql(rawBranch, params) {
  const branch = String(rawBranch || 'all').trim().toLowerCase();
  if (!branch || branch === 'all') return { key: 'all', orderClause: '', expenseClause: '' };
  if (branch === 'general') {
    return {
      key: 'general',
      orderClause: 'AND COALESCE(o.service_branch_id, o.pickup_branch_id) IS NULL',
      expenseClause: 'AND COALESCE(x.branch_id, 0) = 0',
    };
  }

  const branchId = Number.parseInt(branch, 10);
  if (!Number.isInteger(branchId) || branchId <= 0) return { key: 'all', orderClause: '', expenseClause: '' };
  params.push(branchId);
  return {
    key: String(branchId),
    orderClause: `AND COALESCE(o.service_branch_id, o.pickup_branch_id) = $${params.length}`,
    expenseClause: `AND x.branch_id = $${params.length}`,
  };
}

router.get('/report', async (req, res, next) => {
  try {
    const TZ = req.timezone;
    const now = new Date();
    const year = parseInteger(req.query.year, now.getFullYear(), 2000, 2100);
    const month = parseInteger(req.query.month, now.getMonth() + 1, 1, 12);
    const params = [year, month];
    const branchFilter = branchSql(req.query.branch, params);

    const costedOrdersCte = `costed_orders AS (
      SELECT o.*,
             COALESCE(o.cogs_total, item_cost.cogs, 0)::numeric AS calculated_cogs,
             CASE
               WHEN o.payment_method IN ('mixed', 'multiple') OR (o.payment_breakdown IS NOT NULL AND o.payment_breakdown ~ '^\\s*\\{.*\\}\\s*$') THEN
                 COALESCE((NULLIF(o.payment_breakdown, '')::jsonb ->> 'cash')::numeric, 0)
               WHEN o.payment_method = 'cash' THEN o.total::numeric
               ELSE 0::numeric
             END AS payment_cash,
             CASE
               WHEN o.payment_method IN ('mixed', 'multiple') OR (o.payment_breakdown IS NOT NULL AND o.payment_breakdown ~ '^\\s*\\{.*\\}\\s*$') THEN
                 COALESCE((NULLIF(o.payment_breakdown, '')::jsonb ->> 'card')::numeric, 0)
               WHEN o.payment_method = 'card' THEN o.total::numeric
               ELSE 0::numeric
             END AS payment_card,
             CASE
               WHEN o.payment_method IN ('mixed', 'multiple') OR (o.payment_breakdown IS NOT NULL AND o.payment_breakdown ~ '^\\s*\\{.*\\}\\s*$') THEN
                 COALESCE((NULLIF(o.payment_breakdown, '')::jsonb ->> 'transfer')::numeric, 0)
               WHEN o.payment_method = 'transfer' THEN o.total::numeric
               ELSE 0::numeric
             END AS payment_transfer,
             CASE
               WHEN o.payment_method NOT IN ('cash', 'card', 'transfer', 'mixed', 'multiple') THEN
                 o.total::numeric
               ELSE 0::numeric
             END AS payment_other
      FROM {s}.orders o
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(
          COALESCE(NULLIF(item->>'unitCost', '')::numeric, p.unit_cost, 0)
          * COALESCE(NULLIF(item->>'qty', '')::numeric, NULLIF(item->>'quantity', '')::numeric, 0)
        ), 0)::numeric AS cogs
        FROM jsonb_array_elements(COALESCE(NULLIF(o.items, '')::jsonb, '[]'::jsonb)) item
        LEFT JOIN {s}.products p
          ON p.id = COALESCE(NULLIF(item->>'id', '')::int, NULLIF(item->>'product_id', '')::int)
      ) item_cost ON TRUE
    )`;

    const expenseEventsCte = `expense_events AS (
      SELECT e.expense_date AS event_date, e.amount::numeric AS amount, e.branch_id
      FROM {s}.business_expenses e
      UNION ALL
      SELECT (m.created_at AT TIME ZONE '${TZ}')::date AS event_date,
             m.amount::numeric AS amount, ps.branch_id
      FROM {s}.pos_cash_movements m
      JOIN {s}.pos_sessions ps ON ps.id = m.session_id
      WHERE m.kind = 'expense'
    )`;

    const dailySql = `
      WITH input AS (
        SELECT $1::int AS report_year, $2::int AS report_month
      ), days AS (
        SELECT generate_series(
          make_date(report_year, report_month, 1),
          (make_date(report_year, report_month, 1) + interval '1 month - 1 day')::date,
          interval '1 day'
        )::date AS sale_date
        FROM input
      ), ${costedOrdersCte}
      SELECT to_char(d.sale_date, 'YYYY-MM-DD') AS date,
             COALESCE(SUM(o.total), 0)::float AS sales,
             COALESCE(SUM(o.calculated_cogs), 0)::float AS cogs,
             COALESCE(SUM(o.payment_cash), 0)::float AS cash,
             COALESCE(SUM(o.payment_card), 0)::float AS card,
             COALESCE(SUM(o.payment_transfer), 0)::float AS transfer,
             COALESCE(SUM(o.payment_other), 0)::float AS other,
             COUNT(o.id)::int AS tickets
      FROM days d
      LEFT JOIN costed_orders o
        ON (o.created_at AT TIME ZONE '${TZ}')::date = d.sale_date
       AND o.status != 'cancelado'
       ${branchFilter.orderClause}
      GROUP BY d.sale_date
      ORDER BY d.sale_date`;

    const monthlySql = `
      WITH input AS (
        SELECT $1::int AS report_year, $2::int AS report_month
      ), months AS (
        SELECT generate_series(
          make_date(report_year, 1, 1),
          make_date(report_year, 12, 1),
          interval '1 month'
        )::date AS sale_month
        FROM input
      ), ${costedOrdersCte}
      SELECT EXTRACT(MONTH FROM m.sale_month)::int AS month,
             COALESCE(SUM(o.total), 0)::float AS sales,
             COALESCE(SUM(o.calculated_cogs), 0)::float AS cogs,
             COALESCE(SUM(o.payment_cash), 0)::float AS cash,
             COALESCE(SUM(o.payment_card), 0)::float AS card,
             COALESCE(SUM(o.payment_transfer), 0)::float AS transfer,
             COALESCE(SUM(o.payment_other), 0)::float AS other,
             COUNT(o.id)::int AS tickets
      FROM months m
      LEFT JOIN costed_orders o
        ON date_trunc('month', o.created_at AT TIME ZONE '${TZ}')::date = m.sale_month
       AND o.status != 'cancelado'
       ${branchFilter.orderClause}
      GROUP BY m.sale_month
      ORDER BY m.sale_month`;

    const branchBreakdownSql = `
      WITH input AS (
        SELECT $1::int AS report_year, $2::int AS report_month
      ), ${costedOrdersCte}
      SELECT COALESCE(COALESCE(o.service_branch_id, o.pickup_branch_id)::text, 'general') AS key,
             COALESCE(
               b.name,
               NULLIF(o.service_branch_name, ''),
               NULLIF(o.pickup_branch_name, ''),
               'Sin sucursal'
             ) AS name,
             COALESCE(SUM(o.total), 0)::float AS sales,
             COALESCE(SUM(o.calculated_cogs), 0)::float AS cogs,
             COALESCE(SUM(o.payment_cash), 0)::float AS cash,
             COALESCE(SUM(o.payment_card), 0)::float AS card,
             COALESCE(SUM(o.payment_transfer), 0)::float AS transfer,
             COALESCE(SUM(o.payment_other), 0)::float AS other,
             COUNT(o.id)::int AS tickets
      FROM costed_orders o
      CROSS JOIN input i
      LEFT JOIN {s}.branches b ON b.id = COALESCE(o.service_branch_id, o.pickup_branch_id)
      WHERE EXTRACT(YEAR FROM o.created_at AT TIME ZONE '${TZ}')::int = i.report_year
        AND EXTRACT(MONTH FROM o.created_at AT TIME ZONE '${TZ}')::int = i.report_month
        AND o.status != 'cancelado'
        ${branchFilter.orderClause}
      GROUP BY COALESCE(o.service_branch_id, o.pickup_branch_id),
               COALESCE(b.name, NULLIF(o.service_branch_name, ''), NULLIF(o.pickup_branch_name, ''), 'Sin sucursal')
      ORDER BY sales DESC, name ASC`;

    const dailyExpensesSql = `
      WITH input AS (SELECT $1::int AS report_year, $2::int AS report_month),
      days AS (
        SELECT generate_series(
          make_date(report_year, report_month, 1),
          (make_date(report_year, report_month, 1) + interval '1 month - 1 day')::date,
          interval '1 day'
        )::date AS expense_date FROM input
      ), ${expenseEventsCte}
      SELECT to_char(d.expense_date, 'YYYY-MM-DD') AS date,
             COALESCE(SUM(x.amount), 0)::float AS expenses
      FROM days d
      LEFT JOIN expense_events x ON x.event_date = d.expense_date ${branchFilter.expenseClause}
      GROUP BY d.expense_date ORDER BY d.expense_date`;

    const monthlyExpensesSql = `
      WITH input AS (SELECT $1::int AS report_year, $2::int AS report_month),
      months AS (
        SELECT generate_series(make_date(report_year, 1, 1), make_date(report_year, 12, 1), interval '1 month')::date AS expense_month
        FROM input
      ), ${expenseEventsCte}
      SELECT EXTRACT(MONTH FROM m.expense_month)::int AS month,
             COALESCE(SUM(x.amount), 0)::float AS expenses
      FROM months m
      LEFT JOIN expense_events x ON date_trunc('month', x.event_date)::date = m.expense_month ${branchFilter.expenseClause}
      GROUP BY m.expense_month ORDER BY m.expense_month`;

    const branchExpensesSql = `
      WITH input AS (SELECT $1::int AS report_year, $2::int AS report_month), ${expenseEventsCte}
      SELECT COALESCE(x.branch_id::text, 'general') AS key,
             COALESCE(b.name, 'Sin sucursal') AS name,
             COALESCE(SUM(x.amount), 0)::float AS expenses
      FROM expense_events x
      CROSS JOIN input i
      LEFT JOIN {s}.branches b ON b.id = x.branch_id
      WHERE EXTRACT(YEAR FROM x.event_date)::int = i.report_year
        AND EXTRACT(MONTH FROM x.event_date)::int = i.report_month
        ${branchFilter.expenseClause}
      GROUP BY x.branch_id, COALESCE(b.name, 'Sin sucursal')`;

    const purchaseBranchClause = branchFilter.key === 'general'
      ? 'AND COALESCE(po.branch_id, 0) = 0'
      : branchFilter.key !== 'all' ? `AND po.branch_id = $${params.length}` : '';
    const dailyPurchasesSql = `WITH input AS (SELECT $1::int report_year,$2::int report_month),days AS (SELECT generate_series(make_date(report_year,report_month,1),(make_date(report_year,report_month,1)+interval '1 month - 1 day')::date,interval '1 day')::date purchase_date FROM input) SELECT to_char(d.purchase_date,'YYYY-MM-DD') AS date,COALESCE(SUM(po.total),0)::float AS purchases FROM days d LEFT JOIN {s}.purchase_orders po ON (po.received_at AT TIME ZONE '${TZ}')::date=d.purchase_date AND po.status='received' ${purchaseBranchClause} GROUP BY d.purchase_date ORDER BY d.purchase_date`;
    const monthlyPurchasesSql = `WITH input AS (SELECT $1::int report_year,$2::int report_month),months AS (SELECT generate_series(make_date(report_year,1,1),make_date(report_year,12,1),interval '1 month')::date purchase_month FROM input) SELECT EXTRACT(MONTH FROM m.purchase_month)::int AS month,COALESCE(SUM(po.total),0)::float AS purchases FROM months m LEFT JOIN {s}.purchase_orders po ON date_trunc('month',po.received_at AT TIME ZONE '${TZ}')::date=m.purchase_month AND po.status='received' ${purchaseBranchClause} GROUP BY m.purchase_month ORDER BY m.purchase_month`;
    const branchPurchasesSql = `WITH input AS (SELECT $1::int report_year,$2::int report_month) SELECT COALESCE(po.branch_id::text,'general') AS key,COALESCE(b.name,NULLIF(po.branch_name,''),'Sin sucursal') AS name,COALESCE(SUM(po.total),0)::float AS purchases FROM {s}.purchase_orders po CROSS JOIN input i LEFT JOIN {s}.branches b ON b.id=po.branch_id WHERE po.status='received' AND EXTRACT(YEAR FROM po.received_at AT TIME ZONE '${TZ}')::int=i.report_year AND EXTRACT(MONTH FROM po.received_at AT TIME ZONE '${TZ}')::int=i.report_month ${purchaseBranchClause} GROUP BY po.branch_id,COALESCE(b.name,NULLIF(po.branch_name,''),'Sin sucursal')`;

    const customPaymentsSql = `
      WITH input AS (SELECT $1::int AS report_year, $2::int AS report_month)
      SELECT o.payment_method AS id,
             to_char(o.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS date,
             EXTRACT(MONTH FROM o.created_at AT TIME ZONE '${TZ}')::int AS month,
             COUNT(*)::int AS tickets,
             COALESCE(SUM(o.total), 0)::float AS total,
             MAX(CASE WHEN o.payment_breakdown ~ '^\\s*\\{.*\\}\\s*$'
               THEN NULLIF(o.payment_breakdown::jsonb ->> 'customLabel', '') ELSE NULL END) AS stored_label
      FROM {s}.orders o CROSS JOIN input i
      WHERE EXTRACT(YEAR FROM o.created_at AT TIME ZONE '${TZ}')::int = i.report_year
        AND o.status != 'cancelado'
        AND o.payment_method LIKE 'custom\\_%' ESCAPE '\\'
        ${branchFilter.orderClause}
      GROUP BY o.payment_method, to_char(o.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD'),
               EXTRACT(MONTH FROM o.created_at AT TIME ZONE '${TZ}')
      ORDER BY o.payment_method, date`;

    const [dailyRows, monthlyRows, branchRows, dailyExpenseRows, monthlyExpenseRows, branchExpenseRows, dailyPurchaseRows, monthlyPurchaseRows, branchPurchaseRows, customPaymentRows, branches, customMethodsRaw] = await Promise.all([
      req.tdb.all(dailySql, params),
      req.tdb.all(monthlySql, params),
      req.tdb.all(branchBreakdownSql, params),
      req.tdb.all(dailyExpensesSql, params),
      req.tdb.all(monthlyExpensesSql, params),
      req.tdb.all(branchExpensesSql, params),
      req.tdb.all(dailyPurchasesSql, params),
      req.tdb.all(monthlyPurchasesSql, params),
      req.tdb.all(branchPurchasesSql, params),
      req.tdb.all(customPaymentsSql, params),
      req.tdb.all('SELECT id, name, active FROM {s}.branches ORDER BY active DESC, name ASC'),
      getSetting(req.tdb, 'custom_payment_methods_json', '[]'),
    ]);
    const configuredCustomMethods = parseCustomPaymentMethods(customMethodsRaw);
    const customPaymentIds = [...new Set([
      ...configuredCustomMethods.filter((method) => method.active).map((method) => method.id),
      ...customPaymentRows.map((row) => row.id),
    ])];
    const customPaymentSummary = (monthFilter = null, dateFilter = '') => customPaymentIds.map((id) => {
      const rows = customPaymentRows.filter((row) => row.id === id
        && (monthFilter == null || Number(row.month) === Number(monthFilter))
        && (!dateFilter || row.date === dateFilter));
      const configured = configuredCustomMethods.find((method) => method.id === id);
      return {
        id,
        label: configured?.label || rows.find((row) => row.stored_label)?.stored_label || 'Medio personalizado',
        total: money(rows.reduce((sum, row) => sum + Number(row.total || 0), 0)),
        tickets: rows.reduce((sum, row) => sum + Number(row.tickets || 0), 0),
      };
    });

    const dailyExpenseMap = new Map(dailyExpenseRows.map((row) => [row.date, Number(row.expenses || 0)]));
    const monthlyExpenseMap = new Map(monthlyExpenseRows.map((row) => [Number(row.month), Number(row.expenses || 0)]));
    const dailyPurchaseMap = new Map(dailyPurchaseRows.map((row) => [row.date, Number(row.purchases || 0)]));
    const monthlyPurchaseMap = new Map(monthlyPurchaseRows.map((row) => [Number(row.month), Number(row.purchases || 0)]));
    const withProfit = (sales, cogs, expenses) => {
      const grossProfit = money(sales - cogs);
      const netProfit = money(grossProfit - expenses);
      return { grossProfit, netProfit, marginPercent: sales ? Number(((netProfit / sales) * 100).toFixed(2)) : 0 };
    };
    const daily = dailyRows.map((row) => {
      const sales = Number(row.sales || 0);
      const cogs = Number(row.cogs || 0);
      const cash = Number(row.cash || 0);
      const card = Number(row.card || 0);
      const transfer = Number(row.transfer || 0);
      const other = Number(row.other || 0);
      const expenses = dailyExpenseMap.get(row.date) || 0;
      const purchases = dailyPurchaseMap.get(row.date) || 0;
      return {
        date: row.date,
        day: Number(String(row.date).slice(-2)),
        sales,
        cogs,
        cash,
        card,
        transfer,
        other,
        customPayments: customPaymentSummary(null, row.date),
        expenses,
        purchases,
        cashResult: money(sales - expenses - purchases),
        tickets: Number(row.tickets || 0),
        ...withProfit(sales, cogs, expenses),
      };
    });
    const monthly = monthlyRows.map((row) => {
      const monthNumber = Number(row.month);
      const sales = Number(row.sales || 0);
      const cogs = Number(row.cogs || 0);
      const cash = Number(row.cash || 0);
      const card = Number(row.card || 0);
      const transfer = Number(row.transfer || 0);
      const other = Number(row.other || 0);
      const expenses = monthlyExpenseMap.get(monthNumber) || 0;
      const purchases = monthlyPurchaseMap.get(monthNumber) || 0;
      return {
        month: monthNumber,
        label: MONTH_NAMES[monthNumber - 1],
        sales,
        cogs,
        cash,
        card,
        transfer,
        other,
        customPayments: customPaymentSummary(monthNumber),
        expenses,
        purchases,
        cashResult: money(sales - expenses - purchases),
        tickets: Number(row.tickets || 0),
        ...withProfit(sales, cogs, expenses),
      };
    });

    const selectedMonthSales = daily.reduce((sum, row) => sum + row.sales, 0);
    const selectedMonthTickets = daily.reduce((sum, row) => sum + row.tickets, 0);
    const yearSales = monthly.reduce((sum, row) => sum + row.sales, 0);
    const yearTickets = monthly.reduce((sum, row) => sum + row.tickets, 0);
    const selectedMonthCogs = daily.reduce((sum, row) => sum + row.cogs, 0);
    const selectedMonthExpenses = daily.reduce((sum, row) => sum + row.expenses, 0);
    const yearCogs = monthly.reduce((sum, row) => sum + row.cogs, 0);
    const yearExpenses = monthly.reduce((sum, row) => sum + row.expenses, 0);
    const selectedMonthPurchases = daily.reduce((sum, row) => sum + row.purchases, 0);
    const yearPurchases = monthly.reduce((sum, row) => sum + row.purchases, 0);
    const selectedMonthProfit = withProfit(selectedMonthSales, selectedMonthCogs, selectedMonthExpenses);
    const yearProfit = withProfit(yearSales, yearCogs, yearExpenses);
    const bestDay = daily.reduce((best, row) => (row.sales > (best?.sales || 0) ? row : best), null);
    const bestMonth = monthly.reduce((best, row) => (row.sales > (best?.sales || 0) ? row : best), null);

    const selectedMonthCash = money(daily.reduce((sum, row) => sum + row.cash, 0));
    const selectedMonthCard = money(daily.reduce((sum, row) => sum + row.card, 0));
    const selectedMonthTransfer = money(daily.reduce((sum, row) => sum + row.transfer, 0));
    const selectedMonthOther = money(daily.reduce((sum, row) => sum + row.other, 0));

    const yearCash = money(monthly.reduce((sum, row) => sum + row.cash, 0));
    const yearCard = money(monthly.reduce((sum, row) => sum + row.card, 0));
    const yearTransfer = money(monthly.reduce((sum, row) => sum + row.transfer, 0));
    const yearOther = money(monthly.reduce((sum, row) => sum + row.other, 0));

    res.json({
      filters: { year, month, branch: branchFilter.key },
      branches: branches.map((row) => ({ id: Number(row.id), name: row.name, active: Number(row.active) })),
      summary: {
        selectedMonthSales,
        selectedMonthTickets,
        selectedMonthAverage: selectedMonthTickets ? selectedMonthSales / selectedMonthTickets : 0,
        selectedMonthCogs,
        selectedMonthExpenses,
        selectedMonthPurchases,
        selectedMonthCashResult: money(selectedMonthSales - selectedMonthExpenses - selectedMonthPurchases),
        selectedMonthGrossProfit: selectedMonthProfit.grossProfit,
        selectedMonthNetProfit: selectedMonthProfit.netProfit,
        selectedMonthMarginPercent: selectedMonthProfit.marginPercent,
        selectedMonthCash,
        selectedMonthCard,
        selectedMonthTransfer,
        selectedMonthOther,
        selectedMonthPayments: {
          cash: selectedMonthCash,
          card: selectedMonthCard,
          transfer: selectedMonthTransfer,
          other: selectedMonthOther,
          custom: customPaymentSummary(month),
        },
        yearSales,
        yearTickets,
        yearAverage: yearTickets ? yearSales / yearTickets : 0,
        yearCogs,
        yearExpenses,
        yearPurchases,
        yearCashResult: money(yearSales - yearExpenses - yearPurchases),
        yearGrossProfit: yearProfit.grossProfit,
        yearNetProfit: yearProfit.netProfit,
        yearMarginPercent: yearProfit.marginPercent,
        yearCash,
        yearCard,
        yearTransfer,
        yearOther,
        yearPayments: {
          cash: yearCash,
          card: yearCard,
          transfer: yearTransfer,
          other: yearOther,
          custom: customPaymentSummary(),
        },
        bestDay,
        bestMonth,
      },
      daily,
      monthly,
      branchBreakdown: (() => {
        const map = new Map();
        for (const row of branchRows) map.set(row.key, {
          key: row.key,
          name: row.name,
          sales: Number(row.sales || 0),
          cogs: Number(row.cogs || 0),
          cash: Number(row.cash || 0),
          card: Number(row.card || 0),
          transfer: Number(row.transfer || 0),
          other: Number(row.other || 0),
          expenses: 0,
          purchases: 0,
          tickets: Number(row.tickets || 0),
        });
        for (const row of branchExpenseRows) {
          const current = map.get(row.key) || { key: row.key, name: row.name, sales: 0, cogs: 0, cash: 0, card: 0, transfer: 0, other: 0, expenses: 0, purchases: 0, tickets: 0 };
          current.expenses = Number(row.expenses || 0);
          map.set(row.key, current);
        }
        for (const row of branchPurchaseRows) {
          const current = map.get(row.key) || { key: row.key, name: row.name, sales: 0, cogs: 0, cash: 0, card: 0, transfer: 0, other: 0, expenses: 0, purchases: 0, tickets: 0 };
          current.purchases = Number(row.purchases || 0); map.set(row.key,current);
        }
        return [...map.values()].map((row) => ({
          ...row,
          cashResult: money(row.sales - row.expenses - row.purchases),
          ...withProfit(row.sales, row.cogs, row.expenses),
        })).sort((a, b) => b.sales - a.sales);
      })(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/detail', async (req, res, next) => {
  try {
    const TZ = req.timezone;
    res.set('Cache-Control', 'no-store');
    const startDate = parseIsoDate(req.query.startDate);
    const endDate = parseIsoDate(req.query.endDate);
    if (!startDate || !endDate) return res.status(400).json({ error: 'Selecciona un rango de fechas válido' });
    if (startDate > endDate) return res.status(400).json({ error: 'La fecha inicial no puede ser posterior a la final' });
    const rangeDays = Math.floor((new Date(`${endDate}T12:00:00Z`) - new Date(`${startDate}T12:00:00Z`)) / 86400000) + 1;
    if (rangeDays > 731) return res.status(400).json({ error: 'El rango máximo es de 24 meses' });

    const params = [startDate, endDate];
    const branchFilter = branchSql(req.query.branch, params);
    const ordersSql = `
      WITH costed_orders AS (
        SELECT o.*,
               COALESCE(o.cogs_total, item_cost.cogs, 0)::numeric AS calculated_cogs
        FROM {s}.orders o
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(
            COALESCE(NULLIF(item->>'unitCost', '')::numeric, p.unit_cost, 0)
            * COALESCE(NULLIF(item->>'qty', '')::numeric, NULLIF(item->>'quantity', '')::numeric, 0)
          ), 0)::numeric AS cogs
          FROM jsonb_array_elements(COALESCE(NULLIF(o.items, '')::jsonb, '[]'::jsonb)) item
          LEFT JOIN {s}.products p
            ON p.id = COALESCE(NULLIF(item->>'id', '')::int, NULLIF(item->>'product_id', '')::int)
        ) item_cost ON TRUE
      )
      SELECT o.id, o.items, o.subtotal::float AS subtotal, o.total::float AS total,
             o.calculated_cogs::float AS cogs, o.channel, o.delivery, o.status,
             o.payment_method, o.payment_breakdown, o.service_branch_id, o.pickup_branch_id,
             COALESCE(b.name, NULLIF(o.service_branch_name, ''), NULLIF(o.pickup_branch_name, ''), 'Sin sucursal') AS branch_name,
             o.table_number, o.waiter_name,
             to_char(o.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS sale_date,
             to_char(o.created_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS created_at
      FROM costed_orders o
      LEFT JOIN {s}.branches b ON b.id = COALESCE(o.service_branch_id, o.pickup_branch_id)
      WHERE (o.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
        AND o.status != 'cancelado'
        ${branchFilter.orderClause}
      ORDER BY o.created_at ASC, o.id ASC`;

    const expensesSql = `
      WITH expense_events AS (
        SELECT e.id, 'manual'::text AS source, e.expense_date AS event_date,
               e.amount::float AS amount, e.branch_id,
               COALESCE(NULLIF(e.branch_name, ''), b.name, 'Sin sucursal') AS branch_name,
               e.concept, e.notes, e.created_by,
               to_char(e.created_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS created_at
        FROM {s}.business_expenses e
        LEFT JOIN {s}.branches b ON b.id = e.branch_id
        UNION ALL
        SELECT -m.id AS id, 'pos'::text AS source,
               (m.created_at AT TIME ZONE '${TZ}')::date AS event_date,
               m.amount::float AS amount, ps.branch_id,
               COALESCE(NULLIF(ps.branch_name, ''), b.name, 'Sin sucursal') AS branch_name,
               COALESCE(NULLIF(m.note, ''), 'Gasto de caja') AS concept,
               ''::text AS notes, m.created_by,
               to_char(m.created_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS created_at
        FROM {s}.pos_cash_movements m
        JOIN {s}.pos_sessions ps ON ps.id = m.session_id
        LEFT JOIN {s}.branches b ON b.id = ps.branch_id
        WHERE m.kind = 'expense'
      )
      SELECT x.* FROM expense_events x
      WHERE x.event_date BETWEEN $1::date AND $2::date
        ${branchFilter.expenseClause}
      ORDER BY x.event_date ASC, x.id ASC`;

    const purchaseClause = branchFilter.key === 'general'
      ? 'AND COALESCE(po.branch_id, 0) = 0'
      : branchFilter.key !== 'all' ? `AND po.branch_id = $${params.length}` : '';
    const purchasesSql = `
      SELECT po.id, po.order_number, po.supplier_name,
             COALESCE(b.name, NULLIF(po.branch_name, ''), 'Sin sucursal') AS branch_name,
             po.total::float AS total, po.received_by,
             to_char(po.received_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS purchase_date,
             to_char(po.received_at AT TIME ZONE '${TZ}', 'DD/MM/YYYY HH24:MI') AS received_at,
             COALESCE(json_agg(json_build_object(
               'productId', i.product_id, 'name', i.product_name,
               'quantity', i.quantity::float, 'unitCost', i.unit_cost::float,
               'lineTotal', i.line_total::float
             ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]'::json) AS items
      FROM {s}.purchase_orders po
      LEFT JOIN {s}.branches b ON b.id = po.branch_id
      LEFT JOIN {s}.purchase_order_items i ON i.purchase_order_id = po.id
      WHERE po.status = 'received'
        AND (po.received_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
        ${purchaseClause}
      GROUP BY po.id, b.name
      ORDER BY po.received_at ASC, po.id ASC`;

    const [orderRows, expenseRows, purchaseRows, productCosts] = await Promise.all([
      req.tdb.all(ordersSql, params),
      req.tdb.all(expensesSql, params),
      req.tdb.all(purchasesSql, params),
      req.tdb.all('SELECT id, COALESCE(unit_cost, 0)::float AS unit_cost FROM {s}.products'),
    ]);
    const costMap = new Map(productCosts.map((row) => [Number(row.id), Number(row.unit_cost || 0)]));
    const configuredCustomMethods = parseCustomPaymentMethods(await getSetting(req.tdb, 'custom_payment_methods_json', '[]'));
    const customPaymentTotals = new Map(configuredCustomMethods.filter((method) => method.active).map((method) => [
      method.id,
      { id: method.id, label: method.label, total: 0, tickets: 0 },
    ]));
    const paymentTotals = { cash: 0, card: 0, transfer: 0, other: 0 };
    const productMap = new Map();

    const sales = orderRows.map((row) => {
      const total = money(row.total);
      const cogs = money(row.cogs);
      const items = parseJson(row.items, []);
      const breakdown = parseJson(row.payment_breakdown, {});
      const breakdownTotal = ['cash', 'card', 'transfer'].reduce((sum, key) => sum + Number(breakdown[key] || 0), 0);
      if (breakdownTotal > 0) {
        paymentTotals.cash += Number(breakdown.cash || 0);
        paymentTotals.card += Number(breakdown.card || 0);
        paymentTotals.transfer += Number(breakdown.transfer || 0);
      } else if (isCustomPaymentMethod(row.payment_method)) {
        const current = customPaymentTotals.get(row.payment_method) || {
          id: row.payment_method,
          label: breakdown.customLabel || 'Medio personalizado',
          total: 0,
          tickets: 0,
        };
        current.total += total;
        current.tickets += 1;
        customPaymentTotals.set(row.payment_method, current);
      } else if (Object.hasOwn(paymentTotals, row.payment_method)) {
        paymentTotals[row.payment_method] += total;
      } else {
        paymentTotals.other += total;
      }

      if (Array.isArray(items)) {
        for (const item of items) {
          const productId = Number(item?.id || item?.product_id || 0);
          const name = String(item?.name || 'Producto');
          const qty = Math.max(0, Number(item?.qty || item?.quantity || 0));
          const price = Number(item?.price || 0);
          const savedCost = Number(item?.unitCost ?? item?.unit_cost);
          const unitCost = Number.isFinite(savedCost) ? savedCost : (costMap.get(productId) || 0);
          const key = productId ? `id:${productId}` : `name:${name}`;
          const current = productMap.get(key) || { productId: productId || null, name, quantity: 0, sales: 0, cogs: 0 };
          current.quantity += qty;
          current.sales += price * qty;
          current.cogs += unitCost * qty;
          productMap.set(key, current);
        }
      }
      return {
        id: Number(row.id),
        saleDate: row.sale_date,
        createdAt: row.created_at,
        branchName: row.branch_name,
        channel: row.channel,
        delivery: row.delivery,
        paymentMethod: row.payment_method || 'other',
        paymentBreakdown: breakdown,
        tableNumber: row.table_number ? Number(row.table_number) : null,
        waiterName: row.waiter_name || '',
        items: Array.isArray(items) ? items : [],
        total,
        cogs,
        grossProfit: money(total - cogs),
      };
    });

    const expenses = expenseRows.map((row) => ({
      id: Number(row.id), source: row.source, date: String(row.event_date).slice(0, 10),
      createdAt: row.created_at, branchName: row.branch_name, concept: row.concept,
      notes: row.notes || '', amount: money(row.amount), createdBy: row.created_by || '',
    }));
    const purchases = purchaseRows.map((row) => ({
      id: Number(row.id), orderNumber: row.order_number, purchaseDate: row.purchase_date,
      receivedAt: row.received_at, supplierName: row.supplier_name, branchName: row.branch_name,
      receivedBy: row.received_by || '', total: money(row.total),
      items: (Array.isArray(row.items) ? row.items : parseJson(row.items, [])).map((item) => ({
        productId: Number(item.productId || 0), name: item.name || 'Producto',
        quantity: Number(item.quantity || 0), unitCost: money(item.unitCost), lineTotal: money(item.lineTotal),
      })),
    }));
    const totalSales = money(sales.reduce((sum, row) => sum + row.total, 0));
    const totalCogs = money(sales.reduce((sum, row) => sum + row.cogs, 0));
    const totalExpenses = money(expenses.reduce((sum, row) => sum + row.amount, 0));
    const totalPurchases = money(purchases.reduce((sum, row) => sum + row.total, 0));
    const grossProfit = money(totalSales - totalCogs);
    const netProfit = money(grossProfit - totalExpenses);
    const cashResult = money(totalSales - totalPurchases - totalExpenses);
    const products = [...productMap.values()].map((row) => ({
      ...row, quantity: Number(row.quantity.toFixed(4)), sales: money(row.sales), cogs: money(row.cogs), profit: money(row.sales - row.cogs),
    })).sort((a, b) => b.sales - a.sales);

    res.json({
      filters: { startDate, endDate, branch: branchFilter.key, rangeDays },
      summary: {
        sales: totalSales, cogs: totalCogs, expenses: totalExpenses, purchases: totalPurchases,
        grossProfit, netProfit, cashResult,
        marginPercent: totalSales ? Number(((netProfit / totalSales) * 100).toFixed(2)) : 0,
        tickets: sales.length,
        averageTicket: sales.length ? money(totalSales / sales.length) : 0,
      },
      payments: {
        cash: money(paymentTotals.cash), card: money(paymentTotals.card),
        transfer: money(paymentTotals.transfer), other: money(paymentTotals.other),
        custom: [...customPaymentTotals.values()].map((method) => ({
          ...method,
          total: money(method.total),
        })),
      },
      sales,
      expenses,
      purchases,
      products,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
