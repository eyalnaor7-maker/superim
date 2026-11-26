// ===== STATE =====
let finalCartToTransfer = [];

// ===== UTILITIES =====
const formatPrice = amount => `₪${parseFloat(amount || 0).toFixed(2)}`;

function sbFetch(path, options = {}) {
    return fetch(`${SUPABASE_URL}${path}`, {
        ...options,
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
}

let pricesData = {};

function buildDbItemData(p) {
    const subList = Array.isArray(p.substitutes) ? p.substitutes : (p.substitutes ? [p.substitutes] : []);
    const activeSub = subList.find(s => s && s.status !== 'rejected') || null;
    const itemData = {
        name: p.name,
        unit_qty: p.unit_qty != null ? Number(p.unit_qty) : null,
        unit_type: p.unit_type || null,
        substitute_status: activeSub?.status || null,
        shufersal_price: null,
        rami_levy_price: null,
        rami_levy_code: null,
        victory_code: null,
        victory_price: null,
        machsanei_hashuk_price: null,
        machsanei_hashuk_code: null,
        substitutes: activeSub ? [activeSub.substitute_barcode_1, activeSub.substitute_barcode_2].filter(Boolean) : []
    };
    if (p.store_products) {
        p.store_products.forEach(sp => {
            itemData[`${sp.store_name}_price`] = sp.price != null ? parseFloat(sp.price) : null;
            itemData[`${sp.store_name}_code`] = sp.store_code;
            itemData[`${sp.store_name}_updated_at`] = sp.updated_at || null;
            if (sp.store_name === 'victory') {
                itemData.victory_retailer_id = sp.store_code;
            }
        });
    }
    return itemData;
}

// ===== AI SUBSTITUTE ENGINE HELPERS =====
async function fetchSubstituteDetails(substituteBarcodes, headers) {
    if (!substituteBarcodes || substituteBarcodes.length === 0) return;

    const missingBarcodes = substituteBarcodes.filter(b => {
        const xmlKey = b.startsWith('P_') ? b : `P_${b}`;
        const rawKey = b.replace('P_', '');
        return !pricesData[xmlKey] && !pricesData[rawKey];
    });

    if (missingBarcodes.length === 0) return;

    const queryParams = new URLSearchParams({
        select: 'barcode,name,unit_qty,unit_type,store_products(store_name,store_code,price,updated_at)',
        barcode: `in.(${missingBarcodes.join(',')})`
    });

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, { headers });
        if (!response.ok) throw new Error(`Substitutes details query failed: ${response.statusText}`);
        const products = await response.json();

        products.forEach(p => {
            const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
            const itemData = buildDbItemData(p);
            pricesData[xmlKey] = itemData;
            pricesData[xmlKey.replace('P_', '')] = itemData;
        });
    } catch (err) {
        console.error("שגיאה בטעינת פרטי תחליפים מ-Supabase:", err);
    }
}

// ===== CHROME HELPERS =====
// The extension runs in its own window (popup.html?tabId=N, opened by background.js) so the shopper can move it off the cart.
const DETACHED_TAB_ID = Number(new URLSearchParams(location.search).get('tabId')) || null;
let targetWindowId = null; // the browser window of the store tab: new tabs must open there, not in the detached window

async function getTargetTab() {
    let tab = null;
    if (DETACHED_TAB_ID) {
        tab = await chrome.tabs.get(DETACHED_TAB_ID).catch(() => null);
        if (!tab) tab = (await chrome.tabs.query({ active: true, windowType: 'normal' }))[0] || null; // the store tab was closed
    } else {
        tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
    }
    if (tab) targetWindowId = tab.windowId;
    return tab;
}

function openTab(url, active = true) {
    return chrome.tabs.create({ url, active, ...(targetWindowId ? { windowId: targetWindowId } : {}) });
}

// The window remembers where the shopper put it; background.js opens the next one at the same place.
async function rememberWindowPosition() {
    const me = await chrome.windows.getCurrent();
    chrome.windows.onBoundsChanged.addListener(w => {
        if (w.id === me.id) chrome.storage.local.set({ winPos: { left: w.left, top: w.top } });
    });
}

function createHiddenTab(url) {
    return openTab(url, false);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchInHiddenWindow(url, func, args = []) {
    const tab = await createHiddenTab(url);
    try {
        // wait until the tab is on the chain's site and has finished loading (or has been there 6s: some pages never settle)
        const origin = new URL(url).origin;
        let arrivedAt = 0;
        for (let i = 0; i < 160; i++) {
            const t = await chrome.tabs.get(tab.id).catch(() => null);
            if (!t) break;
            const there = String(t.url || '').startsWith(origin);
            if (there && !arrivedAt) arrivedAt = Date.now();
            if (there && (t.status === 'complete' || Date.now() - arrivedAt > 6000)) break;
            await sleep(120);
        }
        await sleep(150);
        // a page that reloads under the script (a redirect, a bot check) gives no answer: try once more
        for (let attempt = 0; attempt < 2; attempt++) {
            const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args }).catch(() => null);
            if (results?.[0]?.result != null) return results[0].result;
            if (attempt === 0) await sleep(1200);
        }
        return null;
    } finally {
        chrome.tabs.remove(tab.id);
    }
}

// ===== SETTINGS =====
async function loadSettings() {
    return new Promise(resolve => {
        chrome.storage.sync.get(['settings', 'userSettings'], result => {
            // settings = store toggles (shufersal/ramiLevy/victory/machsaneiHashuk)
            // userSettings = credentials + branchIds
            resolve({
                ...(result.settings || { shufersal: true, ramiLevy: true, victory: true, machsaneiHashuk: true }),
                userSettings: result.userSettings || {}
            });
        });
    });
}

async function saveSettings(settings) {
    return new Promise(resolve => chrome.storage.sync.set({ settings }, resolve));
}

// ===== REVERSE LOOKUP DICTIONARY =====
function findShufersalDataByRamiLevy(ramiLevyCode, pricesData) {
    for (const [shufersalBarcode, itemData] of Object.entries(pricesData)) {
        if (String(itemData.rami_levy_code) === String(ramiLevyCode)) {
            return {
                shufersal_code: shufersalBarcode,
                name: itemData.name,
                unit_qty: itemData.unit_qty ?? null,
                unit_type: itemData.unit_type ?? null,
                substitute_status: itemData.substitute_status ?? null,
                victory_code: itemData.victory_code,
                shufersal_price: itemData.shufersal_price,
                victory_price: itemData.victory_price,
                victory_retailer_id: itemData.victory_retailer_id,
                machsanei_hashuk_price: itemData.machsanei_hashuk_price ?? null,
                machsanei_hashuk_code: itemData.machsanei_hashuk_code ?? null,
                machsanei_hashuk_updated_at: itemData.machsanei_hashuk_updated_at ?? null,
                substitutes: itemData.substitutes || []
            };
        }
    }
    return null;
}

// ===== RAMI LEVY CATALOG SEARCH =====

async function initSettings() {
    let currentUrl = '';
    try {
        const tab = await getTargetTab();
        currentUrl = tab ? (tab.url || '') : '';
    } catch (e) {
        console.warn("Failed to query active tab for settings:", e);
    }
    const activeStore = detectActiveStore(currentUrl);
    const settings = await loadSettings();

    const storeNames = { shufersal: 'שופרסל', ramiLevy: 'רמי לוי', victory: 'ויקטורי', machsaneiHashuk: 'מחסני השוק' };
    const onStoreSite = /shufersal\.co\.il|rami-levy\.co\.il|victory|mck\.co\.il/.test(currentUrl);
    const { profile } = await chrome.storage.sync.get('profile');
    const hello = profile?.name ? `שלום ${profile.name}, ` : '';
    document.getElementById('startHeadline').textContent = hello + (onStoreSite
        ? `זיהינו עגלה ב${storeNames[activeStore]}`
        : 'פתחו את העגלה באתר של אחת הרשתות');

    // Check if any branches are missing
    const isMissingSettings = 
        !settings.userSettings?.shufersal?.branchId || 
        !settings.userSettings?.victory?.branchId || 
        !settings.userSettings?.machsaneiHashuk?.branchId;
        
    if (isMissingSettings && !document.getElementById('missingSettingsWarn')) {
        const warning = document.createElement('div');
        warning.id = 'missingSettingsWarn';
        warning.innerHTML = 'להשוואה מדויקת, <a href="#" style="color:#856404; text-decoration:underline;">הגדר את הסניפים שלך</a>';
        warning.style = 'background: #fff3cd; color: #856404; padding: 10px; text-align: center; font-size: 13px; font-weight: bold; cursor: pointer; border-bottom: 1px solid #ffeeba;';
        warning.onclick = () => openTab(chrome.runtime.getURL('settings.html'));
        const storePanel = document.getElementById('storePanel');
        if (storePanel && storePanel.parentNode) {
            storePanel.parentNode.insertBefore(warning, storePanel);
        }
    }
    const shufersalCheck = document.getElementById('toggleShufersal');
    const ramiCheck = document.getElementById('toggleRamiLevy');
    const victoryCheck = document.getElementById('toggleVictory');
    const mckCheck = document.getElementById('toggleMCK');

    const shufersalNote = document.getElementById('noteShufersal');
    const ramiNote = document.getElementById('noteRamiLevy');
    const victoryNote = document.getElementById('noteVictory');
    const mckNote = document.getElementById('noteMCK');

    // Reset notes
    if (shufersalNote) shufersalNote.innerText = "מחיר ממאגר הנתונים";
    if (ramiNote) ramiNote.innerText = "מחיר חי בזמן אמת";
    if (victoryNote) victoryNote.innerText = "מחיר חי בזמן אמת";
    if (mckNote) mckNote.innerText = "מחיר חי בזמן אמת";

    function setupToggle(element, noteElement, storeKey) {
        if (!element) return;
        if (activeStore === storeKey) {
            element.checked = true;
            element.disabled = true;
            if (noteElement) {
                noteElement.innerText = "הסופר הנוכחי שלך (תמיד פעיל)";
                noteElement.style.color = "#10b981"; // ירוק אמרלד מודרני
            }
        } else {
            element.checked = settings[storeKey] !== false;
            element.disabled = false;
            if (noteElement) noteElement.style.color = "";
        }
    }

    setupToggle(shufersalCheck, shufersalNote, 'shufersal');
    setupToggle(ramiCheck, ramiNote, 'ramiLevy');
    setupToggle(victoryCheck, victoryNote, 'victory');
    setupToggle(mckCheck, mckNote, 'machsaneiHashuk');

    async function saveCurrentSettings() {
        const s = await loadSettings();
        await saveSettings({
            ...s,
            shufersal: shufersalCheck ? shufersalCheck.checked : true,
            ramiLevy: ramiCheck ? ramiCheck.checked : true,
            victory: victoryCheck ? victoryCheck.checked : true,
            machsaneiHashuk: mckCheck ? mckCheck.checked : true
        });
    }

    if (shufersalCheck) shufersalCheck.addEventListener('change', saveCurrentSettings);
    if (ramiCheck) ramiCheck.addEventListener('change', saveCurrentSettings);
    if (victoryCheck) victoryCheck.addEventListener('change', saveCurrentSettings);
    if (mckCheck) mckCheck.addEventListener('change', saveCurrentSettings);

    document.getElementById('settingsBtn').addEventListener('click', () => {
        document.getElementById('storePanel').classList.toggle('open');
    });

    // כפתור פתיחת דף הגדרות המשתמש
    const userSettingsBtn = document.getElementById('userSettingsBtn');
    if (userSettingsBtn) {
        userSettingsBtn.addEventListener('click', () => {
            openTab(chrome.runtime.getURL('settings.html'));
        });
    }
    document.getElementById('feedbackLink').addEventListener('click', () => openTab(chrome.runtime.getURL('settings.html#feedback')));
    document.getElementById('historyLink').addEventListener('click', showHistory);
}

// ===== MAIN COMPARISON FLOW =====
// Called with nothing: scans the cart in the store tab. Called with a cart from "הסלים שלי": compares that cart
// in every chain with live prices and scans no tab (there is then no "active" store).
async function compareCarts(saved, aiNote, bypassCache = false) { // aiNote: the AI already ran for this cart, so it does not run again
    saved = saved && Array.isArray(saved.raw) ? saved : null; // a button click passes its event here
    const statusDiv = document.getElementById('status');
    const resultDiv = document.getElementById('result');
    const compareBtn = document.getElementById('compareBtn');

    statusDiv.innerHTML = '';
    resultDiv.innerHTML = '';
    document.getElementById('startView').hidden = false;
    finalCartToTransfer = [];
    compareBtn.disabled = true;
    const loading = document.getElementById('loading');
    loading.hidden = false;
    const stopSphere = startSphere(document.getElementById('sphere'));

    document.getElementById('storePanel').classList.remove('open');

    let currentStep = 'init';
    let currentStore = '';

    try {
        const settings = await loadSettings();
        const compareShufersal = settings.shufersal !== false;
        const compareRamiLevy = settings.ramiLevy !== false;
        const compareVictory = settings.victory !== false;
        const compareMCK = settings.machsaneiHashuk !== false;

        const tab = await getTargetTab();

        if (!tab && !saved) {
            throw new Error("לא נמצאה לשונית פעילה. נסה לרענן את העמוד.");
        }

        const currentUrl = tab?.url || '';

        // ★ זיהוי זירה ★
        const activeStore = saved ? null : detectActiveStore(currentUrl);
        currentStore = activeStore || (saved ? saved.store : '') || '';
        const codeStore = saved ? saved.store : activeStore; // the chain whose product codes the cart lines carry
        let activeStoreName = 'שופרסל';
        let scanFunc = scanShufersalCart;

        if (activeStore === 'ramiLevy') {
            scanFunc = scanRamiLevyCart;
            activeStoreName = 'רמי לוי';
        } else if (activeStore === 'victory') {
            scanFunc = scanVictoryCart;
            activeStoreName = 'ויקטורי';
        } else if (activeStore === 'machsaneiHashuk') {
            scanFunc = scanMCKCart;
            activeStoreName = 'מחסני השוק';
        }

        // 1. Scan active cart
        currentStep = 'scan_cart';
        statusDiv.textContent = saved ? 'טוען את הסל השמור...' : `סורק עגלה מ${activeStoreName}...`;

        const delivery = {}; // store key -> { fee, note, minOrder }: what delivery costs there, as the chain itself states it
        const slotDays = {}; // store key -> deliveryFromDays(): the fee per delivery day, where the chain gives it
        // a saved cart brings only what was bought; its old prices are not reused
        let rawCartItems = saved ? saved.raw.map(({ code, name, quantity }) => ({ code, name, quantity })) : [];
        if (!saved) try {
            const scanArgs = activeStore === 'machsaneiHashuk' ? [settings.userSettings?.machsaneiHashuk?.branchId || null] : [];
            const scriptResults = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: scanFunc,
                args: scanArgs
            });

            if (scriptResults && scriptResults[0] && Array.isArray(scriptResults[0].result)) {
                rawCartItems = scriptResults[0].result;
                if (activeStore === 'ramiLevy') {
                    const fee = ramiDeliveryFee(rawCartItems);
                    if (fee != null) delivery.ramiLevy = { fee };
                    rawCartItems = ramiCartLines(rawCartItems);
                }
                if (activeStore === 'shufersal') {
                    const feeResult = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: async () => {
                        const m = document.body.textContent.match(/דמי שירות במשלוח\s*([\d.]+)/);
                        let slotFees = {};
                        try {
                            const r = await fetch('/online/he/timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false');
                            const slots = r.ok ? await r.json() : {};
                            slotFees = Object.fromEntries(Object.entries(slots || {}).map(([day, list]) => [
                                day.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
                                (Array.isArray(list) ? list : []).filter(x => x && x.selectable !== false).map(x => x.price && x.price.value)
                            ]));
                        } catch (e) { }
                        return { fee: m ? parseFloat(m[1]) : null, slotFees };
                    } });
                    const sh = feeResult?.[0]?.result;
                    if (sh?.fee != null) delivery.shufersal = { fee: sh.fee };
                    slotDays.shufersal = deliveryFromDays(sh?.slotFees);
                }
            }
        } catch (err) {
            console.warn("שגיאת סריקה (כנראה עמוד שגוי):", err);
            throw new Error(`לא ניתן לסרוק את העמוד הזה. אנא ודא שאתה נמצא באתר של ${activeStoreName} ולא בעמוד אחר.`);
        }

        if (!rawCartItems || rawCartItems.length === 0) {
            statusDiv.innerHTML = 'לא מצאתי מוצרים בעגלה.';
            compareBtn.disabled = false;
            return;
        }

        // 2. Query Database (products, substitutes, weighed_staples)
        currentStep = 'supabase_lookup';
        const codes = rawCartItems.map(item => item.code);

        statusDiv.innerHTML = 'טוען נתונים מ-Supabase...';
        pricesData = {};
        const headers = {
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json"
        };

        const weighedStaplesPromise = fetch(
            `${SUPABASE_URL}/rest/v1/weighed_staples?select=staple_key,canonical_he,aliases,search_query,unit_type,shufersal_bc,rami_levy_id,victory_query,mck_query`,
            { headers }
        ).then(r => r.ok ? r.json() : []).catch(() => []);

        if (codeStore === 'shufersal') {
            const barcodesList = [];
            codes.forEach(c => {
                if (c.startsWith('P_')) {
                    barcodesList.push(c, c.substring(2));
                } else {
                    barcodesList.push(c, 'P_' + c);
                }
            });
            const queryParams = new URLSearchParams({
                select: 'barcode,name,unit_qty,unit_type,store_products(store_name,store_code,price,updated_at),substitutes!substitutes_original_barcode_fkey(substitute_barcode_1,substitute_barcode_2,status)',
                barcode: `in.(${barcodesList.join(',')})`
            });
            try {
                const products = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, { headers }).then(r => r.ok ? r.json() : []);
                products.forEach(p => {
                    const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
                    const itemData = buildDbItemData(p);
                    pricesData[xmlKey] = itemData;
                    pricesData[xmlKey.replace('P_', '')] = itemData;
                });
            } catch (err) {
                console.error("שגיאה בפנייה ל-Supabase (shufersal):", err);
            }
        } else if (codeStore === 'ramiLevy') {
            const dbQueryCodes = [];
            codes.forEach(c => {
                dbQueryCodes.push(c, c.startsWith('P_') ? c.substring(2) : 'P_' + c);
            });
            const queryParams = new URLSearchParams({
                select: 'store_code,products(barcode,name,unit_qty,unit_type,store_products(store_name,store_code,price,updated_at),substitutes!substitutes_original_barcode_fkey(substitute_barcode_1,substitute_barcode_2,status))',
                store_name: 'eq.rami_levy',
                store_code: `in.(${dbQueryCodes.join(',')})`
            });
            try {
                const res = await fetch(`${SUPABASE_URL}/rest/v1/store_products?${queryParams}`, { headers });
                if (!res.ok) throw new Error(`Supabase query failed: ${res.statusText}`);
                const storeProducts = await res.json();
                storeProducts.forEach(sp => {
                    const p = sp.products;
                    if (!p) return;
                    const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
                    const itemData = buildDbItemData(p);
                    pricesData[xmlKey] = itemData;
                    pricesData[xmlKey.replace('P_', '')] = itemData;
                });
            } catch (err) {
                console.error("שגיאה בפנייה ל-Supabase (ramiLevy):", err);
            }
        } else if (codeStore === 'victory' || codeStore === 'machsaneiHashuk') {
            const barcodesList = codes.map(c => c.startsWith('P_') ? c : `P_${c}`);
            const queryParams = new URLSearchParams({
                select: 'barcode,name,unit_qty,unit_type,store_products(store_name,store_code,price,updated_at),substitutes!substitutes_original_barcode_fkey(substitute_barcode_1,substitute_barcode_2,status)',
                barcode: `in.(${barcodesList.join(',')})`
            });
            try {
                const products = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, { headers }).then(r => r.ok ? r.json() : []);
                products.forEach(p => {
                    const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
                    const itemData = buildDbItemData(p);
                    pricesData[xmlKey] = itemData;
                });
            } catch (err) {
                console.error("שגיאה בפנייה ל-Supabase:", err);
            }
        }

        const weighedStaples = await weighedStaplesPromise;

        // products our database does not know (e.g. a chain's own brand): use the product the AI matched them to, if any
        const DB_STORE = { shufersal: 'shufersal', ramiLevy: 'rami_levy', victory: 'victory', machsaneiHashuk: 'machsanei_hashuk' };
        const isKnown = item => codeStore === 'ramiLevy' ? !!findShufersalDataByRamiLevy(item.code, pricesData)
            : !!(pricesData[item.code] || pricesData['P_' + String(item.code).replace(/^P_/, '')]);
        const unknownItems = rawCartItems.filter(i => !isKnown(i));
        if (unknownItems.length && headers) try {
            const q = new URLSearchParams({
                select: 'store_code,products(barcode,name,unit_qty,unit_type,store_products(store_name,store_code,price,updated_at))',
                store_name: `eq.${DB_STORE[codeStore]}`,
                store_code: `in.(${unknownItems.map(i => `"${String(i.code).replace(/["\\]/g, '')}"`).join(',')})`
            });
            const matches = await fetch(`${SUPABASE_URL}/rest/v1/ai_matches?${q}`, { headers }).then(r => r.ok ? r.json() : []);
            matches.forEach(m => {
                const p = m.products;
                if (!p) return;
                const data = buildDbItemData(p);
                unknownItems.filter(i => String(i.code) === m.store_code).forEach(i => {
                    i.ai_match = { storeName: DB_STORE[codeStore], storeCode: String(i.code) };
                    i.name = `${i.name} (מושווה מול: ${p.name})`;
                    // Rami Levy lines are found by their Rami Levy id; the others by barcode, so they take the match's barcode
                    if (codeStore === 'ramiLevy') pricesData[p.barcode] = { ...data, rami_levy_code: i.code };
                    else { i.code = p.barcode; pricesData[p.barcode] = data; }
                });
            });
        } catch (e) { console.warn('AI matches lookup failed', e); }

        const substituteBarcodes = [];
        Object.values(pricesData).forEach(item => {
            if (item.substitutes) {
                item.substitutes.forEach(b => {
                    substituteBarcodes.push(b.startsWith('P_') ? b : `P_${b}`);
                    substituteBarcodes.push(b.replace('P_', ''));
                });
            }
        });
        if (substituteBarcodes.length > 0) {
            statusDiv.innerHTML = 'טוען פרטי מוצרים תחליפיים...';
            const uniqueSubs = Array.from(new Set(substituteBarcodes));
            await fetchSubstituteDetails(uniqueSubs, headers);
        }

        // 3. Map products
        currentStep = 'map_products';
        const matchedItems = [];
        const missingItems = [];
        const itemsForShufersal = [];
        const itemsForRamiLevy = [];
        const itemsForVictory = [];
        const itemsForMCK = [];

        rawCartItems.forEach(item => {
            let dbItem = null;
            let cleanBarcode = '';
            let shufersalCode = '';

            if (codeStore === 'ramiLevy') {
                const reverseMatch = findShufersalDataByRamiLevy(item.code, pricesData);
                if (reverseMatch) {
                    shufersalCode = reverseMatch.shufersal_code;
                    cleanBarcode = shufersalCode.replace('P_', '');
                    dbItem = { ...reverseMatch, rami_levy_code: item.code };
                }
            } else {
                shufersalCode = item.code;
                const xmlKey = shufersalCode.startsWith('P_') ? shufersalCode : `P_${shufersalCode}`;
                dbItem = pricesData[shufersalCode] || pricesData[xmlKey];
                cleanBarcode = shufersalCode.replace('P_', '');
                if (!dbItem) {
                    const matchingKey = Object.keys(pricesData).find(k => k.endsWith(cleanBarcode));
                    if (matchingKey) dbItem = pricesData[matchingKey];
                }
            }

            if (dbItem) {
                const s_total = activeStore === 'shufersal' ? item.shufersal_total : (dbItem.shufersal_price || 0) * item.quantity;
                const rl_live_total = activeStore === 'ramiLevy' ? item.rami_levy_total : null;
                const v_live_total = activeStore === 'victory' ? item.victory_total : null;
                const mck_live_total = activeStore === 'machsaneiHashuk' ? item.mck_total : null;

                matchedItems.push({
                    name: item.name,
                    quantity: item.quantity,
                    shufersal_code: shufersalCode,
                    original_barcode: shufersalCode.startsWith('P_') ? shufersalCode : `P_${shufersalCode}`,
                    unit_qty: dbItem.unit_qty ?? null,
                    unit_type: dbItem.unit_type ?? null,
                    substitute_status: dbItem.substitute_status ?? null,
                    ai_match: item.ai_match || null,
                    shufersal_total: s_total,
                    shufersal_price_unit: dbItem.shufersal_price != null ? dbItem.shufersal_price : null,
                    backup_target_code: dbItem.rami_levy_code ? String(dbItem.rami_levy_code) : null,
                    rami_levy_price_unit: dbItem.rami_levy_price != null ? dbItem.rami_levy_price : null,
                    victory_code: dbItem.victory_code || null,
                    victory_retailer_id: dbItem.victory_retailer_id || null,
                    victory_price_unit: dbItem.victory_price != null ? dbItem.victory_price : null,
                    mck_price_unit: dbItem.machsanei_hashuk_price != null ? dbItem.machsanei_hashuk_price : null,
                    mck_updated_at: dbItem.machsanei_hashuk_updated_at || null,
                    rl_live_total,
                    v_live_total,
                    mck_live_total,
                    substitutes: dbItem.substitutes || []
                });

                if (activeStore !== 'shufersal') {
                    itemsForShufersal.push({ barcode: cleanBarcode, name: item.name, quantity: item.quantity });
                    if (dbItem.substitutes) {
                        dbItem.substitutes.forEach(subBarcode => {
                            itemsForShufersal.push({
                                barcode: subBarcode.replace('P_', ''),
                                name: `[תחליף] ${item.name}`,
                                quantity: item.quantity
                            });
                        });
                    }
                }

                if (activeStore !== 'ramiLevy' && dbItem.rami_levy_code) {
                    itemsForRamiLevy.push({ id: String(dbItem.rami_levy_code), barcode: cleanBarcode, quantity: item.quantity });
                    if (dbItem.substitutes) {
                        dbItem.substitutes.forEach(subBarcode => {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem && subItem.rami_levy_code) {
                                itemsForRamiLevy.push({
                                    id: String(subItem.rami_levy_code),
                                    barcode: subBarcode.replace('P_', ''),
                                    quantity: item.quantity
                                });
                            }
                        });
                    }
                }

                if (activeStore !== 'victory') {
                    itemsForVictory.push({
                        barcode: cleanBarcode,
                        name: item.name,
                        quantity: item.quantity,
                        retailerProductId: dbItem.victory_retailer_id || null
                    });
                    if (dbItem.substitutes) {
                        dbItem.substitutes.forEach(subBarcode => {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem) {
                                itemsForVictory.push({
                                    barcode: subBarcode.replace('P_', ''),
                                    name: `[תחליף] ${subItem.name}`,
                                    quantity: item.quantity,
                                    retailerProductId: subItem.victory_retailer_id || null
                                });
                            }
                        });
                    }
                }

                if (activeStore !== 'machsaneiHashuk') {
                    itemsForMCK.push({
                        barcode: cleanBarcode,
                        name: item.name,
                        quantity: item.quantity,
                        retailerProductId: null
                    });
                    if (dbItem.substitutes) {
                        dbItem.substitutes.forEach(subBarcode => {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem) {
                                itemsForMCK.push({
                                    barcode: subBarcode.replace('P_', ''),
                                    name: subItem.name,
                                    quantity: item.quantity,
                                    retailerProductId: null
                                });
                            }
                        });
                    }
                }
            } else {
                // Fallback for unbarcoded/weighed produce & meat items using weighed_staples
                const staple = typeof matchWeighedStaple === 'function' ? matchWeighedStaple(item.name, weighedStaples) : null;
                if (staple) {
                    const stapleKey = `W_${staple.staple_key}`;
                    const shufCode = staple.shufersal_bc || stapleKey;
                    const unitType = staple.unit_type || 'g';
                    const unitQty = unitType === 'unit' ? 1 : 1000;

                    matchedItems.push({
                        name: item.name,
                        quantity: item.quantity,
                        shufersal_code: shufCode,
                        original_barcode: null,
                        weighed_key: stapleKey,
                        unit_qty: unitQty,
                        unit_type: unitType,
                        substitute_status: null,
                        ai_match: null,
                        shufersal_total: activeStore === 'shufersal' ? item.shufersal_total : null,
                        shufersal_price_unit: null,
                        backup_target_code: staple.rami_levy_id ? String(staple.rami_levy_id) : null,
                        rami_levy_price_unit: null,
                        victory_code: null,
                        victory_retailer_id: null,
                        victory_price_unit: null,
                        mck_price_unit: null,
                        mck_updated_at: null,
                        rl_live_total: activeStore === 'ramiLevy' ? item.rami_levy_total : null,
                        v_live_total: activeStore === 'victory' ? item.victory_total : null,
                        mck_live_total: activeStore === 'machsaneiHashuk' ? item.mck_total : null,
                        substitutes: []
                    });

                    if (activeStore !== 'shufersal') {
                        itemsForShufersal.push({
                            barcode: staple.shufersal_bc ? staple.shufersal_bc.replace(/^P_/, '') : '',
                            key: stapleKey,
                            searchQuery: staple.search_query || staple.canonical_he,
                            name: item.name,
                            quantity: item.quantity
                        });
                    }
                    if (activeStore !== 'ramiLevy' && staple.rami_levy_id) {
                        itemsForRamiLevy.push({
                            id: String(staple.rami_levy_id),
                            barcode: stapleKey,
                            quantity: item.quantity
                        });
                    }
                    if (activeStore !== 'victory') {
                        itemsForVictory.push({
                            barcode: '',
                            key: stapleKey,
                            searchQuery: staple.victory_query || staple.search_query || staple.canonical_he,
                            name: item.name,
                            quantity: item.quantity
                        });
                    }
                    if (activeStore !== 'machsaneiHashuk') {
                        itemsForMCK.push({
                            barcode: '',
                            key: stapleKey,
                            searchQuery: staple.mck_query || staple.search_query || staple.canonical_he,
                            name: item.name,
                            quantity: item.quantity
                        });
                    }
                } else {
                    missingItems.push(item);
                }
            }
        });

        // 3.8-5.5. Ask the other chains at the same time, using 15-min live price cache unless bypassed
        currentStep = 'live_price_checks';
        let shufersalResults = [], shufersalDebug = null, ramiLevyResults = [];
        let victoryResults = [], agentDebug = null, mckResults = [], mckDebug = null;
        const storeHealth = {};
        const us = settings.userSettings || {};
        let liveCache = await loadLivePriceCache();

        function splitWithCache(storeKey, branchId, list, getKey, canReuseEntry) {
            if (bypassCache) return { cachedResults: [], uncached: list };
            const keys = list.map(getKey).filter(Boolean);
            const { hits } = getFreshCachedPrices(liveCache, storeKey, branchId, keys);
            const cachedResults = [];
            const uncached = [];
            for (const it of list) {
                const k = getKey(it);
                const hit = k ? hits[String(k)] : null;
                const reused = hit ? canReuseEntry(hit, it) : null;
                if (reused) cachedResults.push(reused);
                else uncached.push(it);
            }
            return { cachedResults, uncached };
        }

        const jobs = [];
        let jobsDone = 0;
        const ask = run => jobs.push(run().catch(e => console.warn('price check failed', e)).then(() => {
            statusDiv.textContent = `נבדקו ${++jobsDone} מתוך ${jobs.length} רשתות...`;
        }));

        if (activeStore !== 'shufersal' && compareShufersal && itemsForShufersal.length > 0) ask(async () => {
            const branchKey = us.shufersal?.branchId || 'default';
            const getKey = it => it.barcode || it.key || it.searchQuery;
            const { cachedResults, uncached } = splitWithCache('shufersal', branchKey, itemsForShufersal, getKey, (hit, it) => {
                if (hit.outOfStock) return { ...hit, quantity: it.quantity };
                if (hit.price > 0) return { ...hit, quantity: it.quantity, finalTotal: hit.price * (Number(it.quantity) || 1) };
                return null;
            });
            const delivCache = !bypassCache ? getFreshCachedPrices(liveCache, 'shufersal', branchKey, ['__delivery__']).hits['__delivery__'] : null;

            if (uncached.length === 0 && delivCache) {
                shufersalResults = cachedResults;
                if (delivCache.deliveryFee != null) delivery.shufersal = { fee: delivCache.deliveryFee };
                if (delivCache.slotFees) slotDays.shufersal = deliveryFromDays(delivCache.slotFees);
                storeHealth.shufersal = { ok: true, matched: shufersalResults.filter(r => !r.outOfStock).length, ms: 0 };
                return;
            }

            const t0 = Date.now();
            const r = await fetchInHiddenWindow('https://www.shufersal.co.il/online/he/', agentShufersalAgent, [uncached.length ? uncached : itemsForShufersal.slice(0, 1)]);
            const ms = Date.now() - t0;
            const fresh = r?.results || [];
            if (fresh.length) {
                liveCache = mergePriceCache(liveCache, 'shufersal', branchKey, fresh.map(x => ({ ...x, code: x.barcode })));
            }
            if (r?.debug) {
                shufersalDebug = r.debug;
                liveCache = mergePriceCache(liveCache, 'shufersal', branchKey, {
                    '__delivery__': { deliveryFee: r.debug.deliveryFee ?? null, slotFees: r.debug.slotFees || null }
                });
            }
            shufersalResults = uncached.length ? [...cachedResults, ...fresh] : cachedResults;
            if (r?.debug?.deliveryFee != null) delivery.shufersal = { fee: r.debug.deliveryFee };
            slotDays.shufersal = deliveryFromDays(r?.debug?.slotFees);
            storeHealth.shufersal = { ok: fresh.length > 0 || cachedResults.length > 0, matched: shufersalResults.filter(x => !x.outOfStock).length, ms };
        });

        if (activeStore !== 'ramiLevy' && compareRamiLevy && itemsForRamiLevy.length > 0) ask(async () => {
            const branchKey = us.ramiLevy?.branchId || 'default';
            const { cachedResults, uncached } = splitWithCache('ramiLevy', branchKey, itemsForRamiLevy, it => it.id, (hit, it) => {
                return Number(hit.cachedQty) === Number(it.quantity) ? hit : null;
            });
            const delivCache = !bypassCache ? getFreshCachedPrices(liveCache, 'ramiLevy', branchKey, ['__delivery__']).hits['__delivery__'] : null;

            if (uncached.length === 0 && delivCache) {
                ramiLevyResults = cachedResults;
                if (delivCache.delivery != null) delivery.ramiLevy = { fee: delivCache.delivery };
                storeHealth.ramiLevy = { ok: true, matched: ramiLevyResults.filter(r => !r.outOfStock).length, ms: 0 };
                return;
            }

            const t0 = Date.now();
            // Rami Levy cart promos can span multiple items; fetch uncached items (or all if any miss)
            const toFetch = uncached.length ? itemsForRamiLevy : itemsForRamiLevy.slice(0, 1);
            const r = await fetchInHiddenWindow('https://www.rami-levy.co.il/he', agentInsideCartEngine, [toFetch, us.ramiLevy?.branchId || null]);
            const ms = Date.now() - t0;
            const fresh = (r?.results || []).map(x => ({ ...x, code: x.id, cachedQty: x.quantity }));
            if (uncached.length && fresh.length) {
                ramiLevyResults = fresh;
                liveCache = mergePriceCache(liveCache, 'ramiLevy', branchKey, fresh);
            } else {
                ramiLevyResults = cachedResults;
            }
            if (r) {
                liveCache = mergePriceCache(liveCache, 'ramiLevy', branchKey, { '__delivery__': { delivery: r.delivery ?? null } });
                if (r.delivery != null) delivery.ramiLevy = { fee: r.delivery };
            }
            storeHealth.ramiLevy = { ok: ramiLevyResults.length > 0, matched: ramiLevyResults.filter(x => !x.outOfStock).length, ms };
        });

        // Victory prices every delivery slot for a city
        const { savedCity, savedStreet } = await chrome.storage.sync.get(['savedCity', 'savedStreet']);
        if ((activeStore === 'victory' || compareVictory) && savedCity) ask(async () => {
            const resp = await fetch('https://api.victoryonline.co.il/api/web/delivery-slots', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ city: savedCity, street: '', houseNumber: '' })
            });
            const d = resp.ok ? victoryDeliveryFromSlots(await resp.json()) : null;
            if (!d) return;
            slotDays.victory = d;
            delivery.victory = { fee: d.fee, minOrder: d.minOrder };
        });

        // Rami Levy prices its slots only for a full address
        if ((activeStore === 'ramiLevy' || compareRamiLevy) && savedCity && savedStreet) ask(async () => {
            const cities = await fetch(`https://www.rami-levy.co.il/api/address-autocomplete/city?q=${encodeURIComponent(savedCity)}`).then(r => r.json());
            const city = (cities?.data || []).find(c => c.city_name === savedCity) || cities?.data?.[0];
            if (!city) return;
            const json = await fetch('https://www-api.rami-levy.co.il/api/v2/site/supply/get-supply-date', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ only_area_availability: false, city_id: city.city_id, street_name: savedStreet, user_id: null, name: null, email: null, city: city.city_name, street: savedStreet, showStreet: 1 })
            }).then(r => r.json());
            if (json?.status !== 200) return;
            slotDays.ramiLevy = deliveryFromDays(Object.fromEntries(Object.entries(json.data || {}).map(([date, slots]) =>
                [date, (slots || []).filter(x => x && x.active !== false).map(x => x.deliveryCost)])));
        });

        if (activeStore !== 'victory' && compareVictory && itemsForVictory.length > 0) ask(async () => {
            const branchId = (us.victory?.platform === 2 && us.victory.branchId) || null;
            const branchKey = branchId || 'default';
            const getKey = it => it.barcode || it.key || it.searchQuery;
            const { cachedResults, uncached } = splitWithCache('victory', branchKey, itemsForVictory, getKey, (hit, it) => {
                if (hit.outOfStock) return { ...hit, quantity: it.quantity };
                if (hit.unitPrice > 0) {
                    const qty = Number(it.quantity) || 1;
                    return { ...hit, quantity: it.quantity, finalTotal: victorySaleTotal(hit.unitPrice, qty, hit.sales) };
                }
                return null;
            });

            if (uncached.length === 0) {
                victoryResults = cachedResults;
                storeHealth.victory = { ok: true, matched: victoryResults.filter(r => !r.outOfStock).length, ms: 0 };
                return;
            }

            const t0 = Date.now();
            const r = await fetchInHiddenWindow('https://www.victoryonline.co.il', agentVictoryAgent, [uncached, branchId]);
            const ms = Date.now() - t0;
            let fresh = [];
            if (r?.results) {
                fresh = r.results.map(x => x.outOfStock ? x : { ...x, finalTotal: victorySaleTotal(x.unitPrice, Number(x.quantity) || 1, x.sales) });
                agentDebug = r.debug || null;
                if (fresh.length) {
                    liveCache = mergePriceCache(liveCache, 'victory', branchKey, fresh.map(x => ({ ...x, code: x.barcode })));
                }
            }
            victoryResults = [...cachedResults, ...fresh];
            storeHealth.victory = {
                ok: !agentDebug?.blocked && (fresh.length > 0 || cachedResults.length > 0),
                matched: victoryResults.filter(x => !x.outOfStock).length,
                ms
            };
        });

        if (activeStore !== 'machsaneiHashuk' && compareMCK && itemsForMCK.length > 0) ask(async () => {
            const branchId = us.machsaneiHashuk?.branchId || null;
            const branchKey = branchId || 'default';
            const getKey = it => it.barcode || it.key || it.searchQuery;
            const { cachedResults, uncached } = splitWithCache('machsaneiHashuk', branchKey, itemsForMCK, getKey, (hit, it) => {
                return Number(hit.cachedQty) === Number(it.quantity) ? hit : null;
            });

            if (uncached.length === 0) {
                mckResults = cachedResults;
                storeHealth.machsaneiHashuk = { ok: true, matched: mckResults.filter(r => !r.outOfStock).length, ms: 0 };
                return;
            }

            const t0 = Date.now();
            const r = await fetchInHiddenWindow('https://www.mck.co.il', agentMCKAgent, [uncached, branchId]);
            const ms = Date.now() - t0;
            let fresh = [];
            if (r?.results) {
                fresh = r.results.map(x => ({ ...x, code: x.barcode, cachedQty: x.quantity }));
                mckDebug = r.debug || null;
                if (fresh.length) {
                    liveCache = mergePriceCache(liveCache, 'machsaneiHashuk', branchKey, fresh);
                }
            }
            mckResults = [...cachedResults, ...fresh];
            storeHealth.machsaneiHashuk = {
                ok: !mckDebug?.needsLogin && (fresh.length > 0 || cachedResults.length > 0),
                matched: mckResults.filter(x => !x.outOfStock).length,
                ms
            };
        });

        if (jobs.length) statusDiv.textContent = 'בודק מחירים ודמי משלוח ברשתות במקביל...';
        await Promise.all(jobs);
        await saveLivePriceCache(liveCache);

        // where a chain priced its delivery days, that is the fee; a later cheaper or free day becomes a note
        Object.entries(slotDays).forEach(([key, d]) => {
            if (!d) return;
            const day = d.cheaper && new Date(d.cheaper.date).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
            delivery[key] = { ...delivery[key], fee: d.fee, note: !d.cheaper ? '' : (d.cheaper.fee === 0 ? `משלוח חינם ב${day}` : `משלוח ב-₪${d.cheaper.fee.toFixed(2)} ב${day}`) };
        });

        // 6. Classify matched items
        currentStep = 'classify_items';
        const inStockItems = [];
        const outOfStockItems = [];

        for (const item of matchedItems) {
            const barcode = item.shufersal_code.replace('P_', '');
            const liveKey = item.weighed_key || barcode;

            // Shufersal
            let chosenShufersalBarcode = barcode;
            let shufersalTotal = null;
            let shufersalSource = 'database';
            let shufersalSubName = null;
            if (activeStore === 'shufersal') {
                shufersalTotal = item.shufersal_total;
                shufersalSource = 'live';
            } else if (compareShufersal) {
                const shufersalLive = shufersalResults.find(r => r.barcode === barcode || r.barcode === liveKey);
                if (shufersalLive && !shufersalLive.outOfStock) {
                    shufersalTotal = shufersalLive.finalTotal;
                    shufersalSource = 'live';
                } else {
                    if (item.substitutes && item.substitutes.length > 0) {
                        for (const subBarcode of item.substitutes) {
                            const cleanSub = subBarcode.replace('P_', '');
                            const subLive = shufersalResults.find(r => r.barcode === cleanSub);
                            if (subLive && !subLive.outOfStock) {
                                shufersalTotal = subLive.finalTotal;
                                shufersalSource = 'live-substitute';
                                chosenShufersalBarcode = cleanSub;
                                const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                                if (subItem) shufersalSubName = subItem.name;
                                break;
                            }
                        }
                    }
                    if (!shufersalTotal) {
                        if (shufersalLive && shufersalLive.outOfStock) {
                            shufersalTotal = null;
                        } else if (item.shufersal_price_unit != null) {
                            shufersalTotal = item.shufersal_price_unit * item.quantity;
                            shufersalSource = 'database';
                        }
                    }
                }
            }

            // Rami Levy
            let chosenRamiCode = item.backup_target_code;
            let ramiTotal = null;
            let ramiSource = 'database';
            let ramiSubName = null;
            if (activeStore === 'ramiLevy') {
                ramiTotal = item.rl_live_total;
                ramiSource = 'live';
            } else if (compareRamiLevy) {
                const ramiLive = ramiLevyResults.find(r => r.id === item.backup_target_code);
                if (ramiLive && !ramiLive.outOfStock) {
                    ramiTotal = ramiLive.finalTotal;
                    ramiSource = 'live';
                } else {
                    if (item.substitutes && item.substitutes.length > 0) {
                        for (const subBarcode of item.substitutes) {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem && subItem.rami_levy_code) {
                                const subLive = ramiLevyResults.find(r => r.id === String(subItem.rami_levy_code));
                                if (subLive && !subLive.outOfStock) {
                                    ramiTotal = subLive.finalTotal;
                                    ramiSource = 'live-substitute';
                                    chosenRamiCode = String(subItem.rami_levy_code);
                                    ramiSubName = subItem.name;
                                    break;
                                }
                            }
                        }
                    }
                    if (!ramiTotal) {
                        if (ramiLive && ramiLive.outOfStock) {
                            ramiTotal = null;
                        } else if (item.rami_levy_price_unit != null) {
                            ramiTotal = item.rami_levy_price_unit * item.quantity;
                            ramiSource = 'database';
                        }
                    }
                }
            }

            // Victory
            let chosenVictoryCode = null;
            let victoryTotal = null;
            let victorySource = 'database';
            let victorySubName = null;
            if (activeStore === 'victory') {
                victoryTotal = item.v_live_total;
                victorySource = 'live';
            } else if (compareVictory) {
                const victoryLive = victoryResults.find(r => r.barcode === barcode || r.barcode === liveKey);
                if (victoryLive && !victoryLive.outOfStock) {
                    victoryTotal = victoryLive.finalTotal;
                    victorySource = 'live';
                    chosenVictoryCode = victoryLive.retailerProductId || null;
                } else {
                    if (item.substitutes && item.substitutes.length > 0) {
                        for (const subBarcode of item.substitutes) {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem) {
                                const cleanSub = subBarcode.replace('P_', '');
                                const subLive = victoryResults.find(r => r.barcode === cleanSub);
                                if (subLive && !subLive.outOfStock) {
                                    victoryTotal = subLive.finalTotal;
                                    victorySource = 'live-substitute';
                                    chosenVictoryCode = subLive.retailerProductId || null;
                                    victorySubName = subItem.name;
                                    break;
                                }
                            }
                        }
                    }
                    if (!victoryTotal) {
                        if (victoryLive && victoryLive.outOfStock) {
                            victoryTotal = null;
                        } else if (item.victory_price_unit != null) {
                            victoryTotal = item.victory_price_unit * item.quantity;
                            victorySource = 'database';
                        }
                    }
                }
            }

            // Machsanei HaShuk
            let chosenMCKCode = item.mck_code || item.mck_retailer_id;
            let mckTotal = null;
            let mckSource = 'database';
            let mckSubName = null;
            let mckLive = null;
            if (activeStore === 'machsaneiHashuk') {
                mckTotal = item.mck_live_total;
                mckSource = 'live';
            } else if (compareMCK) {
                mckLive = mckResults.find(r => r.barcode === barcode || r.barcode === liveKey);
                if (mckLive && !mckLive.outOfStock) {
                    mckTotal = mckLive.finalTotal;
                    mckSource = 'live';
                    chosenMCKCode = mckLive.retailerProductId || null;
                } else {
                    if (item.substitutes && item.substitutes.length > 0) {
                        for (const subBarcode of item.substitutes) {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem) {
                                const cleanSub = subBarcode.replace('P_', '');
                                const subLive = mckResults.find(r => r.barcode === cleanSub);
                                if (subLive && !subLive.outOfStock) {
                                    mckTotal = subLive.finalTotal;
                                    mckSource = 'live-substitute';
                                    chosenMCKCode = subLive.retailerProductId || null;
                                    mckSubName = subItem.name;
                                    break;
                                }
                            }
                        }
                    }
                    if (!mckTotal) {
                        if (mckLive && mckLive.outOfStock) {
                            mckTotal = null;
                        } else if (item.mck_price_unit != null) {
                            mckTotal = item.mck_price_unit * item.quantity;
                            mckSource = 'database';
                        }
                    }
                }
            }

            const isShufersalMissing = compareShufersal && (!shufersalTotal || shufersalTotal <= 0) && activeStore !== 'shufersal';
            const isRamiMissing = compareRamiLevy && (!ramiTotal || ramiTotal <= 0) && activeStore !== 'ramiLevy';
            const isVictoryMissing = compareVictory && (!victoryTotal || victoryTotal <= 0) && activeStore !== 'victory';
            const isMCKMissing = compareMCK && (!mckTotal || mckTotal <= 0) && activeStore !== 'machsaneiHashuk';

            const obj = {
                name: item.name,
                quantity: item.quantity,
                shufersal_code: chosenShufersalBarcode.startsWith('P_') ? chosenShufersalBarcode : `P_${chosenShufersalBarcode}`,
                original_barcode: item.original_barcode,
                unit_qty: item.unit_qty,
                unit_type: item.unit_type,
                substitute_status: item.substitute_status,
                ai_match: item.ai_match,
                targetCode: chosenRamiCode,
                victory_code: chosenVictoryCode,
                victory_retailer_id: chosenVictoryCode,
                mck_code: chosenMCKCode,
                mck_retailer_id: chosenMCKCode,
                shufersal_total: compareShufersal ? shufersalTotal : null,
                rami_levy_total: compareRamiLevy ? ramiTotal : null,
                victory_total: compareVictory ? victoryTotal : null,
                mck_total: compareMCK ? mckTotal : null,
                isShufersalMissing,
                isRamiMissing,
                isVictoryMissing,
                isMCKMissing,
                shufersal_price_source: shufersalSource,
                rami_price_source: ramiSource,
                victory_price_source: victorySource,
                mck_price_source: mckSource,
                shufersal_sub_name: shufersalSubName,
                rami_sub_name: ramiSubName,
                victory_sub_name: victorySubName,
                mck_sub_name: mckSubName,
                mck_updated_at: item.mck_updated_at
            };

            const isMissingEverywhere = (!compareShufersal || isShufersalMissing) &&
                                        (!compareRamiLevy || isRamiMissing) &&
                                        (!compareVictory || isVictoryMissing) &&
                                        (!compareMCK || isMCKMissing);

            if (isMissingEverywhere) {
                outOfStockItems.push(obj);
            } else {
                inStockItems.push(obj);
            }
        }

        statusDiv.innerHTML = 'מנתח נתוני עגלה...';
        currentStep = 'render_ui';
        renderUI();

        // ===== RENDER FUNCTION =====
        function renderUI() {
            console.log("=== renderUI: Debug Cart Details ===");
            console.log("delivery:", JSON.stringify(delivery), "per day:", JSON.stringify(slotDays));
            console.log("chain answers:", JSON.stringify({ victory: agentDebug, mck: mckDebug, shufersal: shufersalResults.length, ramiLevy: ramiLevyResults.length, storeHealth }));

            let shufersalHasDb = false;
            let ramiHasDb = false;
            let victoryHasDb = false;
            let mckHasDb = false;

            const checkSources = (item) => {
                if (item.shufersal_price_source === 'database') shufersalHasDb = true;
                if (item.rami_price_source === 'database') ramiHasDb = true;
                if (item.victory_price_source === 'database') victoryHasDb = true;
                if (item.mck_price_source === 'database') mckHasDb = true;
            };
            inStockItems.forEach(checkSources);
            outOfStockItems.forEach(checkSources);

            let totalShufersal = 0, totalRamiLevy = 0, totalVictory = 0, totalMCK = 0;
            let shufersalCount = 0, ramiCount = 0, victoryCount = 0, mckCount = 0;

            const gap = { shufersal: 0, ramiLevy: 0, victory: 0, machsaneiHashuk: 0 };
            const activeField = { shufersal: 'shufersal_total', ramiLevy: 'rami_levy_total', victory: 'victory_total', machsaneiHashuk: 'mck_total' }[activeStore];

            const processItemForTotals = (item) => {
                const known = [item.shufersal_total, item.rami_levy_total, item.victory_total, item.mck_total].filter(v => v > 0);
                const activeTotal = activeStore ? (item[activeField] || 0) : (known.length ? Math.min(...known) : 0);

                if (activeStore === 'shufersal') {
                    totalShufersal += item.shufersal_total || 0;
                    shufersalCount++;
                } else if (compareShufersal) {
                    if (item.shufersal_total != null && item.shufersal_total > 0) {
                        totalShufersal += item.shufersal_total;
                        shufersalCount++;
                    } else gap.shufersal += activeTotal;
                }

                if (activeStore === 'ramiLevy') {
                    totalRamiLevy += item.rami_levy_total || 0;
                    ramiCount++;
                } else if (compareRamiLevy) {
                    if (item.rami_levy_total != null && item.rami_levy_total > 0) {
                        totalRamiLevy += item.rami_levy_total;
                        ramiCount++;
                    } else gap.ramiLevy += activeTotal;
                }

                if (activeStore === 'victory') {
                    totalVictory += item.victory_total || 0;
                    victoryCount++;
                } else if (compareVictory) {
                    if (item.victory_total != null && item.victory_total > 0) {
                        totalVictory += item.victory_total;
                        victoryCount++;
                    } else gap.victory += activeTotal;
                }

                if (activeStore === 'machsaneiHashuk') {
                    totalMCK += item.mck_total || 0;
                    mckCount++;
                } else if (compareMCK) {
                    if (item.mck_total != null && item.mck_total > 0) {
                        totalMCK += item.mck_total;
                        mckCount++;
                    } else gap.machsaneiHashuk += activeTotal;
                }
            };

            inStockItems.forEach(processItemForTotals);
            outOfStockItems.forEach(processItemForTotals);
            missingItems.forEach(processItemForTotals);

            const shufersalBranchName = settings.userSettings?.shufersal?.branchName || '';
            const shufersalDisplayName = shufersalBranchName ? `שופרסל (${shufersalBranchName})` : 'שופרסל';
            const ramiBranchName = settings.userSettings?.ramiLevy?.branchName || '';
            const ramiDisplayName = ramiBranchName ? `רמי לוי (${ramiBranchName})` : 'רמי לוי';
            const victoryBranchName = settings.userSettings?.victory?.branchName || '';
            const victoryDisplayName = victoryBranchName ? `ויקטורי (${victoryBranchName})` : 'ויקטורי';

            const storesWithData = [];
            if (activeStore === 'shufersal' || compareShufersal) {
                const isShufersalActive = activeStore === 'shufersal';
                const shufersalComment = shufersalHasDb ? 'כולל מחירים ממאגר הנתונים' : 'כל המחירים עודכנו בלייב מהאתר';
                const shufersalInfo = isShufersalActive
                    ? 'הסופר הנוכחי שלך'
                    : (shufersalCount === rawCartItems.length ? shufersalComment : `${shufersalComment} · נמצאו ${shufersalCount} מתוך ${rawCartItems.length} מוצרים, ההשוואה רק עליהם`);
                storesWithData.push({
                    key: 'shufersal', name: shufersalDisplayName, total: totalShufersal, gap: gap.shufersal,
                    info: shufersalInfo, hasData: isShufersalActive ? true : (shufersalCount > 0)
                });
            }

            if (compareRamiLevy) {
                const isRamiActive = activeStore === 'ramiLevy';
                const ramiComment = ramiHasDb ? 'כולל מחירים ממאגר הנתונים' : 'כל המחירים עודכנו בלייב מהאתר';
                const ramiInfo = isRamiActive
                    ? 'הסופר הנוכחי שלך'
                    : (ramiCount === rawCartItems.length ? ramiComment : `${ramiComment} · נמצאו ${ramiCount} מתוך ${rawCartItems.length} מוצרים, ההשוואה רק עליהם`);
                storesWithData.push({
                    key: 'ramiLevy', name: ramiDisplayName, total: totalRamiLevy, gap: gap.ramiLevy,
                    info: ramiInfo,
                    hasData: isRamiActive ? true : (ramiCount > 0)
                });
            }

            if (compareVictory) {
                const isVictoryActive = activeStore === 'victory';
                const victoryComment = victoryHasDb ? 'כולל מחירים ממאגר הנתונים' : 'כל המחירים עודכנו בלייב מהאתר';
                const victoryInfo = isVictoryActive
                    ? 'הסופר הנוכחי שלך'
                    : (victoryCount === rawCartItems.length ? victoryComment : `${victoryComment} · נמצאו ${victoryCount} מתוך ${rawCartItems.length} מוצרים, ההשוואה רק עליהם`);
                storesWithData.push({
                    key: 'victory', name: victoryDisplayName, total: totalVictory, gap: gap.victory,
                    info: victoryInfo,
                    hasData: isVictoryActive ? true : (victoryCount > 0),
                    debugInfo: isVictoryActive ? null : (victoryResults.length === 0 ? (agentDebug?.blocked ? 'ויקטורי חסמה זמנית את הבדיקה' : 'מחירים לא נמצאו') : null)
                });
            }

            if (compareMCK) {
                const isMCKActive = activeStore === 'machsaneiHashuk';
                const mckComment = mckHasDb ? 'כולל מחירים ממאגר הנתונים' : 'כל המחירים עודכנו בלייב מהאתר';
                const mckInfo = isMCKActive
                    ? 'הסופר הנוכחי שלך'
                    : (mckCount === rawCartItems.length ? mckComment : `${mckComment} · נמצאו ${mckCount} מתוך ${rawCartItems.length} מוצרים, ההשוואה רק עליהם`);
                const mckNeedsLogin = !isMCKActive && mckDebug?.needsLogin;
                const mckLoginHint = 'התחברו לאתר מחסני השוק לקבלת מחיר עדכני';
                const mckOldDates = [...inStockItems, ...outOfStockItems]
                    .filter(i => i.mck_price_source === 'database' && i.mck_total > 0 && i.mck_updated_at)
                    .map(i => new Date(i.mck_updated_at)).filter(d => !isNaN(d));
                const mckOldDate = mckOldDates.length ? new Date(Math.max(...mckOldDates)).toLocaleDateString('he-IL') : '';
                storesWithData.push({
                    key: 'machsaneiHashuk', name: 'מחסני השוק', total: totalMCK, gap: gap.machsaneiHashuk,
                    info: mckNeedsLogin ? esc(`מחיר ישן${mckOldDate ? ` (${mckOldDate})` : ''} · ${mckLoginHint}`) : mckInfo,
                    hasData: isMCKActive ? true : (mckCount > 0),
                    debugInfo: isMCKActive ? null : (mckNeedsLogin ? mckLoginHint : (mckResults.length === 0 ? (mckDebug?.branchId ? 'מחירים לא נמצאו' : 'לא נמצא סניף') : null))
                });
            }

            storesWithData.forEach(st => {
                const d = delivery[st.key];
                st.delivery = d?.fee ?? null;
                st.deliveryNote = [d?.note, d?.minOrder && st.total < d.minOrder ? `מינימום הזמנה ₪${d.minOrder}` : ''].filter(Boolean).join(' · ');
            });
            const knownFees = storesWithData.filter(s => s.hasData && s.delivery != null).map(s => s.delivery);
            if (knownFees.length) storesWithData.forEach(st => { if (st.delivery == null) st.deliveryEst = Math.max(...knownFees); });
            const sortable = storesWithData.filter(s => s.hasData).sort((a, b) => rvCompareTotal(a) - rvCompareTotal(b));
            const noData = storesWithData.filter(s => !s.hasData);
            const orderedStores = [...sortable, ...noData];
            const cheapest = sortable[0];

            const dealStoreNames = { shufersal: 'שופרסל', ramiLevy: 'רמי לוי', victory: 'ויקטורי', machsaneiHashuk: 'מחסני השוק' };
            const dealsMatrix = [...inStockItems, ...outOfStockItems].map(item => {
                const prices = {};
                if (item.shufersal_total > 0) prices.shufersal = item.shufersal_total;
                if (item.rami_levy_total > 0) prices.ramiLevy = item.rami_levy_total;
                if (item.victory_total > 0) prices.victory = item.victory_total;
                if (item.mck_total > 0) prices.machsaneiHashuk = item.mck_total;
                const subNames = {};
                if (item.shufersal_price_source === 'live-substitute' && item.shufersal_sub_name) subNames.shufersal = item.shufersal_sub_name;
                if (item.rami_price_source === 'live-substitute' && item.rami_sub_name) subNames.ramiLevy = item.rami_sub_name;
                if (item.victory_price_source === 'live-substitute' && item.victory_sub_name) subNames.victory = item.victory_sub_name;
                if (item.mck_price_source === 'live-substitute' && item.mck_sub_name) subNames.machsaneiHashuk = item.mck_sub_name;
                return {
                    name: item.name,
                    quantity: item.quantity,
                    prices,
                    subNames,
                    unitInfo: item.unit_qty && item.unit_type ? { qty: item.unit_qty, unit: item.unit_type } : null
                };
            });
            const outlierDeals = typeof detectOutlierDeals === 'function' ? detectOutlierDeals(dealsMatrix, dealStoreNames) : [];

            const savedLabel = saved ? `${RV_NAMES[saved.store] || ''}, ${new Date(saved.at).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' })}` : '';
            let html = renderStoreSummary({ orderedStores, sortable, activeStore, savedLabel, itemCount: rawCartItems.length, deals: outlierDeals });

            const availableItems = [];
            const replacedItems = [];
            inStockItems.forEach(item => {
                const isReplacedInAny =
                    ((activeStore === 'shufersal' || compareShufersal) && (item.shufersal_price_source === 'live-substitute')) ||
                    (compareRamiLevy && (item.rami_price_source === 'live-substitute')) ||
                    (compareVictory && (item.victory_price_source === 'live-substitute')) ||
                    (compareMCK && (item.mck_price_source === 'live-substitute'));

                if (isReplacedInAny) replacedItems.push(item);
                else availableItems.push(item);
            });

            const detailOpts = isReplaced => ({
                showShufersal: activeStore === 'shufersal' || compareShufersal,
                showRami: compareRamiLevy,
                showVictory: compareVictory,
                showMCK: compareMCK,
                isReplaced
            });

            html += `
            <div class="details-section">
                <button class="details-toggle" id="detailsToggle">
                    <span>פירוט מוצרים (${availableItems.length} זמינים, ${replacedItems.length} הוחלפו)</span>
                    <span class="toggle-arrow" id="toggleArrow">▼</span>
                </button>
                <div class="details-content" id="detailsContent">`;

            if (availableItems.length > 0) {
                html += '<div class="section-label">מוצרים זמינים</div><div class="product-list">';
                availableItems.forEach(item => { html += renderDetailsItem(item, detailOpts(false)); });
                html += '</div>';
            }

            if (replacedItems.length > 0) {
                html += '<div class="section-label">מוצרים שהוחלפו</div><div class="product-list">';
                replacedItems.forEach(item => { html += renderDetailsItem(item, detailOpts(true)); });
                html += '</div>';
            }

            if (outOfStockItems.length > 0) {
                html += '<div class="section-label">חסר במלאי לחלוטין</div><div class="out-section">';
                outOfStockItems.forEach((item) => {
                    html += `<div class="out-item"><div class="out-item-name">${esc(item.name)} x${esc(item.quantity)}</div>`;
                    const missingStores = [
                        (compareShufersal && item.isShufersalMissing) ? 'שופרסל' : '',
                        (compareRamiLevy && item.isRamiMissing) ? 'רמי לוי' : '',
                        (compareVictory && item.isVictoryMissing) ? 'ויקטורי' : '',
                        (compareMCK && item.isMCKMissing) ? 'מחסני השוק' : ''
                    ].filter(Boolean).join(', ');
                    html += `<div class="out-item-sub"><span style="color:#9ca3af; font-size:12px;">חסר ב: ${missingStores}</span></div></div>`;
                });
                html += '</div>';
            }

            if (missingItems.length > 0) {
                html += '<div class="section-label">לא נמצא במאגר לחלוטין</div><div class="missing-section">';
                missingItems.forEach(item => {
                    html += `<div class="missing-item">${esc(item.name)} x${esc(item.quantity)}</div>`;
                });
                html += '</div>';
            }

            html += '</div></div>';
            const aiItems = [...inStockItems, ...outOfStockItems].filter(i => i.isShufersalMissing || i.isRamiMissing || i.isVictoryMissing || i.isMCKMissing);
            const aiCount = aiItems.length + missingItems.length;
            const aiOn = document.getElementById('aiToggle').checked;
            html += `<div class="win" style="margin:0 14px 16px; padding:12px"><b>תחליפים עם AI</b><div id="aiSubMsg" class="sub" role="status" aria-live="polite">${esc(
                aiNote ? aiNote
                : aiCount === 0 ? 'כל המוצרים נמצאו בכל הרשתות, אז אין צורך בתחליפים לסל הזה.'
                : !aiOn ? `${aiCount === 1 ? 'מוצר אחד חסר' : aiCount + ' מוצרים חסרים'} בחלק מהרשתות או במאגר שלנו. כדי שה-AI יחפש מוצרים מקבילים, הדליקו את המתג "חיפוש תחליפים עם AI" במסך ההשוואה.`
                : aiRemaining === 0 ? 'המכסה של היום נוצלה. אפשר שוב מחר.'
                : 'מחפשים תחליפים עם AI...')}</div></div>`;
            resultDiv.innerHTML = html;
            document.getElementById('startView').hidden = true;
            statusDiv.innerHTML = 'סיימנו';

            const activeEntry = sortable.find(st => st.key === activeStore);
            if (!saved) logEvent({
                type: 'comparison',
                active_store: activeStore,
                cheapest_store: cheapest ? cheapest.key : activeStore,
                cart_size: rawCartItems.length,
                matched_count: matchedItems.length,
                saving: cheapest && activeEntry ? Math.max(0, Number((rvCompareTotal(activeEntry) - rvCompareTotal(cheapest)).toFixed(2))) : 0,
                totals: Object.fromEntries(sortable.map(st => [st.key, Number(st.total.toFixed(2))])),
                store_health: storeHealth,
                missing_items: missingItems.slice(0, 50).map(i => ({ store: codeStore, code: String(i.code || ''), name: String(i.name || '') })),
                products: matchedItems.map(i => ({ barcode: i.shufersal_code.replace('P_', ''), name: i.name }))
            });

            finalCartToTransfer = inStockItems;

            if (aiOn && aiCount > 0 && !aiNote && aiRemaining !== 0) askAiSubstitutes(aiItems, saved, missingItems.map(i => ({ store: codeStore, code: i.code, name: i.name })));
            document.getElementById('compareAgain')?.addEventListener('click', () => compareCarts(saved, undefined, true));
            document.getElementById('detailsToggle')?.addEventListener('click', () => {
                document.getElementById('detailsContent').classList.toggle('open');
                document.getElementById('toggleArrow').classList.toggle('open');
            });

            resultDiv.querySelectorAll('[data-bad-sub]').forEach(btn => btn.addEventListener('click', () => {
                btn.disabled = true;
                btn.textContent = 'תודה על הדיווח';
                sbFetch('/rest/v1/rpc/report_bad_substitute', {
                    method: 'POST',
                    body: JSON.stringify({ p_original_barcode: btn.dataset.badSub })
                }).catch(() => {});
            }));
            resultDiv.querySelectorAll('[data-bad-match]').forEach(btn => btn.addEventListener('click', () => {
                btn.disabled = true;
                btn.textContent = 'תודה על הדיווח';
                sbFetch('/rest/v1/rpc/report_bad_substitute', {
                    method: 'POST',
                    body: JSON.stringify({ p_store_name: btn.dataset.storeName, p_store_code: btn.dataset.storeCode })
                }).catch(() => {});
            }));

            const allSources = [...inStockItems, ...outOfStockItems, ...missingItems];
            const subSourceField = {
                shufersal: 'shufersal_price_source',
                ramiLevy: 'rami_price_source',
                victory: 'victory_price_source',
                machsaneiHashuk: 'mck_price_source'
            };
            Object.entries(RV_SWITCH).forEach(([storeKey, sw]) => {
                document.getElementById(sw.id)?.addEventListener('click', () => {
                    const srcKey = subSourceField[storeKey];
                    const usedSubs = Array.from(new Set(
                        allSources
                            .filter(i => i[srcKey] === 'live-substitute' && i.original_barcode && /^P_\d{4,14}$/.test(i.original_barcode))
                            .map(i => i.original_barcode)
                    ));
                    logEvent({ type: 'switch', store: storeKey, ...(usedSubs.length ? { used_substitutes: usedSubs } : {}) });
                    sendCartTo(storeKey, allSources);
                });
            });
            if (!saved) saveCartToHistory(activeStore, allSources, Object.fromEntries(sortable.map(st => [st.key, Number(rvShownTotal(st).toFixed(2))])), rawCartItems);

            compareBtn.disabled = false;
        }

    } catch (error) {
        const known = /^(לא נמצאה לשונית|לא ניתן לסרוק)/.test(error.message || '');
        const shown = known ? error.message : 'משהו השתבש בהשוואה. נסו שוב, ואם זה חוזר שלחו לנו משוב.';
        document.getElementById('result').innerHTML = `<p style="color:#dc2626; text-align:center; padding:16px;">${esc(shown)}</p>`;
        document.getElementById('status').innerHTML = '';
        compareBtn.disabled = false;
        console.error(error);

        const errCode = known ? 'scan_or_tab_error' : `${error?.name || 'Error'}:${String(error?.message || 'unknown').slice(0, 80)}`;
        sbFetch('/rest/v1/rpc/log_client_error', {
            method: 'POST',
            body: JSON.stringify({
                p: {
                    store: currentStore,
                    step: currentStep,
                    error_code: errCode,
                    ext_version: chrome.runtime?.getManifest?.().version || ''
                }
            })
        }).catch(() => {});
    } finally {
        stopSphere();
        loading.hidden = true;
    }
}


// ===== AI SUBSTITUTES (needs an account; server limits it to 3 per day) =====
// The switch on the start view decides whether every comparison asks the AI. Its quota line sits under it.
let aiRemaining; // 0..3 left today, null = no limit (owner), undefined = not known yet
let aiDailyLimit = 3;
const aiCall = (session, body) => fetch(`${SUPABASE_URL}/functions/v1/ai-substitutes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
}).then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));
const loginLink = el => {
    el.innerHTML = 'כדי להשתמש ב-AI צריך להתחבר <button type="button" class="link-btn">להתחברות</button>';
    el.querySelector('button').addEventListener('click', () => openTab(chrome.runtime.getURL('settings.html#account')));
};

async function initAiSwitch() {
    const sw = document.getElementById('aiToggle');
    sw.checked = (await chrome.storage.local.get('aiAuto')).aiAuto === true;
    sw.addEventListener('change', () => chrome.storage.local.set({ aiAuto: sw.checked }));
    showAiQuota();
}

async function showAiQuota(remaining) {
    const el = document.getElementById('aiQuota');
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { aiRemaining = undefined; loginLink(el); return; }
        if (remaining === undefined) {
            const r = await aiCall(session, { quota: true });
            if (!r.ok || !r.data.ok) throw new Error(r.data.error || 'quota');
            remaining = r.data.remaining;
            if (r.data.limit != null) aiDailyLimit = Number(r.data.limit) || 3;
        }
        aiRemaining = remaining;
        el.textContent = remaining === null
            ? 'נשאר במכסה: ללא הגבלה'
            : `נשארו ${remaining} מתוך ${aiDailyLimit} חיפושי AI להיום${remaining ? '' : ' (מתחדש מחר)'}`;
    } catch (e) { console.warn('AI quota unknown', e); el.textContent = ''; }
}

async function askAiSubstitutes(items, saved, unknown = []) {
    const msg = document.getElementById('aiSubMsg');
    const stores = [['isShufersalMissing', 'shufersal'], ['isRamiMissing', 'rami_levy'], ['isVictoryMissing', 'victory'], ['isMCKMissing', 'machsanei_hashuk']];
    try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) { loginLink(msg); return; }
        const { ok, data } = await aiCall(session, {
            items: items.slice(0, 8).map(i => ({ barcode: i.shufersal_code, name: i.name, missingIn: stores.filter(([flag]) => i[flag]).map(([, s]) => s) })),
            unknown: unknown.slice(0, Math.max(0, 8 - items.length))
        });
        showAiQuota(data.remaining);
        if (!ok || !data.ok) { msg.textContent = friendlyError(data.error || 'unavailable'); return; }
        const n = (data.found || []).length;
        if (!n) { msg.textContent = 'ה-AI לא מצא תחליפים מתאימים לסל הזה.'; return; }
        msg.textContent = `נמצאו תחליפים ל-${n} מוצרים. משווים שוב...`;
        setTimeout(() => compareCarts(saved, `ה-AI מצא תחליפים ל-${n} מוצרים, והם כבר בהשוואה הזו.`), 1500);
    } catch (e) {
        console.error(e);
        msg.textContent = friendlyError('unavailable');
    }
}

// ===== SENDING A CART TO A CHAIN =====
// The chain's content script (its *_injector.js) picks the cart up from storage and fills the cart on the site.
function sendCartTo(storeKey, items) {
    const clean = i => String(i.shufersal_code || '').replace('P_', '');
    const go = (data, url) => chrome.storage.local.set(data, () => openTab(url));
    if (storeKey === 'ramiLevy') {
        go({ savedCart: items.filter(i => !i.isRamiMissing && i.targetCode && i.quantity > 0).map(i => {
            const barcode = clean(i).replace(/\D/g, '');
            return { targetCode: i.targetCode, quantity: i.quantity, ...(barcode ? { barcode } : {}) };
        }) }, 'https://www.rami-levy.co.il/he');
    } else if (storeKey === 'victory') {
        go({ savedCartVictory: items.filter(i => !i.isVictoryMissing && (i.victory_code || clean(i)) && i.quantity > 0).map(i => ({
            name: i.name, amount: i.quantity, quantity: i.quantity, shufersal_code: i.shufersal_code || '', barcode: clean(i),
            victory_code: i.victory_code || i.victory_retailer_id || null,
            victory_retailer_id: i.victory_retailer_id || i.victory_code || null
        })) }, 'https://www.victoryonline.co.il');
    } else if (storeKey === 'machsaneiHashuk') {
        // items without an internal code still go, so the site shows why nothing was added instead of staying silent
        go({ savedCartMCKAt: Date.now(), savedCartMCK: items.filter(i => !i.isMCKMissing && i.quantity > 0).map(i => ({
            name: i.name, amount: i.quantity, quantity: i.quantity, shufersal_code: i.shufersal_code || '', barcode: clean(i),
            mck_code: i.mck_code || i.mck_retailer_id || null,
            retailerProductId: i.mck_retailer_id || i.mck_code || null
        })) }, 'https://www.mck.co.il');
    } else {
        go({ savedCartShufersal: items.filter(i => (i.shufersal_code || i.code) && i.quantity > 0).map(i => ({
            shufersalCode: i.shufersal_code || i.code, shufersal_code: i.shufersal_code || i.code, quantity: i.quantity
        })) }, 'https://www.shufersal.co.il/online/he/cart');
    }
}

// ===== MY CARTS (kept on this computer only) =====
const HISTORY_FIELDS = ['name', 'quantity', 'code', 'shufersal_code', 'targetCode', 'victory_code', 'victory_retailer_id', 'mck_code', 'mck_retailer_id', 'isRamiMissing', 'isVictoryMissing', 'isMCKMissing'];

// items: the compared lines with every chain's codes (for "build at"). raw: the cart as scanned (for "compare now").
async function saveCartToHistory(store, items, totals, raw) {
    const slim = items.map(i => Object.fromEntries(HISTORY_FIELDS.filter(f => i[f] != null).map(f => [f, i[f]])));
    const { cartHistory = [] } = await chrome.storage.local.get('cartHistory');
    await chrome.storage.local.set({ cartHistory: addToHistory(cartHistory, {
        at: Date.now(), store, totals, items: slim, raw: raw.map(({ code, name, quantity }) => ({ code, name, quantity }))
    }) });
}

async function showHistory() {
    const { cartHistory = [] } = await chrome.storage.local.get('cartHistory');
    const resultDiv = document.getElementById('result');
    resultDiv.innerHTML = renderHistory(cartHistory);
    document.getElementById('startView').hidden = true;
    resultDiv.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
        const open = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(open));
        document.getElementById('hist-' + b.dataset.toggle).hidden = !open;
    }));
    resultDiv.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => compareCarts(cartHistory[Number(b.dataset.restore)])));
    resultDiv.querySelectorAll('[data-build]').forEach(b => b.addEventListener('click', () => {
        sendCartTo(b.dataset.build, cartHistory[Number(b.dataset.i)].items);
    }));
    document.getElementById('historyBack').addEventListener('click', () => {
        resultDiv.innerHTML = '';
        document.getElementById('startView').hidden = false;
    });
    document.getElementById('historyClear')?.addEventListener('click', async () => {
        await chrome.storage.local.remove('cartHistory');
        showHistory();
    });
}

// ===== ANONYMOUS STATISTICS (Supabase) =====
// One row per comparison with totals only, plus per-product counters. No user id and no cart contents are stored.
async function logEvent(event) {
    try {
        const { shareStats, savedCity } = await chrome.storage.sync.get(['shareStats', 'savedCity']);
        if (shareStats === false) return; // switched off in the settings page
        fetch(`${SUPABASE_URL}/rest/v1/rpc/log_event`, {
            method: 'POST',
            headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p: { ...event, city: savedCity || null, ext_version: chrome.runtime.getManifest().version } })
        }).catch(() => {});
    } catch (e) { }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    rememberWindowPosition();
    initSettings();
    initAiSwitch();
    const btn = document.getElementById('compareBtn');
    if (btn) {
        btn.addEventListener('click', compareCarts);
    }
});