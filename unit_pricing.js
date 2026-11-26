// Pure helpers for unit-price parsing/formatting, outlier deep-deal detection, and weighed-staple matching.

const _UP_MULTI_RE = /(\d+(?:\.\d+)?)\s*[*×xX]\s*(\d+(?:\.\d+)?)\s*(ק["״']{0,2}ג|קילו(?:גרם)?|גרם|גר['׳]?|ג['׳]?|מ["״']{0,2}ל|מל|ליטר|ל['׳]|יח(?:ידות|ידה|['׳])?|kg|gr|g|ml|l|pcs?|units?)?(?=$|[\s,.)\-\/])/i;
const _UP_UNIT_FIRST_MULTI_RE = /(\d+(?:\.\d+)?)\s*(ק["״']{0,2}ג|קילו(?:גרם)?|גרם|גר['׳]?|ג['׳]?|מ["״']{0,2}ל|מל|ליטר|ל['׳]|kg|gr|g|ml|l)\s*[*×xX]\s*(\d+(?:\.\d+)?)(?=$|[\s,.)\-\/])/i;
const _UP_WEIGHT_VOL_RE = /(?:^|[\s,(/\-])(\d+(?:\.\d+)?)\s*(ק["״']{0,2}ג|קילו(?:גרם)?|גרם|גר['׳]?|ג['׳]|מ["״']{0,2}ל|מל|ליטר|ל['׳]|kg|gr|g|ml|l)(?=$|[\s,.)\-\/])/i;
const _UP_ATTACHED_G_RE = /(?:^|[\s,(/\-])(\d+(?:\.\d+)?)ג(?=$|[\s,.)\-\/])/;
const _UP_COUNT_RE = /(?:^|[\s,(/\-])(\d+(?:\.\d+)?)\s*(יחידות|יחידה|יח['׳]?|טבליות|קפסולות|שקיות|גלילים|pcs?|units?)(?=$|[\s,.)\-\/])/i;

function _normalizeUnitToken(rawUnit) {
    const u = String(rawUnit || '').trim().toLowerCase().replace(/["״''׳]/g, '');
    if (!u) return null;
    if (u === 'קג' || u === 'קילו' || u === 'קילוגרם' || u === 'kg') return { unit: 'g', mult: 1000 };
    if (u === 'גרם' || u === 'גר' || u === 'ג' || u === 'g' || u === 'gr') return { unit: 'g', mult: 1 };
    if (u === 'ליטר' || u === 'ל' || u === 'l') return { unit: 'ml', mult: 1000 };
    if (u === 'מל' || u === 'ml') return { unit: 'ml', mult: 1 };
    if (/^(יח|יחידה|יחידות|טבליות|קפסולות|שקיות|גלילים|pc|pcs|unit|units)$/.test(u)) return { unit: 'unit', mult: 1 };
    return null;
}

/**
 * Parse Hebrew product strings into `{ qty, unit }` normalized to `'g'`, `'ml'`, or `'unit'`, or `null` if unknown.
 */
function parseUnitInfo(name) {
    if (!name || typeof name !== 'string') return null;
    const text = name.trim();
    if (!text) return null;

    const roundQty = n => Math.round(n * 1000) / 1000;

    // 1a. "1.5 ליטר * 6"
    let m = text.match(_UP_UNIT_FIRST_MULTI_RE);
    if (m) {
        const a = parseFloat(m[1]);
        const b = parseFloat(m[3]);
        const norm = _normalizeUnitToken(m[2]);
        if (a > 0 && b > 0 && norm) {
            return { qty: roundQty(a * b * norm.mult), unit: norm.unit };
        }
    }

    // 1b. "80*4ג", "6*1.5 ליטר", "80*2"
    m = text.match(_UP_MULTI_RE);
    if (m) {
        const a = parseFloat(m[1]);
        const b = parseFloat(m[2]);
        if (a > 0 && b > 0) {
            const norm = m[3] ? _normalizeUnitToken(m[3]) : { unit: 'g', mult: 1 };
            if (norm) return { qty: roundQty(a * b * norm.mult), unit: norm.unit };
        }
    }

    // 2. Single weight or volume: "500 גרם", "1 ק"ג", "1.5 ליטר", "250 מ"ל", "750גר"
    m = text.match(_UP_WEIGHT_VOL_RE) || text.match(_UP_ATTACHED_G_RE);
    if (m) {
        const val = parseFloat(m[1]);
        const norm = m[2] ? _normalizeUnitToken(m[2]) : { unit: 'g', mult: 1 };
        if (val > 0 && norm) {
            return { qty: roundQty(val * norm.mult), unit: norm.unit };
        }
    }

    // 3. Count: "30 יח'"
    m = text.match(_UP_COUNT_RE);
    if (m) {
        const val = parseFloat(m[1]);
        if (val > 0) return { qty: roundQty(val), unit: 'unit' };
    }

    return null;
}

/**
 * Compute and format unit price as `"₪X.XX ל-100 גרם"`, `"₪X.XX ל-100 מ\"ל"`, or `"₪X.XX ליח'"`.
 * Returns `""` if `!(unitPrice > 0)` or unit cannot be determined.
 */
function formatUnitPrice(unitPrice, name, dbQty, dbUnit) {
    const price = Number(unitPrice);
    if (!(price > 0) || !Number.isFinite(price)) return '';

    let info = null;
    const nDbQty = Number(dbQty);
    if (nDbQty > 0 && Number.isFinite(nDbQty) && dbUnit) {
        const norm = _normalizeUnitToken(dbUnit);
        if (norm) info = { qty: nDbQty * norm.mult, unit: norm.unit };
    }
    if (!info) info = parseUnitInfo(name);
    if (!info || !(info.qty > 0)) return '';

    if (info.unit === 'g') {
        const per100 = (price / info.qty) * 100;
        return `₪${per100.toFixed(2)} ל-100 גרם`;
    }
    if (info.unit === 'ml') {
        const per100 = (price / info.qty) * 100;
        return `₪${per100.toFixed(2)} ל-100 מ"ל`;
    }
    if (info.unit === 'unit') {
        const perUnit = price / info.qty;
        return `₪${perUnit.toFixed(2)} ליח'`;
    }
    return '';
}

function _isCompatiblePackSize(baseInfo, candidateInfo) {
    if (!baseInfo || !candidateInfo) return true;
    if (baseInfo.unit !== candidateInfo.unit) return false;
    const diffRatio = Math.abs(candidateInfo.qty - baseInfo.qty) / baseInfo.qty;
    return diffRatio <= 0.25;
}

/**
 * Find up to 5 outlier deep deals where the cheapest store's line price is at least 25% cheaper
 * AND at least ₪6 cheaper than the second-cheapest store's price for the same product.
 * Excludes substitutes with incompatible pack sizes (>25% size difference or different unit).
 */
function detectOutlierDeals(itemsMatrix, storeNames = {}) {
    if (!Array.isArray(itemsMatrix) || itemsMatrix.length === 0) return [];
    const deals = [];

    for (const item of itemsMatrix) {
        if (!item || !item.prices || typeof item.prices !== 'object') continue;
        const baseInfo = (item.unitInfo && item.unitInfo.qty > 0 && item.unitInfo.unit)
            ? item.unitInfo
            : parseUnitInfo(item.name);

        const entries = [];
        for (const [store, rawPrice] of Object.entries(item.prices)) {
            const price = Number(rawPrice);
            if (!(price > 0) || !Number.isFinite(price)) continue;

            // Exclude substitutes whose pack size differs incompatibly from the original product
            const subName = item.subNames && item.subNames[store];
            const storeUnit = item.unitInfos && item.unitInfos[store];
            const candInfo = storeUnit || (subName ? parseUnitInfo(subName) : null);
            if ((subName || storeUnit) && !_isCompatiblePackSize(baseInfo, candInfo)) continue;

            entries.push({ store, price });
        }

        if (entries.length < 2) continue;
        entries.sort((a, b) => a.price - b.price);

        const best = entries[0];
        const ref = entries[1];
        const saving = Math.round((ref.price - best.price) * 100) / 100;
        const ratio = (ref.price - best.price) / ref.price;

        if (saving >= 6 && ratio >= 0.25 - 1e-9) {
            deals.push({
                name: item.name || '',
                bestStore: best.store,
                bestStoreName: (storeNames && storeNames[best.store]) || best.store,
                bestPrice: Math.round(best.price * 100) / 100,
                refPrice: Math.round(ref.price * 100) / 100,
                saving,
                pct: Math.round(ratio * 100)
            });
        }
    }

    deals.sort((a, b) => b.saving - a.saving);
    return deals.slice(0, 5);
}

const _FINAL_LETTERS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const _SPICE_GUARDS = new Set(['שחור', 'לבן', 'אנגלי', 'גרוס', 'טחון', 'קאיין', 'חריף']);

function _normHeText(str) {
    return String(str || '')
        .replace(/[\u0591-\u05C7]/g, '')
        .replace(/["״''׳\-/,.()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function _stemHeToken(tok) {
    if (tok.length < 3) return tok;
    let s = tok;
    if (s.length >= 4 && (s.endsWith('ים') || s.endsWith('ות'))) {
        s = s.slice(0, -2);
    } else if (s.length >= 4 && s.endsWith('יה')) {
        s = s.slice(0, -1);
    } else if (s.length >= 4 && s.endsWith('ה')) {
        s = s.slice(0, -1);
    }
    const last = s.slice(-1);
    if (_FINAL_LETTERS[last]) s = s.slice(0, -1) + _FINAL_LETTERS[last];
    return s;
}

function _heTokensMatch(rawTokens, candTokens) {
    if (!candTokens.length || candTokens.length > rawTokens.length) return 0;
    let exactHits = 0;
    for (const ct of candTokens) {
        if (rawTokens.includes(ct)) {
            exactHits++;
            continue;
        }
        const cStem = _stemHeToken(ct);
        const foundStem = rawTokens.some(rt => _stemHeToken(rt) === cStem && cStem.length >= 3);
        if (!foundStem) return 0;
    }
    return exactHits === candTokens.length ? 2 : 1;
}

/**
 * Match unbarcoded/weighed produce & meat items against `weighed_staples` rows
 * (`{ staple_key, canonical_he, aliases, search_query, unit_type }`) by exact, prefix, or token match.
 */
function matchWeighedStaple(rawName, staples) {
    const nRaw = _normHeText(rawName);
    if (!nRaw || !Array.isArray(staples) || staples.length === 0) return null;

    const rawTokens = nRaw.split(' ').filter(Boolean);
    let bestMatch = null;
    let bestScore = 0;

    for (const staple of staples) {
        if (!staple) continue;
        const terms = [staple.canonical_he, ...(Array.isArray(staple.aliases) ? staple.aliases : [])].filter(Boolean);
        for (const term of terms) {
            const nCand = _normHeText(term);
            if (!nCand) continue;
            const candTokens = nCand.split(' ').filter(Boolean);

            // Guard single-token produce like "פלפל" from matching spices ("פלפל שחור")
            if (candTokens.length === 1 && candTokens[0] === 'פלפל' && rawTokens.some(t => _SPICE_GUARDS.has(t))) {
                continue;
            }

            let score = 0;
            if (nRaw === nCand) {
                score = 1000 + nCand.length;
            } else if (nRaw.startsWith(nCand + ' ') || nCand.startsWith(nRaw + ' ')) {
                score = 700 + Math.min(nRaw.length, nCand.length);
            } else {
                const tokMatch = _heTokensMatch(rawTokens, candTokens);
                if (tokMatch === 2) score = 500 + nCand.length;
                else if (tokMatch === 1) score = 400 + nCand.length;
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = staple;
            }
        }
    }

    return bestMatch;
}

if (typeof module !== 'undefined') {
    module.exports = { parseUnitInfo, formatUnitPrice, detectOutlierDeals, matchWeighedStaple };
}
