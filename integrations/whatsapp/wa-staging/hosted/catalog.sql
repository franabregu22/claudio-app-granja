-- ADR-025 §18 hosted — READ-ONLY catalog / effective-privilege checks on AppGranja. Variable: gw (gateway Auth user id).
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH api(r) AS (VALUES ('anon'), ('authenticated'), ('service_role')),
fn AS (SELECT p.oid, n.nspname, p.proname, p.prosecdef, p.proowner::regrole::text AS owner, p.proconfig, p.prorettype
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('wa', 'sim') OR (n.nspname = 'public' AND p.proname LIKE 'wa\_%')),
checks(name, got, expected) AS (VALUES
  ('K-1 schemas wa+sim present', ((to_regnamespace('wa') IS NOT NULL) AND (to_regnamespace('sim') IS NOT NULL))::text, 'true'),
  ('K-2 no API role has USAGE on wa / sim', (SELECT count(*) FROM api, unnest(ARRAY['wa', 'sim']) s WHERE has_schema_privilege(api.r, s, 'USAGE'))::text, '0'),
  ('K-3 tables wa / sim', (SELECT count(*) FILTER (WHERE schemaname = 'wa') || '/' || count(*) FILTER (WHERE schemaname = 'sim') FROM pg_tables WHERE schemaname IN ('wa', 'sim')), '7/9'),
  ('K-4 RLS enabled on every wa / sim table', (SELECT count(*) FROM pg_class c WHERE c.relnamespace IN ('wa'::regnamespace, 'sim'::regnamespace) AND c.relkind = 'r' AND NOT c.relrowsecurity)::text, '0'),
  ('K-5 no API role privilege on any wa / sim table, view or sequence', (SELECT count(*) FROM api, pg_class c
      WHERE c.relnamespace IN ('wa'::regnamespace, 'sim'::regnamespace) AND c.relkind IN ('r', 'v', 'S')
        AND (CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(api.r, c.oid, 'USAGE,SELECT,UPDATE')
                  ELSE has_table_privilege(api.r, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END))::text, '0'),
  ('K-6 public.wa_*: 8, SECURITY DEFINER, owner postgres, search_path pinned', (SELECT count(*) || '|' || count(*) FILTER (WHERE prosecdef AND owner = 'postgres'
      AND proconfig @> ARRAY['search_path=sim, public, pg_temp']) FROM fn WHERE nspname = 'public'), '8|8'),
  ('K-7 public.wa_*: EXECUTE authenticated only (not anon, not service_role)', (SELECT count(*) FILTER (WHERE has_function_privilege('authenticated', oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', oid, 'EXECUTE') AND NOT has_function_privilege('service_role', oid, 'EXECUTE')) FROM fn WHERE nspname = 'public')::text, '8'),
  ('K-8 wa.* / sim.* functions executable by no API role', (SELECT count(*) FROM fn, api WHERE nspname IN ('wa', 'sim') AND has_function_privilege(api.r, oid, 'EXECUTE'))::text, '0'),
  ('K-9 check Q: no callable SECURITY DEFINER of public / wa / sim executable by PUBLIC', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'wa', 'sim') AND p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
        AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))::text, '0'),
  ('K-10 wa.config: enabled, gateway = wa-gateway user', (SELECT enabled || '|' || (gateway_user_id = :'gw'::uuid) FROM wa.config), 'true|true'),
  ('K-11 gateway user has no profile', (SELECT count(*) FROM sim.perfiles WHERE id = :'gw'::uuid)::text, '0'),
  ('K-12 senders → profiles: ADMIN, ADMIN, OPERATOR (all synthetic, active)', (SELECT string_agg(p.rol_type::text, ',' ORDER BY p.rol_type, p.email) || '|' || bool_and(p.email LIKE '%@staging.invalid' AND s.activo AND p.activo)
      FROM wa.sender s JOIN sim.perfiles p ON p.id = s.perfil_id), 'ADMIN,ADMIN,OPERATOR|true'),
  ('K-13 public has no tables or views (no accounting outside sim)', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')::text, '0'),
  ('K-14 no ERP: no migration ledger, no public.perfiles, no public.register_*', ((to_regclass('migration_ledger.applied') IS NULL) AND (to_regclass('public.perfiles') IS NULL)
      AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'register\_%'))::text, 'true'),
  ('K-15 test precondition: no Meta secret in Vault yet', (SELECT count(*) FROM vault.secrets WHERE name = 'wa_meta_app_secret')::text, '0'),
  ('K-16 pending sim outflows 25001 / 25002 unclassified', (SELECT count(*) FROM sim.mp_pending_outflow WHERE source_id IN ('930000025001', '930000025002') AND classified_as IS NULL)::text, '2'),
  ('K-17 no cron jobs', CASE WHEN to_regclass('cron.job') IS NULL THEN '0' ELSE (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM cron.job', false, true, '')))[1]::text END, '0'))
SELECT 'catalog|' || CASE WHEN got IS NOT DISTINCT FROM expected THEN 'PASS ' ELSE 'FAIL ' END || name || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY name COLLATE "C";
ROLLBACK;
