-- Products our database does not know (for example a chain's own brand): the AI matches them to a known product,
-- and every later comparison of that chain product uses the match. Catalog data, readable by everyone; only the
-- ai-substitutes Edge Function (service role) writes it. Safe to run more than once.
BEGIN;
CREATE TABLE IF NOT EXISTS ai_matches (
    store_name text NOT NULL CHECK (store_name IN ('shufersal', 'rami_levy', 'victory', 'machsanei_hashuk')),
    store_code text NOT NULL CHECK (char_length(store_code) BETWEEN 1 AND 40),
    barcode    text NOT NULL REFERENCES products(barcode) ON DELETE CASCADE,
    name       text CHECK (char_length(name) <= 120),   -- the chain's own product name, for review
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (store_name, store_code)
);
ALTER TABLE ai_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_matches FROM anon, authenticated;
GRANT SELECT ON ai_matches TO anon, authenticated;
DROP POLICY IF EXISTS "public read" ON ai_matches;
CREATE POLICY "public read" ON ai_matches FOR SELECT TO anon, authenticated USING (true);
COMMIT;
