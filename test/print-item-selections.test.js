const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const helperSource = app.slice(
  app.indexOf('function printableItemSelection(item)'),
  app.indexOf('function operationalOrderNote(order)')
);
const helperContext = {};
vm.runInNewContext(`${helperSource}\nthis.printableItemSelection = printableItemSelection;`, helperContext);
const { printableItemSelection } = helperContext;

test('tickets y comandas conservan variantes e ingredientes seleccionados', () => {
  assert.match(app, /function printableItemSelection\(item\)/);
  assert.match(app, /item\?\.variantName \|\| item\?\.variant_name/);
  assert.match(app, /item\?\.modifiersLabel \|\| item\?\.modifiers_label/);
  assert.match(app, /Ingredientes\/opciones:<\/span>/);
  assert.match(app, /Variante:<\/span>/);
});

test('la comanda no descarta los datos adicionales de cada partida', () => {
  assert.match(app, /function buildOrderComandaItems\(order\)[\s\S]+return rows\.map\(\(item\) => \(\{[\s\S]+\.\.\.item/);
  assert.match(app, /const items = areaItems\.map\(\(it\) => \(\{ \.\.\.it,/);
});

test('tickets normales, rondas y reimpresiones usan el mismo formato de opciones', () => {
  assert.match(app, /const ticketItemRow = \(it\) =>/);
  assert.match(app, /\(ticket\.items \|\| \[\]\)\.map\(ticketItemRow\)/);
  assert.match(app, /\(round\.items \|\| \[\]\)\.map\(ticketItemRow\)/);
});

test('formatea correctamente productos con ingredientes, variantes o ambos', () => {
  assert.deepEqual(
    { ...printableItemSelection({
      name: '500 Gr Boneless (14 a 16 pzas)',
      modifiersLabel: 'Salsa de soya extra',
      modifiers: [{ groupName: 'Salsas', options: [{ name: 'Salsa de soya extra' }] }],
    }) },
    { name: '500 Gr Boneless (14 a 16 pzas)', variant: '', modifiers: 'Salsas: Salsa de soya extra' }
  );

  assert.deepEqual(
    { ...printableItemSelection({
      name: 'Hamburguesa · Doble · Sin cebolla',
      variantName: 'Doble',
      modifiersLabel: 'Sin cebolla',
    }) },
    { name: 'Hamburguesa', variant: 'Doble', modifiers: 'Sin cebolla' }
  );

  assert.deepEqual(
    { ...printableItemSelection({ name: 'Refresco · Grande', variantName: 'Grande' }) },
    { name: 'Refresco', variant: 'Grande', modifiers: '' }
  );
});
