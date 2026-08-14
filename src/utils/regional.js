const CURRENCIES = Object.freeze([
  { code: 'MXN', flag: '🇲🇽', name: 'Peso mexicano' },
  { code: 'USD', flag: '🇺🇸', name: 'Dólar estadounidense' },
  { code: 'GTQ', flag: '🇬🇹', name: 'Quetzal guatemalteco' },
  { code: 'BZD', flag: '🇧🇿', name: 'Dólar beliceño' },
  { code: 'HNL', flag: '🇭🇳', name: 'Lempira hondureño' },
  { code: 'NIO', flag: '🇳🇮', name: 'Córdoba nicaragüense' },
  { code: 'CRC', flag: '🇨🇷', name: 'Colón costarricense' },
  { code: 'PAB', flag: '🇵🇦', name: 'Balboa panameño' },
  { code: 'CUP', flag: '🇨🇺', name: 'Peso cubano' },
  { code: 'DOP', flag: '🇩🇴', name: 'Peso dominicano' },
  { code: 'HTG', flag: '🇭🇹', name: 'Gourde haitiano' },
  { code: 'JMD', flag: '🇯🇲', name: 'Dólar jamaiquino' },
  { code: 'BSD', flag: '🇧🇸', name: 'Dólar bahameño' },
  { code: 'BBD', flag: '🇧🇧', name: 'Dólar barbadense' },
  { code: 'TTD', flag: '🇹🇹', name: 'Dólar de Trinidad y Tobago' },
  { code: 'XCD', flag: '🏝️', name: 'Dólar del Caribe Oriental' },
  { code: 'COP', flag: '🇨🇴', name: 'Peso colombiano' },
  { code: 'VES', flag: '🇻🇪', name: 'Bolívar venezolano' },
  { code: 'GYD', flag: '🇬🇾', name: 'Dólar guyanés' },
  { code: 'SRD', flag: '🇸🇷', name: 'Dólar surinamés' },
  { code: 'PEN', flag: '🇵🇪', name: 'Sol peruano' },
  { code: 'BOB', flag: '🇧🇴', name: 'Boliviano' },
  { code: 'PYG', flag: '🇵🇾', name: 'Guaraní paraguayo' },
  { code: 'CLP', flag: '🇨🇱', name: 'Peso chileno' },
  { code: 'ARS', flag: '🇦🇷', name: 'Peso argentino' },
  { code: 'UYU', flag: '🇺🇾', name: 'Peso uruguayo' },
  { code: 'BRL', flag: '🇧🇷', name: 'Real brasileño' },
  { code: 'EUR', flag: '🇪🇺', name: 'Euro' },
]);

const TIME_ZONES = Object.freeze([
  { value: 'America/Mexico_City', label: 'México · Centro' },
  { value: 'America/Chihuahua', label: 'México · Chihuahua' },
  { value: 'America/Tijuana', label: 'México · Tijuana' },
  { value: 'America/Hermosillo', label: 'México · Sonora' },
  { value: 'America/Mazatlan', label: 'México · Pacífico' },
  { value: 'America/Cancun', label: 'México · Quintana Roo' },
  { value: 'America/Matamoros', label: 'México · Frontera norte' },
  { value: 'America/Ojinaga', label: 'México · Ojinaga' },
  { value: 'America/Guatemala', label: 'Guatemala' },
  { value: 'America/Belize', label: 'Belice' },
  { value: 'America/El_Salvador', label: 'El Salvador' },
  { value: 'America/Tegucigalpa', label: 'Honduras' },
  { value: 'America/Managua', label: 'Nicaragua' },
  { value: 'America/Costa_Rica', label: 'Costa Rica' },
  { value: 'America/Panama', label: 'Panamá' },
  { value: 'America/Havana', label: 'Cuba' },
  { value: 'America/Santo_Domingo', label: 'República Dominicana' },
  { value: 'America/Puerto_Rico', label: 'Puerto Rico' },
  { value: 'America/Port-au-Prince', label: 'Haití' },
  { value: 'America/Jamaica', label: 'Jamaica' },
  { value: 'America/Nassau', label: 'Bahamas' },
  { value: 'America/Barbados', label: 'Barbados y Caribe Oriental' },
  { value: 'America/Port_of_Spain', label: 'Trinidad y Tobago' },
  { value: 'America/Bogota', label: 'Colombia' },
  { value: 'America/Caracas', label: 'Venezuela' },
  { value: 'America/Guyana', label: 'Guyana' },
  { value: 'America/Paramaribo', label: 'Surinam' },
  { value: 'America/Guayaquil', label: 'Ecuador continental' },
  { value: 'Pacific/Galapagos', label: 'Ecuador · Galápagos' },
  { value: 'America/Lima', label: 'Perú' },
  { value: 'America/La_Paz', label: 'Bolivia' },
  { value: 'America/Asuncion', label: 'Paraguay' },
  { value: 'America/Santiago', label: 'Chile continental' },
  { value: 'Pacific/Easter', label: 'Chile · Isla de Pascua' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina' },
  { value: 'America/Montevideo', label: 'Uruguay' },
  { value: 'America/Sao_Paulo', label: 'Brasil · São Paulo / Brasilia' },
  { value: 'America/Fortaleza', label: 'Brasil · Nordeste' },
  { value: 'America/Recife', label: 'Brasil · Recife' },
  { value: 'America/Belem', label: 'Brasil · Belém' },
  { value: 'America/Manaus', label: 'Brasil · Amazonas' },
  { value: 'America/Cuiaba', label: 'Brasil · Mato Grosso' },
  { value: 'America/Rio_Branco', label: 'Brasil · Acre' },
  { value: 'America/Argentina/Cordoba', label: 'Argentina · Córdoba' },
  { value: 'America/Argentina/Mendoza', label: 'Argentina · Mendoza' },
  { value: 'America/New_York', label: 'Estados Unidos · Este' },
  { value: 'America/Chicago', label: 'Estados Unidos · Centro' },
  { value: 'America/Denver', label: 'Estados Unidos · Montaña' },
  { value: 'America/Los_Angeles', label: 'Estados Unidos · Pacífico' },
  { value: 'Europe/Madrid', label: 'España' },
]);

const COUNTRY_DEFAULTS = Object.freeze({
  MX: ['MXN', 'America/Mexico_City'], GT: ['GTQ', 'America/Guatemala'], BZ: ['BZD', 'America/Belize'],
  SV: ['USD', 'America/El_Salvador'], HN: ['HNL', 'America/Tegucigalpa'], NI: ['NIO', 'America/Managua'],
  CR: ['CRC', 'America/Costa_Rica'], PA: ['PAB', 'America/Panama'], CU: ['CUP', 'America/Havana'],
  DO: ['DOP', 'America/Santo_Domingo'], PR: ['USD', 'America/Puerto_Rico'], HT: ['HTG', 'America/Port-au-Prince'],
  JM: ['JMD', 'America/Jamaica'], BS: ['BSD', 'America/Nassau'], BB: ['BBD', 'America/Barbados'],
  TT: ['TTD', 'America/Port_of_Spain'], CO: ['COP', 'America/Bogota'], VE: ['VES', 'America/Caracas'],
  GY: ['GYD', 'America/Guyana'], SR: ['SRD', 'America/Paramaribo'], EC: ['USD', 'America/Guayaquil'],
  PE: ['PEN', 'America/Lima'], BO: ['BOB', 'America/La_Paz'], PY: ['PYG', 'America/Asuncion'],
  CL: ['CLP', 'America/Santiago'], AR: ['ARS', 'America/Argentina/Buenos_Aires'], UY: ['UYU', 'America/Montevideo'],
  BR: ['BRL', 'America/Sao_Paulo'], US: ['USD', 'America/New_York'], ES: ['EUR', 'Europe/Madrid'],
});

const CURRENCY_CODES = new Set(CURRENCIES.map((item) => item.code));
const TIME_ZONE_IDS = new Set(TIME_ZONES.map((item) => item.value));

function regionalDefaults(country) {
  const [currency, timezone] = COUNTRY_DEFAULTS[String(country || '').trim().toUpperCase()] || ['USD', 'America/New_York'];
  return { currency, timezone };
}

function isSupportedCurrency(value) {
  return CURRENCY_CODES.has(String(value || '').trim().toUpperCase());
}

function isSupportedTimeZone(value) {
  return TIME_ZONE_IDS.has(String(value || '').trim());
}

function normalizeTimeZone(value, fallback = 'America/Mexico_City') {
  const timezone = String(value || '').trim();
  return isSupportedTimeZone(timezone) ? timezone : fallback;
}

module.exports = {
  CURRENCIES,
  TIME_ZONES,
  regionalDefaults,
  isSupportedCurrency,
  isSupportedTimeZone,
  normalizeTimeZone,
};
