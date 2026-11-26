const test = require('node:test');
const assert = require('node:assert');
const { detectActiveStore, scanShufersalCart, scanRamiLevyCart, scanVictoryCart, scanMCKCart } = require('../cart_scanners.js');
const { agentInsideCartEngine, agentShufersalAgent, agentVictoryAgent, agentMCKAgent } = require('../store_agents.js');

test('detectActiveStore identifies all 4 chains', () => {
    assert.strictEqual(detectActiveStore('https://www.shufersal.co.il/online/he/cart'), 'shufersal');
    assert.strictEqual(detectActiveStore('https://www.rami-levy.co.il/he'), 'ramiLevy');
    assert.strictEqual(detectActiveStore('https://www.victoryonline.co.il/'), 'victory');
    assert.strictEqual(detectActiveStore('https://www.mck.co.il/'), 'machsaneiHashuk');
    assert.strictEqual(detectActiveStore(''), 'shufersal');
});

test('scanners and agents are self-contained (zero external helper references)', () => {
    const fns = [
        scanShufersalCart, scanRamiLevyCart, scanVictoryCart, scanMCKCart,
        agentInsideCartEngine, agentShufersalAgent, agentVictoryAgent, agentMCKAgent
    ];
    for (const fn of fns) {
        const src = fn.toString();
        assert.ok(!src.includes('loadSettings'), `${fn.name} must not call loadSettings`);
        assert.ok(!src.includes('saveBranchId'), `${fn.name} must not call saveBranchId`);
        assert.ok(!src.includes('require('), `${fn.name} must not call require`);
    }
});

test('agentMCKAgent NEVER POSTs or PATCHes /carts endpoints', async () => {
    const origFetch = global.fetch;
    const origLocalStorage = global.localStorage;
    const calls = [];

    global.localStorage = {
        getItem: (k) => k === 'branch' ? JSON.stringify({ branchId: 123, userId: 456, cartId: 789 }) : null,
        key: (i) => ['branch'][i],
        get length() { return 1; }
    };
    Object.defineProperty(global.localStorage, 'branch', { value: '1', enumerable: true, configurable: true });

    global.fetch = async (url, opts = {}) => {
        calls.push({ url: String(url), method: (opts.method || 'GET').toUpperCase(), headers: opts.headers || {} });
        return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            json: async () => ({
                suggestions: {
                    suggestProducts: {
                        products: [{
                            id: 999,
                            barcode: '7290000000012',
                            name: 'חלב 3%',
                            branch: { isOutOfStock: false, salePrice: 6.5, regularPrice: 7.2, specials: [] }
                        }]
                    }
                }
            })
        };
    };

    try {
        const res = await agentMCKAgent([{ barcode: '7290000000012', name: 'חלב 3%', quantity: 2 }], 123);
        assert.strictEqual(res.results.length, 1);
        assert.strictEqual(res.results[0].finalTotal, 13);
        assert.strictEqual(res.results[0].retailerProductId, 999);
        assert.ok(calls.length >= 1);
        for (const c of calls) {
            assert.ok(!c.url.includes('/carts'), `Unexpected /carts request: ${c.url}`);
            assert.strictEqual(c.method, 'GET', `Expected read-only GET, got ${c.method} for ${c.url}`);
            assert.strictEqual(c.headers['x-http-method-override'], undefined);
        }
    } finally {
        global.fetch = origFetch;
        global.localStorage = origLocalStorage;
    }
});

test('agentShufersalAgent processes items in parallel batches of 4 and fetches delivery slots', async () => {
    const origFetch = global.fetch;
    const origDOMParser = global.DOMParser;
    const origDocument = global.document;

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchedUrls = [];

    global.document = { body: { textContent: 'דמי שירות במשלוח 29.90' } };
    global.DOMParser = class {
        parseFromString(html) {
            const m = html.match(/data-product-code="([^"]+)"[^>]*>([\d.]+)/);
            return {
                querySelector: (sel) => {
                    if (!m || !sel.includes(m[1])) return null;
                    return {
                        querySelector: (qSel) => qSel.includes('totalPrice') ? { innerText: m[2] } : null
                    };
                },
                querySelectorAll: () => []
            };
        }
    };

    global.fetch = async (url) => {
        const u = String(url);
        fetchedUrls.push(u);
        if (u.includes('getHomeDeliverySlots')) {
            return { ok: true, json: async () => ({ '20261127': [{ selectable: true, price: { value: 29.9 } }] }) };
        }
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 15));
        inFlight--;
        const code = decodeURIComponent(u.split('text=')[1]);
        return {
            ok: true,
            text: async () => `<ul><li data-product-code="P_${code}">12.50</li></ul>`
        };
    };

    try {
        const items = Array.from({ length: 6 }, (_, i) => ({ barcode: `729000000000${i}`, quantity: 2 }));
        const out = await agentShufersalAgent(items);
        assert.strictEqual(out.results.length, 6);
        assert.ok(maxInFlight > 1 && maxInFlight <= 4, `Expected parallel batch <= 4, saw maxInFlight=${maxInFlight}`);
        assert.strictEqual(out.results[0].finalTotal, 25);
        assert.strictEqual(out.debug.deliveryFee, 29.9);
        assert.deepStrictEqual(out.debug.slotFees, { '2026-11-27': [29.9] });
    } finally {
        global.fetch = origFetch;
        global.DOMParser = origDOMParser;
        global.document = origDocument;
    }
});
