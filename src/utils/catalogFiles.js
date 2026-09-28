const fs = require('node:fs/promises');
const path = require('node:path');
const XLSX = require('xlsx');

const MAX_CATALOG_PAGES = 20;
const MAX_CATALOG_ROWS = 500;
const MAX_CATALOG_COLUMNS = 50;
const MAX_CATALOG_TEXT = 100000;

function catalogError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { status: 400 });
}

function catalogFileKind(file) {
  const mime = String(file?.mimetype || file?.type || '').toLowerCase();
  const ext = path.extname(String(file?.originalname || file?.name || '')).toLowerCase();
  if (/^image\/(png|jpe?g|webp|gif)$/.test(mime)) return 'image';
  if (ext === '.pdf' && ['application/pdf', 'application/octet-stream', ''].includes(mime)) return 'pdf';
  if (['.xlsx', '.xls', '.csv'].includes(ext) && [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel', 'text/csv', 'application/csv', 'text/plain',
    'application/octet-stream', '',
  ].includes(mime)) return 'spreadsheet';
  return null;
}

function barcodeHeader(value) {
  const key = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /barcode|bar.?code|barras|\b(ean|upc|gtin)\b/.test(key);
}

function spreadsheetText(bytes, filename, limits = {}) {
  const maxRows = limits.maxRows ?? MAX_CATALOG_ROWS;
  const maxColumns = limits.maxColumns ?? MAX_CATALOG_COLUMNS;
  let workbook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'buffer', raw: true, cellNF: true, cellText: true,
      cellFormula: false, cellHTML: false, sheetRows: maxRows + 2,
    });
  } catch {
    throw catalogError(`No se pudo leer ${filename}. Usa un Excel válido, sin contraseña, o un CSV UTF-8.`);
  }
  let rowCount = 0;
  const sheets = [];
  if (workbook.SheetNames.length > 20) throw catalogError(`${filename} contiene demasiadas hojas. Usa hasta 20 hojas por archivo.`);
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet?.['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
    if (range.e.c - range.s.c + 1 > maxColumns || range.e.r - range.s.r > maxRows) {
      throw catalogError(`${filename} supera ${maxRows} filas o ${maxColumns} columnas. Divide el catálogo en archivos más pequeños.`);
    }
    const rows = [];
    const barcodeColumns = new Set();
    for (let r = range.s.r; r <= range.e.r; r += 1) {
      const values = [];
      for (let c = range.s.c; c <= range.e.c; c += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        let value = cell ? String(cell.w ?? cell.v ?? '') : '';
        if (barcodeHeader(value)) barcodeColumns.add(c);
        if (cell?.t === 'n' && barcodeColumns.has(c)) {
          if (!Number.isSafeInteger(cell.v) || String(Math.abs(cell.v)).length > 15) {
            throw catalogError(`El código de barras en ${filename}, hoja ${name}, fila ${r + 1}, perdió precisión. Guarda esa columna como texto y vuelve a cargarla.`);
          }
          // Excel puede mostrar EAN/UPC en notación científica. No enviarla a la IA.
          value = /e[+-]?\d+/i.test(value) ? String(cell.v) : XLSX.utils.format_cell(cell);
        }
        values.push(value);
      }
      if (values.some((value) => value.trim())) {
        rows.push({ row: r + 1, cells: values });
        rowCount += 1;
        if (rowCount > maxRows + workbook.SheetNames.length) {
          throw catalogError(`${filename} supera ${maxRows} filas de datos. Divide el archivo.`);
        }
      }
    }
    if (rows.length) sheets.push({ sheet: name, rows });
  }
  if (!sheets.length) throw catalogError(`${filename} no contiene filas con datos.`);
  return { text: JSON.stringify({ file: filename, sheets }), rowCount };
}

async function renderCatalogPdf(bytes, filename, remainingPages) {
  let document;
  let task;
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const assetPath = (folder) => path.join(root, folder).split(path.sep).join('/') + '/';
    task = getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false,
      cMapUrl: assetPath('cmaps'), cMapPacked: true,
      standardFontDataUrl: assetPath('standard_fonts'),
      wasmUrl: assetPath('wasm'),
      maxImageSize: 16000000,
    });
    document = await task.promise;
    if (document.numPages > remainingPages) {
      throw catalogError(`La carga supera ${MAX_CATALOG_PAGES} páginas entre imágenes y PDF. Divide el documento.`);
    }
    const pages = [];
    for (let n = 1; n <= document.numPages; n += 1) {
      const page = await document.getPage(n);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(3, 2000 / Math.max(original.width, original.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvasContext: canvas.context, viewport }).promise;
        pages.push({ buffer: canvas.canvas.toBuffer('image/jpeg', 88), mimetype: 'image/jpeg', originalname: `${filename} · página ${n}` });
      } finally {
        document.canvasFactory.destroy(canvas);
        page.cleanup();
      }
    }
    return pages;
  } catch (error) {
    if (error.status) throw error;
    throw catalogError(`No se pudo leer ${filename}. Verifica que sea un PDF válido y sin contraseña.`, error);
  } finally {
    if (task) await task.destroy();
  }
}

async function prepareCatalogFiles(files) {
  const images = [];
  const texts = [];
  let textLength = 0;
  for (const file of files) {
    const kind = catalogFileKind(file);
    const filename = file.originalname || file.name || 'archivo';
    if (!kind) throw catalogError('Usa imágenes PNG/JPG/WebP/GIF, PDF, Excel (.xlsx/.xls) o CSV.');
    if (kind === 'image') {
      if (images.length >= MAX_CATALOG_PAGES) throw catalogError(`Puedes analizar hasta ${MAX_CATALOG_PAGES} páginas por carga.`);
      images.push(file);
      continue;
    }
    const bytes = file.buffer || await fs.readFile(file.path);
    if (kind === 'pdf') {
      images.push(...await renderCatalogPdf(bytes, filename, MAX_CATALOG_PAGES - images.length));
    } else {
      const { text } = spreadsheetText(bytes, filename);
      textLength += text.length;
      if (textLength > MAX_CATALOG_TEXT) throw catalogError('Los archivos de Excel contienen demasiado texto. Divide el catálogo.');
      texts.push(text);
    }
  }
  return { images, texts };
}

module.exports = { catalogFileKind, prepareCatalogFiles, renderCatalogPdf, spreadsheetText };
