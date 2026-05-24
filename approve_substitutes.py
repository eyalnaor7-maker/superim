import json
import os


def load_json(path):
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def main():
    pending = load_json('substitutes_pending.json')

    if not pending:
        print("❌ לא נמצא קובץ substitutes_pending.json")
        return

    existing = load_json('substitutes.json')
    added = 0

    for barcode, item in pending.items():
        existing[barcode] = {
            "rami_levy_code": item['substitute_code'],
            "name": item['substitute_name']
        }
        added += 1

    with open('substitutes.json', 'w', encoding='utf-8') as f:
        json.dump(existing, f, ensure_ascii=False, indent=4)

    print(f"✅ {added} תחליפים נשמרו ב-substitutes.json (סה\"כ {len(existing)} במאגר)")


if __name__ == '__main__':
    main()
