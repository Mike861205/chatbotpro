const CORE_PAYMENT_METHOD_IDS = new Set(['cash', 'card', 'transfer', 'mixed', 'multiple']);

function paymentMethodId(value, fallbackIndex = 1) {
  const base = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return `custom_${base || fallbackIndex}`;
}

function normalizeCustomPaymentMethods(raw) {
  let methods;
  try {
    methods = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]'));
  } catch {
    throw new Error('La configuración de medios de pago personalizados no es válida');
  }
  if (!Array.isArray(methods) || methods.length > 15) {
    throw new Error('Puedes configurar hasta 15 medios de pago personalizados');
  }

  const used = new Set();
  return methods.map((method, index) => {
    const label = String(method?.label || '').trim().replace(/\s+/g, ' ').slice(0, 42);
    if (!label) throw new Error('Escribe el nombre de cada medio de pago personalizado');
    let id = String(method?.id || '').trim().toLowerCase();
    if (!/^custom_[a-z0-9_]{1,30}$/.test(id)) id = paymentMethodId(label, index + 1);
    const baseId = id;
    let suffix = 2;
    while (used.has(id) || CORE_PAYMENT_METHOD_IDS.has(id)) {
      id = `${baseId}_${suffix++}`.slice(0, 37);
    }
    used.add(id);
    return { id, label, active: method?.active !== false };
  });
}

function parseCustomPaymentMethods(raw) {
  try {
    return normalizeCustomPaymentMethods(raw);
  } catch {
    return [];
  }
}

function isCustomPaymentMethod(value) {
  return /^custom_[a-z0-9_]{1,36}$/.test(String(value || ''));
}

module.exports = {
  CORE_PAYMENT_METHOD_IDS,
  isCustomPaymentMethod,
  normalizeCustomPaymentMethods,
  parseCustomPaymentMethods,
};
