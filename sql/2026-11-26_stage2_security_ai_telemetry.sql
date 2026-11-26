-- Stage 2: Security cleanup, fast search & FK indexes, product units & weighed staples,
-- 3-layer AI substitute matching (3/day quota + crowd validation), store health & error telemetry.
-- Applied and verified on project icdethibkzwzguwmfoef on 2026-11-26. Idempotent.

BEGIN;

-- 1. Security Advisor fixes
ALTER VIEW IF EXISTS public.product_substitutes_view SET (security_invoker = true);
ALTER VIEW IF EXISTS public.rami_levy_only_products SET (security_invoker = true);
REVOKE ALL ON public.product_substitutes_view FROM public, anon, authenticated;
REVOKE ALL ON public.rami_levy_only_products FROM public, anon, authenticated;
ALTER FUNCTION public.log_price_change() SET search_path = public;

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE e.extname = 'pg_trgm' AND n.nspname = 'public'
    ) THEN
        ALTER EXTENSION pg_trgm SET SCHEMA extensions;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.request_ip() RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT left(trim(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1)), 64)
$$;
REVOKE ALL ON FUNCTION public.request_ip() FROM public, anon, authenticated;

-- 2. Primary key & FK / Trigram search indexes
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dashboard_attempts' AND column_name = 'id'
    ) THEN
        ALTER TABLE public.dashboard_attempts ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON public.products USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ai_matches_barcode ON public.ai_matches (barcode);
CREATE INDEX IF NOT EXISTS idx_substitutes_sub1 ON public.substitutes (substitute_barcode_1);
CREATE INDEX IF NOT EXISTS idx_substitutes_sub2 ON public.substitutes (substitute_barcode_2);

-- 3. Product units, pack sizes & weighed staples
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS unit_qty numeric(10,2);
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS unit_type text CHECK (unit_type IN ('g', 'ml', 'unit'));
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_weighted boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.parse_product_unit(p_name text)
RETURNS TABLE (qty numeric, utype text)
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
    s text := coalesce(p_name, '');
    m text[];
    n1 numeric;
    n2 numeric;
    v numeric;
    u text;
BEGIN
    m := regexp_match(s, '(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+(?:\.\d+)?)\s*(ק"ג|ק״ג|קג|גרם|גר''|גר|ג''|ג|ליטר|ל''|ל|מ"ל|מ״ל|מל)?');
    IF m IS NOT NULL THEN
        n1 := m[1]::numeric;
        n2 := m[2]::numeric;
        v := n1 * n2;
        u := coalesce(m[3], '');
        IF u IN ('ק"ג','ק״ג','קג') THEN RETURN QUERY SELECT round(v * 1000, 2), 'g'::text; RETURN; END IF;
        IF u IN ('ליטר','ל''','ל') THEN RETURN QUERY SELECT round(v * 1000, 2), 'ml'::text; RETURN; END IF;
        IF u IN ('מ"ל','מ״ל','מל') THEN RETURN QUERY SELECT round(v, 2), 'ml'::text; RETURN; END IF;
        IF u <> '' OR greatest(n1, n2) >= 15 THEN RETURN QUERY SELECT round(v, 2), 'g'::text; RETURN; END IF;
        RETURN QUERY SELECT round(v, 2), 'unit'::text; RETURN;
    END IF;

    m := regexp_match(s, '(\d+(?:\.\d+)?)\s*(ק"ג|ק״ג|קג|גרם|גר''|גר|ג''|ג(?=\s|$|[,.)/-])|ליטר|ל''|ל(?=\s|$|[,.)/-])|מ"ל|מ״ל|מל)');
    IF m IS NOT NULL THEN
        v := m[1]::numeric;
        u := trim(m[2]);
        IF u IN ('ק"ג','ק״ג','קג') THEN RETURN QUERY SELECT round(v * 1000, 2), 'g'::text; RETURN; END IF;
        IF u IN ('ליטר','ל''','ל') THEN RETURN QUERY SELECT round(v * 1000, 2), 'ml'::text; RETURN; END IF;
        IF u IN ('מ"ל','מ״ל','מל') THEN RETURN QUERY SELECT round(v, 2), 'ml'::text; RETURN; END IF;
        RETURN QUERY SELECT round(v, 2), 'g'::text; RETURN;
    END IF;

    m := regexp_match(s, '(\d+)\s*(יח''|יח״|יחידות|יח(?=\s|$|[,.)/-]))');
    IF m IS NOT NULL THEN
        RETURN QUERY SELECT m[1]::numeric, 'unit'::text; RETURN;
    END IF;

    RETURN QUERY SELECT NULL::numeric, NULL::text;
END $$;

UPDATE public.products p
SET unit_qty = u.qty, unit_type = u.utype
FROM (
    SELECT barcode, (public.parse_product_unit(name)).*
    FROM public.products
) u
WHERE p.barcode = u.barcode
  AND u.qty IS NOT NULL
  AND (p.unit_qty IS DISTINCT FROM u.qty OR p.unit_type IS DISTINCT FROM u.utype);

CREATE TABLE IF NOT EXISTS public.weighed_staples (
    staple_key    text PRIMARY KEY,
    canonical_he  text NOT NULL,
    aliases       text[] NOT NULL DEFAULT '{}',
    search_query  text NOT NULL,
    unit_type     text NOT NULL DEFAULT 'g' CHECK (unit_type IN ('g', 'unit')),
    shufersal_bc  text,
    rami_levy_id  text,
    victory_query text,
    mck_query     text
);
ALTER TABLE public.weighed_staples ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weighed_staples FROM anon, authenticated;
GRANT SELECT ON public.weighed_staples TO anon, authenticated;
DROP POLICY IF EXISTS "public read weighed_staples" ON public.weighed_staples;
CREATE POLICY "public read weighed_staples" ON public.weighed_staples FOR SELECT TO anon, authenticated USING (true);

INSERT INTO public.weighed_staples (staple_key, canonical_he, aliases, search_query, unit_type) VALUES
    ('tomato',       'עגבניה',            ARRAY['עגבנייה','עגבניות','עגבניה רגילה','עגבניות חממה'], 'עגבניה', 'g'),
    ('cucumber',     'מלפפון',            ARRAY['מלפפונים','מלפפון ירוק','מלפפון חממה'], 'מלפפון', 'g'),
    ('onion',        'בצל יבש',           ARRAY['בצל','בצל לבן','בצל יבש רגיל'], 'בצל יבש', 'g'),
    ('red_onion',    'בצל סגול',          ARRAY['בצל אדום'], 'בצל סגול', 'g'),
    ('potato',       'תפוח אדמה לבן',     ARRAY['תפוח אדמה','תפו"א','תפוחי אדמה'], 'תפוח אדמה לבן', 'g'),
    ('red_potato',   'תפוח אדמה אדום',    ARRAY['תפו"א אדום','תפוחי אדמה אדומים'], 'תפוח אדמה אדום', 'g'),
    ('carrot',       'גזר',               ARRAY['גזרים','גזר ארוז','גזר תפזורת'], 'גזר', 'g'),
    ('red_pepper',   'פלפל אדום',         ARRAY['גמבה','גמבה אדומה','פלפל מתוק אדום'], 'פלפל אדום', 'g'),
    ('yellow_pepper','פלפל צהוב',         ARRAY['גמבה צהובה'], 'פלפל צהוב', 'g'),
    ('zucchini',     'קישוא',             ARRAY['קישואים','זוקיני'], 'קישוא', 'g'),
    ('eggplant',     'חציל',              ARRAY['חצילים','חציל חממה'], 'חציל', 'g'),
    ('sweet_potato', 'בטטה',              ARRAY['בטטות'], 'בטטה', 'g'),
    ('cabbage',      'כרוב לבן',          ARRAY['כרוב','כרוב ירוק'], 'כרוב לבן', 'g'),
    ('lemon',        'לימון',             ARRAY['לימונים','לימון טרי'], 'לימון', 'g'),
    ('banana',       'בננה',              ARRAY['בננות'], 'בננה', 'g'),
    ('avocado',      'אבוקדו',            ARRAY['אבוקדו בשל','אבוקדו ירוק'], 'אבוקדו', 'g'),
    ('apple_green',  'תפוח עץ גרני סמית', ARRAY['תפוח ירוק','גרני סמית','תפוח עץ ירוק'], 'תפוח גרני סמית', 'g'),
    ('apple_pink',   'תפוח עץ פינק ליידי',ARRAY['פינק ליידי','תפוח ורוד'], 'תפוח פינק ליידי', 'g'),
    ('garlic',       'שום',               ARRAY['שום טרי','מארז שום'], 'שום', 'g'),
    ('chicken_brst', 'חזה עוף טרי',       ARRAY['חזה עוף','פילה עוף טרי','שניצל עוף טרי'], 'חזה עוף טרי', 'g')
ON CONFLICT (staple_key) DO NOTHING;

-- 4. 3-Layer AI Matching, 3/Day Quota & Crowd Validation
ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS uses int NOT NULL DEFAULT 1;
ALTER TABLE public.substitutes ADD COLUMN IF NOT EXISTS chosen_count int NOT NULL DEFAULT 0;
ALTER TABLE public.substitutes ADD COLUMN IF NOT EXISTS neg_votes int NOT NULL DEFAULT 0;
ALTER TABLE public.ai_matches  ADD COLUMN IF NOT EXISTS chosen_count int NOT NULL DEFAULT 0;
ALTER TABLE public.ai_matches  ADD COLUMN IF NOT EXISTS neg_votes int NOT NULL DEFAULT 0;
ALTER POLICY "public read" ON public.ai_matches USING (neg_votes < 2);

CREATE OR REPLACE FUNCTION public.claim_ai_quota(p_user uuid, p_limit int DEFAULT 3)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_uses int;
BEGIN
    INSERT INTO public.ai_usage (user_id, day, uses)
    VALUES (p_user, current_date, 1)
    ON CONFLICT (user_id, day) DO UPDATE
        SET uses = public.ai_usage.uses + 1
        WHERE public.ai_usage.uses < p_limit
    RETURNING uses INTO v_uses;

    IF v_uses IS NULL THEN
        RETURN -1;
    END IF;
    RETURN greatest(p_limit - v_uses, 0);
END $$;
REVOKE ALL ON FUNCTION public.claim_ai_quota(uuid, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_quota(uuid, int) TO service_role;

CREATE OR REPLACE FUNCTION public.refund_ai_quota(p_user uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.ai_usage SET uses = greatest(uses - 1, 0) WHERE user_id = p_user AND day = current_date;
END $$;
REVOKE ALL ON FUNCTION public.refund_ai_quota(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_ai_quota(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.ai_candidates_v2(
    p_name text,
    p_exclude text,
    p_limit int DEFAULT 12,
    p_missing_stores text[] DEFAULT NULL
)
RETURNS TABLE (barcode text, name text, stores text, unit_qty numeric, unit_type text)
LANGUAGE plpgsql STABLE SET search_path = public, extensions AS $$
DECLARE
    v_qty numeric;
    v_type text;
    v_gf boolean := (p_name ~ '(לל"ג|לל״ג|ללא גלוטן)');
    v_lf boolean := (p_name ~ '(נטול לקטוז|נטו\.לקטוז|ללא לקטוז|דל לקטוז)');
    w1 text := split_part(trim(coalesce(p_name, '')), ' ', 1);
    w2 text := split_part(trim(coalesce(p_name, '')), ' ', 2);
BEGIN
    SELECT u.qty, u.utype INTO v_qty, v_type FROM public.parse_product_unit(p_name) u;

    RETURN QUERY
    SELECT
        p.barcode,
        p.name,
        string_agg(sp.store_name, ',' ORDER BY sp.store_name) AS stores,
        p.unit_qty,
        p.unit_type
    FROM public.products p
    JOIN public.store_products sp ON sp.barcode = p.barcode
    LEFT JOIN public.substitutes sub ON sub.substitute_barcode_1 = p.barcode
    WHERE p.barcode <> coalesce(p_exclude, '')
      AND (
          p.name OPERATOR(extensions.%) p_name
          OR (char_length(w1) >= 2 AND p.name ILIKE '%' || w1 || '%')
          OR (char_length(w2) >= 3 AND p.name ILIKE '%' || w2 || '%')
      )
      AND (NOT v_gf OR p.name ~ '(לל"ג|לל״ג|ללא גלוטן)')
      AND (NOT v_lf OR p.name ~ '(נטול לקטוז|נטו\.לקטוז|ללא לקטוז|דל לקטוז)')
      AND (
          v_qty IS NULL OR p.unit_qty IS NULL
          OR (p.unit_type = v_type AND p.unit_qty BETWEEN v_qty * 0.70 AND v_qty * 1.35)
      )
    GROUP BY p.barcode, p.name, p.unit_qty, p.unit_type
    HAVING (
        p_missing_stores IS NULL
        OR cardinality(p_missing_stores) = 0
        OR bool_or(sp.store_name = ANY (p_missing_stores))
    )
    ORDER BY
        extensions.similarity(p.name, p_name)
        + least(coalesce(max(sub.chosen_count), 0) * 0.02, 0.15) DESC
    LIMIT least(coalesce(p_limit, 12), 20);
END $$;
REVOKE ALL ON FUNCTION public.ai_candidates_v2(text, text, int, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_candidates_v2(text, text, int, text[]) TO service_role;

CREATE TABLE IF NOT EXISTS public.substitute_reports (
    day        date NOT NULL DEFAULT current_date,
    ip_hash    text NOT NULL,
    target_key text NOT NULL,
    PRIMARY KEY (day, ip_hash, target_key)
);
ALTER TABLE public.substitute_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.substitute_reports FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.report_bad_substitute(
    p_original_barcode text DEFAULT NULL,
    p_store_name text DEFAULT NULL,
    p_store_code text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_ip_hash text := encode(sha256(convert_to(coalesce(request_ip(), 'anon'), 'UTF8')), 'hex');
    v_target  text;
    v_inserted int;
BEGIN
    IF p_original_barcode IS NOT NULL AND p_original_barcode ~ '^P_[0-9]{4,14}$' THEN
        v_target := 'sub:' || p_original_barcode;
        INSERT INTO public.substitute_reports (day, ip_hash, target_key)
        VALUES (current_date, v_ip_hash, v_target) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN RETURN; END IF;

        UPDATE public.substitutes
        SET neg_votes = neg_votes + 1,
            status = CASE WHEN neg_votes + 1 >= 2 THEN 'rejected' ELSE status END,
            substitute_barcode_1 = CASE WHEN neg_votes + 1 >= 2 THEN NULL ELSE substitute_barcode_1 END,
            substitute_barcode_2 = CASE WHEN neg_votes + 1 >= 2 THEN NULL ELSE substitute_barcode_2 END
        WHERE original_barcode = p_original_barcode AND status = 'ai';
    ELSIF p_store_name IN ('shufersal', 'rami_levy', 'victory', 'machsanei_hashuk')
          AND char_length(coalesce(p_store_code, '')) BETWEEN 1 AND 40 THEN
        v_target := 'match:' || p_store_name || ':' || p_store_code;
        INSERT INTO public.substitute_reports (day, ip_hash, target_key)
        VALUES (current_date, v_ip_hash, v_target) ON CONFLICT DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN RETURN; END IF;

        UPDATE public.ai_matches
        SET neg_votes = neg_votes + 1
        WHERE store_name = p_store_name AND store_code = p_store_code;
    END IF;
END $$;
REVOKE ALL ON FUNCTION public.report_bad_substitute(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.report_bad_substitute(text, text, text) TO anon, authenticated;

-- 5. Store health, missing products & client errors + rich dashboard
CREATE TABLE IF NOT EXISTS public.missing_product_counts (
    day        date NOT NULL DEFAULT current_date,
    store_name text NOT NULL,
    code       text NOT NULL,
    name       text,
    reports    int  NOT NULL DEFAULT 0,
    PRIMARY KEY (day, store_name, code)
);
ALTER TABLE public.missing_product_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.missing_product_counts FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.store_health_daily (
    day         date NOT NULL DEFAULT current_date,
    store_key   text NOT NULL,
    checks      int  NOT NULL DEFAULT 0,
    ok_checks   int  NOT NULL DEFAULT 0,
    matched_sum int  NOT NULL DEFAULT 0,
    ms_sum      bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (day, store_key)
);
ALTER TABLE public.store_health_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_health_daily FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.client_errors (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    store_key   text,
    step        text,
    error_code  text NOT NULL,
    ext_version text
);
CREATE INDEX IF NOT EXISTS idx_client_errors_at ON public.client_errors (at DESC);
ALTER TABLE public.client_errors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_errors FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_client_error(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF jsonb_typeof(p) <> 'object' OR coalesce(p->>'error_code', '') = '' THEN RETURN; END IF;
    IF (SELECT count(*) FROM public.client_errors WHERE at > now() - interval '1 hour') >= 300 THEN RETURN; END IF;
    INSERT INTO public.client_errors (store_key, step, error_code, ext_version)
    VALUES (
        left(coalesce(p->>'store', ''), 24),
        left(coalesce(p->>'step', ''), 40),
        left(p->>'error_code', 120),
        left(coalesce(p->>'ext_version', ''), 20)
    );
END $$;
REVOKE ALL ON FUNCTION public.log_client_error(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.log_client_error(jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_event(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    stores constant text[] := ARRAY['shufersal', 'ramiLevy', 'victory', 'machsaneiHashuk'];
    prod jsonb;
    miss jsonb;
    hlth record;
    sub_bc text;
BEGIN
    IF p->>'type' = 'switch' THEN
        IF (p->>'store' = ANY (stores)) IS NOT TRUE THEN RETURN; END IF;
        INSERT INTO public.comparison_events (event_type, switch_store, city, ext_version)
        VALUES ('switch', p->>'store', left(p->>'city', 60), left(p->>'ext_version', 20));
        IF jsonb_typeof(p->'used_substitutes') = 'array' THEN
            FOR sub_bc IN SELECT jsonb_array_elements_text(p->'used_substitutes') LIMIT 50 LOOP
                IF sub_bc ~ '^P_[0-9]{4,14}$' THEN
                    UPDATE public.substitutes SET chosen_count = chosen_count + 1 WHERE original_barcode = sub_bc;
                END IF;
            END LOOP;
        END IF;
        RETURN;
    END IF;

    IF (p->>'type' = 'comparison' AND p->>'active_store' = ANY (stores) AND p->>'cheapest_store' = ANY (stores)) IS NOT TRUE THEN
        RETURN;
    END IF;

    INSERT INTO public.comparison_events (event_type, active_store, cheapest_store, city, cart_size, matched_count, saving, totals, ext_version)
    VALUES ('comparison', p->>'active_store', p->>'cheapest_store', left(p->>'city', 60),
            least(greatest((p->>'cart_size')::int, 0), 500),
            least(greatest((p->>'matched_count')::int, 0), 500),
            least(greatest((p->>'saving')::numeric, 0), 100000),
            CASE WHEN jsonb_typeof(p->'totals') = 'object' AND length((p->'totals')::text) < 400 THEN p->'totals' END,
            left(p->>'ext_version', 20));

    FOR prod IN
        SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p->'products') = 'array' THEN p->'products' ELSE '[]'::jsonb END) AS e LIMIT 200
    LOOP
        CONTINUE WHEN coalesce(prod->>'barcode', '') !~ '^[0-9]{4,14}$';
        INSERT INTO public.product_counts (day, barcode, name, compared)
        VALUES (current_date, prod->>'barcode', left(prod->>'name', 120), 1)
        ON CONFLICT (day, barcode) DO UPDATE SET compared = public.product_counts.compared + 1;
    END LOOP;

    IF jsonb_typeof(p->'missing_items') = 'array' THEN
        FOR miss IN SELECT e FROM jsonb_array_elements(p->'missing_items') AS e LIMIT 50 LOOP
            CONTINUE WHEN coalesce(miss->>'code', '') !~ '^[\w-]{1,40}$';
            INSERT INTO public.missing_product_counts (day, store_name, code, name, reports)
            VALUES (current_date, left(coalesce(miss->>'store', 'unknown'), 24), miss->>'code', left(coalesce(miss->>'name', ''), 120), 1)
            ON CONFLICT (day, store_name, code) DO UPDATE SET reports = public.missing_product_counts.reports + 1;
        END LOOP;
    END IF;

    IF jsonb_typeof(p->'store_health') = 'object' THEN
        FOR hlth IN SELECT key, value FROM jsonb_each(p->'store_health') LOOP
            CONTINUE WHEN (hlth.key = ANY (stores)) IS NOT TRUE OR jsonb_typeof(hlth.value) <> 'object';
            INSERT INTO public.store_health_daily (day, store_key, checks, ok_checks, matched_sum, ms_sum)
            VALUES (
                current_date,
                hlth.key,
                1,
                CASE WHEN coalesce((hlth.value->>'ok')::boolean, false) THEN 1 ELSE 0 END,
                least(greatest(coalesce((hlth.value->>'matched')::int, 0), 0), 500),
                least(greatest(coalesce((hlth.value->>'ms')::bigint, 0), 0), 60000)
            )
            ON CONFLICT (day, store_key) DO UPDATE SET
                checks      = public.store_health_daily.checks + 1,
                ok_checks   = public.store_health_daily.ok_checks + EXCLUDED.ok_checks,
                matched_sum = public.store_health_daily.matched_sum + EXCLUDED.matched_sum,
                ms_sum      = public.store_health_daily.ms_sum + EXCLUDED.ms_sum;
        END LOOP;
    END IF;
END $$;
REVOKE ALL ON FUNCTION public.log_event(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.log_event(jsonb) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.dashboard_stats(p_days int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
BEGIN
    RETURN jsonb_build_object(
        'totals', (
            SELECT jsonb_build_object(
                'comparisons', count(*) FILTER (WHERE event_type = 'comparison'),
                'switches',    count(*) FILTER (WHERE event_type = 'switch'),
                'saving_sum',  coalesce(sum(saving), 0),
                'saving_avg',  coalesce(round(avg(saving) FILTER (WHERE saving > 0), 2), 0),
                'with_saving', count(*) FILTER (WHERE saving > 0),
                'cart_avg',    coalesce(round(avg(cart_size), 1), 0),
                'matched_pct', coalesce(round(100.0 * sum(matched_count) / nullif(sum(cart_size), 0), 0), 0))
            FROM public.comparison_events WHERE created_at >= since),
        'by_day', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('day', d, 'comparisons', c, 'switches', s) ORDER BY d), '[]'::jsonb)
            FROM (SELECT created_at::date AS d,
                         count(*) FILTER (WHERE event_type = 'comparison') AS c,
                         count(*) FILTER (WHERE event_type = 'switch') AS s
                  FROM public.comparison_events WHERE created_at >= since GROUP BY 1) x),
        'cheapest', (
            SELECT coalesce(jsonb_object_agg(k, c), '{}'::jsonb)
            FROM (SELECT cheapest_store AS k, count(*) AS c FROM public.comparison_events
                  WHERE created_at >= since AND event_type = 'comparison' GROUP BY 1) x),
        'active', (
            SELECT coalesce(jsonb_object_agg(k, c), '{}'::jsonb)
            FROM (SELECT active_store AS k, count(*) AS c FROM public.comparison_events
                  WHERE created_at >= since AND event_type = 'comparison' GROUP BY 1) x),
        'switch_to', (
            SELECT coalesce(jsonb_object_agg(k, c), '{}'::jsonb)
            FROM (SELECT switch_store AS k, count(*) AS c FROM public.comparison_events
                  WHERE created_at >= since AND event_type = 'switch' GROUP BY 1) x),
        'cities', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('city', city, 'count', c) ORDER BY c DESC), '[]'::jsonb)
            FROM (SELECT city, count(*) AS c FROM public.comparison_events
                  WHERE created_at >= since AND event_type = 'comparison' AND city IS NOT NULL
                  GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 10) x),
        'products', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('barcode', barcode, 'name', name, 'count', c) ORDER BY c DESC), '[]'::jsonb)
            FROM (SELECT barcode, max(name) AS name, sum(compared) AS c FROM public.product_counts
                  WHERE day >= since::date GROUP BY 1 ORDER BY 3 DESC LIMIT 15) x),
        'store_health', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'store', store_key,
                'checks', checks,
                'ok_pct', round(100.0 * ok_checks / nullif(checks, 0), 0),
                'avg_ms', round(ms_sum::numeric / nullif(checks, 0), 0),
                'matched_avg', round(matched_sum::numeric / nullif(checks, 0), 1)
            ) ORDER BY store_key), '[]'::jsonb)
            FROM (SELECT store_key, sum(checks) AS checks, sum(ok_checks) AS ok_checks, sum(matched_sum) AS matched_sum, sum(ms_sum) AS ms_sum
                  FROM public.store_health_daily WHERE day >= since::date GROUP BY 1) sh),
        'missing_products', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('store', store_name, 'code', code, 'name', name, 'count', c) ORDER BY c DESC), '[]'::jsonb)
            FROM (SELECT store_name, code, max(name) AS name, sum(reports) AS c
                  FROM public.missing_product_counts WHERE day >= since::date GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 20) mp),
        'ai_review', (
            SELECT coalesce(jsonb_agg(row_to_json(ar)), '[]'::jsonb)
            FROM (
                SELECT 'substitute' AS kind, s.original_barcode AS key, p0.name AS orig_name,
                       p1.name AS match_name, s.neg_votes, s.chosen_count, s.created_at
                FROM public.substitutes s
                LEFT JOIN public.products p0 ON p0.barcode = s.original_barcode
                LEFT JOIN public.products p1 ON p1.barcode = s.substitute_barcode_1
                WHERE s.status = 'ai'
                UNION ALL
                SELECT 'match' AS kind, m.store_name || ':' || m.store_code AS key, m.name AS orig_name,
                       pm.name AS match_name, m.neg_votes, m.chosen_count, m.created_at
                FROM public.ai_matches m
                LEFT JOIN public.products pm ON pm.barcode = m.barcode AND m.neg_votes < 2
                ORDER BY created_at DESC LIMIT 25
            ) ar),
        'client_errors', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('at', at, 'store', store_key, 'step', step, 'code', error_code, 'version', ext_version) ORDER BY at DESC), '[]'::jsonb)
            FROM (SELECT * FROM public.client_errors WHERE at >= since ORDER BY at DESC LIMIT 30) ce),
        'accounts', (SELECT count(*) FROM auth.users),
        'ai_uses', (SELECT coalesce(sum(uses), 0) FROM public.ai_usage WHERE day >= since::date),
        'security', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('at', at, 'event', event) ORDER BY at DESC), '[]'::jsonb)
            FROM (SELECT at, event FROM public.security_log ORDER BY at DESC LIMIT 30) s),
        'feedback', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'message', message, 'contact', contact, 'version', ext_version)
                                      ORDER BY created_at DESC), '[]'::jsonb)
            FROM (SELECT * FROM public.feedback ORDER BY created_at DESC LIMIT 50) f)
    );
END $$;
REVOKE ALL ON FUNCTION public.dashboard_stats(int) FROM public, anon, authenticated;

COMMIT;
