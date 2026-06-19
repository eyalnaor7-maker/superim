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

        // Try jQuery $.ajax first if available (bypasses extension initiator cookie tracking)
        if (window.$ && typeof window.$.ajax === 'function') {
            window.$.ajax({
                url: url,
                type: options.method || 'POST',
                data: options.body,
                headers: options.headers,
                dataType: 'text',
                xhrFields: {
                    withCredentials: true
                },
                success: function(data, textStatus, jqXHR) {
                    window.postMessage({
                        source: "shufersal-main",
                        action: "EXECUTE_FETCH_RESPONSE",
                        status: jqXHR.status,
                        statusText: jqXHR.statusText,
                        text: data,
                        requestId
                    }, "*");
                },
                error: function(jqXHR, textStatus, errorThrown) {
                    window.postMessage({
                        source: "shufersal-main",
                        action: "EXECUTE_FETCH_RESPONSE",
                        status: jqXHR.status,
                        statusText: jqXHR.statusText,
                        text: jqXHR.responseText || '',
                        error: errorThrown || textStatus,
                        requestId
                    }, "*");
                }
            });
            return;
        }

        // Try native XMLHttpRequest if $.ajax is not available
        try {
            const xhr = new XMLHttpRequest();
            xhr.open(options.method || 'POST', url, true);
            xhr.withCredentials = true;
            
            // Set headers
            if (options.headers) {
                for (const [key, val] of Object.entries(options.headers)) {
                    xhr.setRequestHeader(key, val);
                }
            }

            xhr.onload = function() {
                window.postMessage({
                    source: "shufersal-main",
                    action: "EXECUTE_FETCH_RESPONSE",
                    status: xhr.status,
                    statusText: xhr.statusText,
                    text: xhr.responseText,
                    requestId
                }, "*");
            };

            xhr.onerror = function() {
                window.postMessage({
                    source: "shufersal-main",
                    action: "EXECUTE_FETCH_RESPONSE",
                    error: "XHR Network Error",
                    requestId
                }, "*");
            };

            xhr.send(options.body);
        } catch (xhrError) {
            // Fallback to native fetch
            try {
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
    }
});
