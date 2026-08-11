const {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} = require('libphonenumber-js/max');

const SUPPORTED_COUNTRIES = new Set(getCountries());
const displayNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['es'], { type: 'region' })
  : null;

function countryName(country) {
  const code = String(country || '').trim().toUpperCase();
  if (!SUPPORTED_COUNTRIES.has(code)) return '';
  try {
    return displayNames?.of(code) || code;
  } catch {
    return code;
  }
}

function isObviouslyFake(nationalNumber) {
  const digits = String(nationalNumber || '').replace(/\D/g, '');
  if (!digits) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  if (/^(0123456789|1234567890|9876543210|0987654321)$/.test(digits)) return true;
  if (/^(.{1,3})\1{2,}$/.test(digits)) return true;
  return false;
}

function invalidPhone(message) {
  const error = new Error(message);
  error.code = 'INVALID_PHONE';
  error.status = 400;
  return error;
}

function normalizeInternationalPhone(rawPhone, rawCountry) {
  const country = String(rawCountry || '').trim().toUpperCase();
  if (!SUPPORTED_COUNTRIES.has(country)) {
    throw invalidPhone('Selecciona un país válido para el teléfono');
  }

  const input = String(rawPhone || '').trim();
  if (!input) throw invalidPhone('Ingresa tu número de teléfono');
  if (/[a-z]/i.test(input)) throw invalidPhone('El teléfono sólo puede contener números y símbolos telefónicos');

  const rawDigits = input.replace(/\D/g, '');
  const digits = rawDigits.startsWith('00') ? rawDigits.slice(2) : rawDigits;
  if (digits.length < 4 || digits.length > 15) {
    throw invalidPhone('El número está incompleto o excede la longitud internacional permitida');
  }

  const hasInternationalPrefix = input.startsWith('+') || rawDigits.startsWith('00');
  const primaryInput = input.startsWith('+')
    ? input
    : (rawDigits.startsWith('00') ? `+${digits}` : digits);
  let parsed = parsePhoneNumberFromString(primaryInput, country);
  if ((!parsed || !parsed.isPossible() || !parsed.isValid()) && !hasInternationalPrefix) {
    const internationalCandidate = parsePhoneNumberFromString(`+${digits}`);
    if (internationalCandidate?.isPossible() && internationalCandidate?.isValid()) parsed = internationalCandidate;
  }
  if (!parsed || !parsed.isPossible() || !parsed.isValid()) {
    throw invalidPhone(`Ingresa un teléfono válido para ${countryName(country)}`);
  }
  if (parsed.country && parsed.country !== country) {
    throw invalidPhone(`La lada del número no corresponde a ${countryName(country)}`);
  }
  if (isObviouslyFake(parsed.nationalNumber)) {
    throw invalidPhone('Ingresa un teléfono real; no se permiten números repetidos o secuenciales');
  }

  const resolvedCountry = parsed.country || country;
  return {
    country: resolvedCountry,
    countryName: countryName(resolvedCountry),
    callingCode: String(parsed.countryCallingCode || getCountryCallingCode(resolvedCountry)),
    e164: parsed.number,
    digits: parsed.number.replace(/\D/g, ''),
    nationalNumber: String(parsed.nationalNumber),
    international: parsed.formatInternational(),
  };
}

function phoneCountries() {
  return getCountries()
    .map((code) => ({
      code,
      name: countryName(code),
      callingCode: String(getCountryCallingCode(code)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function describeStoredPhone(rawPhone, storedCountry = '', storedCallingCode = '') {
  const value = String(rawPhone || '').trim();
  const selectedCountry = String(storedCountry || '').trim().toUpperCase();
  let parsed = null;

  if (value) {
    if (value.startsWith('+')) parsed = parsePhoneNumberFromString(value);
    else if (selectedCountry) parsed = parsePhoneNumberFromString(value, selectedCountry);
    else {
      const legacyDigits = value.replace(/\D/g, '');
      // El formulario histórico pedía 10 dígitos mexicanos. Para valores más
      // largos intentamos primero reconocer una lada internacional ya incluida.
      parsed = legacyDigits.length === 10
        ? parsePhoneNumberFromString(legacyDigits, 'MX')
        : parsePhoneNumberFromString(`+${legacyDigits}`);
      if (!parsed || !parsed.isValid()) parsed = parsePhoneNumberFromString(legacyDigits, 'MX');
    }
  }

  const country = SUPPORTED_COUNTRIES.has(selectedCountry) ? selectedCountry : (parsed?.country || '');
  const callingCode = String(storedCallingCode || parsed?.countryCallingCode || (country ? getCountryCallingCode(country) : ''));
  const digits = parsed?.number?.replace(/\D/g, '') || value.replace(/\D/g, '');
  const valid = Boolean(parsed?.isPossible() && parsed?.isValid() && !isObviouslyFake(parsed.nationalNumber));

  return {
    country,
    countryName: countryName(country),
    callingCode,
    e164: parsed?.number || (digits ? `+${digits}` : ''),
    digits,
    international: parsed?.formatInternational() || (digits ? `+${digits}` : ''),
    valid,
  };
}

module.exports = {
  countryName,
  describeStoredPhone,
  isObviouslyFake,
  normalizeInternationalPhone,
  phoneCountries,
};
