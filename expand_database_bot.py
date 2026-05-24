"""
expand_database_bot.py
======================
בוט מתקדם להרחבת prices.json בעזרת קבצי XML מרובים מהסופרים.

לוגיקה חדשה:
  1. קורא את קבצי ה-XML של שופרסל, רמי לוי, ו-ויקטורי.
  2. מקבצי ה-XML של ויקטורי (PriceFull) שולף את הקישור בין הברקוד הכללי לבין השם המדויק שויקטורי נתנו למוצר.
  3. עובר על מוצרים משותפים או על המאגר הקיים שחסר להם קוד ויקטורי.
  4. מחפש ב-API של ויקטורי באמצעות השם המדויק שנשלף בשלב 2!
  5. שומר הכל ישירות ל-prices.json.
"""

import xml.etree.ElementTree as ET
import json
import requests
import time
import random
import os
import re
import glob

# ===== הגדרת קבצים =====
SHUFERSAL_FILES = glob.glob('שופרסל*.xml') + glob.glob('*7290027600007*.xml')
RAMI_LEVY_FILES = glob.glob('רמי לוי*.xml') + glob.glob('*7290058140886*.xml')
VICTORY_FILES   = glob.glob('ויקטורי*.xml') + glob.glob('*7290696200003*.xml')

STORE_ID_RAMI_LEVY = 331
VICTORY_TOKEN = "83402ecd207b06ff2a81ff7306167fb5fca540dfda97c5df2c88c063485d6a9ebdf91734c9386d149e35293ac391b0ab53021d205806af4e04a69c228f92e162"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
]

def parse_shufersal_or_rl_xml(file_path):
    data = {}
    if not os.path.exists(file_path): return data
    try:
        with open(file_path, 'rb') as f:
            raw = f.read()
        text = raw.decode('utf-8', errors='replace')
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        root = ET.fromstring(clean.encode('utf-8'))
        
        items = list(root.iter('Item')) or list(root.iter('Product'))
        for item in items:
            code_elem  = item.find('ItemCode')
            name_elem  = item.find('ItemName')
            price_elem = item.find('ItemPrice')
            if code_elem is None or name_elem is None or price_elem is None: continue
            
            barcode = code_elem.text.strip() if code_elem.text else ''
            name    = name_elem.text.strip()  if name_elem.text  else ''
            try:
                price = float(price_elem.text)
                if len(barcode) >= 8 and price > 0:
                    if barcode not in data or price < data[barcode]['price']:
                        data[barcode] = {"name": name, "price": price}
            except (ValueError, TypeError):
                pass
    except Exception as e:
        print(f"❌ שגיאה בקריאת {file_path}: {e}")
    return data

def parse_victory_xml(file_path):
    """מחלץ ברקודים כלליים ושמות מתוך קובץ ה-XML של ויקטורי"""
    data = {}
    if not os.path.exists(file_path): return data
    try:
        with open(file_path, 'rb') as f:
            raw = f.read()
        text = raw.decode('utf-8', errors='replace')
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        root = ET.fromstring(clean.encode('utf-8'))
        
        items = list(root.iter('Product')) or list(root.iter('Item'))
        for item in items:
            code_elem  = item.find('ItemCode')
            name_elem  = item.find('ItemName')
            price_elem = item.find('ItemPrice')
            if code_elem is None or name_elem is None or price_elem is None: continue
            
            code  = code_elem.text.strip()  if code_elem.text  else ''
            name  = name_elem.text.strip()  if name_elem.text  else ''
            
            # מוודאים שזה ברקוד כללי ארוך ולא קוד פנימי קצר!
            if len(code) > 8 and name:
                try:
                    price = float(price_elem.text)
                    if code not in data or price < data[code]['price']:
                        data[code] = {"name": name, "price": price}
                except (ValueError, TypeError):
                    pass
    except Exception as e:
        print(f"❌ שגיאה בקריאת {file_path}: {e}")
    return data

def merge_store_xmls(file_list, parser_func):
    merged = {}
    for f in file_list:
        partial = parser_func(f)
        for key, val in partial.items():
            if key not in merged or val['price'] < merged[key]['price']:
                merged[key] = val
    return merged

def find_rami_levy_internal_id(barcode):
    headers = {"User-Agent": random.choice(USER_AGENTS), "Accept": "application/json, text/plain, */*", "Referer": "https://www.rami-levy.co.il/he"}
    try:
        response = requests.post("https://www.rami-levy.co.il/api/catalog", headers=headers, json={"q": str(barcode), "store": STORE_ID_RAMI_LEVY}, timeout=10)
        if response.status_code == 200:
            data = response.json()
            if data.get('data'):
                product = data['data'][0]
                if str(product.get('barcode')) == str(barcode): return str(product.get('id')), float(product.get('price', {}).get('price', 0))
    except: pass
    return None, None

def fetch_victory_internal_id(victory_name):
    """מחפש מוצר בויקטורי לפי השם המדויק שחולץ מה-XML"""
    if not VICTORY_TOKEN: return None, None
    url = "https://www.victoryonline.co.il/v2/retailers/1470/branches/2439/products/autocomplete"
    headers = {"User-Agent": random.choice(USER_AGENTS), "Accept": "application/json", "Authorization": f"Bearer {VICTORY_TOKEN}"}
    params = {"appId": "4", "query": victory_name, "from": "0", "size": "10", "isSearch": "true", "languageId": "1"}
    try:
        res = requests.get(url, params=params, headers=headers, timeout=10)
        if res.status_code == 200:
            products = res.json().get('suggestions', {}).get('suggestProducts', {}).get('products', [])
            for p in products:
                # בודק התאמה מדויקת או התאמה חלקית טובה
                if p.get('name', '').strip() == victory_name.strip():
                    return str(p.get('id')), float(p.get('branch', {}).get('regularPrice', 0))
            if products:
                return str(products[0].get('id')), float(products[0].get('branch', {}).get('regularPrice', 0))
    except: pass
    return None, None

def expand_database():
    print("=" * 60)
    print("🚀 מרחיב את מאגר המחירים בעזרת חילוץ שמות מ-XML של ויקטורי")
    print("=" * 60)

    # 1. טעינת קבצי XML
    shufersal_data = merge_store_xmls(SHUFERSAL_FILES, parse_shufersal_or_rl_xml)
    rl_data        = merge_store_xmls(RAMI_LEVY_FILES, parse_shufersal_or_rl_xml)
    victory_data   = merge_store_xmls(VICTORY_FILES,   parse_victory_xml)

    print(f"✅ נטענו משופרסל: {len(shufersal_data):,} ברקודים")
    print(f"✅ נטענו מרמי לוי: {len(rl_data):,} ברקודים")
    print(f"✅ נטענו מויקטורי (עם ברקוד כללי): {len(victory_data):,} ברקודים")

    # 2. טעינת מאגר קיים
    database = {}
    if os.path.exists('prices.json'):
        with open('prices.json', 'r', encoding='utf-8') as f:
            database = json.load(f)
        print(f"📚 מאגר קיים prices.json: {len(database):,} מוצרים")

    # אילו מוצרים צריכים סריקה? (מוצרים חדשים לחלוטין או קיימים שחסר להם קוד)
    common_barcodes = set(shufersal_data.keys()) & set(rl_data.keys())
    
    # רשימת הברקודים שנטפל בהם: או שהם במשותף של שופרסל ורמי לוי, או שהם כבר במאגר וחסר להם ויקטורי ויש לנו אותם ב-XML של ויקטורי!
    target_barcodes = set(common_barcodes)
    for db_key, item in database.items():
        b = db_key[2:]
        if not item.get('victory_code') and b in victory_data:
            target_barcodes.add(b)

    print(f"🎯 סה\"כ ברקודים להרחבה / עדכון: {len(target_barcodes):,}")
    
    added, updated_vic, updated_rl = 0, 0, 0
    consecutive_fails = 0

    try:
        for idx, barcode in enumerate(target_barcodes, 1):
            db_key = f"P_{barcode}"
            if db_key not in database:
                database[db_key] = {
                    "name": shufersal_data.get(barcode, {}).get('name', 'Unknown'),
                    "shufersal_price": shufersal_data.get(barcode, {}).get('price', 0),
                    "rami_levy_price": rl_data.get(barcode, {}).get('price', 0),
                    "rami_levy_code": None,
                    "victory_code": None,
                    "victory_price": None
                }
                added += 1

            entry = database[db_key]
            item_name = entry['name']
            
            needs_save = False
            print(f"[{idx}/{len(target_barcodes)}] {item_name[:30]}...", end=" ", flush=True)

            # בדיקת רמי לוי
            if not entry.get('rami_levy_code'):
                rl_id, rl_price = find_rami_levy_internal_id(barcode)
                if rl_id:
                    entry['rami_levy_code'] = rl_id
                    if rl_price: entry['rami_levy_price'] = rl_price
                    print(f"✅ RL:{rl_id}", end=" ")
                    needs_save = True
                    consecutive_fails = 0
                else:
                    consecutive_fails += 1
            
            # בדיקת ויקטורי מתוך ה-XML!
            if not entry.get('victory_code') and barcode in victory_data:
                # הנה הקסם - שולפים את השם המדויק של ויקטורי מאמצעות הברקוד מה-XML!
                exact_victory_name = victory_data[barcode]['name']
                vic_id, vic_price = fetch_victory_internal_id(exact_victory_name)
                
                if vic_id:
                    entry['victory_code'] = vic_id
                    entry['victory_price'] = vic_price if vic_price else victory_data[barcode]['price']
                    print(f"✅ V:{vic_id}", end=" ")
                    needs_save = True
                    consecutive_fails = 0
                    updated_vic += 1
                else:
                    consecutive_fails += 1
            
            if not needs_save and entry.get('rami_levy_code') and entry.get('victory_code'):
                print("✔️ כבר מעודכן", end="")
            elif not entry.get('rami_levy_code') and not entry.get('victory_code'):
                print("❌ לא נמצא בשום מקום", end="")

            print("") # New line
            
            if needs_save:
                time.sleep(random.uniform(0.5, 1.2))
            
            if consecutive_fails >= 10:
                print("\n⚠️ חסימה מהשרת (10 כשלונות) — ממתין דקה...")
                time.sleep(60)
                consecutive_fails = 0

            if idx % 30 == 0:
                _save(database)
                print("   💾 שמרנו גיבוי ביניים...")

    except KeyboardInterrupt:
        print("\n🛑 עצירה ידנית")

    _save(database)
    print(f"\n🎉 סיום התהליך!")
    print(f"🆕 מוצרים חדשים שנוספו למאגר: {added}")
    print(f"🎯 קודי ויקטורי פנימיים שעודכנו בהצלחה בעזרת ה-XML: {updated_vic}")
    print(f"📚 גודל המאגר כעת: {len(database):,} מוצרים.")

def _save(database):
    with open('prices.json', 'w', encoding='utf-8') as f:
        json.dump(database, f, ensure_ascii=False, indent=4)

if __name__ == '__main__':
    expand_database()
