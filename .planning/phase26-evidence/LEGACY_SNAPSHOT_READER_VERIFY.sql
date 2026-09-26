-- ============================================================================
-- PHASE 26 — FAIL-CLOSED PROOF FOR legacy_snapshot_reader (NOT EXECUTED YET)
--
-- Run CONNECTED AS legacy_snapshot_reader, before any snapshot.
-- Part 1 is catalog inspection only (SELECT). Part 2 are write probes that touch
-- zero rows by construction (WHERE false / rolled back) and must each ERROR.
-- The snapshot proceeds only if every expectation holds; otherwise STOP.
-- ============================================================================
\set ON_ERROR_STOP 0

-- ---------------------------------------------------------------------------
-- PART 1 — inspection
-- ---------------------------------------------------------------------------
-- 1.1 identity (source identity recorded in the manifest)
SELECT current_user, session_user, current_database(),
       current_setting('server_version') AS server_version,
       current_setting('default_transaction_read_only') AS default_read_only,
       inet_server_addr() AS server_addr, now() AS observed_at;

-- 1.2 role attributes — expect all false, connlimit 2, validuntil set
SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolinherit,
       rolconnlimit, rolvaliduntil
  FROM pg_roles WHERE rolname = current_user;

-- 1.3 memberships — expect 0 rows
SELECT r.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
 WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user);

-- 1.4 the 26 source tables: exist, SELECT = true, every write privilege = false, RLS state
WITH t(name) AS (VALUES
  ('perfiles'),('clientes'),('productos'),('precios_historial'),('pedidos'),('pedido_lineas'),
  ('pagos'),('pago_en_caja'),('movimientos_caja'),('cuentas_caja'),('arqueos_caja'),
  ('categorias_finanzas'),('cheques'),('comisiones'),('lotes'),('producciones'),
  ('recuentos_lote'),('mercadopago_raw'),('mercadopago_movements'),
  ('mp_source_record'),('mp_financial_movement'),('mp_movement_source_link'),
  ('mp_source_link_resolution'),('monthly_reconciliation'),('reconciliation_snapshot'),
  ('import_period_coverage'))
SELECT t.name, c.relkind, c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced,
       has_table_privilege(c.oid, 'SELECT')     AS sel,
       has_table_privilege(c.oid, 'INSERT')     AS ins,
       has_table_privilege(c.oid, 'UPDATE')     AS upd,
       has_table_privilege(c.oid, 'DELETE')     AS del,
       has_table_privilege(c.oid, 'TRUNCATE')   AS trunc,
       has_table_privilege(c.oid, 'REFERENCES') AS refs,
       has_table_privilege(c.oid, 'TRIGGER')    AS trig
  FROM t LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || t.name)
 ORDER BY t.name;

-- 1.5 any write privilege anywhere outside system schemas — expect 0
SELECT n.nspname, c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p','v','m','f')
   AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
   AND (has_table_privilege(c.oid,'INSERT') OR has_table_privilege(c.oid,'UPDATE')
     OR has_table_privilege(c.oid,'DELETE') OR has_table_privilege(c.oid,'TRUNCATE'));

-- 1.6 CREATE on any schema — expect 0 rows; database CREATE false; TEMP reported
SELECT nspname FROM pg_namespace WHERE has_schema_privilege(oid, 'CREATE');
SELECT has_database_privilege(current_database(), 'CREATE') AS db_create,
       has_database_privilege(current_database(), 'TEMP')   AS db_temp;   -- inherited from PUBLIC; see evidence file

-- 1.7 SECURITY DEFINER functions this role can EXECUTE (PUBLIC grants included).
--     Any business write function here (e.g. marcar_pedido_entregado) → STOP.
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef
   AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND has_function_privilege(p.oid, 'EXECUTE')
 ORDER BY 1, 2;
SELECT p.proname, p.prosecdef, has_function_privilege(p.oid, 'EXECUTE') AS can_execute
  FROM pg_proc p WHERE p.proname = 'marcar_pedido_entregado';

-- 1.8 policies that apply to this role on the source tables (PUBLIC or the role itself)
SELECT tablename, policyname, permissive, cmd, roles, qual
  FROM pg_policies
 WHERE schemaname = 'public'
   AND (roles && ARRAY['public', current_user]::name[])
 ORDER BY tablename, policyname;

-- ---------------------------------------------------------------------------
-- PART 2 — write probes: each MUST fail with "permission denied" / "must be owner".
-- READ WRITE is set explicitly so the failure proves the privilege boundary,
-- not only default_transaction_read_only. Zero rows can be affected.
-- ---------------------------------------------------------------------------
BEGIN READ WRITE; INSERT INTO public.clientes SELECT * FROM public.clientes WHERE false; ROLLBACK;
BEGIN READ WRITE; UPDATE public.clientes SET id = id WHERE false;                    ROLLBACK;
BEGIN READ WRITE; DELETE FROM public.clientes WHERE false;                           ROLLBACK;
BEGIN READ WRITE; CREATE TABLE public.__phase26_probe (x int);                        ROLLBACK;
BEGIN READ WRITE; ALTER TABLE public.clientes ADD COLUMN __phase26_probe int;        ROLLBACK;
-- TRUNCATE and the business RPC are proven by 1.4 (trunc = false) and 1.7
-- (no executable definer write function); they are deliberately not invoked.

-- ---------------------------------------------------------------------------
-- PART 3 — completeness under RLS (decides whether R1 is needed)
-- ---------------------------------------------------------------------------
SET row_security = off;   -- pg_dump's default: must ERROR on RLS tables unless BYPASSRLS
SELECT count(*) FROM public.clientes;
RESET row_security;
