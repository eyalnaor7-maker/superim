import json
import os
import requests
import getpass
import pg8000.dbapi
import re
from difflib import SequenceMatcher
import time
import sys
import io

# Fix Windows terminal UTF-8 encoding support for Hebrew text
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

GEMINI_API_KEY = "AIzaSyCu_EXWBvOSXoMn_9lqB_e3JFm7wZ702Bk"

DB_PASSWORD = None

# Load keys from config.json if available
if os.path.exists('config.json'):
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            cfg = json.load(f)
            if cfg.get('gemini_api_key'):
                GEMINI_API_KEY = cfg['gemini_api_key']
            if cfg.get('supabase_db_password') and cfg['supabase_db_password'] != "YOUR_SUPABASE_DATABASE_PASSWORD":
                DB_PASSWORD = cfg['supabase_db_password']
    except Exception:
        pass

def safe_str(val):
    return val.encode('ascii', errors='replace').decode('ascii')

def extract_weight(name):
    # Regex to find weight value and unit
    match = re.search(r'(\d+\.?\d*)\s*(גרם|מ"ל|מל|ליטר|ק"ג|קג)', name, re.IGNORECASE)
    if not match:
        return None
    value = float(match.group(1))
    unit = match.group(2).replace('"', '').lower()
    if unit in ['קג', 'ק"ג']:
        value *= 1000
        unit = 'גרם'
    if unit == 'ליטר':
        value *= 1000
        unit = 'מל'
    return {'value': value, 'unit': unit}

def ask_gemini_for_substitute(original_name, candidates):
    if not candidates:
        return None

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
    
    candidate_list = "\n".join([f"{i+1}. {c['name']}" for i, c in enumerate(candidates)])
    
    prompt = f"""אתה עוזר לבחור מוצר חלופי בסופרמרקט.
בהינתן מוצר מקורי ורשימת מוצרים אפשריים, בחר את התחליף הכי מתאים.

כללים חשובים:
- התחליף חייב להיות אותו סוג מוצר בדיוק (פתיתים=פתיתים, תירס שימורים=תירס שימורים, קוקה קולה=קוקה קולה או מותג קולה אחר)
- מותג שונה זה בסדר גמור בתנאי שהסוג והשימוש זהים לחלוטין
- קוסקוס זה לא פתיתים! אטריות זה לא אורז!
- ענה רק עם המספר של המוצר הנבחר (למשל: 1), או 0 אם אין אף חלופה מתאימה ברשימה.

מוצר מקורי: "{original_name}"

רשימת מוצרים אפשריים:
{candidate_list}

מספר:"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 5}
    }
    
    try:
        res = requests.post(url, json=payload, timeout=10)
        if res.status_code == 200:
            text = res.json()['candidates'][0]['content']['parts'][0]['text'].strip()
            digits = re.findall(r'\d+', text)
            if digits:
                choice = int(digits[0])
                if 1 <= choice <= len(candidates):
                    return candidates[choice - 1]
    except Exception as e:
        print(f" (AI error: {e})", end="")
    return None

def find_substitutes_locally(original_product, all_products, target_store):
    orig_barcode = original_product['barcode']
    orig_name = original_product['name']
    orig_weight = extract_weight(orig_name)
    
    candidates = []
    
    for barcode, p in all_products.items():
        if barcode == orig_barcode:
            continue
            
        # Must have code for the target store
        store_code = p.get(f"{target_store}_code")
        price = p.get(f"{target_store}_price")
        if not store_code:
            continue
            
        # Filter by weight compatibility
        weight = extract_weight(p['name'])
        if orig_weight and weight:
            # Must be same unit (grams with grams, ml with ml)
            if weight['unit'] != orig_weight['unit']:
                continue
            # Weight must be within 50% of the original product
            ratio = weight['value'] / orig_weight['value']
            if ratio < 0.5 or ratio > 2.0:
                continue
        elif orig_weight or weight:
            # If one has weight and the other doesn't, we can skip or penalize. Let's keep it but calculate similarity
            pass

        # Calculate name similarity using SequenceMatcher
        sim = SequenceMatcher(None, orig_name, p['name']).ratio()
        
        # Core token overlaps (simple check)
        words_orig = set(orig_name.split())
        words_cand = set(p['name'].split())
        overlap = len(words_orig & words_cand)
        
        # Score calculation
        score = sim * 100 + overlap * 10
        
        candidates.append({
            'barcode': barcode,
            'name': p['name'],
            'code': store_code,
            'price': price,
            'score': score
        })
        
    # Sort candidates by score descending
    candidates.sort(key=lambda x: x['score'], reverse=True)
    
    # Return top 5 candidates for Gemini to evaluate
    return candidates[:5]

def main():
    print("=" * 65)
    print("🤖 מחולל תחליפים אוטומטי - Supabase Substitutes Generator")
    print("=" * 65)
    
    global DB_PASSWORD
    password = DB_PASSWORD
    if not password:
        password = getpass.getpass("Enter your Supabase database password: ")

    try:
        conn = pg8000.dbapi.connect(
            host="db.icdethibkzwzguwmfoef.supabase.co",
            port=5432,
            database="postgres",
            user="postgres",
            password=password
        )
        cursor = conn.cursor()
        print("✅ Connected to Supabase.")
    except Exception as e:
        print(f"❌ Connection failed: {e}")
        return

    # 1. Fetch all products and prices from database into memory
    print("Loading database into memory...")
    all_products = {}
    try:
        cursor.execute("SELECT barcode, name FROM products")
        for barcode, name in cursor.fetchall():
            all_products[barcode] = {
                "name": name,
                "rami_levy_code": None,
                "rami_levy_price": None,
                "victory_code": None,
                "victory_price": None
            }

        cursor.execute("SELECT barcode, store_name, store_code, price FROM store_products")
        for barcode, store_name, store_code, price in cursor.fetchall():
            if barcode in all_products:
                all_products[barcode][f"{store_name}_code"] = store_code
                all_products[barcode][f"{store_name}_price"] = float(price) if price is not None else None
        print(f"✅ Loaded {len(all_products)} products.")
    except Exception as e:
        print(f"❌ Failed to load database: {e}")
        cursor.close()
        conn.close()
        return

    # 2. Select the first 10 products
    # We take the first 10 items from all_products
    first_10_barcodes = list(all_products.keys())[:10]
    
    print("\n🚀 Processing first 10 products for substitutes...")
    
    substitutes_to_insert = []
    
    for idx, barcode in enumerate(first_10_barcodes, 1):
        product = {
            'barcode': barcode,
            'name': all_products[barcode]['name']
        }
        print(f"\n[{idx}/10] Original: '{safe_str(product['name'])}'")
        
        # Generate for Rami Levy
        rl_candidates = find_substitutes_locally(product, all_products, 'rami_levy')
        rl_sub = ask_gemini_for_substitute(product['name'], rl_candidates)
        if rl_sub:
            print(f"  👉 Rami Levy Substitute: '{safe_str(rl_sub['name'])}' (Code: {rl_sub['code']})")
            substitutes_to_insert.append((barcode, rl_sub['code'], rl_sub['name'], 'rami_levy'))
        else:
            print("  ❌ Rami Levy Substitute: No suitable match found.")

        # Generate for Victory
        vic_candidates = find_substitutes_locally(product, all_products, 'victory')
        vic_sub = ask_gemini_for_substitute(product['name'], vic_candidates)
        if vic_sub:
            print(f"  👉 Victory Substitute:   '{safe_str(vic_sub['name'])}' (Code: {vic_sub['code']})")
            substitutes_to_insert.append((barcode, vic_sub['code'], vic_sub['name'], 'victory'))
        else:
            print("  ❌ Victory Substitute:   No suitable match found.")

        time.sleep(1.0) # Rate limit Gemini calls nicely

    # 3. Save to database
    if substitutes_to_insert:
        print(f"\n💾 Saving {len(substitutes_to_insert)} substitutes to database...")
        try:
            for barcode, sub_code, sub_name, store_name in substitutes_to_insert:
                cursor.execute(
                    """
                    INSERT INTO substitutes (original_barcode, substitute_code, substitute_name, store_name)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (original_barcode, store_name) DO UPDATE SET
                        substitute_code = EXCLUDED.substitute_code,
                        substitute_name = EXCLUDED.substitute_name,
                        created_at = now()
                    """,
                    (barcode, sub_code, sub_name, store_name)
                )
            conn.commit()
            print("🎉 Successfully saved first 10 products' substitutes!")
        except Exception as e:
            print(f"❌ Failed to save to database: {e}")
            conn.rollback()
    else:
        print("\nNo substitutes were generated.")

    cursor.close()
    conn.close()

if __name__ == '__main__':
    main()
