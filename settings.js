// settings.js

let allBranches = [];

document.addEventListener('DOMContentLoaded', async () => {
    const loadingDiv = document.getElementById('loading');
    const locationSection = document.getElementById('location-section');
    const settingsForm = document.getElementById('settings-form');
    const cityInput = document.getElementById('city-input');

    // טעינת רשימת הסניפים מכל הרשתות (מוגדר ב-branch_service.js)
    if (window.branchService && typeof window.branchService.getAllBranches === 'function') {
        allBranches = await window.branchService.getAllBranches();
    } else {
        console.error("branch_service.js not loaded properly.");
    }

    loadingDiv.style.display = 'none';
    locationSection.style.display = 'block';
    settingsForm.style.display = 'block';

    // איכלוס ראשוני של כל התפריטים
    populateDropdowns('');

    // מאזין לשינוי בעיר כדי לסנן
    cityInput.addEventListener('input', (e) => {
        const cityFilter = e.target.value.trim().toLowerCase();
        populateDropdowns(cityFilter);
    });

    // טעינת הגדרות שמורות מקודם
    loadSavedSettings();

    // שמירה
    document.getElementById('save-btn').addEventListener('click', saveSettings);
});

function populateDropdowns(cityFilter) {
    const networks = {
        'shufersal': document.getElementById('shufersal-branch'),
        'rami_levy': document.getElementById('rami-levy-branch'),
        'victory': document.getElementById('victory-branch'),
        'machsanei_hashuk': document.getElementById('mck-branch')
    };

    // עבור כל רשת, ניצור אופציות מתאימות
    for (const [networkKey, selectEl] of Object.entries(networks)) {
        // שמירת הבחירה הנוכחית אם קיימת
        const currentValue = selectEl.value;

        // סינון סניפים של הרשת הספציפית, ואם יש חיפוש עיר - סינון לפי עיר
        const networkBranches = allBranches.filter(b => b.network === networkKey);
        
        let filteredBranches = networkBranches;
        if (cityFilter) {
            filteredBranches = networkBranches.filter(b => 
                (b.city && b.city.toLowerCase().includes(cityFilter)) || 
                (b.address && b.address.toLowerCase().includes(cityFilter)) ||
                (b.name && b.name.toLowerCase().includes(cityFilter))
            );
        }

        // אם אין תוצאות בסינון עיר, נציג את כל סניפי הרשת כדי לא להשאיר ריק לגמרי
        if (filteredBranches.length === 0 && cityFilter) {
            filteredBranches = networkBranches;
        }

        // בניית ה-HTML של האופציות
        selectEl.innerHTML = '<option value="">-- בחר סניף --</option>';
        filteredBranches.forEach(branch => {
            const option = document.createElement('option');
            option.value = branch.id;
            const cityText = branch.city ? ` (${branch.city})` : '';
            option.textContent = `${branch.name}${cityText}`;
            option.dataset.name = branch.name;
            selectEl.appendChild(option);
        });

        // החזרת הערך שנבחר אם הוא עדיין ברשימה
        if (currentValue && Array.from(selectEl.options).some(opt => opt.value === currentValue)) {
            selectEl.value = currentValue;
        }
    }
}

function loadSavedSettings() {
    chrome.storage.sync.get(['userSettings', 'savedCity'], (data) => {
        const userSettings = data.userSettings || {};
        
        if (data.savedCity) {
            document.getElementById('city-input').value = data.savedCity;
            populateDropdowns(data.savedCity); // סינון לפי העיר השמורה
        }

        if (userSettings.shufersal && userSettings.shufersal.branchId) {
            document.getElementById('shufersal-branch').value = userSettings.shufersal.branchId;
        }
        if (userSettings.ramiLevy && userSettings.ramiLevy.branchId) {
            document.getElementById('rami-levy-branch').value = userSettings.ramiLevy.branchId;
        }
        if (userSettings.victory && userSettings.victory.branchId) {
            document.getElementById('victory-branch').value = userSettings.victory.branchId;
        }
        if (userSettings.machsaneiHashuk && userSettings.machsaneiHashuk.branchId) {
            document.getElementById('mck-branch').value = userSettings.machsaneiHashuk.branchId;
        }
    });
}

function saveSettings() {
    const city = document.getElementById('city-input').value.trim();
    
    const shufersalSelect = document.getElementById('shufersal-branch');
    const ramiLevySelect = document.getElementById('rami-levy-branch');
    const victorySelect = document.getElementById('victory-branch');
    const mckSelect = document.getElementById('mck-branch');

    const userSettings = {
        shufersal: {
            branchId: shufersalSelect.value,
            branchName: shufersalSelect.options[shufersalSelect.selectedIndex]?.dataset.name || ''
        },
        ramiLevy: {
            branchId: ramiLevySelect.value,
            branchName: ramiLevySelect.options[ramiLevySelect.selectedIndex]?.dataset.name || ''
        },
        victory: {
            branchId: victorySelect.value,
            branchName: victorySelect.options[victorySelect.selectedIndex]?.dataset.name || ''
        },
        machsaneiHashuk: {
            branchId: mckSelect.value,
            branchName: mckSelect.options[mckSelect.selectedIndex]?.dataset.name || ''
        }
    };

    chrome.storage.sync.set({ userSettings: userSettings, savedCity: city }, () => {
        const status = document.getElementById('statusMessage');
        status.textContent = 'ההגדרות נשמרו בהצלחה! ✅';
        status.className = 'status-success';
        status.style.display = 'block';
        
        setTimeout(() => {
            status.style.display = 'none';
        }, 3000);
    });
}
