-- PHASE 31 Step 2 — READ-ONLY diagnosis of SECURITY DEFINER functions in schema public (target project).
-- No secret, no data row is printed. Run:  psql "$CUTOVER_TARGET_DB_URL" -X -A -F '|' -f target-definer-diagnosis.sql
BEGIN TRANSACTION READ ONLY;

-- 1. platform / version
SELECT 'pg_version' AS k, current_setting('server_version') AS v
UNION ALL SELECT 'ext:' || extname, extversion FROM pg_extension ORDER BY 1;

-- 2. full inventory used by provision-target.mjs verify (schema public, prosecdef), sorted by identity
SELECT p.oid::regprocedure::text AS identity,
       pg_get_userbyid(p.proowner) AS owner,
       l.lanname AS lang,
       pg_get_function_result(p.oid) AS returns,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       coalesce(p.proacl::text, '(default: PUBLIC EXECUTE)') AS acl,
       (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
         WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS extension
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
 WHERE p.prosecdef AND p.pronamespace = 'public'::regnamespace
 ORDER BY 1;

-- 3. focus: every public SECURITY DEFINER executable by anon (directly, via PUBLIC, or by role membership)
SELECT 'ANON_EXECUTABLE' AS k, p.oid::regprocedure::text AS identity,
       pg_get_userbyid(p.proowner) AS owner,
       pg_get_function_result(p.oid) AS returns,
       coalesce(p.proacl::text, '(NULL acl = PUBLIC EXECUTE)') AS acl,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec,
       EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 'anon'::regrole AND a.privilege_type = 'EXECUTE') AS anon_direct,
       (SELECT string_agg(evtname || ':' || evtevent, ',') FROM pg_event_trigger WHERE evtfoid = p.oid) AS event_triggers,
       (SELECT string_agg(tgrelid::regclass::text || ':' || tgname, ',') FROM pg_trigger WHERE tgfoid = p.oid) AS triggers,
       left(regexp_replace(p.prosrc, '\s+', ' ', 'g'), 400) AS source_head
  FROM pg_proc p
 WHERE p.prosecdef AND p.pronamespace = 'public'::regnamespace AND has_function_privilege('anon', p.oid, 'EXECUTE');

-- 4. is the function part of the target migrations? (ledger never records functions; compare names to this list in the report)
SELECT 'ledger_rows' AS k, count(*)::text FROM migration_ledger.applied;

-- 5. API exposure context
SELECT 'pgrst_db_schemas' AS k, coalesce(current_setting('pgrst.db_schemas', true), '(not set at DB level)')
UNION ALL SELECT 'event_triggers_total', count(*)::text FROM pg_event_trigger
UNION ALL SELECT 'event_trigger:' || evtname, evtevent || ' -> ' || evtfoid::regprocedure::text || ' enabled=' || evtenabled::text FROM pg_event_trigger;
ROLLBACK;
