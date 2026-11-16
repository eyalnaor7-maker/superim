// Pure view: builds the store-summary markup for the popup results screen.
const _rvEsc = typeof module !== 'undefined' ? require('./safe_html.js').esc : esc;

const RV_COLORS = { shufersal: '#e11d48', ramiLevy: '#2563eb', victory: '#f97316', machsaneiHashuk: '#7c3aed' };
const RV_SWITCH = {
    shufersal: { id: 'switchToShufersal', go: 'עבור לשופרסל', pick: 'עבור לשופרסל' },
    ramiLevy: { id: 'switchToRamiLevy', go: 'עבור לרמי לוי', pick: 'עבור לרמי לוי' },
    victory: { id: 'switchToVictory', go: 'עבור לויקטורי', pick: 'בחר ויקטורי' },
    machsaneiHashuk: { id: 'switchToMCK', go: 'עבור למחסני השוק', pick: 'בחר מחסני השוק' }
};

const rvMoney = n => `₪${Number(n).toFixed(2)}`;
const rvAvatar = s => `<span class="av" style="--c:${RV_COLORS[s.key] || '#64748b'}">${_rvEsc(String(s.name || '').charAt(0))}</span>`;

// delivery = the fee the chain itself gave (0 = free). deliveryEst = stand-in for a chain that gave none:
// the highest fee among the others, so a chain is never crowned cheapest just because its fee is unknown.
const rvDelivery = s => s.delivery ?? s.deliveryEst ?? 0;
const rvShownTotal = s => s.total + rvDelivery(s);
const rvCompareTotal = s => rvShownTotal(s) + (s.gap || 0);
function rvDeliveryLine(s) {
    if (s.delivery == null && s.deliveryEst == null) return '<div class="sub">לא כולל דמי משלוח</div>';
    const text = s.delivery == null ? `כולל הערכת דמי משלוח ${rvMoney(s.deliveryEst)} (הרשת לא מסרה מחיר)`
        : s.delivery === 0 ? 'כולל משלוח חינם' : `כולל דמי משלוח ${rvMoney(s.delivery)}`;
    return `<div class="sub">${text}${s.deliveryNote ? ' · ' + _rvEsc(s.deliveryNote) : ''}</div>`;
}

function renderStoreSummary({ orderedStores, sortable, activeStore, savedLabel }) {
    // gap = what the shopper pays today for the products this store lacks. Adding it compares like with like:
    // a store that has 1 of 3 products is not "98% cheaper".
    const cmp = rvCompareTotal;
    const winner = sortable[0];
    const active = sortable.find(s => s.key === activeStore);
    const saving = winner && active ? cmp(active) - cmp(winner) : 0;
    const withDelivery = sortable.some(s => s.delivery != null || s.deliveryEst != null);

    let hero;
    if (!winner) {
        hero = `<div class="lbl">לא נמצאו מחירים</div>`;
    } else if (active && saving > 0.01) {
        const pct = Math.round(saving / rvShownTotal(active) * 100);
        hero = `<div class="lbl">החיסכון שלך בעגלה הזו${withDelivery ? ', כולל דמי משלוח' : ''}</div><div class="big num">${rvMoney(saving)}</div>` +
            (pct >= 1 ? `<span class="pill">${pct}% פחות מ${_rvEsc(active.name)}</span>` : '');
    } else {
        hero = `<div class="lbl">${active ? 'העגלה שלך כבר הכי זולה' : (savedLabel ? `הכי זול עכשיו לסל השמור (${_rvEsc(savedLabel)})` : 'הרשת הזולה ביותר')}</div><div class="big num">${rvMoney(rvShownTotal(active || winner))}</div>`;
    }

    let html = `<div class="hero"><div class="top"><span class="brand"><svg class="ic"><use href="#i-cart"/></svg>השוואת עגלות</span></div>${hero}</div>`;

    if (winner) {
        const cta = winner.key === activeStore ? '' :
            `<button class="cta" id="${RV_SWITCH[winner.key].id}">לבנות את העגלה ב${_rvEsc(winner.name)} ←</button>`;
        html += `<div class="win"><div class="row">${rvAvatar(winner)}<div class="grow"><b>${_rvEsc(winner.name)}</b>` +
            `<div class="sub">${winner.info}</div>${rvDeliveryLine(winner)}</div><b class="num tot">${rvMoney(rvShownTotal(winner))}</b></div>${cta}</div>`;
    }

    html += '<div class="list">';
    orderedStores.filter(s => s !== winner).forEach(s => {
        const sw = RV_SWITCH[s.key];
        const isActive = s.key === activeStore;
        const sub = s.hasData
            ? `<div class="sub">${isActive ? 'העגלה הנוכחית שלך' : s.info}</div>${rvDeliveryLine(s)}`
            : `<div class="warn">${_rvEsc(s.debugInfo || 'לא נמצאו מחירים למוצרים בעגלה')}</div>`;
        const end = s.hasData
            ? `<b class="num">${rvMoney(rvShownTotal(s))}</b><div class="diff num" dir="ltr">+${rvMoney(cmp(s) - cmp(winner))}</div>`
            : '';
        const btn = isActive ? '' : `<button class="mini" id="${sw.id}">${s.hasData ? sw.go : sw.pick}</button>`;
        html += `<div class="row">${rvAvatar(s)}<div class="grow"><b>${_rvEsc(s.name)}</b>${sub}</div>` +
            `<div class="end">${end}${btn}</div></div>`;
    });
    return html + '<div class="row"><button class="mini" id="compareAgain">להשוות שוב</button></div></div>';
}

const RV_NAMES = { shufersal: 'שופרסל', ramiLevy: 'רמי לוי', victory: 'ויקטורי', machsaneiHashuk: 'מחסני השוק' };

// Saved carts: newest first, at most 20. Comparing the same cart again replaces its entry instead of adding one.
function addToHistory(list, entry) {
    const sig = e => e.store + '|' + (e.items || []).map(i => `${i.code || i.shufersal_code}x${i.quantity}`).sort().join(',');
    return [entry, ...(list || []).filter(e => sig(e) !== sig(entry))].slice(0, 20);
}

// One card per saved cart: when and where it was put together. Opening a card lists its products and offers
// "compare now" (live prices in every chain, nothing is built) or building it straight at a chain.
function renderHistory(list) {
    let html = `<div class="hero s"><div class="top"><span class="brand"><svg class="ic"><use href="#i-cart"/></svg>השוואת עגלות</span></div>` +
        `<div class="big">הסלים שלי</div></div><div class="list">`;
    if (!list.length) html += `<div class="sub c">עוד אין סלים שמורים. כל השוואה נשמרת כאן אוטומטית, במחשב הזה בלבד.</div>`;
    list.forEach((e, i) => {
        const when = new Date(e.at);
        const date = when.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: '2-digit' });
        const time = when.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        const items = e.raw || e.items || [];
        const count = items.length === 1 ? 'מוצר אחד' : items.length + ' מוצרים';
        const best = Object.entries(e.totals || {}).sort((a, b) => a[1] - b[1])[0];
        html += `<div class="hist"><button type="button" class="hist-head" aria-expanded="false" aria-controls="hist-${i}" data-toggle="${i}">` +
            rvAvatar({ key: e.store, name: RV_NAMES[e.store] || '?' }) +
            `<span class="grow"><b>${_rvEsc(date)}, ${_rvEsc(time)}</b><span class="sub">הורכב ב${_rvEsc(RV_NAMES[e.store] || '')} · ${count}</span></span>` +
            `<span class="toggle-arrow" aria-hidden="true">▼</span></button>` +
            `<div class="hist-body" id="hist-${i}" hidden><ul class="hist-items">` +
            items.map(it => `<li><span>${_rvEsc(it.name || 'מוצר')}</span><span class="num">x${_rvEsc(it.quantity)}</span></li>`).join('') + `</ul>` +
            (best ? `<div class="sub">בהשוואה ההיא הכי זול היה ב${_rvEsc(RV_NAMES[best[0]] || '')}: <span class="num">${rvMoney(best[1])}</span></div>` : '') +
            (e.raw ? `<button type="button" class="cta" data-restore="${i}">להשוות את הסל הזה עכשיו</button>` : '') +
            `<div class="btns"><span>או לבנות אותו ישר ב:</span>` +
            Object.keys(RV_NAMES).map(k => `<button type="button" class="mini" data-build="${k}" data-i="${i}">${RV_NAMES[k]}</button>`).join('') +
            `</div></div></div>`;
    });
    return html + `<div class="row"><button type="button" class="mini" id="historyBack">חזרה</button>` +
        (list.length ? `<button type="button" class="mini" id="historyClear">מחיקת כל הסלים</button>` : '') + `</div></div>`;
}

if (typeof module !== 'undefined') module.exports = { renderStoreSummary, addToHistory, renderHistory, rvCompareTotal, rvShownTotal };
