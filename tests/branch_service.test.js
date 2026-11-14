const test = require('node:test');
const assert = require('node:assert');
const { citySuggestions, branchesInCity } = require('../branch_service.js');

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

test('branchesInCity: a street named after a city does not beat a branch in that city', () => {
    const motzkin = { name: 'מוצקין', city: 'קרית מוצקין', address: 'שד ירושלים 1 נווה גנים, קרית מוצקין', areas: '' };
    const malha = { name: 'מלחה', city: 'ירושלים', address: 'קניון מלחה, ירושלים', areas: '' };
    const noCity = { name: 'אשקלון מרכז', city: 'אשקלון מרכז', address: 'יצחק בן צבי 48', areas: '' };
    assert.deepStrictEqual(branchesInCity([motzkin, malha, noCity], 'ירושלים'), [malha]);
    // the address is still used when it is the only clue
    assert.deepStrictEqual(branchesInCity([motzkin, noCity], 'ירושלים'), [motzkin]);
});
