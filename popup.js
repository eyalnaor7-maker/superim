// ===== STATE =====
let finalCartToTransfer = [];

// ===== UTILITIES =====
const formatPrice = amount => `₪${parseFloat(amount || 0).toFixed(2)}`;

const STOP_WORDS = new Set(['גרם', 'מ"ל', 'מל', 'ליטר', 'ק"ג', 'קג', 'יח', 'יחידות', 'של', 'עם', 'בלי', 'ו', 'ב', 'ל', 'מ', 'פרוס', 'טרי', 'קפוא']);

function findSubstitute(productName, pricesData) {
    const allTokens = [
        ...productName.split(/[\s\-\/,.'"%*]+/).map(w => w.trim()).filter(w => w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)),
        ...(productName.match(/\d+\.?\d*/g) || []).filter(n => n.length > 1)
    ];

    let bestMatch = null;
    let bestScore = 0;

    for (const [, item] of Object.entries(pricesData)) {
        if (!item.rami_levy_code) continue;
        if (item.name === productName) continue;

        let score = 0;
        for (const token of allTokens) {
            if (item.name.includes(token)) score++;
        }
        if (score > bestScore && score >= 2) {
            bestScore = score;
            bestMatch = { code: item.rami_levy_code, name: item.name, price: item.rami_levy_price || 0 };
        }
    }
    return bestMatch;
}

const STORE_SYNONYMS = [
    [/של פעם/g, 'אורגינל'],
    [/חמוצה/g, ''],
];

function extractSearchQuery(name) {
    let query = name;
    for (const [pattern, replacement] of STORE_SYNONYMS) {
        query = query.replace(pattern, replacement);
    }
    return query
        .replace(/\d+\.?\d*\s*%/g, '')
        .replace(/\d+\.?\d*\s*(גרם|מ"ל|מל|ליטר|ק"ג|קג|יח'?)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ===== CHROME HELPERS =====
function createHiddenTab(url) {
    return new Promise(resolve => chrome.tabs.create({ url, active: false }, resolve));
}

async function fetchInHiddenWindow(url, func, args = [], delay = 2500) {
    const tab = await createHiddenTab(url);
    try {
        await new Promise(r => setTimeout(r, delay));
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
        return results[0].result;
    } finally {
        chrome.tabs.remove(tab.id);
    }
}

// ===== SETTINGS - store selection =====
async function loadSettings() {
    return new Promise(resolve => {
        chrome.storage.local.get(['settings'], result => {
            resolve(result.settings || { ramiLevy: true, victory: true });
        });
    });
}

async function saveSettings(settings) {
    return new Promise(resolve => chrome.storage.local.set({ settings }, resolve));
}

// ===== SHUFERSAL CART SCANNER (runs in active tab) =====
function scanShufersalCart() {
    const cartItems = document.querySelectorAll('article.miglog-incart');
    const products = [];
    const seenCodes = new Set();

    cartItems.forEach(article => {
        const code = article.getAttribute('data-product-code');
        if (!code || seenCodes.has(code)) return;

        const nameElem = article.querySelector('.miglog-prod-name a') || article.querySelector('.title');
        const name = nameElem ? nameElem.innerText.trim() : 'מוצר';

        const qtyInput = article.querySelector('input.js-qty-selector-input, input[name="qty"]');
        const quantity = parseFloat(qtyInput?.value || article.getAttribute('data-entry-qty') || 1);

        const priceElem = article.querySelector('.miglog-prod-totalPrize') ||
                          article.querySelector('.miglog-prod-totalPrice') ||
                          article.querySelector('.price') ||
                          article.querySelector('.total-price');

        let shufersal_total = 0;
        if (priceElem) {
            shufersal_total = parseFloat(priceElem.innerText.replace(/[^\d.]/g, '')) || 0;
        }

        const discountElem = article.querySelector('.miglog-prod-totalDiscount');
        if (discountElem) {
            const rawDiscount = discountElem.innerText.replace(/[^\d.]/g, '');
            const discount = parseFloat(rawDiscount) || 0;
            shufersal_total = shufersal_total - discount;
        }

        if (quantity > 0) {
            products.push({ name, code, quantity, shufersal_total });
            seenCodes.add(code);
        }
    });
    return products;
}

// ===== RAMI LEVY CART SCANNER =====
async function scanRamiLevyCart() {
    try {
        const rlStorage = localStorage.getItem('ramilevy');
        let secretToken = '';
        if (rlStorage) {
            const parsed = JSON.parse(rlStorage);
            if (parsed.authuser?.user) secretToken = parsed.authuser.user.token;
        }

        const headers = { 'Accept': 'application/json, text/plain, */*' };
        if (secretToken) {
            headers['ecomtoken'] = secretToken;
            headers['authorization'] = 'Bearer ' + secretToken;
        }

        const resp = await fetch('https://www.rami-levy.co.il/api/v2/cart', { headers });
        if (!resp.ok) return [];
        const data = await resp.json();

        const products = [];
        if (data && data.items) {
            data.items.forEach(item => {
                if (item.is_delivery) return; // מתעלמים מדמי משלוח
                products.push({
                    code: String(item.id),
                    name: item.name,
                    quantity: item.quantity,
                    rami_levy_total: item.FormatedTotalPrice
                });
            });
        }
        return products;
    } catch(e) {
        console.error('שגיאה בסריקת עגלת רמי לוי:', e);
        return [];
    }
}

// ===== REVERSE LOOKUP DICTIONARY =====
function findShufersalDataByRamiLevy(ramiLevyCode, pricesData) {
    for (const [shufersalBarcode, itemData] of Object.entries(pricesData)) {
        if (String(itemData.rami_levy_code) === String(ramiLevyCode)) {
            return {
                shufersal_code: shufersalBarcode,
                name: itemData.name,
                victory_code: itemData.victory_code,
                shufersal_price: itemData.shufersal_price,
                victory_price: itemData.victory_price,
                victory_retailer_id: itemData.victory_retailer_id,
                substitute_code: itemData.substitute_code,
                substitute_name: itemData.substitute_name,
                substitute_price: itemData.substitute_price
            };
        }
    }
    return null;
}

// ===== RAMI LEVY AGENT (runs inside hidden Rami Levy window) =====
async function agentInsideCartEngine(itemsList) {
    const itemsPayload = {};
    itemsList.forEach(item => {
        if (item.id) itemsPayload[item.id] = parseFloat(item.quantity).toFixed(2);
    });

    let storeId = '1', secretToken = '';
    try {
        const rlStorage = localStorage.getItem('ramilevy');
        if (rlStorage) {
            const parsed = JSON.parse(rlStorage);
            if (parsed.authuser?.user) {
                storeId = String(parsed.authuser.user.store_id || 1);
                secretToken = parsed.authuser.user.token || '';
            }
        }
    } catch(e) {}

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8'
    };
    if (secretToken) {
        headers['ecomtoken'] = secretToken;
        headers['authorization'] = 'Bearer ' + secretToken;
    }

    try {
        const resp = await fetch('https://www.rami-levy.co.il/api/v2/cart', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                store: storeId, isClub: 0,
                supplyAt: new Date().toISOString(),
                items: itemsPayload,
                meta: { uid: 0 }
            })
        });
        if (resp.ok) {
            const data = await resp.json();
            return (data?.items || []).map(ci => ({
                id: String(ci.id),
                finalTotal: ci.FormatedTotalPrice,
                quantity: ci.quantity
            }));
        }
    } catch(e) {}
    return [];
}

// ===== VICTORY AGENT (runs inside hidden Victory window) =====
async function agentVictoryAgent(items) {
    const VICTORY_RETAILER_ID = 1470;
    const VICTORY_APP_ID = 4;

    const VICTORY_SEARCH_FILTERS = encodeURIComponent(JSON.stringify({
        "must": {
            "exists": ["family.id","family.categoriesPaths.id","branch.regularPrice"],
            "term": {"branch.isActive": true, "branch.isVisible": true}
        },
        "mustNot": {"term": {"branch.regularPrice": 0}},
        "bool": {
            "should": [
                {"bool": {"must_not": {"exists": {"field": "branch.outOfStockShowUntilDate"}}}},
                {"bool": {"must": [{"range": {"branch.outOfStockShowUntilDate": {"gt": "now"}}}, {"term": {"branch.isOutOfStock": true}}]}},
                {"bool": {"must": [{"term": {"branch.isOutOfStock": false}}]}}
            ]
        }
    }));

    let token = '';
    let branchId = null;
    let cartId = null;
    let userId = null;

    for (const key of Object.keys(localStorage)) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw || raw.length < 4) continue;

            if (/^[0-9a-f]{60,}$/.test(raw.trim())) { token = raw.trim(); continue; }

            const p = JSON.parse(raw);
            if (typeof p !== 'object' || !p) continue;

            const t = p?.token || p?.authToken || p?.access_token || p?.user?.token || p?.accessToken || p?.auth?.token || p?.session?.token;
            if (t && typeof t === 'string' && t.length > 40) token = t;

            const uid = p?.userId || p?.user?.id || p?.id || p?.data?.userId || p?.session?.userId;
            if (uid && !userId) userId = uid;

            const bid = p?.branchId || p?.branch?.id || p?.selectedBranch?.id || p?.currentBranch?.id || p?.store?.branchId;
            if (bid && !branchId) branchId = Number(bid);

            const cid = p?.cartId || p?.cart?.id || p?.currentCart?.id || p?.activeCart?.id;
            if (cid && !cartId) cartId = cid;

        } catch(e) {}
    }

    if (!token) {
        console.warn('[Victory] No token found in localStorage');
        return { results: [], debug: { token: false, branchId, cartId, userId, noToken: true } };
    }

    const baseHeaders = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8',
        'Authorization': 'Bearer ' + token
    };

    if (!branchId) {
        const discoveryEndpoints = [
            `/v2/retailers/${VICTORY_RETAILER_ID}/users/me?appId=${VICTORY_APP_ID}`,
            `/v2/retailers/${VICTORY_RETAILER_ID}/customers/me?appId=${VICTORY_APP_ID}`,
            `/v2/retailers/${VICTORY_RETAILER_ID}/users/${userId || 0}/settings?appId=${VICTORY_APP_ID}`,
        ];
        for (const ep of discoveryEndpoints) {
            if (branchId) break;
            try {
                const r = await fetch(ep, { headers: baseHeaders, credentials: 'include' });
                if (!r.ok) continue;
                const d = await r.json();
                const bid = d?.branchId || d?.selectedBranchId || d?.branch?.id
                          || d?.user?.branchId || d?.data?.branchId
                          || (Array.isArray(d?.branches) && d.branches[0]?.id);
                if (bid) branchId = Number(bid);
                const uid = d?.userId || d?.id || d?.user?.id;
                if (uid && !userId) userId = uid;
                const cid = d?.cartId || d?.cart?.id || d?.activeCartId;
                if (cid && !cartId) cartId = cid;
            } catch(e) {}
        }
    }

    if (!cartId && branchId && userId) {
        try {
            const ep = `/v2/retailers/${VICTORY_RETAILER_ID}/branches/${branchId}/carts?appId=${VICTORY_APP_ID}&userId=${userId}`;
            const r = await fetch(ep, { headers: baseHeaders, credentials: 'include' });
            if (r.ok) {
                const d = await r.json();
                const cid = d?.cart?.id || d?.id || d?.cartId
                           || (Array.isArray(d) && d[0]?.id)
                           || d?.data?.id || d?.data?.cart?.id;
                if (cid) cartId = Number(cid);
            }
        } catch(e) {}
    }

    if (!cartId && branchId && userId) {
        try {
            const r = await fetch(`/v2/retailers/${VICTORY_RETAILER_ID}/branches/${branchId}/carts?appId=${VICTORY_APP_ID}`, {
                method: 'POST',
                headers: { ...baseHeaders, 'Content-Type': 'application/json;charset=UTF-8' },
                credentials: 'include',
                body: JSON.stringify({ deliveryType: 1, source: 'Extension', userId })
            });
            if (r.ok) {
                const d = await r.json();
                const cid = d?.cart?.id || d?.id || d?.cartId || d?.data?.id || d?.data?.cart?.id;
                if (cid) cartId = Number(cid);
            }
        } catch(e) {}
    }

    const results = [];
    const foundIds = new Map();

    if (branchId) {
        const searchBase = `/v2/retailers/${VICTORY_RETAILER_ID}/branches/${branchId}/products/autocomplete`;
        for (const item of items) {
            if (item.retailerProductId) {
                foundIds.set(item.barcode, { retailerProductId: Number(item.retailerProductId), price: 0, quantity: item.quantity });
                continue;
            }

            let matched = false;
            for (const q of [item.barcode, item.name]) {
                if (matched) break;
                try {
                    const url = `${searchBase}?appId=${VICTORY_APP_ID}&filters=${VICTORY_SEARCH_FILTERS}&query=${encodeURIComponent(q)}&from=0&size=10&isSearch=true&languageId=1&userId=${userId}`;
                    const resp = await fetch(url, { headers: baseHeaders, credentials: 'include' });
                    if (!resp.ok) continue;
                    const data = await resp.json();

                    const products = data?.suggestions?.suggestProducts?.products || [];
                    const match = products.find(p =>
                        String(p.barcode) === String(item.barcode) ||
                        String(p.localBarcode) === String(item.barcode)
                    );

                    if (match?.id) {
                        const outOfStock = match.branch?.isOutOfStock === true;
                        const rid = Number(match.id);
                        const basePrice = parseFloat(match.branch?.salePrice ?? match.branch?.regularPrice ?? match.branch?.price ?? 0);
                        let finalTotal = basePrice * item.quantity;

                        const specials = match.branch?.specials || [];
                        if (specials.length > 0) {
                            for (const special of specials) {
                                const reqQty = special.firstLevel?.firstPurchaseTotal;
                                const promoPrice = special.firstLevel?.firstGift?.total ?? special.firstLevel?.total;

                                if (reqQty && promoPrice && item.quantity >= reqQty) {
                                    const promoCount = Math.floor(item.quantity / reqQty);
                                    const remainder = item.quantity % reqQty;
                                    const calculatedPromoTotal = (promoCount * promoPrice) + (remainder * basePrice);
                                    if (calculatedPromoTotal < finalTotal) {
                                        finalTotal = calculatedPromoTotal;
                                    }
                                }
                            }
                        }

                        foundIds.set(item.barcode, {
                            retailerProductId: rid,
                            price: outOfStock ? 0 : basePrice,
                            quantity: item.quantity,
                            outOfStock
                        });

                        if (basePrice > 0 && !outOfStock) {
                            results.push({
                                barcode: item.barcode,
                                finalTotal: finalTotal,
                                quantity: item.quantity,
                                outOfStock: false,
                                retailerProductId: rid
                            });
                        }
                        matched = true;
                    }
                } catch(e) {}
            }
        }
    }

    if (cartId && branchId) {
        const cartUrl = `/v2/retailers/${VICTORY_RETAILER_ID}/branches/${branchId}/carts/${cartId}?appId=${VICTORY_APP_ID}`;

        const allForCart = new Map();
        foundIds.forEach((info, barcode) => {
            allForCart.set(info.retailerProductId, { barcode, quantity: info.quantity });
        });
        items.forEach(i => {
            if (i.retailerProductId && !foundIds.has(i.barcode)) {
                allForCart.set(Number(i.retailerProductId), { barcode: i.barcode, quantity: i.quantity });
            }
        });

        const cartLines = Array.from(allForCart.entries()).map(([rid, info]) => ({
            quantity: Number(info.quantity),
            soldBy: null,
            retailerProductId: rid,
            type: 1
        }));

        function extractLinePrice(line) {
            const qty = line.quantity || 1;
            const lwt = line.lineWithTax != null ? parseFloat(line.lineWithTax) : null;
            const ap = line.actualPrice != null ? parseFloat(line.actualPrice) * qty : null;
            const orig = line.originalTotalPrice != null ? parseFloat(line.originalTotalPrice) : null;
            const base = line.price != null ? parseFloat(line.price) * qty : null;
            const validPrices = [lwt, ap, orig, base].filter(p => p != null && p > 0);
            if (validPrices.length > 0) return Math.min(...validPrices);
            return 0;
        }

        function processCartLines(lineList) {
            lineList.forEach(line => {
                if (line.type !== 1) return;
                const rid = Number(line.retailerProductId);
                const info = allForCart.get(rid);
                if (!info) return;
                const isOutOfStock = line.product?.branch?.isOutOfStock === true;
                const finalPrice = extractLinePrice(line);
                const existIdx = results.findIndex(r => r.barcode === info.barcode);
                let bestPrice = finalPrice;

                if (existIdx >= 0) {
                    if (results[existIdx].finalTotal > 0 && results[existIdx].finalTotal < bestPrice) {
                        bestPrice = results[existIdx].finalTotal;
                    }
                    results.splice(existIdx, 1);
                }

                results.push({
                    barcode: info.barcode,
                    finalTotal: isOutOfStock ? 0 : bestPrice,
                    quantity: line.quantity || info.quantity,
                    outOfStock: isOutOfStock,
                    retailerProductId: rid
                });
            });
        }

        const processedByGet = new Set();
        try {
            const getResp = await fetch(`${cartUrl}&userId=${userId}`, {
                method: 'GET', headers: baseHeaders, credentials: 'include'
            });
            if (getResp.ok) {
                const getData = await getResp.json();
                const existingLines = getData?.cart?.lines || getData?.lines || [];

                existingLines.forEach(line => {
                    if (line.type !== 1) return;
                    const rid = Number(line.retailerProductId);
                    const info = allForCart.get(rid);
                    if (!info || line.quantity !== info.quantity) return;
                    const isOutOfStock = line.product?.branch?.isOutOfStock === true;
                    const finalPrice = extractLinePrice(line);
                    const existIdx = results.findIndex(r => r.barcode === info.barcode);
                    let bestPrice = finalPrice;

                    if (existIdx >= 0) {
                        if (results[existIdx].finalTotal > 0 && results[existIdx].finalTotal < bestPrice) {
                            bestPrice = results[existIdx].finalTotal;
                        }
                        results.splice(existIdx, 1);
                    }

                    results.push({
                        barcode: info.barcode,
                        finalTotal: isOutOfStock ? 0 : bestPrice,
                        quantity: line.quantity,
                        outOfStock: isOutOfStock,
                        retailerProductId: rid
                    });
                    processedByGet.add(rid);
                });
            }
        } catch(e) {}

        const uncoveredLines = cartLines.filter(l => !processedByGet.has(l.retailerProductId));
        if (uncoveredLines.length > 0) {
            try {
                const resp = await fetch(cartUrl, {
                    method: 'POST',
                    headers: { ...baseHeaders, 'x-http-method-override': 'PATCH' },
                    credentials: 'include',
                    body: JSON.stringify({ lines: cartLines, deliveryType: 1, source: 'Extension' })
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const patchLines = (data?.cart?.lines || data?.lines || [])
                        .filter(l => !processedByGet.has(Number(l.retailerProductId)));
                    processCartLines(patchLines);
                }
            } catch(e) {}
        }
    }

    return { results, debug: { token: !!token, branchId, cartId, userId, foundCount: foundIds.size, totalItems: items.length } };
}

// ===== RAMI LEVY CATALOG SEARCH =====
async function searchRamiLevyCatalog(query, excludeCode = null) {
    try {
        const resp = await fetch('https://www.rami-levy.co.il/api/catalog', {
            method: 'POST',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json;charset=UTF-8',
                'Referer': 'https://www.rami-levy.co.il/he'
            },
            body: JSON.stringify({ q: query, store: 331 })
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.data?.length > 0) {
                const product = data.data.find(p => String(p.id) !== excludeCode);
                if (product) return { code: String(product.id), name: product.name, price: product.price?.price || 0 };
            }
        }
    } catch(e) {}
    return null;
}

// ===== SETTINGS UI INIT =====
async function initSettings() {
    const settings = await loadSettings();
    const ramiCheck = document.getElementById('toggleRamiLevy');
    const victoryCheck = document.getElementById('toggleVictory');

    ramiCheck.checked = settings.ramiLevy !== false;
    victoryCheck.checked = settings.victory !== false;

    ramiCheck.addEventListener('change', async () => {
        const s = await loadSettings();
        await saveSettings({ ...s, ramiLevy: ramiCheck.checked });
    });
    victoryCheck.addEventListener('change', async () => {
        const s = await loadSettings();
        await saveSettings({ ...s, victory: victoryCheck.checked });
    });

    document.getElementById('settingsBtn').addEventListener('click', () => {
        document.getElementById('storePanel').classList.toggle('open');
    });
}

// ===== MAIN COMPARISON FLOW =====
async function compareCarts() {
    const statusDiv = document.getElementById('status');
    const resultDiv = document.getElementById('result');
    const compareBtn = document.getElementById('compareBtn');

    statusDiv.innerHTML = '';
    resultDiv.innerHTML = '';
    finalCartToTransfer = [];
    compareBtn.disabled = true;

    document.getElementById('storePanel').classList.remove('open');

    try {
        const settings = await loadSettings();
        const compareRamiLevy = settings.ramiLevy !== false;
        const compareVictory = settings.victory !== false;

        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];

        if (!tab) {
            throw new Error("לא נמצאה לשונית פעילה. נסה לרענן את העמוד.");
        }

        const currentUrl = tab.url || '';

        // ★ זיהוי זירה ★
        let activeStore = 'shufersal';
        if (currentUrl.includes('rami-levy.co.il')) {
            activeStore = 'ramiLevy';
        }

        // 1. Scan active cart עם חליפת מגן
        statusDiv.innerHTML = `סורק עגלה מ${activeStore === 'ramiLevy' ? 'רמי לוי' : 'שופרסל'}...`;

        let rawCartItems = [];
        try {
            const scriptResults = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: activeStore === 'ramiLevy' ? scanRamiLevyCart : scanShufersalCart
            });

            // מוודא שהסריקה עבדה ושהיא החזירה לנו מערך אמיתי
            if (scriptResults && scriptResults[0] && Array.isArray(scriptResults[0].result)) {
                rawCartItems = scriptResults[0].result;
            }
        } catch (err) {
            console.warn("שגיאת סריקה (כנראה עמוד שגוי):", err);
            throw new Error(`לא ניתן לסרוק את העמוד הזה. אנא ודא שאתה נמצא באתר של ${activeStore === 'ramiLevy' ? 'רמי לוי' : 'שופרסל'} ולא בעמוד אחר.`);
        }

        if (!rawCartItems || rawCartItems.length === 0) {
            statusDiv.innerHTML = '❌ לא מצאתי מוצרים בעגלה.';
            compareBtn.disabled = false;
            return;
        }

        // 2. Load databases
        statusDiv.innerHTML = 'טוען מאגר נתונים...';
        const [pricesData, substitutesData] = await Promise.all([
            fetch(chrome.runtime.getURL('prices.json')).then(r => r.json()),
            fetch(chrome.runtime.getURL('substitutes.json')).then(r => r.json()).catch(() => ({}))
        ]);

        // 3. Map products
        const matchedItems = [];
        const missingItems = [];
        const itemsForRamiLevy = [];
        const itemsForVictory = [];

        rawCartItems.forEach(item => {
            let dbItem = null;
            let cleanBarcode = '';
            let shufersalCode = '';

            if (activeStore === 'ramiLevy') {
                const reverseMatch = findShufersalDataByRamiLevy(item.code, pricesData);
                if (reverseMatch) {
                    shufersalCode = reverseMatch.shufersal_code;
                    cleanBarcode = shufersalCode.replace('P_', '');
                    dbItem = reverseMatch;
                }
            } else {
                shufersalCode = item.code;
                let xmlKey = shufersalCode.startsWith('P_') ? shufersalCode : `P_${shufersalCode}`;
                dbItem = pricesData[xmlKey];
                cleanBarcode = shufersalCode.replace('P_', '');
                if (!dbItem) {
                    const matchingKey = Object.keys(pricesData).find(k => k.endsWith(cleanBarcode));
                    if (matchingKey) dbItem = pricesData[matchingKey];
                }
            }

            if (dbItem && (dbItem.rami_levy_code || activeStore === 'ramiLevy')) {
                const substituteData = dbItem.substitute_code ? {
                    code: dbItem.substitute_code, name: dbItem.substitute_name, price: dbItem.substitute_price
                } : null;

                let s_total = activeStore === 'shufersal' ? item.shufersal_total : (dbItem.shufersal_price || 0) * item.quantity;
                let rl_live_total = activeStore === 'ramiLevy' ? item.rami_levy_total : null;

                matchedItems.push({
                    name: item.name,
                    quantity: item.quantity,
                    shufersal_code: shufersalCode,
                    shufersal_total: s_total,
                    backup_target_code: String(dbItem.rami_levy_code),
                    victory_retailer_id: dbItem.victory_retailer_id || null,
                    victory_price_unit: dbItem.victory_price != null ? dbItem.victory_price : null,
                    substitute: substituteData,
                    rl_live_total: rl_live_total
                });

                if (activeStore === 'shufersal') {
                    itemsForRamiLevy.push({ id: String(dbItem.rami_levy_code), quantity: item.quantity });
                }

                itemsForVictory.push({
                    barcode: cleanBarcode,
                    name: item.name,
                    quantity: item.quantity,
                    retailerProductId: dbItem.victory_retailer_id || null
                });
            } else {
                missingItems.push(item);
            }
        });

        if (matchedItems.length === 0) {
            resultDiv.innerHTML = '<p style="color:#9ca3af; text-align:center; padding: 20px;">אף אחד מהמוצרים לא קיים במאגר להשוואה</p>';
            statusDiv.innerHTML = '';
            compareBtn.disabled = false;
            return;
        }

        // 4. Fetch Rami Levy prices
        let ramiLevyResults = [];
        if (activeStore !== 'ramiLevy' && compareRamiLevy && itemsForRamiLevy.length > 0) {
            statusDiv.innerHTML = 'בודק מחירים ברמי לוי...';
            try {
                ramiLevyResults = await fetchInHiddenWindow('https://www.rami-levy.co.il/he', agentInsideCartEngine, [itemsForRamiLevy], 2500) || [];
            } catch(e) {}
        }

        // 5. Fetch Victory prices
        let victoryResults = [];
        let agentDebug = null;
        if (compareVictory && itemsForVictory.length > 0) {
            statusDiv.innerHTML = 'בודק מחירים בויקטורי...';
            try {
                const agentResponse = await fetchInHiddenWindow('https://www.victoryonline.co.il', agentVictoryAgent, [itemsForVictory], 3500);
                if (agentResponse?.results) {
                    victoryResults = agentResponse.results;
                    agentDebug = agentResponse.debug || null;
                }
            } catch(e) {}
        }

        // 6. Classify matched items
        const inStockItems = [];
        const outOfStockItems = [];
        const itemsToDeleteCodes = new Set();

        matchedItems.forEach(item => {
            let ramiTotal = null;
            if (activeStore === 'ramiLevy') {
                ramiTotal = item.rl_live_total;
            } else {
                const liveData = ramiLevyResults.find(r => r.id === item.backup_target_code);
                ramiTotal = liveData ? liveData.finalTotal : (compareRamiLevy ? 0 : null);
            }

            const barcode = item.shufersal_code.replace('P_', '');
            const victoryLive = victoryResults.find(r => r.barcode === barcode);
            const victoryTotal = victoryLive
                ? (victoryLive.outOfStock ? null : victoryLive.finalTotal)
                : (item.victory_price_unit != null ? item.victory_price_unit * item.quantity : null);

            const obj = {
                name: item.name,
                quantity: item.quantity,
                shufersal_code: item.shufersal_code,
                targetCode: item.backup_target_code,
                shufersal_total: item.shufersal_total,
                rami_levy_total: compareRamiLevy ? (ramiTotal || 0) : null,
                victory_total: compareVictory ? victoryTotal : null,
                substitute: item.substitute
            };

            if (!compareRamiLevy || ramiTotal > 0 || activeStore === 'ramiLevy') {
                inStockItems.push(obj);
            } else {
                outOfStockItems.push(obj);
                itemsToDeleteCodes.add(item.backup_target_code);
            }
        });

        // 7. Search substitutes
        if (outOfStockItems.length > 0 && compareRamiLevy) {
            statusDiv.innerHTML = 'מחפש תחליפים...';
            await Promise.all(outOfStockItems.map(async outItem => {
                if (outItem.substitute) return;
                const barcode = outItem.shufersal_code.replace('P_', '');
                if (substitutesData[barcode]) {
                    outItem.substitute = substitutesData[barcode]; return;
                }
                const query = extractSearchQuery(outItem.name);
                outItem.substitute = await searchRamiLevyCatalog(query, outItem.targetCode);
                if (!outItem.substitute) outItem.substitute = findSubstitute(outItem.name, pricesData);
            }));
        }

        // 8. Substitute click handler
        resultDiv.addEventListener('click', e => {
            const btn = e.target.closest('.sub-btn');
            if (!btn) return;
            const idx = parseInt(btn.getAttribute('data-index'));
            const item = outOfStockItems[idx];
            if (!item) return;
            outOfStockItems.splice(idx, 1);
            inStockItems.push({
                name: '🔄 ' + item.substitute.name,
                quantity: item.quantity,
                shufersal_code: item.shufersal_code,
                targetCode: item.substitute.code,
                shufersal_total: item.shufersal_total,
                rami_levy_total: item.substitute.price * item.quantity,
                victory_total: null
            });
            renderUI();
        });

        renderUI();

        // ===== RENDER FUNCTION =====
        function renderUI() {
            let totalShufersal = 0, totalRamiLevy = 0, totalVictory = 0;
            let ramiCount = 0, victoryCount = 0;

            inStockItems.forEach(item => {
                totalShufersal += item.shufersal_total || 0;
                if (item.rami_levy_total !== null && item.rami_levy_total !== undefined) {
                    totalRamiLevy += item.rami_levy_total;
                    ramiCount++;
                }
                if (item.victory_total !== null && item.victory_total !== undefined) {
                    totalVictory += item.victory_total;
                    victoryCount++;
                }
            });

            const storesWithData = [];
            storesWithData.push({
                key: 'shufersal', name: 'שופרסל', total: totalShufersal,
                info: activeStore === 'shufersal' ? 'הסופר הנוכחי שלך' : 'ממאגר מחירים', hasData: true
            });

            if (compareRamiLevy) {
                storesWithData.push({
                    key: 'ramiLevy', name: 'רמי לוי', total: totalRamiLevy,
                    info: activeStore === 'ramiLevy' ? 'הסופר הנוכחי שלך' : (ramiCount > 0 ? 'מחיר חי' : 'ממתין'),
                    hasData: activeStore === 'ramiLevy' ? true : (ramiCount > 0)
                });
            }

            if (compareVictory) {
                storesWithData.push({
                    key: 'victory', name: 'ויקטורי', total: totalVictory,
                    info: victoryResults.length > 0 ? 'מחיר חי' : 'ממאגר',
                    hasData: victoryCount > 0,
                    debugInfo: victoryResults.length === 0 ? (agentDebug?.noToken ? 'לא מחובר לויקטורי' : (agentDebug?.branchId ? 'מחירים לא נמצאו' : 'לא נמצא סניף')) : null
                });
            }

            const sortable = storesWithData.filter(s => s.hasData).sort((a, b) => a.total - b.total);
            const noData = storesWithData.filter(s => !s.hasData);
            const orderedStores = [...sortable, ...noData];
            const cheapest = sortable[0];

            let html = `
            <div class="live-header">
                <div class="live-badge"><div class="live-dot"></div>השוואה חיה</div>
                <div class="comparison-title">אופטימיזציית עגלה</div>
                <div class="comparison-subtitle">ניתחנו ${rawCartItems.length} פריטים ברשתות שבחרת</div>
            </div>`;

            orderedStores.forEach((store) => {
                const isCheapest = store.hasData && sortable[0]?.key === store.key;
                const cheapestRef = sortable.find(s => s.key === activeStore) || sortable[0];
                const diff = (cheapestRef && store.hasData) ? store.total - cheapestRef.total : 0;
                const savingFromActive = cheapestRef.total - store.total;

                let diffHtml;
                if (!store.hasData) {
                    diffHtml = `<span class="price-diff same" style="background:#f3f4f6; color:#9ca3af">${store.debugInfo || 'ממתין לנתונים...'}</span>`;
                } else if (isCheapest && store.key !== activeStore && savingFromActive > 0.01) {
                    diffHtml = `<span class="price-diff saved">חסכת ${formatPrice(savingFromActive)}</span>`;
                } else if (isCheapest) {
                    diffHtml = `<span class="price-diff same">הכי זול!</span>`;
                } else {
                    diffHtml = `<span class="price-diff extra">+${formatPrice(diff)}</span>`;
                }

                let btnHtml = '';
                if (store.key === activeStore) {
                    btnHtml = `<button class="store-btn ghost">סופר נוכחי</button>`;
                } else if (store.key === 'ramiLevy') {
                    btnHtml = `<button class="store-btn dark" id="switchToRamiLevy">עבור לרמי לוי</button>`;
                } else if (store.key === 'victory') {
                    btnHtml = `<button class="store-btn blue" id="switchToVictory">${store.hasData ? 'עבור לויקטורי' : 'בחר ויקטורי'}</button>`;
                } else if (store.key === 'shufersal') {
                    btnHtml = `<button class="store-btn" style="background:#e8132b; color:white; border-color:#e8132b;" id="switchToShufersal">עבור לשופרסל</button>`;
                }

                const priceDisplay = store.hasData
                    ? `<div class="store-price"><span class="store-price-sym">₪</span>${store.total.toFixed(2)}</div>`
                    : `<div style="font-size:13px; color:#9ca3af; margin-top:4px;">לא זמין</div>`;

                html += `
                <div class="store-card ${isCheapest ? 'cheapest' : ''}">
                    ${isCheapest ? '<div class="cheapest-badge">הכי זול</div>' : ''}
                    <div class="store-top-row">
                        <div>
                            <div class="store-name">${store.name}</div>
                            ${isCheapest && store.key !== activeStore ? '<div class="guarantee-badge">✓ מחיר מובטח</div>' : ''}
                        </div>
                        <div class="store-price-block">${priceDisplay}</div>
                    </div>
                    <div class="store-bottom-row">
                        <div class="store-info">${store.info}</div>
                        ${diffHtml}
                    </div>
                    ${btnHtml}
                </div>`;
            });

            html += `
            <div class="details-section">
                <button class="details-toggle" id="detailsToggle">
                    <span>פירוט מוצרים (${inStockItems.length} זמינים)</span>
                    <span class="toggle-arrow" id="toggleArrow">▼</span>
                </button>
                <div class="details-content" id="detailsContent">`;

            if (inStockItems.length > 0) {
                html += '<div class="section-label">מוצרים זמינים</div><div class="product-list">';
                inStockItems.forEach(item => {
                    const rText = (compareRamiLevy && item.rami_levy_total !== null) ? `<span class="p-rami">${formatPrice(item.rami_levy_total)}</span>` : '';
                    const vText = (compareVictory && item.victory_total !== null && item.victory_total !== undefined) ? `<span class="p-victory">${formatPrice(item.victory_total)}</span>` : '';
                    html += `
                    <div class="product-item">
                        <span class="product-name">${item.name} x${item.quantity}</span>
                        <div class="product-prices">
                            <span class="p-shufersal">${formatPrice(item.shufersal_total)}</span>
                            ${rText}${vText}
                        </div>
                    </div>`;
                });
                html += '</div>';
            }

            if (outOfStockItems.length > 0) {
                html += '<div class="section-label">חסר במלאי רמי לוי</div><div class="out-section">';
                outOfStockItems.forEach((item, idx) => {
                    html += `<div class="out-item"><div class="out-item-name">${item.name} x${item.quantity}</div>`;
                    if (item.substitute) {
                        html += `<div class="out-item-sub">
                            <button class="sub-btn" data-index="${idx}">
                                החלף ל: ${item.substitute.name} (${formatPrice(item.substitute.price * item.quantity)})
                            </button></div>`;
                    }
                    html += '</div>';
                });
                html += '</div>';
            }

            if (missingItems.length > 0) {
                html += '<div class="section-label">לא במאגר התוסף</div><div class="missing-section">';
                missingItems.forEach(item => {
                    html += `<div class="missing-item">❌ ${item.name} x${item.quantity}</div>`;
                });
                html += '</div>';
            }

            html += '</div></div>';
            resultDiv.innerHTML = html;
            statusDiv.innerHTML = '✅ סיימנו!';

            sendAnalyticsEvent('comparisons', {
                cartSize: rawCartItems.length,
                matchedCount: matchedItems.length,
                missingCount: missingItems.length,
                inStockCount: inStockItems.length,
                outOfStockCount: outOfStockItems.length,
                shufersalTotal: parseFloat(totalShufersal.toFixed(2)),
                ramiLevyTotal: compareRamiLevy ? parseFloat(totalRamiLevy.toFixed(2)) : -1,
                victoryTotal: compareVictory ? parseFloat(totalVictory.toFixed(2)) : -1,
                cheapestStore: cheapest ? cheapest.key : 'shufersal'
            });

            const inStockCodes = new Set(inStockItems.map(i => i.targetCode));
            const deletePayload = Array.from(itemsToDeleteCodes)
                .filter(code => !inStockCodes.has(code))
                .map(code => ({ targetCode: code, quantity: 0 }));
            finalCartToTransfer = inStockItems.concat(deletePayload);

            document.getElementById('detailsToggle')?.addEventListener('click', () => {
                document.getElementById('detailsContent').classList.toggle('open');
                document.getElementById('toggleArrow').classList.toggle('open');
            });

            document.getElementById('switchToRamiLevy')?.addEventListener('click', () => {
                chrome.storage.local.set({ savedCart: finalCartToTransfer }, () => {
                    chrome.tabs.create({ url: 'https://www.rami-levy.co.il/he' });
                });
            });

            document.getElementById('switchToVictory')?.addEventListener('click', () => {
                const victoryCart = finalCartToTransfer.filter(i => i.quantity > 0).map(i => {
                    const dbKey = i.shufersal_code.startsWith('P_') ? i.shufersal_code : 'P_' + i.shufersal_code;
                    const dbItem = pricesData[dbKey];
                    const cleanBarcode = i.shufersal_code.replace('P_', '');
                    return {
                        name: i.name, amount: i.quantity, quantity: i.quantity,
                        shufersal_code: i.shufersal_code,
                        barcode: cleanBarcode,
                        victory_code: dbItem ? dbItem.victory_code : null,
                        victory_retailer_id: dbItem ? dbItem.victory_retailer_id : null
                    };
                });
                chrome.storage.local.set({ savedCartVictory: victoryCart }, () => {
                    chrome.tabs.create({ url: 'https://www.victoryonline.co.il' });
                });
            });

            document.getElementById('switchToShufersal')?.addEventListener('click', () => {
                const shufersalCart = finalCartToTransfer.filter(i => i.quantity > 0).map(i => {
                    return {
                        shufersalCode: i.shufersal_code,
                        quantity: i.quantity
                    };
                });
                chrome.storage.local.set({ savedCartShufersal: shufersalCart }, () => {
                    chrome.tabs.create({ url: 'https://www.shufersal.co.il/online/he/cart' });
                });
            });

            compareBtn.disabled = false;
        }

    } catch(error) {
        document.getElementById('result').innerHTML = `<p style="color:#dc2626; text-align:center; padding:16px;">!שגיאה:<br>${error.message}</p>`;
        document.getElementById('status').innerHTML = '';
        compareBtn.disabled = false;
        console.error(error);
    }
}

// ===== VICTORY DEBUG AGENT =====
function agentVictoryDebug() { /* (נשאר ללא שינוי) */ }
async function debugVictoryConnection() { /* (נשאר ללא שינוי) */ }

// ===== FIREBASE ANALYTICS =====
const FIREBASE_PROJECT_ID = 'supermarket-compare-81306';
const FIREBASE_API_KEY    = 'AIzaSyDwDsfZryLFFPw57Il8lBtvgsYFFXqaxYs';

function _toFsVal(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number')  return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string')  return { stringValue: v };
    if (Array.isArray(v))       return { arrayValue: { values: v.map(_toFsVal) } };
    return { stringValue: String(v) };
}

function sendAnalyticsEvent(collection, data) {
    if (FIREBASE_PROJECT_ID === 'YOUR_PROJECT_ID') return;
    try {
        const fields = {};
        for (const [k, v] of Object.entries(data)) fields[k] = _toFsVal(v);
        fields.timestamp = { timestampValue: new Date().toISOString() };
        fetch(
            `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}?key=${FIREBASE_API_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }
        );
    } catch(e) { }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    initSettings();
    const btn = document.getElementById('compareBtn');
    if (btn) {
        btn.addEventListener('click', compareCarts);
    }
});