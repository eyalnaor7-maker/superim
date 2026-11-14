const test = require('node:test');
const assert = require('node:assert');
const { normalizeBarcode, pickExactHit, barcodeFromImage, cityFromAddress, branchFromDeliverySlots } = require('../victory_match.js');

test('branchFromDeliverySlots reads the delivering branch, null when there is no delivery', () => {
  const answer = { status: 'success', data: { '2026-11-15': [{ id: '5067', hours: '10:00-12:00', branchId: '26' }] } };
  assert.strictEqual(branchFromDeliverySlots(answer), '26');
  assert.strictEqual(branchFromDeliverySlots({ status: 'success', data: [] }), null);
  assert.strictEqual(branchFromDeliverySlots({ status: 'error' }), null);
  assert.strictEqual(branchFromDeliverySlots(null), null);
});

test('normalizeBarcode strips P_ and leading zeros', () => {
  assert.strictEqual(normalizeBarcode('P_0007290004131074'), '7290004131074');
});
test('pickExactHit accepts only the exact barcode', () => {
  assert.strictEqual(pickExactHit([{ sku: '7290004135072' }, { sku: '7290004131074', id: '7338' }], 'P_7290004131074').id, '7338');
  assert.strictEqual(pickExactHit([{ sku: '7290004135072' }], '7290004131074'), null);
  assert.strictEqual(pickExactHit([], 'x'), null);
});
test('barcodeFromImage reads both image path forms', () => {
  assert.strictEqual(barcodeFromImage('https://d.cloudfront.net/media/product-images/7290113392304/7290113392304.jpg'), '7290113392304');
  assert.strictEqual(barcodeFromImage('https://d.cloudfront.net/gs1/7290004131074/7290004131074_S1.jpg'), '7290004131074');
  assert.strictEqual(barcodeFromImage(''), null);
});
test('cityFromAddress takes text after last comma, else name', () => {
  assert.strictEqual(cityFromAddress('אפיקים 1, אופקים', 'אופקים'), 'אופקים');
  assert.strictEqual(cityFromAddress('', 'אשקלון מרכז'), 'אשקלון מרכז');
});
