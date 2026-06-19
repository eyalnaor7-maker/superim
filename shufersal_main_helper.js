// ===== SHUFERSAL MAIN HELPER =====
// Runs in the MAIN world (page context).
// Communicates with shufersal_injector.js (ISOLATED world) via window.postMessage.

window.addEventListener("message", async function(event) {
    // Only accept messages from our own window and from the isolated content script
    if (event.source !== window || !event.data || event.data.source !== "shufersal-isolated") {
        return;
    }

    const { action, requestId } = event.data;

    if (action === "GET_CSRF") {
        let token = '';
        if (window.ACC && window.ACC.config) {
            token = window.ACC.config.CSRFToken || window.ACC.config.csrfToken || '';
        }
        if (!token) {
            token = window.csrfToken || window.CSRFToken || '';
        }
        window.postMessage({
            source: "shufersal-main",
            action: "GET_CSRF_RESPONSE",
            csrfToken: token,
            requestId
        }, "*");
    } else if (action === "EXECUTE_FETCH") {
        const { url, options } = event.data;
        try {
            // Execute fetch in the page context
            const resp = await fetch(url, options);
            const text = await resp.text();
            window.postMessage({
                source: "shufersal-main",
                action: "EXECUTE_FETCH_RESPONSE",
                status: resp.status,
                statusText: resp.statusText,
                text: text,
                requestId
            }, "*");
        } catch (e) {
            window.postMessage({
                source: "shufersal-main",
                action: "EXECUTE_FETCH_RESPONSE",
                error: e.message,
                requestId
            }, "*");
        }
    }
});
