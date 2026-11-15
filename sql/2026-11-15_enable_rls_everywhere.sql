-- Turns Row Level Security on for EVERY table in the public schema, and keeps the extension working:
-- the three price tables stay readable (read only) by the public key. Safe to run more than once.
-- Run in Supabase: SQL Editor -> paste this whole file -> Run. The last query shows the result.

BEGIN;

-- 1. RLS on, for every table that does not have it yet. Policies that already exist are kept.
DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;

-- 2. With RLS on, a table without a policy returns nothing. The extension reads these three, so each must
--    have a read policy. One is added only where no SELECT policy exists yet.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['products', 'store_products', 'substitutes'] LOOP
        IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND cmd IN ('SELECT', 'ALL')
        ) THEN
            EXECUTE format('CREATE POLICY "Allow public read access" ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
            EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
        END IF;
    END LOOP;
END $$;

COMMIT;

-- Check: every row must show rls_on = true. A table with policies = 0 is closed to the public key
-- (that is correct for comparison_events, product_counts and dashboard_access).
SELECT t.tablename,
       t.rowsecurity AS rls_on,
       (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t.tablename) AS policies
FROM pg_tables t
WHERE t.schemaname = 'public'
ORDER BY t.tablename;
