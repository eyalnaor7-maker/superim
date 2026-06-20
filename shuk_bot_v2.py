import requests
import urllib.parse
import re
import os
import sys
import time
import argparse
from datetime import datetime, timezone
from difflib import SequenceMatcher
import io
import json

# Force terminal output to UTF-8 for Hebrew support
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Default Constants
SUPABASE_URL = "https://icdethibkzwzguwmfoef.supabase.co"
API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImljZGV0aGlia3p3emd1d21mb2VmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc8MTg1MzMxNywiZXhwIjoyMDk3NDI5MzE3fQ.Kni3uAk3mAEtLNNgsRxPwIX4KfKqSZ7kK2NZ0MJq750"
STORE_NAME = "machsanei_hashuk"
BRANCH_ID = 836  # Beer Sheva
GEMINI_API_KEY = ""

# Load config.json if exists
config_path = "config.json"
if os.path.exists(config_path):
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
            if cfg.get("supabase_url"):
                SUPABASE_URL = cfg["supabase_url"]
            if cfg.get("supabase_anon_key"):
                API_KEY = cfg["supabase_anon_key"]
            if cfg.get("gemini_api_key"):
                GEMINI_API_KEY = cfg["gemini_api_key"]
    except Exception as e:
        print(f"[!] Error reading config.json: {e}")

headers = {
    "apikey": API_KEY,
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

api_headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.mck.co.il",
    "Referer": "https://www.mck.co.il/"
}

def clean_product_name(name):
    if not name:
        return ""
    name = str(name).strip()
    
    # Remove common punctuation
    name = re.sub(r'[\-\_\.\,\!\?\/\\\(\)\[\]\{\}\'\"\'\`\:\;\+\#\&\*]', ' ', name)
    
    # Remove weights/volumes (numbers + unit)
    name = re.sub(r'\b\d+\s*(?:גרם|גר|ג|מ"ל|מל|ליטר|ל|ק"ג|קג|יח|יחידות|אחוז|%)\b', ' ', name)
    
    # Remove standalone units
    name = re.sub(r'\b(?:גרם|גר|ג|מ"ל|מל|ליטר|ל|ק"ג|קג|יח|יחידות|אחוז|%)\b', ' ', name)
    
    # Remove lone numbers
    name = re.sub(r'\b\d+(?:\.\d+)?\b', ' ', name)
    
    # Normalize spaces
    words = name.split()
    # Limit to first 4 words for a focused search query
    cleaned = " ".join(words[:4])
    return cleaned

def name_similarity(name1, name2):
    n1 = re.sub(r'[^\w\s]', '', name1.lower())
    n2 = re.sub(r'[^\w\s]', '', name2.lower())
    return SequenceMatcher(None, n1, n2).ratio()

def fetch_all_supabase_products():
    print("[*] Fetching products from Supabase 'products' table...")
    products = []
    limit = 1000
    offset = 0
    while True:
        url = f"{SUPABASE_URL}/rest/v1/products?select=barcode,name&limit={limit}&offset={offset}"
        try:
            r = requests.get(url, headers=headers)
            if r.status_code != 200:
                print(f"[X] Error fetching products: {r.text}")
                break
            data = r.json()
            if not data:
                break
            products.extend(data)
            if len(data) < limit:
                break
            offset += limit
        except Exception as e:
            print(f"[X] Exception fetching products: {e}")
            break
    print(f"[V] Loaded {len(products)} products from Supabase.")
    return products

def fetch_existing_store_products():
    print(f"[*] Fetching existing store products for '{STORE_NAME}'...")
    store_products = {}
    limit = 1000
    offset = 0
    while True:
        url = f"{SUPABASE_URL}/rest/v1/store_products?store_name=eq.{STORE_NAME}&select=id,barcode,store_code,price&limit={limit}&offset={offset}"
        try:
            r = requests.get(url, headers=headers)
            if r.status_code != 200:
                print(f"[X] Error fetching store products: {r.text}")
                break
            data = r.json()
            if not data:
                break
            for item in data:
                barcode = item.get('barcode')
                if barcode:
                    store_products[barcode] = item
            if len(data) < limit:
                break
            offset += limit
        except Exception as e:
            print(f"[X] Exception fetching store products: {e}")
            break
    print(f"[V] Loaded {len(store_products)} existing store mappings from Supabase.")
    return store_products

def search_by_barcode_api(clean_barcode):
    url = f"https://www.mck.co.il/v2/retailers/1107/branches/{BRANCH_ID}/products?appId=4&barcode={clean_barcode}"
    try:
        res = requests.get(url, headers=api_headers, timeout=10)
        if res.status_code == 200:
            return res.json().get('products', [])
    except Exception as e:
        print(f"      [!] Barcode API Exception: {e}")
    return []

def search_by_name_api(cleaned_name):
    # Method A: /products search query
    encoded_name = urllib.parse.quote(cleaned_name)
    url_products = f"https://www.mck.co.il/v2/retailers/1107/branches/{BRANCH_ID}/products?appId=4&query={encoded_name}"
    
    # Method B: autocomplete query
    filters_param = "%7B%22must%22:%7B%22exists%22:%5B%22family.id%22,%22family.categoriesPaths.id%22,%22branch.regularPrice%22%5D,%22term%22:%7B%22branch.isActive%22:true,%22branch.isVisible%22:true%7D%7D,%22mustNot%22:%7B%22term%22:%7B%22branch.regularPrice%22:0%7D%7D%7D"
    url_auto = f"https://www.mck.co.il/v2/retailers/1107/branches/{BRANCH_ID}/products/autocomplete?appId=4&filters={filters_param}&from=0&isSearch=true&languageId=1&size=10&query={encoded_name}"
    
    candidates = []
    seen_ids = set()
    
    # Query Products Search
    try:
        r = requests.get(url_products, headers=api_headers, timeout=10)
        if r.status_code == 200:
            for p in r.json().get('products', []):
                p_id = p.get('id')
                if p_id and p_id not in seen_ids:
                    seen_ids.add(p_id)
                    candidates.append(p)
    except Exception as e:
        print(f"      [!] Name Search API Exception: {e}")

    # Query Autocomplete
    try:
        r = requests.get(url_auto, headers=api_headers, timeout=10)
        if r.status_code == 200:
            auto_prods = r.json().get('suggestions', {}).get('suggestProducts', {}).get('products', [])
            for p in auto_prods:
                p_id = p.get('id')
                if p_id and p_id not in seen_ids:
                    seen_ids.add(p_id)
                    candidates.append(p)
    except Exception as e:
        print(f"      [!] Autocomplete API Exception: {e}")
        
    return candidates

def ask_gemini_for_match(db_name, candidates):
    if not GEMINI_API_KEY:
        return None
        
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
    
    candidate_lines = []
    for idx, c in enumerate(candidates):
        c_name = c.get('localName') or c.get('name')
        branch = c.get('branch', {})
        c_price = branch.get('regularPrice') or branch.get('price')
        candidate_lines.append(f"{idx+1}. {c_name} (מחיר: {c_price} ש\"ח)")
        
    candidate_list = "\n".join(candidate_lines)
    
    prompt = f"""אתה עוזר להשוות מוצרים בין סופרמרקטים שונים כדי למצוא את המוצר המדויק.
בהינתן מוצר מטרה מבסיס הנתונים ורשימת מוצרים שנמצאו באתר "מחסני השוק", בחר את המוצר שהוא בדיוק אותו מוצר (יכול להיות שינוי קל בניסוח השם או בסידור המילים, אך מדובר באותו מוצר, אותו יצרן, אותם אחוזים ואותו נפח/משקל).

כללים חשובים ביותר:
1. בחר אך ורק את המוצר המדויק.
2. אל תבחר מוצר שהוא בטעם אחר, משקל אחר, או מוצר דומה אך לא אותו אחד (למשל: "קוקה קולה זירו 1.5 ליטר" ו-"קוקה קולה זירו 1 ליטר" הם מוצרים שונים! "פריגת תפוזים" ו-"פריגת ענבים" הם מוצרים שונים! "פירורי לחם מוזהבים" ו-"פירורי לחם לבנים" הם מוצרים שונים!).
3. החזר את מספר האינדקס של המוצר המתאים ביותר (החל מ-1).
4. אם אף אחד מהמוצרים ברשימה אינו המוצר המדויק, החזר 0.
5. החזר אך ורק מספר בודד המייצג את האינדקס, ללא מילים נוספות וללא סימני פיסוק.

מוצר מטרה: "{db_name}"

רשימת מועמדים מאתר מחסני השוק:
{candidate_list}

תשובה (מספר אינדקס או 0):"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 10}
    }
    
    for attempt in range(3):
        try:
            r = requests.post(url, json=payload, timeout=10)
            if r.status_code == 200:
                res_data = r.json()
                cands = res_data.get('candidates', [])
                if cands:
                    content = cands[0].get('content', {})
                    parts = content.get('parts', [])
                    if parts:
                        text = parts[0].get('text', '').strip()
                        match = re.search(r'\d+', text)
                        if match:
                            val = int(match.group())
                            if 1 <= val <= len(candidates):
                                return candidates[val - 1]
                            elif val == 0:
                                return None
            elif r.status_code == 429:
                print("      [!] Gemini API returned 429 (Quota/Rate Limit Exceeded). Will fall back to local matching.")
                return None
            time.sleep(1)
        except Exception as e:
            print(f"      [!] Gemini API Call Exception: {e}")
            time.sleep(1)
            
    return None

def save_to_supabase(db_barcode, internal_id, price, existing_item):
    now_str = datetime.now(timezone.utc).isoformat()
    
    store_code_val = str(internal_id) if internal_id is not None else None
    price_val = float(price) if price is not None else None
    
    if existing_item:
        record_id = existing_item['id']
        url = f"{SUPABASE_URL}/rest/v1/store_products?id=eq.{record_id}"
        payload = {
            "store_code": store_code_val,
            "price": price_val,
            "updated_at": now_str
        }
        try:
            r = requests.patch(url, headers=headers, json=payload)
            if r.status_code in [200, 204]:
                return True, "Updated"
            else:
                return False, f"PATCH Error {r.status_code}: {r.text}"
        except Exception as e:
            return False, f"PATCH Exception: {e}"
    else:
        url = f"{SUPABASE_URL}/rest/v1/store_products"
        payload = {
            "barcode": db_barcode,
            "store_name": STORE_NAME,
            "store_code": store_code_val,
            "price": price_val,
            "updated_at": now_str
        }
        try:
            r = requests.post(url, headers=headers, json=payload)
            if r.status_code in [200, 201, 204]:
                return True, "Inserted"
            else:
                return False, f"POST Error {r.status_code}: {r.text}"
        except Exception as e:
            return False, f"POST Exception: {e}"

def main():
    parser = argparse.ArgumentParser(description="Machsanei HaShuk Smart Scraper Bot v2")
    parser.add_argument("-l", "--limit", type=int, default=0, help="Limit number of items to search (0 for unlimited)")
    parser.add_argument("-o", "--offset", type=int, default=0, help="Start offset index in target list")
    args = parser.parse_args()
    
    print("==================================================")
    print("      MACHSANEI HASHUK SMART SCRAPER BOT V2       ")
    print("==================================================")
    
    products = fetch_all_supabase_products()
    existing_store_products = fetch_existing_store_products()
    
    targets = []
    for p in products:
        barcode = p.get('barcode')
        name = p.get('name')
        if not barcode:
            continue
            
        existing = existing_store_products.get(barcode)
        is_unmapped = False
        
        if not existing:
            is_unmapped = True
        else:
            store_code = existing.get('store_code')
            if store_code is None or store_code in ('None', ''):
                is_unmapped = True
                
        if is_unmapped:
            targets.append({
                "barcode": barcode,
                "name": name,
                "existing": existing
            })
            
    total_targets = len(targets)
    print(f"[V] Found {total_targets} products needing mapping.")
    
    if args.offset >= total_targets:
        print("[!] Offset index out of range. Stopping.")
        return
        
    slice_targets = targets[args.offset:]
    if args.limit > 0:
        slice_targets = slice_targets[:args.limit]
        
    print(f"[*] Will process {len(slice_targets)} products (starting from target index {args.offset}).")
    
    processed = 0
    matched_barcode = 0
    matched_name = 0
    unmapped_saved = 0
    success_db = 0
    failed_db = 0
    
    for idx, target in enumerate(slice_targets, 1):
        db_barcode = target["barcode"]
        db_name = target["name"]
        existing = target["existing"]
        clean_barcode = db_barcode.replace("P_", "").strip()
        
        processed += 1
        print(f"\n[{processed}/{len(slice_targets)}] (אינדקס יעד: {args.offset + idx - 1})")
        print(f"  ברקוד: {clean_barcode} | שם: '{db_name}'")
        
        best_cand = None
        match_method = ""
        
        # --- STEP 1: Strict Barcode API query ---
        candidates = search_by_barcode_api(clean_barcode)
        if candidates:
            # Filter candidates: prefer active & visible
            for c in candidates:
                branch = c.get('branch', {})
                if branch.get('isActive') and branch.get('isVisible'):
                    best_cand = c
                    match_method = "Barcode (Active & Visible)"
                    break
            if not best_cand:
                for c in candidates:
                    branch = c.get('branch', {})
                    if branch.get('isActive'):
                        best_cand = c
                        match_method = "Barcode (Active)"
                        break
            if not best_cand:
                best_cand = candidates[0]
                match_method = "Barcode (First Result)"
                
            matched_barcode += 1
            
        # --- STEP 2: Name Search Fallback (if no barcode match) ---
        if not best_cand:
            cleaned_name = clean_product_name(db_name)
            if cleaned_name:
                print(f"  [-] חיפוש ישיר נכשל. מחפש לפי שם מנוקה: '{cleaned_name}'...")
                name_candidates = search_by_name_api(cleaned_name)
                
                # Check for indirect barcode match in name search suggestions
                for c in name_candidates:
                    c_barcode = c.get('barcode') or c.get('localBarcode')
                    if c_barcode:
                        clean_c_barcode = str(c_barcode).strip().lstrip('0')
                        clean_target_barcode = clean_barcode.lstrip('0')
                        if clean_c_barcode == clean_target_barcode:
                            best_cand = c
                            match_method = "Name Search (Indirect Barcode Match)"
                            matched_barcode += 1
                            break
                            
                # Check for fuzzy name match
                if not best_cand and name_candidates:
                    similar_candidates = []
                    for c in name_candidates:
                        c_name = c.get('localName') or c.get('name')
                        sim = name_similarity(db_name, c_name)
                        if sim >= 0.5:
                            similar_candidates.append((sim, c))
                            
                    similar_candidates.sort(key=lambda x: x[0], reverse=True)
                    
                    if similar_candidates:
                        # If highly similar, map directly
                        if similar_candidates[0][0] >= 0.85:
                            best_cand = similar_candidates[0][1]
                            match_method = f"Name Search (Fuzzy Match: {similar_candidates[0][0]:.2f})"
                            matched_name += 1
                        else:
                            # Use Gemini to choose the exact match
                            top_candidates = [x[1] for x in similar_candidates[:5]]
                            print(f"    [*] מפעיל את Gemini למיון {len(top_candidates)} מועמדים דומים...")
                            gemini_match = ask_gemini_for_match(db_name, top_candidates)
                            if gemini_match:
                                best_cand = gemini_match
                                c_name = best_cand.get('localName') or best_cand.get('name')
                                match_method = f"Gemini LLM Match ('{c_name}')"
                                matched_name += 1
                                time.sleep(1.5)
                            else:
                                # Fallback: if Gemini fails or returns 429/None, check if top candidate is >= 0.82
                                top_sim, top_cand = similar_candidates[0]
                                if top_sim >= 0.82:
                                    best_cand = top_cand
                                    match_method = f"Fuzzy Name Fallback (Similarity: {top_sim:.2f})"
                                    matched_name += 1
                                    print(f"    [*] גיבוי ללא-Gemini: משתמש בדמיון טקסט מנוקה ({top_sim:.2f}) עבור: '{top_cand.get('localName') or top_cand.get('name')}'")
                                else:
                                    print("    [-] לא נמצאה התאמה מדויקת (גם לא דרך גיבוי דמיון טקסט).")
                                
        # --- STEP 3: Database Write ---
        if best_cand:
            p_id = best_cand.get('id')
            branch = best_cand.get('branch', {})
            p_price = branch.get('regularPrice') or branch.get('price')
            p_name = best_cand.get('localName') or best_cand.get('name')
            
            print(f"  [V] התאמה נמצאה באמצעות {match_method}!")
            print(f"      קוד: {p_id} | מחיר: {p_price} ש\"ח | שם באתר: '{p_name}'")
            
            success, action = save_to_supabase(db_barcode, p_id, p_price, existing)
        else:
            print("  [-] לא נמצאה התאמה. שומר כ-NULL (לא נמכר ברשת).")
            success, action = save_to_supabase(db_barcode, None, None, existing)
            unmapped_saved += 1
            
        if success:
            success_db += 1
            print(f"      [V] בסיס הנתונים עודכן בהצלחה ({action}).")
        else:
            failed_db += 1
            print(f"      [X] עדכון בסיס הנתונים נכשל: {action}")
            
        time.sleep(0.35)
        
    print("\n==================================================")
    print("                  סיכום ריצה                      ")
    print("==================================================")
    print(f"מוצרים שסרקו:             {processed}")
    print(f"התאמות ברקוד מוצלחות:     {matched_barcode}")
    print(f"התאמות שם/Gemini מוצלחות:  {matched_name}")
    print(f"סומנו כלא קיימים (NULL):   {unmapped_saved}")
    print(f"עדכונים מוצלחים ב-DB:      {success_db}")
    print(f"עדכוני DB שנכשלו:         {failed_db}")
    print("==================================================")

if __name__ == "__main__":
    main()
