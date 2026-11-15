-- Feedback, anonymous statistics and the owner's dashboard.
-- Run once in Supabase: SQL Editor -> paste this whole file -> Run. Safe to run more than once.
-- Then do the one manual step at the bottom (choosing the dashboard password).

BEGIN;

-- 1. Feedback: anyone may send a message, nobody can read messages with the public key.
CREATE TABLE IF NOT EXISTS feedback (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now(),
    message     text NOT NULL CHECK (char_length(message) BETWEEN 3 AND 2000),
    contact     text CHECK (char_length(contact) <= 200),
    ext_version text CHECK (char_length(ext_version) <= 20)
);
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone can send feedback" ON feedback;
CREATE POLICY "anyone can send feedback" ON feedback FOR INSERT TO anon, authenticated WITH CHECK (true);
REVOKE ALL ON feedback FROM anon, authenticated;
GRANT INSERT ON feedback TO anon, authenticated;

-- 2. Statistics. One row per comparison with totals only: no user id, no list of products.
CREATE TABLE IF NOT EXISTS comparison_events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at     timestamptz NOT NULL DEFAULT now(),
    event_type     text NOT NULL,            -- 'comparison' or 'switch' (the shopper asked to build the cart at a chain)
    active_store   text,
    cheapest_store text,
    switch_store   text,
    city           text,
    cart_size      int,
    matched_count  int,
    saving         numeric(10,2),
    totals         jsonb,
    ext_version    text
);
CREATE INDEX IF NOT EXISTS comparison_events_created_at ON comparison_events (created_at);
ALTER TABLE comparison_events ENABLE ROW LEVEL SECURITY;   -- no policies: only the functions below touch it
REVOKE ALL ON comparison_events FROM anon, authenticated;

-- Product popularity is counted per day, detached from any cart, so a cart can never be rebuilt from it.
CREATE TABLE IF NOT EXISTS product_counts (
    day      date NOT NULL,
    barcode  text NOT NULL,
    name     text,
    compared int  NOT NULL DEFAULT 0,
    PRIMARY KEY (day, barcode)
);
ALTER TABLE product_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON product_counts FROM anon, authenticated;

-- The only way the extension writes statistics. Everything is validated and clamped here.
CREATE OR REPLACE FUNCTION log_event(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    stores constant text[] := ARRAY['shufersal', 'ramiLevy', 'victory', 'machsaneiHashuk'];
    prod jsonb;
BEGIN
    IF p->>'type' = 'switch' THEN
        IF (p->>'store' = ANY (stores)) IS NOT TRUE THEN RETURN; END IF;
        INSERT INTO comparison_events (event_type, switch_store, city, ext_version)
        VALUES ('switch', p->>'store', left(p->>'city', 60), left(p->>'ext_version', 20));
        RETURN;
    END IF;

    IF (p->>'type' = 'comparison' AND p->>'active_store' = ANY (stores) AND p->>'cheapest_store' = ANY (stores)) IS NOT TRUE THEN
        RETURN;
    END IF;

    INSERT INTO comparison_events (event_type, active_store, cheapest_store, city, cart_size, matched_count, saving, totals, ext_version)
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
        INSERT INTO product_counts (day, barcode, name, compared)
        VALUES (current_date, prod->>'barcode', left(prod->>'name', 120), 1)
        ON CONFLICT (day, barcode) DO UPDATE SET compared = product_counts.compared + 1;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION log_event(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION log_event(jsonb) TO anon, authenticated;

-- 3. The dashboard. It reads aggregates only, and only with the owner's password (stored as a hash).
-- shortcut: one shared password instead of personal sign-in; move to Supabase Auth when Google sign-in is added.
CREATE TABLE IF NOT EXISTS dashboard_access (key_hash text PRIMARY KEY);
ALTER TABLE dashboard_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dashboard_access FROM anon, authenticated;

CREATE OR REPLACE FUNCTION dashboard_data(p_key text, p_days int DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dashboard_access WHERE key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex')) THEN
        PERFORM pg_sleep(1);   -- slows password guessing
        RAISE EXCEPTION 'wrong dashboard password' USING ERRCODE = '28000';
    END IF;

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
            FROM comparison_events WHERE created_at >= since),
        'by_day', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('day', d, 'comparisons', c, 'switches', s) ORDER BY d), '[]'::jsonb)
            FROM (SELECT created_at::date AS d,
                         count(*) FILTER (WHERE event_type = 'comparison') AS c,
                         count(*) FILTER (WHERE event_type = 'switch') AS s
                  FROM comparison_events WHERE created_at >= since GROUP BY 1) x),
        'cheapest', (
            SELECT coalesce(jsonb_object_agg(k, c), '{}'::jsonb)
            FROM (SELECT cheapest_store AS k, count(*) AS c FROM comparison_events
                  WHERE created_at >= since AND event_type = 'comparison' GROUP BY 1) x),
        'active', (
            SELECT coalesce(jsonb_object_agg(k, c), '{}'::jsonb)
            FROM (SELECT active_store AS k, count(*) AS c FROM comparison_events
                  WHERE created_at >= since AND event_type = 'comparison' GROUP BY 1) x),
        'switch_to', (
            SELECT coalesce(jsonb_object_agg(k, c), '{}'::jsonb)
            FROM (SELECT switch_store AS k, count(*) AS c FROM comparison_events
                  WHERE created_at >= since AND event_type = 'switch' GROUP BY 1) x),
        -- a city with fewer than 3 comparisons is left out, so a lone shopper in a small town is not singled out
        'cities', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('city', city, 'count', c) ORDER BY c DESC), '[]'::jsonb)
            FROM (SELECT city, count(*) AS c FROM comparison_events
                  WHERE created_at >= since AND event_type = 'comparison' AND city IS NOT NULL
                  GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 10) x),
        'products', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('barcode', barcode, 'name', name, 'count', c) ORDER BY c DESC), '[]'::jsonb)
            FROM (SELECT barcode, max(name) AS name, sum(compared) AS c FROM product_counts
                  WHERE day >= since::date GROUP BY 1 ORDER BY 3 DESC LIMIT 15) x),
        'feedback', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'message', message, 'contact', contact, 'version', ext_version)
                                      ORDER BY created_at DESC), '[]'::jsonb)
            FROM (SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50) f)
    );
END $$;
REVOKE ALL ON FUNCTION dashboard_data(text, int) FROM public;
GRANT EXECUTE ON FUNCTION dashboard_data(text, int) TO anon, authenticated;

COMMIT;

-- ONE MANUAL STEP (the owner): choose a long password, put it between the quotes instead of the Hebrew text,
-- remove the two dashes at the start of the next line, and run just that line:
-- INSERT INTO dashboard_access VALUES (encode(sha256(convert_to('כאן-כותבים-סיסמה-ארוכה', 'UTF8')), 'hex')) ON CONFLICT DO NOTHING;
