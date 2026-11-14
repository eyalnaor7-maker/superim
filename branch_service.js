// branch_service.js

const API_ENDPOINTS = {
    victory: 'https://api.victoryonline.co.il/api/web/branches',
    machsanei_hashuk: 'https://www.mck.co.il/v2/retailers/1107/branches?appId=4'
};

/**
 * מביא רשימת סניפים מויקטורי או מחסני השוק
 */
async function fetchBranchesGeneric(network) {
    try {
        const url = API_ENDPOINTS[network];
        if (!url) return [];
        
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const json = await response.json();
        // Victory's new API wraps everything in {status, data}
        const data = network === 'victory' ? (json?.status === 'success' && Array.isArray(json.data) ? json.data : [])
            : (Array.isArray(json) ? json : (json?.branches || [])); // Machsanei HaShuk wraps the list in {branches}

        // ממפה את התשובה לפורמט אחיד
        return data.map(b => ({
            id: b.id.toString(),
            name: b.name,
            city: network === 'victory' ? cityFromAddress(b.address, b.name) : (b.city || b.name || ''),
            address: b.address || b.location || '',
            areas: (b.areas || []).map(a => a.name).join(', '), // delivery areas, so a city the branch delivers to finds it
            network: network
        }));
    } catch (error) {
        console.error(`Error fetching branches for ${network}:`, error);
        return [];
    }
}

/**
 * מביא סניפים משופרסל (באמצעות קריאת API דמוית שופרסל)
 * מבוסס על מבנה JSON שנמצא בחקירה
 */
async function fetchShufersalBranches() {
    try {
        // כרגע אנו משתמשים במידע שהתגלה בחקירה (הארד-קוד זמני עד שיהיה לנו את ה-URL המדויק)
        return [
            { id: "876", name: "ליקוט אתר מפיץ-באר שבע", city: "באר שבע", address: "", network: "shufersal" },
            { id: "737", name: "המפיץ סיטונאות באר שבע", city: "באר שבע", address: "סולל בונה 2", network: "shufersal" },
            { id: "222", name: "דיל רמות באר שבע ב'", city: "באר שבע", address: "הערים התאומות 28", network: "shufersal" },
            { id: "248", name: "דיל באר שבע- נווה מנחם", city: "באר שבע", address: "החשמונאים 15", network: "shufersal" },
            { id: "110", name: "דיל הפארק באר שבע", city: "באר שבע", address: "נחל פרת 20", network: "shufersal" },
            { id: "83", name: "דיל באר שבע- שאול המלך", city: "באר שבע", address: "קניון שאול המלך", network: "shufersal" },
            { id: "65", name: "דיל באר שבע - צ'ורלי", city: "באר שבע", address: "האורגים 1", network: "shufersal" },
            { id: "49", name: "דיל באר שבע- הר בוקר", city: "באר שבע", address: "הר בוקר 17", network: "shufersal" }
        ];
    } catch (e) {
        console.error("Error with Shufersal branches", e);
        return [];
    }
}

/**
 * מביא סניפים עבור רמי לוי.
 * לפי החקירה, אנו יודעים שהסניף שמור תחת store_id (למשל '82') ושהבקשות דורשות טוקן אישי.
 * כאן נציב רשימה חלקית בתור fallback, אבל בפועל הסקריפט משתמש במה ששמור בעגלה של המשתמש.
 */
async function fetchRamiLevyBranches() {
    return [
        { id: "82", name: "סניף באר שבע (משלוחים)", city: "באר שבע", address: "רמי לוי", network: "rami_levy" },
        { id: "331", name: "ביג באר שבע", city: "באר שבע", address: "דרך חברון 29", network: "rami_levy" },
        { id: "332", name: "נווה זאב באר שבע", city: "באר שבע", address: "יוהנה ז'בוטינסקי", network: "rami_levy" }
    ];
}

// The official city list and the chains' own data spell things differently ("קריית"/"קרית", hyphens, quote marks).
function normCity(s) {
    return String(s || '').replace(/קריית/g, 'קרית').replace(/["'׳״-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Cities that start with what was typed, for the city input's suggestion list.
function citySuggestions(cities, typed) {
    const t = normCity(typed);
    return t ? cities.filter(c => normCity(c).startsWith(t)) : [];
}

// Branches whose city, address, name or delivery areas mention the city. No city means no filter.
function branchesInCity(branches, city) {
    const t = normCity(String(city || '').split(' - ')[0]);
    return t ? branches.filter(b => [b.city, b.address, b.name, b.areas].some(f => normCity(f).includes(t))) : branches;
}

async function getAllBranches() {
    const [victory, mck, shufersal, ramiLevy] = await Promise.all([
        fetchBranchesGeneric('victory'),
        fetchBranchesGeneric('machsanei_hashuk'),
        fetchShufersalBranches(),
        fetchRamiLevyBranches()
    ]);
    
    return [...victory, ...mck, ...shufersal, ...ramiLevy];
}

// לשימוש בתוך התוסף (Chrome Extension)
if (typeof window !== 'undefined') {
    window.branchService = {
        getAllBranches
    };
}

if (typeof module !== 'undefined') module.exports = { normCity, citySuggestions, branchesInCity };
