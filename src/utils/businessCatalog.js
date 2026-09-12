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

function mergeUniqueByName(target, incoming, merge) {
  for (const item of incoming) {
    const key = normalizedKey(item.name);
    const found = target.find((candidate) => normalizedKey(candidate.name) === key);
    if (found && merge) merge(found, item);
    else if (!found) target.push(item);
  }
  return target;
}

function normalizeAiCatalogProducts(inputProducts = []) {
  const rows = (Array.isArray(inputProducts) ? inputProducts : []).slice(0, 200);
  const products = [];
  const inferredVariantCounts = new Map();
  for (const raw of rows) {
    if (cleanText(raw?.variantGroup, 160) || cleanText(raw?.variantName, 120)
        || (Array.isArray(raw?.variants) && raw.variants.length)
        || (Array.isArray(raw?.presentations) && raw.presentations.length)) continue;
    const inferred = inferVariantFromProductName(raw?.name);
    if (!inferred.variantName) continue;
    const key = `${normalizedKey(raw?.categoryName ?? raw?.category)}::${normalizedKey(inferred.baseName)}`;
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
    const inferredKey = `${normalizedKey(raw?.categoryName ?? raw?.category)}::${normalizedKey(inferredCandidate.baseName)}`;
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
    const modifierGroups = rawModifierGroups
      .slice(0, 15)
      .map(normalizeModifierGroup)
      .filter(Boolean);

    const product = {
      name,
      description: cleanText(raw?.description, 1000),
      price: moneyValue(raw?.price),
      categoryName: cleanText(raw?.categoryName ?? raw?.category, 120),
      variants: [],
      modifierGroups,
      warnings: (Array.isArray(raw?.warnings) ? raw.warnings : []).map((item) => cleanText(item, 240)).filter(Boolean).slice(0, 10),
      confidence: Math.max(0, Math.min(1, Number(raw?.confidence) || 0)),
      imageIndex: raw?.imageIndex !== null && raw?.imageIndex !== undefined && raw?.imageIndex !== ''
        && Number.isInteger(Number(raw.imageIndex)) ? Number(raw.imageIndex) : null,
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
    `Genera cada ${profile.item} listo para cargar en el sistema POS/chatbot, siguiendo exactamente la estructura del alta manual.`,
    'Formato JSON requerido:',
    '{"products":[{"name":"string","description":"string","price":123.45,"categoryName":"string","variants":[{"name":"string","price":123.45}],"modifierGroups":[{"name":"string","minSelections":0,"maxSelections":1,"options":[{"name":"string","extraPrice":0}]}],"confidence":0.95,"warnings":["string"]}],"notes":["string"]}',
    'Reglas de lectura:',
    `- Incluye sólo cada ${profile.item}; omite encabezados, teléfonos, subtotales y texto decorativo.`,
    '- Respeta nombres y precios impresos. price y extraPrice son números sin símbolo de moneda; si no son legibles usa 0 y agrega una advertencia.',
    `- categoryName debe ser breve (ej. ${profile.categoryExamples}) y reutilizar una categoría existente cuando corresponda.`,
    `- ${profile.descriptionRule}`,
    '- No inventes ingredientes, tamaños, precios, opciones ni descripciones que no sean visibles.',
    '- Crea UN solo producto base y coloca dentro de variants sus tamaños, cantidades, presentaciones o planes con precio diferente. No repitas el producto por cada variante.',
    '- Usa modifierGroups sólo para elecciones que el cliente puede personalizar (ingredientes, sabores, términos, guarniciones o extras). No conviertas la lista descriptiva de ingredientes incluidos en opciones.',
    '- Para cada grupo infiere minSelections/maxSelections sólo cuando el menú indique “elige”, “incluye”, “hasta” u otra regla clara; si no, usa 0 y 1.',
    '- En combos, conserva en description los componentes fijos. Sólo crea opciones para componentes que realmente se puedan elegir.',
    '- Si el precio base no aparece pero sí hay variantes, usa como price el menor precio de sus variantes.',
    '- confidence va de 0 a 1; agrega warnings cuando el texto, relación o precio sea dudoso.',
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
