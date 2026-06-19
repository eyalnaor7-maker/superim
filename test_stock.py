import requests, sys, io, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
resp = requests.post('https://www.rami-levy.co.il/api/catalog', json={'q': 'לחם מחמצת וכוסמין', 'store': 331})
data = resp.json()
if data.get('data'):
    for p in data['data'][:3]:
        print(f"{p['id']} - {p['name']}")
        print(f"  inventory: {p.get('inventory')}")
        print(f"  has_stock: {p.get('has_stock')}")
        print(f"  is_stock: {p.get('is_stock')}")
        print(f"  available_in: {p.get('available_in')}")
        print(f"  multiplication: {p.get('multiplication')}")
        print('---')
