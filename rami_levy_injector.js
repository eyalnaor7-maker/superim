window.addEventListener('load', function() {
    chrome.storage.local.get(['savedCart'], function(result) {
        if (result.savedCart && result.savedCart.length > 0) {
            transferCartInstantly(result.savedCart);
            chrome.storage.local.remove(['savedCart']);
        }
    });
});

async function transferCartInstantly(cartItems) {
    createStatusWindow();
    updateStatus("🚀 מכין את חבילת הנתונים לעגלה...");

    let secretToken = "";
    let storeId = "1";
    let userId = 0;

    let ramiLevyStorage = localStorage.getItem('ramilevy') || sessionStorage.getItem('ramilevy');
    if (ramiLevyStorage) {
        try {
            let parsedData = JSON.parse(ramiLevyStorage);
            let userObj = parsedData.authuser.user;

            secretToken = userObj.token;
            storeId = String(userObj.store_id || 1);
            userId = userObj.id || 0;
        } catch (error) {
            console.error("Failed to parse user data:", error);
        }
    }

    if (!secretToken) {
        await transferGuestCart(cartItems, ramiLevyStorage);
        return;
    }

    let requestHeaders = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "locale": "he"
    };

    if (secretToken) {
        requestHeaders["ecomtoken"] = secretToken;
        requestHeaders["authorization"] = "Bearer " + secretToken;
    }

    // Fetch current cart items to delete anything not in our savedCart
    let currentCartIds = new Set();
    try {
        console.log("Rami Levy Injector: Fetching current cart via GET...");
        const getCartResponse = await fetch("https://www.rami-levy.co.il/api/v2/cart", {
            method: "GET",
            headers: {
                "accept": "application/json, text/plain, */*",
                "locale": "he",
                "ecomtoken": secretToken || "",
                "authorization": secretToken ? "Bearer " + secretToken : ""
            },
            credentials: "include"
        });
        console.log("Rami Levy Injector: GET cart response status:", getCartResponse.status);
        if (getCartResponse.ok) {
            const cartData = await getCartResponse.json();
            console.log("Rami Levy Injector: Cart data received:", cartData);
            if (cartData && cartData.items) {
                cartData.items.forEach(ci => {
                    if (ci && ci.id) {
                        currentCartIds.add(String(ci.id));
                    }
                });
            }
        } else {
            console.warn("Rami Levy Injector: GET cart request failed with status", getCartResponse.status);
        }
    } catch (error) {
        console.error("Failed to fetch current cart for deletion:", error);
    }

    let itemsPayload = {};
    const activeCodes = new Set();
    for (let i = 0; i < cartItems.length; i++) {
        let finalId = String(cartItems[i].targetCode);
        let qty = cartItems[i].quantity !== undefined ? cartItems[i].quantity : 1;
        activeCodes.add(finalId);

        // התיקון הקריטי: אם הכמות היא 0 (מחיקה), שולחים מספר 0 ולא "0.00"
        if (qty === 0) {
            itemsPayload[finalId] = 0;
        } else {
            itemsPayload[finalId] = parseFloat(qty).toFixed(2);
        }
    }

    // Delete any items currently in the cart that are not in our savedCart
    currentCartIds.forEach(id => {
        if (!activeCodes.has(id)) {
            itemsPayload[id] = 0;
        }
    });

    console.log("Rami Levy Injector: Desired cart items:", cartItems);
    console.log("Rami Levy Injector: Active codes:", Array.from(activeCodes));
    console.log("Rami Levy Injector: Current cart IDs from server:", Array.from(currentCartIds));
    console.log("Rami Levy Injector: Final items payload to send:", itemsPayload);

    let requestBody = {
        store: Number(storeId),
        isClub: 0,
        supplyAt: new Date().toISOString(),
        items: itemsPayload,
        meta: {
            uid: userId
        }
    };

    updateStatus("⚡ משגר עגלה ומנקה מוצרים חסרים...");

    try {
        const response = await fetch("https://www.rami-levy.co.il/api/v2/cart", {
            method: "POST",
            headers: requestHeaders,
            credentials: "include",
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            updateStatus("🎉 עבר בהצלחה! מרענן את העמוד...");
            setTimeout(() => {
                window.location.reload();
            }, 1500);
        } else {
            updateStatus(`❌ שגיאה ${response.status}. השרת מסרב לקבל.`);
        }

    } catch (error) {
        updateStatus("❌ שגיאת רשת מול השרת.");
        console.error(error);
    }
}

// Guest: the cart is kept only in localStorage["ramilevy"], so write it there.
async function transferGuestCart(cartItems, rawState) {
    try {
        let state = {};
        try { state = JSON.parse(rawState) || {}; } catch (e) { /* no usable state */ }
        const store = String((state.cart && state.cart.storeId) || 331);
        const quantities = {};
        const removeIds = new Set();
        const barcodes = {};
        cartItems.forEach(i => {
            const id = String(i.targetCode);
            const qty = i.quantity !== undefined ? Number(i.quantity) : 1;
            if (qty > 0) quantities[id] = qty; else removeIds.add(id);
            if (i.barcode) barcodes[id] = String(i.barcode).replace(/\D/g, '');
        });

        updateStatus("⚡ מביא פרטי מוצרים מהקטלוג...");
        const products = [];
        let missing = 0;
        for (const id of Object.keys(quantities)) {
            // The site's own search finds a product by barcode; q=<id> is unconfirmed, so it is only the fallback.
            const resp = await fetch("https://www.rami-levy.co.il/api/catalog", {
                method: "POST",
                headers: { "accept": "application/json, text/plain, */*", "content-type": "application/json;charset=UTF-8", "locale": "he" },
                body: JSON.stringify({ q: barcodes[id] || id, store: store, size: 10 })
            });
            if (!resp.ok) { updateStatus(`❌ שגיאה ${resp.status} בקטלוג.`); return; }
            const data = await resp.json();
            const hit = ((data && data.data) || []).find(p => String(p.id) === id || (barcodes[id] && String(p.barcode) === barcodes[id]));
            if (hit) {
                quantities[String(hit.id)] = quantities[id]; // a barcode match may carry a newer id than the saved one
                products.push(hit);
            } else missing++;
        }
        if (missing > 0) {
            updateStatus("⚠️ חלק מהמוצרים לא נמצאו בקטלוג ולא נוספו.");
        }

        state = mergeGuestCart(state, products, quantities);
        state.cart.items = state.cart.items.filter(i => !removeIds.has(String(i.id)));
        localStorage.setItem('ramilevy', JSON.stringify(state));
        updateStatus("🎉 עבר בהצלחה! מרענן את העמוד...");
        setTimeout(() => { window.location.reload(); }, 1500);
    } catch (error) {
        updateStatus("❌ שגיאת רשת מול השרת.");
        console.error(error);
    }
}

function createStatusWindow() {
    const container = document.createElement('div');
    container.id = 'supermarket-status';
    container.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 300px;
        background: white; border: 3px solid #2e7d32; border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 999999;
        padding: 20px; direction: rtl; font-family: Arial, sans-serif; text-align: center;
    `;
    container.innerHTML = `
        <h3 style="margin:0 0 10px 0; color:#2e7d32; font-size:18px;">🛒 פרויקט סופרים</h3>
        <p id="statusMessage" style="font-size: 14px; font-weight: bold; color: #333;">מתחיל פעולה...</p>
    `;
    document.body.appendChild(container);
    return container;
}

function updateStatus(message) {
    const statusEl = document.getElementById('statusMessage');
    if (statusEl) {
        statusEl.innerText = message;
    }
}