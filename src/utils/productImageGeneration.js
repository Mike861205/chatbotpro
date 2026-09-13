const STYLE_PROMPTS = {
  clean: 'fotografía comercial limpia, fondo neutro cálido, iluminación suave de estudio, encuadre apetitoso y realista',
  dark: 'fotografía comercial estilo restaurante, fondo oscuro elegante, luz lateral cálida, alto contraste moderado y apariencia realista',
  rustic: 'fotografía comercial artesanal, mesa de madera discreta, luz natural cálida, presentación abundante y apariencia realista',
  bright: 'fotografía comercial luminosa, fondo claro, colores naturales, iluminación uniforme y apariencia fresca y realista',
};

function cleanPromptText(value, maxLength = 600) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeImageStyle(value) {
  const style = cleanPromptText(value, 30).toLowerCase();
  return STYLE_PROMPTS[style] ? style : 'clean';
}

function buildProductImagePrompt(product = {}, options = {}) {
  const name = cleanPromptText(product.name, 160);
  const description = cleanPromptText(product.description, 700);
  const category = cleanPromptText(product.categoryName || product.category, 120);
  const customInstruction = cleanPromptText(product.imageInstruction, 300);
  const style = normalizeImageStyle(options.style);
  const businessType = cleanPromptText(options.businessType, 60).toLowerCase();
  const isRestaurant = businessType === 'restaurant'
    || /alitas|pollo|papas|hamburgues|combo|pizza|taco|comida|bebida|postre|boneless/i.test(`${name} ${description} ${category}`);
  const subject = isRestaurant ? 'platillo' : 'producto o servicio';

  return [
    `Crea una imagen cuadrada para el catálogo de un negocio. ${STYLE_PROMPTS[style]}.`,
    `El ${subject} principal es: “${name || 'producto'}”.`,
    category ? `Categoría: “${category}”.` : '',
    description ? `Componentes fijos visibles que sí deben respetarse: “${description}”.` : 'No se proporcionaron componentes adicionales; representa únicamente el producto nombrado.',
    customInstruction ? `Indicación visual aprobada por el tenant: “${customInstruction}”.` : '',
    'Muestra solamente elementos indicados por el nombre y la descripción. No inventes ingredientes, guarniciones, cantidades, marcas ni empaques.',
    'Si la descripción indica que incluye papas, bebida u otra guarnición fija, debe aparecer. Si hay sabores, salsas o ingredientes configurables, no intentes mostrar todas las alternativas; usa una presentación neutra y coherente.',
    'Las variantes son tamaños o cantidades del mismo producto y compartirán esta fotografía; no dibujes varias versiones ni números de piezas.',
    'Sin palabras, letras, precios, promociones, logotipos, marcas de agua, menús, personas, manos ni texto decorativo.',
    'Composición centrada, producto completo dentro del encuadre, lista para una tarjeta de comercio electrónico, aspecto fotográfico natural y no ilustración.',
  ].filter(Boolean).join(' ');
}

module.exports = { buildProductImagePrompt, normalizeImageStyle };
