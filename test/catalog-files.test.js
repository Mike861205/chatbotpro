const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const sharp = require('sharp');
const { catalogFileKind, spreadsheetText, renderCatalogPdf, prepareCatalogFiles } = require('../src/utils/catalogFiles');

function workbookBytes(rows, type = 'xlsx', configure = () => {}) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  configure(sheet);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Productos');
  return XLSX.write(workbook, { type: 'buffer', bookType: type });
}

// PDF real, sin proveedor IA ni archivos del usuario. Incluye una página de texto
// y otra con una imagen incrustada para verificar también PDF escaneados.
function pdfBytes(image) {
  const text = 'BT /F1 18 Tf 10 160 Td (Leche 25.00 - 0001234567890) Tj ET';
  const draw = 'q 200 0 0 200 0 0 cm /Photo Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Photo 8 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.from(object), Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    length += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));
  return Buffer.concat(chunks);
}

test('acepta imágenes, PDF y Excel/CSV, pero no ejecutables ni otros archivos', () => {
  for (const [originalname, mimetype, expected] of [
    ['foto.jpg', 'image/jpeg', 'image'], ['MENU.PDF', 'application/pdf', 'pdf'],
    ['catalogo.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'],
    ['catalogo.xls', 'application/vnd.ms-excel', 'spreadsheet'], ['catalogo.csv', 'text/csv', 'spreadsheet'],
    ['programa.exe', 'application/octet-stream', null], ['catalogo.pdf', 'text/html', null],
  ]) assert.equal(catalogFileKind({ originalname, mimetype }), expected);
});

for (const type of ['xlsx', 'xls']) test(`lee ${type} conservando códigos de texto y ceros iniciales con formato numérico`, () => {
  const bytes = workbookBytes([
    ['Producto', 'Precio', 'Código de barras'], ['Leche', 25.5, '0001234567890'], ['Pan', 20, 123],
  ], type, (sheet) => { sheet.C3.z = '0000000000000'; });
  const parsed = JSON.parse(spreadsheetText(bytes, `catalogo.${type}`).text);
  assert.equal(parsed.sheets[0].rows[1].cells[2], '0001234567890');
  assert.equal(parsed.sheets[0].rows[2].cells[2], '0000000000123');
  assert.equal(parsed.sheets[0].rows[1].cells[1], '25.5');
});

test('CSV preserva ceros iniciales sin convertirlos a números', () => {
  const bytes = Buffer.from('Producto,Precio,EAN\nLeche,25.50,0001234567890\n');
  const parsed = JSON.parse(spreadsheetText(bytes, 'catalogo.csv').text);
  assert.equal(parsed.sheets[0].rows[1].cells[2], '0001234567890');
});

test('convierte notación científica en EAN completo y rechaza números cuya precisión ya se perdió', () => {
  const bytes = workbookBytes([['Producto', 'EAN'], ['Leche', 7501234567890]], 'xlsx', (sheet) => { sheet.B2.z = '0.00E+00'; });
  assert.equal(JSON.parse(spreadsheetText(bytes, 'catalogo.xlsx').text).sheets[0].rows[1].cells[1], '7501234567890');
  assert.throws(() => spreadsheetText(workbookBytes([['Producto', 'EAN'], ['Leche', 1234567890123456]]), 'catalogo.xlsx'), /perdió precisión/);
});

test('rechaza hojas vacías y catálogos demasiado grandes sin truncarlos en silencio', () => {
  assert.throws(() => spreadsheetText(workbookBytes([]), 'vacio.xlsx'), /no contiene/);
  assert.throws(() => spreadsheetText(workbookBytes([['Nombre'], ['A'], ['B'], ['C']]), 'grande.xlsx', { maxRows: 2 }), /supera/);
  assert.throws(() => spreadsheetText(workbookBytes([['A', 'B', 'C']]), 'grande.xlsx', { maxColumns: 2 }), /supera/);
});

test('renderiza todas las páginas del PDF, incluido contenido escaneado, en imágenes legibles', async () => {
  const image = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#0044cc' } }).jpeg().toBuffer();
  const pages = await renderCatalogPdf(pdfBytes(image), 'menu.pdf', 20);
  assert.equal(pages.length, 2);
  assert.match(pages[1].originalname, /página 2/);
  const metadata = await sharp(pages[1].buffer).metadata();
  assert.equal(metadata.format, 'jpeg');
  const { data } = await sharp(pages[1].buffer).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[2] > 150 && data[0] < 20, 'la imagen del PDF no debe convertirse en una página vacía');
  await assert.rejects(renderCatalogPdf(pdfBytes(image), 'menu.pdf', 1), /supera 20 páginas/);
  await assert.rejects(renderCatalogPdf(Buffer.from('No soy PDF'), 'roto.pdf', 20), /PDF válido/);
});

test('carga mixta reúne imágenes y filas sin enviar Excel como imagen a la IA', async () => {
  const photo = { originalname: 'foto.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('placeholder') };
  const excel = { originalname: 'productos.xlsx', mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbookBytes([['Nombre', 'Barcode'], ['Leche', '000123']]) };
  const prepared = await prepareCatalogFiles([photo, excel]);
  assert.deepEqual(prepared.images, [photo]);
  assert.equal(prepared.texts.length, 1);
  assert.match(prepared.texts[0], /000123/);
});
