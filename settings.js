// settings.js

let allBranches = [];
const autoPicked = {}; // network key -> the current selection was our guess, not the user's

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const locationSection = document.getElementById('location-section');
    const settingsForm = document.getElementById('settings-form');
    const cityInput = document.getElementById('city-input');

    // טעינת רשימת הסניפים מכל הרשתות (מוגדר ב-branch_service.js)
    if (window.branchService && typeof window.branchService.getAllBranches === 'function') {
        allBranches = await window.branchService.getAllBranches();
    } else {
        console.error("branch_service.js not loaded properly.");
    }

    loadingDiv.style.display = 'none';
    locationSection.style.display = 'block';
    settingsForm.style.display = 'block';

    // איכלוס ראשוני של כל התפריטים
    populateDropdowns('');

    // מאזין לשינוי בעיר כדי לסנן
    cityInput.addEventListener('input', () => onCityTyped());
    // the street and the map follow only a committed city (blur or a picked suggestion), never a keystroke
    cityInput.addEventListener('change', () => locateAddress());

    const streetInput = document.getElementById('street-input');
    let streetTimer;
    streetInput.addEventListener('input', () => { clearTimeout(streetTimer); streetTimer = setTimeout(suggestStreets, 250); });
    streetInput.addEventListener('change', () => locateAddress());

    initMap();

    // טעינת הגדרות שמורות מקודם
    loadSavedSettings();

    // שמירה
    document.getElementById('save-btn').addEventListener('click', saveSettings);
});

// ===== address, street suggestions and map =====
const isCity = (name) => ISRAEL_CITIES.some(c => normCity(c) === normCity(name));

// refresh the city suggestions, the branch lists and the street field after the city text changed
function onCityTyped() {
    const typed = document.getElementById('city-input').value.trim();
    document.getElementById('city-list').replaceChildren(...citySuggestions(ISRAEL_CITIES, typed).map(c => new Option(c, c)));
    populateDropdowns(typed.length > 1 ? typed : ''); // one letter matches half the branches by accident
    const street = document.getElementById('street-input');
    const ready = isCity(typed);
    street.disabled = !ready;
    document.getElementById('street-hint').textContent = ready
        ? 'התחילו להקליד ובחרו מההצעות, כך הרחוב ייכתב כמו באתר רמי לוי.'
        : 'קודם בוחרים עיר.';
    if (!ready) document.getElementById('street-list').replaceChildren();
}

const ramiCityIds = new Map(); // city name -> Rami Levy city_id
async function ramiCityId(city) {
    if (ramiCityIds.has(city)) return ramiCityIds.get(city);
    const answer = await fetch(`https://www.rami-levy.co.il/api/address-autocomplete/city?q=${encodeURIComponent(city)}`).then(r => r.json());
    const entry = pickCityEntry(answer, city);
    if (entry) ramiCityIds.set(city, entry.city_id);
    return entry && entry.city_id;
}

let streetRequest = 0;
async function suggestStreets() {
    const city = document.getElementById('city-input').value.trim();
    const typed = document.getElementById('street-input').value.trim();
    const mine = ++streetRequest;
    if (!typed || !isCity(city)) return;
    try {
        const id = await ramiCityId(city);
        if (!id) return;
        const answer = await fetch(`https://www.rami-levy.co.il/api/address-autocomplete/street?q=${encodeURIComponent(typed)}&city_id=${id}`).then(r => r.json());
        if (mine === streetRequest) document.getElementById('street-list').replaceChildren(...streetNames(answer).map(s => new Option(s, s)));
    } catch (error) {
        console.error('Street suggestions failed', error); // free text still works
    }
}

// Nominatim allows one request per second: calls run one after another with a gap.
let nominatimQueue = Promise.resolve();
function nominatim(url) {
    const run = nominatimQueue.then(() => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }));
    nominatimQueue = run.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, 1100)));
    return run;
}

let map, marker, currentLatLng, mapRequest = 0;
const mapMessage = (text) => { document.getElementById('map-msg').textContent = text; };

function initMap() {
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    map = L.map('map', { center: [31.5, 34.9], zoom: 7, zoomAnimation: !calm, fadeAnimation: !calm, markerZoomAnimation: !calm });
    map.attributionControl.setPrefix(false);
    // openstreetmap.org's own tile servers answer extension pages with "403 Access blocked" (no Referer), and CARTO wants a key.
    // Israel Hiking Map serves OpenStreetMap data with Hebrew labels; its tiles are CC BY-NC-SA (free, non-commercial use).
    // shortcut: fine while the extension is free; a paid version needs a commercial tile provider with a key.
    L.tileLayer('https://israelhiking.osm.org.il/Hebrew/Tiles/{z}/{x}/{y}.png', {
        maxNativeZoom: 16,
        maxZoom: 18,
        attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · <a href="https://israelhiking.osm.org.il" target="_blank" rel="noopener">Israel Hiking Map</a>'
    }).on('tileerror', () => mapMessage('המפה לא נטענה כרגע. אפשר להמשיך לבחור עיר ורחוב בשדות.')).addTo(map);
    map.on('click', (e) => pickOnMap(e.latlng));
}

function placeMarker(lat, lng, zoom) {
    currentLatLng = { lat, lng };
    if (marker) marker.setLatLng([lat, lng]);
    else marker = L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 3, fillColor: '#047857', fillOpacity: 1 }).addTo(map);
    map.setView([lat, lng], zoom);
}

// street + city -> a point on the map; a street the geocoder does not know falls back to the city
async function locateAddress() {
    const city = document.getElementById('city-input').value.trim();
    if (!isCity(city)) return;
    const street = document.getElementById('street-input').value.trim();
    const mine = ++mapRequest;
    try {
        let found;
        for (const [text, zoom] of street ? [[geocodeQuery(street, city), 16], [geocodeQuery('', city), 12]] : [[geocodeQuery('', city), 12]]) {
            const results = await nominatim(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=il&limit=1&accept-language=he&q=${encodeURIComponent(text)}`);
            if (mine !== mapRequest) return; // a newer address replaced this one
            if (results[0]) { found = { lat: +results[0].lat, lng: +results[0].lon, zoom, exact: zoom === 16 || !street }; break; }
        }
        if (!found) return mapMessage('לא מצאנו את הכתובת במפה. אפשר להמשיך בלי המפה.');
        placeMarker(found.lat, found.lng, found.zoom);
        mapMessage(found.exact ? '' : 'לא מצאנו את הרחוב במפה, מוצג מרכז העיר.');
    } catch (error) {
        console.error('Geocoding failed', error);
        if (mine === mapRequest) mapMessage('איתור הכתובת במפה לא הצליח. אפשר להמשיך בלי המפה.');
    }
}

async function pickOnMap(latlng) {
    const mine = ++mapRequest;
    placeMarker(latlng.lat, latlng.lng, map.getZoom());
    mapMessage('מחפשים את הכתובת...');
    try {
        const answer = await nominatim(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=he&lat=${latlng.lat}&lon=${latlng.lng}`);
        if (mine !== mapRequest) return;
        const { city, street } = addressFromNominatim(answer, ISRAEL_CITIES);
        const cityInput = document.getElementById('city-input');
        if (city) {
            cityInput.value = city;
            onCityTyped();
        }
        if (city || isCity(cityInput.value.trim())) document.getElementById('street-input').value = street;
        mapMessage(city ? 'הכתובת מולאה מהמפה. כדאי לבחור את הרחוב מההצעות.' : 'לא זיהינו עיר מהרשימה, העיר נשארה כפי שהייתה.');
    } catch (error) {
        console.error('Reverse geocoding failed', error);
        if (mine === mapRequest) mapMessage('לא הצלחנו לזהות כתובת בנקודה הזו. אפשר למלא בשדות.');
    }
}

function branchOption(branch) {
    const option = new Option(`${branch.name}${branch.city && branch.city !== branch.name ? ` (${branch.city})` : ''}`, branch.id);
    option.dataset.name = branch.name;
    return option;
}

function populateDropdowns(cityFilter) {
    const networks = {
        'shufersal': document.getElementById('shufersal-branch'),
        'rami_levy': document.getElementById('rami-levy-branch'),
        'victory': document.getElementById('victory-branch'),
        'machsanei_hashuk': document.getElementById('mck-branch')
    };

    for (const [networkKey, selectEl] of Object.entries(networks)) {
        const currentValue = selectEl.value;
        const networkBranches = allBranches.filter(b => b.network === networkKey);
        const inCity = cityFilter ? branchesInCity(networkBranches, cityFilter) : [];
        const cityMatched = inCity.length > 0;
        // no branch in the city: offer the whole chain rather than an empty list
        const shown = cityMatched ? inCity : networkBranches;

        // an empty list means the chain's site did not answer: say so instead of looking like "no branches"
        const placeholder = networkBranches.length === 0 ? 'רשימת הסניפים לא נטענה — רעננו את הדף'
            : (cityFilter && !cityMatched ? 'אין סניף בעיר — בחרו סניף אחר' : '-- בחר סניף --');
        selectEl.replaceChildren(new Option(placeholder, ''), ...shown.map(branchOption));

        if (currentValue && !autoPicked[networkKey] && shown.some(b => b.id === currentValue)) {
            selectEl.value = currentValue; // the user's own choice stays while it is still offered
        } else if (cityMatched) {
            selectEl.value = shown[0].id;
            autoPicked[networkKey] = true;
        }
        selectEl.onchange = () => { autoPicked[networkKey] = false; };
        if (networkKey === 'victory' && cityFilter && !cityMatched && networkBranches.length > 0) suggestVictoryDeliveryBranch(cityFilter);
    }
}

// Victory has a branch in few cities but delivers to many more: ask its site which branch delivers to this city.
async function suggestVictoryDeliveryBranch(city) {
    if (!ISRAEL_CITIES.some(c => normCity(c) === normCity(city))) return; // a complete city name only, not every keystroke
    const id = await window.branchService.fetchVictoryDeliveryBranchId(city);
    const selectEl = document.getElementById('victory-branch');
    const option = id && Array.from(selectEl.options).find(o => o.value === id);
    const cityChanged = document.getElementById('city-input').value.trim() !== city;
    if (!option || cityChanged || (selectEl.value && !autoPicked.victory)) return; // the user's own choice always wins
    option.text = `${option.dataset.name} — משלוחים ל${city}`;
    selectEl.value = id;
    autoPicked.victory = true;
}

function loadSavedSettings() {
    chrome.storage.sync.get(['userSettings', 'savedCity', 'savedStreet', 'savedLatLng'], (data) => {
        const userSettings = data.userSettings || {};
        document.getElementById('street-input').value = data.savedStreet || '';

        if (data.savedCity) {
            document.getElementById('city-input').value = data.savedCity;
            onCityTyped();
        }
        const at = data.savedLatLng;
        if (at && Number.isFinite(at.lat) && Number.isFinite(at.lng)) placeMarker(at.lat, at.lng, 15);
        else if (data.savedCity) locateAddress(); // no saved point: find the saved city on the map

        [
            ['shufersal', 'shufersal-branch', userSettings.shufersal?.branchId],
            ['rami_levy', 'rami-levy-branch', userSettings.ramiLevy?.branchId],
            // an id saved before Victory's 2026 re-platform is a different id space, not a choice
            ['victory', 'victory-branch', userSettings.victory?.platform === 2 ? userSettings.victory.branchId : ''],
            ['machsanei_hashuk', 'mck-branch', userSettings.machsaneiHashuk?.branchId]
        ].forEach(([network, selectId, id]) => {
            const branch = id && allBranches.find(b => b.network === network && b.id === String(id));
            if (!branch) return;
            const selectEl = document.getElementById(selectId);
            // a saved branch outside the saved city must still be shown as selected
            if (!Array.from(selectEl.options).some(o => o.value === branch.id)) selectEl.appendChild(branchOption(branch));
            selectEl.value = branch.id;
            autoPicked[network] = false;
        });
    });
}

function saveSettings() {
    const city = document.getElementById('city-input').value.trim();
    
    const shufersalSelect = document.getElementById('shufersal-branch');
    const ramiLevySelect = document.getElementById('rami-levy-branch');
    const victorySelect = document.getElementById('victory-branch');
    const mckSelect = document.getElementById('mck-branch');

    const userSettings = {
        shufersal: {
            branchId: shufersalSelect.value,
            branchName: shufersalSelect.options[shufersalSelect.selectedIndex]?.dataset.name || ''
        },
        ramiLevy: {
            branchId: ramiLevySelect.value,
            branchName: ramiLevySelect.options[ramiLevySelect.selectedIndex]?.dataset.name || ''
        },
        victory: {
            platform: 2, // branch ids saved before Victory's 2026 re-platform are a different id space and are ignored
            branchId: victorySelect.value,
            branchName: victorySelect.options[victorySelect.selectedIndex]?.dataset.name || ''
        },
        machsaneiHashuk: {
            branchId: mckSelect.value,
            branchName: mckSelect.options[mckSelect.selectedIndex]?.dataset.name || ''
        }
    };

    const toSave = { userSettings: userSettings, savedCity: city, savedStreet: document.getElementById('street-input').value.trim() };
    if (currentLatLng) toSave.savedLatLng = currentLatLng;
    chrome.storage.sync.set(toSave, () => flash(document.getElementById('statusMessage'), 'ההגדרות נשמרו', 4000));
}

// a visible, announced confirmation that clears itself
const flashTimers = new Map();
function flash(el, text, ms = 3000) {
    el.textContent = text;
    el.classList.add('status-success');
    clearTimeout(flashTimers.get(el));
    flashTimers.set(el, setTimeout(() => { el.textContent = ''; }, ms));
}

// ===== profile and feedback =====
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('profile-name');
    const share = document.getElementById('share-stats');
    chrome.storage.sync.get(['profile', 'shareStats'], d => {
        nameInput.value = d.profile?.name || '';
        share.checked = d.shareStats !== false;
    });
    const auto = document.getElementById('auto-status');
    nameInput.addEventListener('change', () => chrome.storage.sync.set({ profile: { name: nameInput.value.trim() } }, () => flash(auto, 'השינוי נשמר')));
    share.addEventListener('change', () => chrome.storage.sync.set({ shareStats: share.checked }, () => flash(auto, 'השינוי נשמר')));
    chrome.storage.local.get('cartHistory', d => { document.getElementById('history-count').textContent = (d.cartHistory || []).length; });

    const message = document.getElementById('fb-message');
    const status = document.getElementById('fb-status');
    const sendBtn = document.getElementById('fb-send');
    sendBtn.addEventListener('click', async () => {
        const text = message.value.trim();
        if (text.length < 3) { status.textContent = 'כתבו כמה מילים לפני השליחה'; message.focus(); return; }
        sendBtn.disabled = true;
        status.textContent = 'שולח...';
        // the public key may only add a row to this table; it cannot read what others wrote
        const ok = await fetch(`${SUPABASE_URL}/rest/v1/feedback`, {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ message: text, contact: document.getElementById('fb-contact').value.trim() || null, ext_version: chrome.runtime.getManifest().version })
        }).then(r => r.ok).catch(() => false);
        sendBtn.disabled = false;
        status.textContent = ok ? 'תודה! המשוב התקבל' : 'השליחה לא הצליחה. נסו שוב מאוחר יותר';
        if (ok) message.value = '';
    });
    if (location.hash === '#feedback') message.focus(); // arriving from the popup's "שליחת משוב" link
});

// ===== optional account (Supabase Auth) =====
document.addEventListener('DOMContentLoaded', () => {
    const $ = id => document.getElementById(id);
    const status = $('acct-status');
    const say = text => { clearTimeout(flashTimers.get(status)); status.textContent = text; };
    const busy = on => document.querySelectorAll('#account button').forEach(b => { b.disabled = on; });
    const authCode = e => e.status === 429 ? 'rate_limited' : e.code === 'user_already_exists' ? 'user_exists' : e.code;
    const logEvent = name => { sb.rpc('log_my_event', { p_event: name }).then(() => {}, () => {}); };

    sb.auth.onAuthStateChange((_event, session) => {
        $('acct-out').hidden = !!session;
        $('acct-in').hidden = !session;
        $('acct-confirm').hidden = true;
        $('acct-who').textContent = session?.user?.email || '';
    });

    $('acct-signin').addEventListener('click', async () => {
        busy(true); say('מתחבר...');
        const { error } = await sb.auth.signInWithPassword({ email: $('acct-email').value.trim(), password: $('acct-pass').value });
        busy(false);
        if (error) return say(friendlyError(error));
        $('acct-pass').value = '';
        say('התחברת בהצלחה');
        logEvent('sign_in');
    });
    $('acct-signup').addEventListener('click', async () => {
        busy(true); say('נרשם...');
        const { error } = await sb.auth.signUp({ email: $('acct-email').value.trim(), password: $('acct-pass').value });
        busy(false);
        say(error ? friendlyError(error) : 'שלחנו אליך מייל לאישור. אחרי האישור אפשר להתחבר.');
    });
    $('acct-signout').addEventListener('click', async () => {
        await sb.rpc('log_my_event', { p_event: 'sign_out' }).then(() => {}, () => {});
        await sb.auth.signOut();
        say('התנתקת');
    });
    $('acct-delete').addEventListener('click', () => { $('acct-confirm').hidden = false; $('acct-yes').focus(); });
    $('acct-no').addEventListener('click', () => { $('acct-confirm').hidden = true; $('acct-delete').focus(); });
    $('acct-yes').addEventListener('click', async () => {
        busy(true); say('מוחק...');
        const { error } = await sb.rpc('delete_my_account');
        if (error) { busy(false); return say(friendlyError(authCode(error) || 'unavailable')); }
        await sb.auth.signOut({ scope: 'local' });
        await chrome.storage.local.clear();
        await chrome.storage.sync.clear();
        say('החשבון נמחק');
        setTimeout(() => location.reload(), 2000);
    });
});
