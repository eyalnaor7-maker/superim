// ===== STATE =====
let finalCartToTransfer = [];

// ===== UTILITIES =====
const formatPrice = amount => `₪${parseFloat(amount || 0).toFixed(2)}`;

let pricesData = {};


// ===== AI SUBSTITUTE ENGINE HELPERS =====
async function fetchSubstituteDetails(substituteBarcodes, headers) {
    if (!substituteBarcodes || substituteBarcodes.length === 0) return;
    
    // De-duplicate and filter out barcodes already in pricesData
    const missingBarcodes = substituteBarcodes.filter(b => {
        const xmlKey = b.startsWith('P_') ? b : `P_${b}`;
        const rawKey = b.replace('P_', '');
        return !pricesData[xmlKey] && !pricesData[rawKey];
    });
    
    if (missingBarcodes.length === 0) return;
    
    const queryParams = new URLSearchParams({
        select: 'barcode,name,store_products(store_name,store_code,price,updated_at)',
        barcode: `in.(${missingBarcodes.join(',')})`
    });
    
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, { headers });
        if (!response.ok) throw new Error(`Substitutes details query failed: ${response.statusText}`);
        const products = await response.json();
        
        products.forEach(p => {
            const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
            const itemData = {
                name: p.name,
                shufersal_price: null,
                rami_levy_price: null,
                rami_levy_code: null,
                victory_code: null,
                victory_price: null,
                substitutes: []
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
            pricesData[xmlKey] = itemData;
            pricesData[xmlKey.replace('P_', '')] = itemData;
        });
    } catch (err) {
        console.error("שגיאה בטעינת פרטי תחליפים מ-Supabase:", err);
    }
}





// ===== CHROME HELPERS =====
// The popup can be detached into its own window (popup.html?tabId=N) so the shopper can move it off the cart.
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

async function popOut() {
    const tab = await getTargetTab();
    const { winPos } = await chrome.storage.local.get('winPos');
    const base = { url: `popup.html?tabId=${tab ? tab.id : ''}`, type: 'popup', width: 378, height: 660 };
    // a remembered position on a screen that is no longer connected is refused: open at the default place instead
    await chrome.windows.create({ ...base, ...(winPos || {}) }).catch(() => chrome.windows.create(base));
    await chrome.storage.local.set({ detached: true });
    window.close();
}

async function initWindowMode() {
    const btn = document.getElementById('popoutBtn');
    if (!DETACHED_TAB_ID) {
        if ((await chrome.storage.local.get('detached')).detached) return popOut(); // the shopper chose the movable window last time
        btn.addEventListener('click', popOut);
        return;
    }
    document.body.classList.add('detached');
    btn.title = 'חזרה לחלונית הרגילה של התוסף';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', async () => { await chrome.storage.local.set({ detached: false }); window.close(); });
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
        for (let i = 0; i < 100; i++) {
            const t = await chrome.tabs.get(tab.id).catch(() => null);
            if (!t) break;
            const there = String(t.url || '').startsWith(origin);
            if (there && !arrivedAt) arrivedAt = Date.now();
            if (there && (t.status === 'complete' || Date.now() - arrivedAt > 6000)) break;
            await sleep(200);
        }
        await sleep(600);
        // a page that reloads under the script (a redirect, a bot check) gives no answer: try once more
        for (let attempt = 0; attempt < 2; attempt++) {
            const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args }).catch(() => null);
            if (results?.[0]?.result != null) return results[0].result;
            await sleep(1500);
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

// Save a branchId discovered from a store's website automatically
async function saveBranchId(store, branchId) {
    return new Promise(resolve => {
        chrome.storage.sync.get(['userSettings'], result => {
            const us = result.userSettings || {};
            if (!us[store]) us[store] = {};
            if (us[store].branchId !== String(branchId)) {
                us[store].branchId = String(branchId);
                chrome.storage.sync.set({ userSettings: us }, resolve);
            } else {
                resolve();
            }
        });
    });
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
        if (name.includes('משלוח') || name.toLowerCase().includes('delivery') || name.toLowerCase().includes('shipping')) return;

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
// Runs in the Rami Levy tab and only hands back the stored cart; ramiCartLines (rami_guest.js) prices it.
function scanRamiLevyCart() {
    try {
        const raw = localStorage.getItem('ramilevy') || sessionStorage.getItem('ramilevy');
        const items = raw ? JSON.parse(raw)?.cart?.items : null;
        return Array.isArray(items) ? items : [];
    } catch(e) {
        console.error('שגיאה בסריקת עגלת רמי לוי מהזיכרון:', e);
        return [];
    }
}

// ===== VICTORY CART SCANNER =====
// Runs in the Victory tab via executeScript: must be self-contained.
async function scanVictoryCart() {
    try {
        const sessionId = localStorage.getItem('cart-session-id');
        if (!sessionId) return [];
        const resp = await fetch('https://api.victoryonline.co.il/api/web/cart', {
            headers: { 'Accept': 'application/json', 'Cart-Session-Id': sessionId }
        });
        if (!resp.ok) return [];
        const json = await resp.json();
        if (json?.status !== 'success') return [];
        const lines = json.data?.items || [];

        const products = [];
        lines.forEach(line => {
            const m = String(line.featuredImage || '').match(/\/(?:product-images|gs1)\/(\d+)\//);
            const quantity = Number(line.quantity) || 1;
            const lineTotal = line.totalSalePrice ?? line.totalPrice; // totalSalePrice exists only when a sale applies, and is what the shopper pays
            const total = lineTotal != null ? parseFloat(lineTotal) : (parseFloat(line.price) || 0) * quantity;
            products.push({
                code: m ? m[1] : 'victory-' + line.id, // no barcode in the image path: keep the line so it shows as unmatched
                name: line.name || 'מוצר',
                quantity: quantity,
                victory_total: total
            });
        });
        return products;
    } catch(e) {
        console.error('Error scanning Victory cart:', e);
        return [];
    }
}

// ===== MACHSANEI HASHUK CART SCANNER =====
async function scanMCKCart() {
    try {
        const settingsData = await loadSettings();
        const userSettings = settingsData.userSettings || {};
        const mckSettings = userSettings.machsaneiHashuk || {};

        const MCK_RETAILER_ID = 1107;
        const MCK_APP_ID = 4;

        function extractLinePrice(line) {
            const qty = line.quantity || 1;
            const lwt = line.lineWithTax != null ? parseFloat(line.lineWithTax) : null;
            const ap = line.actualPrice != null ? parseFloat(line.actualPrice) * qty : null;
            const orig = line.originalTotalPrice != null ? parseFloat(line.originalTotalPrice) : null;
            const base = line.price != null ? parseFloat(line.price) * qty : null;
            const prices = [lwt, ap, orig, base].filter(p => p != null && p > 0);
            let minPrice = prices.length > 0 ? Math.min(...prices) : 0;

            // Fallback base price from product object
            const prodRegPrice = line.product?.branch?.regularPrice != null ? parseFloat(line.product.branch.regularPrice) : null;
            const prodSalePrice = line.product?.branch?.salePrice != null ? parseFloat(line.product.branch.salePrice) : null;
            const prodPrice = line.product?.price != null ? parseFloat(line.product.price) : null;
            const basePrice = prodSalePrice ?? prodRegPrice ?? prodPrice ?? (line.price != null ? parseFloat(line.price) : 0);
            
            if (minPrice === 0 && basePrice > 0) {
                minPrice = basePrice * qty;
            }

            // Apply branch specials if available
            const specials = line.product?.branch?.specials || line.product?.specials || [];
            if (specials.length > 0 && basePrice > 0) {
                for (const special of specials) {
                    const reqQty = special.firstLevel?.firstPurchaseTotal;
                    const promoPrice = special.firstLevel?.firstGift?.total ?? special.firstLevel?.total;

                    if (reqQty && promoPrice && qty >= reqQty) {
                        const promoCount = Math.floor(qty / reqQty);
                        const remainder = qty % reqQty;
                        const calculatedPromoTotal = (promoCount * promoPrice) + (remainder * basePrice);
                        if (minPrice === 0 || calculatedPromoTotal < minPrice) {
                            minPrice = calculatedPromoTotal;
                        }
                    }
                }
            }

            return minPrice;
        }

        function extractBarcode(product) {
            if (!product) return null;
            if (product.barcode) return String(product.barcode);
            if (product.localBarcode) return String(product.localBarcode);
            let imageUrl = null;
            if (product.image) {
                if (typeof product.image === 'string') imageUrl = product.image;
                else if (typeof product.image === 'object' && product.image.url) imageUrl = product.image.url;
            }
            if (!imageUrl && product.images && Array.isArray(product.images) && product.images.length > 0) {
                const firstImg = product.images[0];
                if (typeof firstImg === 'string') imageUrl = firstImg;
                else if (typeof firstImg === 'object' && firstImg.url) imageUrl = firstImg.url;
            }
            if (imageUrl && typeof imageUrl === 'string') {
                const match = imageUrl.match(/\/(\d{8,14})(?:-|\/|\.|\?)/) || imageUrl.match(/\b(\d{8,14})\b/);
                if (match) return match[1];
            }
            return null;
        }

        // 1. Try local storage / session storage parsing first (Offline / Guest Cart)
        let localCartItems = null;
        const allKeys = new Set([...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
        for (const key of allKeys) {
            try {
                const val = localStorage.getItem(key) || sessionStorage.getItem(key);
                if (!val || val.length < 50) continue;
                const parsed = JSON.parse(val);
                if (typeof parsed !== 'object') continue;

                function findCartItems(obj) {
                    if (!obj || typeof obj !== 'object') return null;
                    if (Array.isArray(obj)) {
                        const isCart = obj.length > 0 && obj.every(item => {
                            if (!item || typeof item !== 'object') return false;
                            const keys = Object.keys(item).join(',').toLowerCase();
                            const hasProduct = keys.includes('retailerproductid') || keys.includes('product');
                            const hasQty = keys.includes('qty') || keys.includes('quantity') || keys.includes('amount');
                            return hasProduct && hasQty;
                        });
                        if (isCart) return obj;
                    }
                    for (const k of Object.keys(obj)) {
                        const found = findCartItems(obj[k]);
                        if (found) return found;
                    }
                    return null;
                }
                const found = findCartItems(parsed);
                if (found) {
                    localCartItems = found;
                    break;
                }
            } catch(e) {}
        }

        if (localCartItems) {
            const products = [];
            localCartItems.forEach(line => {
                if (line.type != null && line.type !== 1) return;
                const product = line.product;
                if (!product) return;
                const barcode = extractBarcode(product);
                if (!barcode) return;

                const name = product.name || 'מוצר';
                if (name.includes('משלוח') || name.toLowerCase().includes('delivery') || name.toLowerCase().includes('shipping')) return;
                const quantity = line.quantity || 1;
                const finalTotal = extractLinePrice(line);

                products.push({
                    code: String(barcode),
                    name: name,
                    quantity: quantity,
                    mck_total: finalTotal
                });
            });
            if (products.length > 0) return products;
        }

        // 2. Fallback to API requests if storage search failed
        let token = '';
        let branchId = null;
        let cartId = null;
        let userId = null;

        for (const key of allKeys) {
            try {
                const raw = localStorage.getItem(key) || sessionStorage.getItem(key);
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

                const cid = p?.cartId || p?.serverCartId || p?.cart?.id || p?.currentCart?.id || p?.activeCart?.id;
                if (cid && !cartId) cartId = cid;

            } catch(e) {}
        }

        // Save newly discovered branchId, or fallback to saved one
        if (branchId) {
            saveBranchId('machsaneiHashuk', branchId);
        } else if (mckSettings.branchId) {
            branchId = Number(mckSettings.branchId);
        }

        if (!token) {
            console.warn('[MCK Scanner] No token found');
            return [];
        }

        const baseHeaders = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=UTF-8',
            'Authorization': token.includes('Bearer') ? token : 'Bearer ' + token
        };

        if (!branchId) {
            const discoveryEndpoints = [
                `/v2/retailers/${MCK_RETAILER_ID}/users/me?appId=${MCK_APP_ID}`,
                `/v2/retailers/${MCK_RETAILER_ID}/customers/me?appId=${MCK_APP_ID}`,
                `/v2/retailers/${MCK_RETAILER_ID}/users/${userId || 0}/settings?appId=${MCK_APP_ID}`,
            ];
            for (const ep of discoveryEndpoints) {
                if (branchId) break;
                try {
                    const r = await fetch(ep, { headers: baseHeaders });
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
                const ep = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/carts?appId=${MCK_APP_ID}&userId=${userId}`;
                const r = await fetch(ep, { headers: baseHeaders });
                if (r.ok) {
                    const d = await r.json();
                    const cid = d?.cart?.id || d?.id || d?.cartId
                               || (Array.isArray(d) && d[0]?.id)
                               || d?.data?.id || d?.data?.cart?.id;
                    if (cid) cartId = Number(cid);
                }
            } catch(e) {}
        }

        if (!branchId || !cartId) {
            console.warn('[MCK Scanner] Missing branchId or cartId');
            return [];
        }

        const cartUrl = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/carts/${cartId}?appId=${MCK_APP_ID}`;
        const resp = await fetch(cartUrl, {
            method: 'POST',
            headers: {
                ...baseHeaders,
                'x-http-method-override': 'PATCH'
            },
            credentials: 'include',
            body: JSON.stringify({ lines: [] })
        });
        if (!resp.ok) return [];

        const data = await resp.json();
        const lines = data?.cart?.lines || data?.lines || [];

        const products = [];
        lines.forEach(line => {
            if (line.type !== 1) return;
            const product = line.product;
            if (!product) return;

            const barcode = extractBarcode(product);
            if (!barcode) return;

            const name = product.name || 'מוצר';
            if (name.includes('משלוח') || name.toLowerCase().includes('delivery') || name.toLowerCase().includes('shipping')) return;
            const quantity = line.quantity || 1;
            const finalTotal = extractLinePrice(line);

            products.push({
                code: String(barcode),
                name: name,
                quantity: quantity,
                mck_total: finalTotal
            });
        });

        return products;
    } catch(e) {
        console.error('Error scanning MCK cart:', e);
        return [];
    }
}

// ===== ACTIVE STORE DETECTOR =====
function detectActiveStore(url) {
    if (!url) return 'shufersal';
    if (url.includes('rami-levy.co.il')) {
        return 'ramiLevy';
    }
    if (url.includes('victoryonline.co.il') || url.includes('victory')) {
        return 'victory';
    }
    if (url.includes('mck.co.il')) {
        return 'machsaneiHashuk';
    }
    return 'shufersal';
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
                substitutes: itemData.substitutes || []
            };
        }
    }
    return null;
}

// ===== RAMI LEVY AGENT (runs inside hidden Rami Levy window) =====
async function agentInsideCartEngine(itemsList, settingsStoreId) {
    const itemsPayload = {};
    itemsList.forEach(item => {
        if (item.id) itemsPayload[item.id] = parseFloat(item.quantity).toFixed(2);
    });

    let storeId = Number(settingsStoreId) || 331, secretToken = ''; // 331 is the store the site gives a guest
    try {
        const rlStorage = localStorage.getItem('ramilevy') || sessionStorage.getItem('ramilevy');
        if (rlStorage) {
            const parsed = JSON.parse(rlStorage);
            if (parsed.authuser?.user) {
                storeId = Number(parsed.authuser.user.store_id || storeId);
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
                store: Number(storeId), isClub: 0,
                supplyAt: new Date().toISOString(),
                items: itemsPayload,
                meta: { uid: 0 }
            })
        });
        if (resp.ok) {
            const data = await resp.json();
            const cartItemsMap = {};
            (data?.items || []).forEach(ci => {
                cartItemsMap[String(ci.id)] = ci;
            });
            const deliveryLine = (data?.items || []).find(ci => ci.is_delivery); // the site adds its delivery charge as a cart line
            return { delivery: deliveryLine ? Number(deliveryLine.FormatedTotalPrice) : null, results: itemsList.map(item => {
                const ci = cartItemsMap[item.id];
                const isOutOfStock = !ci;
                return {
                    id: item.id,
                    finalTotal: isOutOfStock ? 0 : (ci ? ci.FormatedTotalPrice : 0),
                    quantity: ci ? ci.quantity : item.quantity,
                    outOfStock: isOutOfStock
                };
            }) };
        }
    } catch(e) {
        console.error("Cart API failed", e);
    }

    // Fallback if cart request failed: return all as out of stock
    return { delivery: null, results: itemsList.map(item => ({
        id: item.id,
        finalTotal: 0,
        quantity: item.quantity,
        outOfStock: true
    })) };
}

// ===== SHUFERSAL AGENT (runs inside hidden Shufersal window) =====
async function agentShufersalAgent(items) {
    const results = [];
    const debug = {};

    for (const item of items) {
        const barcode = item.barcode;
        const q = barcode.startsWith('P_') ? barcode : `P_${barcode}`;
        try {
            const response = await fetch(`/online/he/search?text=${encodeURIComponent(barcode)}`);
            if (!response.ok) {
                results.push({ barcode, outOfStock: true });
                continue;
            }
            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');

            // 1. Try search results list item matching the barcode
            let card = doc.querySelector(`li[data-product-code="${q}"]`) || 
                       doc.querySelector(`li[data-product-code="${barcode}"]`) ||
                       doc.querySelector(`article.miglog-incart[data-product-code="${q}"]`) ||
                       doc.querySelector(`article.miglog-incart[data-product-code="${barcode}"]`) ||
                       doc.querySelector('li.miglog-prod') ||
                       doc.querySelector('article.miglog-incart');

            if (card) {
                const priceElem = card.querySelector('.miglog-prod-totalPrize') ||
                                  card.querySelector('.miglog-prod-totalPrice') ||
                                  card.querySelector('.price') ||
                                  card.querySelector('.total-price') ||
                                  card.querySelector('.price-number');
                if (priceElem) {
                    const priceText = priceElem.innerText.replace(/[^\d.]/g, '');
                    let price = parseFloat(priceText) || 0;

                    const discountElem = card.querySelector('.miglog-prod-totalDiscount') || card.querySelector('.discount');
                    if (discountElem) {
                        const discount = parseFloat(discountElem.innerText.replace(/[^\d.]/g, '')) || 0;
                        price = price - discount;
                    }

                    results.push({
                        barcode,
                        price,
                        finalTotal: price * item.quantity,
                        outOfStock: price <= 0
                    });
                    continue;
                }
            }

            // 2. Try single product page details (if redirected)
            const priceElem = doc.querySelector('.product-price') || 
                              doc.querySelector('.sp-price') || 
                              doc.querySelector('.price') ||
                              doc.querySelector('.price-number') ||
                              doc.querySelector('.current-price');
            if (priceElem) {
                const priceText = priceElem.innerText.replace(/[^\d.]/g, '');
                let price = parseFloat(priceText) || 0;
                
                results.push({
                    barcode,
                    price,
                    finalTotal: price * item.quantity,
                    outOfStock: price <= 0
                });
                continue;
            }

            results.push({ barcode, outOfStock: true });
        } catch (e) {
            console.error('[Shufersal Agent] Error fetching barcode ' + barcode, e);
            results.push({ barcode, outOfStock: true });
        }
    }
    // the header of the site's own page states the delivery charge; by now the hidden tab has had time to load it
    const fee = document.body?.textContent.match(/דמי שירות במשלוח\s*([\d.]+)/);
    if (fee) debug.deliveryFee = parseFloat(fee[1]);
    // read only: the slots for the address the shopper already saved on the site, each with its price. {} when none.
    try {
        const r = await fetch('/online/he/timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false');
        const slots = r.ok ? await r.json() : {};
        debug.slotFees = Object.fromEntries(Object.entries(slots || {}).map(([day, list]) => [
            day.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
            (Array.isArray(list) ? list : []).filter(x => x && x.selectable !== false).map(x => x.price && x.price.value)
        ]));
    } catch (e) { }
    return { results, debug };
}

// ===== VICTORY AGENT (runs inside hidden Victory window) =====
// Serialized by executeScript: everything it uses must be defined inside it.
async function agentVictoryAgent(items, settingsBranchId) {
    const branchId = String(settingsBranchId || '55');
    const ALGOLIA_URL = 'https://QF3L7C47QU-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=0abb07df3782882c383198f99009782d&x-algolia-application-id=QF3L7C47QU';
    const norm = v => String(v == null ? '' : v).replace(/^P_/, '').replace(/\D/g, '').replace(/^0+/, '');
    const results = [];
    const notFound = [];
    const debug = { branchId, foundCount: 0, totalItems: items.length, notFound };

    const withBarcode = items.filter(i => norm(i.barcode));
    items.filter(i => !norm(i.barcode)).forEach(i => notFound.push(i.barcode || i.name || ''));

    for (let start = 0; start < withBarcode.length; start += 20) {
        const batch = withBarcode.slice(start, start + 20);
        let data = null;
        try {
            const resp = await fetch(ALGOLIA_URL, {
                method: 'POST',
                body: JSON.stringify({ requests: batch.map(i => ({
                    indexName: 'products', query: norm(i.barcode), hitsPerPage: 6, page: 0,
                    facetFilters: [[`inStockBranches:${branchId}`]], relevancyStrictness: 0
                })) })
            });
            if (resp.status === 429) { debug.blocked = true; debug.reason = 'HTTP 429'; break; }
            if (!resp.ok) { debug.reason = 'HTTP ' + resp.status; batch.forEach(i => notFound.push(i.barcode)); continue; }
            data = await resp.json();
        } catch (e) {
            debug.reason = 'network error';
            batch.forEach(i => notFound.push(i.barcode));
            continue;
        }
        if (data && data.captchaAction) { debug.blocked = true; debug.reason = 'captchaAction'; break; }

        batch.forEach((item, idx) => {
            const hits = data?.results?.[idx]?.hits || [];
            const want = norm(item.barcode);
            const hit = hits.find(h => h && norm(h.sku) === want);
            if (!hit) { notFound.push(item.barcode); return; }
            const price = parseFloat(hit.price) || 0;
            const outOfStock = hit.inStock === false || price <= 0;
            const qty = Number(item.quantity) || 1;
            debug.foundCount++;
            results.push({
                barcode: item.barcode,
                finalTotal: outOfStock ? 0 : price * qty,
                quantity: item.quantity,
                outOfStock,
                unitPrice: price,
                sales: hit.sales || [], // priced in the popup by victorySaleTotal
                retailerProductId: String(hit.id),
                name: hit.name,
                isWeight: !!hit.isWeight
            });
        });
    }

    return { results, debug };
}

// ===== MACHSANEI HASHUK AGENT (runs inside hidden MCK window) =====
async function agentMCKAgent(items, settingsBranchId) {
    const MCK_RETAILER_ID = 1107;
    const MCK_APP_ID = 4;

    const MCK_SEARCH_FILTERS = encodeURIComponent(JSON.stringify({
        "must": {
            "exists": ["family.id","family.categoriesPaths.id","branch.regularPrice"],
            "term": {"branch.isActive": true, "branch.isVisible": true}
        },
        "mustNot": {"term": {"branch.regularPrice": 0, "branch.isOutOfStock": true}}
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

            const cid = p?.cartId || p?.serverCartId || p?.cart?.id || p?.currentCart?.id || p?.activeCart?.id;
            if (cid && !cartId) cartId = cid;

        } catch(e) {}
    }

    // No token: still try the public catalog, without Authorization
    let authBlocked = false;
    const baseHeaders = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8'
    };
    if (token) baseHeaders['Authorization'] = 'Bearer ' + token;

    if (!branchId) {
        const discoveryEndpoints = [
            `/v2/retailers/${MCK_RETAILER_ID}/users/me?appId=${MCK_APP_ID}`,
            `/v2/retailers/${MCK_RETAILER_ID}/customers/me?appId=${MCK_APP_ID}`,
            `/v2/retailers/${MCK_RETAILER_ID}/users/${userId || 0}/settings?appId=${MCK_APP_ID}`,
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
            const ep = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/carts?appId=${MCK_APP_ID}&userId=${userId}`;
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
            const r = await fetch(`/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/carts?appId=${MCK_APP_ID}`, {
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

    if (!branchId && settingsBranchId) branchId = Number(settingsBranchId);

    const results = [];
    const foundIds = new Map();

    if (branchId) {
        const searchBase = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/products/autocomplete`;
        for (const item of items) {
            if (authBlocked) break;
            const knownRetailerId = item.retailerProductId ? Number(item.retailerProductId) : null;

            let matched = false;
            for (const q of [item.barcode, item.name]) {
                if (matched || authBlocked) break;
                try {
                    const url = `${searchBase}?appId=${MCK_APP_ID}&filters=${MCK_SEARCH_FILTERS}&query=${encodeURIComponent(q)}&from=0&size=10&isSearch=true&languageId=1&userId=${userId}`;
                    const resp = await fetch(url, { headers: baseHeaders, credentials: 'include' });
                    // 401/403/429 or an HTML bot-check page: stop calling this chain
                    if ([401, 403, 429].includes(resp.status) || !(resp.headers.get('content-type') || '').includes('json')) { authBlocked = true; break; }
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
            if (!matched && knownRetailerId) {
                foundIds.set(item.barcode, { retailerProductId: knownRetailerId, price: 0, quantity: item.quantity, outOfStock: false });
            }
        }
    }

    if (cartId && branchId) {
        const cartUrl = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/carts/${cartId}?appId=${MCK_APP_ID}`;

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
            const prices = [lwt, ap, orig, base].filter(p => p != null && p > 0);
            let minPrice = prices.length > 0 ? Math.min(...prices) : 0;

            // Fallback base price from product object
            const prodRegPrice = line.product?.branch?.regularPrice != null ? parseFloat(line.product.branch.regularPrice) : null;
            const prodSalePrice = line.product?.branch?.salePrice != null ? parseFloat(line.product.branch.salePrice) : null;
            const prodPrice = line.product?.price != null ? parseFloat(line.product.price) : null;
            const basePrice = prodSalePrice ?? prodRegPrice ?? prodPrice ?? (line.price != null ? parseFloat(line.price) : 0);
            
            if (minPrice === 0 && basePrice > 0) {
                minPrice = basePrice * qty;
            }

            // Apply branch specials if available
            const specials = line.product?.branch?.specials || line.product?.specials || [];
            if (specials.length > 0 && basePrice > 0) {
                for (const special of specials) {
                    const reqQty = special.firstLevel?.firstPurchaseTotal;
                    const promoPrice = special.firstLevel?.firstGift?.total ?? special.firstLevel?.total;

                    if (reqQty && promoPrice && qty >= reqQty) {
                        const promoCount = Math.floor(qty / reqQty);
                        const remainder = qty % reqQty;
                        const calculatedPromoTotal = (promoCount * promoPrice) + (remainder * basePrice);
                        if (minPrice === 0 || calculatedPromoTotal < minPrice) {
                            minPrice = calculatedPromoTotal;
                        }
                    }
                }
            }

            return minPrice;
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
            const getResp = await fetch(cartUrl, {
                method: 'POST',
                headers: {
                    ...baseHeaders,
                    'x-http-method-override': 'PATCH'
                },
                credentials: 'include',
                body: JSON.stringify({ lines: [] })
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

    if (authBlocked && results.length === 0) return { results: [], debug: { needsLogin: true, branchId } };
    return { results, debug: { token: !!token, branchId, cartId, userId, foundCount: foundIds.size, totalItems: items.length, needsLogin: !token && !branchId } };
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
async function compareCarts() {
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

    try {
        const settings = await loadSettings();
        const compareShufersal = settings.shufersal !== false;
        const compareRamiLevy = settings.ramiLevy !== false;
        const compareVictory = settings.victory !== false;
        const compareMCK = settings.machsaneiHashuk !== false;

        const tab = await getTargetTab();

        if (!tab) {
            throw new Error("לא נמצאה לשונית פעילה. נסה לרענן את העמוד.");
        }

        const currentUrl = tab.url || '';

        // ★ זיהוי זירה ★
        const activeStore = detectActiveStore(currentUrl);
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

        // 1. Scan active cart עם חליפת מגן
        statusDiv.innerHTML = `סורק עגלה מ${activeStoreName}...`;

        const delivery = {}; // store key -> { fee, note, minOrder }: what delivery costs there, as the chain itself states it
        const slotDays = {}; // store key -> deliveryFromDays(): the fee per delivery day, where the chain gives it
        let rawCartItems = [];
        try {
            const scriptResults = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: scanFunc
            });

            // מוודא שהסריקה עבדה ושהיא החזירה לנו מערך אמיתי
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

        // 2. Query Database / Load Local Fallback
        const codes = rawCartItems.map(item => item.code);

        let headers = null;
        {
            statusDiv.innerHTML = 'טוען נתונים מ-Supabase...';
            pricesData = {};
            headers = {
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json"
            };

            if (activeStore === 'shufersal') {
                // שופרסל: data-product-code מחזיר ברקוד אמיתי (P_xxx) ולא store_code פנימי
                // לכן מחפשים לפי barcode ישירות בטבלת products
                const barcodesList = [];
                codes.forEach(c => {
                    if (c.startsWith('P_')) {
                        barcodesList.push(c);
                        barcodesList.push(c.substring(2));
                    } else {
                        barcodesList.push(c);
                        barcodesList.push('P_' + c);
                    }
                });
                const queryParams = new URLSearchParams({
                    select: 'barcode,name,store_products(store_name,store_code,price,updated_at),substitutes!substitutes_original_barcode_fkey(substitute_barcode_1,substitute_barcode_2)',
                    barcode: `in.(${barcodesList.join(',')})`
                });
                try {
                    const products = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, { headers }).then(r => r.ok ? r.json() : []);

                    products.forEach(p => {
                        const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
                        const rawKey = xmlKey.replace('P_', '');
                        const itemData = {
                            name: p.name,
                            shufersal_price: null,
                            rami_levy_price: null,
                            rami_levy_code: null,
                            victory_code: null,
                            victory_price: null,
                            machsanei_hashuk_price: null,
                            machsanei_hashuk_code: null,
                            substitutes: p.substitutes ? (Array.isArray(p.substitutes) ? p.substitutes.flatMap(s => [s.substitute_barcode_1, s.substitute_barcode_2]).filter(Boolean) : [p.substitutes.substitute_barcode_1, p.substitutes.substitute_barcode_2].filter(Boolean)) : []
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
                        // שמור לפי שתי הגרסאות של המפתח כדי שהחיפוש יצליח
                        pricesData[xmlKey] = itemData;
                        pricesData[rawKey] = itemData;
                    });
                } catch (err) {
                    console.error("שגיאה בפנייה ל-Supabase (shufersal):", err);
                }
            } else if (activeStore === 'ramiLevy') {
                const dbQueryCodes = [];
                codes.forEach(c => {
                    dbQueryCodes.push(c);
                    if (!c.startsWith('P_')) {
                        dbQueryCodes.push('P_' + c);
                    } else {
                        dbQueryCodes.push(c.substring(2));
                    }
                });
                const queryParams = new URLSearchParams({
                    select: 'store_code,products(barcode,name,store_products(store_name,store_code,price,updated_at),substitutes!substitutes_original_barcode_fkey(substitute_barcode_1,substitute_barcode_2))',
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
                        const itemData = {
                            name: p.name,
                            shufersal_price: null,
                            rami_levy_price: null,
                            rami_levy_code: null,
                            victory_code: null,
                            victory_price: null,
                            machsanei_hashuk_price: null,
                            machsanei_hashuk_code: null,
                            substitutes: p.substitutes ? (Array.isArray(p.substitutes) ? p.substitutes.flatMap(s => [s.substitute_barcode_1, s.substitute_barcode_2]).filter(Boolean) : [p.substitutes.substitute_barcode_1, p.substitutes.substitute_barcode_2].filter(Boolean)) : []
                        };
                        if (p.store_products) {
                            p.store_products.forEach(innerSp => {
                                itemData[`${innerSp.store_name}_price`] = innerSp.price != null ? parseFloat(innerSp.price) : null;
                                itemData[`${innerSp.store_name}_code`] = innerSp.store_code;
                                itemData[`${innerSp.store_name}_updated_at`] = innerSp.updated_at || null;
                                if (innerSp.store_name === 'victory') {
                                    itemData.victory_retailer_id = innerSp.store_code;
                                }
                            });
                        }
                        pricesData[xmlKey] = itemData;
                        pricesData[xmlKey.replace('P_', '')] = itemData;
                    });
                } catch (err) {
                    console.error("שגיאה בפנייה ל-Supabase (ramiLevy):", err);
                }
            } else if (activeStore === 'victory' || activeStore === 'machsaneiHashuk') {
                const barcodesList = codes.map(c => c.startsWith('P_') ? c : `P_${c}`);
                const queryParams = new URLSearchParams({
                    select: 'barcode,name,store_products(store_name,store_code,price,updated_at),substitutes!substitutes_original_barcode_fkey(substitute_barcode_1,substitute_barcode_2)',
                    barcode: `in.(${barcodesList.join(',')})`
                });
                try {
                    const products = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, { headers }).then(r => r.ok ? r.json() : []);

                    products.forEach(p => {
                        const xmlKey = p.barcode.startsWith('P_') ? p.barcode : `P_${p.barcode}`;
                        const itemData = {
                            name: p.name,
                            shufersal_price: null,
                            rami_levy_price: null,
                            rami_levy_code: null,
                            victory_code: null,
                            victory_price: null,
                            substitutes: p.substitutes ? (Array.isArray(p.substitutes) ? p.substitutes.flatMap(s => [s.substitute_barcode_1, s.substitute_barcode_2]).filter(Boolean) : [p.substitutes.substitute_barcode_1, p.substitutes.substitute_barcode_2].filter(Boolean)) : []
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
                        pricesData[xmlKey] = itemData;
                    });
                } catch (err) {
                    console.error("שגיאה בפנייה ל-Supabase:", err);
                }
            }
        }

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
                dbItem = pricesData[shufersalCode] || pricesData[xmlKey];
                cleanBarcode = shufersalCode.replace('P_', '');
                if (!dbItem) {
                    const matchingKey = Object.keys(pricesData).find(k => k.endsWith(cleanBarcode));
                    if (matchingKey) dbItem = pricesData[matchingKey];
                }
            }

            if (dbItem) {
                let s_total = activeStore === 'shufersal' ? item.shufersal_total : (dbItem.shufersal_price || 0) * item.quantity;
                let rl_live_total = activeStore === 'ramiLevy' ? item.rami_levy_total : null;
                let v_live_total = activeStore === 'victory' ? item.victory_total : null;
                let mck_live_total = activeStore === 'machsaneiHashuk' ? item.mck_total : null;

                matchedItems.push({
                    name: item.name,
                    quantity: item.quantity,
                    shufersal_code: shufersalCode,
                    shufersal_total: s_total,
                    shufersal_price_unit: dbItem.shufersal_price != null ? dbItem.shufersal_price : null,
                    backup_target_code: dbItem.rami_levy_code ? String(dbItem.rami_levy_code) : null,
                    rami_levy_price_unit: dbItem.rami_levy_price != null ? dbItem.rami_levy_price : null,
                    victory_code: dbItem.victory_code || null,
                    victory_retailer_id: dbItem.victory_retailer_id || null,
                    victory_price_unit: dbItem.victory_price != null ? dbItem.victory_price : null,
                    mck_price_unit: dbItem.machsanei_hashuk_price != null ? dbItem.machsanei_hashuk_price : null,
                    mck_updated_at: dbItem.machsanei_hashuk_updated_at || null,
                    rl_live_total: rl_live_total,
                    v_live_total: v_live_total,
                    mck_live_total: mck_live_total,
                    substitutes: dbItem.substitutes || []
                });

                if (activeStore !== 'shufersal') {
                    itemsForShufersal.push({
                        barcode: cleanBarcode,
                        name: item.name,
                        quantity: item.quantity
                    });
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
                                    name: `[תחליף] ${subItem.name}`,
                                    quantity: item.quantity,
                                    retailerProductId: null
                                });
                            }
                        });
                    }
                }
            } else {
                missingItems.push(item);
            }
        });

        // We do not return early even if matchedItems.length === 0, so that active store's scanned cart total is still rendered

        // 3.8-5.5. Ask the other chains at the same time, one hidden tab each (one after the other took about half a minute)
        let shufersalResults = [], shufersalDebug = null, ramiLevyResults = [];
        let victoryResults = [], agentDebug = null, mckResults = [], mckDebug = null;
        const jobs = [];
        let jobsDone = 0;
        const ask = run => jobs.push(run().catch(e => console.warn('price check failed', e)).then(() => {
            statusDiv.textContent = `נבדקו ${++jobsDone} מתוך ${jobs.length} רשתות...`;
        }));
        const us = settings.userSettings || {};

        if (activeStore !== 'shufersal' && compareShufersal && itemsForShufersal.length > 0) ask(async () => {
            const r = await fetchInHiddenWindow('https://www.shufersal.co.il/online/he/', agentShufersalAgent, [itemsForShufersal]);
            if (r?.results) { shufersalResults = r.results; shufersalDebug = r.debug || null; }
            if (r?.debug?.deliveryFee != null) delivery.shufersal = { fee: r.debug.deliveryFee };
            slotDays.shufersal = deliveryFromDays(r?.debug?.slotFees);
        });
        if (activeStore !== 'ramiLevy' && compareRamiLevy && itemsForRamiLevy.length > 0) ask(async () => {
            const r = await fetchInHiddenWindow('https://www.rami-levy.co.il/he', agentInsideCartEngine, [itemsForRamiLevy, us.ramiLevy?.branchId || null]);
            ramiLevyResults = r?.results || [];
            if (r?.delivery != null) delivery.ramiLevy = { fee: r.delivery };
        });
        // Victory prices every delivery slot for a city, so a free-delivery day shows up here
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
        // Rami Levy prices its slots only for a full address: the same two requests its own delivery dialog sends
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
            const r = await fetchInHiddenWindow('https://www.victoryonline.co.il', agentVictoryAgent, [itemsForVictory, (us.victory?.platform === 2 && us.victory.branchId) || null]);
            if (r?.results) {
                // the search answer carries the unit price and the sale names ("2 ב-₪110"); the shopper pays the sale total
                victoryResults = r.results.map(x => x.outOfStock ? x : { ...x, finalTotal: victorySaleTotal(x.unitPrice, Number(x.quantity) || 1, x.sales) });
                agentDebug = r.debug || null;
            }
        });
        if (activeStore !== 'machsaneiHashuk' && compareMCK && itemsForMCK.length > 0) ask(async () => {
            const r = await fetchInHiddenWindow('https://www.mck.co.il', agentMCKAgent, [itemsForMCK, us.machsaneiHashuk?.branchId || null]);
            if (r?.results) { mckResults = r.results; mckDebug = r.debug || null; }
        });
        if (jobs.length) statusDiv.textContent = 'בודק מחירים ודמי משלוח ברשתות במקביל...';
        await Promise.all(jobs);
        // where a chain priced its delivery days, that is the fee; a later cheaper or free day becomes a note
        Object.entries(slotDays).forEach(([key, d]) => {
            if (!d) return;
            const day = d.cheaper && new Date(d.cheaper.date).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
            delivery[key] = { ...delivery[key], fee: d.fee, note: !d.cheaper ? '' : (d.cheaper.fee === 0 ? `משלוח חינם ב${day}` : `משלוח ב-₪${d.cheaper.fee} ב${day}`) };
        });

        // 6. Classify matched items
        const inStockItems = [];
        const outOfStockItems = [];

        for (const item of matchedItems) {
            const barcode = item.shufersal_code.replace('P_', '');
            
            // Shufersal
            let chosenShufersalBarcode = barcode;
            let shufersalTotal = null;
            let shufersalSource = 'database';
            let shufersalSubName = null;
            if (activeStore === 'shufersal') {
                shufersalTotal = item.shufersal_total;
                shufersalSource = 'live';
            } else if (compareShufersal) {
                let shufersalLive = shufersalResults.find(r => r.barcode === barcode);
                if (shufersalLive && !shufersalLive.outOfStock) {
                    shufersalTotal = shufersalLive.finalTotal;
                    shufersalSource = 'live';
                } else {
                    let foundSub = false;
                    if (item.substitutes && item.substitutes.length > 0) {
                        for (const subBarcode of item.substitutes) {
                            const cleanSub = subBarcode.replace('P_', '');
                            const subLive = shufersalResults.find(r => r.barcode === cleanSub);
                            if (subLive && !subLive.outOfStock) {
                                shufersalTotal = subLive.finalTotal;
                                shufersalSource = 'live-substitute';
                                chosenShufersalBarcode = cleanSub;
                                foundSub = true;
                                const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                                if (subItem) {
                                    shufersalSubName = subItem.name;
                                }
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
                let ramiLive = ramiLevyResults.find(r => r.id === item.backup_target_code);
                if (ramiLive && !ramiLive.outOfStock) {
                    ramiTotal = ramiLive.finalTotal;
                    ramiSource = 'live';
                } else {
                    let foundSub = false;
                    if (item.substitutes && item.substitutes.length > 0) {
                        for (const subBarcode of item.substitutes) {
                            const subItem = pricesData[subBarcode] || pricesData[subBarcode.startsWith('P_') ? subBarcode : `P_${subBarcode}`];
                            if (subItem && subItem.rami_levy_code) {
                                const subLive = ramiLevyResults.find(r => r.id === String(subItem.rami_levy_code));
                                if (subLive && !subLive.outOfStock) {
                                    ramiTotal = subLive.finalTotal;
                                    ramiSource = 'live-substitute';
                                    chosenRamiCode = String(subItem.rami_levy_code);
                                    foundSub = true;
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
            // DB victory codes are old Stor.ai ids: only a live match gives a usable new-platform id
            let chosenVictoryCode = null;
            let victoryTotal = null;
            let victorySource = 'database';
            let victorySubName = null;
            if (activeStore === 'victory') {
                victoryTotal = item.v_live_total;
                victorySource = 'live';
            } else if (compareVictory) {
                let victoryLive = victoryResults.find(r => r.barcode === barcode);
                if (victoryLive && !victoryLive.outOfStock) {
                    victoryTotal = victoryLive.finalTotal;
                    victorySource = 'live';
                    chosenVictoryCode = victoryLive.retailerProductId || null;
                } else {
                    let foundSub = false;
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
                                    foundSub = true;
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
                mckLive = mckResults.find(r => r.barcode === barcode);
                if (mckLive && !mckLive.outOfStock) {
                    mckTotal = mckLive.finalTotal;
                    mckSource = 'live';
                    chosenMCKCode = mckLive.retailerProductId || null; // without it the "build cart" button sends an empty cart
                } else {
                    let foundSub = false;
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
                                    foundSub = true;
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

        renderUI();

        // ===== RENDER FUNCTION =====
        function renderUI() {
            console.log("=== renderUI: Debug Cart Details ===");
            console.log("delivery:", JSON.stringify(delivery), "per day:", JSON.stringify(slotDays));
            console.log("chain answers:", JSON.stringify({ victory: agentDebug, mck: mckDebug, shufersal: shufersalResults.length, ramiLevy: ramiLevyResults.length }));
            console.log("inStockItems:", JSON.parse(JSON.stringify(inStockItems)));
            console.log("missingItems:", JSON.parse(JSON.stringify(missingItems)));

            // Analyze price sources
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

            // gap per store: what the active store charges for the products that store has no price for
            const gap = { shufersal: 0, ramiLevy: 0, victory: 0, machsaneiHashuk: 0 };
            const activeField = { shufersal: 'shufersal_total', ramiLevy: 'rami_levy_total', victory: 'victory_total', machsaneiHashuk: 'mck_total' }[activeStore];

            const processItemForTotals = (item) => {
                const activeTotal = item[activeField] || 0;
                // Shufersal
                if (activeStore === 'shufersal') {
                    totalShufersal += item.shufersal_total || 0;
                    shufersalCount++;
                } else if (compareShufersal) {
                    if (item.shufersal_total !== null && item.shufersal_total !== undefined && item.shufersal_total > 0) {
                        totalShufersal += item.shufersal_total;
                        shufersalCount++;
                    } else gap.shufersal += activeTotal;
                }

                // Rami Levy
                if (activeStore === 'ramiLevy') {
                    totalRamiLevy += item.rami_levy_total || 0;
                    ramiCount++;
                } else if (compareRamiLevy) {
                    if (item.rami_levy_total !== null && item.rami_levy_total !== undefined && item.rami_levy_total > 0) {
                        totalRamiLevy += item.rami_levy_total;
                        ramiCount++;
                    } else gap.ramiLevy += activeTotal;
                }

                // Victory
                if (activeStore === 'victory') {
                    totalVictory += item.victory_total || 0;
                    victoryCount++;
                } else if (compareVictory) {
                    if (item.victory_total !== null && item.victory_total !== undefined && item.victory_total > 0) {
                        totalVictory += item.victory_total;
                        victoryCount++;
                    } else gap.victory += activeTotal;
                }

                // Machsanei HaShuk
                if (activeStore === 'machsaneiHashuk') {
                    totalMCK += item.mck_total || 0;
                    mckCount++;
                } else if (compareMCK) {
                    if (item.mck_total !== null && item.mck_total !== undefined && item.mck_total > 0) {
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
            const mckBranchName = settings.userSettings?.machsaneiHashuk?.branchName || '';
            const mckDisplayName = mckBranchName ? `מחסני השוק (${mckBranchName})` : 'מחסני השוק';

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

            let html = renderStoreSummary({ orderedStores, sortable, activeStore, itemCount: rawCartItems.length });

            // Split inStockItems into available (no replacements) and replaced (replacements in at least one store)
            const availableItems = [];
            const replacedItems = [];
            inStockItems.forEach(item => {
                const isReplacedInAny = 
                    ((activeStore === 'shufersal' || compareShufersal) && (item.shufersal_price_source === 'live-substitute')) ||
                    (compareRamiLevy && (item.rami_price_source === 'live-substitute')) ||
                    (compareVictory && (item.victory_price_source === 'live-substitute')) ||
                    (compareMCK && (item.mck_price_source === 'live-substitute'));
                
                if (isReplacedInAny) {
                    replacedItems.push(item);
                } else {
                    availableItems.push(item);
                }
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
                availableItems.forEach(item => {
                    const sText = (activeStore === 'shufersal' || compareShufersal) ? `<span class="p-shufersal">${(item.shufersal_total && item.shufersal_total > 0) ? formatPrice(item.shufersal_total) : '-'}</span>` : '';
                    const rText = (compareRamiLevy) ? `<span class="p-rami">${(item.rami_levy_total && item.rami_levy_total > 0) ? formatPrice(item.rami_levy_total) : '-'}</span>` : '';
                    const vText = (compareVictory) ? `<span class="p-victory">${(item.victory_total && item.victory_total > 0) ? formatPrice(item.victory_total) : '-'}</span>` : '';
                    const mText = (compareMCK) ? `<span class="p-mck">${(item.mck_total && item.mck_total > 0) ? formatPrice(item.mck_total) : '-'}</span>` : '';
                    html += `
                    <div class="product-item">
                        <span class="product-name">${esc(item.name)} x${esc(item.quantity)}</span>
                        <div class="product-prices">
                            ${sText}
                            ${rText}${vText}${mText}
                        </div>
                    </div>`;
                });
                html += '</div>';
            }

            if (replacedItems.length > 0) {
                html += '<div class="section-label">מוצרים שהוחלפו</div><div class="product-list">';
                replacedItems.forEach(item => {
                    const sIsSub = (item.shufersal_price_source === 'live-substitute');
                    const sSubBadge = sIsSub ? '<span title="הוחלף בתחליף" style="font-size: 10px; color: #f59e0b; margin-left: 2px;">תחליף</span>' : '';
                    const sText = (activeStore === 'shufersal' || compareShufersal) ? `<span class="p-shufersal">${(item.shufersal_total && item.shufersal_total > 0) ? formatPrice(item.shufersal_total) + sSubBadge : '-'}</span>` : '';
                    
                    const rIsSub = (item.rami_price_source === 'live-substitute');
                    const rSubBadge = rIsSub ? '<span title="הוחלף בתחליף" style="font-size: 10px; color: #f59e0b; margin-left: 2px;">תחליף</span>' : '';
                    const rText = (compareRamiLevy) ? `<span class="p-rami">${(item.rami_levy_total && item.rami_levy_total > 0) ? formatPrice(item.rami_levy_total) + rSubBadge : '-'}</span>` : '';
                    
                    const vIsSub = (item.victory_price_source === 'live-substitute');
                    const vSubBadge = vIsSub ? '<span title="הוחלף בתחליף" style="font-size: 10px; color: #f59e0b; margin-left: 2px;">תחליף</span>' : '';
                    const vText = (compareVictory) ? `<span class="p-victory">${(item.victory_total && item.victory_total > 0) ? formatPrice(item.victory_total) + vSubBadge : '-'}</span>` : '';
                    
                    const mIsSub = (item.mck_price_source === 'live-substitute');
                    const mSubBadge = mIsSub ? '<span title="הוחלף בתחליף" style="font-size: 10px; color: #f59e0b; margin-left: 2px;">תחליף</span>' : '';
                    const mText = (compareMCK) ? `<span class="p-mck">${(item.mck_total && item.mck_total > 0) ? formatPrice(item.mck_total) + mSubBadge : '-'}</span>` : '';
                    
                    const replacementsDetail = [];
                    if (sIsSub && item.shufersal_sub_name) {
                        replacementsDetail.push(`שופרסל: הוחלף ב-${esc(item.shufersal_sub_name)}`);
                    }
                    if (rIsSub && item.rami_sub_name) {
                        replacementsDetail.push(`רמי לוי: הוחלף ב-${esc(item.rami_sub_name)}`);
                    }
                    if (vIsSub && item.victory_sub_name) {
                        replacementsDetail.push(`ויקטורי: הוחלף ב-${esc(item.victory_sub_name)}`);
                    }
                    if (mIsSub && item.mck_sub_name) {
                        replacementsDetail.push(`מחסני השוק: הוחלף ב-${esc(item.mck_sub_name)}`);
                    }
                    
                    const detailHtml = replacementsDetail.length > 0 
                        ? `<div class="product-sub-info" style="font-size: 11px; color: #f59e0b; padding-top: 4px; line-height: 1.4;">${replacementsDetail.join(' | ')}</div>` 
                        : '';

                    html += `
                    <div class="product-item" style="flex-direction: column; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid #f3f4f6;">
                        <div style="display: flex; justify-content: space-between; width: 100%;">
                            <span class="product-name" style="font-weight: 500;">${esc(item.name)} x${esc(item.quantity)}</span>
                            <div class="product-prices">
                                ${sText}
                                ${rText}${vText}${mText}
                            </div>
                        </div>
                        ${detailHtml}
                    </div>`;
                });
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
            resultDiv.innerHTML = html;
            document.getElementById('startView').hidden = true;
            statusDiv.innerHTML = 'סיימנו';

            const activeEntry = sortable.find(st => st.key === activeStore);
            logEvent({
                type: 'comparison',
                active_store: activeStore,
                cheapest_store: cheapest ? cheapest.key : activeStore,
                cart_size: rawCartItems.length,
                matched_count: matchedItems.length,
                saving: cheapest && activeEntry ? Math.max(0, Number((rvCompareTotal(activeEntry) - rvCompareTotal(cheapest)).toFixed(2))) : 0,
                totals: Object.fromEntries(sortable.map(st => [st.key, Number(st.total.toFixed(2))])),
                // product names only feed "most compared products" counters; they are never stored as one cart
                products: matchedItems.map(i => ({ barcode: i.shufersal_code.replace('P_', ''), name: i.name }))
            });

            finalCartToTransfer = inStockItems;

            document.getElementById('compareAgain')?.addEventListener('click', compareCarts);
            document.getElementById('detailsToggle')?.addEventListener('click', () => {
                document.getElementById('detailsContent').classList.toggle('open');
                document.getElementById('toggleArrow').classList.toggle('open');
            });



            const allSources = [...inStockItems, ...outOfStockItems, ...missingItems];
            Object.entries(RV_SWITCH).forEach(([storeKey, sw]) => {
                document.getElementById(sw.id)?.addEventListener('click', () => { logEvent({ type: 'switch', store: storeKey }); sendCartTo(storeKey, allSources); });
            });
            saveCartToHistory(activeStore, allSources, Object.fromEntries(sortable.map(st => [st.key, Number(rvShownTotal(st).toFixed(2))])));

            compareBtn.disabled = false;
        }

    } catch(error) {
        document.getElementById('result').innerHTML = `<p style="color:#dc2626; text-align:center; padding:16px;">!שגיאה:<br>${esc(error.message)}</p>`;
        document.getElementById('status').innerHTML = '';
        compareBtn.disabled = false;
        console.error(error);
    } finally {
        stopSphere();
        loading.hidden = true;
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

async function saveCartToHistory(store, items, totals) {
    const slim = items.map(i => Object.fromEntries(HISTORY_FIELDS.filter(f => i[f] != null).map(f => [f, i[f]])));
    const { cartHistory = [] } = await chrome.storage.local.get('cartHistory');
    await chrome.storage.local.set({ cartHistory: addToHistory(cartHistory, { at: Date.now(), store, totals, items: slim }) });
}

async function showHistory() {
    const { cartHistory = [] } = await chrome.storage.local.get('cartHistory');
    const resultDiv = document.getElementById('result');
    resultDiv.innerHTML = renderHistory(cartHistory);
    document.getElementById('startView').hidden = true;
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
    initWindowMode();
    initSettings();
    const btn = document.getElementById('compareBtn');
    if (btn) {
        btn.addEventListener('click', compareCarts);
    }
});