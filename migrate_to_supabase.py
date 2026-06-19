import json
import os
import getpass
import pg8000.dbapi

def main():
    json_path = 'prices.json'
    subs_path = 'substitutes.json'

    if not os.path.exists(json_path):
        print(f"❌ '{json_path}' not found in the current directory.")
        return

    print("--- Supabase Database Migration Tool ---")
    password = getpass.getpass("Enter your Supabase database password: ")

    try:
        print("Connecting to Supabase Postgres database...")
        conn = pg8000.dbapi.connect(
            host="db.icdethibkzwzguwmfoef.supabase.co",
            port=5432,
            database="postgres",
            user="postgres",
            password=password
        )
        cursor = conn.cursor()
        print("✅ Connected successfully.")
    except Exception as e:
        print(f"❌ Connection failed: {e}")
        return

    # Load prices.json
    print(f"Loading '{json_path}'...")
    with open(json_path, 'r', encoding='utf-8') as f:
        prices_data = json.load(f)
    print(f"✅ Loaded {len(prices_data)} products from JSON.")

    # 1. Insert Products
    print("Migrating products...")
    product_batch = []
    store_product_batch = []
    
    for barcode, item in prices_data.items():
        name = item.get('name', 'Unknown')
        product_batch.append((barcode, name))

        # Shufersal prices
        shufersal_price = item.get('shufersal_price')
        if shufersal_price is not None:
            store_product_batch.append((barcode, 'shufersal', None, shufersal_price))

        # Rami Levy
        rami_levy_code = item.get('rami_levy_code')
        rami_levy_price = item.get('rami_levy_price')
        if rami_levy_code is not None or rami_levy_price is not None:
            code_str = str(rami_levy_code) if rami_levy_code is not None else None
            price_val = float(rami_levy_price) if rami_levy_price is not None else None
            store_product_batch.append((barcode, 'rami_levy', code_str, price_val))

        # Victory
        victory_code = item.get('victory_code')
        victory_price = item.get('victory_price')
        if victory_code is not None or victory_price is not None:
            code_str = str(victory_code) if victory_code is not None else None
            price_val = float(victory_price) if victory_price is not None else None
            store_product_batch.append((barcode, 'victory', code_str, price_val))

    # Insert products in batches
    print("Writing to 'products' table...")
    inserted_products = 0
    batch_size = 200
    for i in range(0, len(product_batch), batch_size):
        batch = product_batch[i:i+batch_size]
        try:
            placeholders = ", ".join(["(%s, %s)"] * len(batch))
            query = f"INSERT INTO products (barcode, name) VALUES {placeholders} ON CONFLICT (barcode) DO UPDATE SET name = EXCLUDED.name"
            params = [val for item in batch for val in item]
            cursor.execute(query, params)
            conn.commit()
            inserted_products += len(batch)
            print(f"  Products processed: {inserted_products}/{len(product_batch)}")
        except Exception as e:
            print(f"❌ Error inserting products batch: {e}")
            conn.rollback()
            return

    # Insert store_products in batches
    print("Writing to 'store_products' table...")
    inserted_store_products = 0
    for i in range(0, len(store_product_batch), batch_size):
        batch = store_product_batch[i:i+batch_size]
        try:
            placeholders = ", ".join(["(%s, %s, %s, %s)"] * len(batch))
            query = (
                f"INSERT INTO store_products (barcode, store_name, store_code, price) VALUES {placeholders} "
                "ON CONFLICT (barcode, store_name) DO UPDATE SET "
                "store_code = EXCLUDED.store_code, price = EXCLUDED.price, updated_at = now()"
            )
            params = [val for item in batch for val in item]
            cursor.execute(query, params)
            conn.commit()
            inserted_store_products += len(batch)
            print(f"  Store prices processed: {inserted_store_products}/{len(store_product_batch)}")
        except Exception as e:
            print(f"❌ Error inserting store products batch: {e}")
            conn.rollback()
            return

    # Load and migrate substitutes.json if it exists
    if os.path.exists(subs_path):
        print(f"Loading '{subs_path}'...")
        try:
            with open(subs_path, 'r', encoding='utf-8') as f:
                subs_data = json.load(f)
            print(f"✅ Loaded {len(subs_data)} substitutes.")
            
            inserted_subs = 0
            for barcode, item in subs_data.items():
                # We assume substitutes in substitutes.json are for rami_levy by default as per approve_substitutes.py
                sub_code = item.get('rami_levy_code')
                sub_name = item.get('name')
                if sub_code and sub_name:
                    cursor.execute(
                        "INSERT INTO substitutes (original_barcode, substitute_code, substitute_name, store_name) "
                        "VALUES (%s, %s, %s, %s) "
                        "ON CONFLICT (original_barcode, store_name) DO UPDATE SET "
                        "substitute_code = EXCLUDED.substitute_code, substitute_name = EXCLUDED.substitute_name",
                        (barcode, str(sub_code), sub_name, 'rami_levy')
                    )
                    inserted_subs += 1
            print(f"✅ Migrated {inserted_subs} substitutions to database.")
        except Exception as e:
            print(f"⚠️ Error migrating substitutes: {e}")
            # Don't fail the whole migration if substitutes has issues

    # Commit changes
    print("Committing transaction...")
    conn.commit()
    cursor.close()
    conn.close()
    print("🎉 Database migration completed successfully!")

if __name__ == '__main__':
    main()
