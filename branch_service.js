// branch_service.js

const API_ENDPOINTS = {
    victory: 'https://www.victoryonline.co.il/v2/retailers/1470/branches?appId=4',
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
        const data = await response.json();
        
        // ממפה את התשובה לפורמט אחיד
        return data.map(b => ({
            id: b.id.toString(),
            name: b.name,
            city: b.city || '',
            address: b.address || '',
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
