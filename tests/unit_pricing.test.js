const test = require('node:test');
const assert = require('node:assert');
const { parseUnitInfo, formatUnitPrice, detectOutlierDeals, matchWeighedStaple } = require('../unit_pricing.js');

test('parseUnitInfo: multipacks', () => {
    assert.deepStrictEqual(parseUnitInfo('לחמניות 80*4ג'), { qty: 320, unit: 'g' });
    assert.deepStrictEqual(parseUnitInfo('מים מינרליים 6*1.5 ליטר'), { qty: 9000, unit: 'ml' });
    assert.deepStrictEqual(parseUnitInfo('בייגלה 80*2'), { qty: 160, unit: 'g' });
    assert.deepStrictEqual(parseUnitInfo('קולה זירו 6 × 330 מ"ל'), { qty: 1980, unit: 'ml' });
    assert.deepStrictEqual(parseUnitInfo('סוכר 2 * 1 ק"ג'), { qty: 2000, unit: 'g' });
    assert.deepStrictEqual(parseUnitInfo('שמן 1.5 ליטר * 4'), { qty: 6000, unit: 'ml' });
});

test('parseUnitInfo: single weights, volumes, and counts', () => {
    assert.deepStrictEqual(parseUnitInfo('פסטה ברילה 500 גרם'), { qty: 500, unit: 'g' });
    assert.deepStrictEqual(parseUnitInfo('טחינה 750גר'), { qty: 750, unit: 'g' });
    assert.deepStrictEqual(parseUnitInfo('אורז בסמטי 1 ק"ג'), { qty: 1000, unit: 'g' });
    assert.deepStrictEqual(parseUnitInfo('מיץ תפוזים 1.5 ליטר'), { qty: 1500, unit: 'ml' });
    assert.deepStrictEqual(parseUnitInfo('שמנת מתוקה 250 מ"ל'), { qty: 250, unit: 'ml' });
    assert.deepStrictEqual(parseUnitInfo("ביצים גודל L 30 יח'"), { qty: 30, unit: 'unit' });
});

test('parseUnitInfo: returns null for unknown or percentage-only strings', () => {
    assert.strictEqual(parseUnitInfo('חלב תנובה 3%'), null);
    assert.strictEqual(parseUnitInfo(''), null);
    assert.strictEqual(parseUnitInfo(null), null);
});

test('formatUnitPrice: formats g, ml, unit, prefers DB unit metadata, guards invalid prices', () => {
    assert.strictEqual(formatUnitPrice(10, 'פסטה 500 גרם'), '₪2.00 ל-100 גרם');
    assert.strictEqual(formatUnitPrice(6, 'מים 1.5 ליטר'), '₪0.40 ל-100 מ"ל');
    assert.strictEqual(formatUnitPrice(12.9, "ביצים 30 יח'"), "₪0.43 ליח'");
    assert.strictEqual(formatUnitPrice(15, 'מוצר כללי', 250, 'g'), '₪6.00 ל-100 גרם');
    assert.strictEqual(formatUnitPrice(10, 'מוצר כללי', 500, 'ml'), '₪2.00 ל-100 מ"ל');
    assert.strictEqual(formatUnitPrice(0, 'פסטה 500 גרם'), '');
    assert.strictEqual(formatUnitPrice(-5, 'פסטה 500 גרם'), '');
    assert.strictEqual(formatUnitPrice(10, 'מוצר ללא משקל'), '');
});

test('detectOutlierDeals: finds >=25% AND >=6 NIS deals, excludes incompatible pack sizes, sorts desc max 5', () => {
    const storeNames = { shufersal: 'שופרסל', victory: 'ויקטורי', ramiLevy: 'רמי לוי' };
    const matrix = [
        // Deep deal: 29.9 vs 18.9 -> saving 11.00, 37%
        { name: 'קפה מגורען 200 גרם', quantity: 1, prices: { shufersal: 29.9, victory: 18.9, ramiLevy: 29.9 } },
        // Too small NIS saving (< 6): 10 vs 6 -> 40% but saving 4
        { name: 'חלב 1 ליטר', quantity: 1, prices: { shufersal: 10, victory: 6 } },
        // Too small % (< 25%): 40 vs 32 -> saving 8 but 20%
        { name: 'שמן זית 750 מ"ל', quantity: 1, prices: { shufersal: 40, victory: 32 } },
        // Incompatible substitute pack size (1000ml vs 500ml) -> excluded!
        {
            name: 'מיץ תפוזים 1 ליטר',
            quantity: 1,
            prices: { shufersal: 20, victory: 10 },
            subNames: { victory: 'מיץ תפוזים 500 מ"ל' }
        },
        // 5 more valid deals to test sorting and max 5 cap
        { name: 'מוצר א 500 גרם', quantity: 1, prices: { shufersal: 30, ramiLevy: 20 } },  // saving 10
        { name: 'מוצר ב 500 גרם', quantity: 1, prices: { shufersal: 50, victory: 25 } },   // saving 25
        { name: 'מוצר ג 500 גרם', quantity: 1, prices: { shufersal: 24, ramiLevy: 18 } },  // saving 6, exactly 25%
        { name: 'מוצר ד 500 גרם', quantity: 1, prices: { shufersal: 40, victory: 26 } },   // saving 14
        { name: 'מוצר ה 500 גרם', quantity: 1, prices: { shufersal: 45, ramiLevy: 30 } },  // saving 15
    ];

    const deals = detectOutlierDeals(matrix, storeNames);
    assert.strictEqual(deals.length, 5);
    assert.deepStrictEqual(deals.map(d => d.name), [
        'מוצר ב 500 גרם',
        'מוצר ה 500 גרם',
        'מוצר ד 500 גרם',
        'קפה מגורען 200 גרם',
        'מוצר א 500 גרם'
    ]);
    assert.strictEqual(deals[0].bestStore, 'victory');
    assert.strictEqual(deals[0].bestStoreName, 'ויקטורי');
    assert.strictEqual(deals[0].saving, 25);
    assert.strictEqual(deals[0].pct, 50);
});

test('matchWeighedStaple: matches exact, aliases, prefix, and Hebrew plural tokens; rejects non-produce', () => {
    const staples = [
        { staple_key: 'tomato', canonical_he: 'עגבניה', aliases: ['עגבנייה', 'עגבניות', 'עגבניות חממה'], search_query: 'עגבניה', unit_type: 'g' },
        { staple_key: 'cucumber', canonical_he: 'מלפפון', aliases: ['מלפפונים', 'מלפפון חממה'], search_query: 'מלפפון', unit_type: 'g' },
        { staple_key: 'chicken_breast', canonical_he: 'חזה עוף', aliases: ['חזה עוף טרי'], search_query: 'חזה עוף', unit_type: 'g' },
        { staple_key: 'red_pepper', canonical_he: 'פלפל אדום', aliases: ['גמבה'], search_query: 'פלפל אדום', unit_type: 'g' },
        { staple_key: 'onion', canonical_he: 'בצל יבש', aliases: ['בצל'], search_query: 'בצל יבש', unit_type: 'g' },
        { staple_key: 'red_onion', canonical_he: 'בצל סגול', aliases: ['בצל אדום'], search_query: 'בצל סגול', unit_type: 'g' }
    ];

    assert.strictEqual(matchWeighedStaple('מלפפונים חממה', staples)?.staple_key, 'cucumber');
    assert.strictEqual(matchWeighedStaple('עגבניה', staples)?.staple_key, 'tomato');
    assert.strictEqual(matchWeighedStaple('חזה עוף טרי פרוס', staples)?.staple_key, 'chicken_breast');
    assert.strictEqual(matchWeighedStaple('בצל סגול אורגני', staples)?.staple_key, 'red_onion');
    assert.strictEqual(matchWeighedStaple('חלב תנובה 3%', staples), null);
    assert.strictEqual(matchWeighedStaple('שניצל עוף קפוא', staples), null);
});
