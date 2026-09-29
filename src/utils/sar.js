const TAX_CATEGORIES = new Set(['exempt', 'tax15', 'tax18']);

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function sarNumber(establishment, emissionPoint, documentType, sequential) {
  return `${establishment}-${emissionPoint}-${documentType}-${String(sequential).padStart(8, '0')}`;
}

function validRtn(value) {
  return /^\d{14}$/.test(String(value || '').trim());
}

function validCai(value) {
  return /^[A-Z0-9]{6}(?:-[A-Z0-9]{6}){4}-[A-Z0-9]{2}$/.test(String(value || '').trim().toUpperCase());
}

function parseDocumentNumber(value) {
  const match = /^(\d{3})-(\d{3})-(\d{2})-(\d{8})$/.exec(String(value || '').trim());
  if (!match) return null;
  return { establishment: match[1], emissionPoint: match[2], documentType: match[3], sequential: Number(match[4]) };
}

function calculateSarTotals(items, deliveryFee = 0, deliveryCategory = '', deliveryExonerated = false) {
  const lines = [];
  const totals = { exempt: 0, exonerated15: 0, exonerated18: 0, taxable15: 0, isv15: 0, taxable18: 0, isv18: 0, total: 0 };
  for (const item of items) {
    const category = String(item.sarTaxCategory || item.sar_tax_category || '');
    if (!TAX_CATEGORIES.has(category)) throw Object.assign(new Error(`Clasifica el ISV del producto ${item.name || item.id || ''} antes de facturar`), { statusCode: 409 });
    const quantity = Number(item.qty ?? item.quantity);
    const unitPrice = Number(item.price);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) {
      throw Object.assign(new Error('La venta contiene partidas inválidas para facturación SAR'), { statusCode: 409 });
    }
    const gross = money(quantity * unitPrice);
    const rate = category === 'tax15' ? 0.15 : category === 'tax18' ? 0.18 : 0;
    const exonerated = Boolean(item.sarExonerated) && rate > 0;
    const base = exonerated ? gross : rate ? money(gross / (1 + rate)) : gross;
    const tax = exonerated ? 0 : money(gross - base);
    lines.push({ productId: Number(item.id || item.productId || 0), name: String(item.name || 'Producto').slice(0, 200), quantity, unitPrice: Number(unitPrice.toFixed(6)), category, exonerated, base, tax, gross });
    if (category === 'exempt') totals.exempt = money(totals.exempt + gross);
    if (category === 'tax15') { if (exonerated) totals.exonerated15 = money(totals.exonerated15 + base); else { totals.taxable15 = money(totals.taxable15 + base); totals.isv15 = money(totals.isv15 + tax); } }
    if (category === 'tax18') { if (exonerated) totals.exonerated18 = money(totals.exonerated18 + base); else { totals.taxable18 = money(totals.taxable18 + base); totals.isv18 = money(totals.isv18 + tax); } }
    totals.total = money(totals.total + gross);
  }
  if (Number(deliveryFee) > 0) {
    if (!TAX_CATEGORIES.has(deliveryCategory)) throw Object.assign(new Error('Configura el tratamiento ISV del envío antes de facturar'), { statusCode: 409 });
    const extra = calculateSarTotals([{ name: 'Servicio de entrega', qty: 1, price: deliveryFee, sarTaxCategory: deliveryCategory, sarExonerated: deliveryExonerated }]);
    lines.push(...extra.lines);
    for (const key of Object.keys(totals)) totals[key] = money(totals[key] + extra.totals[key]);
  }
  return { lines, totals };
}

function exonerateSarItems(items, deliveryFee, deliveryCategory) {
  const adjusted = items.map((item) => {
    const category = item.sarTaxCategory || item.sar_tax_category;
    if (!TAX_CATEGORIES.has(category)) throw Object.assign(new Error('Clasifica el ISV de todos los productos antes de aplicar una exoneración'), { statusCode: 409 });
    if (item.taxEnabled) throw Object.assign(new Error('Desactiva el impuesto genérico antes de aplicar una exoneración SAR'), { statusCode: 409 });
    const rate = category === 'tax15' ? 0.15 : category === 'tax18' ? 0.18 : 0;
    if (!rate) return item;
    const originalGross = money(Number(item.price) * Number(item.qty));
    const netGross = money(originalGross / (1 + rate));
    return { ...item, price: netGross / Number(item.qty), sarExonerated: true, sarOriginalGross: originalGross, sarNetGross: netGross };
  });
  if (deliveryFee > 0 && !TAX_CATEGORIES.has(deliveryCategory)) throw Object.assign(new Error('Clasifica el ISV del envío antes de aplicar una exoneración'), { statusCode: 409 });
  const rate = deliveryCategory === 'tax15' ? 0.15 : deliveryCategory === 'tax18' ? 0.18 : 0;
  return { items: adjusted, deliveryFee: rate ? money(deliveryFee / (1 + rate)) : money(deliveryFee), deliveryExonerated: rate > 0 };
}

function calculateSarCredit(originalLines, previousCredits, requestedQuantities) {
  if (!Array.isArray(originalLines) || !originalLines.length || !Array.isArray(requestedQuantities) || requestedQuantities.length !== originalLines.length) {
    throw Object.assign(new Error('Selecciona las cantidades por partida de la factura original'), { statusCode: 400 });
  }
  const creditedLine = (credit, index) => (credit?.lines || []).find((line) => Number(line.originalLineIndex) === index);
  const used = originalLines.map((_, index) => money(previousCredits.reduce((sum, credit) => sum + Number(creditedLine(credit,index)?.quantity || 0), 0)));
  const totals = { exempt:0, exonerated15:0, exonerated18:0, taxable15:0, isv15:0, taxable18:0, isv18:0, total:0 };
  const lines = [];
  for (let index = 0; index < originalLines.length; index++) {
    const source = originalLines[index];
    const quantity = Number(requestedQuantities[index]);
    const originalQuantity = Number(source.quantity);
    if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(originalQuantity) || quantity > originalQuantity - used[index] + 0.000001) {
      throw Object.assign(new Error(`La cantidad de la partida ${index + 1} supera lo pendiente por acreditar`), { statusCode: 409 });
    }
    if (!quantity) continue;
    const fraction = quantity / originalQuantity;
    const remainingGross = money(Number(source.gross) - previousCredits.reduce((sum, credit) => sum + Number(creditedLine(credit,index)?.gross || 0), 0));
    const gross = money(quantity >= originalQuantity - used[index] - 0.000001 ? remainingGross : Number(source.gross) * fraction);
    const base = money(source.tax ? gross / (1 + (source.category === 'tax18' ? .18 : .15)) : gross);
    const tax = money(gross - base);
    const line = { ...source, quantity, gross, base, tax, unitPrice: Number((gross / quantity).toFixed(6)) };
    lines.push({ ...line, originalLineIndex: index });
    const field = source.category === 'exempt' ? 'exempt' : source.exonerated ? (source.category === 'tax18' ? 'exonerated18' : 'exonerated15') : (source.category === 'tax18' ? 'taxable18' : 'taxable15');
    totals[field] = money(totals[field] + base);
    if (tax) totals[source.category === 'tax18' ? 'isv18' : 'isv15'] = money(totals[source.category === 'tax18' ? 'isv18' : 'isv15'] + tax);
    totals.total = money(totals.total + gross);
  }
  if (!lines.length) throw Object.assign(new Error('Indica al menos una cantidad para acreditar'), { statusCode: 400 });
  return { lines, totals };
}

module.exports = { TAX_CATEGORIES, money, sarNumber, validRtn, validCai, parseDocumentNumber, calculateSarTotals, exonerateSarItems, calculateSarCredit };
