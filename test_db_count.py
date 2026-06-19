import getpass
import pg8000.dbapi

def main():
    password = getpass.getpass("Enter your Supabase database password to check counts: ")
    try:
        conn = pg8000.dbapi.connect(
            host="db.icdethibkzwzguwmfoef.supabase.co",
            port=5432,
            database="postgres",
            user="postgres",
            password=password
        )
        cursor = conn.cursor()
        
        # Check products count
        cursor.execute("SELECT COUNT(*) FROM products")
        products_count = cursor.fetchone()[0]
        
        # Check store_products count
        cursor.execute("SELECT COUNT(*) FROM store_products")
        store_products_count = cursor.fetchone()[0]
        
        print(f"\n📊 Database counts according to PostgreSQL:")
        print(f"  - products table: {products_count} rows")
        print(f"  - store_products table: {store_products_count} rows")
        
        cursor.close()
        conn.close()
    except Exception as e:
        print(f"❌ Error checking counts: {e}")

if __name__ == '__main__':
    main()
