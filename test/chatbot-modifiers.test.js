const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handleMessage, toggleModifierOptionSelection } = require('../src/chatbot/engine');

const chatHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'chat.html'), 'utf8');

function modifierState(group) {
  return {
    step: 'choosing_modifiers',
    cart: [],
    customer: {},
    currency: 'MXN',
    aiHistory: [],
    pendingProduct: {
      id: 7,
      name: 'Hamburguesa',
      price: 100,
      variants: [{ id: 3, name: 'Mediana', price: 100 }],
      groups: [group],
    },
    pendingVariantId: 3,
    pendingVariantName: 'Mediana',
    pendingVariantPrice: 100,
    pendingAddQty: 1,
    pendingModifiers: {},
    pendingModifierGroupIndex: 0,
  };
}

function fakeTenantDb(initialState) {
  let savedState = structuredClone(initialState);
  return {
    get savedState() { return savedState; },
    async get(sql, params) {
      if (sql.includes('chat_sessions')) return { state: JSON.stringify(savedState) };
      if (sql.includes('settings')) {
        if (params[0] === 'whatsapp') return { value: '526141234567' };
        return null;
      }
      throw new Error(`Consulta get inesperada: ${sql}`);
    },
    async all(sql) {
      if (sql.includes('settings')) return [];
      throw new Error(`Consulta all inesperada: ${sql}`);
    },
    async run(sql, params) {
      if (!sql.includes('chat_sessions')) throw new Error(`Consulta run inesperada: ${sql}`);
      savedState = JSON.parse(params[1]);
      return { changes: 1 };
    },
  };
}

function fakeCatalogTenantDb(initialState) {
  const products = new Map([
    [101, { id: 101, name: 'Pizza especial', price: 150 }],
    [102, { id: 102, name: 'Refresco', price: 40 }],
    [103, { id: 103, name: 'Hamburguesa', price: 95 }],
    [104, { id: 104, name: 'Papas', price: 50 }],
  ]);
  const variants = new Map([
    [101, [{ id: 1001, name: 'Mediana', price: 150 }, { id: 1002, name: 'Grande', price: 190 }]],
    [102, [{ id: 1101, name: 'Regular', price: 40 }, { id: 1102, name: 'Grande', price: 55 }]],
  ]);
  const groups = new Map([
    [101, [{ id: 201, name: 'Ingredientes', min_selections: 1, max_selections: 2 }]],
    [103, [{ id: 301, name: 'Verduras', min_selections: 1, max_selections: 1 }]],
  ]);
  const options = new Map([
    [201, [{ id: 2001, name: 'Pepperoni', extra_price: 0 }, { id: 2002, name: 'Jalapeño', extra_price: 0 }]],
    [301, [{ id: 3001, name: 'Con todo', extra_price: 0 }, { id: 3002, name: 'Sin cebolla', extra_price: 0 }]],
  ]);
  let savedState = structuredClone(initialState);

  return {
    get savedState() { return savedState; },
    async get(sql, params) {
      if (sql.includes('chat_sessions')) return { state: JSON.stringify(savedState) };
      if (sql.includes('settings')) {
        if (params[0] === 'whatsapp') return { value: '526141234567' };
        return null;
      }
      if (sql.includes('FROM {s}.products WHERE id')) return products.get(Number(params[0])) || null;
      throw new Error(`Consulta get inesperada: ${sql}`);
    },
    async all(sql, params) {
      if (sql.includes('settings')) return [];
      const id = Number(params[0]);
      if (sql.includes('product_variants')) return variants.get(id) || [];
      if (sql.includes('modifier_groups')) return groups.get(id) || [];
      if (sql.includes('modifier_options')) return options.get(id) || [];
      throw new Error(`Consulta all inesperada: ${sql}`);
    },
    async run(sql, params) {
      if (!sql.includes('chat_sessions')) throw new Error(`Consulta run inesperada: ${sql}`);
      savedState = JSON.parse(params[1]);
      return { changes: 1 };
    },
  };
}

function fakeMenuTenantDb(initialState) {
  let savedState = structuredClone(initialState);
  const categories = [{ id: 1, name: 'Pollo asado', sort: 1 }, { id: 2, name: 'Bebidas', sort: 2 }];
  const products = [
    { id: 11, name: '1 pollo', description: '', price: 180, image: '', category: 'Pollo asado' },
    { id: 22, name: 'Refresco', description: '', price: 35, image: '', category: 'Bebidas' },
  ];
  return {
    get savedState() { return savedState; },
    async get(sql, params) {
      if (sql.includes('chat_sessions')) return { state: JSON.stringify(savedState) };
      if (sql.includes('settings')) return params[0] === 'whatsapp' ? { value: '526141234567' } : null;
      if (sql.includes('SELECT name FROM {s}.categories')) return categories.find((row) => row.id === Number(params[0])) || null;
      throw new Error(`Consulta get inesperada: ${sql}`);
    },
    async all(sql) {
      if (sql.includes('settings')) return [];
      if (sql.includes('SELECT * FROM {s}.categories')) return categories;
      if (sql.includes('FROM {s}.products p LEFT JOIN {s}.categories')) return products;
      throw new Error(`Consulta all inesperada: ${sql}`);
    },
    async run(sql, params) {
      if (!sql.includes('chat_sessions')) throw new Error(`Consulta run inesperada: ${sql}`);
      savedState = JSON.parse(params[1]);
      return { changes: 1 };
    },
  };
}

test('una opción con máximo 1 completa el ingrediente inmediatamente', async () => {
  const group = {
    id: 5,
    name: 'Verdura',
    min_selections: 0,
    max_selections: 1,
    options: [{ id: 11, name: 'Con todo', extra_price: 0 }, { id: 12, name: 'Sin cebolla', extra_price: 0 }],
  };
  const db = fakeTenantDb(modifierState(group));

  const reply = await handleMessage(db, 'restaurante', 'session-1', 'mod_opt_12');

  assert.equal(db.savedState.step, 'start');
  assert.equal(db.savedState.cart.length, 1);
  assert.equal(db.savedState.cart[0].modifiers[0].options[0].name, 'Sin cebolla');
  assert.equal(reply.options.some((option) => option.value === 'mod_next'), false);
});

test('varias opciones se acumulan hasta el máximo en el mismo paso', () => {
  const group = {
    id: 8,
    max_selections: 3,
    options: [{ id: 21 }, { id: 22 }, { id: 23 }],
  };
  const state = { pendingModifiers: {} };

  assert.equal(toggleModifierOptionSelection(state, group, 21).reachedMax, false);
  assert.equal(toggleModifierOptionSelection(state, group, 22).reachedMax, false);
  assert.equal(toggleModifierOptionSelection(state, group, 23).reachedMax, true);
  assert.deepEqual(state.pendingModifiers[8], [21, 22, 23]);
});

test('el chatbot actualiza opciones múltiples sin repetir la pregunta y avanza al llegar al máximo', async () => {
  const group = {
    id: 8,
    name: 'Ingredientes',
    min_selections: 1,
    max_selections: 3,
    options: [
      { id: 21, name: 'Cebolla', extra_price: 0 },
      { id: 22, name: 'Tomate', extra_price: 0 },
      { id: 23, name: 'Lechuga', extra_price: 0 },
    ],
  };
  const db = fakeTenantDb(modifierState(group));

  const first = await handleMessage(db, 'restaurante', 'session-2', 'mod_opt_21');
  assert.deepEqual(first.messages, []);
  assert.equal(db.savedState.step, 'choosing_modifiers');

  const second = await handleMessage(db, 'restaurante', 'session-2', 'mod_opt_22');
  assert.deepEqual(second.messages, []);
  assert.deepEqual(db.savedState.pendingModifiers[8], [21, 22]);

  await handleMessage(db, 'restaurante', 'session-2', 'mod_opt_23');
  assert.equal(db.savedState.step, 'start');
  assert.equal(db.savedState.cart[0].modifiers[0].options.length, 3);
});

test('rechaza opciones que no pertenecen al grupo configurado', () => {
  const group = { id: 8, max_selections: 1, options: [{ id: 21 }] };
  const state = { pendingModifiers: {} };

  const result = toggleModifierOptionSelection(state, group, 999);

  assert.equal(result.valid, false);
  assert.deepEqual(state.pendingModifiers, {});
});

test('aplica de una sola vez entre el mínimo y máximo de ingredientes elegidos', async () => {
  const group = {
    id: 9,
    name: 'Ingredientes',
    min_selections: 1,
    max_selections: 4,
    options: [31, 32, 33, 34].map((id) => ({ id, name: `Ingrediente ${id}`, extra_price: 0 })),
  };
  const db = fakeTenantDb(modifierState(group));

  await handleMessage(db, 'restaurante', 'session-3', 'mod_apply_31,32,33,34');

  assert.equal(db.savedState.step, 'start');
  assert.equal(db.savedState.cart[0].modifiers[0].options.length, 4);
});

test('entrega a la interfaz el mínimo, máximo y opciones del grupo actual', async () => {
  const group = {
    id: 10,
    name: 'Ingredientes',
    min_selections: 1,
    max_selections: 4,
    options: [41, 42, 43, 44].map((id) => ({ id, name: `Ingrediente ${id}`, extra_price: 0 })),
  };
  const state = modifierState(group);
  state.step = 'choosing_variant';
  const db = fakeTenantDb(state);

  const reply = await handleMessage(db, 'restaurante', 'session-4', 'variant_3');

  assert.equal(reply.modifierGroup.id, 10);
  assert.equal(reply.modifierGroup.minSelections, 1);
  assert.equal(reply.modifierGroup.maxSelections, 4);
  assert.equal(reply.modifierGroup.options.length, 4);
});

test('la interfaz acumula ingredientes localmente y los envía juntos', () => {
  assert.match(chatHtml, /function renderModifierGroup\(group\)/);
  assert.match(chatHtml, /const selected = new Set/);
  assert.match(chatHtml, /send\(`mod_apply_\$\{ids\}`/);
  assert.match(chatHtml, /Mín\. \$\{min\} · Máx\. \$\{max\}/);
  assert.match(chatHtml, /submitButton\.disabled = selected\.size < min \|\| selected\.size > max/);
});

test('volver desde los productos de una categoría regresa directo a las categorías', async () => {
  const db = fakeMenuTenantDb({ step: 'choosing_category', cart: [], customer: {}, currency: 'MXN', aiHistory: [] });

  const productsReply = await handleMessage(db, 'restaurante', 'session-menu-back', 'cat_1');
  const backOption = productsReply.options.find((option) => option.label.includes('Volver'));
  assert.equal(backOption?.value, 'menu');
  assert.equal(db.savedState.currentCategoryId, 1);

  const categoriesReply = await handleMessage(db, 'restaurante', 'session-menu-back', backOption.value);
  assert.equal(db.savedState.step, 'choosing_category');
  assert.deepEqual(categoriesReply.options.map((option) => option.value), ['cat_1', 'cat_2']);
  assert.equal(categoriesReply.products, null);
});

test('configura automáticamente varios productos con variantes, ingredientes o ambos', async () => {
  const db = fakeCatalogTenantDb({ step: 'choosing_product', cart: [], customer: {}, currency: 'MXN', aiHistory: [] });

  let reply = await handleMessage(db, 'restaurante', 'session-bulk', 'prod_apply_101-1,102-2,103-1,104-3');
  assert.equal(db.savedState.step, 'choosing_variant');
  assert.equal(db.savedState.pendingProduct.id, 101);
  assert.equal(db.savedState.pendingConfigurationTotal, 3);
  assert.match(reply.messages[0], /Producto 1 de 3/);
  assert.match(reply.messages[0], /Nombre: Pizza especial/);
  assert.match(reply.messages[0], /Configuración: \*Variante e ingredientes\*/);

  reply = await handleMessage(db, 'restaurante', 'session-bulk', 'variant_1002');
  assert.equal(db.savedState.step, 'choosing_modifiers');
  assert.equal(reply.modifierGroup.id, 201);

  reply = await handleMessage(db, 'restaurante', 'session-bulk', 'mod_apply_2001');
  assert.equal(db.savedState.step, 'choosing_variant');
  assert.equal(db.savedState.pendingProduct.id, 102);
  assert.match(reply.messages[0], /Producto 2 de 3/);
  assert.match(reply.messages[0], /Nombre: Refresco/);
  assert.match(reply.messages[0], /Configuración: \*Variante\*/);

  reply = await handleMessage(db, 'restaurante', 'session-bulk', 'variant_1101');
  assert.equal(db.savedState.step, 'choosing_modifiers');
  assert.equal(db.savedState.pendingProduct.id, 103);
  assert.equal(reply.modifierGroup.id, 301);
  assert.match(reply.messages[0], /Producto 3 de 3/);
  assert.match(reply.messages[0], /Nombre: Hamburguesa/);
  assert.match(reply.messages[0], /Configuración: \*Ingredientes\*/);

  reply = await handleMessage(db, 'restaurante', 'session-bulk', 'mod_apply_3002');
  assert.equal(db.savedState.step, 'start');
  assert.equal(db.savedState.pendingConfigurationTotal, 0);
  assert.equal(db.savedState.cart.length, 4);
  assert.equal(db.savedState.cart.find((item) => item.id === 102).qty, 2);
  assert.equal(db.savedState.cart.find((item) => item.id === 104).qty, 3);
  assert.match(reply.messages[0], /Todos los productos quedaron configurados/);
});
