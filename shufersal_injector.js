// ===== SHUFERSAL INJECTOR =====
// Content script that runs on shufersal.co.il pages.
// Picks up a savedCartShufersal from chrome.storage and transfers the items.

function initShufersal() {
    chrome.storage.local.get(['savedCartShufersal'], function (result) {
        if (result.savedCartShufersal && result.savedCartShufersal.length > 0) {
            chrome.storage.local.remove(['savedCartShufersal']);
            transferCartToShufersal(result.savedCartShufersal);
        }
    });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initShufersal();
} else {
    window.addEventListener('load', initShufersal);
}

async function transferCartToShufersal(cartItems) {
    createShufersalStatusWindow();
    updateShufersalStatus('מתחבר לשופרסל...');

    let csrfToken = '';
    const metaTag = document.querySelector('meta[name="_csrf"]');
    if (metaTag) csrfToken = metaTag.getAttribute('content');

    if (!csrfToken) {
        const inputTag = document.querySelector('input[name="CSRFToken"]');
        if (inputTag) csrfToken = inputTag.value;
    }

    if (!csrfToken) {
        const cookies = document.cookie.split(';');
        for (const c of cookies) {
            const [k, v] = c.trim().split('=');
            if (k.toLowerCase().includes('csrf')) {
                csrfToken = decodeURIComponent(v);
                break;
            }
        }
    }

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        // שים לב לשינוי כאן - השתמשנו בפורמט שגילית!
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    if (csrfToken) headers['CSRFToken'] = csrfToken;

    updateShufersalStatus(`מעביר ${cartItems.length} מוצרים לעגלה...`);

    let successCount = 0;

    for (const item of cartItems) {
        if (!item.shufersal_code) continue;
        const code = item.shufersal_code.startsWith('P_') ? item.shufersal_code : 'P_' + item.shufersal_code;

        // בניית החבילה המדויקת שגילית בשטח!
        const formData = new URLSearchParams();
        formData.append('cartContext[openFrom]', 'DEPARTMENT');
        formData.append('cartContext[recommendationType]', 'REGULAR');
        formData.append('productCodePost', code);
        formData.append('productCode', code);
        formData.append('sellingMethod', 'BY_UNIT');
        formData.append('affiliateCode', '');
        formData.append('comment', '');
        formData.append('frontQuantity', item.quantity || 1);
        formData.append('qty', item.quantity || 1);

        try {
            // הוספת המוצר דרך הנתיב הסטנדרטי של שופרסל
            const resp = await fetch('/online/he/cart/addEntry', {
                method: 'POST',
                headers,
                credentials: 'include',
                body: formData.toString()
            });

            if (resp.ok) {
                successCount++;
            }
        } catch (e) {
            console.error('Failed to add to Shufersal', code, e);
        }
    }

    if (successCount > 0) {
        updateShufersalStatus(`הצלחה! ${successCount} מוצרים הועברו לעגלה שלך! מרענן עמוד...`);
        setTimeout(() => window.location.reload(), 2000);
    } else {
        updateShufersalStatus('לא הצלחתי להוסיף מוצרים. נסה שוב לאחר התחברות לשופרסל.');
    }
}

function createShufersalStatusWindow() {
    const existing = document.getElementById('shufersal-compare-status');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'shufersal-compare-status';
    container.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 320px;
        background: white; border: 3px solid #e8132b; border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 999999;
        padding: 20px; direction: rtl; font-family: Arial, sans-serif; text-align: center;
    `;
    container.innerHTML = `
        <h3 style="margin:0 0 10px 0; color:#e8132b;">פרויקט סופרים - שופרסל</h3>
        <p id="shufersal-status-text" style="margin:0; font-size:16px; font-weight:bold;">מתחיל...</p>
    `;
    document.body.appendChild(container);
}

function updateShufersalStatus(text) {
    const el = document.getElementById('shufersal-status-text');
    if (el) el.innerText = text;
}
