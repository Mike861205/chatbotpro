const CATALOG_PROFILES = {
  restaurant: {
    document: 'menú de restaurante o cafetería',
    item: 'producto vendible',
    categoryExamples: 'Hamburguesas, Bebidas, Postres',
    descriptionRule: 'Describe brevemente ingredientes, preparación o presentación.',
  },
  furniture: {
    document: 'catálogo de una mueblería',
    item: 'mueble o conjunto vendible',
    categoryExamples: 'Salas, Recámaras, Comedores',
    descriptionRule: 'Describe medidas, materiales, colores o acabados que aparezcan.',
  },
  travel_agency: {
    document: 'catálogo de una agencia de viajes',
    item: 'paquete, tour, traslado o servicio reservable',
    categoryExamples: 'Paquetes, Tours, Hoteles, Traslados',
    descriptionRule: 'Describe destino, duración, fechas, inclusiones y restricciones que aparezcan.',
  },
  office_services: {
    document: 'catálogo de servicios profesionales',
    item: 'servicio o plan contratable',
    categoryExamples: 'Consultoría, Contabilidad, Legal',
    descriptionRule: 'Describe alcance, modalidad, duración u honorarios que aparezcan.',
  },
  screen_printing: {
    document: 'catálogo de serigrafía o estampado',
    item: 'prenda, técnica o servicio cotizable',
    categoryExamples: 'Playeras, DTF, Vinil, Sublimación',
    descriptionRule: 'Describe técnica, material, talla, color, tiraje o número de tintas que aparezcan.',
  },
  carpentry: {
    document: 'catálogo de carpintería',
    item: 'mueble o trabajo cotizable',
    categoryExamples: 'Cocinas, Clósets, Puertas, Muebles',
    descriptionRule: 'Describe medidas, madera, acabado, estilo o tiempo de fabricación que aparezcan.',
  },
  health: {
    document: 'catálogo de una clínica o centro de salud',
    item: 'consulta, estudio o servicio agendable',
    categoryExamples: 'Consultas, Estudios, Especialidades',
    descriptionRule: 'Describe especialidad, duración y requisitos previos; no inventes diagnósticos ni indicaciones médicas.',
  },
  dentist: {
    document: 'catálogo de un consultorio dental',
    item: 'tratamiento, valoración o servicio agendable',
    categoryExamples: 'Preventiva, Ortodoncia, Endodoncia, Estética',
    descriptionRule: 'Describe sesiones, alcance o requisitos publicados; no inventes diagnósticos ni planes de tratamiento.',
  },
};

function getCatalogProfile(businessType) {
  const key = String(businessType || 'restaurant').trim().toLowerCase();
  return CATALOG_PROFILES[key] || CATALOG_PROFILES.restaurant;
}

function buildAiCatalogPrompt(businessType, categoryNames = []) {
  const profile = getCatalogProfile(businessType);
  return [
    `Analiza este ${profile.document} y regresa SOLO JSON válido.`,
    `Genera cada ${profile.item} listo para cargar en el sistema POS/chatbot.`,
    'El campo interno "products" representa los artículos o servicios del catálogo, sin importar el giro.',
    'Formato JSON requerido:',
    '{"products":[{"name":"string","description":"string","price":123.45,"categoryName":"string","variantGroup":"string opcional","variantName":"string opcional"}],"notes":["string"]}',
    'Reglas:',
    `- Incluye solo cada ${profile.item}; omite encabezados, subtotales y texto decorativo.`,
    '- price debe ser número mayor o igual a 0.',
    `- categoryName debe ser breve (ej. ${profile.categoryExamples}).`,
    `- ${profile.descriptionRule}`,
    '- Si un artículo o servicio tiene presentaciones, planes o modalidades, usa variantGroup para el nombre base y variantName para la opción.',
    '- Si falta precio, usa 0 y agrega una nota; no inventes información.',
    '- Máximo 60 elementos.',
    `Categorías existentes del tenant: ${categoryNames.join(', ') || 'Ninguna'}`,
  ].join('\n');
}

module.exports = { buildAiCatalogPrompt, getCatalogProfile };