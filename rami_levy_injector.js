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

    let ramiLevyStorage = localStorage.getItem('ramilevy');
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

    let requestHeaders = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "locale": "he"
    };

    if (secretToken) {
        requestHeaders["ecomtoken"] = secretToken;
        requestHeaders["authorization"] = "Bearer " + secretToken;
    }

    let itemsPayload = {};
    for (let i = 0; i < cartItems.length; i++) {
        let finalId = cartItems[i].targetCode;
        let qty = cartItems[i].quantity !== undefined ? cartItems[i].quantity : 1;

        // התיקון הקריטי: אם הכמות היא 0 (מחיקה), שולחים מספר 0 ולא "0.00"
        if (qty === 0) {
            itemsPayload[finalId] = 0;
        } else {
            itemsPayload[finalId] = parseFloat(qty).toFixed(2);
        }
    }

    let requestBody = {
        store: storeId,
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