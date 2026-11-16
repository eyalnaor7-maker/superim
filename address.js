// Pure address helpers for settings.js. Needs normCity from branch_service.js.
const addressNormCity = typeof normCity === 'function' ? normCity : require('./branch_service.js').normCity;

// Rami Levy's city lookup: the entry named exactly like the chosen city, else the first one.
function pickCityEntry(answer, city) {
    const list = Array.isArray(answer && answer.data) ? answer.data : [];
    return list.find(e => addressNormCity(e.city_name) === addressNormCity(city)) || list[0] || null;
}

// Street names for the datalist, without repeats.
function streetNames(answer) {
    const list = Array.isArray(answer && answer.data) ? answer.data : [];
    return [...new Set(list.map(e => String(e.street_name || '').trim()).filter(Boolean))];
}

// Nominatim reverse answer -> the official city name (null when it is not in the list) and the street.
function addressFromNominatim(answer, cities) {
    const a = (answer && answer.address) || {};
    const place = a.city || a.town || a.village || a.municipality || '';
    const city = cities.find(c => addressNormCity(c) === addressNormCity(place)) || null;
    return { city, street: a.road || '' };
}

// Search text for the geocoder: only the parts that exist.
function geocodeQuery(street, city) {
    return [street, city, 'ישראל'].map(s => String(s || '').trim()).filter(Boolean).join(', ');
}

if (typeof module !== 'undefined') module.exports = { pickCityEntry, streetNames, addressFromNominatim, geocodeQuery };
