-- Enable the pg_trgm extension for fuzzy name searches
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create products table
CREATE TABLE IF NOT EXISTS products (
    barcode TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Create store_products table
CREATE TABLE IF NOT EXISTS store_products (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    barcode TEXT NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
    store_name TEXT NOT NULL, -- 'shufersal', 'rami_levy', 'victory'
    store_code TEXT,
    price NUMERIC(10, 2),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_store_product UNIQUE (barcode, store_name)
);

-- Create substitutes table
CREATE TABLE IF NOT EXISTS substitutes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    original_barcode TEXT NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
    substitute_code TEXT NOT NULL,
    substitute_name TEXT NOT NULL,
    store_name TEXT NOT NULL,
    status TEXT DEFAULT 'approved', -- 'pending', 'approved'
    created_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT unique_substitute UNIQUE (original_barcode, store_name)
);

-- Enable Row-Level Security (RLS) on all tables
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE substitutes ENABLE ROW LEVEL SECURITY;

-- Create policies for public read access (for Chrome Extension using anon key)
CREATE POLICY "Allow public read access to products" ON products
    FOR SELECT USING (true);

CREATE POLICY "Allow public read access to store_products" ON store_products
    FOR SELECT USING (true);

CREATE POLICY "Allow public read access to substitutes" ON substitutes
    FOR SELECT USING (true);

-- Create policies for write access (for authenticated API users)
CREATE POLICY "Allow write access to authenticated users on products" ON products
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow write access to authenticated users on store_products" ON store_products
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow write access to authenticated users on substitutes" ON substitutes
    FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Helper function for finding substitute candidates using trigram similarity
CREATE OR REPLACE FUNCTION find_candidates(product_name text, target_store text, limit_val int DEFAULT 8)
RETURNS TABLE (
    code text,
    name text,
    price numeric
) SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    SELECT 
        sp.store_code::text AS code,
        p.name::text AS name,
        COALESCE(sp.price, 0)::numeric AS price
    FROM store_products sp
    JOIN products p ON sp.barcode = p.barcode
    WHERE sp.store_name = target_store 
      AND sp.store_code IS NOT NULL
      AND (p.name % product_name OR p.name ILIKE '%' || split_part(product_name, ' ', 1) || '%')
    ORDER BY similarity(p.name, product_name) DESC
    LIMIT limit_val;
END;
$$ LANGUAGE plpgsql;
