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
