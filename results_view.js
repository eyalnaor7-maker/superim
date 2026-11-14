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

function renderStoreSummary({ orderedStores, sortable, activeStore }) {
    const winner = sortable[0];
    const active = sortable.find(s => s.key === activeStore);
    const saving = winner && active ? active.total - winner.total : 0;

    let hero;
    if (!winner) {
        hero = `<div class="lbl">לא נמצאו מחירים</div>`;
    } else if (active && saving > 0.01) {
        const pct = Math.round(saving / active.total * 100);
        hero = `<div class="lbl">החיסכון שלך בעגלה הזו</div><div class="big num">${rvMoney(saving)}</div>` +
            `<span class="pill">${pct}% פחות מ${_rvEsc(active.name)}</span>`;
    } else {
        hero = `<div class="lbl">${active ? 'העגלה שלך כבר הכי זולה' : 'הרשת הזולה ביותר'}</div><div class="big num">${rvMoney((active || winner).total)}</div>`;
    }

    let html = `<div class="hero"><div class="top"><span class="brand"><svg class="ic"><use href="#i-cart"/></svg>השוואת עגלות</span></div>${hero}</div>`;

    if (winner) {
        const cta = winner.key === activeStore ? '' :
            `<button class="cta" id="${RV_SWITCH[winner.key].id}">לבנות את העגלה ב${_rvEsc(winner.name)} ←</button>`;
        html += `<div class="win"><div class="row">${rvAvatar(winner)}<div class="grow"><b>${_rvEsc(winner.name)}</b>` +
            `<div class="sub">${winner.info}</div></div><b class="num tot">${rvMoney(winner.total)}</b></div>${cta}</div>`;
    }

    html += '<div class="list">';
    orderedStores.filter(s => s !== winner).forEach(s => {
        const sw = RV_SWITCH[s.key];
        const isActive = s.key === activeStore;
        const sub = s.hasData
            ? `<div class="sub">${isActive ? 'העגלה הנוכחית שלך' : s.info}</div>`
            : `<div class="warn">${_rvEsc(s.debugInfo || 'ממתין לנתונים...')}</div>`;
        const end = s.hasData
            ? `<b class="num">${rvMoney(s.total)}</b><div class="diff num" dir="ltr">+${rvMoney(s.total - winner.total)}</div>`
            : '';
        const btn = isActive ? '' : `<button class="mini" id="${sw.id}">${s.hasData ? sw.go : sw.pick}</button>`;
        html += `<div class="row">${rvAvatar(s)}<div class="grow"><b>${_rvEsc(s.name)}</b>${sub}</div>` +
            `<div class="end">${end}${btn}</div></div>`;
    });
    return html + '<div class="row"><button class="mini" id="compareAgain">להשוות שוב</button></div></div>';
}

if (typeof module !== 'undefined') module.exports = { renderStoreSummary };
