const test = require('node:test');
const assert = require('node:assert');
const { renderStoreSummary } = require('../results_view.js');

function stores() {
    const list = [
        { key: 'ramiLevy', name: 'רמי לוי', total: 412.3, info: 'כל המוצרים נמצאו', hasData: true },
        { key: 'victory', name: 'ויקטורי', total: 428.9, info: 'חסרים 2 מוצרים', hasData: true },
        { key: 'shufersal', name: 'שופרסל', total: 450.1, info: 'הסופר הנוכחי שלך', hasData: true },
        { key: 'machsaneiHashuk', name: 'מחסני השוק', total: 0, info: '', hasData: false, debugInfo: 'מחירים לא נמצאו' }
    ];
    const sortable = list.filter(s => s.hasData).sort((a, b) => a.total - b.total);
    return { orderedStores: [...sortable, ...list.filter(s => !s.hasData)], sortable };
}

const count = (html, s) => html.split(s).length - 1;

test('saving case: hero, single winner button, diffs, no-data row', () => {
    const { orderedStores, sortable } = stores();
    const html = renderStoreSummary({ orderedStores, sortable, activeStore: 'shufersal', itemCount: 23 });
    assert.ok(html.includes('₪37.80'));
    assert.ok(html.includes('8% פחות משופרסל'));
    assert.strictEqual(count(html, 'id="switchToRamiLevy"'), 1);
    const winStart = html.indexOf('class="win"');
    const winEnd = html.indexOf('class="list"');
    const idPos = html.indexOf('id="switchToRamiLevy"');
    assert.ok(idPos > winStart && idPos < winEnd);
    assert.ok(html.includes('+₪16.60'));
    assert.ok(html.includes('מחירים לא נמצאו'));
    const mckRow = html.split('class="row"').find(r => r.includes('מחסני השוק'));
    assert.ok(!mckRow.includes('₪'));
    assert.ok(!html.includes('id="switchToShufersal"'));
});

test('active store cheapest: no zero saving, no build button', () => {
    const { orderedStores, sortable } = stores();
    const html = renderStoreSummary({ orderedStores, sortable, activeStore: 'ramiLevy', itemCount: 23 });
    assert.ok(html.includes('העגלה שלך כבר הכי זולה'));
    assert.ok(!html.includes('₪0.00'));
    assert.ok(!html.includes('id="switchToRamiLevy"'));
});

test('no store has data: neutral hero, no throw', () => {
    const html = renderStoreSummary({ orderedStores: [], sortable: [], activeStore: 'shufersal', itemCount: 0 });
    assert.ok(html.includes('לא נמצאו מחירים'));
});

test('store name is escaped', () => {
    const s = [{ key: 'victory', name: 'A<b>&', total: 10, info: '', hasData: true }];
    const html = renderStoreSummary({ orderedStores: s, sortable: s, activeStore: 'shufersal', itemCount: 1 });
    assert.ok(html.includes('A&lt;b&gt;&amp;'));
    assert.ok(!html.includes('A<b>'));
});

test('a store missing products is compared only on the products it has', () => {
    // cart of 3 at Victory costs 924.73; Shufersal has 1 product (14.70) that costs 16.70 at Victory
    const list = [
        { key: 'shufersal', name: 'שופרסל', total: 14.7, gap: 908.03, info: '', hasData: true },
        { key: 'victory', name: 'ויקטורי', total: 924.73, gap: 0, info: '', hasData: true }
    ];
    const html = renderStoreSummary({ orderedStores: list, sortable: list, activeStore: 'victory', itemCount: 3 });
    assert.ok(html.includes('₪2.00'));
    assert.ok(!html.includes('910.03'));
    assert.ok(!html.includes('% פחות')); // under 1% is not worth a badge
});

const { addToHistory, renderHistory } = require('../results_view.js');
test('addToHistory: newest first, same cart replaces itself, capped at 20', () => {
    const cart = (store, qty, at) => ({ at, store, totals: {}, items: [{ shufersal_code: 'P_1', quantity: qty }] });
    let list = addToHistory([], cart('victory', 1, 1));
    list = addToHistory(list, cart('victory', 2, 2));
    list = addToHistory(list, cart('victory', 1, 3)); // the first cart again
    assert.deepStrictEqual(list.map(e => e.at), [3, 2]);
    for (let i = 0; i < 30; i++) list = addToHistory(list, cart('shufersal', 100 + i, 10 + i));
    assert.strictEqual(list.length, 20);
});
test('renderHistory: escapes names, offers every chain, empty state', () => {
    const html = renderHistory([{ at: 0, store: 'ramiLevy', totals: { victory: 110, ramiLevy: 115 }, items: [{ name: '<b>x</b>', quantity: 2 }] }]);
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'));
    assert.ok(html.includes('הכי זול היה בויקטורי') && html.includes('₪110.00'));
    assert.strictEqual(html.split('data-build=').length - 1, 4);
    assert.ok(renderHistory([]).includes('עוד אין סלים שמורים'));
});

test('delivery fees are part of the totals, the ranking and the labels', () => {
    // products alone: victory 100 < ramiLevy 110. With delivery (victory 35.9, ramiLevy free) ramiLevy wins.
    const list = [
        { key: 'ramiLevy', name: 'רמי לוי', total: 110, gap: 0, delivery: 0, info: '', hasData: true },
        { key: 'victory', name: 'ויקטורי', total: 100, gap: 0, delivery: 35.9, deliveryNote: 'משלוח חינם ביום שלישי', info: '', hasData: true },
        { key: 'machsaneiHashuk', name: 'מחסני השוק', total: 105, gap: 0, delivery: null, deliveryEst: 35.9, info: '', hasData: true }
    ];
    const { rvCompareTotal } = require('../results_view.js');
    const sortable = [...list].sort((a, b) => rvCompareTotal(a) - rvCompareTotal(b));
    assert.deepStrictEqual(sortable.map(s => s.key), ['ramiLevy', 'victory', 'machsaneiHashuk']);
    const html = renderStoreSummary({ orderedStores: sortable, sortable, activeStore: 'victory', itemCount: 3 });
    assert.ok(html.includes('כולל דמי משלוח</div>') || html.includes(', כולל דמי משלוח'));
    assert.ok(html.includes('₪25.90'));                      // saving: 135.90 - 110
    assert.ok(html.includes('כולל משלוח חינם'));
    assert.ok(html.includes('₪135.90') && html.includes('כולל דמי משלוח ₪35.90 · משלוח חינם ביום שלישי'));
    assert.ok(html.includes('₪140.90') && html.includes('כולל הערכת דמי משלוח ₪35.90'));
});
test('no chain gave a delivery fee: totals stay product-only and say so', () => {
    const list = [{ key: 'victory', name: 'ויקטורי', total: 100, gap: 0, info: '', hasData: true }, { key: 'shufersal', name: 'שופרסל', total: 120, gap: 0, info: '', hasData: true }];
    const html = renderStoreSummary({ orderedStores: list, sortable: list, activeStore: 'shufersal', itemCount: 1 });
    assert.ok(html.includes('₪20.00') && html.includes('לא כולל דמי משלוח') && !html.includes(', כולל דמי משלוח'));
});
