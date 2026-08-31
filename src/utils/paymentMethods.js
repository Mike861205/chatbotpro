const CORE_PAYMENT_METHOD_IDS = new Set(['cash', 'card', 'transfer', 'mixed', 'multiple']);
const ACCOUNT_IDENTIFIER_TYPES = new Set(['account', 'clabe', 'card', 'phone', 'document', 'email', 'other']);
const ACCOUNT_IDENTIFIER_LABELS = { account: 'Número de cuenta', clabe: 'CLABE interbancaria', card: 'Número de tarjeta', phone: 'Teléfono', document: 'Documento / identificación', email: 'Correo electrónico', other: 'Dato para el pago' };

function legacyAccountFields(account) {
  if (!account?.bankName && !account?.holderName && !account?.identifier) return [];
  return [
    { label: 'Banco o institución', value: account.bankName },
    { label: 'Nombre del titular', value: account.holderName },
    { label: ACCOUNT_IDENTIFIER_LABELS[account.identifierType] || 'Dato para el pago', value: account.identifier },
  ];
}

function normalizePaymentAccounts(raw, options = {}) {
  const { context = 'cuentas', required = false } = options;
  let accounts;
  try {
    accounts = Array.isArray(raw) ? raw : JSON.parse(String(raw || '[]'));
  } catch {
    throw new Error(`La configuración de ${context} no es válida`);
  }
  if (!Array.isArray(accounts) || accounts.length > 10) {
    throw new Error(`Puedes configurar hasta 10 cuentas en ${context}`);
  }
  if (required && !accounts.length) {
    throw new Error(`Agrega al menos una cuenta en ${context}`);
  }
  return accounts.map((account) => {
    const sourceFields = Array.isArray(account?.fields) ? account.fields : legacyAccountFields(account);
    if (!sourceFields.length || sourceFields.length > 12) {
      throw new Error(`Cada cuenta de ${context} debe tener entre 1 y 12 datos`);
    }
    const fields = sourceFields.map((field) => ({
      label: String(field?.label || '').trim().slice(0, 50),
      value: String(field?.value || '').trim().slice(0, 160),
    }));
    if (fields.some((field) => !field.label || !field.value)) {
      throw new Error(`Completa el título y la información de cada dato en ${context}`);
    }
    return { fields };
  });
}

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
    const accountDetailsEnabled = method?.accountDetailsEnabled === true;
    const accounts = normalizePaymentAccounts(method?.accounts || [], {
      context: label,
      required: accountDetailsEnabled,
    });
    return { id, label, active: method?.active !== false, accountDetailsEnabled, accounts };
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
  ACCOUNT_IDENTIFIER_TYPES,
  CORE_PAYMENT_METHOD_IDS,
  isCustomPaymentMethod,
  normalizeCustomPaymentMethods,
  normalizePaymentAccounts,
  parseCustomPaymentMethods,
};
