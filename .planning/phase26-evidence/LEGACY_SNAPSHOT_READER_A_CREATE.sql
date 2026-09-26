-- ============================================================================
-- PHASE 26 — BLOCK A: dedicated legacy snapshot reader (APPROVED by owner)
--
-- Run by the owner in psql, connected to PRODUCTION as the administrative
-- database owner (`postgres`). One transaction: if any table is absent or any
-- statement fails, ON_ERROR_STOP aborts and nothing is committed.
--
-- Creates only: one role, its role settings, CONNECT/USAGE/SELECT grants.
-- Writes no business row. Creates no table, function, view or policy.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_snapshot_reader') THEN
    RAISE EXCEPTION 'legacy_snapshot_reader already exists — inspect it, do not reuse blindly';
  END IF;
END $$;

CREATE ROLE legacy_snapshot_reader
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2
  VALID UNTIL '2026-10-31 23:59:59+00';

-- Defence in depth only (a session can override these; the grants are the boundary).
ALTER ROLE legacy_snapshot_reader SET default_transaction_read_only = on;
ALTER ROLE legacy_snapshot_reader SET statement_timeout = '30min';
ALTER ROLE legacy_snapshot_reader SET idle_in_transaction_session_timeout = '5min';

GRANT CONNECT ON DATABASE postgres TO legacy_snapshot_reader;
GRANT USAGE   ON SCHEMA public    TO legacy_snapshot_reader;

-- Exactly the 28 legacy source tables. A missing table raises and aborts the block.
GRANT SELECT ON TABLE
  public.perfiles, public.clientes, public.productos, public.precios_historial,
  public.pedidos, public.pedido_lineas, public.pagos, public.pago_en_caja,
  public.movimientos_caja, public.cuentas_caja, public.arqueos_caja, public.categorias_finanzas,
  public.cheques, public.comisiones, public.facturas,
  public.lotes, public.producciones, public.recuentos_lote,
  public.mercadopago_raw, public.mercadopago_movements, public.mercadopago_settlement,
  public.mp_source_record, public.mp_financial_movement,
  public.mp_movement_source_link, public.mp_source_link_resolution,
  public.monthly_reconciliation, public.reconciliation_snapshot, public.import_period_coverage
TO legacy_snapshot_reader;

-- Sequences owned by those tables (serial / identity), SELECT only, for pg_dump.
DO $$
DECLARE s regclass;
BEGIN
  FOR s IN
    SELECT DISTINCT seq.oid::regclass
      FROM pg_class seq
      JOIN pg_depend d ON d.objid = seq.oid AND d.deptype IN ('a', 'i')
      JOIN pg_class t  ON t.oid = d.refobjid
     WHERE seq.relkind = 'S'
       AND t.relnamespace = 'public'::regnamespace
       AND t.relname = ANY (ARRAY[
         'perfiles','clientes','productos','precios_historial','pedidos','pedido_lineas',
         'pagos','pago_en_caja','movimientos_caja','cuentas_caja','arqueos_caja',
         'categorias_finanzas','cheques','comisiones','facturas','lotes','producciones',
         'recuentos_lote','mercadopago_raw','mercadopago_movements','mercadopago_settlement',
         'mp_source_record','mp_financial_movement','mp_movement_source_link',
         'mp_source_link_resolution','monthly_reconciliation','reconciliation_snapshot',
         'import_period_coverage'])
  LOOP
    EXECUTE format('GRANT SELECT ON SEQUENCE %s TO legacy_snapshot_reader', s);
  END LOOP;
END $$;

COMMIT;

-- Password — set interactively in this same psql session:
--   \password legacy_snapshot_reader
-- Rules: the password never appears in any SQL file or in this repository; it is
-- kept only in the git-ignored .env.test as LEGACY_READONLY_DATABASE_URL; it is
-- never printed, pasted into the Dashboard SQL editor, or committed.

-- Record of what this block created (run after COMMIT):
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
       rolinherit, rolconnlimit, rolvaliduntil
  FROM pg_roles WHERE rolname = 'legacy_snapshot_reader';
SELECT table_name, privilege_type
  FROM information_schema.role_table_grants
 WHERE grantee = 'legacy_snapshot_reader' ORDER BY table_name, privilege_type;
