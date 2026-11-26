const test = require('node:test');
const assert = require('node:assert');
const {
    citySuggestions,
    branchesInCity,
    fetchShufersalBranches,
    fetchRamiLevyBranches,
    RAMI_LEVY_FALLBACK_BRANCHES
} = require('../branch_service.js');

test('citySuggestions returns cities starting with the typed text', () => {
    const cities = ['אבן יהודה', 'באר יעקב', 'באר שבע', 'גבעתיים', 'קריית גת'];
    assert.deepStrictEqual(citySuggestions(cities, 'באר'), ['באר יעקב', 'באר שבע']);
    assert.deepStrictEqual(citySuggestions(cities, 'ג'), ['גבעתיים']);
    assert.deepStrictEqual(citySuggestions(cities, 'קרית'), ['קריית גת']);
    assert.deepStrictEqual(citySuggestions(cities, '  '), []);
});

test('branchesInCity matches city, name, address and delivery areas', () => {
    const mck = { name: 'באר שבע', city: '', address: 'האורגים 8', areas: 'באר שבע, עומר' };
    const tlv = { name: 'סניף מרכז', city: 'תל אביב', address: '', areas: '' };
    const motzkin = { name: 'מוצקין', city: 'קרית מוצקין', address: '', areas: '' };
    const all = [mck, tlv, motzkin];
    assert.deepStrictEqual(branchesInCity(all, 'עומר'), [mck]);
    assert.deepStrictEqual(branchesInCity(all, 'תל אביב - יפו'), [tlv]);
    assert.deepStrictEqual(branchesInCity(all, 'קריית מוצקין'), [motzkin]);
    assert.deepStrictEqual(branchesInCity(all, 'אילת'), []);
    assert.deepStrictEqual(branchesInCity(all, ''), all);
});

test('branchesInCity: a city inside a longer place name does not match', () => {
    const ganYavne = { name: 'גן-יבנה', city: 'גן-יבנה', address: 'הכישור 8, גן-יבנה', areas: '' };
    const ashkelon = { name: 'אשקלון מרכז', city: 'אשקלון מרכז', address: 'יצחק בן צבי 48', areas: '' };
    assert.deepStrictEqual(branchesInCity([ganYavne, ashkelon], 'יבנה'), []);
    assert.deepStrictEqual(branchesInCity([ganYavne, ashkelon], 'גן יבנה'), [ganYavne]);
    assert.deepStrictEqual(branchesInCity([ganYavne, ashkelon], 'אשקלון'), [ashkelon]);
});

test('branchesInCity: a street named after a city does not beat a branch in that city', () => {
    const motzkin = { name: 'מוצקין', city: 'קרית מוצקין', address: 'שד ירושלים 1 נווה גנים, קרית מוצקין', areas: '' };
    const malha = { name: 'מלחה', city: 'ירושלים', address: 'קניון מלחה, ירושלים', areas: '' };
    const noCity = { name: 'אשקלון מרכז', city: 'אשקלון מרכז', address: 'יצחק בן צבי 48', areas: '' };
    assert.deepStrictEqual(branchesInCity([motzkin, malha, noCity], 'ירושלים'), [malha]);
    // the address is still used when it is the only clue
    assert.deepStrictEqual(branchesInCity([motzkin, noCity], 'ירושלים'), [motzkin]);
});

test('Shufersal nationwide branches cover 35+ hubs and preserve Beersheba IDs', async () => {
    const branches = await fetchShufersalBranches();
    assert.ok(branches.length >= 35, `Expected >=35 Shufersal branches, got ${branches.length}`);
    assert.ok(branches.every(b => b.network === 'shufersal' && b.id && b.name && b.city));
    const ids = new Set(branches.map(b => b.id));
    assert.strictEqual(ids.size, branches.length, 'Shufersal branch IDs must be unique');
    for (const keptId of ['876', '737', '222', '248', '110', '83', '65', '49']) {
        assert.ok(ids.has(keptId), `Missing preserved Shufersal Beersheba ID ${keptId}`);
    }
    for (const city of ['תל אביב - יפו', 'ירושלים', 'חיפה', 'אילת', 'באר שבע', 'מודיעין-מכבים-רעות', 'קריית ביאליק']) {
        assert.ok(branchesInCity(branches, city).length > 0, `Expected Shufersal branch for ${city}`);
    }
});

test('Rami Levy nationwide fallback covers 35+ hubs and preserves Beersheba IDs', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => { throw new Error('offline'); };
    try {
        const branches = await fetchRamiLevyBranches();
        assert.ok(branches.length >= 35, `Expected >=35 Rami Levy fallback branches, got ${branches.length}`);
        assert.strictEqual(branches.length, RAMI_LEVY_FALLBACK_BRANCHES.length);
        assert.ok(branches.every(b => b.network === 'rami_levy' && b.id && b.name && b.city));
        const ids = new Set(branches.map(b => b.id));
        assert.strictEqual(ids.size, branches.length, 'Rami Levy branch IDs must be unique');
        for (const keptId of ['82', '331', '332']) {
            assert.ok(ids.has(keptId), `Missing preserved Rami Levy Beersheba ID ${keptId}`);
        }
        for (const city of ['תל אביב - יפו', 'ירושלים', 'חיפה', 'אילת', 'באר שבע', 'מודיעין-מכבים-רעות', 'פרדס חנה-כרכור']) {
            assert.ok(branchesInCity(branches, city).length > 0, `Expected Rami Levy branch for ${city}`);
        }
    } finally {
        global.fetch = origFetch;
    }
});

test('Rami Levy live fetch normalizes endpoint payload when reachable', async () => {
    const origFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            data: [
                { id: 18, name: 'תל אביב', city_name: 'תל אביב - יפו', address: 'דרך בגין 132', areas: [{ name: 'תל אביב - יפו' }] },
                { id: 82, name: 'באר שבע', city_name: 'באר שבע', address: 'דרך חברון 29' }
            ]
        })
    });
    try {
        const branches = await fetchRamiLevyBranches();
        assert.strictEqual(branches.length, 2);
        assert.deepStrictEqual(branches[0], {
            id: '18',
            name: 'תל אביב',
            city: 'תל אביב - יפו',
            address: 'דרך בגין 132',
            areas: 'תל אביב - יפו',
            network: 'rami_levy'
        });
    } finally {
        global.fetch = origFetch;
    }
});
