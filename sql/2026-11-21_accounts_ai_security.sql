-- Accounts (Supabase Auth), AI substitute usage, security log, dashboard lockout. 2026-11-21.
-- Run in Supabase: SQL Editor -> paste this whole file -> Run. Safe to run more than once.
-- The dashboard password itself is NOT in this file (the repository is public); it is set in the SQL Editor only.

BEGIN;

-- caller's IP as PostgREST passes it (first x-forwarded-for entry); empty outside an API request
CREATE OR REPLACE FUNCTION request_ip() RETURNS text LANGUAGE sql STABLE AS $$
    SELECT left(trim(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1)), 64)
$$;
REVOKE ALL ON FUNCTION request_ip() FROM public, anon, authenticated;

-- 1. Security log: sign-ins, sign-outs, account deletion, AI use, dashboard logins. Nobody reads it through the API.
CREATE TABLE IF NOT EXISTS security_log (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at      timestamptz NOT NULL DEFAULT now(),
    user_id uuid,              -- no foreign key: the line stays after the account is deleted
    event   text NOT NULL,
    detail  jsonb,
    ip      text
);
CREATE INDEX IF NOT EXISTS security_log_at ON security_log (at);
ALTER TABLE security_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON security_log FROM anon, authenticated;

-- a signed-in user may add a sign-in / sign-out line about himself only
CREATE OR REPLACE FUNCTION log_my_event(p_event text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF auth.uid() IS NULL OR p_event NOT IN ('sign_in', 'sign_out') THEN RETURN; END IF;
    INSERT INTO security_log (user_id, event, ip) VALUES (auth.uid(), p_event, request_ip());
END $$;
REVOKE ALL ON FUNCTION log_my_event(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION log_my_event(text) TO authenticated;

-- 2. Owners: no daily AI limit. Filled by hand in the SQL Editor.
CREATE TABLE IF NOT EXISTS owners (user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE);
ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON owners FROM anon, authenticated;

-- 3. AI substitute use: one row per user per day. The primary key is the daily limit.
CREATE TABLE IF NOT EXISTS ai_usage (
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    day     date NOT NULL DEFAULT current_date,
    PRIMARY KEY (user_id, day)
);
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ai_usage FROM anon, authenticated;
GRANT SELECT ON ai_usage TO authenticated;
DROP POLICY IF EXISTS "own usage only" ON ai_usage;
CREATE POLICY "own usage only" ON ai_usage FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

-- candidates for the AI to choose from; called only by the Edge Function (service role)
CREATE OR REPLACE FUNCTION ai_candidates(p_name text, p_exclude text, p_limit int DEFAULT 12)
RETURNS TABLE (barcode text, name text, stores text)
LANGUAGE sql STABLE SET search_path = public, extensions AS $$
    SELECT p.barcode, p.name, string_agg(sp.store_name, ',' ORDER BY sp.store_name)
    FROM products p JOIN store_products sp ON sp.barcode = p.barcode
    WHERE p.barcode <> p_exclude
      AND (p.name % p_name OR p.name ILIKE '%' || split_part(p_name, ' ', 1) || '%')
    GROUP BY p.barcode, p.name
    ORDER BY similarity(p.name, p_name) DESC
    LIMIT least(coalesce(p_limit, 12), 20)
$$;
REVOKE ALL ON FUNCTION ai_candidates(text, text, int) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION ai_candidates(text, text, int) TO service_role;

-- 4. Account deletion: the user deletes himself and everything linked to him (ai_usage, owners cascade)
CREATE OR REPLACE FUNCTION delete_my_account() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
    IF uid IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '28000'; END IF;
    INSERT INTO security_log (user_id, event, ip) VALUES (uid, 'account_deleted', request_ip());
    DELETE FROM auth.users WHERE id = uid;
END $$;
REVOKE ALL ON FUNCTION delete_my_account() FROM public, anon;
GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;

-- 5. Dashboard: numbers only after the password; 5 wrong tries per IP in 15 minutes, or 50 in an hour overall, lock it.
CREATE TABLE IF NOT EXISTS dashboard_attempts (at timestamptz NOT NULL DEFAULT now(), ip text, ok boolean NOT NULL);
ALTER TABLE dashboard_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON dashboard_attempts FROM anon, authenticated;

CREATE OR REPLACE FUNCTION dashboard_stats(p_days int) RETURNS jsonb
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
        'accounts', (SELECT count(*) FROM auth.users),
        'ai_uses', (SELECT count(*) FROM ai_usage WHERE day >= since::date),
        'security', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('at', at, 'event', event) ORDER BY at DESC), '[]'::jsonb)
            FROM (SELECT at, event FROM security_log ORDER BY at DESC LIMIT 30) s),
        'feedback', (
            SELECT coalesce(jsonb_agg(jsonb_build_object('at', created_at, 'message', message, 'contact', contact, 'version', ext_version)
                                      ORDER BY created_at DESC), '[]'::jsonb)
            FROM (SELECT * FROM feedback ORDER BY created_at DESC LIMIT 50) f)
    );
END $$;
REVOKE ALL ON FUNCTION dashboard_stats(int) FROM public, anon, authenticated;

-- returns {"error": ...} instead of raising, so the failed attempt is recorded (an exception would roll it back)
CREATE OR REPLACE FUNCTION dashboard_data(p_key text, p_days int DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
    v_ip text := request_ip();
    v_ok boolean;
BEGIN
    IF (SELECT count(*) FROM dashboard_attempts WHERE NOT ok AND ip = v_ip AND at > now() - interval '15 minutes') >= 5
       OR (SELECT count(*) FROM dashboard_attempts WHERE NOT ok AND at > now() - interval '1 hour') >= 50 THEN
        INSERT INTO security_log (event, ip) VALUES ('dashboard_locked', v_ip);
        RETURN jsonb_build_object('error', 'locked');
    END IF;
    v_ok := EXISTS (SELECT 1 FROM dashboard_access WHERE key_hash = encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex'));
    INSERT INTO dashboard_attempts (ip, ok) VALUES (v_ip, v_ok);
    DELETE FROM dashboard_attempts WHERE at < now() - interval '2 days';
    IF NOT v_ok THEN
        PERFORM pg_sleep(1);
        INSERT INTO security_log (event, ip) VALUES ('dashboard_login_failed', v_ip);
        RETURN jsonb_build_object('error', 'wrong_password');
    END IF;
    INSERT INTO security_log (event, ip) VALUES ('dashboard_login', v_ip);
    RETURN dashboard_stats(p_days);
END $$;
REVOKE ALL ON FUNCTION dashboard_data(text, int) FROM public;
GRANT EXECUTE ON FUNCTION dashboard_data(text, int) TO anon, authenticated;

COMMIT;
