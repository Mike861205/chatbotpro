const FLOATING_ICON_CATALOG = Object.freeze({
  fast_food: ['🍕', '🍔', '🍟', '🌭', '🥤', '🌮', '🥪', '🍗'],
  grill: ['🍗', '🍖', '🔥', '🥩', '🍽️', '🌽', '🥔', '🥤'],
  asian: ['🥡', '🥢', '🍜', '🍣', '🍱', '🥟', '🍚', '🍵'],
  seafood: ['🦐', '🦞', '🦀', '🐟', '🐙', '🦪', '🍋', '🌊'],
  cafe: ['☕', '🧁', '🍰', '🍩', '🍪', '🍫', '🥐', '🍦'],
  healthy: ['🥗', '🥑', '🍎', '🍓', '🍍', '🥕', '🥦', '🧃'],
  technology: ['💻', '📱', '🖥️', '⌨️', '🖱️', '🎧', '🔌', '🤖'],
  finance: ['💵', '💰', '🪙', '💳', '📈', '🧾', '🏦', '💸'],
  services: ['🛍️', '📦', '🎁', '✂️', '🔧', '🧰', '🚚', '⭐'],
  delivery: ['🛵', '🚚', '📦', '📍', '🗺️', '🏠', '⏱️', '✅'],
});

const DEFAULT_FLOATING_ICONS = Object.freeze(['🍕', '💵', '🛵', '💻', '🍔', '📱', '🥤', '🍟']);
const ALLOWED_FLOATING_ICONS = new Set([...DEFAULT_FLOATING_ICONS, ...Object.values(FLOATING_ICON_CATALOG).flat()]);

function parseFloatingIcons(raw, fallback = DEFAULT_FLOATING_ICONS) {
  let value = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return [...fallback];
    try { value = JSON.parse(raw); } catch { return [...fallback]; }
  }
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map((icon) => String(icon || '').trim()).filter((icon) => ALLOWED_FLOATING_ICONS.has(icon)))].slice(0, 8);
}

function validateFloatingIcons(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { throw new Error('La selección de iconos flotantes no es válida'); }
  }
  if (!Array.isArray(value) || value.length > 8) throw new Error('Selecciona hasta 8 iconos flotantes');
  const normalized = parseFloatingIcons(value, []);
  if (normalized.length !== new Set(value.map((icon) => String(icon || '').trim())).size) {
    throw new Error('La selección contiene iconos no disponibles en el catálogo');
  }
  return normalized;
}

module.exports = { FLOATING_ICON_CATALOG, DEFAULT_FLOATING_ICONS, parseFloatingIcons, validateFloatingIcons };
