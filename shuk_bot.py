import requests
import xml.etree.ElementTree as ET
import urllib.parse
import re
import os
import sys
import time
import argparse
from datetime import datetime, timezone

# Constants
SUPABASE_URL = "https://icdethibkzwzguwmfoef.supabase.co"
API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImljZGV0aGlia3p3emd1d21mb2VmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTg1MzMxNywiZXhwIjoyMDk3NDI5MzE3fQ.Kni3uAk3mAEtLNNgsRxPwIX4KfKqSZ7kK2NZ0MJq750"
STORE_NAME = "machsanei_hashuk"
BRANCH_ID = 836  # Beer Sheva
XML_PATH = "PriceFull7290058140886-001-070-20260411-001008.xml"

headers = {
    "apikey": API_KEY,
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

def parse_xml():
    """Parses MCK XML file to get mapping of barcode -> (name, price)"""
    if not os.path.exists(XML_PATH):
        print(f"[!] XML file not found at {XML_PATH}, will fallback to DB names only.")
        return {}
        
    print(f"[*] Parsing XML file: {XML_PATH}...")
    try:
        with open(XML_PATH, 'rb') as f:
            raw = f.read()
        text = raw.decode('utf-8', errors='replace')
        clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
        
        root = ET.fromstring(clean.encode('utf-8'))
        items_dict = {}
        for item in root.iter('Item'):
            code_elem = item.find('ItemCode')
            name_elem = item.find('ItemName')
            price_elem = item.find('ItemPrice')
            
            if code_elem is not None and name_elem is not None and price_elem is not None:
                barcode = code_elem.text.strip() if code_elem.text else ""
                name = name_elem.text.strip() if name_elem.text else ""
                price_str = price_elem.text.strip() if price_elem.text else "0"
                try:
                    price = float(price_str)
                except ValueError:
                    price = 0.0
                
                if barcode and name:
                    items_dict[barcode] = {"name": name, "price": price}
        print(f"[V] Loaded {len(items_dict)} items from XML.")
        return items_dict
    except Exception as e:
        print(f"[X] Error parsing XML: {e}")
        return {}

def get_all_supabase_products():
    """Fetches all products from 'products' table using pagination"""
    print("[*] Fetching products from Supabase 'products' table...")
    products = []
    limit = 1000
    offset = 0
    
    while True:
        url = f"{SUPABASE_URL}/rest/v1/products?select=*&limit={limit}&offset={offset}"
        try:
            r = requests.get(url, headers=headers)
            if r.status_code != 200:
                print(f"[X] Error fetching products: {r.text}")
                break
            data = r.json()
            if not data:
                break
            products.extend(data)
            print(f"    Fetched {len(data)} products (Total: {len(products)})...")
            if len(data) < limit:
                break
            offset += limit
        except Exception as e:
            print(f"[X] Exception fetching products: {e}")
            break
            
    print(f"[V] Loaded {len(products)} products from Supabase.")
    return products

def get_existing_store_products():
    """Fetches existing mappings for machsanei_hashuk from 'store_products' table"""
    print(f"[*] Fetching existing store products for '{STORE_NAME}'...")
    store_products = {}
    limit = 1000
    offset = 0
    
    while True:
        url = f"{SUPABASE_URL}/rest/v1/store_products?store_name=eq.{STORE_NAME}&select=*&limit={limit}&offset={offset}"
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
            print(f"    Fetched {len(data)} mappings (Total: {len(store_products)})...")
            if len(data) < limit:
                break
            offset += limit
        except Exception as e:
            print(f"[X] Exception fetching store products: {e}")
            break
            
    print(f"[V] Loaded {len(store_products)} existing store mappings from Supabase.")
    return store_products

def search_mck_api(barcode, name_from_xml, name_from_db):
    """Searches MCK API by barcode and then by name to find product ID and live price"""
    search_queries = []
    
    # Query 1: barcode
    search_queries.append(str(barcode))
    
    # Query 2: name from XML (usually better matched)
    if name_from_xml:
        search_queries.append(" ".join(name_from_xml.split()[:4]))
        
    # Query 3: name from DB
    if name_from_db:
        search_queries.append(" ".join(name_from_db.split()[:4]))
        
    # Standard filter for MCK API
    filters_param = "%7B%22must%22:%7B%22exists%22:%5B%22family.id%22,%22family.categoriesPaths.id%22,%22branch.regularPrice%22%5D,%22term%22:%7B%22branch.isActive%22:true,%22branch.isVisible%22:true%7D%7D,%22mustNot%22:%7B%22term%22:%7B%22branch.regularPrice%22:0%7D%7D%7D"
    
    api_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Origin": "https://www.mck.co.il",
        "Referer": "https://www.mck.co.il/"
    }
    
    # Dedup search queries maintaining order
    seen = set()
    unique_queries = []
    for q in search_queries:
        if q and q not in seen:
            seen.add(q)
            unique_queries.append(q)
            
    for q in unique_queries:
        encoded_q = urllib.parse.quote(q)
        url = f"https://www.mck.co.il/v2/retailers/1107/branches/{BRANCH_ID}/products/autocomplete?appId=4&filters={filters_param}&from=0&isSearch=true&languageId=1&size=10&query={encoded_q}"
        try:
            r = requests.get(url, headers=api_headers)
            if r.status_code == 200:
                data = r.json()
                products = data.get('suggestions', {}).get('suggestProducts', {}).get('products', [])
                for p in products:
                    prod_barcode = p.get('barcode') or p.get('localBarcode')
                    if str(prod_barcode) == str(barcode):
                        # Match found! Extract ID and Price
                        prod_id = p.get('id')
                        # Fetch price, prefer regularPrice or price
                        price = p.get('branch', {}).get('regularPrice') or p.get('branch', {}).get('price')
                        try:
                            price_val = float(price) if price is not None else None
                        except ValueError:
                            price_val = None
                            
                        return prod_id, price_val, p.get('localName')
        except Exception as e:
            print(f"      [!] API Exception for query '{q}': {e}")
            
    return None, None, None

def save_to_supabase(db_barcode, internal_id, price, existing_item):
    """Inserts or updates mapping in store_products"""
    now_str = datetime.now(timezone.utc).isoformat()
    
    if existing_item:
        # Perform update (PATCH)
        record_id = existing_item['id']
        url = f"{SUPABASE_URL}/rest/v1/store_products?id=eq.{record_id}"
        payload = {
            "store_code": str(internal_id),
            "price": price,
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
        # Perform insert (POST)
        url = f"{SUPABASE_URL}/rest/v1/store_products"
        payload = {
            "barcode": db_barcode,
            "store_name": STORE_NAME,
            "store_code": str(internal_id),
            "price": price,
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
    parser = argparse.ArgumentParser(description="Machsanei HaShuk Supabase Scraper Bot")
    parser.add_argument("-l", "--limit", type=int, default=0, help="Limit number of items to search (0 for unlimited)")
    args = parser.parse_args()
    
    print("==================================================")
    print("      MACHSANEI HASHUK SUPABASE SCRAPER BOT       ")
    print("==================================================")
    
    xml_data = parse_xml()
    products = get_all_supabase_products()
    existing_store_products = get_existing_store_products()
    
    print(f"[V] Total products in database: {len(products)}")
    
    processed = 0
    matched = 0
    unmapped_saved = 0
    updated = 0
    inserted = 0
    failed = 0
    
    print("\n[*] Starting mapping process...")
    for idx, p in enumerate(products):
        if args.limit > 0 and processed >= args.limit:
            print(f"\n[*] Reached limit of {args.limit} processed items. Stopping.")
            break
            
        db_barcode = p.get('barcode', '')
        # Clean barcode (remove 'P_' prefix)
        clean_barcode = db_barcode.replace("P_", "").strip()
        db_name = p.get('name', '')
        
        if not clean_barcode:
            continue
            
        processed += 1
        print(f"\n[{processed}/{args.limit if args.limit > 0 else len(products)}] Barcode: {clean_barcode} | DB Name: '{db_name}'")
        
        # Get XML details if available
        xml_info = xml_data.get(clean_barcode)
        xml_name = xml_info['name'] if xml_info else None
        xml_price = xml_info['price'] if xml_info else None
        
        # Get existing database item mapping
        existing_item = existing_store_products.get(db_barcode)
        
        # Case 1: Product does not exist in the XML price list (definitely not sold)
        if clean_barcode not in xml_data:
            # If it's already in DB, we don't need to do anything (it's already saved as unmapped)
            if existing_item:
                print("    [V] Product not in XML and already mapped in DB as unmapped. Skipping.")
                continue
                
            print("    [-] Product not found in XML price list. Saving as unmapped.")
            success, action = save_to_supabase(db_barcode, None, None, None)
            if success:
                print(f"    [V] Database: {action} successfully (empty store_code).")
                if action == "Updated":
                    updated += 1
                else:
                    inserted += 1
                unmapped_saved += 1
            else:
                print(f"    [X] Database: Save failed! Reason: {action}")
                failed += 1
            continue
            
        # Case 2: Product exists in XML, check if we already processed it
        if existing_item:
            # We already have a DB entry (can be mapped with a code, or empty)
            store_code = existing_item.get('store_code')
            db_price = float(existing_item.get('price')) if existing_item.get('price') is not None else None
            
            if xml_price is not None and xml_price != db_price:
                print(f"    [V] Already processed (Code: '{store_code}'). Updating price in DB: {db_price} -> {xml_price} NIS")
                success, action = save_to_supabase(db_barcode, store_code, xml_price, existing_item)
                if success:
                    updated += 1
                else:
                    print(f"    [X] DB update failed: {action}")
            else:
                print(f"    [V] Already processed (Code: '{store_code}') and price is up to date. Skipping API.")
            continue
            
        # Case 3: Product exists in XML but has not been processed yet
        print(f"    - XML Name: '{xml_name}' (Price: {xml_price} NIS)")
        
        # Search the API
        internal_id, live_price, site_name = search_mck_api(clean_barcode, xml_name, db_name)
        
        if internal_id:
            matched += 1
            # Prefer live price from site, fallback to XML price
            final_price = live_price if live_price is not None else xml_price
            print(f"    [V] Match: ID={internal_id}, Price={final_price} NIS ('{site_name}')")
            
            # Save mapped product to database
            success, action = save_to_supabase(db_barcode, internal_id, final_price, existing_item)
            if success:
                print(f"    [V] Database: {action} successfully.")
                if action == "Updated":
                    updated += 1
                else:
                    inserted += 1
            else:
                print(f"    [X] Database: Save failed! Reason: {action}")
                failed += 1
        else:
            print("    [-] Match not found on site. Saving as unmapped with XML price.")
            success, action = save_to_supabase(db_barcode, None, xml_price, existing_item)
            if success:
                print(f"    [V] Database: {action} successfully (empty store_code, XML price).")
                if action == "Updated":
                    updated += 1
                else:
                    inserted += 1
                unmapped_saved += 1
            else:
                print(f"    [X] Database: Save failed! Reason: {action}")
                failed += 1
                
        # Rate limit spacing (optimized to 0.25s)
        time.sleep(0.25)
        
    print("\n==================================================")
    print("                  RUN SUMMARY                     ")
    print("==================================================")
    print(f"Processed items:  {processed}")
    print(f"Matched on site:  {matched}")
    print(f"Saved as unmapped: {unmapped_saved}")
    print(f"  - Database updates: {updated}")
    print(f"  - Database inserts: {inserted}")
    print(f"Failed DB writes: {failed}")
    print(f"Not found on site: {processed - matched}")
    print("==================================================")

if __name__ == "__main__":
    main()
