const WEEKDAY_BY_SHORT_NAME = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

function normalizeProductSaleDays(value, { strict = false } = {}) {
  let input = value;
  if (input === null || input === undefined) input = [];
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) input = [];
    else {
      try {
        input = JSON.parse(text);
      } catch {
        if (strict) throw Object.assign(new Error('Los días de venta no tienen un formato válido'), { status: 400 });
        input = [];
      }
    }
  }
  if (!Array.isArray(input)) {
    if (strict) throw Object.assign(new Error('Selecciona días de venta válidos'), { status: 400 });
    return [];
  }

  const days = input.map(Number);
  if (strict && days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw Object.assign(new Error('Los días de venta deben estar entre domingo y sábado'), { status: 400 });
  }
  return [...new Set(days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function weekdayInTimeZone(at = new Date(), timeZone = 'America/Mexico_City') {
  try {
    const shortName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
    return WEEKDAY_BY_SHORT_NAME[shortName] ?? at.getDay();
  } catch {
    return at.getDay();
  }
}

function isProductAvailableToday(product, at = new Date(), timeZone = 'America/Mexico_City') {
  const days = normalizeProductSaleDays(product?.saleDays ?? product?.sale_days);
  return !days.length || days.includes(weekdayInTimeZone(at, timeZone));
}

function productAvailabilityFields(product, at = new Date(), timeZone = 'America/Mexico_City') {
  const saleDays = normalizeProductSaleDays(product?.saleDays ?? product?.sale_days);
  return {
    saleDays,
    availableToday: !saleDays.length || saleDays.includes(weekdayInTimeZone(at, timeZone)),
  };
}

module.exports = {
  normalizeProductSaleDays,
  weekdayInTimeZone,
  isProductAvailableToday,
  productAvailabilityFields,
};
