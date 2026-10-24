-- ADR-025 — READ-ONLY preflight of upgrade-004 on the INSTALLED bot staging (AppGranja). Changes nothing.
-- Output lines: pre|<name>|<value>|PASS|FAIL|INFO. The apply script requires every PASS line and no FAIL.
BEGIN READ ONLY;
WITH c AS (
  SELECT 'fingerprint' AS n, ((to_regclass('migration_ledger.applied') IS NULL) AND (to_regclass('public.perfiles') IS NULL)
                              AND (to_regnamespace('wa') IS NOT NULL) AND (to_regnamespace('sim') IS NOT NULL))::text AS v, 'true' AS want
  UNION ALL SELECT 'upgrade-001 wa_context', (to_regprocedure('public.wa_context(bigint)') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 'upgrade-003 duplicate_refs', (to_regprocedure('wa.duplicate_refs(jsonb, uuid)') IS NOT NULL)::text, 'true'
  UNION ALL SELECT 'upgrade-004 absent', ((to_regprocedure('wa.selectable_categories()') IS NULL) AND (to_regprocedure('wa.category_check(uuid, boolean)') IS NULL)
                     AND (to_regprocedure('wa.selectable_accounts()') IS NULL) AND (to_regprocedure('wa.account_check(uuid, text, boolean)') IS NULL)
                     AND (to_regprocedure('wa.dispatch_unclassified(wa.draft, text, bigint)') IS NULL) AND (to_regclass('public.fin_mp_whatsapp_notes') IS NULL)
                     AND (to_regclass('sim.expense_pending_classification') IS NULL))::text, 'true'
  UNION ALL SELECT 'public wa_* functions', (SELECT count(*)::text FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%'), '8'
  UNION ALL SELECT 'no draft CONFIRMING (no confirmation in flight)', (SELECT count(*)::text FROM wa.draft WHERE state = 'CONFIRMING'), '0'
  -- the accounts the published V2 resolves by name (interpreter-config account_by_method) must keep their type → method
  UNION ALL SELECT 'V2 accounts by name (Caja chica CASH, BNA BANK_ACCOUNT, Mercado Pago EXTERNAL_SERVICE, active)',
         (SELECT count(*)::text FROM sim.financial_account WHERE activo AND (nombre, account_type::text) IN (('Caja chica', 'CASH'), ('BNA', 'BANK_ACCOUNT'), ('Mercado Pago', 'EXTERNAL_SERVICE'))), '3'
)
SELECT 'pre|' || n || '|' || v || '|' || CASE WHEN v = want THEN 'PASS' ELSE 'FAIL' END FROM c
UNION ALL
-- the 3 functions upgrade-004 replaces: their exact current definitions (the rollback restores these; drift is reported)
SELECT 'pre|md5 ' || x.sig || '|' || md5(pg_get_functiondef(x.sig::regprocedure)) || '|INFO'
  FROM unnest(ARRAY['wa.validate_payload(text,jsonb)', 'public.wa_confirm(bigint,uuid,integer)', 'public.wa_context(bigint)']) x(sig)
UNION ALL
SELECT 'pre|drafts by state|' || coalesce((SELECT string_agg(state || '=' || n, ',' ORDER BY state) FROM (SELECT state, count(*) n FROM wa.draft GROUP BY state) s), 'none') || '|INFO'
UNION ALL SELECT 'pre|wa.config enabled|' || coalesce((SELECT enabled::text FROM wa.config), 'missing') || '|INFO'
UNION ALL SELECT 'pre|last inbound|' || coalesce((SELECT max(received_at)::text FROM wa.inbound_message), 'none') || '|INFO';
ROLLBACK;
