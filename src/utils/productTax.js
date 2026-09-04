const PRODUCT_TAX_MODES = new Set(['added', 'included']);

function money(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function normalizeProductTaxConfig(input = {}) {
  const enabled = input.enabled === true || input.taxEnabled === true || String(input.enabled ?? input.taxEnabled ?? input.product_tax_enabled ?? '0') === '1';
  const rawMode = String(input.mode ?? input.taxMode ?? input.product_tax_mode ?? 'included').trim().toLowerCase();
  const rate = Number(input.rate ?? input.taxRate ?? input.product_tax_rate ?? 0.16);
  return {
    enabled,
    mode: PRODUCT_TAX_MODES.has(rawMode) ? rawMode : 'included',
    rate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.16,
  };
}

async function loadProductTaxConfig(tenantDb) {
  const rows = await tenantDb.all(
    "SELECT key,value FROM {s}.settings WHERE key=ANY($1::text[])",
    [['product_tax_enabled', 'product_tax_mode', 'product_tax_rate']]
  );
  return normalizeProductTaxConfig(Object.fromEntries(rows.map((row) => [row.key, row.value])));
}

function effectiveProductPrice(capturedPrice, inputConfig = {}) {
  const config = normalizeProductTaxConfig(inputConfig);
  const price = money(capturedPrice);
  return config.enabled && config.mode === 'added' ? money(price * (1 + config.rate)) : price;
}

function productTaxLineSnapshot(effectivePrice, inputConfig = {}) {
  const config = normalizeProductTaxConfig(inputConfig);
  if (!config.enabled) return {};
  const total = money(effectivePrice);
  const base = config.rate > 0 ? money(total / (1 + config.rate)) : total;
  return {
    taxEnabled: true,
    taxMode: config.mode,
    taxRate: config.rate,
    taxBasePrice: base,
    taxAmount: money(total - base),
  };
}

function applyProductTaxToCatalogProduct(product, inputConfig = {}) {
  const config = normalizeProductTaxConfig(inputConfig);
  const modifierGroups = (product.modifierGroups || product.groups || []).map((group) => ({
    ...group,
    options: (group.options || []).map((option) => ({
      ...option,
      extra_price: effectiveProductPrice(option.extra_price, config),
    })),
  }));
  return {
    ...product,
    price: effectiveProductPrice(product.price, config),
    taxEnabled: config.enabled,
    taxMode: config.mode,
    taxRate: config.rate,
    variants: (product.variants || []).map((variant) => ({
      ...variant,
      price: effectiveProductPrice(variant.price, config),
    })),
    ...(Array.isArray(product.modifierGroups) ? { modifierGroups } : {}),
    ...(Array.isArray(product.groups) ? { groups: modifierGroups } : {}),
  };
}

module.exports = {
  PRODUCT_TAX_MODES,
  normalizeProductTaxConfig,
  loadProductTaxConfig,
  effectiveProductPrice,
  productTaxLineSnapshot,
  applyProductTaxToCatalogProduct,
};