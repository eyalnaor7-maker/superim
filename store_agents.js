// Store price-checking agents executed in hidden tabs via chrome.scripting.executeScript({ func }).
// Every agent MUST remain completely self-contained with zero external closure dependencies.

// ===== RAMI LEVY AGENT =====
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
    } catch (e) {}

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
            const deliveryLine = (data?.items || []).find(ci => ci.is_delivery);
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
    } catch (e) {
        console.error('Cart API failed', e);
    }

    return { delivery: null, results: itemsList.map(item => ({
        id: item.id,
        finalTotal: 0,
        quantity: item.quantity,
        outOfStock: true
    })) };
}

// ===== SHUFERSAL AGENT =====
async function agentShufersalAgent(items) {
    const results = [];
    const debug = {};
    const BATCH = 4;

    async function fetchOne(item) {
        const barcode = item.barcode || '';
        const resultKey = barcode || item.key || item.searchQuery || '';
        const queryText = barcode || item.searchQuery || item.name || '';
        if (!queryText) return { barcode: resultKey, outOfStock: true };

        const q = barcode ? (barcode.startsWith('P_') ? barcode : `P_${barcode}`) : '';
        try {
            const response = await fetch(`/online/he/search?text=${encodeURIComponent(queryText)}`);
            if (!response.ok) return { barcode: resultKey, outOfStock: true };

            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');

            let card = null;
            if (barcode) {
                // Only the result card of this exact barcode counts for barcoded products.
                card = doc.querySelector(`li[data-product-code="${q}"]`) || doc.querySelector(`li[data-product-code="${barcode}"]`);
            } else if (item.searchQuery) {
                // Weighed staple without a barcode: pick the first matching search result card.
                const cards = Array.from(doc.querySelectorAll('li[data-product-code]'));
                const needle = String(item.searchQuery).trim();
                card = cards.find(c => (c.innerText || '').includes(needle)) || cards[0] || null;
            }

            const priceElem = card && (card.querySelector('.miglog-prod-totalPrize') ||
                                       card.querySelector('.miglog-prod-totalPrice') ||
                                       card.querySelector('.price') ||
                                       card.querySelector('.total-price') ||
                                       card.querySelector('.price-number'));
            if (priceElem) {
                let price = parseFloat(priceElem.innerText.replace(/[^\d.]/g, '')) || 0;
                const discountElem = card.querySelector('.miglog-prod-totalDiscount') || card.querySelector('.discount');
                if (discountElem) price -= parseFloat(discountElem.innerText.replace(/[^\d.]/g, '')) || 0;
                return { barcode: resultKey, price, finalTotal: price * item.quantity, outOfStock: price <= 0 };
            }
            return { barcode: resultKey, outOfStock: true };
        } catch (e) {
            console.error('[Shufersal Agent] Error fetching ' + queryText, e);
            return { barcode: resultKey, outOfStock: true };
        }
    }

    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        const batchResults = await Promise.all(batch.map(fetchOne));
        results.push(...batchResults);
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

// ===== VICTORY AGENT =====
async function agentVictoryAgent(items, settingsBranchId) {
    const branchId = String(settingsBranchId || '55');
    const ALGOLIA_URL = 'https://QF3L7C47QU-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=0abb07df3782882c383198f99009782d&x-algolia-application-id=QF3L7C47QU';
    const norm = v => String(v == null ? '' : v).replace(/^P_/, '').replace(/\D/g, '').replace(/^0+/, '');
    const results = [];
    const notFound = [];
    const debug = { branchId, foundCount: 0, totalItems: items.length, notFound };

    const queryable = items.filter(i => norm(i.barcode) || i.searchQuery);
    items.filter(i => !norm(i.barcode) && !i.searchQuery).forEach(i => notFound.push(i.barcode || i.name || ''));

    for (let start = 0; start < queryable.length; start += 20) {
        const batch = queryable.slice(start, start + 20);
        let data = null;
        try {
            const resp = await fetch(ALGOLIA_URL, {
                method: 'POST',
                body: JSON.stringify({ requests: batch.map(i => ({
                    indexName: 'products',
                    query: norm(i.barcode) || String(i.searchQuery),
                    hitsPerPage: 6,
                    page: 0,
                    facetFilters: [[`inStockBranches:${branchId}`]],
                    relevancyStrictness: 0
                })) })
            });
            if (resp.status === 429) { debug.blocked = true; debug.reason = 'HTTP 429'; break; }
            if (!resp.ok) { debug.reason = 'HTTP ' + resp.status; batch.forEach(i => notFound.push(i.barcode || i.key || i.name)); continue; }
            data = await resp.json();
        } catch (e) {
            debug.reason = 'network error';
            batch.forEach(i => notFound.push(i.barcode || i.key || i.name));
            continue;
        }
        if (data && data.captchaAction) { debug.blocked = true; debug.reason = 'captchaAction'; break; }

        batch.forEach((item, idx) => {
            const hits = data?.results?.[idx]?.hits || [];
            const want = norm(item.barcode);
            let hit = null;
            if (want) {
                hit = hits.find(h => h && norm(h.sku) === want);
            } else if (item.searchQuery) {
                const needle = String(item.searchQuery).trim();
                hit = hits.find(h => h && h.isWeight && String(h.name || '').includes(needle))
                   || hits.find(h => h && String(h.name || '').includes(needle))
                   || hits[0] || null;
            }
            const resultKey = item.barcode || item.key || item.searchQuery;
            if (!hit) { notFound.push(resultKey); return; }
            const price = parseFloat(hit.price) || 0;
            const outOfStock = hit.inStock === false || price <= 0;
            const qty = Number(item.quantity) || 1;
            debug.foundCount++;
            results.push({
                barcode: resultKey,
                finalTotal: outOfStock ? 0 : price * qty,
                quantity: item.quantity,
                outOfStock,
                unitPrice: price,
                sales: hit.sales || [],
                retailerProductId: String(hit.id),
                name: hit.name,
                isWeight: !!hit.isWeight
            });
        });
    }

    return { results, debug };
}

// ===== MACHSANEI HASHUK AGENT =====
// Read-only catalog price checker: NEVER creates, POSTs, or PATCHes /carts so a signed-in shopper's cart is never modified.
async function agentMCKAgent(items, settingsBranchId) {
    const MCK_RETAILER_ID = 1107;
    const MCK_APP_ID = 4;
    const BATCH = 4;

    const MCK_SEARCH_FILTERS = encodeURIComponent(JSON.stringify({
        'must': {
            'exists': ['family.id', 'family.categoriesPaths.id', 'branch.regularPrice'],
            'term': { 'branch.isActive': true, 'branch.isVisible': true }
        },
        'mustNot': { 'term': { 'branch.regularPrice': 0, 'branch.isOutOfStock': true } }
    }));

    let token = '';
    let branchId = null;
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
        } catch (e) {}
    }

    let authBlocked = false;
    const baseHeaders = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=UTF-8'
    };
    if (token) baseHeaders['Authorization'] = token.includes('Bearer') ? token : 'Bearer ' + token;

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
            } catch (e) {}
        }
    }

    if (!branchId && settingsBranchId) branchId = Number(settingsBranchId);

    const results = [];
    let foundCount = 0;

    function normBc(v) {
        return String(v == null ? '' : v).replace(/^P_/, '').replace(/^0+/, '');
    }

    function calcSpecialTotal(match, basePrice, qty) {
        let finalTotal = basePrice * qty;
        const specials = match.branch?.specials || [];
        if (specials.length > 0 && basePrice > 0) {
            for (const special of specials) {
                const reqQty = special.firstLevel?.firstPurchaseTotal;
                const promoPrice = special.firstLevel?.firstGift?.total ?? special.firstLevel?.total;
                if (reqQty && promoPrice && qty >= reqQty) {
                    const promoCount = Math.floor(qty / reqQty);
                    const remainder = qty % reqQty;
                    const calculatedPromoTotal = (promoCount * promoPrice) + (remainder * basePrice);
                    if (calculatedPromoTotal < finalTotal) {
                        finalTotal = calculatedPromoTotal;
                    }
                }
            }
        }
        return finalTotal;
    }

    async function lookupItem(item) {
        if (authBlocked) return null;
        const searchBase = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/products/autocomplete`;
        const queries = item.barcode ? [item.barcode, item.name] : [item.searchQuery || item.name];
        const resultKey = item.barcode || item.key || item.searchQuery;

        for (const q of queries.filter(Boolean)) {
            if (authBlocked) break;
            try {
                const userParam = userId != null ? `&userId=${userId}` : '';
                const url = `${searchBase}?appId=${MCK_APP_ID}&filters=${MCK_SEARCH_FILTERS}&query=${encodeURIComponent(q)}&from=0&size=10&isSearch=true&languageId=1${userParam}`;
                const resp = await fetch(url, { headers: baseHeaders, credentials: 'include' });
                if ([401, 403, 429].includes(resp.status) || !(resp.headers.get('content-type') || '').includes('json')) {
                    authBlocked = true;
                    break;
                }
                if (!resp.ok) continue;
                const data = await resp.json();
                const products = data?.suggestions?.suggestProducts?.products || [];

                let match = null;
                if (item.barcode) {
                    const want = normBc(item.barcode);
                    match = products.find(p =>
                        normBc(p.barcode) === want || normBc(p.localBarcode) === want
                    );
                } else if (item.searchQuery) {
                    const needle = String(item.searchQuery).trim();
                    match = products.find(p => p && p.branch?.isOutOfStock !== true && String(p.name || '').includes(needle))
                         || products.find(p => p && p.branch?.isOutOfStock !== true)
                         || null;
                }

                if (match?.id) {
                    const outOfStock = match.branch?.isOutOfStock === true;
                    const rid = Number(match.id);
                    const basePrice = parseFloat(match.branch?.salePrice ?? match.branch?.regularPrice ?? match.branch?.price ?? 0);
                    const qty = Number(item.quantity) || 1;
                    const finalTotal = calcSpecialTotal(match, basePrice, qty);
                    foundCount++;

                    if (basePrice > 0 && !outOfStock) {
                        return {
                            barcode: resultKey,
                            finalTotal,
                            unitPrice: basePrice,
                            quantity: item.quantity,
                            outOfStock: false,
                            retailerProductId: rid
                        };
                    }
                    return {
                        barcode: resultKey,
                        finalTotal: 0,
                        quantity: item.quantity,
                        outOfStock: true,
                        retailerProductId: rid
                    };
                }
            } catch (e) {}
        }
        return null;
    }

    if (branchId) {
        for (let i = 0; i < items.length; i += BATCH) {
            if (authBlocked) break;
            const batch = items.slice(i, i + BATCH);
            const batchRes = await Promise.all(batch.map(lookupItem));
            batchRes.forEach(r => { if (r) results.push(r); });
        }
    }

    if (authBlocked && results.length === 0) return { results: [], debug: { needsLogin: true, branchId } };
    return { results, debug: { token: !!token, branchId, userId, foundCount, totalItems: items.length, needsLogin: !token && !branchId } };
}

if (typeof module !== 'undefined') {
    module.exports = { agentInsideCartEngine, agentShufersalAgent, agentVictoryAgent, agentMCKAgent };
}
