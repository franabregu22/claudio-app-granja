-- ADR-025 — READ-ONLY preflight of upgrade-005 (payment method never presumed) on the INSTALLED bot staging (AppGranja).
-- Output lines: pre|<name>|<value>|PASS|FAIL|INFO. The apply script requires every PASS line (5) and no FAIL.
BEGIN READ ONLY;
WITH c AS (
  SELECT 'fingerprint' AS n, ((to_regclass('migration_ledger.applied') IS NULL) AND (to_regclass('public.perfiles') IS NULL)
                              AND (to_regnamespace('wa') IS NOT NULL) AND (to_regnamespace('sim') IS NOT NULL))::text AS v, 'true' AS want
  UNION ALL SELECT 'upgrade-004 installed', ((to_regprocedure('wa.selectable_categories()') IS NOT NULL) AND (to_regprocedure('wa.dispatch_unclassified(wa.draft, text, bigint)') IS NOT NULL)
                     AND (to_regclass('public.fin_mp_whatsapp_notes') IS NOT NULL))::text, 'true'
  UNION ALL SELECT 'upgrade-005 absent', (pg_get_functiondef('wa.validate_payload(text,jsonb)'::regprocedure) NOT LIKE '%method_pending%'
                     AND pg_get_functiondef('public.wa_confirm(bigint,uuid,integer)'::regprocedure) NOT LIKE '%WA_METHOD_REQUIRED%'
                     AND pg_get_functiondef('public.wa_correct(bigint,uuid,integer,jsonb)'::regprocedure) NOT LIKE '%WA_BUTTON_MISMATCH%')::text, 'true'
  UNION ALL SELECT 'public wa_* functions', (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%'), '8'
  UNION ALL SELECT 'no draft CONFIRMING (no confirmation in flight)', (SELECT count(*)::text FROM wa.draft WHERE state = 'CONFIRMING'), '0'
)
SELECT 'pre|' || n || '|' || v || '|' || CASE WHEN v = want THEN 'PASS' ELSE 'FAIL' END FROM c
UNION ALL
-- the 3 functions upgrade-005 replaces: their exact current definitions (the rollback restores these; drift is reported)
SELECT 'pre|md5 ' || x.sig || '|' || md5(pg_get_functiondef(x.sig::regprocedure)) || '|INFO'
  FROM unnest(ARRAY['wa.validate_payload(text,jsonb)', 'public.wa_correct(bigint,uuid,integer,jsonb)', 'public.wa_confirm(bigint,uuid,integer)']) x(sig)
UNION ALL
SELECT 'pre|drafts by state|' || coalesce((SELECT string_agg(state || '=' || n, ',' ORDER BY state) FROM (SELECT state, count(*) n FROM wa.draft GROUP BY state) s), 'none') || '|INFO'
UNION ALL SELECT 'pre|last inbound|' || coalesce((SELECT max(received_at)::text FROM wa.inbound_message), 'none') || '|INFO';
ROLLBACK;
