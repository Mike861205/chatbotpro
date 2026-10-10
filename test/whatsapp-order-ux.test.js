const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../src/routes/whatsapp');

const rowsOf = (message) => message.interactive.action.sections.flatMap((section) => section.rows);

test('los comandos del motor viajan sin perder guiones bajos ni la letra s', () => {
  for (const command of ['order_note_no', 'order_note_yes', 'more_products', 'checkout', 'prods_page_2', 'receiving_mode_recoger']) {
    const id = route.whatsappInteractiveMessages({
      options: [{ label: 'x', value: command }],
    })[0].buttons[0].payload;
    assert.match(id, /^[A-Za-z0-9]+$/);
    assert.equal(route.whatsappEngineInput(id), command);
  }
});

test('la nota del pedido ofrece "Agregar nota" y "Sin nota" con el cuerpo de la pregunta', () => {
  const reply = {
    messages: ['¿Deseas agregar una nota a tu pedido?'],
    options: [
      { label: '✏️ Sí, agregar nota', value: 'order_note_yes' },
      { label: '❌ No, continuar', value: 'order_note_no' },
    ],
  };
  const plan = route.whatsappReplyPlan(reply);
  assert.deepEqual(plan.texts, []);
  assert.equal(plan.interactives.length, 1);
  assert.equal(plan.interactives[0].bodyText, '¿Deseas agregar una nota a tu pedido?');
  const titles = plan.interactives[0].buttons.map((button) => button.title);
  assert.deepEqual(titles, ['👉 ✏️ Agregar nota', '👉 Sin nota']);
  assert.equal(route.whatsappEngineInput(plan.interactives[0].buttons[1].payload), 'order_note_no');
});

test('las categorías llegan en una sola lista que explica que se pueden pedir varios productos', () => {
  const options = ['ALITAS', 'BEBIDAS', 'CHICKENBAKE', 'COSTILLA', 'PAPAS CON POLLO'].map((name, index) => ({ label: name, value: `cat_${index + 1}` }));
  const plan = route.whatsappReplyPlan({ messages: ['¿Qué categoría te gustaría ver? 😋'], options });
  assert.equal(plan.interactives.length, 1);
  const [list] = plan.interactives;
  assert.equal(list.kind, 'list');
  assert.equal(list.interactive.action.button, 'Ver categorías');
  assert.match(list.bodyText, /¿Qué categoría te gustaría ver\?/);
  assert.match(list.bodyText, /varios productos/);
  assert.equal(rowsOf(list).length, 5);
  assert.equal(route.whatsappEngineInput(rowsOf(list)[4].id), 'cat_5');
});

test('los productos de una categoría salen en una sola lista explicativa', () => {
  const products = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, name: `Producto ${index + 1}`, priceLabel: '$10.00' }));
  products[1].qty = 2;
  const plan = route.whatsappReplyPlan({
    messages: ['Elige un producto para agregarlo a tu pedido:'],
    categoryName: 'PAPAS CON POLLO',
    products,
    options: [{ label: '⬅️ Volver', value: 'back' }],
  });
  const lists = plan.interactives.filter((message) => message.kind === 'list');
  assert.equal(lists.length, 1);
  assert.match(lists[0].bodyText, /PAPAS CON POLLO/);
  assert.match(lists[0].bodyText, /varios productos/);
  assert.doesNotMatch(lists[0].bodyText, /1\/2|2\/2/);
  assert.equal(rowsOf(lists[0]).length, 5);
  assert.match(rowsOf(lists[0])[1].description, /Llevas 2/);
  assert.equal(plan.interactives.at(-1).kind, 'buttons');
  assert.ok(plan.interactives.every((message) => !/Ver productos \d/.test(message.interactive?.action?.button || '')));
});

test('un catálogo largo se pagina dentro de la misma lista con Ver más productos', () => {
  const products = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: `Producto ${index + 1}`, priceLabel: '$10.00' }));
  const first = route.whatsappReplyPlan({ messages: [], categoryName: 'ALITAS', products }).interactives[0];
  const firstRows = rowsOf(first);
  assert.ok(firstRows.length <= 10);
  assert.equal(route.whatsappEngineInput(firstRows.at(-1).id), 'prods_page_2');
  assert.match(first.bodyText, /Mostrando 1-8 de 12/);

  const second = route.whatsappReplyPlan({ messages: [], categoryName: 'ALITAS', products, productPage: 2 }).interactives[0];
  const secondRows = rowsOf(second);
  assert.equal(route.whatsappEngineInput(secondRows[0].id), 'prods_page_1');
  assert.equal(secondRows.length, 5);
  assert.match(second.bodyText, /Mostrando 9-12 de 12/);
});

test('las sucursales largas usan una lista con el nombre completo', () => {
  const options = ['Sucursal Guadalajara Centro', 'Sucursal Lomas del Sol'].map((name, index) => ({ label: `🏪 ${name}`, value: `branch_${index + 1}` }));
  const plan = route.whatsappReplyPlan({ messages: ['¿En qué sucursal?'], options });
  assert.equal(plan.interactives.length, 1);
  assert.equal(plan.interactives[0].interactive.action.button, 'Ver sucursales');
  assert.match(rowsOf(plan.interactives[0])[0].description, /Guadalajara Centro/);
});
