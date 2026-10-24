-- ADR-025 — READ-ONLY verification after upgrade-005 (psql -v pre='<accounting snapshot before>'). Changes nothing.
-- Output: check|<group>|<name>|<value>|PASS|FAIL.
BEGIN READ ONLY;
WITH c AS (
  SELECT 'FUNCIONES' g, 'validate_payload keeps a pending method (never presumed)' n, (pg_get_functiondef('wa.validate_payload(text,jsonb)'::regprocedure) LIKE '%method_pending%')::text v, 'true' w
  UNION ALL SELECT 'FUNCIONES', 'wa_confirm refuses CONFIRM / UNCLASSIFIED while the method is pending (WA_METHOD_REQUIRED)',
         (pg_get_functiondef('public.wa_confirm(bigint,uuid,integer)'::regprocedure) LIKE '%WA_METHOD_REQUIRED%')::text, 'true'
  UNION ALL SELECT 'FUNCIONES', 'wa_correct accepts a button only as METHOD:<draft>:<version>:<method> (WA_BUTTON_MISMATCH)',
         (pg_get_functiondef('public.wa_correct(bigint,uuid,integer,jsonb)'::regprocedure) LIKE '%WA_BUTTON_MISMATCH%')::text, 'true'
  UNION ALL SELECT 'UPGRADE_004', 'upgrade-004 objects still installed (rules, unclassified dispatch, MP notes view)',
         ((to_regprocedure('wa.selectable_categories()') IS NOT NULL) AND (to_regprocedure('wa.dispatch_unclassified(wa.draft, text, bigint)') IS NOT NULL)
          AND (to_regclass('public.fin_mp_whatsapp_notes') IS NOT NULL))::text, 'true'
  UNION ALL SELECT 'API', 'public wa_* = 8, SECURITY DEFINER, authenticated only',
         (SELECT count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'wa\_%' AND p.prosecdef
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')), '8'
  UNION ALL SELECT 'API', 'no wa.* / sim.* function executable by an API role',
         (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('wa', 'sim')
            AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), '0'
  UNION ALL SELECT 'SIN_CAMBIOS', 'accounting snapshot unchanged by the upgrade',
         'purchases=' || (SELECT count(*) FROM sim.purchases) || '|sum=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
         || '|mp_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow) || '|confirmations=' || (SELECT count(*) FROM wa.confirmation), :'pre'
)
SELECT 'check|' || g || '|' || n || '|' || v || '|' || CASE WHEN v = w THEN 'PASS' ELSE 'FAIL' END FROM c;
ROLLBACK;
