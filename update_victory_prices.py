"""
update_victory_prices.py
------------------------
Enriches prices.json with Victory XML prices.
Run this whenever you download a fresh Victory XML file.

Usage:
    python update_victory_prices.py
    python update_victory_prices.py "ויקטורי - באר שבע.xml"
"""

import json
import xml.etree.ElementTree as ET
import re
import sys
import os

XML_FILE = sys.argv[1] if len(sys.argv) > 1 else r'ויקטורי - באר שבע.xml'
PRICES_FILE = 'prices.json'


def parse_victory_xml(path):
    """Parse Victory XML (UTF-8 with possible invalid control chars)."""
    with open(path, 'rb') as f:
        raw = f.read()

    text = raw.decode('utf-8', errors='replace')
    # Remove invalid XML 1.0 characters (control chars except \t \n \r)
    clean = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)

    root = ET.fromstring(clean.encode('utf-8'))
    products_el = root.find('Products')
    if products_el is None:
        raise ValueError('No <Products> element found in XML')

    print(f'XML store: ChainID={root.findtext("ChainID")} StoreID={root.findtext("StoreID")}')
    return products_el


def main():
    if not os.path.exists(XML_FILE):
        print(f'❌ XML file not found: {XML_FILE}')
        sys.exit(1)

    if not os.path.exists(PRICES_FILE):
        print(f'❌ prices.json not found')
        sys.exit(1)

    print(f'📄 Reading XML: {XML_FILE}')
    products_el = parse_victory_xml(XML_FILE)

    # Build barcode → price lookup
    victory_prices = {}
    zero_price = 0
    for prod in products_el:
        code = (prod.findtext('ItemCode') or '').strip()
        if not code:
            continue
        price_str = (prod.findtext('ItemPrice') or '').strip()
        try:
            price = float(price_str)
            if price > 0:
                victory_prices[code] = price
            else:
                zero_price += 1
        except ValueError:
            pass

    print(f'✅ XML: {len(victory_prices)} products with price>0, {zero_price} skipped (price=0)')

    # Load and update prices.json
    with open(PRICES_FILE, encoding='utf-8') as f:
        db = json.load(f)

    matched = 0
    not_matched = 0
    for key, item in db.items():
        barcode = key.replace('P_', '').strip()
        if barcode in victory_prices:
            item['victory_price'] = victory_prices[barcode]
            matched += 1
        else:
            not_matched += 1

    print(f'🔗 Matched: {matched}/{len(db)} products in prices.json')
    print(f'   Not matched: {not_matched} (not in Victory XML for this branch)')

    with open(PRICES_FILE, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=4)

    print(f'✅ prices.json updated with victory_price field!')


if __name__ == '__main__':
    main()
