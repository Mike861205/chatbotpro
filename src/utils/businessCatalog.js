const CATALOG_PROFILES = {
  restaurant: {
    document: 'menú de restaurante o cafetería',
    item: 'producto vendible',
    categoryExamples: 'Hamburguesas, Bebidas, Postres',
    descriptionRule: 'Conserva los ingredientes, preparación, contenido y presentación que sí sean visibles.',
  },
  furniture: {
    document: 'catálogo de una mueblería',
    item: 'mueble o conjunto vendible',
    categoryExamples: 'Salas, Recámaras, Comedores',
    descriptionRule: 'Conserva medidas, materiales, colores o acabados que aparezcan.',
  },
  travel_agency: {
    document: 'catálogo de una agencia de viajes',
    item: 'paquete, tour, traslado o servicio reservable',
    categoryExamples: 'Paquetes, Tours, Hoteles, Traslados',
    descriptionRule: 'Conserva destino, duración, fechas, inclusiones y restricciones que aparezcan.',
  },
  office_services: {
    document: 'catálogo de servicios profesionales',
    item: 'servicio o plan contratable',
    categoryExamples: 'Consultoría, Contabilidad, Legal',
    descriptionRule: 'Conserva alcance, modalidad, duración u honorarios que aparezcan.',
  },
  screen_printing: {
    document: 'catálogo de serigrafía o estampado',
    item: 'prenda, técnica o servicio cotizable',
    categoryExamples: 'Playeras, DTF, Vinil, Sublimación',
    descriptionRule: 'Conserva técnica, material, talla, color, tiraje o número de tintas que aparezcan.',
  },
  carpentry: {
    document: 'catálogo de carpintería',
    item: 'mueble o trabajo cotizable',
    categoryExamples: 'Cocinas, Clósets, Puertas, Muebles',
    descriptionRule: 'Conserva medidas, madera, acabado, estilo o tiempo de fabricación que aparezcan.',
  },
  health: {
    document: 'catálogo de una clínica o centro de salud',
    item: 'consulta, estudio o servicio agendable',
    categoryExamples: 'Consultas, Estudios, Especialidades',
    descriptionRule: 'Conserva especialidad, duración y requisitos publicados; no inventes diagnósticos ni indicaciones médicas.',
  },
  dentist: {
    document: 'catálogo de un consultorio dental',
    item: 'tratamiento, valoración o servicio agendable',
    categoryExamples: 'Preventiva, Ortodoncia, Endodoncia, Estética',
    descriptionRule: 'Conserva sesiones, alcance o requisitos publicados; no inventes diagnósticos ni planes de tratamiento.',
  },
};

function getCatalogProfile(businessType) {
  const key = String(businessType || 'restaurant').trim().toLowerCase();
  return CATALOG_PROFILES[key] || CATALOG_PROFILES.restaurant;
}

function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizedKey(value) {
  return cleanText(value, 200)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function moneyValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : 0;
  let raw = String(value ?? '').replace(/[^0-9,.-]/g, '').trim();
  if (!raw) return 0;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma > lastDot) raw = raw.replace(/\./g, '').replace(',', '.');
  else raw = raw.replace(/,/g, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : 0;
}

function normalizeVariant(raw) {
  if (typeof raw === 'string') raw = { name: raw };
  const name = cleanText(raw?.name ?? raw?.variantName ?? raw?.label, 120);
  if (!name) return null;
  return { name, price: moneyValue(raw?.price) };
}

function inferVariantFromProductName(name) {
  const text = cleanText(name, 160);
  const parenthesized = text.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenthesized) return { baseName: parenthesized[1].trim(), variantName: parenthesized[2].trim() };
  const suffix = text.match(/^(.+?)\s*(?:[-:]\s*)?(chica|mediana|grande|jumbo|familiar|personal|individual|doble|triple|\d+(?:[.,]\d+)?\s*(?:ml|l|litros?|g|kg|pzas?|piezas?))$/i);
  if (suffix) return { baseName: suffix[1].trim(), variantName: suffix[2].trim() };
  return { baseName: text, variantName: '' };
}

function normalizeModifierOption(raw) {
  if (typeof raw === 'string') raw = { name: raw };
  const name = cleanText(raw?.name ?? raw?.label, 120);
  if (!name) return null;
  return {
    name,
    extraPrice: moneyValue(raw?.extraPrice ?? raw?.extra_price ?? raw?.price),
  };
}

function normalizeModifierGroup(raw) {
  const name = cleanText(raw?.name ?? raw?.groupName, 120);
  const rawOptions = Array.isArray(raw?.options) ? raw.options
    : (Array.isArray(raw?.items) ? raw.items : []);
  const options = rawOptions
    .slice(0, 30)
    .map(normalizeModifierOption)
    .filter(Boolean);
  if (!name || !options.length) return null;
  const maxRaw = Number(raw?.maxSelections ?? raw?.max_selections);
  const maxSelections = Math.max(1, Math.min(options.length, Number.isFinite(maxRaw) ? Math.floor(maxRaw) : 1));
  const minRaw = Number(raw?.minSelections ?? raw?.min_selections);
  const minSelections = Math.max(0, Math.min(maxSelections, Number.isFinite(minRaw) ? Math.floor(minRaw) : 0));
  return { name, minSelections, maxSelections, options };
}

function normalizeImageRegion(raw, fallbackImageIndex = null) {
  const region = raw?.imageRegion ?? raw?.photoRegion ?? raw?.image_region;
  if (!region || typeof region !== 'object' || Array.isArray(region)) return null;
  const rawCoordinates = [
    Number(region.x ?? region.left),
    Number(region.y ?? region.top),
    Number(region.width ?? region.w),
    Number(region.height ?? region.h),
  ];
  if (rawCoordinates.some((value) => !Number.isFinite(value))) return null;
  const usesUnitScale = rawCoordinates.every((value) => value >= 0 && value <= 1)
    && rawCoordinates[2] > 0 && rawCoordinates[3] > 0;
  const [x, y, width, height] = usesUnitScale
    ? rawCoordinates.map((value) => value * 100)
    : rawCoordinates;
  const safeX = Math.max(0, Math.min(99, x));
  const safeY = Math.max(0, Math.min(99, y));
  const safeWidth = Math.max(0, Math.min(100 - safeX, width));
  const safeHeight = Math.max(0, Math.min(100 - safeY, height));
  if (safeWidth < 5 || safeHeight < 5) return null;
  const imageIndexRaw = region.imageIndex ?? region.image_index ?? fallbackImageIndex;
  const imageIndex = Number.isInteger(Number(imageIndexRaw)) ? Math.max(0, Number(imageIndexRaw)) : null;
  if (imageIndex === null) return null;
  const confidenceRaw = Number(region.confidence);
  return {
    imageIndex,
    x: Number(safeX.toFixed(2)),
    y: Number(safeY.toFixed(2)),
    width: Number(safeWidth.toFixed(2)),
    height: Number(safeHeight.toFixed(2)),
    confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.7,
  };
}

function directChoiceGroups(raw) {
  const definitions = [
    { keys: ['flavors', 'sabores'], name: 'Elige tu sabor', required: true },
    { keys: ['sauces', 'salsas'], name: 'Elige tu salsa', required: true },
    { keys: ['ingredientOptions', 'optionalIngredients', 'ingredientesOpcionales'], name: 'Ingredientes / opciones', required: false },
    { keys: ['choices', 'selectableOptions'], name: 'Opciones', required: false },
  ];
  const groups = [];
  for (const definition of definitions) {
    const values = definition.keys.map((key) => raw?.[key]).find(Array.isArray);
    if (!values?.length) continue;
    groups.push({
      name: definition.name,
      minSelections: definition.required ? 1 : 0,
      maxSelections: 1,
      options: values,
    });
  }
  return groups;
}

const GENERIC_CATEGORY_KEYS = new Set([
  '', 'general', 'otros', 'productos', 'menu', 'catalogo', 'comida', 'comida rapida', 'platillos', 'alimentos',
  'other', 'products', 'menu items', 'catalog', 'food', 'fast food', 'dishes',
]);

function isGenericCategory(value) {
  return GENERIC_CATEGORY_KEYS.has(normalizedKey(value));
}

function inferRestaurantCategory(raw) {
  const name = normalizedKey(raw?.name);
  const section = normalizedKey(raw?.sourceSection ?? raw?.menuSection ?? raw?.section ?? raw?.heading);
  const context = `${name} ${section}`.trim();
  if (!context) return '';

  // El nombre del producto tiene prioridad para que un combo con pollo o alitas
  // no termine dentro de esas categorías por los componentes de su descripción.
  if (/\b(combo|mix)\b/.test(name)) return 'Combos';
  if (/\b(alita|alitas|boneless|wing|wings)\b/.test(context)) return 'Alitas';
  if (/\b(hamburguesa|hamburguesas|burger|burgers)\b/.test(context)) return 'Hamburguesas';
  if (/\b(papas y pollo|pollo y papas|orden de pollo|pollo jumbo|pollo sabor|chicken bake|kendaddy)\b/.test(context)) return 'Pollo y papas';
  if (/\b(costilla|costillas)\b/.test(context)) return 'Costillas';
  if (/\b(ensalada|ensaladas)\b/.test(context)) return 'Ensaladas';
  if (/\b(shrimp|camaron|camarones)\b/.test(context)) return 'Mariscos';
  if (/\b(pizza|pizzas)\b/.test(context)) return 'Pizzas';
  if (/\b(taco|tacos)\b/.test(context)) return 'Tacos';
  if (/\b(burrito|burritos)\b/.test(context)) return 'Burritos';
  if (/\b(hot dog|hot dogs|dogos)\b/.test(context)) return 'Hot dogs';
  if (/\b(sushi|rollo|rollos)\b/.test(context)) return 'Sushi';
  if (/\b(pasta|pastas|espagueti)\b/.test(context)) return 'Pastas';
  if (/\b(postre|postres|pastel|pasteles)\b/.test(context)) return 'Postres';
  if (/\b(bebida|bebidas|refresco|refrescos|jugo|jugos|agua|aguas|cafe|cafes)\b/.test(context)) return 'Bebidas';
  if (/\b(desayuno|desayunos)\b/.test(context)) return 'Desayunos';
  if (/\b(extras?|adicionales?|aros? de cebolla|dedos? de queso|guacamole|aderezo)\b/.test(context)) return 'Extras';
  if (/\b(papa|papas|fries)\b/.test(context)) return 'Papas';
  if (/\b(pollo|chicken)\b/.test(context)) return 'Pollo y papas';
  return '';
}

function resolveAiCategory(raw, { inferCategories = false } = {}) {
  const categoryName = cleanText(raw?.categoryName ?? raw?.category, 120);
  if (!inferCategories || !isGenericCategory(categoryName)) return categoryName;
  return inferRestaurantCategory(raw) || categoryName;
}

function mergeUniqueByName(target, incoming, merge) {
  for (const item of incoming) {
    const key = normalizedKey(item.name);
    const found = target.find((candidate) => normalizedKey(candidate.name) === key);
    if (found && merge) merge(found, item);
    else if (!found) target.push(item);
  }
  return target;
}

function normalizeAiCatalogProducts(inputProducts = [], options = {}) {
  const rows = (Array.isArray(inputProducts) ? inputProducts : []).slice(0, 200);
  const products = [];
  const inferredVariantCounts = new Map();
  for (const raw of rows) {
    if (cleanText(raw?.variantGroup, 160) || cleanText(raw?.variantName, 120)
        || (Array.isArray(raw?.variants) && raw.variants.length)
        || (Array.isArray(raw?.presentations) && raw.presentations.length)) continue;
    const inferred = inferVariantFromProductName(raw?.name);
    if (!inferred.variantName) continue;
    const key = `${normalizedKey(resolveAiCategory(raw, options))}::${normalizedKey(inferred.baseName)}`;
    inferredVariantCounts.set(key, (inferredVariantCounts.get(key) || 0) + 1);
  }

  for (const raw of rows) {
    const rowName = cleanText(raw?.name, 160);
    const explicitBase = cleanText(raw?.variantGroup, 160);
    const legacyVariantName = cleanText(raw?.variantName, 120);
    const rawVariants = Array.isArray(raw?.variants) ? raw.variants
      : (Array.isArray(raw?.presentations) ? raw.presentations : (Array.isArray(raw?.sizes) ? raw.sizes : []));
    const hasNestedVariants = rawVariants.length > 0;
    const inferredCandidate = inferVariantFromProductName(rowName);
    const categoryName = resolveAiCategory(raw, options);
    const inferredKey = `${normalizedKey(categoryName)}::${normalizedKey(inferredCandidate.baseName)}`;
    const inferred = !explicitBase && !legacyVariantName && !hasNestedVariants
      && (inferredVariantCounts.get(inferredKey) || 0) > 1
      ? inferredCandidate
      : { baseName: rowName, variantName: '' };
    const name = explicitBase || inferred.baseName || rowName;
    if (!name) continue;

    const variants = rawVariants
      .slice(0, 30)
      .map(normalizeVariant)
      .filter(Boolean);
    if (legacyVariantName) variants.push({ name: legacyVariantName, price: moneyValue(raw?.price) });
    else if (inferred.variantName) variants.push({ name: inferred.variantName, price: moneyValue(raw?.price) });

    const rawModifierGroups = Array.isArray(raw?.modifierGroups) ? raw.modifierGroups
      : (Array.isArray(raw?.optionGroups) ? raw.optionGroups
        : (Array.isArray(raw?.ingredientGroups) ? raw.ingredientGroups
          : (Array.isArray(raw?.modifiers) ? raw.modifiers : [])));
    const normalizedModifierGroups = [...rawModifierGroups, ...directChoiceGroups(raw)]
      .slice(0, 15)
      .map(normalizeModifierGroup)
      .filter(Boolean);
    const modifierGroups = [];
    mergeUniqueByName(modifierGroups, normalizedModifierGroups, (group, addition) => {
      mergeUniqueByName(group.options, addition.options);
      group.minSelections = Math.max(group.minSelections, addition.minSelections);
      group.maxSelections = Math.max(group.maxSelections, addition.maxSelections);
    });

    const product = {
      name,
      description: cleanText(raw?.description, 1000),
      price: moneyValue(raw?.price),
      categoryName,
      variants: [],
      modifierGroups,
      warnings: (Array.isArray(raw?.warnings) ? raw.warnings : []).map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 10),
      confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
      imageIndex: raw?.imageIndex !== null && raw?.imageIndex !== undefined && raw?.imageIndex !== ''
        && Number.isInteger(Number(raw.imageIndex)) ? Number(raw.imageIndex) : null,
      imageRegion: normalizeImageRegion(raw, raw?.imageIndex),
    };
    mergeUniqueByName(product.variants, variants);
    if (product.price === 0 && (!product.variants.length || product.variants.every((variant) => variant.price === 0))) {
      product.warnings.push('Revisa el precio: no se pudo leer un importe mayor a cero.');
    }
    if (product.variants.some((variant) => variant.price === 0)) {
      product.warnings.push('Una o más variantes no tienen un precio legible.');
    }
    if (product.confidence > 0 && product.confidence < 0.7) {
      product.warnings.push('Lectura con baja confianza; revisa este producto antes de importarlo.');
    }
    product.warnings = [...new Set(product.warnings)];

    // Las respuestas anteriores enviaban una fila por variante. Las consolidamos
    // para evitar crear productos duplicados al importar una respuesta antigua.
    const existing = products.find((candidate) => normalizedKey(candidate.name) === normalizedKey(name)
      && normalizedKey(candidate.categoryName) === normalizedKey(product.categoryName));
    if (existing) {
      if (product.description.length > existing.description.length) existing.description = product.description;
      if (!existing.price || (product.price && product.price < existing.price)) existing.price = product.price;
      mergeUniqueByName(existing.variants, product.variants);
      mergeUniqueByName(existing.modifierGroups, product.modifierGroups, (group, addition) => {
        mergeUniqueByName(group.options, addition.options);
        group.minSelections = Math.max(group.minSelections, addition.minSelections);
        group.maxSelections = Math.max(group.maxSelections, addition.maxSelections);
      });
      existing.warnings = [...new Set([...existing.warnings, ...product.warnings])];
      if (!existing.imageRegion || Number(product.imageRegion?.confidence || 0) > Number(existing.imageRegion?.confidence || 0)) {
        existing.imageRegion = product.imageRegion;
      }
    } else {
      products.push(product);
    }
  }

  return products.slice(0, 60);
}

function buildAiCatalogPrompt(businessType, categoryNames = []) {
  const profile = getCatalogProfile(businessType);
  return [
    `Analiza todas las imágenes como páginas de un mismo ${profile.document} y devuelve SOLO JSON válido.`,
    '- El giro configurado es una referencia, no una restricción: si el contenido visible pertenece claramente a otro giro (por ejemplo, un menú de comida), prioriza siempre el documento real y adapta productos, categorías y opciones a lo que muestra.',
    `Genera cada ${profile.item} listo para cargar en el sistema POS/chatbot, siguiendo exactamente la estructura del alta manual.`,
    'Formato JSON requerido:',
    '{"products":[{"name":"string","description":"string","price":123.45,"categoryName":"string","sourceSection":"encabezado visible del bloque","imageIndex":0,"imageRegion":{"imageIndex":0,"x":10,"y":20,"width":30,"height":25,"confidence":0.9},"variants":[{"name":"string","price":123.45}],"modifierGroups":[{"name":"string","minSelections":0,"maxSelections":1,"options":[{"name":"string","extraPrice":0}]}],"confidence":0.95,"warnings":["string"]}],"notes":["string"]}',
    'Reglas de lectura:',
    '- Antes de generar el JSON, haz una auditoría visual silenciosa de cada columna y bloque: título, renglones pequeños debajo o al costado, precios, separadores y siguiente encabezado. No omitas texto pequeño legible.',
    '- Respeta el alcance espacial: un título abre un bloque y los renglones alineados debajo pertenecen a ese producto hasta encontrar otro título, separador claro o cambio de columna.',
    `- Incluye sólo cada ${profile.item}; omite encabezados, teléfonos, subtotales y texto decorativo.`,
    '- Respeta nombres y precios impresos. price y extraPrice son números sin símbolo de moneda; si no son legibles usa 0 y agrega una advertencia.',
    `- categoryName debe ser breve (ej. ${profile.categoryExamples}) y representar la familia real del producto. Usa sourceSection para copiar el encabezado visible del bloque y normalízalo como categoría.`,
    '- No uses una sola categoría genérica para todo el documento. “General”, “Menú”, “Productos”, “Platillos” o “Comida rápida” no sustituyen las secciones específicas visibles.',
    '- Puedes proponer categorías nuevas aunque no existan todavía; reutiliza una categoría existente sólo cuando sea semánticamente equivalente, nunca sólo porque ya existe.',
    '- En un menú como este, clasifica Alitas/Boneless en “Alitas”; Hamburguesa y papas en “Hamburguesas”; Papas y pollo, Orden de pollo, Pollo jumbo o Chicken Bake en “Pollo y papas”; Combo/Mix en “Combos”; Extras en “Extras”; y conserva secciones claras como Ensaladas o Costillas.',
    `- ${profile.descriptionRule}`,
    '- No inventes ingredientes, tamaños, precios, opciones ni descripciones que no sean visibles.',
    '- Crea UN solo producto base y coloca dentro de variants sus tamaños, cantidades, presentaciones o planes con precio diferente. No repitas el producto por cada variante.',
    '- Usa modifierGroups para elecciones que el cliente puede personalizar: ingredientes, sabores, salsas, términos o guarniciones. Una lista de alternativas sin precio colocada inmediatamente debajo o junto al producto también es un grupo seleccionable aunque no diga “elige”.',
    '- Ejemplo obligatorio: si “Alitas” muestra 8 pza $169, 12 pza $199 y 17 pza $229, crea esas tres variantes; si debajo aparecen “Piña habanero, BBQ, Picositas, Ajo parmesano, Pimienta limón, Mango habanero, Tamarindo”, crea además en Alitas un grupo “Elige tu salsa” con esas siete opciones y extraPrice 0.',
    '- Distingue opciones de descripción: una frase narrativa con “incluye”, “con” o componentes unidos por “+” suele ser contenido fijo y va en description; una lista vertical de sabores/salsas/tipos alternativos es modifierGroups. No conviertas la lista descriptiva de ingredientes incluidos en opciones.',
    '- Una sección independiente “Extras” o “Adicionales” con precio propio por renglón son productos adicionales, salvo que el menú los vincule claramente a un producto. No la conviertas en un grupo global ni mezcles su precio con las salsas gratuitas.',
    '- Para cada grupo define minSelections/maxSelections respetando las reglas explícitas de cantidad. Si una lista de sabores o salsas implica escoger una para poder pedir el producto y no muestra otra cantidad, usa minSelections=1 y maxSelections=1. Para opciones realmente opcionales usa 0 y 1.',
    '- En combos, conserva en description los componentes fijos. Sólo crea opciones para componentes que realmente se puedan elegir.',
    '- Si el precio base no aparece pero sí hay variantes, usa como price el menor precio de sus variantes.',
    '- confidence va de 0 a 1; agrega warnings cuando el texto, relación o precio sea dudoso.',
    '- Antes de responder, verifica para cada producto que ninguna lista cercana de sabores, salsas, tamaños o presentaciones haya quedado sin asignar. Usa imageIndex basado en cero para indicar la página de origen.',
    '- Si un texto pequeño es legible pero no puedes asociarlo con seguridad, no lo descartes: cópialo en notes con la página y el bloque visual para que el tenant pueda revisarlo.',
    '- Para imageRegion usa coordenadas porcentuales 0-100 sobre la vista completa original: x/y esquina superior izquierda y width/height del recorte. Devuélvelo sólo cuando exista una fotografía claramente asociada a ese producto, con confidence >= 0.65.',
    '- El recorte imageRegion debe rodear únicamente la comida o producto: evita precios, textos, logotipos, teléfonos y adornos. Si una foto representa varios productos o no hay relación clara, usa imageRegion:null; nunca asignes por cercanía dudosa.',
    '- Máximo 60 productos, 30 variantes por producto, 15 grupos y 30 opciones por grupo.',
    `Categorías existentes del tenant: ${categoryNames.join(', ') || 'Ninguna'}`,
  ].join('\n');
}

module.exports = {
  buildAiCatalogPrompt,
  getCatalogProfile,
  moneyValue,
  normalizeAiCatalogProducts,
};
