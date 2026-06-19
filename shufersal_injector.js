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

    if (!csrfToken) {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const match = script.textContent.match(/CSRFToken\s*[:=]\s*['"]([^'"]+)['"]/i);
            if (match) {
                csrfToken = match[1];
                break;
            }
        }
    }

    console.log("Shufersal Injector: Detected CSRF Token:", csrfToken);
    console.log("Shufersal Injector: Items to transfer:", cartItems);

    if (!csrfToken) {
        updateShufersalStatus('⚠️ אזהרה: לא נמצא טוקן CSRF. מנסה בכל זאת...');
    } else {
        updateShufersalStatus(`🔑 טוקן CSRF נמצא: ${csrfToken.substring(0, 8)}... מכין ${cartItems.length} מוצרים...`);
    }

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
    };
    if (csrfToken) {
        headers['CSRFToken'] = csrfToken;
        headers['X-CSRF-Token'] = csrfToken;
        headers['X-Csrf-Token'] = csrfToken;
    }

    let successCount = 0;
    let urlStatuses = {};

    const urlsToTry = [
        '/online/he/cart/addEntry',
        '/online/he/cart/addEntry/',
        '/online/he/cart/add',
        '/online/he/cart/add/',
        '/online/he/cart/addentry',
        '/online/he/cart/addentry/',
        '/he/cart/addEntry',
        '/he/cart/addEntry/',
        '/he/cart/add',
        '/he/cart/add/',
        '/he/cart/addentry',
        '/he/cart/addentry/'
    ];

    const formTag = document.querySelector('form[action*="/cart/"]');
    if (formTag) {
        const actionUrl = formTag.getAttribute('action');
        if (actionUrl && !urlsToTry.includes(actionUrl)) {
            urlsToTry.unshift(actionUrl);
            if (!actionUrl.endsWith('/')) {
                urlsToTry.unshift(actionUrl + '/');
            }
        }
    }

    console.log("Shufersal Injector: Endpoints to attempt:", urlsToTry);

    for (let idx = 0; idx < cartItems.length; idx++) {
        const item = cartItems[idx];
        if (!item.shufersal_code) {
            console.warn("Shufersal Injector: Skipped item due to missing shufersal_code:", item);
            continue;
        }
        const code = item.shufersal_code.startsWith('P_') ? item.shufersal_code : 'P_' + item.shufersal_code;

        updateShufersalStatus(`שולח מוצר ${idx + 1}/${cartItems.length}: ${item.name || code}...`);

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
        formData.append('quantity', item.quantity || 1);
        if (csrfToken) {
            formData.append('CSRFToken', csrfToken);
        }

        let itemSuccess = false;
        for (const url of urlsToTry) {
            try {
                console.log(`Shufersal Injector: Sending add request to ${url} for ${code}`);
                const resp = await fetch(url, {
                    method: 'POST',
                    headers,
                    credentials: 'include',
                    body: formData.toString()
                });

                const text = await resp.text();
                console.log(`Shufersal Injector: Response from ${url} for ${code}: status = ${resp.status}`, text.substring(0, 300));
                
                urlStatuses[url] = resp.status;
                
                if (resp.ok) {
                    // Check if response is HTML (redirect / login page)
                    if (text.trim().startsWith('<') || text.includes('<!DOCTYPE html>') || text.includes('<html')) {
                        console.warn(`Shufersal Injector: Received HTML instead of JSON for ${code}. This usually means redirect due to expired session or invalid CSRF.`);
                        urlStatuses[url] = 'HTML_REDIRECT';
                        continue;
                    }
                    
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    } catch (e) {}
                    
                    if (parsed) {
                        // If it is JSON, check Hybris success indicators
                        if (parsed.statusCode && parsed.statusCode !== 'success') {
                            console.warn(`Shufersal Injector: Server returned JSON status: ${parsed.statusCode} for ${code}`);
                            urlStatuses[url] = `JSON_ERROR_${parsed.statusCode}`;
                            continue;
                        }
                        if (parsed.quantityAdded === 0) {
                            console.warn(`Shufersal Injector: Server returned quantityAdded = 0 for ${code}`);
                            urlStatuses[url] = 'JSON_QTY_0';
                            continue;
                        }
                    }
                    
                    itemSuccess = true;
                    break;
                } else {
                    console.warn(`Shufersal Injector: Failed response from ${url} for ${code}:`, text.substring(0, 300));
                }
            } catch (e) {
                urlStatuses[url] = 'NetworkError';
                console.error(`Shufersal Injector: Fetch error on ${url} for ${code}:`, e);
            }
        }

        if (itemSuccess) {
            successCount++;
        }
    }

    if (successCount > 0) {
        updateShufersalStatus(`🎉 הצלחה! ${successCount} מתוך ${cartItems.length} מוצרים הועברו לעגלה! מרענן...`);
        setTimeout(() => window.location.reload(), 2000);
    } else {
        const statusReport = Object.entries(urlStatuses)
            .map(([url, status]) => `- ${url}: ${status}`)
            .join('\n');
        updateShufersalStatus(`❌ שגיאה: לא הצלחנו להעביר אף מוצר.\n\nתוצאות נתיבים:\n${statusReport}\n\nאנא ודא שאתה מחובר לחשבון שלך בשופרסל ונסה שנית.`);
    }
}

function createShufersalStatusWindow() {
    const existing = document.getElementById('shufersal-compare-status');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'shufersal-compare-status';
    container.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 340px;
        background: white; border: 3px solid #e8132b; border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 999999;
        padding: 20px; direction: rtl; font-family: Arial, sans-serif; text-align: right;
    `;
    container.innerHTML = `
        <h3 style="margin:0 0 10px 0; color:#e8132b; text-align: center;">פרויקט סופרים - שופרסל</h3>
        <p id="shufersal-status-text" style="margin:0; font-size:14px; font-weight:bold; white-space:pre-wrap; color:#333; line-height: 1.4;"></p>
    `;
    document.body.appendChild(container);
}

function updateShufersalStatus(text) {
    const el = document.getElementById('shufersal-status-text');
    if (el) el.innerText = text;
}
