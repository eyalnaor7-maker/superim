import requests
import urllib.parse
from bs4 import BeautifulSoup
import sys
import io

# Fix Windows terminal UTF-8 encoding support for Hebrew text
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

def get_shufersal_product_code(product_name):
    print(f"[*] מתחיל חיפוש עבור: '{product_name}'...")
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
            
            # Find all product elements with data-product-code attribute
            cards = soup.find_all(attrs={"data-product-code": True})
            # Filter only list items (li) containing the main product grid details
            product_cards = [c for c in cards if c.name == 'li' and 'miglog-prod' in c.get('class', [])]

            if product_cards:
                # Take the first matched product card
                first_card = product_cards[0]
                
                shufersal_code = first_card.get('data-product-code')
                
                # Extract product name
                name_el = first_card.find('strong')
                shufersal_name = name_el.get_text().strip() if name_el else "לא נמצא שם"

                print(f"[V] הצלחה! הקוד הפנימי של שופרסל הוא: {shufersal_code}")
                print(f"[V] השם של המוצר באתר שלהם הוא: {shufersal_name}")
                return shufersal_code
            else:
                print("[-] השרת ענה, אך לא מצא מוצרים תואמים לחיפוש.")
                return None
        else:
            print(f"[X] שגיאה בחיבור לשרת שופרסל. קוד שגיאה: {response.status_code}")
            return None

    except Exception as e:
        print(f"[X] התרחשה שגיאה לא צפויה: {e}")
        return None

# אזור בדיקה
if __name__ == "__main__":
    test_product_name = "פתיתים"
    get_shufersal_product_code(test_product_name)
