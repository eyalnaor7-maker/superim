// ===== MACHSANEI HASHUK INJECTOR =====
// Content script that runs on mck.co.il pages.

const MCK_RETAILER_ID = 1107;
const MCK_APP_ID = 4;

window.addEventListener('load', function () {
    chrome.storage.local.get(['savedCartMCK'], function (result) {
        if (result.savedCartMCK && result.savedCartMCK.length > 0) {
            chrome.storage.local.remove(['savedCartMCK']);
            transferCartToMCK(result.savedCartMCK);
        }
    });
});

async function transferCartToMCK(cartItems) {
    createMCKStatusWindow();
    updateMCKStatus('🔍 מתחבר למערכת של מחסני השוק...');

    let token = '';
    let branchId = null;

    // חיפוש token ו-branchId ב-localStorage (אותו מבנה כמו ויקטורי - פלטפורמת Stor.ai)
    for (const key of Object.keys(localStorage)) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw || raw.length < 4) continue;

            // Token ישיר כ-hex string
            if (/^[0-9a-f]{60,}$/.test(raw.trim())) {
                token = raw.trim();
                continue;
            }

            const p = JSON.parse(raw);
            if (typeof p !== 'object' || !p) continue;

            // חיפוש token
            const t = p?.token || p?.authToken || p?.access_token || p?.user?.token
                    || p?.accessToken || p?.auth?.token || p?.session?.token;
            if (t && typeof t === 'string' && t.length > 40) token = t;

            // חיפוש branchId
            const bid = p?.branchId || p?.branch?.id || p?.selectedBranch?.id
                      || p?.currentBranch?.id || p?.store?.branchId;
            if (bid && !branchId) branchId = Number(bid);

        } catch (e) {}
    }

    if (!token) {
        updateMCKStatus('❌ שגיאה: לא הצלחתי למצוא משתמש מחובר. אנא התחבר לאתר מחסני השוק.');
        return;
    }

    if (!branchId) {
        // ניסיון לגלות branchId דרך API
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=UTF-8',
            'Authorization': 'Bearer ' + token
        };
        try {
            const r = await fetch(`/v2/retailers/${MCK_RETAILER_ID}/users/me?appId=${MCK_APP_ID}`, {
                headers, credentials: 'include'
            });
            if (r.ok) {
                const d = await r.json();
                branchId = d?.branchId || d?.selectedBranchId || d?.branch?.id || d?.user?.branchId;
            }
        } catch(e) {}
    }

    if (!branchId) {
        updateMCKStatus('❌ שגיאה: לא הצלחתי למצוא סניף. אנא בחר סניף באתר מחסני השוק.');
        return;
    }

    const headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "Authorization": 'Bearer ' + token
    };

    updateMCKStatus('🚀 מכין את המוצרים להעברה...');

    const linesPayload = [];
    let successCount = 0;

    for (const item of cartItems) {
        const internalCode = item.mck_code || item.retailerProductId;

        if (internalCode) {
            linesPayload.push({
                quantity: item.amount || item.quantity || 1,
                soldBy: null,
                isCase: false,
                retailerProductId: parseInt(internalCode),
                type: 1
            });
            successCount++;
        }
    }

    if (linesPayload.length === 0) {
        updateMCKStatus('❌ אין מוצרים להעברה (חסרים קודים פנימיים).');
        return;
    }

    const payload = {
        lines: linesPayload,
        deliveryType: 1
    };

    updateMCKStatus('🛒 משגר את העגלה למחסני השוק...');
    const addUrl = `/v2/retailers/${MCK_RETAILER_ID}/branches/${branchId}/carts?appId=${MCK_APP_ID}`;

    try {
        const addResponse = await fetch(addUrl, {
            method: 'POST',
            headers: headers,
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (addResponse.ok || addResponse.status === 201) {
            updateMCKStatus(`🎉 מדהים! ${successCount} מוצרים הועברו לעגלה שלך! מרענן...`);
            setTimeout(() => window.location.reload(), 2000);
        } else {
            updateMCKStatus(`❌ השרת סירב לבקשה (שגיאה ${addResponse.status})`);
            const errorText = await addResponse.text();
            console.error("פירוט שגיאה מהשרת:", errorText);
        }

    } catch (error) {
        console.error("שגיאת רשת:", error);
        updateMCKStatus('❌ חלה שגיאת תקשורת מול שרתי מחסני השוק.');
    }
}

// ===== פונקציות ממשק =====
function createMCKStatusWindow() {
    const existing = document.getElementById('mck-compare-status');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'mck-compare-status';
    container.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 320px;
        background: white; border: 3px solid #e65100; border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 999999;
        padding: 20px; direction: rtl; font-family: Arial, sans-serif; text-align: center;
    `;
    container.innerHTML = `
        <h3 style="margin:0 0 10px 0; color:#e65100;">🛒 פרויקט סופרים - מחסני השוק</h3>
        <p id="mck-status-text" style="margin:0; font-size:16px; font-weight:bold;">מתחיל...</p>
    `;
    document.body.appendChild(container);
}

function updateMCKStatus(text) {
    const el = document.getElementById('mck-status-text');
    if (el) el.innerText = text;
}
