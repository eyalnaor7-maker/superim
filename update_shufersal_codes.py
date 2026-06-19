import requests
import urllib.parse
from bs4 import BeautifulSoup
import pg8000.dbapi
import getpass
import time
import random
import sys
import io

# Fix Windows terminal UTF-8 encoding support for Hebrew text
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def safe_str(val):
    return val.encode('ascii', errors='replace').decode('ascii')

def get_shufersal_product_data(product_name):
    encoded_name = urllib.parse.quote(product_name)
    url = f"https://www.shufersal.co.il/online/he/search?text={encoded_name}"
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://www.shufersal.co.il/online/he/"
    }

    try:
        response = requests.get(url, headers=headers, timeout=15)
        if response.status_code == 200:
            soup = BeautifulSoup(response.text, 'html.parser')
            cards = soup.find_all(attrs={"data-product-code": True})
            product_cards = [c for c in cards if c.name == 'li' and 'miglog-prod' in c.get('class', [])]

            if product_cards:
                first_card = product_cards[0]
                shufersal_code = first_card.get('data-product-code')
                
                # Extract price
                price_el = first_card.select_one('.price .number')
                price = float(price_el.get_text().strip()) if price_el else None
                
                return shufersal_code, price
    except Exception:
        pass
    return None, None

def main():
    print("=" * 65)
    print("🛒 שופרסל קודים פנימיים - Shufersal Database Sync Tool")
    print("=" * 65)
    
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

    # Find products in products table that are missing Shufersal code in store_products
    query = """
        SELECT p.barcode, p.name 
        FROM products p
        LEFT JOIN store_products sp ON p.barcode = sp.barcode AND sp.store_name = 'shufersal'
        WHERE sp.store_code IS NULL OR sp.store_code = ''
    """
    try:
        cursor.execute(query)
        targets = cursor.fetchall()
        print(f"🔍 Found {len(targets)} products missing Shufersal code.")
    except Exception as e:
        print(f"❌ Query failed: {e}")
        cursor.close()
        conn.close()
        return

    if not targets:
        print("✅ All products already have Shufersal codes in database.")
        cursor.close()
        conn.close()
        return

    updated_count = 0
    try:
        for idx, (barcode, name) in enumerate(targets, 1):
            print(f"[{idx}/{len(targets)}] Searching for '{safe_str(name)}'...", end=" ", flush=True)
            
            # Scrape Shufersal code and price
            shufersal_code, price = get_shufersal_product_data(name)
            
            if shufersal_code:
                # Upsert into store_products
                cursor.execute(
                    """
                    INSERT INTO store_products (barcode, store_name, store_code, price)
                    VALUES (%s, 'shufersal', %s, %s)
                    ON CONFLICT (barcode, store_name) DO UPDATE SET
                        store_code = EXCLUDED.store_code,
                        price = EXCLUDED.price,
                        updated_at = now()
                    """,
                    (barcode, shufersal_code, price)
                )
                conn.commit()
                updated_count += 1
                print(f"✅ Found Code: {shufersal_code} | Price: {price}")
            else:
                print("❌ Not found")
            
            # Delay to avoid rate limiting
            time.sleep(random.uniform(1.2, 2.5))
            
    except KeyboardInterrupt:
        print("\n🛑 Stopped manually by user.")

    print("\n" + "=" * 65)
    print(f"📊 Summary: Synced {updated_count} product codes to store_products table.")
    print("=" * 65)

    cursor.close()
    conn.close()

if __name__ == '__main__':
    main()
