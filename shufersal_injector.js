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

let pendingRequests = {};

window.addEventListener("message", function(event) {
    if (event.source !== window || !event.data || event.data.source !== "shufersal-main") {
        return;
    }

    const { action, requestId } = event.data;
    if (pendingRequests[requestId]) {
        pendingRequests[requestId](event.data);
        delete pendingRequests[requestId];
    }
});

function getCsrfFromMainWorld() {
    return new Promise((resolve) => {
        const requestId = Math.random().toString(36).substring(2, 9);
        pendingRequests[requestId] = (data) => {
            resolve(data.csrfToken || '');
        };
        window.postMessage({
            source: "shufersal-isolated",
            action: "GET_CSRF",
            requestId
        }, "*");
        setTimeout(() => {
            if (pendingRequests[requestId]) {
                delete pendingRequests[requestId];
                resolve('');
            }
        }, 1500);
    });
}

function fetchFromMainWorld(url, options) {
    return new Promise((resolve, reject) => {
        const requestId = Math.random().toString(36).substring(2, 9);
        pendingRequests[requestId] = (data) => {
            if (data.error) {
                reject(new Error(data.error));
            } else {
                resolve({
                    ok: data.status >= 200 && data.status < 300,
                    status: data.status,
                    statusText: data.statusText,
                    text: () => Promise.resolve(data.text)
                });
            }
        };
        window.postMessage({
            source: "shufersal-isolated",
            action: "EXECUTE_FETCH",
            url,
            options,
            requestId
        }, "*");
    });
}

async function transferCartToShufersal(cartItems) {
    createShufersalStatusWindow();
    updateShufersalStatus('מתחבר לשופרסל...');

    let csrfToken = '';
    let tokenSource = '';

    csrfToken = await getCsrfFromMainWorld();
    if (csrfToken) tokenSource = 'Page Context (ACC.config helper)';

    if (!csrfToken) {
        const metaTag = document.querySelector('meta[name="_csrf"]');
        if (metaTag) {
            csrfToken = metaTag.getAttribute('content');
            tokenSource = 'Meta Tag (_csrf)';
        }
    }

    if (!csrfToken) {
        const inputTag = document.querySelector('input[name="CSRFToken"]');
        if (inputTag) {
            csrfToken = inputTag.value;
            tokenSource = 'Input Tag (CSRFToken)';
        }
    }

    if (!csrfToken) {
        const cookies = document.cookie.split(';');
        for (const c of cookies) {
            const idx = c.indexOf('=');
            if (idx !== -1) {
                const k = c.substring(0, idx).trim();
                const v = c.substring(idx + 1).trim();
                if (k.toLowerCase().includes('csrf') || k.toLowerCase().includes('xsrf')) {
                    csrfToken = decodeURIComponent(v);
                    tokenSource = `Cookie (${k})`;
                    break;
                }
            }
        }
    }

    if (!csrfToken) {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
            const match = script.textContent.match(/CSRFToken\s*[:=]\s*['"]([^'"]+)['"]/i);
            if (match) {
                csrfToken = match[1];
                tokenSource = 'Inline Script';
                break;
            }
        }
    }

    console.log("Shufersal Injector: Detected CSRF Token:", csrfToken, "Source:", tokenSource);
    console.log("Shufersal Injector: Items to transfer:", cartItems);

    if (!csrfToken) {
        updateShufersalStatus('⚠️ אזהרה: לא נמצא טוקן CSRF. מנסה בכל זאת...');
    } else {
        updateShufersalStatus(`🔑 טוקן CSRF נמצא מ-${tokenSource}: ${csrfToken.substring(0, 8)}... מכין ${cartItems.length} מוצרים...`);
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
        headers['csrftoken'] = csrfToken;
        headers['X-XSRF-TOKEN'] = csrfToken;
    }

    let successCount = 0;
    let urlStatuses = {};

    for (let idx = 0; idx < cartItems.length; idx++) {
        const item = cartItems[idx];
        if (!item.shufersal_code) {
            console.warn("Shufersal Injector: Skipped item due to missing shufersal_code:", item);
            continue;
        }
        const code = item.shufersal_code.startsWith('P_') ? item.shufersal_code : 'P_' + item.shufersal_code;

        updateShufersalStatus(`שולח מוצר ${idx + 1}/${cartItems.length}: ${item.name || code}...`);

        let itemSuccess = false;
        let itemLog = `Product: ${item.name || code}\n`;

        // Define the specific attempts based on exact F12 network logs
        const attempts = [
            // Attempt 1: Exact F12 JSON structure with cartContext params (openFrom=PRODUCT)
            {
                url: '/online/he/cart/add?cartContext%5BopenFrom%5D=PRODUCT&cartContext%5BrecommendationType%5D=REGULAR',
                type: 'json',
                label: 'json-exact-f12-product',
                reqBody: JSON.stringify({
                    productCodePost: code,
                    productCode: code,
                    sellingMethod: "BY_UNIT",
                    qty: String(item.quantity || 1),
                    frontQuantity: String(item.quantity || 1),
                    comment: "",
                    affiliateCode: ""
                })
            },
            // Attempt 2: Exact F12 JSON structure with cartContext params (openFrom=DEPARTMENT)
            {
                url: '/online/he/cart/add?cartContext%5BopenFrom%5D=DEPARTMENT&cartContext%5BrecommendationType%5D=REGULAR',
                type: 'json',
                label: 'json-exact-f12-dept',
                reqBody: JSON.stringify({
                    productCodePost: code,
                    productCode: code,
                    sellingMethod: "BY_UNIT",
                    qty: String(item.quantity || 1),
                    frontQuantity: String(item.quantity || 1),
                    comment: "",
                    affiliateCode: ""
                })
            },
            // Attempt 3: Exact F12 JSON structure without query params
            {
                url: '/online/he/cart/add',
                type: 'json',
                label: 'json-exact-f12-no-params',
                reqBody: JSON.stringify({
                    productCodePost: code,
                    productCode: code,
                    sellingMethod: "BY_UNIT",
                    qty: String(item.quantity || 1),
                    frontQuantity: String(item.quantity || 1),
                    comment: "",
                    affiliateCode: ""
                })
            },
            // Attempt 4: Trailing slash exact JSON
            {
                url: '/online/he/cart/add/',
                type: 'json',
                label: 'json-exact-f12-slash',
                reqBody: JSON.stringify({
                    productCodePost: code,
                    productCode: code,
                    sellingMethod: "BY_UNIT",
                    qty: String(item.quantity || 1),
                    frontQuantity: String(item.quantity || 1),
                    comment: "",
                    affiliateCode: ""
                })
            },
            // Fallback 5: Standard Form Post to /online/he/cart/add (openFrom=PRODUCT)
            {
                url: '/online/he/cart/add?cartContext%5BopenFrom%5D=PRODUCT&cartContext%5BrecommendationType%5D=REGULAR',
                type: 'form',
                label: 'form-exact-f12-product',
                reqBody: null
            },
            // Fallback 6: Standard Form Post to /online/he/cart/add (openFrom=DEPARTMENT)
            {
                url: '/online/he/cart/add?cartContext%5BopenFrom%5D=DEPARTMENT&cartContext%5BrecommendationType%5D=REGULAR',
                type: 'form',
                label: 'form-exact-f12-dept',
                reqBody: null
            },
            // Fallback 7: Form Post to addEntry
            {
                url: '/online/he/cart/addEntry',
                type: 'form',
                label: 'form-addEntry',
                reqBody: null
            }
        ];

        // Add formTag action dynamically if present
        const formTag = document.querySelector('form[action*="/cart/"]');
        if (formTag) {
            const actionUrl = formTag.getAttribute('action');
            if (actionUrl) {
                attempts.push({
                    url: actionUrl,
                    type: 'form',
                    label: 'form-tag-action',
                    reqBody: null
                });
            }
        }

        for (const attempt of attempts) {
            const { url, type, label, reqBody } = attempt;
            const attemptKey = `${url} (${label})`;
            try {
                let bodyToSend;
                let reqHeaders = { ...headers };

                if (type === 'json') {
                    reqHeaders['Content-Type'] = 'application/json';
                    bodyToSend = reqBody;
                } else {
                    reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
                    const formData = new URLSearchParams();
                    const openFromVal = label.includes('product') ? 'PRODUCT' : 'DEPARTMENT';
                    formData.append('cartContext[openFrom]', openFromVal);
                    formData.append('cartContext[recommendationType]', 'REGULAR');
                    formData.append('productCodePost', code);
                    formData.append('productCode', code);
                    formData.append('sellingMethod', 'BY_UNIT');
                    formData.append('affiliateCode', '');
                    formData.append('comment', '');
                    formData.append('frontQuantity', String(item.quantity || 1));
                    formData.append('qty', String(item.quantity || 1));
                    formData.append('quantity', String(item.quantity || 1));
                    if (csrfToken) {
                        formData.append('CSRFToken', csrfToken);
                    }
                    bodyToSend = formData.toString();
                }

                console.log(`Shufersal Injector: Sending add request to ${url} (${label}) for ${code}`);
                const resp = await fetchFromMainWorld(url, {
                    method: 'POST',
                    headers: reqHeaders,
                    credentials: 'include',
                    body: bodyToSend
                });

                const text = await resp.text();
                console.log(`Shufersal Injector: Response from ${url} (${label}) for ${code}: status = ${resp.status}`, text.substring(0, 300));

                urlStatuses[attemptKey] = resp.status;
                itemLog += `- ${url} (${label}) -> Status ${resp.status}\n  Response: ${text.substring(0, 150).replace(/\r?\n|\r/g, " ")}\n`;

                if (resp.ok) {
                    // Check if response is a full page redirect (contains standard document tags or title)
                    if (text.includes('<!DOCTYPE html>') || text.includes('<html') || text.includes('<title>Shufersal</title>')) {
                        console.warn(`Shufersal Injector: Received HTML page instead of fragment for ${code}.`);
                        urlStatuses[attemptKey] = 'HTML_REDIRECT_ERROR';
                        continue;
                    }

                    // A successful update will return the minicart HTML fragment containing the product code
                    if (text.includes(code)) {
                        itemSuccess = true;
                        urlStatuses[attemptKey] = 'SUCCESS_FRAGMENT';
                        break;
                    }

                    // Try to parse as JSON in case it was a JSON response format
                    let parsed = null;
                    try {
                        parsed = JSON.parse(text);
                    } catch (e) {}

                    if (parsed) {
                        if (parsed.statusCode && parsed.statusCode !== 'success') {
                            console.warn(`Shufersal Injector: Server returned JSON status: ${parsed.statusCode} for ${code}`);
                            urlStatuses[attemptKey] = `JSON_ERROR_${parsed.statusCode}`;
                            continue;
                        }
                        if (parsed.quantityAdded === 0) {
                            console.warn(`Shufersal Injector: Server returned quantityAdded = 0 for ${code}`);
                            urlStatuses[attemptKey] = 'JSON_QTY_0';
                            continue;
                        }
                        itemSuccess = true;
                        urlStatuses[attemptKey] = 'SUCCESS_JSON';
                        break;
                    }

                    // If it returned ok status but doesn't contain product code or valid JSON, it's not a success (probably empty cart template)
                    console.warn(`Shufersal Injector: Response did not contain product code ${code} and was not valid JSON.`);
                    urlStatuses[attemptKey] = 'FAILED_NOT_IN_FRAGMENT';
                    continue;
                } else {
                    console.warn(`Shufersal Injector: Failed response from ${url} for ${code}:`, text.substring(0, 300));
                }
            } catch (e) {
                urlStatuses[attemptKey] = 'NetworkError';
                itemLog += `- ${url} (${label}) -> NetworkError: ${e.message}\n`;
                console.error(`Shufersal Injector: Fetch error on ${url} (${label}) for ${code}:`, e);
            }
        }

        if (itemSuccess) {
            successCount++;
            addShufersalDebugLog(`✅ Success: ${item.name || code}\n${itemLog}\n`);
        } else {
            addShufersalDebugLog(`❌ Failed: ${item.name || code}\n${itemLog}\n`);
        }
    }

    if (successCount > 0) {
        if (successCount === cartItems.length) {
            updateShufersalStatus(`🎉 סיום: כל ${successCount} המוצרים הועברו בהצלחה!\nהעמוד יתרענן אוטומטית בעוד 2 שניות לעדכון העגלה... 🔄`);
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            updateShufersalStatus(`🎉 סיום: ${successCount} מתוך ${cartItems.length} מוצרים הועברו בהצלחה.\n\nחלק מהמוצרים לא הועברו. אנא בדוק את לוג הדיאגנוסטיקה למטה ולחץ על כפתור הרענון לעדכון הסל.`);
            const actionArea = document.getElementById('shufersal-action-area');
            if (actionArea) actionArea.style.display = 'block';
        }
    } else {
        const statusReport = Object.entries(urlStatuses)
            .map(([url, status]) => `- ${url}: ${status}`)
            .join('\n');
        updateShufersalStatus(`❌ שגיאה: לא הצלחנו להעביר אף מוצר.\n\nתוצאות נתיבים:\n${statusReport}\n\nאנא בדוק את הלוג למטה ושתף אותי בתוצאה.`);
    }
}

function createShufersalStatusWindow() {
    const existing = document.getElementById('shufersal-compare-status');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'shufersal-compare-status';
    container.style.cssText = `
        position: fixed; bottom: 20px; right: 20px; width: 440px; max-height: 480px;
        background: white; border: 3px solid #e8132b; border-radius: 15px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 999999;
        padding: 20px; direction: rtl; font-family: Arial, sans-serif; text-align: right;
        display: flex; flex-direction: column; overflow: hidden;
    `;
    container.innerHTML = `
        <h3 style="margin:0 0 10px 0; color:#e8132b; text-align: center;">פרויקט סופרים - שופרסל</h3>
        <div id="shufersal-status-content" style="flex: 1; overflow-y: auto; margin-bottom: 10px; min-height: 250px;">
            <p id="shufersal-status-text" style="margin:0; font-size:14px; font-weight:bold; white-space:pre-wrap; color:#333; line-height: 1.4;">מתחיל...</p>
            <div id="shufersal-debug-log" style="margin-top:10px; font-family: monospace; font-size:11px; background:#f4f4f4; padding:8px; border-radius:5px; border:1px solid #ccc; max-height:180px; overflow-y:auto; white-space:pre-wrap; display:none; direction: ltr; text-align: left;"></div>
        </div>
        <div id="shufersal-action-area" style="text-align: center; display:none;">
            <button id="shufersal-refresh-btn" style="background:#e8132b; color:white; border:none; padding:10px 20px; font-size:14px; font-weight:bold; border-radius:8px; cursor:pointer; box-shadow:0 3px 6px rgba(0,0,0,0.2);">רענן עמוד לעדכון העגלה 🔄</button>
        </div>
    `;
    document.body.appendChild(container);

    document.getElementById('shufersal-refresh-btn').addEventListener('click', () => {
        window.location.reload();
    });
}

function updateShufersalStatus(text) {
    const el = document.getElementById('shufersal-status-text');
    if (el) el.innerText = text;
}

function addShufersalDebugLog(text) {
    const el = document.getElementById('shufersal-debug-log');
    if (el) {
        el.style.display = 'block';
        el.innerText += text + '\n';
        el.scrollTop = el.scrollHeight;
    }
}
