const test = require('node:test');
const assert = require('node:assert');
const {
    PRICE_CACHE_TTL_MS,
    PRICE_CACHE_MAX_ENTRIES,
    makePriceCacheKey,
    getFreshCachedPrices,
    mergePriceCache
} = require('../price_cache.js');

test('makePriceCacheKey formats store, branch (or default), and code', () => {
    assert.strictEqual(makePriceCacheKey('victory', '55', '7290001'), 'victory|55|7290001');
    assert.strictEqual(makePriceCacheKey('shufersal', null, '7290001'), 'shufersal|default|7290001');
    assert.strictEqual(makePriceCacheKey('ramiLevy', '', 12345), 'ramiLevy|default|12345');
});

test('getFreshCachedPrices returns fresh hits and separates expired/missing misses', () => {
    const now = 1_000_000_000;
    let cache = {};
    cache = mergePriceCache(cache, 'victory', '55', [
        { barcode: '111', finalTotal: 10, unitPrice: 10 },
        { barcode: '222', finalTotal: 20, unitPrice: 20 }
    ], now - 5 * 60 * 1000); // 5 mins old (fresh)

    cache = mergePriceCache(cache, 'victory', '55', [
        { barcode: '333', finalTotal: 30, unitPrice: 30 }
    ], now - PRICE_CACHE_TTL_MS); // exactly 15 mins old -> expired

    const { hits, misses } = getFreshCachedPrices(cache, 'victory', '55', ['111', '222', '333', '444'], now);
    assert.strictEqual(hits['111'].finalTotal, 10);
    assert.strictEqual(hits['222'].finalTotal, 20);
    assert.strictEqual(hits['333'], undefined);
    assert.deepStrictEqual(misses, ['333', '444']);
});

test('mergePriceCache isolates branches and evicts oldest entries beyond 600', () => {
    const baseTime = 2_000_000_000;
    let cache = {};
    for (let i = 0; i < PRICE_CACHE_MAX_ENTRIES + 25; i++) {
        cache = mergePriceCache(cache, 'shufersal', '10', [{ barcode: `B${i}`, price: i }], baseTime + i);
    }

    const keys = Object.keys(cache);
    assert.strictEqual(keys.length, PRICE_CACHE_MAX_ENTRIES);
    // Oldest 25 (B0..B24) should have been evicted
    assert.strictEqual(cache[makePriceCacheKey('shufersal', '10', 'B0')], undefined);
    assert.strictEqual(cache[makePriceCacheKey('shufersal', '10', 'B24')], undefined);
    assert.ok(cache[makePriceCacheKey('shufersal', '10', 'B25')]);
    assert.ok(cache[makePriceCacheKey('shufersal', '10', `B${PRICE_CACHE_MAX_ENTRIES + 24}`)]);

    // Different branchId must not collide
    const { misses } = getFreshCachedPrices(cache, 'shufersal', '99', ['B25'], baseTime + 1000);
    assert.deepStrictEqual(misses, ['B25']);
});
