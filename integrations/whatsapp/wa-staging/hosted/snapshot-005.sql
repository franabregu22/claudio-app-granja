-- ADR-025 — READ-ONLY. Run BEFORE upgrade-005 (psql -t -A); its output IS the rollback script of upgrade-005 for THIS database:
-- the exact current definitions of the 3 replaced functions (pg_get_functiondef) and their privileges. upgrade-005 adds no object.
BEGIN READ ONLY;
SELECT '-- ADR-025 rollback of upgrade-005, generated from the database itself at ' || now()::text;
SELECT E'\\set ON_ERROR_STOP 1';
SELECT 'BEGIN;';
SELECT 'DO $g$ BEGIN IF to_regclass(''migration_ledger.applied'') IS NOT NULL OR to_regclass(''public.perfiles'') IS NOT NULL OR to_regnamespace(''wa'') IS NULL OR to_regnamespace(''sim'') IS NULL'
    || ' THEN RAISE EXCEPTION ''ROLLBACK_GUARD: not the installed bot staging''; END IF; END $g$;';
SELECT pg_get_functiondef(x.sig::regprocedure) || E';\n'
       || 'ALTER FUNCTION ' || x.sig || ' OWNER TO postgres;' || E'\n'
       || 'REVOKE ALL ON FUNCTION ' || x.sig || ' FROM PUBLIC, anon, authenticated, service_role;'
       || CASE WHEN x.sig LIKE 'public.%' THEN E'\nGRANT EXECUTE ON FUNCTION ' || x.sig || ' TO authenticated;' ELSE '' END
  FROM unnest(ARRAY['wa.validate_payload(text,jsonb)', 'public.wa_correct(bigint,uuid,integer,jsonb)', 'public.wa_confirm(bigint,uuid,integer)']) WITH ORDINALITY x(sig, i)
 ORDER BY x.i;
SELECT 'SELECT ''rollback|'' || md5(pg_get_functiondef(''wa.validate_payload(text,jsonb)''::regprocedure)) || ''|'' || md5(pg_get_functiondef(''public.wa_correct(bigint,uuid,integer,jsonb)''::regprocedure))'
    || ' || ''|'' || md5(pg_get_functiondef(''public.wa_confirm(bigint,uuid,integer)''::regprocedure));';
SELECT 'COMMIT;';
ROLLBACK;
