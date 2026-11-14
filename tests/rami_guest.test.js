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
