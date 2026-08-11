const test = require('node:test');
const assert = require('node:assert/strict');
const { stockValuation } = require('../src/utils/stockValuation');

test('calcula venta, costo, utilidad y margen del stock de una sucursal', () => {
  assert.deepEqual(stockValuation([
    { quantity: 10, salePrice: 100, unitCost: 60 },
    { quantity: 2, salePrice: 50, unitCost: 25 },
  ]), {
    salesValue: 1100,
    costValue: 650,
    profitValue: 450,
    profitPercent: 40.91,
  });
});

test('evita porcentajes inválidos cuando no hay inventario valorizado', () => {
  assert.deepEqual(stockValuation([{ quantity: 0, salePrice: 100, unitCost: 60 }]), {
    salesValue: 0,
    costValue: 0,
    profitValue: 0,
    profitPercent: 0,
  });
});

test('refleja pérdida cuando el costo supera al precio de venta', () => {
  assert.deepEqual(stockValuation([{ quantity: 3, salePrice: 80, unitCost: 100 }]), {
    salesValue: 240,
    costValue: 300,
    profitValue: -60,
    profitPercent: -25,
  });
});
