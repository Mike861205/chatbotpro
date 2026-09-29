const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSarTotals, exonerateSarItems, calculateSarCredit, sarNumber, parseDocumentNumber, validCai, validRtn } = require('../src/utils/sar');

test('Honduras: número de factura y datos SAR-927 conservan su formato', () => {
  assert.equal(sarNumber('000','002','01',170701), '000-002-01-00170701');
  assert.deepEqual(parseDocumentNumber('000-002-01-00170701'), { establishment:'000', emissionPoint:'002', documentType:'01', sequential:170701 });
  assert.equal(validCai('55B9A8-92841E-EF5CED-63BE03-090924-B7'), true);
  assert.equal(validRtn('13061993003501'), true);
  assert.equal(validRtn('1306199300350'), false);
});

test('Honduras: separa ISV incluido por línea y conserva el total cobrado', () => {
  const result = calculateSarTotals([
    { name:'Gravado 15', qty:1, price:250, sarTaxCategory:'tax15' },
    { name:'Gravado 18', qty:2, price:59, sarTaxCategory:'tax18' },
    { name:'Exento', qty:1, price:20, sarTaxCategory:'exempt' },
  ], 15, 'tax15');
  assert.deepEqual(result.totals, { exempt:20, exonerated15:0, exonerated18:0, taxable15:230.43, isv15:34.57, taxable18:100, isv18:18, total:403 });
  assert.equal(result.lines.length, 4);
});

test('Honduras: exoneración se calcula antes del cobro y no confunde exento con exonerado', () => {
  const original = [
    { id:1, name:'Producto 15', qty:2, price:115, sarTaxCategory:'tax15' },
    { id:2, name:'Producto 18', qty:1, price:118, sarTaxCategory:'tax18' },
    { id:3, name:'Producto exento', qty:1, price:20, sarTaxCategory:'exempt' },
  ];
  const adjusted = exonerateSarItems(original,0,'');
  const result = calculateSarTotals(adjusted.items);
  assert.equal(result.totals.total,320);
  assert.equal(result.totals.exonerated15,200);
  assert.equal(result.totals.exonerated18,100);
  assert.equal(result.totals.exempt,20);
  assert.equal(result.totals.isv15 + result.totals.isv18,0);
  assert.equal(original[0].price,115);
});

test('Honduras: nota de crédito parcial respeta lo ya acreditado y conserva remanente', () => {
  const invoice = calculateSarTotals([{id:1,name:'Producto',qty:3,price:115,sarTaxCategory:'tax15'}]);
  const first = calculateSarCredit(invoice.lines,[],[1]);
  const second = calculateSarCredit(invoice.lines,[first],[2]);
  assert.equal(first.totals.total+second.totals.total,invoice.totals.total);
  assert.throws(()=>calculateSarCredit(invoice.lines,[first],[3]),/supera lo pendiente/);
  assert.throws(()=>calculateSarCredit(invoice.lines,[first,second],[1]),/supera lo pendiente/);
});

test('Honduras: nota de crédito sobre venta exonerada revierte base sin crear ISV', () => {
  const adjusted=exonerateSarItems([{id:9,name:'Producto',qty:2,price:115,sarTaxCategory:'tax15'}],0,'');
  const invoice=calculateSarTotals(adjusted.items);
  const note=calculateSarCredit(invoice.lines,[],[1]);
  assert.equal(note.totals.exonerated15,100);
  assert.equal(note.totals.isv15,0);
  assert.equal(note.totals.total,100);
});

test('Honduras: una partida sin tratamiento ISV bloquea la emisión', () => {
  assert.throws(() => calculateSarTotals([{ name:'Sin clasificar', qty:1, price:10 }]), /Clasifica el ISV/);
});
