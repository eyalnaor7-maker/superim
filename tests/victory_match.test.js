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

const { victorySaleTotal } = require('../victory_match.js');
test('victorySaleTotal: "2 ב-₪110" applies per pair, up to maxQuantity uses', () => {
  const sale = { name: '2 ב-₪110', isMaxSale: false, maxQuantity: 2 }; // shape seen on the live site 2026-11-15
  assert.strictEqual(victorySaleTotal(69.9, 1, [sale]), 69.9);
  assert.strictEqual(victorySaleTotal(69.9, 2, [sale]), 110);
  assert.strictEqual(victorySaleTotal(69.9, 3, [sale]), 179.9);
  assert.strictEqual(victorySaleTotal(69.9, 6, [sale]), 359.8); // only 2 uses
});
test('victorySaleTotal: plain sale price, and ignored sales', () => {
  assert.strictEqual(victorySaleTotal(999, 1, [{ name: '₪899' }]), 899);
  assert.strictEqual(victorySaleTotal(10, 2, [{ name: '2 ב-₪15', isMaxSale: true }]), 20);
  assert.strictEqual(victorySaleTotal(10, 2, [{ name: 'השני ב-₪1' }]), 20);
  assert.strictEqual(victorySaleTotal(10, 2, null), 20);
});

const { victoryDeliveryFromSlots } = require('../victory_match.js');
test('victoryDeliveryFromSlots: nearest day fee, and a later free-delivery day', () => {
  const slot = (date, fee) => ({ id: '1', date, hours: '10:00-12:00', fee, minOrder: 250, branchId: '26' }); // live shape 2026-11-15
  const json = { status: 'success', data: { '2026-11-17': [slot('2026-11-17', 0)], '2026-11-16': [slot('2026-11-16', 35.9), slot('2026-11-16', 29.9)] } };
  assert.deepStrictEqual(victoryDeliveryFromSlots(json), { fee: 29.9, minOrder: 250, cheaper: { fee: 0, date: '2026-11-17' } });
  const flat = { status: 'success', data: { '2026-11-16': [slot('2026-11-16', 35.9)], '2026-11-17': [slot('2026-11-17', 35.9)] } };
  assert.deepStrictEqual(victoryDeliveryFromSlots(flat), { fee: 35.9, minOrder: 250, cheaper: null });
  assert.strictEqual(victoryDeliveryFromSlots({ status: 'success', data: {} }), null);
  assert.strictEqual(victoryDeliveryFromSlots({ status: 'error' }), null);
});

const { deliveryFromDays } = require('../victory_match.js');
test('deliveryFromDays: nearest day decides the fee, a later cheaper day is reported', () => {
  // Rami Levy and Shufersal shapes reduce to this: fees per day (live shapes seen 2026-11-15)
  assert.deepStrictEqual(deliveryFromDays({ '2026-11-17': [35.9, 35.9], '2026-11-18': [35.9], '2026-11-24': [0, 35.9] }),
    { fee: 35.9, cheaper: { date: '2026-11-24', fee: 0 } });
  assert.deepStrictEqual(deliveryFromDays({ '2026-11-17': [0], '2026-11-18': [35.9] }), { fee: 0, cheaper: null }); // free today
  assert.deepStrictEqual(deliveryFromDays({ '2026-11-17': [null, undefined], '2026-11-18': [29.9] }), { fee: 29.9, cheaper: null });
  assert.strictEqual(deliveryFromDays({}), null);
  assert.strictEqual(deliveryFromDays(undefined), null);
});
