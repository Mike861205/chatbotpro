const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const start = app.indexOf('function renderExpensePageControls(');
const end = app.indexOf('function openDeleteExpenseModal(', start);
assert.ok(start >= 0 && end > start);

test('la tabla muestra 10, 20, 50 o 100 gastos por página sin perder el total filtrado', () => {
  const elements = new Map();
  const $ = (selector) => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', value: '', disabled: false,
      querySelectorAll: () => [],
    });
    return elements.get(selector);
  };
  const context = {
    $, COSTING_EXPENSE_PAGE: 1, COSTING_DELETED_EXPENSE_PAGE: 1,
    COSTING_EXPENSE_PAGE_SIZE: 10, ME: { role: 'owner' },
    isCashierUser: () => false, esc: String,
    fmtMoney: (value) => `$${Number(value).toFixed(2)}`,
    emptyHTML: () => 'Sin gastos',
  };
  vm.runInNewContext(app.slice(start, end), context);
  const expenses = Array.from({ length: 125 }, (_, index) => ({
    id: index + 1, expense_date: '2026-10-07', branch_name: 'Auroras',
    concept: `Gasto ${index + 1}`, source: 'manual', amount: 1, created_by: 'caja',
  }));

  for (const size of [10, 20, 50, 100]) {
    context.COSTING_EXPENSE_PAGE_SIZE = size;
    context.COSTING_EXPENSE_PAGE = 1;
    context.renderExpenseTable(expenses);
    const rendered = [...$('#costingExpensesTable').innerHTML.matchAll(/data-expense-id="/g)].length;
    assert.equal(rendered, size);
    assert.match($('#costingExpensePageInfo').textContent, new RegExp(`1–${size} de 125`));
    assert.equal($('#costingExpensePrev').disabled, true);
    assert.equal($('#costingExpenseNext').disabled, false);
  }

  context.COSTING_EXPENSE_PAGE_SIZE = 20;
  context.COSTING_EXPENSE_PAGE = 3;
  context.renderExpenseTable(expenses);
  assert.match($('#costingExpensesTable').innerHTML, /data-expense-id="41"/);
  assert.doesNotMatch($('#costingExpensesTable').innerHTML, /data-expense-id="21"/);
  assert.match($('#costingExpensePageInfo').textContent, /41–60 de 125/);
});
