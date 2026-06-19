"""
smart_database_builder.py
=========================
בוט חכם ומאוחד להרחבת מסד הנתונים (prices.json)

אסטרטגיה בשלושה שלבים:
  שלב 1: הצלבת ברקודים מקבצי XML → זיהוי אלו מוצרים קיימים בכל סופר
  שלב 2: חיפוש קוד פנימי ב-API לפי ברקוד (הכי מדויק)
  שלב 3: חיפוש קוד פנימי ב-API לפי שם מוצר מה-XML (fallback חכם)

הסבר בשפה פשוטה:
  - קבצי XML מכילים ברקוד + שם + מחיר (אבל לא את הקוד הפנימי של האתר)
  - הקוד הפנימי נמצא רק באתר עצמו (דרך ה-API)
  - אז: XML עוזר לנו לדעת אילו מוצרים קיימים, ו-API עוזר למצוא את הקוד הפנימי
"""

import xml.etree.ElementTree as ET
import json
import requests
import time
import random
import os
import re
import glob
import sys
import io
from datetime import datetime

# תיקון encoding לטרמינל Windows
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ==========================================
#   הגדרות - שנה לפי הצורך
# ==========================================

# טוקן ויקטורי - חובה לעדכן! (העתק מ-LocalStorage > frontend > token באתר ויקטורי)
VICTORY_TOKEN = "83402ecd207b06ff2a81ff7306167fb5fca540dfda97c5df2c88c063485d6a9ebdf91734c9386d149e35293ac391b0ab53021d205806af4e04a69c228f92e162"

# חנויות ספציפיות
RAMI_LEVY_STORE_ID = 331
VICTORY_RETAILER_ID = 1470
VICTORY_BRANCH_ID = 2439
VICTORY_APP_ID = 4

# קבצים
PRICES_JSON_FILE = 'prices.json'
BACKUP_SUFFIX = f'_backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json'

# הגדרות ריצה
DRY_RUN = False            # True = רק מראה מה ישתנה, בלי לשמור
SAVE_EVERY = 25            # שמירה אוטומטית כל X מוצרים
DELAY_BETWEEN_CALLS = (0.4, 1.0)  # השהיה בין קריאות API (שניות)
MAX_CONSECUTIVE_FAILS = 10
FAIL_COOLDOWN = 60         # זמן המתנה (שניות) אחרי הרבה כישלונות

# ==========================================
#   חלק 1: קריאת קבצי XML
# ==========================================

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
]


def _read_xml_safe(file_path):
    """קורא קובץ XML בבטחה, מטפל בבעיות encoding"""
    if not os.path.exists(file_path):
        return None
    try:
        with open(file_path, 'rb') as f:
            raw = f.read()
        text = raw.decode('utf-8', errors='replace')
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        return ET.fromstring(clean.encode('utf-8'))
    except Exception as e:
        print(f"  ❌ שגיאה בקריאת {file_path}: {e}")
        return None


def parse_xml_products(file_path, min_barcode_len=8):
    """
    מחלץ מוצרים מקובץ XML (עובד לכל הסופרים).
    מחזיר: { ברקוד: { name, price } }
    מסנן רק ברקודים ארוכים (כלליים) עם מחיר > 0
    """
    data = {}
    root = _read_xml_safe(file_path)
    if root is None:
        return data

    # מחפש גם <Item> (שופרסל/רמי לוי) וגם <Product> (ויקטורי)
    items = list(root.iter('Item')) + list(root.iter('Product'))

    for item in items:
        code_elem = item.find('ItemCode')
        name_elem = item.find('ItemName')
        price_elem = item.find('ItemPrice')

        if code_elem is None or name_elem is None or price_elem is None:
            continue

        barcode = (code_elem.text or '').strip()
        name = (name_elem.text or '').strip()

        if len(barcode) < min_barcode_len or not name:
            continue

        try:
            price = float(price_elem.text)
            if price <= 0:
                continue
            # שומרים את המחיר הנמוך ביותר (אם יש כפילויות)
            if barcode not in data or price < data[barcode]['price']:
                data[barcode] = {"name": name, "price": price}
        except (ValueError, TypeError):
            pass

    return data


def find_xml_files():
    """מוצא את כל קבצי ה-XML בתיקייה, ממיין לפי סופר"""
    shufersal = glob.glob('שופרסל*.xml') + glob.glob('*7290027600007*.xml')
    rami_levy = glob.glob('רמי לוי*.xml') + glob.glob('*7290058140886*.xml')
    victory = glob.glob('ויקטורי*.xml') + glob.glob('*7290696200003*.xml')

    # הסרת כפילויות
    shufersal = list(set(shufersal))
    rami_levy = list(set(rami_levy))
    victory = list(set(victory))

    return shufersal, rami_levy, victory


def merge_xml_data(file_list):
    """ממזג נתונים ממספר קבצי XML (שומר מחיר נמוך)"""
    merged = {}
    for f in file_list:
        partial = parse_xml_products(f)
        for barcode, info in partial.items():
            if barcode not in merged or info['price'] < merged[barcode]['price']:
                merged[barcode] = info
        print(f"    📄 {os.path.basename(f)}: {len(partial):,} מוצרים")
    return merged


# ==========================================
#   חלק 2: חיפוש קודים פנימיים ב-API
# ==========================================

def clean_product_name(name):
    """
    מנקה שם מוצר לחיפוש ב-API.
    מסיר: משקלים, אחוזים, תווים מיוחדים, מילות רעש
    """
    clean = name
    # הסרת משקלים ומידות
    clean = re.sub(r'\d+\.?\d*\s*(גרם|גר|מ"ל|מל|ליטר|ל\'|ק"ג|קג|יח\'?|מ"ג|מג|מ\.ל|ק\.ג)', '', clean, flags=re.IGNORECASE)
    # הסרת אחוזים
    clean = re.sub(r'\d+\.?\d*\s*%', '', clean)
    # הסרת מספרים בודדים בסוף (כמו "500", "750")
    clean = re.sub(r'\b\d{2,5}\b', '', clean)
    # הסרת תווים מיוחדים (שומרים אותיות עברית, אנגלית, רווחים)
    clean = re.sub(r'[^א-תa-zA-Z0-9\s]', ' ', clean)
    # הסרת רווחים כפולים
    clean = re.sub(r'\s+', ' ', clean).strip()
    # חיתוך ל-40 תווים (API לא אוהב שמות ארוכים)
    return clean[:40]


def search_rami_levy_api(query):
    """
    חיפוש ברמי לוי לפי ברקוד או שם.
    מחזיר: (internal_code, price) או (None, None)
    """
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "Referer": "https://www.rami-levy.co.il/he"
    }
    try:
        res = requests.post(
            "https://www.rami-levy.co.il/api/catalog",
            headers=headers,
            json={"q": str(query), "store": RAMI_LEVY_STORE_ID},
            timeout=10
        )
        if res.status_code == 200:
            data = res.json()
            if data.get('data') and len(data['data']) > 0:
                product = data['data'][0]
                price = float(product.get('price', {}).get('price', 0))
                code = str(product.get('id'))
                barcode_match = str(product.get('barcode', ''))
                return code, price, barcode_match
    except Exception:
        pass
    return None, None, None


def search_victory_api(query):
    """
    חיפוש בויקטורי לפי ברקוד או שם.
    משתמש בשיטה של victory_bot.py ללא צורך בטוקן.
    """
    import urllib.parse
    
    encoded_query = urllib.parse.quote(str(query))
    filters_param = "%7B%22must%22:%7B%22exists%22:%5B%22family.id%22,%22family.categoriesPaths.id%22,%22branch.regularPrice%22%5D,%22term%22:%7B%22branch.isActive%22:true,%22branch.isVisible%22:true%7D%7D,%22mustNot%22:%7B%22term%22:%7B%22branch.regularPrice%22:0%7D%7D,%22bool%22:%7B%22should%22:%5B%7B%22bool%22:%7B%22must_not%22:%7B%22exists%22:%7B%22field%22:%22branch.outOfStockShowUntilDate%22%7D%7D%7D%7D,%7B%22bool%22:%7B%22must%22:%5B%7B%22range%22:%7B%22branch.outOfStockShowUntilDate%22:%7B%22gt%22:%22now%22%7D%7D%7D,%7B%22term%22:%7B%22branch.isOutOfStock%22:true%7D%7D%5D%7D%7D,%7B%22bool%22:%7B%22must%22:%5B%7B%22term%22:%7B%22branch.isOutOfStock%22:false%7D%7D%5D%7D%7D%5D%7D%7D"

    url = f"https://www.victoryonline.co.il/v2/retailers/{VICTORY_RETAILER_ID}/branches/{VICTORY_BRANCH_ID}/products/autocomplete?appId={VICTORY_APP_ID}&filters={filters_param}&from=0&isSearch=true&languageId=1&size=10&query={encoded_query}"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://www.victoryonline.co.il",
        "Referer": "https://www.victoryonline.co.il/"
    }
    
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.status_code == 200:
            data = res.json()
            if data.get('suggestions') and data['suggestions'].get('suggestProducts') and data['suggestions']['suggestProducts'].get('products'):
                return data['suggestions']['suggestProducts']['products']
        elif res.status_code in [401, 403]:
            return "AUTH_ERROR"
    except Exception:
        pass
    return []


def find_rami_levy_code(barcode, product_name):
    """
    מוצא קוד פנימי של רמי לוי.
    שלב 1: חיפוש לפי ברקוד (מדויק)
    שלב 2: חיפוש לפי שם מנוקה (fallback)
    מחזיר: (code, price, confidence, method)
    """
    # שלב 1: חיפוש לפי ברקוד
    code, price, returned_barcode = search_rami_levy_api(barcode)
    if code:
        if returned_barcode == str(barcode):
            return code, price, 100, "barcode_exact"
        else:
            return code, price, 70, "barcode_first_result"

    time.sleep(random.uniform(*DELAY_BETWEEN_CALLS))

    # שלב 2: חיפוש לפי שם
    cleaned_name = clean_product_name(product_name)
    if len(cleaned_name) > 2:
        code, price, returned_barcode = search_rami_levy_api(cleaned_name)
        if code:
            if returned_barcode == str(barcode):
                return code, price, 90, "name_barcode_match"
            else:
                return code, price, 50, "name_first_result"

    return None, None, 0, "not_found"


def find_victory_code(barcode, product_name, xml_victory_name=None):
    """
    מוצא קוד פנימי של ויקטורי.
    שלב 1: חיפוש לפי ברקוד (מדויק)
    שלב 2: חיפוש לפי שם מה-XML של ויקטורי (מדויק מאוד!)
    שלב 3: חיפוש לפי שם מנוקה (fallback)
    מחזיר: (code, price, confidence, method)
    """

    def extract_info(product):
        """מחלץ קוד פנימי ומחיר מתוצאת API"""
        prod_id = str(product.get('id'))
        branch = product.get('branch', {})
        price = branch.get('salePrice') or branch.get('regularPrice') or branch.get('price') or 0
        return prod_id, float(price)

    # שלב 1: חיפוש לפי ברקוד
    products = search_victory_api(str(barcode))
    if products == "AUTH_ERROR":
        return None, None, 0, "auth_error"
    if products == "NO_TOKEN":
        return None, None, 0, "no_token"

    for p in (products or []):
        p_barcode = str(p.get('barcode', '')).strip()
        p_local = str(p.get('localBarcode', '')).strip()
        if p_barcode == str(barcode) or p_local == str(barcode):
            code, price = extract_info(p)
            return code, price, 100, "barcode_exact"

    time.sleep(random.uniform(*DELAY_BETWEEN_CALLS))

    # שלב 2: חיפוש לפי שם מה-XML של ויקטורי (הכי חכם!)
    if xml_victory_name:
        products = search_victory_api(xml_victory_name)
        if products and products not in ["AUTH_ERROR", "NO_TOKEN"]:
            # קודם מחפשים התאמת שם מדויקת
            for p in products:
                if p.get('name', '').strip() == xml_victory_name.strip():
                    code, price = extract_info(p)
                    return code, price, 95, "xml_name_exact"
            # אחרת לוקחים את הראשון (כי השם מה-XML מאוד מדויק)
            if products:
                code, price = extract_info(products[0])
                return code, price, 85, "xml_name_first"

        time.sleep(random.uniform(*DELAY_BETWEEN_CALLS))

    # שלב 3: חיפוש לפי שם מנוקה
    cleaned_name = clean_product_name(product_name)
    if len(cleaned_name) > 2:
        products = search_victory_api(cleaned_name)
        if products and products not in ["AUTH_ERROR", "NO_TOKEN"]:
            # מחפשים התאמת ברקוד
            for p in products:
                p_barcode = str(p.get('barcode', '')).strip()
                p_local = str(p.get('localBarcode', '')).strip()
                if p_barcode == str(barcode) or p_local == str(barcode):
                    code, price = extract_info(p)
                    return code, price, 90, "cleaned_name_barcode_match"
            # fallback: תוצאה ראשונה
            if products:
                code, price = extract_info(products[0])
                return code, price, 40, "cleaned_name_first"

    return None, None, 0, "not_found"


# ==========================================
#   חלק 3: הלוגיקה הראשית
# ==========================================

def run():
    print("=" * 65)
    print("🚀 בוט חכם להרחבת מסד הנתונים — Smart Database Builder")
    print("=" * 65)
    print(f"📅 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"🔧 מצב: {'DRY RUN (לא שומר!)' if DRY_RUN else 'LIVE (שומר שינויים)'}")
    print()

    # ---- שלב 0: בוט ויקטורי מעודכן ----
    print("✅ משתמש בשיטה של victory_bot.py לחיפוש ללא טוקן!")
    print()

    # ---- שלב 1: טעינת קבצי XML ----
    print("📂 שלב 1: קריאת קבצי XML...")
    shufersal_files, rami_levy_files, victory_files = find_xml_files()

    print(f"\n  שופרסל ({len(shufersal_files)} קבצים):")
    shufersal_xml = merge_xml_data(shufersal_files) if shufersal_files else {}

    print(f"\n  רמי לוי ({len(rami_levy_files)} קבצים):")
    rami_levy_xml = merge_xml_data(rami_levy_files) if rami_levy_files else {}

    print(f"\n  ויקטורי ({len(victory_files)} קבצים):")
    victory_xml = merge_xml_data(victory_files) if victory_files else {}

    print(f"\n📊 סיכום XML:")
    print(f"  שופרסל: {len(shufersal_xml):,} מוצרים (ברקודים כלליים)")
    print(f"  רמי לוי: {len(rami_levy_xml):,} מוצרים")
    print(f"  ויקטורי: {len(victory_xml):,} מוצרים (ברקודים כלליים בלבד)")

    # ברקודים משותפים
    all_barcodes = set(shufersal_xml.keys()) | set(rami_levy_xml.keys()) | set(victory_xml.keys())
    common_all_3 = set(shufersal_xml.keys()) & set(rami_levy_xml.keys()) & set(victory_xml.keys())
    common_sh_rl = set(shufersal_xml.keys()) & set(rami_levy_xml.keys())
    common_sh_vi = set(shufersal_xml.keys()) & set(victory_xml.keys())

    print(f"\n  🔗 ברקודים משותפים:")
    print(f"    כל שלושת הסופרים: {len(common_all_3):,}")
    print(f"    שופרסל + רמי לוי: {len(common_sh_rl):,}")
    print(f"    שופרסל + ויקטורי: {len(common_sh_vi):,}")
    print(f"    סה\"כ ברקודים ייחודיים: {len(all_barcodes):,}")

    # ---- שלב 2: טעינת מסד קיים + גיבוי ----
    print(f"\n📚 שלב 2: טעינת מסד קיים...")
    database = {}
    if os.path.exists(PRICES_JSON_FILE):
        with open(PRICES_JSON_FILE, 'r', encoding='utf-8') as f:
            database = json.load(f)
        print(f"  מאגר קיים: {len(database):,} מוצרים")

        # גיבוי
        if not DRY_RUN:
            backup_path = PRICES_JSON_FILE.replace('.json', BACKUP_SUFFIX)
            with open(backup_path, 'w', encoding='utf-8') as f:
                json.dump(database, f, ensure_ascii=False, indent=4)
            print(f"  💾 גיבוי נשמר: {backup_path}")
    else:
        print("  ⚠️ לא נמצא prices.json — ייווצר חדש")

    # ---- שלב 3: ניתוח מה חסר ----
    print(f"\n🔍 שלב 3: ניתוח מה חסר...")

    # בניית רשימת מטרות
    targets = []

    # 3a: מוצרים קיימים ב-database שחסר להם קוד
    existing_missing_rl = 0
    existing_missing_vic = 0
    for db_key, item in database.items():
        barcode = db_key[2:] if db_key.startswith('P_') else db_key
        needs_rl = not item.get('rami_levy_code')
        needs_vic = not item.get('victory_code')

        if needs_rl or needs_vic:
            targets.append({
                'barcode': barcode,
                'name': item.get('name', ''),
                'needs_rl': needs_rl,
                'needs_vic': needs_vic,
                'in_rl_xml': barcode in rami_levy_xml,
                'in_vic_xml': barcode in victory_xml,
                'vic_xml_name': victory_xml.get(barcode, {}).get('name'),
                'source': 'existing_db'
            })
            if needs_rl:
                existing_missing_rl += 1
            if needs_vic:
                existing_missing_vic += 1

    # 3b: מוצרים חדשים שנמצאו ב-XML אבל לא ב-database
    new_from_xml = 0
    for barcode in all_barcodes:
        db_key = f"P_{barcode}"
        if db_key not in database:
            # מוצר חדש! מוסיפים אותו
            in_shufersal = barcode in shufersal_xml
            in_rl = barcode in rami_levy_xml
            in_victory = barcode in victory_xml

            # נוסיף רק מוצרים שנמצאים בלפחות 2 סופרים
            store_count = sum([in_shufersal, in_rl, in_victory])
            if store_count >= 2:
                # בוחרים שם ומחיר מהמקור הטוב ביותר
                name = (shufersal_xml.get(barcode, {}).get('name') or
                        rami_levy_xml.get(barcode, {}).get('name') or
                        victory_xml.get(barcode, {}).get('name', 'Unknown'))
                shufersal_price = shufersal_xml.get(barcode, {}).get('price', 0)
                rl_price = rami_levy_xml.get(barcode, {}).get('price', 0)

                targets.append({
                    'barcode': barcode,
                    'name': name,
                    'needs_rl': True,
                    'needs_vic': True,
                    'in_rl_xml': in_rl,
                    'in_vic_xml': in_victory,
                    'vic_xml_name': victory_xml.get(barcode, {}).get('name'),
                    'source': 'new_from_xml',
                    'shufersal_price': shufersal_price,
                    'rl_xml_price': rl_price
                })
                new_from_xml += 1

    print(f"  📋 מוצרים קיימים שחסר להם רמי לוי: {existing_missing_rl:,}")
    print(f"  📋 מוצרים קיימים שחסר להם ויקטורי: {existing_missing_vic:,}")
    print(f"  🆕 מוצרים חדשים מ-XML (ב-2+ סופרים): {new_from_xml:,}")
    print(f"  🎯 סה\"כ מטרות לעיבוד: {len(targets):,}")

    if not targets:
        print("\n✅ אין מה לעדכן! המאגר מלא.")
        return

    # ---- שלב 4: חיפוש קודים פנימיים ----
    print(f"\n🔎 שלב 4: חיפוש קודים פנימיים ב-API...")
    print(f"   (זה ייקח זמן — כל חיפוש דורש קריאה לאתר)")
    print()

    stats = {
        'rl_found': 0, 'rl_failed': 0,
        'vic_found': 0, 'vic_failed': 0, 'vic_auth_error': False,
        'new_products': 0,
        'methods': {}
    }
    consecutive_fails = 0
    save_count = 0

    try:
        for idx, target in enumerate(targets, 1):
            barcode = target['barcode']
            name = target['name']
            db_key = f"P_{barcode}"
            changed = False

            # הוספת מוצר חדש ל-database
            if db_key not in database:
                database[db_key] = {
                    "name": name,
                    "shufersal_price": target.get('shufersal_price', 0),
                    "rami_levy_price": target.get('rl_xml_price', 0),
                    "rami_levy_code": None,
                    "victory_code": None,
                    "victory_price": None
                }
                stats['new_products'] += 1

            entry = database[db_key]
            short_name = name[:35] + ('...' if len(name) > 35 else '')
            print(f"  [{idx}/{len(targets)}] {short_name}", end=" ", flush=True)

            # --- חיפוש רמי לוי ---
            if target['needs_rl'] and not entry.get('rami_levy_code'):
                code, price, confidence, method = find_rami_levy_code(barcode, name)
                if code:
                    entry['rami_levy_code'] = code
                    if price:
                        entry['rami_levy_price'] = price
                    print(f"✅RL:{code}({confidence}%)", end=" ")
                    stats['rl_found'] += 1
                    stats['methods'][f'rl_{method}'] = stats['methods'].get(f'rl_{method}', 0) + 1
                    changed = True
                    consecutive_fails = 0
                else:
                    print(f"❌RL", end=" ")
                    stats['rl_failed'] += 1
                    consecutive_fails += 1

                time.sleep(random.uniform(*DELAY_BETWEEN_CALLS))

            # --- חיפוש ויקטורי ---
            if target['needs_vic'] and not entry.get('victory_code'):
                xml_name = target.get('vic_xml_name')
                code, price, confidence, method = find_victory_code(barcode, name, xml_name)
                if code:
                    entry['victory_code'] = code
                    if price:
                        entry['victory_price'] = price
                    entry['victory_retailer_id'] = int(code) if code.isdigit() else None
                    print(f"✅V:{code}({confidence}%)", end=" ")
                    stats['vic_found'] += 1
                    stats['methods'][f'vic_{method}'] = stats['methods'].get(f'vic_{method}', 0) + 1
                    changed = True
                    consecutive_fails = 0
                elif method == 'auth_error':
                    if not stats['vic_auth_error']:
                        print(f"\n  🚨 טוקן ויקטורי פג תוקף! מדלג על חיפושי ויקטורי.")
                        stats['vic_auth_error'] = True
                    # מסמנים שלא צריך ויקטורי יותר
                    for t in targets[idx:]:
                        t['needs_vic'] = False
                elif method == 'no_token':
                    pass  # כבר הזהרנו
                else:
                    print(f"❌V", end=" ")
                    stats['vic_failed'] += 1
                    consecutive_fails += 1

                time.sleep(random.uniform(*DELAY_BETWEEN_CALLS))

            if not changed and entry.get('rami_levy_code') and entry.get('victory_code'):
                print("✔️", end="")

            print()  # שורה חדשה

            # חסימה? ממתינים
            if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
                print(f"\n  ⚠️ {MAX_CONSECUTIVE_FAILS} כישלונות רצופים — ממתין {FAIL_COOLDOWN} שניות...")
                time.sleep(FAIL_COOLDOWN)
                consecutive_fails = 0

            # שמירה אוטומטית
            if changed:
                save_count += 1
            if save_count > 0 and save_count % SAVE_EVERY == 0 and not DRY_RUN:
                _save(database)
                print(f"  💾 שמירה אוטומטית ({save_count} עדכונים)")

    except KeyboardInterrupt:
        print("\n\n🛑 עצירה ידנית! שומר את מה שהספקנו...")

    # ---- שלב 5: שמירה וסיכום ----
    if not DRY_RUN:
        _save(database)

    print("\n" + "=" * 65)
    print("📊 סיכום ריצה:")
    print("=" * 65)
    print(f"  🆕 מוצרים חדשים שנוספו: {stats['new_products']:,}")
    print(f"  ✅ קודי רמי לוי שנמצאו: {stats['rl_found']:,}")
    print(f"  ❌ קודי רמי לוי שלא נמצאו: {stats['rl_failed']:,}")
    print(f"  ✅ קודי ויקטורי שנמצאו: {stats['vic_found']:,}")
    print(f"  ❌ קודי ויקטורי שלא נמצאו: {stats['vic_failed']:,}")
    print(f"  📚 גודל המאגר כעת: {len(database):,} מוצרים")

    if stats['methods']:
        print(f"\n  🔍 שיטות שעבדו:")
        for method, count in sorted(stats['methods'].items(), key=lambda x: -x[1]):
            store, approach = method.split('_', 1)
            store_name = 'רמי לוי' if store == 'rl' else 'ויקטורי'
            print(f"    {store_name} — {approach}: {count:,}")

    if stats['vic_auth_error']:
        print(f"\n  ⚠️ שים לב: טוקן ויקטורי פג תוקף! עדכן אותו והרץ שוב.")

    # חישוב כיסוי
    total = len(database)
    with_rl = sum(1 for v in database.values() if v.get('rami_levy_code'))
    with_vic = sum(1 for v in database.values() if v.get('victory_code'))
    with_both = sum(1 for v in database.values() if v.get('rami_levy_code') and v.get('victory_code'))

    print(f"\n  📈 כיסוי מאגר:")
    print(f"    רמי לוי: {with_rl:,}/{total:,} ({100*with_rl//total}%)")
    print(f"    ויקטורי: {with_vic:,}/{total:,} ({100*with_vic//total}%)")
    print(f"    שניהם: {with_both:,}/{total:,} ({100*with_both//total}%)")

    if DRY_RUN:
        print(f"\n  ℹ️ זו הייתה הרצת DRY RUN — שום דבר לא נשמר!")
    else:
        print(f"\n  ✅ השינויים נשמרו ל-{PRICES_JSON_FILE}")


def _save(database):
    """שמירה בטוחה של המאגר"""
    with open(PRICES_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(database, f, ensure_ascii=False, indent=4)


# ==========================================
#   הרצה ישירה
# ==========================================

if __name__ == '__main__':
    run()
