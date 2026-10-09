const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const start = app.indexOf('function expenseExportDetails()');
const end = app.indexOf("document.querySelectorAll('#costingSort [data-cost-sort]')", start);
assert.ok(start >= 0 && end > start);

function exportContext() {
  const files = [];
  const documents = [];
  const context = {
    COSTING_EXPENSE_DATA: {
      allDates: false, from: '2026-10-01', to: '2026-10-31', total: 100, globalTotal: 170,
      expenses: [{ expense_date: '2026-10-07', branch_name: 'Auroras', concept: 'Luz', notes: 'Turno', source: 'pos', amount: 100, created_by: 'mike', created_at: '07/10/2026 10:00' }],
    },
    $: () => ({ selectedOptions: [{ textContent: 'Auroras' }] }),
    ME: { tenant: { businessName: 'Restaurante' } },
    SETTINGS: {},
    fmtBusinessDateTime: () => '07/10/2026 12:00',
    fmtMoney: (value) => `$${Number(value).toFixed(2)}`,
    toast: (message) => { throw new Error(message); },
    XLSX: {
      utils: {
        book_new: () => ({ sheets: [] }),
        aoa_to_sheet: (rows) => rows,
        json_to_sheet: (rows) => rows,
        book_append_sheet: (book, sheet, name) => book.sheets.push({ name, sheet }),
      },
      writeFile: (book, filename) => files.push({ book, filename }),
    },
    jspdf: { jsPDF: class {
      constructor() { this.lines = []; this.internal = { getNumberOfPages: () => 1, pageSize: { getWidth: () => 270, getHeight: () => 210 } }; documents.push(this); }
      setFontSize() {}
      text(value) { this.lines.push(value); }
      autoTable(value) { this.table = value; }
      setPage() {}
      save(filename) { this.filename = filename; }
    } },
  };
  vm.runInNewContext(app.slice(start, end), context);
  return { context, files, documents };
}

test('Excel exporta únicamente el filtro de fechas y sucursal con total coincidente', () => {
  const { context, files } = exportContext();
  context.exportExpensesExcel();
  assert.equal(files.length, 1);
  assert.match(files[0].filename, /auroras_2026-10-01_2026-10-31\.xlsx$/);
  const summary = files[0].book.sheets.find((sheet) => sheet.name === 'Resumen').sheet;
  const rows = files[0].book.sheets.find((sheet) => sheet.name === 'Gastos').sheet;
  assert.deepEqual(Array.from(summary.find((row) => row[0] === 'Total')), ['Total', 100]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Sucursal, 'Auroras');
  assert.equal(rows[0].Monto, 100);
});

test('PDF usa el mismo alcance filtrado y muestra el total', () => {
  const { context, documents } = exportContext();
  context.exportExpensesPdf();
  assert.equal(documents.length, 1);
  assert.match(documents[0].filename, /auroras_2026-10-01_2026-10-31\.pdf$/);
  assert.equal(documents[0].table.body.length, 1);
  assert.equal(documents[0].table.body[0][1], 'Auroras');
  assert.ok(documents[0].lines.some((line) => String(line).includes('Total: $100.00')));
});
