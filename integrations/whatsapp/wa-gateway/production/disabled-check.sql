-- ADR-025 — the bot is OFF while wa.config.enabled = false: every public.wa_* entry point is refused for the gateway itself
-- (and for an ADMIN), and nothing is recorded. LOCAL ERP database only (rolled back; nothing persists).
--   docker exec -i <client> psql -U postgres -d <local erp db> -X -q -t -A -f - < production/disabled-check.sql
\set ON_ERROR_STOP 1
BEGIN;
DO $g$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NULL OR (SELECT max(version) FROM migration_ledger.applied) < '0102' THEN RAISE EXCEPTION 'needs an ERP database at 0102'; END IF;
  IF current_database() NOT LIKE 'erp\_%' AND current_database() <> 'postgres' THEN RAISE EXCEPTION 'local ERP databases only'; END IF;
  IF EXISTS (SELECT 1 FROM wa.config) THEN RAISE EXCEPTION 'wa.config already has a row: run on a database where the bot was never configured'; END IF;
END $g$;
-- the production preparation: gateway identity (no ERP profile) + config DISABLED + one ADMIN mapped (as step E would do)
CREATE TEMP TABLE t_ids AS SELECT gen_random_uuid() AS gw,
  (SELECT id FROM perfiles WHERE activo AND rol_type::text = 'ADMIN' ORDER BY id LIMIT 1) AS admin;
INSERT INTO wa.config (gateway_user_id, enabled) SELECT gw, false FROM t_ids;
INSERT INTO wa.sender (phone_e164, perfil_id) SELECT '+5491100000099', admin FROM t_ids;
CREATE TEMP TABLE t_before AS SELECT
  (SELECT count(*) FROM purchases) AS purchases, (SELECT count(*) FROM financial_operation) AS ops, (SELECT count(*) FROM financial_posting) AS postings,
  (SELECT count(*) FROM expense_pending_classification) AS pending, (SELECT count(*) FROM wa.inbound_message) AS inbound, (SELECT count(*) FROM wa.draft) AS drafts;
GRANT SELECT ON t_ids TO authenticated;
CREATE TEMP TABLE t_out (who text, fn text, result text);
GRANT INSERT ON t_out TO authenticated;
-- every entry point, called as `who`; the result is the error text (or OK)
CREATE FUNCTION pg_temp.try(p_who text, p_uid uuid, p_fn text, p_sql text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN EXECUTE p_sql; INSERT INTO t_out VALUES (p_who, p_fn, 'OK');
  EXCEPTION WHEN OTHERS THEN INSERT INTO t_out VALUES (p_who, p_fn, left(SQLERRM, 60)); END;
  RESET ROLE;
END $f$;
DO $t$ DECLARE gw uuid := (SELECT gw FROM t_ids); ad uuid := (SELECT admin FROM t_ids); d uuid := gen_random_uuid(); w text; u uuid; BEGIN
  FOREACH w IN ARRAY ARRAY['gateway', 'admin'] LOOP
    u := CASE w WHEN 'gateway' THEN gw ELSE ad END;
    PERFORM pg_temp.try(w, u, 'wa_ingest', $$SELECT public.wa_ingest(encode(convert_to('{"object":"whatsapp_business_account","entry":[]}', 'UTF8'), 'base64'), 'sha256=' || repeat('0', 64))$$);
    PERFORM pg_temp.try(w, u, 'wa_propose', $$SELECT public.wa_propose(1, 'CASUAL_EXPENSE', '{"total":1000,"concept":"x"}'::jsonb)$$);
    PERFORM pg_temp.try(w, u, 'wa_correct', format($$SELECT public.wa_correct(1, %L, 1, '{"total":2000}'::jsonb)$$, d));
    PERFORM pg_temp.try(w, u, 'wa_cancel', format($$SELECT public.wa_cancel(1, %L, 1)$$, d));
    PERFORM pg_temp.try(w, u, 'wa_link_mp', format($$SELECT public.wa_link_mp(1, %L, 1, '123')$$, d));
    PERFORM pg_temp.try(w, u, 'wa_confirm', format($$SELECT public.wa_confirm(1, %L, 1)$$, d));
    PERFORM pg_temp.try(w, u, 'wa_expire', $$SELECT public.wa_expire()$$);
    PERFORM pg_temp.try(w, u, 'wa_context', $$SELECT public.wa_context(1)$$);
  END LOOP;
END $t$;
SELECT 'check|' || CASE WHEN result LIKE 'FORBIDDEN%' THEN 'PASS' ELSE 'FAIL' END || '|' || who || ' ' || fn || ' refused while disabled :: ' || result FROM t_out ORDER BY who, fn;
SELECT 'check|' || CASE WHEN b.purchases = (SELECT count(*) FROM purchases) AND b.ops = (SELECT count(*) FROM financial_operation)
    AND b.postings = (SELECT count(*) FROM financial_posting) AND b.pending = (SELECT count(*) FROM expense_pending_classification)
    AND b.inbound = (SELECT count(*) FROM wa.inbound_message) AND b.drafts = (SELECT count(*) FROM wa.draft) THEN 'PASS' ELSE 'FAIL' END
  || '|nothing recorded: purchases, operations, postings, unclassified expenses, inbound messages, drafts unchanged' FROM t_before b;
SELECT 'check|' || CASE WHEN (SELECT count(*) FROM perfiles WHERE id = (SELECT gw FROM t_ids)) = 0 THEN 'PASS' ELSE 'FAIL' END || '|the gateway identity has no ERP profile';
ROLLBACK;
