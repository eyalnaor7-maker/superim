// 15-minute live price cache helpers + chrome.storage.local wrapper.
const PRICE_CACHE_TTL_MS = 15 * 60 * 1000;
const PRICE_CACHE_MAX_ENTRIES = 600;
const PRICE_CACHE_STORAGE_KEY = 'livePriceCache';

function makePriceCacheKey(storeKey, branchId, code) {
    const branch = branchId != null && String(branchId).trim() !== '' ? String(branchId).trim() : 'default';
    return `${storeKey}|${branch}|${String(code)}`;
}

/**
 * Split `codes` into `{ hits, misses }` against `cacheMap` for entries fresher than `PRICE_CACHE_TTL_MS`.
 */
function getFreshCachedPrices(cacheMap, storeKey, branchId, codes, nowMs = Date.now()) {
    const map = cacheMap && typeof cacheMap === 'object' ? cacheMap : {};
    const hits = {};
    const misses = [];

    for (const code of (Array.isArray(codes) ? codes : [])) {
        const key = makePriceCacheKey(storeKey, branchId, code);
        const entry = map[key];
        if (entry && typeof entry.cachedAt === 'number' && (nowMs - entry.cachedAt) < PRICE_CACHE_TTL_MS) {
            hits[String(code)] = entry;
        } else {
            misses.push(code);
        }
    }

    return { hits, misses };
}

/**
 * Return a new cacheMap with `freshEntries` merged at `nowMs`, expired entries removed,
 * and total size capped at `PRICE_CACHE_MAX_ENTRIES` (oldest-first eviction).
 */
function mergePriceCache(cacheMap, storeKey, branchId, freshEntries, nowMs = Date.now()) {
    const next = {};
    if (cacheMap && typeof cacheMap === 'object') {
        for (const [k, v] of Object.entries(cacheMap)) {
            if (v && typeof v.cachedAt === 'number' && (nowMs - v.cachedAt) < PRICE_CACHE_TTL_MS) {
                next[k] = v;
            }
        }
    }

    if (Array.isArray(freshEntries)) {
        for (const item of freshEntries) {
            if (!item) continue;
            const code = item.code ?? item.barcode ?? item.id;
            if (code == null || code === '') continue;
            const key = makePriceCacheKey(storeKey, branchId, code);
            next[key] = { ...item, cachedAt: nowMs };
        }
    } else if (freshEntries && typeof freshEntries === 'object') {
        for (const [code, val] of Object.entries(freshEntries)) {
            if (!val) continue;
            const key = makePriceCacheKey(storeKey, branchId, code);
            next[key] = { ...val, cachedAt: nowMs };
        }
    }

    const keys = Object.keys(next);
    if (keys.length > PRICE_CACHE_MAX_ENTRIES) {
        keys.sort((a, b) => (next[a].cachedAt || 0) - (next[b].cachedAt || 0));
        const excess = keys.length - PRICE_CACHE_MAX_ENTRIES;
        for (let i = 0; i < excess; i++) {
            delete next[keys[i]];
        }
    }

    return next;
}

async function loadLivePriceCache() {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return {};
    try {
        const res = await chrome.storage.local.get(PRICE_CACHE_STORAGE_KEY);
        return res?.[PRICE_CACHE_STORAGE_KEY] || {};
    } catch (e) {
        return {};
    }
}

async function saveLivePriceCache(cacheMap) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    try {
        await chrome.storage.local.set({ [PRICE_CACHE_STORAGE_KEY]: cacheMap || {} });
    } catch (e) { }
}

if (typeof module !== 'undefined') {
    module.exports = {
        PRICE_CACHE_TTL_MS,
        PRICE_CACHE_MAX_ENTRIES,
        makePriceCacheKey,
        getFreshCachedPrices,
        mergePriceCache,
        loadLivePriceCache,
        saveLivePriceCache
    };
}
