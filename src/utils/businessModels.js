const BUSINESS_MODELS = Object.freeze({
  restaurant: 'Restaurante / cafetería',
  grocery: 'Tienda / abarrotes',
  furniture: 'Mueblería',
  travel_agency: 'Agencia de viajes',
  office_services: 'Oficina / servicios profesionales',
  screen_printing: 'Serigrafía / estampado',
  carpentry: 'Carpintería',
  health: 'Salud / clínica',
  dentist: 'Consultorio dental',
});

function isBusinessModel(value) {
  return Object.hasOwn(BUSINESS_MODELS, value);
}

module.exports = { BUSINESS_MODELS, isBusinessModel };
