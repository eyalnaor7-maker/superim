// ===== VICTORY INJECTOR =====
// Content script that runs on victoryonline.co.il pages.

const VICTORY_API = 'https://api.victoryonline.co.il/api/web';
const VICTORY_ALGOLIA_URL = 'https://QF3L7C47QU-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=0abb07df3782882c383198f99009782d&x-algolia-application-id=QF3L7C47QU';
// Inlined from victory_match.js (this content script loads alone).
const normalizeVictoryBarcode = v => String(v == null ? '' : v).replace(/^P_/, '').replace(/\D/g, '').replace(/^0+/, '');

function initVictory() {
    chrome.storage.local.get(['savedCartVictory'], function (result) {
        if (result.savedCartVictory && result.savedCartVictory.length > 0) {
            chrome.storage.local.remove(['savedCartVictory']);
            transferCartToVictory(result.savedCartVictory);
        }
    });
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initVictory();
} else {
    window.addEventListener('load', initVictory);
}

async function transferCartToVictory(cartItems) {
    createVictoryStatusWindow();
    updateVictoryStatus('🔍 מתחבר למערכת של ויקטורי...');

    try {
        // 1. Resolve each line to a new-platform product id
        const lines = new Map();
        const toSearch = [];
        for (const item of cartItems) {
            const quantity = Number(item.amount || item.quantity) || 1;
            const id = item.victory_code || item.victory_retailer_id;
            if (id) lines.set(String(id), quantity);
            else if (normalizeVictoryBarcode(item.barcode || item.shufersal_code)) toSearch.push({ barcode: item.barcode || item.shufersal_code, quantity });
        }

        if (toSearch.length > 0) {
            updateVictoryStatus('🔎 מאתר מוצרים בויקטורי...');
            const branchId = await new Promise(resolve => chrome.storage.sync.get(['userSettings'], r => resolve(String((r?.userSettings?.victory?.platform === 2 && r.userSettings.victory.branchId) || '55'))));
            for (let start = 0; start < toSearch.length; start += 20) {
                const batch = toSearch.slice(start, start + 20);
                const resp = await fetch(VICTORY_ALGOLIA_URL, {
                    method: 'POST',
                    body: JSON.stringify({ requests: batch.map(i => ({
                        indexName: 'products', query: normalizeVictoryBarcode(i.barcode), hitsPerPage: 6, page: 0,
                        facetFilters: [[`inStockBranches:${branchId}`]], relevancyStrictness: 0
                    })) })
                });
                if (!resp.ok) break;
                const data = await resp.json();
                if (data?.captchaAction) break;
                batch.forEach((item, idx) => {
                    const want = normalizeVictoryBarcode(item.barcode);
                    const hit = (data?.results?.[idx]?.hits || []).find(h => h && normalizeVictoryBarcode(h.sku) === want);
                    if (hit) lines.set(String(hit.id), item.quantity);
                });
            }
        }

        if (lines.size === 0) {
            updateVictoryStatus('❌ לא נמצאו מוצרים מתאימים בויקטורי.');
            return;
        }

        // 2. Get or create the guest cart session
        let sessionId = localStorage.getItem('cart-session-id');
        if (!sessionId) {
            const r = await fetch(`${VICTORY_API}/cart/session`, { headers: { 'Accept': 'application/json' } });
            const j = r.ok ? await r.json() : null;
            sessionId = j?.status === 'success' ? j.data?.sessionId : null;
            if (!sessionId) {
                updateVictoryStatus('❌ לא הצלחתי לפתוח עגלה באתר ויקטורי.');
                return;
            }
            localStorage.setItem('cart-session-id', sessionId);
        }

        // 3. One PUT with the whole array
        updateVictoryStatus('🛒 משגר את העגלה לויקטורי...');
        const payload = Array.from(lines.entries()).map(([id, quantity]) => ({ id, quantity }));
        const putResp = await fetch(`${VICTORY_API}/cart`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Cart-Session-Id': sessionId },
            body: JSON.stringify(payload)
        });
        const putJson = putResp.ok ? await putResp.json().catch(() => null) : null;
        if (putJson?.status === 'success') {
            updateVictoryStatus(`🎉 מדהים! ${payload.length} מוצרים הועברו לעגלה שלך! מרענן...`);
            setTimeout(() => window.location.reload(), 2000);
        } else {
            updateVictoryStatus(`❌ השרת סירב לבקשה (שגיאה ${putResp.status})`);
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