-- ADR-025 B-4 — PRODUCTION parity for the candidate migration 0101 and the WhatsApp expense flow. READ-ONLY:
-- one REPEATABLE READ READ ONLY transaction, rolled back. Prints object names, ACLs, counts, business catalog names (accounts,
-- categories) and truncated profile ids only — no email, person name, balance, amount or secret value.
\set ON_ERROR_STOP 1
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH
rpc(sig) AS (VALUES
  ('public.register_casual_purchase(date,numeric,numeric,uuid,varchar,purchase_nature,uuid,payment_method,varchar,varchar,jsonb,jsonb,jsonb,uuid,uuid,text,text)'),
  ('public.register_purchase(uuid,date,numeric,numeric,uuid,varchar,purchase_nature,jsonb,jsonb,varchar,uuid,uuid,varchar,uuid,text)'),
  ('public.register_purchase_with_fiscal_document(uuid,date,numeric,numeric,uuid,purchase_nature,jsonb,jsonb,varchar,fiscal_document_type,date,numeric,numeric,jsonb,varchar,uuid,varchar,uuid,text)'),
  ('public.register_fiscal_document(fiscal_document_type,fiscal_direction,date,date,numeric,numeric,jsonb,uuid,uuid,varchar,text,varchar,varchar)')),
rpcs AS (SELECT r.sig, to_regprocedure(r.sig) AS oid FROM rpc r),
pub AS (SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
           AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))),
-- every table / column the candidate 0101 reads directly (outside the RPCs it calls)
deps(t, c) AS (VALUES ('perfiles','id'),('perfiles','activo'),('perfiles','rol_type'),
  ('expense_category','id'),('expense_category','nombre'),('expense_category','activo'),('expense_category','fiscal_reserved'),('expense_category','group_id'),
  ('expense_category_group','id'),('expense_category_group','kind'),('expense_category_group','activo'),
  ('financial_account','id'),('financial_account','nombre'),('financial_account','account_type'),('financial_account','activo'),
  ('purchases','is_current'),('purchases','amount_total'),('purchases','economic_date'),('purchases','expense_category_id'),('purchases','idempotency_key'),('purchases','created_at'),
  ('fin_mp_pending_classification','source_id'),('fin_mp_pending_classification','direction'),('fin_mp_pending_classification','status'),
  ('fin_mp_pending_classification','economic_amount'),('fin_mp_pending_classification','business_date')),
missing AS (SELECT d.t || '.' || d.c AS col FROM deps d WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns ic
             WHERE ic.table_schema = 'public' AND ic.table_name = d.t AND ic.column_name = d.c)),
acc AS (SELECT a.nombre, a.account_type::text AS t FROM financial_account a WHERE a.activo),
sel AS (SELECT c.id, c.nombre, g.nombre AS grupo FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
         WHERE c.activo AND NOT c.fiscal_reserved AND g.kind::text = 'EXPENSE' AND g.activo),
adm AS (SELECT p.id FROM perfiles p WHERE p.activo AND p.rol_type::text = 'ADMIN'),
checks(grp, name, got, expected) AS (VALUES
  ('1_IDENTIDAD', 'I-1 migration ledger max version', (SELECT max(version)::text FROM migration_ledger.applied), '0100'),
  ('1_IDENTIDAD', 'I-2 auth.uid() reads claim.sub then claims (definition md5 as on 2026-10-21)',
     (SELECT (pg_get_functiondef('auth.uid'::regproc) ~ 'request\.jwt\.claim\.sub' AND pg_get_functiondef('auth.uid'::regproc) ~ 'request\.jwt\.claims')::text
             || '|' || md5(pg_get_functiondef('auth.uid'::regproc))), 'true|ea3b41bf29e2ad573067939329aa088e'),
  ('2_RPC', 'R-1 the four accounting RPC signatures used by 0101 exist', (SELECT count(oid)::text FROM rpcs), '4'),
  ('2_RPC', 'R-2 all four SECURITY DEFINER, owner postgres', (SELECT count(*)::text FROM rpcs r JOIN pg_proc p ON p.oid = r.oid WHERE p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'), '4'),
  ('2_RPC', 'R-3 EXECUTE: authenticated yes; anon / service_role / PUBLIC no',
     (SELECT count(*)::text FROM rpcs r JOIN pg_proc p ON p.oid = r.oid WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)), '4'),
  ('2_RPC', 'R-4 helpers present: current_app_role(), assert_period_open, extensions.hmac, vault', (SELECT (to_regprocedure('public.current_app_role()') IS NOT NULL)::text
       || '|' || EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'assert_period_open') || '|' || EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'extensions' AND p.proname = 'hmac')
       || '|' || (to_regclass('vault.secrets') IS NOT NULL)), 'true|true|true|true'),
  ('2_RPC', 'R-5 every table / column 0101 reads directly exists', (SELECT count(*)::text || CASE WHEN count(*) > 0 THEN ' :: ' || string_agg(col, ', ') ELSE '' END FROM missing), '0'),
  ('3_SEGURIDAD', 'S-1 SECURITY DEFINER functions executable by PUBLIC (any schema, callable)', (SELECT count(*)::text FROM pub), '0'),
  ('3_SEGURIDAD', 'S-2 custom LOGIN roles', (SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname), 'none') FROM pg_roles
     WHERE rolcanlogin AND rolname !~ '^(postgres|authenticator|supabase_.*|pgbouncer|dashboard_user|pgsodium_.*|cli_login_.*|supabase_read_only_user|supabase_etl_admin|supabase_replication_admin|supabase_realtime_admin|supabase_storage_admin|supabase_auth_admin|supabase_functions_admin)$'), 'none'),
  ('3_SEGURIDAD', 'S-3 service_role: INSERT/UPDATE on financial tables', (SELECT (count(*) FILTER (WHERE has_table_privilege('service_role', t, 'INSERT') OR has_table_privilege('service_role', t, 'UPDATE')))::text || '/' || count(*)
     FROM unnest(array['purchases','financial_operation','financial_posting','supplier_ledger','client_ledger','fiscal_document','purchase_attachment','audit_events','perfiles','mp_reconciliation','pedidos']) t), '0/11'),
  ('4_CUENTAS', 'C-1 active cash accounts (CASH)', (SELECT count(*)::text FROM acc WHERE t = 'CASH'), '1'),
  ('4_CUENTAS', 'C-2 active BNA bank account', (SELECT count(*)::text FROM acc WHERE t = 'BANK_ACCOUNT' AND nombre ILIKE '%BNA%'), '1'),
  ('4_CUENTAS', 'C-3 active Patagonia bank account', (SELECT count(*)::text FROM acc WHERE t = 'BANK_ACCOUNT' AND nombre ILIKE '%patagonia%'), '1'),
  ('4_CUENTAS', 'C-4 Mercado Pago account with the exact name 0101 uses for needs_mp ("Mercado Pago", EXTERNAL_SERVICE)', (SELECT count(*)::text FROM acc WHERE t = 'EXTERNAL_SERVICE' AND nombre = 'Mercado Pago'), '1'),
  ('5_CATEGORIAS', 'K-1 selectable subcategories (active, not reserved, EXPENSE group active) > 0', (SELECT (count(*) > 0)::text FROM sel), 'true'),
  ('5_CATEGORIAS', 'K-2 selectable subcategory names are unique (GPT picks by name)', (SELECT count(*)::text FROM (SELECT lower(nombre) FROM sel GROUP BY 1 HAVING count(*) > 1) x), '0'),
  ('6_ADMIN', 'A-1 at least two active ADMIN profiles (the two pilot profiles are validated by b4-admin-candidates.sh)', (SELECT (count(*) >= 2)::text FROM adm), 'true'),
  ('7_METODOS', 'M-1 payment_method has CASH, TRANSFER, MERCADOPAGO; purchase_nature has OPERATING',
     (SELECT (array['CASH','TRANSFER','MERCADOPAGO'] <@ enum_range(NULL::payment_method)::text[])::text || '|' || ('OPERATING' = ANY (enum_range(NULL::purchase_nature)::text[]))), 'true|true'),
  ('8_SIN_WA', 'W-1 no schema wa, no public.wa_* function, no wa_* table, no Vault secret named wa_meta_app_secret',
     (SELECT (to_regnamespace('wa') IS NULL)::text || '|' || (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%')
       || '|' || (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname LIKE 'wa\_%')
       || '|' || (SELECT count(*) FROM vault.secrets WHERE name = 'wa_meta_app_secret')), 'true|0|0|0'),
  ('8_SIN_WA', 'W-2 no sim schema (staging-only objects) in production', (SELECT (to_regnamespace('sim') IS NULL)::text), 'true'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY grp, name COLLATE "C";
-- information for the decisions (business catalog names only)
SELECT 'info|accounts (active): ' || string_agg(nombre || ' [' || account_type::text || ']', '; ' ORDER BY account_type::text, nombre) FROM financial_account WHERE activo;
SELECT 'info|migration ledger rows: ' || count(*) FROM migration_ledger.applied;
SELECT 'info|payment_method values: ' || array_to_string(enum_range(NULL::payment_method)::text[], ',');
SELECT 'info|selectable subcategories: ' || count(*) FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
 WHERE c.activo AND NOT c.fiscal_reserved AND g.kind::text = 'EXPENSE' AND g.activo;
SELECT 'info|cat ' || g.nombre || ' > ' || string_agg(c.nombre, ', ' ORDER BY c.nombre) FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
 WHERE c.activo AND NOT c.fiscal_reserved AND g.kind::text = 'EXPENSE' AND g.activo GROUP BY g.nombre ORDER BY g.nombre;
SELECT 'info|admin profile ids (first 8 chars): ' || string_agg(left(id::text, 8), ',' ORDER BY id) FROM perfiles WHERE activo AND rol_type::text = 'ADMIN';
SELECT 'info|other active profiles by role: ' || coalesce(string_agg(rol_type::text || '=' || n, ',' ORDER BY rol_type::text), 'none')
  FROM (SELECT rol_type, count(*) n FROM perfiles WHERE activo AND rol_type::text <> 'ADMIN' GROUP BY rol_type) x;
SELECT 'info|PostgREST role settings: ' || coalesce(string_agg(coalesce(r.rolname, '(all)') || ': ' || array_to_string(s.setconfig, ' ; '), ' | '), 'none')
  FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'pgrst.%');
SELECT 'info|business date today (America/Argentina/Buenos_Aires): ' || (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date;
ROLLBACK;
