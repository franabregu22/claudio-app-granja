-- ============================================================================
-- PHASE 26 — BLOCK B (option R1, APPROVED by owner): temporary SELECT policies
--
-- Run by the owner in psql as `postgres`, ONLY after Block A is verified clean
-- (VERIFY part 1, including 1.7). One transaction; any failure aborts all of it.
--
-- Creates only policies named legacy_snapshot_reader_select, FOR SELECT,
-- TO legacy_snapshot_reader, USING (true), and only on source tables whose RLS
-- is enabled. They exist solely so the reader can take a complete snapshot and
-- are removed by Block C. No BYPASSRLS, no write, no CREATE, no membership.
-- ============================================================================
\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  src text[] := ARRAY[
    'perfiles','clientes','productos','precios_historial','pedidos','pedido_lineas',
    'pagos','pago_en_caja','movimientos_caja','cuentas_caja','arqueos_caja',
    'categorias_finanzas','cheques','comisiones','lotes','producciones',
    'recuentos_lote','mercadopago_raw','mercadopago_movements',
    'mp_source_record','mp_financial_movement','mp_movement_source_link',
    'mp_source_link_resolution','monthly_reconciliation','reconciliation_snapshot',
    'import_period_coverage'];
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'legacy_snapshot_reader') THEN
    RAISE EXCEPTION 'Block A not applied: legacy_snapshot_reader does not exist';
  END IF;
  -- Name collision guard: the name must be unused ANYWHERE, so Block C can never
  -- drop a policy it did not create.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'legacy_snapshot_reader_select') THEN
    RAISE EXCEPTION 'a policy named legacy_snapshot_reader_select already exists — stop';
  END IF;

  FOREACH t IN ARRAY src LOOP
    -- ::regclass raises if the table is absent (aborts the block)
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = format('public.%I', t)::regclass) THEN
      EXECUTE format(
        'CREATE POLICY legacy_snapshot_reader_select ON public.%I '
        'AS PERMISSIVE FOR SELECT TO legacy_snapshot_reader USING (true)', t);
    END IF;
  END LOOP;
END $$;

COMMIT;

-- Record exactly which tables received the policy, and the RLS state of all 26.
SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS rls_forced,
       EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                 AND p.polname = 'legacy_snapshot_reader_select') AS reader_policy
  FROM pg_class c
 WHERE c.relnamespace = 'public'::regnamespace
   AND c.relname = ANY (ARRAY[
    'perfiles','clientes','productos','precios_historial','pedidos','pedido_lineas',
    'pagos','pago_en_caja','movimientos_caja','cuentas_caja','arqueos_caja',
    'categorias_finanzas','cheques','comisiones','lotes','producciones',
    'recuentos_lote','mercadopago_raw','mercadopago_movements',
    'mp_source_record','mp_financial_movement','mp_movement_source_link',
    'mp_source_link_resolution','monthly_reconciliation','reconciliation_snapshot',
    'import_period_coverage'])
 ORDER BY c.relname;

-- RESTRICTIVE policies are AND-ed with every permissive one; any that applies to
-- PUBLIC or the reader would make the snapshot partial. Expect 0 rows.
SELECT schemaname, tablename, policyname, roles, qual
  FROM pg_policies
 WHERE schemaname = 'public' AND permissive = 'RESTRICTIVE'
   AND cmd IN ('SELECT', 'ALL')
   AND roles && ARRAY['public', 'legacy_snapshot_reader']::name[];
