-- Stage 1 lockdown: price tables become read-only for every client key.
-- Writes happen only through the service role / direct DB connection (the Python bots).
-- Safe to run more than once.

BEGIN;

-- Any signed-in user could rewrite prices through these. Needed gone before Google sign-in exists.
DROP POLICY IF EXISTS "Allow write access to authenticated users on products" ON products;
DROP POLICY IF EXISTS "Allow write access to authenticated users on store_products" ON store_products;
DROP POLICY IF EXISTS "Allow write access to authenticated users on substitutes" ON substitutes;

-- Anonymous write path used by the removed Gemini feature.
DROP FUNCTION IF EXISTS upsert_substitute(text, text, text);

REVOKE ALL ON products, store_products, substitutes FROM anon, authenticated;
GRANT SELECT ON products, store_products, substitutes TO anon, authenticated;

-- Fuzzy-search helper for the removed Gemini feature; nothing calls it any more.
DROP FUNCTION IF EXISTS find_candidates(text, text, int);

COMMIT;

-- Check afterwards: expect only the three "Allow public read access ..." SELECT policies.
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('products', 'store_products', 'substitutes')
ORDER BY tablename, policyname;
