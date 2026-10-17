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
      categoryTotals: [{ name: 'Servicios', count: 1, total: 100 }],
      expenses: [{ expense_date: '2026-10-07', branch_name: 'Auroras', category_name: 'Servicios', concept: 'Luz', notes: 'Turno', source: 'pos', amount: 100, created_by: 'mike', created_at: '07/10/2026 10:00' }],
    },
    $: (selector) => ({ selectedOptions: [{ textContent: selector === '#costingExpenseFilterCategory' ? 'Servicios' : 'Auroras' }] }),
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
      autoTable(value) { this.tables ||= []; this.tables.push(value); this.table = value; }
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
  assert.match(files[0].filename, /auroras_servicios_2026-10-01_2026-10-31\.xlsx$/);
  const summary = files[0].book.sheets.find((sheet) => sheet.name === 'Resumen').sheet;
  const rows = files[0].book.sheets.find((sheet) => sheet.name === 'Gastos').sheet;
  assert.deepEqual(Array.from(summary.find((row) => row[0] === 'Total vigente')), ['Total vigente', 100]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Sucursal, 'Auroras');
  assert.equal(rows[0].Tipo, 'Gasto');
  assert.equal(rows[0].Categoría, 'Servicios');
  assert.equal(rows[0].Monto, 100);
  assert.equal(files[0].book.sheets.find((sheet) => sheet.name === 'Por categoría').sheet[0].Total, 100);
});

test('PDF usa el mismo alcance filtrado y muestra el total', () => {
  const { context, documents } = exportContext();
  context.exportExpensesPdf();
  assert.equal(documents.length, 1);
  assert.match(documents[0].filename, /auroras_servicios_2026-10-01_2026-10-31\.pdf$/);
  assert.equal(documents[0].tables[0].body.length, 1);
  assert.equal(documents[0].tables[0].body[0][1], 'Auroras');
  assert.equal(documents[0].tables[0].body[0][2], 'Gasto');
  assert.equal(documents[0].tables[0].body[0][3], 'Servicios');
  assert.equal(documents[0].tables[1].body.length, 0);
  assert.ok(documents[0].lines.some((line) => String(line).includes('Vigente: $100.00')));
});

test('un reporte con solo reversos también se exporta a Excel y PDF', () => {
  const { context, files, documents } = exportContext();
  context.COSTING_EXPENSE_DATA.expenses = [];
  context.COSTING_EXPENSE_DATA.total = 0;
  context.COSTING_EXPENSE_DATA.deletedTotal = 100;
  context.COSTING_EXPENSE_DATA.deletedCount = 1;
  context.COSTING_EXPENSE_DATA.deletedExpenses = [{
    expense_date: '2026-10-07', deleted_at: '17/10/2026 11:00', branch_name: 'Auroras',
    movement_kind: 'expense', concept: 'Luz', amount: 100, created_by: 'mike', deleted_by: 'caja7', authorized_by: 'NIP del negocio',
  }];
  context.exportExpensesExcel();
  context.exportExpensesPdf();
  assert.equal(files[0].book.sheets.find((sheet) => sheet.name === 'Reversos').sheet.length, 1);
  assert.equal(documents[0].tables[1].body.length, 1);
  assert.ok(documents[0].lines.some((line) => String(line).includes('Reversos: $100.00')));
});
