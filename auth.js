// Optional Supabase Auth client (publishable key only) and Hebrew error texts.
// Talks to Supabase Auth (the hosted login service) over its REST API: passwords are checked and tokens issued
// by Supabase, never here. Same calls as supabase-js uses, for the few methods the extension needs.
// The session (access + refresh token) lives in chrome.storage.local, shared by the popup and the settings page.
const CONFIRM_URL = 'https://supermarket-compare-81306.web.app/confirmed.html';

function oauthAuthorizeUrl(provider = 'google') {
    const base = typeof SUPABASE_URL !== 'undefined'
        ? SUPABASE_URL
        : (typeof globalThis !== 'undefined' && globalThis.SUPABASE_URL) || 'https://icdethibkzwzguwmfoef.supabase.co';
    const url = String(base || '').replace(/\/+$/, '');
    return `${url}/auth/v1/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(CONFIRM_URL)}`;
}

function parseOAuthHash(hash) {
    const raw = String(hash || '');
    const idx = raw.indexOf('#');
    const frag = idx >= 0 ? raw.slice(idx + 1) : raw;
    if (!frag) return null;
    const params = new URLSearchParams(frag);
    const access_token = params.get('access_token');
    if (!access_token) return null;
    const rawExp = Number(params.get('expires_in'));
    const expires_in = Number.isFinite(rawExp) && rawExp > 0 ? rawExp : 3600;
    return {
        access_token,
        refresh_token: params.get('refresh_token') || '',
        token_type: params.get('token_type') || 'bearer',
        expires_in,
        expires_at: Math.floor(Date.now() / 1000) + expires_in
    };
}

const sb = (() => {
    if (typeof SUPABASE_URL === 'undefined' || typeof chrome === 'undefined' || !chrome.storage) return null;
    const KEY = 'sbSession';
    const listeners = [];
    const headers = token => ({ apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' });
    const asError = (status, body) => ({ status, code: body?.error_code || body?.code || (status === 429 ? 'rate_limited' : 'unavailable') });
    async function call(path, body, token, method) {
        try {
            const m = method || 'POST';
            const r = await fetch(SUPABASE_URL + path, { method: m, headers: headers(token), body: body === undefined || m === 'GET' ? undefined : JSON.stringify(body) });
            const data = r.status === 204 ? null : await r.json().catch(() => null);
            return r.ok ? { data, error: null } : { data: null, error: asError(r.status, data) };
        } catch (e) { return { data: null, error: { status: 0, code: 'unavailable' } }; }
    }
    const read = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
    async function save(session) {
        if (session) await chrome.storage.local.set({ [KEY]: session }); else await chrome.storage.local.remove(KEY);
        listeners.forEach(f => f(session ? 'SIGNED_IN' : 'SIGNED_OUT', session));
    }
    const keep = d => ({ access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: { id: d.user?.id, email: d.user?.email } });
    async function getSession() {
        let s = await read();
        if (s && s.expires_at - 60 < Date.now() / 1000) { // expired or about to: trade the refresh token for a new pair
            const { data, error } = await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
            s = error ? null : keep(data);
            await save(s);
        }
        return { data: { session: s }, error: null };
    }
    async function signInWithGoogle() {
        if (!chrome.tabs) return { data: null, error: { status: 0, code: 'unavailable' } };
        const currentTab = (await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []))[0] || null;
        let authTab;
        try {
            authTab = await chrome.tabs.create({ url: oauthAuthorizeUrl('google'), active: true });
        } catch (e) {
            return { data: null, error: { status: 0, code: 'unavailable' } };
        }
        const restoreFocus = () => {
            if (currentTab?.id) chrome.tabs.update(currentTab.id, { active: true }).catch(() => {});
            if (currentTab?.windowId && chrome.windows?.update) chrome.windows.update(currentTab.windowId, { focused: true }).catch(() => {});
        };
        const oauthResult = await new Promise(resolve => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                chrome.tabs.onRemoved?.removeListener(onRemoved);
            };
            const finish = res => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(res);
            };
            const onUpdated = (tabId, changeInfo, tab) => {
                if (tabId !== authTab.id) return;
                const tabUrl = changeInfo.url || tab?.url || '';
                if (!tabUrl.startsWith(CONFIRM_URL)) return;
                if (tabUrl.includes('#access_token=')) {
                    const parsed = parseOAuthHash(tabUrl);
                    chrome.tabs.remove(authTab.id).catch(() => {});
                    restoreFocus();
                    if (!parsed) return finish({ data: null, error: { status: 400, code: 'unavailable' } });
                    return finish({ data: parsed, error: null });
                }
                if (tabUrl.includes('error=')) {
                    chrome.tabs.remove(authTab.id).catch(() => {});
                    restoreFocus();
                    return finish({ data: null, error: { status: 400, code: 'unavailable' } });
                }
            };
            const onRemoved = tabId => {
                if (tabId !== authTab.id) return;
                restoreFocus();
                finish({ data: null, error: { status: 0, code: 'oauth_cancelled' } });
            };
            const timer = setTimeout(() => {
                chrome.tabs.remove(authTab.id).catch(() => {});
                restoreFocus();
                finish({ data: null, error: { status: 408, code: 'oauth_timeout' } });
            }, 120000);
            chrome.tabs.onUpdated.addListener(onUpdated);
            chrome.tabs.onRemoved?.addListener(onRemoved);
        });
        if (oauthResult.error) return oauthResult;

        const { data: userData, error: userErr } = await call('/auth/v1/user', undefined, oauthResult.data.access_token, 'GET');
        if (userErr || !userData) return { data: null, error: userErr || { status: 0, code: 'unavailable' } };
        const session = keep({ ...oauthResult.data, user: userData.user || userData });
        await save(session);
        call('/rest/v1/rpc/log_my_event', { p_event: 'sign_in' }, session.access_token).catch(() => {});
        return { data: { session, user: session.user }, error: null };
    }
    return {
        auth: {
            getSession,
            signInWithGoogle,
            async signInWithPassword({ email, password }) {
                const { data, error } = await call('/auth/v1/token?grant_type=password', { email, password });
                if (!error) await save(keep(data));
                return { data, error };
            },
            signUp: ({ email, password }) => call('/auth/v1/signup', { email, password }),
            async signOut(opts) {
                const s = await read();
                if (s) await call(`/auth/v1/logout?scope=${opts?.scope || 'global'}`, undefined, s.access_token);
                await save(null);
                return { error: null };
            },
            onAuthStateChange(fn) {
                listeners.push(fn);
                getSession().then(({ data }) => fn('INITIAL_SESSION', data.session));
                return { data: { subscription: { unsubscribe() { listeners.splice(listeners.indexOf(fn), 1); } } } };
            }
        },
        async rpc(name, args) {
            const { data: { session } } = await getSession();
            return call(`/rest/v1/rpc/${name}`, args || {}, session?.access_token);
        }
    };
})();

const FRIENDLY_ERRORS = {
    not_signed_in: 'כדי להשתמש ב-AI צריך להתחבר',
    daily_limit: 'השתמשת כבר היום בחיפוש התחליפים. אפשר לנסות שוב מחר.',
    unavailable: 'השירות לא זמין כרגע. נסו שוב מאוחר יותר.',
    bad_request: 'הבקשה לא תקינה. נסו שוב.',
    invalid_credentials: 'האימייל או הסיסמה לא נכונים.',
    email_not_confirmed: 'צריך לאשר את האימייל. בדקו את תיבת המייל.',
    weak_password: 'הסיסמה חלשה מדי. השתמשו ב-8 תווים לפחות.',
    rate_limited: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
    user_exists: 'כבר קיים חשבון עם האימייל הזה. נסו להתחבר.',
    oauth_cancelled: 'ההתחברות עם Google בוטלה.',
    oauth_timeout: 'ההתחברות עם Google לא הושלמה בזמן. נסו שוב.'
};

// Accepts a code string or a supabase-js auth error ({ code, status }).
function friendlyError(err) {
    let code = err;
    if (err && typeof err === 'object') {
        code = err.status === 429 ? 'rate_limited' : err.code === 'user_already_exists' ? 'user_exists' : err.code;
    }
    return FRIENDLY_ERRORS[code] || 'משהו השתבש. נסו שוב.';
}

if (typeof module !== 'undefined') module.exports = { friendlyError, oauthAuthorizeUrl, parseOAuthHash, CONFIRM_URL };
