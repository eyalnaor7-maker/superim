const test = require('node:test');
const assert = require('node:assert');
const { mergeGuestCart } = require('../rami_guest.js');

test('adds items with amount', () => {
  const s = mergeGuestCart({ cart: { items: [] } }, [{ id: 1, name: 'a' }], { 1: 3 });
  assert.deepStrictEqual(s.cart.items, [{ id: 1, name: 'a', amount: 3 }]);
});
test('replaces same id, keeps unrelated', () => {
  const s = mergeGuestCart({ cart: { items: [{ id: 1, amount: 1 }, { id: 2, amount: 5 }] } }, [{ id: 1 }], { 1: 2 });
  assert.deepStrictEqual(s.cart.items, [{ id: 2, amount: 5 }, { id: 1, amount: 2 }]);
});
test('tolerates empty state', () => {
  assert.strictEqual(mergeGuestCart({}, [{ id: 7 }], { 7: 2 }).cart.items[0].amount, 2);
  assert.strictEqual(mergeGuestCart(null, [{ id: 7 }], { 7: 1 }).cart.items.length, 1);
});
test('does not mutate input', () => {
  const input = { cart: { items: [{ id: 1, amount: 1 }] } };
  const snap = JSON.stringify(input);
  mergeGuestCart(input, [{ id: 1 }, { id: 2 }], { 1: 2, 2: 1 });
  assert.strictEqual(JSON.stringify(input), snap);
});

const { ramiCartLines } = require('../rami_guest.js');
test('ramiCartLines: a "2 for 115" line is 115, not finalPrice times amount', () => {
  // shape copied from the live site, 2026-11-15
  const nutrilon = { id: 266631, name: 'נוטרילון 3- 800 גרם', amount: 2, isAvailable: true, is_delivery: false, sumPrice: 115, finalPrice: 119.8,
    price: { price: 59.9, finalPrice: 115, saleOldPrice: 119.8 }, finalCart: { FormatedTotalPrice: 115, quantity: 2 } };
  const delivery = { id: 164854, name: 'מחיר משלוח', amount: 1, is_delivery: true, sumPrice: 35.9, price: { price: 35.9, finalPrice: 35.9 } };
  assert.deepStrictEqual(ramiCartLines([nutrilon, delivery]),
    [{ code: '266631', name: 'נוטרילון 3- 800 גרם', quantity: 2, rami_levy_total: 115, outOfStock: false }]);
});
test('ramiCartLines: unpriced line falls back to unit price times amount; unavailable is zero', () => {
  assert.strictEqual(ramiCartLines([{ id: 1, name: 'a', amount: 3, price: { price: 5, finalPrice: 5 } }])[0].rami_levy_total, 15);
  assert.strictEqual(ramiCartLines([{ id: 1, name: 'a', amount: 3, isAvailable: false, sumPrice: 15 }])[0].rami_levy_total, 0);
  assert.deepStrictEqual(ramiCartLines(null), []);
});
