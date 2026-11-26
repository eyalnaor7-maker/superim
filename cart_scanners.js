// Active-store detection and per-chain cart scanners.
// Note: scan* functions are serialized by chrome.scripting.executeScript({ func }) into world: 'MAIN'
// and MUST remain completely self-contained with zero external closure dependencies.

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

function scanRamiLevyCart() {
    try {
        const raw = localStorage.getItem('ramilevy') || sessionStorage.getItem('ramilevy');
        const items = raw ? JSON.parse(raw)?.cart?.items : null;
        return Array.isArray(items) ? items : [];
    } catch (e) {
        console.error('שגיאה בסריקת עגלת רמי לוי מהזיכרון:', e);
        return [];
    }
}

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
                code: m ? m[1] : 'victory-' + line.id, // no barcode in the image path: keep the line so weighed/AI matching can identify it
                name: line.name || 'מוצר',
                quantity: quantity,
                victory_total: total
            });
        });
        return products;
    } catch (e) {
        console.error('Error scanning Victory cart:', e);
        return [];
    }
}

async function scanMCKCart(settingsBranchId) {
    try {
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

            const prodRegPrice = line.product?.branch?.regularPrice != null ? parseFloat(line.product.branch.regularPrice) : null;
            const prodSalePrice = line.product?.branch?.salePrice != null ? parseFloat(line.product.branch.salePrice) : null;
            const prodPrice = line.product?.price != null ? parseFloat(line.product.price) : null;
            const basePrice = prodSalePrice ?? prodRegPrice ?? prodPrice ?? (line.price != null ? parseFloat(line.price) : 0);

            if (minPrice === 0 && basePrice > 0) {
                minPrice = basePrice * qty;
            }

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
            } catch (e) {}
        }

        if (localCartItems) {
            const products = [];
            localCartItems.forEach(line => {
                if (line.type != null && line.type !== 1) return;
                const product = line.product;
                if (!product) return;
                const barcode = extractBarcode(product);
                const code = barcode ? String(barcode) : (product.id ? 'mck-' + product.id : null);
                if (!code) return;

                const name = product.name || 'מוצר';
                if (name.includes('משלוח') || name.toLowerCase().includes('delivery') || name.toLowerCase().includes('shipping')) return;
                const quantity = line.quantity || 1;
                const finalTotal = extractLinePrice(line);

                products.push({
                    code,
                    name,
                    quantity,
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
            } catch (e) {}
        }

        if (!branchId && settingsBranchId) {
            branchId = Number(settingsBranchId);
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
                } catch (e) {}
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
            } catch (e) {}
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
            const code = barcode ? String(barcode) : (product.id ? 'mck-' + product.id : null);
            if (!code) return;

            const name = product.name || 'מוצר';
            if (name.includes('משלוח') || name.toLowerCase().includes('delivery') || name.toLowerCase().includes('shipping')) return;
            const quantity = line.quantity || 1;
            const finalTotal = extractLinePrice(line);

            products.push({
                code,
                name,
                quantity,
                mck_total: finalTotal
            });
        });

        return products;
    } catch (e) {
        console.error('Error scanning MCK cart:', e);
        return [];
    }
}

if (typeof module !== 'undefined') {
    module.exports = { detectActiveStore, scanShufersalCart, scanRamiLevyCart, scanVictoryCart, scanMCKCart };
}
