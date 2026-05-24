import requests
import urllib.parse


def get_victory_product_code(product_name):
    print(f"[*] מתחיל חיפוש עבור: '{product_name}'...")

    # שלב 1: קידוד השם
    encoded_name = urllib.parse.quote(product_name)

    # שלב 2: שילוב מנצח - כתובת ה-autocomplete עם הפילטרים
    filters_param = "%7B%22must%22:%7B%22exists%22:%5B%22family.id%22,%22family.categoriesPaths.id%22,%22branch.regularPrice%22%5D,%22term%22:%7B%22branch.isActive%22:true,%22branch.isVisible%22:true%7D%7D,%22mustNot%22:%7B%22term%22:%7B%22branch.regularPrice%22:0%7D%7D,%22bool%22:%7B%22should%22:%5B%7B%22bool%22:%7B%22must_not%22:%7B%22exists%22:%7B%22field%22:%22branch.outOfStockShowUntilDate%22%7D%7D%7D%7D,%7B%22bool%22:%7B%22must%22:%5B%7B%22range%22:%7B%22branch.outOfStockShowUntilDate%22:%7B%22gt%22:%22now%22%7D%7D%7D,%7B%22term%22:%7B%22branch.isOutOfStock%22:true%7D%7D%5D%7D%7D,%7B%22bool%22:%7B%22must%22:%5B%7B%22term%22:%7B%22branch.isOutOfStock%22:false%7D%7D%5D%7D%7D%5D%7D%7D"

    url = f"https://www.victoryonline.co.il/v2/retailers/1470/branches/2439/products/autocomplete?appId=4&filters={filters_param}&from=0&isSearch=true&languageId=1&size=10&query={encoded_name}"

    # שלב 3: כותרות כדי להיראות כמו גולש אמיתי
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://www.victoryonline.co.il",
        "Referer": "https://www.victoryonline.co.il/"
    }

    try:
        response = requests.get(url, headers=headers)

        if response.status_code == 200:
            data = response.json()

            # שלב 4: התיקון הגדול! הולכים ישר ל-"products"
            items = []
            if data.get('suggestions') and data['suggestions'].get('suggestProducts') and data['suggestions'][
                'suggestProducts'].get('products'):
                items = data['suggestions']['suggestProducts']['products']

            if items:
                # לוקחים את המוצר הראשון ברשימה
                first_item = items[0]

                # שולפים את ה-ID ואת השם המקומי (כפי שגילינו ב-JSON)
                victory_code = first_item.get('id')
                victory_name = first_item.get('localName', 'לא נמצא שם')

                print(f"[V] הצלחה! הקוד הפנימי של ויקטורי הוא: {victory_code}")
                print(f"[V] השם של המוצר באתר שלהם הוא: {victory_name}")
                return victory_code
            else:
                print("[-] השרת ענה, אבל לא החזיר מוצרים תחת המילה 'products'.")
                return None
        else:
            print(f"[X] שגיאה בחיבור לשרת. קוד שגיאה: {response.status_code}")
            return None

    except Exception as e:
        print(f"[X] התרחשה שגיאה לא צפויה: {e}")
        return None


# אזור בדיקה - רגע האמת!
if __name__ == "__main__":
    test_product_name = "פלפל"
    get_victory_product_code(test_product_name)