import requests
import urllib.parse
import json
import time
import xml.etree.ElementTree as ET


# ==========================================
# חלק 1: הבוט שבנינו יחד (מנוע החיפוש באתר)
# ==========================================
def get_victory_product_code(product_name):
    encoded_name = urllib.parse.quote(product_name)
    filters_param = "%7B%22must%22:%7B%22exists%22:%5B%22family.id%22,%22family.categoriesPaths.id%22,%22branch.regularPrice%22%5D,%22term%22:%7B%22branch.isActive%22:true,%22branch.isVisible%22:true%7D%7D,%22mustNot%22:%7B%22term%22:%7B%22branch.regularPrice%22:0%7D%7D,%22bool%22:%7B%22should%22:%5B%7B%22bool%22:%7B%22must_not%22:%7B%22exists%22:%7B%22field%22:%22branch.outOfStockShowUntilDate%22%7D%7D%7D%7D,%7B%22bool%22:%7B%22must%22:%5B%7B%22range%22:%7B%22branch.outOfStockShowUntilDate%22:%7B%22gt%22:%22now%22%7D%7D%7D,%7B%22term%22:%7B%22branch.isOutOfStock%22:true%7D%7D%5D%7D%7D,%7B%22bool%22:%7B%22must%22:%5B%7B%22term%22:%7B%22branch.isOutOfStock%22:false%7D%7D%5D%7D%7D%5D%7D%7D"
    url = f"https://www.victoryonline.co.il/v2/retailers/1470/branches/2439/products/autocomplete?appId=4&filters={filters_param}&from=0&isSearch=true&languageId=1&size=10&query={encoded_name}"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json",
        "Origin": "https://www.victoryonline.co.il",
        "Referer": "https://www.victoryonline.co.il/"
    }

    try:
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            data = response.json()
            items = []
            if data.get('suggestions') and data['suggestions'].get('suggestProducts') and data['suggestions'][
                'suggestProducts'].get('products'):
                items = data['suggestions']['suggestProducts']['products']

            if items:
                return items[0].get('id')
    except Exception as e:
        pass

    return None


# ==========================================
# חלק 2: מפענח ה-XML של שקיפות המחירים
# ==========================================
def parse_victory_xml(xml_path):
    print(f"[*] קורא ומנתח את קובץ ה-XML של ויקטורי...")
    victory_dict = {}
    try:
        # קורא את קובץ ה-XML
        tree = ET.parse(xml_path)
        root = tree.getroot()

        # עובר על כל המוצרים בקובץ (התגית נקראת Item)
        for item in root.iter('Item'):
            code_elem = item.find('ItemCode')  # הברקוד הכללי
            name_elem = item.find('ItemName')  # השם שויקטורי נתנו

            if code_elem is not None and name_elem is not None:
                barcode = code_elem.text.strip() if code_elem.text else ""
                name = name_elem.text.strip() if name_elem.text else ""

                if barcode and name:
                    victory_dict[barcode] = name

        print(f"[V] נטענו בהצלחה {len(victory_dict)} מוצרים מתוך ה-XML.")
        return victory_dict
    except Exception as e:
        print(f"[X] שגיאה בקריאת קובץ ה-XML: {e}")
        return {}


# ==========================================
# חלק 3: המנהל שמצליב את הכל וכותב לקובץ
# ==========================================
def update_database():
    # נתיבי הקבצים שלך
    json_file_path = 'prices.json'
    # הוספתי סיומת .xml בסוף כדי שפייתון ידע לקרוא את זה (אם הקובץ אצלך בלי סיומת, תמחק את ה-.xml מהשורה למטה)
    xml_file_path = r'C:\Users\eyaln\Desktop\PriceFull7290696200003-001-068-20260522-050429.xml'

    # שלב א': טוענים את ה-XML של ויקטורי לתוך זיכרון המחשב
    victory_xml_data = parse_victory_xml(xml_file_path)
    if not victory_xml_data:
        return  # אם ה-XML לא נטען, עוצרים כאן

    # שלב ב': פותחים את prices.json שלך
    print(f"\n[*] פותח את מאגר הנתונים הראשי '{json_file_path}'...")
    try:
        with open(json_file_path, 'r', encoding='utf-8') as f:
            db_data = json.load(f)
    except FileNotFoundError:
        print(f"[X] לא מצאתי את הקובץ {json_file_path}. ודא שהוא באותה תיקייה.")
        return

    updated_count = 0

    # שלב ג': עוברים על כל המוצרים במאגר שלך ומצליבים
    for general_code, details in db_data.items():
        # המאגר שלך שומר את הברקוד עם הקידומת 'P_', אז ננקה אותה כדי שנוכל להשוות ל-XML
        clean_barcode = general_code.replace("P_", "")

        # בודקים אם הברקוד הזה קיים ב-XML של ויקטורי!
        if clean_barcode in victory_xml_data:
            victory_name = victory_xml_data[clean_barcode]
            print(f"\n[*] נמצאה הצלבה ב-XML! ברקוד: {clean_barcode}")
            print(f"    שם המוצר בויקטורי: '{victory_name}'")
            print(f"    יוצא לחפש את הקוד הפנימי באתר ויקטורי...")

            # לוקחים את ה-3/4 מילים הראשונות מהשם של ויקטורי כדי לקבל חיפוש מדויק באתר שלהם
            search_term = " ".join(victory_name.split()[:4])

            # שולחים לבוט שלנו!
            internal_victory_code = get_victory_product_code(search_term)

            if internal_victory_code:
                # מעדכנים או דורסים רק את הקוד של ויקטורי!
                db_data[general_code]["victory_code"] = str(internal_victory_code)
                print(f"    [V] בוצע! הוקצה קוד פנימי: {internal_victory_code}")
                updated_count += 1
            else:
                print(f"    [-] האתר של ויקטורי לא מצא תוצאה לשם הזה.")

            # המתנה בין חיפושים
            time.sleep(1.5)

            # שלב ד': שומרים חזרה לקובץ prices.json
    if updated_count > 0:
        print(f"\n[*] שומר נתונים... סך הכל הצלחנו להצליב ולשלוף {updated_count} קודים פנימיים.")
        with open(json_file_path, 'w', encoding='utf-8') as f:
            json.dump(db_data, f, ensure_ascii=False, indent=4)
        print(f"[V] הקובץ '{json_file_path}' התעדכן בהצלחה!")
    else:
        print("\nסיימתי. לא בוצעו שינויים.")


if __name__ == "__main__":
    update_database()