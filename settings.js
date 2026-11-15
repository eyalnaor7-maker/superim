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
    cityInput.addEventListener('input', (e) => {
        const typed = e.target.value.trim();
        document.getElementById('city-list').replaceChildren(...citySuggestions(ISRAEL_CITIES, typed).map(c => new Option(c, c)));
        populateDropdowns(typed.length > 1 ? typed : ''); // one letter matches half the branches by accident
    });

    // טעינת הגדרות שמורות מקודם
    loadSavedSettings();

    // שמירה
    document.getElementById('save-btn').addEventListener('click', saveSettings);
});

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
    chrome.storage.sync.get(['userSettings', 'savedCity'], (data) => {
        const userSettings = data.userSettings || {};

        if (data.savedCity) {
            document.getElementById('city-input').value = data.savedCity;
            populateDropdowns(data.savedCity);
        }

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

    chrome.storage.sync.set({ userSettings: userSettings, savedCity: city }, () => {
        const status = document.getElementById('statusMessage');
        status.textContent = 'ההגדרות נשמרו';
        status.className = 'status-success';
        status.style.display = 'block';
        
        setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
    });
}

// ===== profile and feedback =====
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('profile-name');
    const share = document.getElementById('share-stats');
    chrome.storage.sync.get(['profile', 'shareStats'], d => {
        nameInput.value = d.profile?.name || '';
        share.checked = d.shareStats !== false;
    });
    nameInput.addEventListener('change', () => chrome.storage.sync.set({ profile: { name: nameInput.value.trim() } }));
    share.addEventListener('change', () => chrome.storage.sync.set({ shareStats: share.checked }));
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
