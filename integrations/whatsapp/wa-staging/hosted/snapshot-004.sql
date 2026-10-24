-- ADR-025 — READ-ONLY. Run BEFORE upgrade-004 (psql -t -A); its output IS the rollback script of upgrade-004 for THIS database:
-- the exact current definitions of the 3 replaced functions (pg_get_functiondef), their privileges, and the removal of every object
-- upgrade-004 adds. Accounting rows are never touched; sim.expense_pending_classification is dropped only if empty.
BEGIN READ ONLY;
SELECT '-- ADR-025 rollback of upgrade-004, generated from the database itself at ' || now()::text;
SELECT E'\\set ON_ERROR_STOP 1';
SELECT 'BEGIN;';
SELECT 'DO $g$ BEGIN IF to_regclass(''migration_ledger.applied'') IS NOT NULL OR to_regclass(''public.perfiles'') IS NOT NULL OR to_regnamespace(''wa'') IS NULL OR to_regnamespace(''sim'') IS NULL'
    || ' THEN RAISE EXCEPTION ''ROLLBACK_GUARD: not the installed bot staging''; END IF; END $g$;';
SELECT pg_get_functiondef(x.sig::regprocedure) || E';\n'
       || 'ALTER FUNCTION ' || x.sig || ' OWNER TO postgres;' || E'\n'
       || 'REVOKE ALL ON FUNCTION ' || x.sig || ' FROM PUBLIC, anon, authenticated, service_role;'
       || CASE WHEN x.sig LIKE 'public.%' THEN E'\nGRANT EXECUTE ON FUNCTION ' || x.sig || ' TO authenticated;' ELSE '' END
  FROM unnest(ARRAY['wa.validate_payload(text,jsonb)', 'public.wa_confirm(bigint,uuid,integer)', 'public.wa_context(bigint)']) WITH ORDINALITY x(sig, i)
 ORDER BY x.i;
SELECT 'DROP VIEW IF EXISTS public.fin_mp_whatsapp_notes;';
SELECT 'DROP FUNCTION IF EXISTS wa.dispatch_unclassified(wa.draft, text, bigint), wa.selectable_categories(), wa.category_check(uuid, boolean), '
    || 'wa.selectable_accounts(), wa.account_check(uuid, text, boolean);';
SELECT 'DROP FUNCTION IF EXISTS sim.register_unclassified_expense(date, numeric, varchar, uuid, sim.payment_method, varchar, varchar, varchar, jsonb, text);';
SELECT 'DO $d$ BEGIN IF to_regclass(''sim.expense_pending_classification'') IS NOT NULL THEN'
    || ' IF (SELECT count(*) FROM sim.expense_pending_classification) = 0 THEN DROP TABLE sim.expense_pending_classification;'
    || ' ELSE RAISE NOTICE ''ROLLBACK_KEPT: sim.expense_pending_classification has rows (staging evidence kept)''; END IF; END IF; END $d$;';
SELECT 'SELECT ''rollback|'' || md5(pg_get_functiondef(''wa.validate_payload(text,jsonb)''::regprocedure)) || ''|'' || md5(pg_get_functiondef(''public.wa_confirm(bigint,uuid,integer)''::regprocedure))'
    || ' || ''|'' || md5(pg_get_functiondef(''public.wa_context(bigint)''::regprocedure)) || ''|new_objects='' || ((to_regprocedure(''wa.selectable_categories()'') IS NOT NULL)::int'
    || ' + (to_regclass(''public.fin_mp_whatsapp_notes'') IS NOT NULL)::int + (to_regprocedure(''wa.dispatch_unclassified(wa.draft, text, bigint)'') IS NOT NULL)::int);';
SELECT 'COMMIT;';
ROLLBACK;
