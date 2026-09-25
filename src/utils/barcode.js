function normalizeProductBarcode(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  return raw.replace(/\s+/g, '');
}

function isValidProductBarcode(value) {
  const barcode = normalizeProductBarcode(value);
  return !barcode || /^[A-Z0-9._\-/]{3,64}$/.test(barcode);
}

module.exports = { normalizeProductBarcode, isValidProductBarcode };
