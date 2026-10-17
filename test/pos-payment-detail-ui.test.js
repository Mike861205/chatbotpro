const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const start = source.indexOf('function renderPosPaymentReport(report)');
const end = source.indexOf('async function openPosPaymentReport(method)', start);
assert.ok(start >= 0 && end > start);

test('al pulsar tarjeta se muestra el detalle sin pedir importes externos', () => {
  const elements = { '#posPaymentReportSubtitle': { textContent: '' }, '#posPaymentReportBody': { innerHTML: '' } };
  const context = {
    $: (selector) => elements[selector],
    fmtMoney: (value) => `$${Number(value).toFixed(2)}`,
    esc: (value) => String(value),
    emptyHTML: () => 'Sin registros',
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.renderPosPaymentReport({
    method: 'card', label: 'Tarjeta', branchName: 'Auroras', sessionId: 20,
    count: 2, total: 160,
    groups: [{ type: 'debit', count: 1, total: 120 }, { type: 'credit', count: 1, total: 40 }],
    transactions: [
      { ticket: 'POS-1', paidAt: '17 Oct 2026, 10:00', cardType: 'debit', amount: 120, mixed: false },
      { ticket: 'POS-2', paidAt: '17 Oct 2026, 10:15', cardType: 'credit', amount: 40, mixed: true },
    ],
  });
  const html = elements['#posPaymentReportBody'].innerHTML;
  assert.match(html, /Detalle de transacciones/);
  assert.match(html, /POS-1/);
  assert.match(html, /POS-2/);
  assert.match(html, /Tarjeta de débito/);
  assert.match(html, /Tarjeta de crédito/);
  assert.doesNotMatch(html, /<input|Captura total externo|Transacciones externas/);
});
