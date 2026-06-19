import json
import requests
import time
import random
import os
from google import genai

GEMINI_API_KEY = "AIzaSyCu_EXWBvOSXoMn_9lqB_e3JFm7wZ702Bk"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
]


def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=4)


def search_rami_levy(query, count=6):
    url = "https://www.rami-levy.co.il/api/catalog"
    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.rami-levy.co.il/he"
    }
    try:
        response = requests.post(url, headers=headers, json={"q": query, "store": 331}, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return [
                {
                    "id": str(p.get('id')),
                    "name": p.get('name', ''),
                    "price": p.get('price', {}).get('price', 0)
                }
                for p in data.get('data', [])[:count]
            ]
    except Exception as e:
        print(f"שגיאת רשת: {e}")
    return []


def ask_ai_for_substitute(original_name, candidates, original_code):
    filtered = [c for c in candidates if c['id'] != original_code]
    if not filtered:
        return None

    client = genai.Client(api_key=GEMINI_API_KEY)
    candidates_text = "\n".join([f"{i+1}. {c['name']} (₪{c['price']})" for i, c in enumerate(filtered)])

    prompt = f"""אתה עוזר לבחור מוצר חלופי בסופרמרקט.

המוצר המקורי: "{original_name}"

מוצרים אפשריים ברמי לוי:
{candidates_text}

בחר את המוצר שהוא החלופה הכי טובה - מוצר דומה מבחינת סוג ושימוש, אך לא חייב להיות זהה לחלוטין.
ענה רק עם מספר, או 0 אם אין חלופה מתאימה כלל."""

    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model='gemini-1.5-pro',
                contents=prompt
            )
            choice = int(response.text.strip())
            if 1 <= choice <= len(filtered):
                return filtered[choice - 1]
            return None
        except Exception as e:
            if '429' in str(e):
                wait = 30 * (attempt + 1)
                print(f"מגבלת קצב - ממתין {wait} שניות...", end=" ", flush=True)
                time.sleep(wait)
            else:
                print(f"שגיאת Gemini: {e}")
                return None
    return None


def main():
    prices = load_json('prices.json')
    pending = load_json('substitutes_pending.json')

    print(f"📦 {len(prices)} מוצרים במאגר")
    print(f"✅ {len(pending)} הצעות קיימות כבר\n")

    processed = 0
    consecutive_fails = 0

    try:
        for db_key, item in prices.items():
            barcode = db_key.replace('P_', '')

            if barcode in pending:
                continue

            name = item.get('name', '')
            rami_levy_code = str(item.get('rami_levy_code', ''))

            print(f"🔍 {name}...", end=" ", flush=True)

            candidates = search_rami_levy(name)

            if not candidates:
                print("❌ אין תוצאות מרמי לוי")
                consecutive_fails += 1
            else:
                substitute = ask_ai_for_substitute(name, candidates, rami_levy_code)

                if substitute:
                    pending[barcode] = {
                        "original_name": name,
                        "substitute_code": substitute['id'],
                        "substitute_name": substitute['name'],
                        "substitute_price": substitute['price']
                    }
                    print(f"✅ → {substitute['name']}")
                    consecutive_fails = 0
                else:
                    print("⚠️ Claude לא מצא חלופה מתאימה")
                    consecutive_fails += 1

                processed += 1

            if processed % 20 == 0:
                save_json('substitutes_pending.json', pending)
                print(f"\n💾 שמור ({len(pending)} הצעות סה\"כ)\n")

            if consecutive_fails >= 5:
                print("\n⚠️ 5 כשלונות ברצף - ממתין 60 שניות...")
                time.sleep(60)
                consecutive_fails = 0

            time.sleep(random.uniform(0.8, 1.8))

    except KeyboardInterrupt:
        print("\n🛑 עצירה ידנית")

    save_json('substitutes_pending.json', pending)
    print(f"\n🎉 סיום! {len(pending)} הצעות נשמרו ב-substitutes_pending.json")
    print("👉 עבור על הקובץ, מחק שורות שגויות, ואז הפעל: python approve_substitutes.py")


if __name__ == '__main__':
    main()
