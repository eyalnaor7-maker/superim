import json
import requests
import time
import os
import re

# קבצי העבודה שלנו
TARGET_BARCODES_FILE = 'target_barcodes.json'
PRICES_JSON_FILE = 'prices.json'

# --- 🚨 שים פה את הטוקן של ויקטורי 🚨 ---
# חובה לשים פה טוקן כדי שהחיפוש החכם יעבוד (העתק אותו מה-Local Storage של ויקטורי)
VICTORY_TOKEN = "83402ecd207b06ff2a81ff7306167fb5fca540dfda97c5df2c88c063485d6a9ebdf91734c9386d149e35293ac391b0ab53021d205806af4e04a69c228f92e162"


def clean_product_name(name):
    """
    פונקציית הניקוי החכמה שלך: מסירה משקלים, מידות ותווים מיוחדים כדי שויקטורי יבין
    """
    clean = re.sub(r'\d+\.?\d*\s*(גרם|מ"ל|מל|ליטר|ק"ג|קג|יח\'?|מ"ג)', '', name, flags=re.IGNORECASE)
    clean = re.sub(r'[^א-תa-zA-Z0-9\s]', ' ', clean)
    clean = re.sub(r'\s+', ' ', clean).strip()
    return clean[:40]


def fetch_rami_levy_data(barcode):
    url = "https://www.rami-levy.co.il/api/catalog"
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8"
    }
    payload = {"q": str(barcode), "store": 331}

    try:
        res = requests.post(url, headers=headers, json=payload, timeout=7)
        if res.status_code == 200:
            data = res.json()
            if 'data' in data and len(data['data']) > 0:
                product = data['data'][0]
                price = product.get('price', {}).get('price', 0)
                internal_code = str(product.get('id'))
                return internal_code, float(price)
    except Exception:
        pass
    return None, None


def fetch_victory_data(barcode, original_name):
    VICTORY_RETAILER_ID = 1470
    VICTORY_APP_ID = 4
    BRANCH_ID = 2439

    url = f"https://www.victoryonline.co.il/v2/retailers/{VICTORY_RETAILER_ID}/branches/{BRANCH_ID}/products/autocomplete"
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
    }
    if VICTORY_TOKEN:
        headers["Authorization"] = f"Bearer {VICTORY_TOKEN}"

    def search_victory_api(query_text):
        params = {
            "appId": VICTORY_APP_ID, "query": query_text,
            "from": "0", "size": "10", "isSearch": "true", "languageId": "1"
        }
        try:
            res = requests.get(url, params=params, headers=headers, timeout=7)
            if res.status_code == 200:
                return res.json().get('suggestions', {}).get('suggestProducts', {}).get('products', [])
            elif res.status_code in [401, 403]:
                return "AUTH_ERROR"
        except Exception:
            pass
        return []

    def extract_info(p):
        retailer_id = str(p.get('id'))
        branch_info = p.get('branch', {})
        price = branch_info.get('salePrice') or branch_info.get('regularPrice') or branch_info.get('price') or 0
        return retailer_id, float(price)

    # --- תוכנית א': חיפוש ישיר לפי ברקוד ---
    products_by_barcode = search_victory_api(str(barcode))
    if products_by_barcode == "AUTH_ERROR":
        print("  ❌ [ויקטורי] שגיאת הרשאה! הטוקן פג תוקף או חסר.")
        return None, None

    for p in products_by_barcode:
        p_barcode = str(p.get('barcode', '')).strip()
        p_local = str(p.get('localBarcode', '')).strip()
        if p_barcode == str(barcode) or p_local == str(barcode):
            return extract_info(p)

    # --- תוכנית ב': חיפוש לפי שם (אם ברקוד לא עבד) ---
    cleaned_name = clean_product_name(original_name)
    if len(cleaned_name) > 2:
        products_by_name = search_victory_api(cleaned_name)
        if products_by_name == "AUTH_ERROR":
            return None, None

        # שלב 1 בתוכנית ב': מחפשים את הברקוד שלנו בתוך תוצאות השם
        for p in products_by_name:
            p_barcode = str(p.get('barcode', '')).strip()
            p_local = str(p.get('localBarcode', '')).strip()
            if p_barcode == str(barcode) or p_local == str(barcode):
                print(f"  🔍 ויקטורי נמצא דרך השם! ({cleaned_name})")
                return extract_info(p)

        # שלב 2 בתוכנית ב' (רשות): אם הברקוד לא חזר בכלל, אבל יש תוצאה ראשונה - ניקח אותה בהסתייגות
        if len(products_by_name) > 0:
            best_match = products_by_name[0]
            print(f"  ⚠️ ויקטורי - התאמה חלקית לשם: {best_match.get('name', '')}")
            return extract_info(best_match)

    return None, None


def main():
    print("🚀 מתחיל בבניית מאגר הנתונים המלא (הבוט האולטימטיבי)...")

    if not os.path.exists(TARGET_BARCODES_FILE):
        print(f"❌ שגיאה: לא מצאתי את {TARGET_BARCODES_FILE}")
        return

    with open(TARGET_BARCODES_FILE, 'r', encoding='utf-8') as f:
        targets = json.load(f)

    db = {}
    if os.path.exists(PRICES_JSON_FILE):
        with open(PRICES_JSON_FILE, 'r', encoding='utf-8') as f:
            try:
                db = json.load(f)
            except:
                db = {}

    total_targets = len(targets)
    updated_count = 0

    if not VICTORY_TOKEN:
        print("⚠️ אזהרה קריטית: לא הזנת VICTORY_TOKEN! החיפוש בויקטורי ייכשל ברובו.")

    print(f"📦 מצאתי {total_targets} מטרות. מתחיל לסרוק...\n")

    for idx, target in enumerate(targets, 1):
        barcode = target['barcode']
        original_name = target['name']
        db_key = f"P_{barcode}"

        if db_key not in db:
            db[db_key] = {
                "name": original_name,
                "shufersal_price": 0,
                "rami_levy_code": None,
                "rami_levy_price": None,
                "victory_code": None,
                "victory_retailer_id": None,
                "victory_price": None
            }

        item_ref = db[db_key]
        needs_rl = target['in_rami_levy'] and not item_ref.get('rami_levy_code')
        needs_vic = target['in_victory'] and not item_ref.get('victory_code')

        if needs_rl or needs_vic:
            print(f"[{idx}/{total_targets}] סורק: {original_name} (ברקוד: {barcode})")
            needs_save = False

            # --- סריקת ויקטורי ---
            if needs_vic:
                vic_code, vic_price = fetch_victory_data(barcode, original_name)
                if vic_code:
                    item_ref['victory_code'] = vic_code
                    item_ref['victory_retailer_id'] = int(vic_code)
                    item_ref['victory_price'] = vic_price
                    print(f"  ✅ ויקטורי עודכן (קוד פנימי: {vic_code})")
                    needs_save = True
                time.sleep(0.4)  # מנוחה קלה כדי לא לעצבן את ויקטורי

            # --- סריקת רמי לוי ---
            if needs_rl:
                rl_code, rl_price = fetch_rami_levy_data(barcode)
                if rl_code:
                    item_ref['rami_levy_code'] = rl_code
                    item_ref['rami_levy_price'] = rl_price
                    print(f"  ✅ רמי לוי עודכן (קוד פנימי: {rl_code})")
                    needs_save = True
                time.sleep(0.3)

            if needs_save:
                updated_count += 1

            if idx % 20 == 0 and updated_count > 0:
                with open(PRICES_JSON_FILE, 'w', encoding='utf-8') as f:
                    json.dump(db, f, ensure_ascii=False, indent=4)
                print("  💾 [שמירה אוטומטית בוצעה]")

    # שמירה אחרונה בסיום הריצה
    with open(PRICES_JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=4)

    print(f"\n🎉 סיימנו בהצלחה! התווספו/עודכנו {updated_count} מוצרים במאגר (prices.json).")


if __name__ == "__main__":
    main()