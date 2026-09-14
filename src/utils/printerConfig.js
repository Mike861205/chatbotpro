const MAX_PRINTERS = 12;
const MAX_COPIES = 3;
const VALID_MODES = new Set(['browser', 'qz']);
const VALID_DESTINATION = /^(ticket|general|area:[1-9]\d*)$/;

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('La configuración de impresión directa no es válida');
  }
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizePrinterConfig(raw) {
  const input = parseConfig(raw);
  const mode = VALID_MODES.has(input.mode) ? input.mode : 'browser';
  const sourcePrinters = Array.isArray(input.printers) ? input.printers : [];
  if (sourcePrinters.length > MAX_PRINTERS) {
    throw new Error(`Puedes configurar hasta ${MAX_PRINTERS} impresoras`);
  }

  const usedIds = new Set();
  const printers = sourcePrinters.map((printer, index) => {
    const name = normalizeText(printer?.name, 180);
    if (!name) throw new Error(`Selecciona la impresora ${index + 1}`);
    const label = normalizeText(printer?.label, 60) || name;
    let id = normalizeText(printer?.id, 48).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!id || usedIds.has(id)) id = `printer_${index + 1}`;
    usedIds.add(id);

    const rawBranchId = Number(printer?.branchId);
    const branchId = Number.isInteger(rawBranchId) && rawBranchId > 0 ? rawBranchId : null;
    const widthMm = Number(printer?.widthMm) === 58 ? 58 : 80;
    const copies = Math.max(1, Math.min(MAX_COPIES, Math.trunc(Number(printer?.copies) || 1)));
    const destinations = [...new Set((Array.isArray(printer?.destinations) ? printer.destinations : [])
      .map((destination) => String(destination || '').trim().toLowerCase())
      .filter((destination) => VALID_DESTINATION.test(destination)))];
    if (!destinations.length) throw new Error(`Asigna al menos un destino a ${label}`);

    return { id, label, name, branchId, widthMm, copies, destinations };
  });

  if (mode === 'qz' && !printers.length) {
    throw new Error('Agrega al menos una impresora para activar la impresión directa');
  }

  return { version: 1, mode, printers };
}

module.exports = { normalizePrinterConfig };
