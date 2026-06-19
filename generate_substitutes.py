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

USE_GEMINI = True
GEMINI_API_KEY = "AIzaSyCu_EXWBvOSXoMn_9lqB_e3JFm7wZ702Bk"

# Load keys from config.json if available
if os.path.exists('config.json'):
    try:
        with open('config.json', 'r', encoding='utf-8') as f:
            cfg = json.load(f)
            if cfg.get('gemini_api_key') and cfg['gemini_api_key'] != "YOUR_GEMINI_API_KEY":
                GEMINI_API_KEY = cfg['gemini_api_key']
            if cfg.get('supabase_db_password') and cfg['supabase_db_password'] != "YOUR_SUPABASE_DATABASE_PASSWORD":
                DB_PASSWORD = cfg['supabase_db_password']
    except Exception:
        pass

def safe_str(val):
    return val.encode('ascii', errors='replace').decode('ascii')

def extract_pack_size(name):
    # Match text patterns
    if 'שישייה' in name or 'שישיה' in name:
        return 6
    if 'רביעייה' in name or 'רביעיה' in name:
        return 4
    if 'זוג' in name:
        return 2
        
    # Match "6*330" or "6 * 330" or "6x330"
    match = re.search(r'(\d+)\s*[\*xX]\s*\d+', name)
    if match:
        return int(match.group(1))

    # Match "6 יח" or "6 יחידות" or "6 יח'"
    match = re.search(r'(\d+)\s*(יח\'|יחידות|יח)', name)
    if match:
        return int(match.group(1))
        
    return 1

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

def ask_gemini_for_substitutes(original_name, candidates):
    if not candidates:
        return None, None

    # We use gemini-2.0-flash as the default model
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}"
    
    candidate_list = "\n".join([f"{i+1}. {c['name']}" for i, c in enumerate(candidates)])
    
    prompt = f"""אתה עוזר לבחור מוצרים חלופיים בסופרמרקט.
בהינתן מוצר מקורי ורשימת מוצרים אפשריים, בחר את 2 התחליפים הכי מתאימים (עדיפות ראשונה ועדיפות שנייה).

כללים חשובים ביותר:
1. בחר מוצר שהוא החלופה הכי טובה - מוצר דומה מבחינת סוג ושימוש, אך לא חייב להיות זהה לחלוטין (למשל: בירה ממותג X יכולה להחליף בירה ממותג Y).
2. אל תבחר תחליף לא מתאים ששונה מהותית בקטגוריה (למשל קוסקוס זה לא פתיתים! אטריות זה לא אורז! בירה שחורה זה לא בירה לבנה! משחת שיניים זה לא מברשת שיניים!).
3. אם יש רק תחליף מתאים אחד ברשימה, בחר אותו כעדיפות ראשונה, ועבור עדיפות שנייה בחר 0.
4. אם אין אף חלופה מתאימה בכלל, החזר 0 עבור שתי העדיפויות.
5. החזר את התשובה בפורמט של שני מספרים מופרדים בפסיק בלבד, ללא מילים נוספות. 
לדוגמה:
- אם הראשון והשלישי מתאימים: 1, 3
- אם רק השני מתאים: 2, 0
- אם אף אחד לא מתאים: 0, 0

מוצר מקורי: "{original_name}"

רשימת מוצרים אפשריים:
{candidate_list}

תשובה (בפורמט 'מספר, מספר'):"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 10}
    }
    
    try:
        res = requests.post(url, json=payload, timeout=10)
        if res.status_code == 200:
            text = res.json()['candidates'][0]['content']['parts'][0]['text'].strip()
            digits = re.findall(r'\d+', text)
            if len(digits) >= 2:
                idx1, idx2 = int(digits[0]), int(digits[1])
                sub1 = candidates[idx1 - 1] if 1 <= idx1 <= len(candidates) else None
                sub2 = candidates[idx2 - 1] if 1 <= idx2 <= len(candidates) else None
                return sub1, sub2
            elif len(digits) == 1:
                idx1 = int(digits[0])
                sub1 = candidates[idx1 - 1] if 1 <= idx1 <= len(candidates) else None
                return sub1, None
        elif res.status_code == 403:
            print(" (AI error: API key is invalid or leaked. Please update the gemini_api_key in config.json)", end="")
        elif res.status_code == 429:
            print(" (AI error: API rate limit/quota exceeded)", end="")
        else:
            print(f" (AI error: HTTP {res.status_code})", end="")
    except Exception as e:
        print(f" (AI error: {e})", end="")
    return None, None

STOP_WORDS_HEB = {
    'גרם', 'מ"ל', 'מל', 'ליטר', 'ק"ג', 'קג', 'יח', 'יחידות', 'של', 'עם', 'בלי', 
    'ו', 'ב', 'ל', 'מ', 'פרוס', 'טרי', 'קפוא', 'בטעם', 'מארז', 'בקבוק', 'פחית', 
    'שקית', 'קופסה', 'קופסא', 'יחידה', 'חבילה', 'מארזים', 'בקר'
}

def get_significant_words(name):
    # Extract words with 2 or more letters, ignoring numbers
    words = re.findall(r'\b[א-תa-zA-Z]{2,}\b', name.lower())
    return {w for w in words if w not in STOP_WORDS_HEB}

def find_candidates_locally(original_product, all_products, precomputed):
    orig_barcode = original_product['barcode']
    orig_name = original_product['name']
    
    orig_meta = precomputed[orig_barcode]
    orig_pack = orig_meta['pack_size']
    orig_weight = orig_meta['weight']
    sig_words_orig = orig_meta['sig_words']
    
    candidates = []
    
    for barcode, p in all_products.items():
        if barcode == orig_barcode:
            continue
            
        # Must have code for at least one store
        if not (p.get("rami_levy_code") or p.get("victory_code") or p.get("shufersal_code")):
            continue
            
        cand_meta = precomputed[barcode]
        
        # Pack size matching: multi-packs must substitute with matching multi-packs
        if orig_pack != cand_meta['pack_size']:
            continue

        # Ensure there is at least one significant overlapping word to prevent cross-category matches
        sig_words_cand = cand_meta['sig_words']
        sig_overlap = len(sig_words_orig & sig_words_cand)
        if sig_overlap == 0:
            continue

        # Filter by weight compatibility
        weight = cand_meta['weight']
        if orig_weight and weight:
            if weight['unit'] != orig_weight['unit']:
                continue
            ratio = weight['value'] / orig_weight['value']
            if ratio < 0.5 or ratio > 2.0:
                continue

        # Calculate name similarity using SequenceMatcher (only runs on filtered candidates!)
        sim = SequenceMatcher(None, orig_name, p['name']).ratio()
        
        # Token overlap (using all tokens including brands, but excluding stop words)
        words_orig = set(orig_name.split())
        words_cand = set(p['name'].split())
        overlap = len(words_orig & words_cand)
        
        # Discard extremely low similarities early to prevent bad substitutes
        if sim < 0.35 and overlap == 0:
            continue
            
        score = sim * 100 + overlap * 10
        
        candidates.append({
            'barcode': barcode,
            'name': p['name'],
            'score': score
        })
        
    candidates.sort(key=lambda x: x['score'], reverse=True)
    
    # Return top 5 candidates
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
                "victory_price": None,
                "shufersal_code": None,
                "shufersal_price": None
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

    # Precompute metadata for all products to boost performance
    print("Pre-computing product metadata...")
    precomputed = {}
    for barcode, p in all_products.items():
        precomputed[barcode] = {
            'pack_size': extract_pack_size(p['name']),
            'weight': extract_weight(p['name']),
            'sig_words': get_significant_words(p['name'])
        }
    print("✅ Metadata pre-computed.")

    # 2. Select products to process
    RUN_LIMIT = 20  # Set to None to run on all products
    
    all_barcodes = list(all_products.keys())
    if RUN_LIMIT is not None:
        barcodes_to_run = all_barcodes[:RUN_LIMIT]
        print(f"\n🚀 Processing first {RUN_LIMIT} products for substitutes (AI Mode)...")
    else:
        barcodes_to_run = all_barcodes
        print(f"\n🚀 Processing ALL {len(barcodes_to_run)} products for substitutes (AI Mode)...")
    
    substitutes_to_insert = []
    
    for idx, barcode in enumerate(barcodes_to_run, 1):
        product = {
            'barcode': barcode,
            'name': all_products[barcode]['name']
        }
        
        # Generate candidates
        candidates = find_candidates_locally(product, all_products, precomputed)
        
        sub1, sub2 = None, None
        if USE_GEMINI:
            sub1, sub2 = ask_gemini_for_substitutes(product['name'], candidates)
        else:
            # Local matching engine (no API costs)
            if candidates:
                if candidates[0]['score'] >= 50:
                    sub1 = candidates[0]
                    if len(candidates) >= 2 and candidates[1]['score'] >= 45:
                        sub2 = candidates[1]

        # Display and accumulate results if we found matches
        if sub1 or sub2:
            print(f"\n[{idx}/{len(barcodes_to_run)}] Original: '{product['name']}'")
            if sub1:
                print(f"  👉 Primary Substitute:   '{sub1['name']}' (Barcode: {sub1['barcode']}, Score: {sub1['score']:.1f})")
            if sub2:
                print(f"  👉 Secondary Substitute: '{sub2['name']}' (Barcode: {sub2['barcode']}, Score: {sub2['score']:.1f})")
            
            substitutes_to_insert.append((
                barcode, 
                sub1['barcode'] if sub1 else None, 
                sub2['barcode'] if sub2 else None
            ))
        else:
            # Log skipped products only when processing a limited batch to avoid flooding stdout
            if RUN_LIMIT is not None:
                print(f"\n[{idx}/{len(barcodes_to_run)}] Original: '{product['name']}'")
                print("  ❌ No suitable substitutes found (left empty).")

        if USE_GEMINI:
            time.sleep(1.0) # Rate limit Gemini calls nicely

    # 3. Save to database
    if substitutes_to_insert:
        print(f"\n💾 Saving {len(substitutes_to_insert)} substitutes to database...")
        try:
            batch_size = 200
            for i in range(0, len(substitutes_to_insert), batch_size):
                batch = substitutes_to_insert[i:i+batch_size]
                placeholders = ",".join(["(%s, %s, %s)"] * len(batch))
                query = f"""
                    INSERT INTO substitutes (original_barcode, substitute_barcode_1, substitute_barcode_2)
                    VALUES {placeholders}
                    ON CONFLICT (original_barcode) DO UPDATE SET
                        substitute_barcode_1 = EXCLUDED.substitute_barcode_1,
                        substitute_barcode_2 = EXCLUDED.substitute_barcode_2,
                        created_at = now()
                """
                params = [val for row in batch for val in row]
                cursor.execute(query, params)
            conn.commit()
            print("Success: Successfully saved substitutes to database!")
        except Exception as e:
            print(f"Error: Failed to save to database: {e}")
            conn.rollback()
    else:
        print("\nNo substitutes were generated.")

    cursor.close()
    conn.close()

if __name__ == '__main__':
    main()
