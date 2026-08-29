const MODULES = Object.freeze([
  ['dashboard', 'Dashboard'], ['pedidos', 'Pedidos'], ['clientes', 'Clientes'],
  ['pos', 'Punto de venta'], ['ventas', 'Ventas'], ['facturacion', 'Facturacion MX'],
  ['cfdi', 'CFDI emitidos'], ['cancelaciones', 'Cancelaciones'], ['cortes', 'Cortes'],
  ['kds', 'Pantallas KDS'], ['productos', 'Productos'], ['costos', 'Costo de ventas'],
  ['inventarios', 'Inventarios'], ['stock-sucursales', 'Stock por sucursal'],
  ['compras', 'Compras'], ['empleados', 'Productividad'], ['chatbot', 'Mi chatbot'],
  ['config', 'Mi negocio'], ['suscripciones', 'Suscripciones'], ['instrucciones', 'Instrucciones'],
]);

const MODULE_KEYS = new Set(MODULES.map(([key]) => key));

function normalizeModules(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { value = []; }
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter((item) => MODULE_KEYS.has(item)))];
}

function hasModule(user, moduleKey) {
  return user?.role === 'owner' || normalizeModules(user?.permissions).includes(moduleKey);
}

module.exports = { MODULES, MODULE_KEYS, normalizeModules, hasModule };
