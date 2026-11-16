const test = require('node:test');
const assert = require('node:assert');
const { pickCityEntry, streetNames, addressFromNominatim, geocodeQuery } = require('../address.js');

test('pickCityEntry prefers the exact city name, else the first entry', () => {
    const answer = { data: [{ city_name: 'באר שבע - צפון', city_id: 1 }, { city_name: 'באר שבע', city_id: 2 }] };
    assert.strictEqual(pickCityEntry(answer, 'באר שבע').city_id, 2);
    assert.strictEqual(pickCityEntry(answer, 'עומר').city_id, 1);
    assert.strictEqual(pickCityEntry({ data: [] }, 'עומר'), null);
    assert.strictEqual(pickCityEntry(null, 'עומר'), null);
});

test('streetNames drops empty and repeated names', () => {
    assert.deepStrictEqual(streetNames({ data: [{ street_name: 'רגר' }, { street_name: 'רגר' }, { street_name: '' }] }), ['רגר']);
    assert.deepStrictEqual(streetNames(undefined), []);
});

test('addressFromNominatim matches the city against the official list', () => {
    const cities = ['תל אביב - יפו', 'קריית גת'];
    assert.deepStrictEqual(addressFromNominatim({ address: { city: 'תל אביב-יפו', road: 'דיזנגוף' } }, cities), { city: 'תל אביב - יפו', street: 'דיזנגוף' });
    assert.deepStrictEqual(addressFromNominatim({ address: { town: 'קרית גת' } }, cities), { city: 'קריית גת', street: '' });
    assert.deepStrictEqual(addressFromNominatim({ address: { village: 'מקום לא קיים', road: 'הגפן' } }, cities), { city: null, street: 'הגפן' });
    assert.deepStrictEqual(addressFromNominatim({}, cities), { city: null, street: '' });
});

test('geocodeQuery skips empty parts', () => {
    assert.strictEqual(geocodeQuery('הגפן', 'עומר'), 'הגפן, עומר, ישראל');
    assert.strictEqual(geocodeQuery('', 'עומר'), 'עומר, ישראל');
});
