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

    try {
        const frontendData = localStorage.getItem('frontend');
        if (frontendData) {
            const parsed = JSON.parse(frontendData);
            token = parsed.session?.token || parsed.token;
            branchId = parsed.branchId;
        }
    } catch (e) {
        console.error("שגיאה בקריאת נתוני משתמש:", e);
    }

    if (!token || !branchId) {
        updateVictoryStatus('❌ שגיאה: לא הצלחתי למצוא משתמש מחובר. אנא התחבר לאתר ויקטורי.');
        return;
    }

    const headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "Authorization": token.includes('Bearer') ? token : 'Bearer ' + token
    };

    updateVictoryStatus('🚀 מכין את המוצרים להעברה...');

    const linesPayload = [];
    let successCount = 0;

    for (const item of cartItems) {
        const internalCode = item.victory_code || item.retailerProductId;

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
            body: JSON.stringify(payload)
        });

        if (addResponse.ok || addResponse.status === 201) {
            // החזרנו את הודעת ההצלחה ואת הרענון האוטומטי אחרי 2 שניות!
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