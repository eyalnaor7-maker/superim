# Supabase Database Integration & API Documentation

This project has been migrated from a local JSON database (`prices.json`) to a central **Supabase (PostgreSQL)** database. This document provides setup instructions, schema details, and API code snippets for developers and AI coding agents working on this repository.

---

## 1. Database Connection Details

*   **Host**: `db.icdethibkzwzguwmfoef.supabase.co`
*   **Port**: `5432`
*   **Database**: `postgres`
*   **User**: `postgres`
*   **Default Schema**: `public`
*   **SQL DDL File**: [supabase_schema.sql](file:///c:/Users/yonas/Desktop/grocery%20project/supabase_schema.sql) (Contains the schema creation script)

---

## 2. Table Schema

The database consists of three main tables under the `public` schema:

### `products`
Stores general product metadata.
*   `barcode` (TEXT, Primary Key): Barcodes including the `P_` prefix (e.g. `P_7290008464697`) to maintain backward compatibility.
*   `name` (TEXT, Not Null): Hebrew product name.
*   `created_at` (TIMESTAMPTZ, Default: `now()`)

### `store_products`
Stores store-specific codes and prices.
*   `barcode` (TEXT, Foreign Key -> `products.barcode`, ON DELETE CASCADE)
*   `store_name` (TEXT, Not Null): E.g., `'shufersal'`, `'rami_levy'`, `'victory'`.
*   `store_code` (TEXT): The internal store product code.
*   `price` (NUMERIC(10,2)): Current product price at the store.
*   `updated_at` (TIMESTAMPTZ, Default: `now()`)
*   *Constraint*: Unique combination of `(barcode, store_name)` for upserts.

### `substitutes`
Stores approved substitutions/alternatives.
*   `original_barcode` (TEXT, Foreign Key -> `products.barcode`, ON DELETE CASCADE)
*   `substitute_code` (TEXT, Not Null): Store code of the alternative item.
*   `substitute_name` (TEXT, Not Null): Name of the alternative item.
*   `store_name` (TEXT, Not Null): Store for the substitute (e.g. `'rami_levy'`).
*   `status` (TEXT, Default: `'approved'`)
*   `created_at` (TIMESTAMPTZ, Default: `now()`)
*   *Constraint*: Unique combination of `(original_barcode, store_name)`.

---

## 3. Database Search Helper (RPC Function)

A custom PostgreSQL function `find_candidates` is defined in the database for fuzzy name searches using trigram string similarity (requires `pg_trgm` extension):

```sql
CREATE OR REPLACE FUNCTION find_candidates(product_name text, target_store text, limit_val int DEFAULT 8)
RETURNS TABLE (
    code text,
    name text,
    price numeric
) SECURITY DEFINER;
```

---

## 4. API Configurations (`config.json`)

To run the Chrome extension or python scrapers, you must create a local [config.json](file:///c:/Users/yonas/Desktop/grocery%20project/config.json) file in the root directory. **This file is ignored by Git and must never be committed.**

**config.json Template:**
```json
{
  "gemini_api_key": "YOUR_GEMINI_API_KEY",
  "supabase_url": "https://icdethibkzwzguwmfoef.supabase.co",
  "supabase_anon_key": "YOUR_SUPABASE_ANON_KEY",
  "supabase_db_password": "YOUR_SUPABASE_DATABASE_PASSWORD"
}
```

---

## 5. Python Scraper Queries (Write / Update)

Python scripts connect to the database directly using `pg8000` (a pure-Python PostgreSQL client). 

**Bulk Product Upsert Example:**
```python
import pg8000.dbapi

conn = pg8000.dbapi.connect(
    host="db.icdethibkzwzguwmfoef.supabase.co",
    port=5432,
    database="postgres",
    user="postgres",
    password="DATABASE_PASSWORD"
)
cursor = conn.cursor()

# Bulk insert products
query = "INSERT INTO products (barcode, name) VALUES (%s, %s) ON CONFLICT (barcode) DO UPDATE SET name = EXCLUDED.name"
cursor.execute(query, ("P_7290008464697", "בירה מכבי 6 יח"))
conn.commit()
```

---

## 6. Chrome Extension Queries (Read-only via REST/RPC)

To keep the extension lightweight, the Chrome extension queries Supabase directly via the auto-generated **PostgREST API** using standard `fetch` requests.

### Fetching Cart Prices (REST join query):
```javascript
const queryParams = new URLSearchParams({
    select: 'barcode,name,store_products(store_name,store_code,price),substitutes(substitute_code,substitute_name,store_name)',
    barcode: `in.(P_7290008464697,P_7290008801843)`
});

const response = await fetch(`${SUPABASE_URL}/rest/v1/products?${queryParams}`, {
    headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
    }
});
const products = await response.json();
```

### Searching Substitute Candidates (RPC call):
```javascript
const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_candidates`, {
    method: 'POST',
    headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        product_name: "רוטב בזיליקום",
        target_store: "victory",
        limit_val: 8
    })
});
const candidates = await response.json();
```
