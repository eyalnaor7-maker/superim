// branch_service.js

const API_ENDPOINTS = {
    victory: 'https://api.victoryonline.co.il/api/web/branches',
    machsanei_hashuk: 'https://www.mck.co.il/v2/retailers/1107/branches?appId=4',
    rami_levy: 'https://www.rami-levy.co.il/api/v2/site/stores'
};

const SHUFERSAL_BRANCHES = [
    // באר שבע (נשמרו המזהים הקיימים)
    { id: "876", name: "ליקוט אתר מפיץ-באר שבע", city: "באר שבע", address: "", areas: "באר שבע, עומר, להבים, מיתר", network: "shufersal" },
    { id: "737", name: "המפיץ סיטונאות באר שבע", city: "באר שבע", address: "סולל בונה 2", areas: "באר שבע", network: "shufersal" },
    { id: "222", name: "דיל רמות באר שבע ב'", city: "באר שבע", address: "הערים התאומות 28", areas: "באר שבע", network: "shufersal" },
    { id: "248", name: "דיל באר שבע- נווה מנחם", city: "באר שבע", address: "החשמונאים 15", areas: "באר שבע", network: "shufersal" },
    { id: "110", name: "דיל הפארק באר שבע", city: "באר שבע", address: "נחל פרת 20", areas: "באר שבע", network: "shufersal" },
    { id: "83", name: "דיל באר שבע- שאול המלך", city: "באר שבע", address: "קניון שאול המלך", areas: "באר שבע", network: "shufersal" },
    { id: "65", name: "דיל באר שבע - צ'ורלי", city: "באר שבע", address: "האורגים 1", areas: "באר שבע", network: "shufersal" },
    { id: "49", name: "דיל באר שבע- הר בוקר", city: "באר שבע", address: "הר בוקר 17", areas: "באר שבע", network: "shufersal" },
    // מרכז וגוש דן
    { id: "413", name: "שופרסל אונליין תל אביב - מרכז", city: "תל אביב - יפו", address: "יגאל אלון 94", areas: "תל אביב - יפו, גבעתיים, רמת גן", network: "shufersal" },
    { id: "267", name: "שופרסל דיל יגאל אלון תל אביב", city: "תל אביב - יפו", address: "יגאל אלון 123", areas: "תל אביב - יפו", network: "shufersal" },
    { id: "252", name: "שופרסל דיל רמת אביב", city: "תל אביב - יפו", address: "ברודצקי 43", areas: "תל אביב - יפו", network: "shufersal" },
    { id: "139", name: "שופרסל דיל רמת גן - איילון", city: "רמת גן", address: "ששת הימים 2", areas: "רמת גן, בני ברק, גבעתיים", network: "shufersal" },
    { id: "145", name: "שופרסל שלי גבעתיים", city: "גבעתיים", address: "ויצמן 71", areas: "גבעתיים", network: "shufersal" },
    { id: "194", name: "שופרסל דיל בני ברק", city: "בני ברק", address: "הירקון 2", areas: "בני ברק", network: "shufersal" },
    { id: "102", name: "שופרסל דיל פתח תקווה - סגולה", city: "פתח תקווה", address: "אבי אורן 2", areas: "פתח תקווה, גבעת שמואל, קרית אונו", network: "shufersal" },
    { id: "312", name: "שופרסל דיל פתח תקווה - אם המושבות", city: "פתח תקווה", address: "זבולון המר 3", areas: "פתח תקווה", network: "shufersal" },
    { id: "178", name: "שופרסל דיל ראשון לציון - מערב", city: "ראשון לציון", address: "ילדי טהרן 5", areas: "ראשון לציון, נס ציונה", network: "shufersal" },
    { id: "205", name: "שופרסל דיל ראשון לציון - ראשונים", city: "ראשון לציון", address: "הרצל 132", areas: "ראשון לציון", network: "shufersal" },
    { id: "160", name: "שופרסל דיל חולון", city: "חולון", address: "גולדה מאיר 7", areas: "חולון, אזור", network: "shufersal" },
    { id: "161", name: "שופרסל דיל בת ים", city: "בת ים", address: "הקוממיות 18", areas: "בת ים", network: "shufersal" },
    { id: "184", name: "שופרסל דיל רחובות", city: "רחובות", address: "בילו 2", areas: "רחובות, נס ציונה, מזכרת בתיה", network: "shufersal" },
    { id: "281", name: "שופרסל שלי נס ציונה", city: "נס ציונה", address: "ויצמן 14", areas: "נס ציונה", network: "shufersal" },
    { id: "340", name: "שופרסל דיל מודיעין", city: "מודיעין-מכבים-רעות", address: "השדרה המרכזית 15", areas: "מודיעין-מכבים-רעות, מודיעין, שוהם", network: "shufersal" },
    { id: "215", name: "שופרסל דיל לוד", city: "לוד", address: "אהרון שוורץ 1", areas: "לוד, רמלה", network: "shufersal" },
    { id: "216", name: "שופרסל דיל רמלה", city: "רמלה", address: "דוד רזיאל 1", areas: "רמלה, לוד, באר יעקב", network: "shufersal" },
    { id: "298", name: "שופרסל דיל ראש העין", city: "ראש העין", address: "יהודה הלוי 1", areas: "ראש העין", network: "shufersal" },
    // שרון
    { id: "150", name: "שופרסל דיל נתניה - פולג", city: "נתניה", address: "גיבורי ישראל 17", areas: "נתניה, אבן יהודה", network: "shufersal" },
    { id: "151", name: "שופרסל דיל נתניה - מרכז", city: "נתניה", address: "הרצל 60", areas: "נתניה", network: "shufersal" },
    { id: "120", name: "שופרסל דיל כפר סבא", city: "כפר סבא", address: "עתיר ידע 4", areas: "כפר סבא, הוד השרון", network: "shufersal" },
    { id: "121", name: "שופרסל דיל רעננה", city: "רעננה", address: "החרושת 2", areas: "רעננה", network: "shufersal" },
    { id: "122", name: "שופרסל דיל הרצליה", city: "הרצליה", address: "שבעת הכוכבים 8", areas: "הרצליה, רמת השרון", network: "shufersal" },
    { id: "274", name: "שופרסל שלי הוד השרון", city: "הוד השרון", address: "דרך רמתיים 58", areas: "הוד השרון", network: "shufersal" },
    { id: "230", name: "שופרסל דיל חדרה", city: "חדרה", address: "הרברט סמואל 85", areas: "חדרה, אור עקיבא, קיסריה", network: "shufersal" },
    { id: "232", name: "שופרסל דיל פרדס חנה-כרכור", city: "פרדס חנה-כרכור", address: "דרך הבנים 1", areas: "פרדס חנה-כרכור, פרדס חנה, כרכור", network: "shufersal" },
    // ירושלים והסביבה
    { id: "30", name: "שופרסל דיל ירושלים - תלפיות", city: "ירושלים", address: "האומן 17", areas: "ירושלים, מבשרת ציון, מעלה אדומים", network: "shufersal" },
    { id: "35", name: "שופרסל דיל ירושלים - גבעת שאול", city: "ירושלים", address: "כנפי נשרים 22", areas: "ירושלים", network: "shufersal" },
    { id: "38", name: "שופרסל דיל ירושלים - מלחה", city: "ירושלים", address: "דרך אגודת הספורט בית\"ר 1", areas: "ירושלים", network: "shufersal" },
    { id: "318", name: "שופרסל דיל בית שמש", city: "בית שמש", address: "שדרות יגאל אלון 1", areas: "בית שמש", network: "shufersal" },
    // צפון וחיפה
    { id: "52", name: "שופרסל דיל חיפה - חוצות המפרץ", city: "חיפה", address: "שדרות ההסתדרות 205", areas: "חיפה, נשר, טירת כרמל", network: "shufersal" },
    { id: "55", name: "שופרסל דיל חיפה - נשר", city: "חיפה", address: "בר יהודה 147", areas: "חיפה, נשר", network: "shufersal" },
    { id: "58", name: "שופרסל דיל קריות - קרית ביאליק", city: "קרית ביאליק", address: "העקום 1 (קריון)", areas: "קרית ביאליק, קרית מוצקין, קרית אתא, קרית ים", network: "shufersal" },
    { id: "240", name: "שופרסל דיל נהריה", city: "נהריה", address: "לוחמי הגטאות 30", areas: "נהריה, עכו, שלומי", network: "shufersal" },
    { id: "242", name: "שופרסל דיל כרמיאל", city: "כרמיאל", address: "מעלה כמון 2", areas: "כרמיאל", network: "shufersal" },
    { id: "244", name: "שופרסל דיל עפולה", city: "עפולה", address: "קהילת ציון 30", areas: "עפולה, מגדל העמק, נוף הגליל", network: "shufersal" },
    { id: "246", name: "שופרסל דיל טבריה", city: "טבריה", address: "יהודה הלוי 1", areas: "טבריה", network: "shufersal" },
    { id: "249", name: "שופרסל דיל קרית שמונה", city: "קרית שמונה", address: "שדרות תל חי 95", areas: "קרית שמונה", network: "shufersal" },
    // דרום ושפלה
    { id: "90", name: "שופרסל דיל אשדוד - סטאר סנטר", city: "אשדוד", address: "ז'בוטינסקי 45", areas: "אשדוד, גן יבנה", network: "shufersal" },
    { id: "94", name: "שופרסל דיל אשקלון", city: "אשקלון", address: "הגבורה 10", areas: "אשקלון", network: "shufersal" },
    { id: "261", name: "שופרסל דיל יבנה", city: "יבנה", address: "השדרות 2", areas: "יבנה", network: "shufersal" },
    { id: "263", name: "שופרסל דיל קרית גת", city: "קרית גת", address: "מלכי ישראל 178", areas: "קרית גת", network: "shufersal" },
    { id: "265", name: "שופרסל דיל שדרות", city: "שדרות", address: "הנביאים 2", areas: "שדרות, נתיבות, אופקים", network: "shufersal" },
    { id: "290", name: "שופרסל דיל אילת", city: "אילת", address: "חטיבת גולני 1", areas: "אילת", network: "shufersal" }
];

const RAMI_LEVY_FALLBACK_BRANCHES = [
    // באר שבע והדרום (נשמרו המזהים 82, 331, 332)
    { id: "82", name: "סניף באר שבע (משלוחים)", city: "באר שבע", address: "רמי לוי", areas: "באר שבע, עומר, להבים, מיתר", network: "rami_levy" },
    { id: "331", name: "רמי לוי ביג באר שבע", city: "באר שבע", address: "דרך חברון 29", areas: "באר שבע", network: "rami_levy" },
    { id: "332", name: "רמי לוי נווה זאב באר שבע", city: "באר שבע", address: "יוהנה ז'בוטינסקי", areas: "באר שבע", network: "rami_levy" },
    { id: "39", name: "רמי לוי תלפיות ירושלים", city: "ירושלים", address: "האומן 15", areas: "ירושלים, מבשרת ציון, מעלה אדומים", network: "rami_levy" },
    { id: "41", name: "רמי לוי גבעת שאול ירושלים", city: "ירושלים", address: "כנפי נשרים 26", areas: "ירושלים", network: "rami_levy" },
    { id: "43", name: "רמי לוי פסגת זאב ירושלים", city: "ירושלים", address: "משה דיין 158", areas: "ירושלים", network: "rami_levy" },
    { id: "47", name: "רמי לוי עטרות ירושלים", city: "ירושלים", address: "אזור תעשייה עטרות", areas: "ירושלים", network: "rami_levy" },
    { id: "18", name: "רמי לוי תל אביב - אונליין", city: "תל אביב - יפו", address: "דרך בגין 132", areas: "תל אביב - יפו, גבעתיים", network: "rami_levy" },
    { id: "301", name: "רמי לוי רמת גן - איילון", city: "רמת גן", address: "אבא הלל 301", areas: "רמת גן, גבעתיים", network: "rami_levy" },
    { id: "21", name: "רמי לוי בני ברק", city: "בני ברק", address: "אלישע 1", areas: "בני ברק, רמת גן", network: "rami_levy" },
    { id: "14", name: "רמי לוי פתח תקווה", city: "פתח תקווה", address: "קריית אריה, גיסין 68", areas: "פתח תקווה, גבעת שמואל", network: "rami_levy" },
    { id: "23", name: "רמי לוי ראש העין", city: "ראש העין", address: "המלאכה 1", areas: "ראש העין", network: "rami_levy" },
    { id: "15", name: "רמי לוי ראשון לציון", city: "ראשון לציון", address: "משה שרת 16", areas: "ראשון לציון, נס ציונה", network: "rami_levy" },
    { id: "58", name: "רמי לוי חולון", city: "חולון", address: "המרכבה 38", areas: "חולון, אזור", network: "rami_levy" },
    { id: "59", name: "רמי לוי בת ים", city: "בת ים", address: "הרב ניסנבאום 37", areas: "בת ים", network: "rami_levy" },
    { id: "28", name: "רמי לוי רחובות", city: "רחובות", address: "הרצל 102", areas: "רחובות, נס ציונה", network: "rami_levy" },
    { id: "31", name: "רמי לוי מודיעין (שילת)", city: "מודיעין-מכבים-רעות", address: "צומת שילת", areas: "מודיעין-מכבים-רעות, מודיעין, שילת", network: "rami_levy" },
    { id: "64", name: "רמי לוי מודיעין עילית", city: "מודיעין עילית", address: "שדרות אביי ורבא 1", areas: "מודיעין עילית", network: "rami_levy" },
    { id: "34", name: "רמי לוי לוד", city: "לוד", address: "החשמונאים 1", areas: "לוד", network: "rami_levy" },
    { id: "35", name: "רמי לוי רמלה", city: "רמלה", address: "תל חי 2", areas: "רמלה, באר יעקב", network: "rami_levy" },
    { id: "11", name: "רמי לוי נתניה", city: "נתניה", address: "המחקר 2", areas: "נתניה, אבן יהודה", network: "rami_levy" },
    { id: "16", name: "רמי לוי כפר סבא", city: "כפר סבא", address: "התעש 24", areas: "כפר סבא, הוד השרון", network: "rami_levy" },
    { id: "17", name: "רמי לוי רעננה", city: "רעננה", address: "היצירה 11", areas: "רעננה", network: "rami_levy" },
    { id: "62", name: "רמי לוי הרצליה", city: "הרצליה", address: "משכית 32", areas: "הרצליה, רמת השרון", network: "rami_levy" },
    { id: "25", name: "רמי לוי חדרה", city: "חדרה", address: "השלום 2", areas: "חדרה, אור עקיבא", network: "rami_levy" },
    { id: "44", name: "רמי לוי פרדס חנה-כרכור", city: "פרדס חנה-כרכור", address: "העמל 12", areas: "פרדס חנה-כרכור, פרדס חנה, כרכור", network: "rami_levy" },
    { id: "19", name: "רמי לוי חיפה - מת\"ם / צ'ק פוסט", city: "חיפה", address: "שדרות ההסתדרות 76", areas: "חיפה, נשר, טירת כרמל", network: "rami_levy" },
    { id: "20", name: "רמי לוי קריות - קרית ביאליק", city: "קרית ביאליק", address: "דרך עכו 192", areas: "קרית ביאליק, קרית מוצקין, קרית אתא, קרית ים", network: "rami_levy" },
    { id: "22", name: "רמי לוי עפולה", city: "עפולה", address: "יהושע חנקין 14", areas: "עפולה, מגדל העמק", network: "rami_levy" },
    { id: "24", name: "רמי לוי טבריה", city: "טבריה", address: "הגליל 1", areas: "טבריה", network: "rami_levy" },
    { id: "26", name: "רמי לוי כרמיאל", city: "כרמיאל", address: "הנפח 4", areas: "כרמיאל", network: "rami_levy" },
    { id: "27", name: "רמי לוי נהריה", city: "נהריה", address: "היצירה 6", areas: "נהריה, עכו", network: "rami_levy" },
    { id: "36", name: "רמי לוי בית שמש", city: "בית שמש", address: "העמל 5", areas: "בית שמש", network: "rami_levy" },
    { id: "29", name: "רמי לוי אשדוד", city: "אשדוד", address: "הבנאים 10", areas: "אשדוד, גן יבנה", network: "rami_levy" },
    { id: "30", name: "רמי לוי אשקלון", city: "אשקלון", address: "הפלדה 5", areas: "אשקלון", network: "rami_levy" },
    { id: "48", name: "רמי לוי יבנה", city: "יבנה", address: "הסדן 3", areas: "יבנה", network: "rami_levy" },
    { id: "51", name: "רמי לוי קרית גת", city: "קרית גת", address: "האומן 1", areas: "קרית גת", network: "rami_levy" },
    { id: "52", name: "רמי לוי שדרות", city: "שדרות", address: "בן גוריון 1", areas: "שדרות, נתיבות, אופקים", network: "rami_levy" },
    { id: "66", name: "רמי לוי אילת", city: "אילת", address: "העבודה 4", areas: "אילת", network: "rami_levy" }
];

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
 * מחזיר את רשימת הסניפים הארצית של שופרסל (אונליין / דיל / שלי)
 */
async function fetchShufersalBranches() {
    try {
        return SHUFERSAL_BRANCHES.map(b => ({ ...b }));
    } catch (e) {
        console.error("Error with Shufersal branches", e);
        return [];
    }
}

function normalizeRamiLevyBranch(b) {
    const id = b && (b.id ?? b.store_id ?? b.branch_id ?? b.code);
    const name = b && (b.name || b.store_name || b.title);
    if (id == null || !name) return null;
    const city = String(b.city || b.city_name || '').trim() || String(name).trim();
    const areas = Array.isArray(b.areas)
        ? b.areas.map(a => (typeof a === 'string' ? a : a?.name || '')).filter(Boolean).join(', ')
        : String(b.areas || city);
    return {
        id: String(id),
        name: String(name).trim(),
        city,
        address: String(b.address || b.street || '').trim(),
        areas,
        network: 'rami_levy'
    };
}

/**
 * מביא סניפים עבור רמי לוי מהשרת הציבורי, עם גיבוי ארצי מלא של סניפים ומוקדי משלוח.
 */
async function fetchRamiLevyBranches() {
    if (typeof fetch === 'function') {
        try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;
            try {
                const response = await fetch(API_ENDPOINTS.rami_levy, controller ? { signal: controller.signal } : undefined);
                if (response && response.ok) {
                    const json = await response.json();
                    const raw = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : (Array.isArray(json?.stores) ? json.stores : []));
                    const normalized = raw.map(normalizeRamiLevyBranch).filter(Boolean);
                    if (normalized.length > 0) return normalized;
                }
            } finally {
                if (timer) clearTimeout(timer);
            }
        } catch (error) {
            console.warn('Rami Levy live branch fetch failed, using nationwide fallback:', error?.message || error);
        }
    }
    return RAMI_LEVY_FALLBACK_BRANCHES.map(b => ({ ...b }));
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

// Branches whose city, name or delivery areas mention the city. No city means no filter.
// The street address counts only when nothing else matched: "שדרות ירושלים" in Kiryat Motzkin is not a Jerusalem branch.
function branchesInCity(branches, city) {
    const t = normCity(String(city || '').split(' - ')[0]);
    if (!t) return branches;
    // a place must start with the city: "יבנה" is not "גן יבנה"
    const byPlace = branches.filter(b => [b.city, b.name, ...String(b.areas || '').split(',')].some(f => normCity(f).startsWith(t)));
    if (byPlace.length) return byPlace;
    // in "street, town" the town must also start with the city; the street part may only mention it
    return branches.filter(b => {
        const parts = String(b.address || '').split(',');
        const town = parts.length > 1 ? parts.pop() : '';
        return normCity(town).startsWith(t) || parts.some(p => normCity(p).includes(t));
    });
}

// Victory's branch list has no delivery areas. Its own site asks this endpoint which branch delivers to an address.
// shortcut: asks by city only, so a city split between two branches gets one of them; add a street field if that matters.
const victoryDeliveryCache = new Map();
async function fetchVictoryDeliveryBranchId(city) {
    if (victoryDeliveryCache.has(city)) return victoryDeliveryCache.get(city);
    let id = null;
    try {
        const response = await fetch('https://api.victoryonline.co.il/api/web/delivery-slots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ city, street: '', houseNumber: '' })
        });
        id = branchFromDeliverySlots(await response.json());
        if (response.ok) victoryDeliveryCache.set(city, id); // a rate-limit answer must not be remembered as "no delivery"
    } catch (error) {
        console.error('Error asking Victory which branch delivers to', city, error);
    }
    return id;
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
        getAllBranches,
        fetchVictoryDeliveryBranchId,
        fetchShufersalBranches,
        fetchRamiLevyBranches
    };
}

if (typeof module !== 'undefined') {
    module.exports = {
        normCity,
        citySuggestions,
        branchesInCity,
        fetchShufersalBranches,
        fetchRamiLevyBranches,
        getAllBranches,
        SHUFERSAL_BRANCHES,
        RAMI_LEVY_FALLBACK_BRANCHES
    };
}
