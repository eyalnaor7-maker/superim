// ===== VICTORY INJECTOR =====
// Content script that runs on victoryonline.co.il pages.

const VICTORY_RETAILER_ID = 1470;
const VICTORY_APP_ID = 4;

window.addEventListener('load', function () {
    chrome.storage.local.get(['savedCartVictory'], function (result) {
        if (result.savedCartVictory && result.savedCartVictory.length > 0) {
            chrome.storage.local.remove(['savedCartVictory']);
            transferCartToVictory(result.savedCartVictory);
        }
    });
});

async function transferCartToVictory(cartItems) {
    createVictoryStatusWindow();
    updateVictoryStatus('🔍 מתחבר למערכת של ויקטורי...');

    let token = '';
    let branchId = null;

    // Search token and branchId in localStorage (same as Machsanei Hashuk - Stor.ai platform)
    for (const key of Object.keys(localStorage)) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw || raw.length < 4) continue;

            // Direct token as hex string
            if (/^[0-9a-f]{60,}$/.test(raw.trim())) {
                token = raw.trim();
                continue;
            }

            const p = JSON.parse(raw);
            if (typeof p !== 'object' || !p) continue;

            // Search token
            const t = p?.token || p?.authToken || p?.access_token || p?.user?.token
                    || p?.accessToken || p?.auth?.token || p?.session?.token;
            if (t && typeof t === 'string' && t.length > 40) token = t;

            // Search branchId
            const bid = p?.branchId || p?.branch?.id || p?.selectedBranch?.id
                      || p?.currentBranch?.id || p?.store?.branchId;
            if (bid && !branchId) branchId = Number(bid);

        } catch (e) {}
    }

    if (!token) {
        updateVictoryStatus('❌ שגיאה: לא הצלחתי למצוא משתמש מחובר. אנא התחבר לאתר ויקטורי.');
        return;
    }

    if (!branchId) {
        // Attempt to discover branchId via API
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json;charset=UTF-8',
            'Authorization': 'Bearer ' + token
        };
        try {
            const r = await fetch(`/v2/retailers/${VICTORY_RETAILER_ID}/users/me?appId=${VICTORY_APP_ID}`, {
                headers, credentials: 'include'
            });
            if (r.ok) {
                const d = await r.json();
                branchId = d?.branchId || d?.selectedBranchId || d?.branch?.id || d?.user?.branchId;
            }
        } catch(e) {}
    }

    if (!branchId) {
        updateVictoryStatus('❌ שגיאה: לא הצלחתי למצוא סניף. אנא בחר סניף באתר ויקטורי.');
        return;
    }

    const headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "Authorization": 'Bearer ' + token
    };

    updateVictoryStatus('🚀 מכין את המוצרים להעברה...');

    const linesPayload = [];
    let successCount = 0;

    for (const item of cartItems) {
        const internalCode = item.victory_code || item.victory_retailer_id || item.retailerProductId;

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
        updateVictoryStatus('❌ אין מוצרים להעברה (חסרים קודים פנימיים).');
        return;
    }

    const payload = {
        lines: linesPayload,
        deliveryType: 1
    };

    updateVictoryStatus('🛒 משגר את העגלה לויקטורי...');
    const addUrl = `https://www.victoryonline.co.il/v2/retailers/${VICTORY_RETAILER_ID}/branches/${branchId}/carts?appId=${VICTORY_APP_ID}`;

    try {
        const addResponse = await fetch(addUrl, {
            method: 'POST',
            headers: headers,
            credentials: 'include',
            body: JSON.stringify(payload)
        });

        if (addResponse.ok || addResponse.status === 201) {
            updateVictoryStatus(`🎉 מדהים! ${successCount} מוצרים הועברו לעגלה שלך! מרענן...`);
            setTimeout(() => window.location.reload(), 2000);
        } else {
            updateVictoryStatus(`❌ השרת סירב לבקשה (שגיאה ${addResponse.status})`);
            const errorText = await addResponse.text();
            console.error("פירוט שגיאה מהשרת:", errorText);
        }

    } catch (error) {
        console.error("שגיאת רשת:", error);
        updateVictoryStatus('❌ חלה שגיאת תקשורת מול שרתי ויקטורי.');
    }
}

// ===== פונקציות ממשק =====
function createVictoryStatusWindow() {
    const existing = document.getElementById('victory-compare-status');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'victory-compare-status';
    container.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 320px;
        background: white; border: 3px solid #1565c0; border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 999999;
        padding: 20px; direction: rtl; font-family: Arial, sans-serif; text-align: center;
    `;
    container.innerHTML = `
        <h3 style="margin:0 0 10px 0; color:#1565c0;">פרויקט סופרים - ויקטורי</h3>
        <p id="victory-status-text" style="margin:0; font-size:16px; font-weight:bold;">מתחיל...</p>
    `;
    document.body.appendChild(container);
}

function updateVictoryStatus(text) {
    const el = document.getElementById('victory-status-text');
    if (el) el.innerText = text;
}