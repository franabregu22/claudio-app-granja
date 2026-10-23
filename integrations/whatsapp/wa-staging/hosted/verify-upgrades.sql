-- ADR-025 §18 — READ-ONLY verification of upgrade-001 (public.wa_context) and upgrade-002 (sim categories) on AppGranja.
-- psql variable: since = start of the upgrade run (timestamptz). Nothing is written: the transaction is READ ONLY and rolled back.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH fn AS (SELECT p.* FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'wa_context'),
cats AS (SELECT c.id, c.nombre, c.group_id FROM sim.expense_category c JOIN sim.expense_category_group g ON g.id = c.group_id
          WHERE c.activo AND NOT c.fiscal_reserved AND g.kind::text = 'EXPENSE' AND g.activo),
newc AS (SELECT c.* FROM sim.expense_category c WHERE c.id IN ('aaaaaaaa-0025-0000-0000-0000000000c4', 'aaaaaaaa-0025-0000-0000-0000000000c5', 'aaaaaaaa-0025-0000-0000-0000000000c6')),
checks(grp, name, got, expected) AS (VALUES
  ('RPC', 'R-1 wa_context: one SECURITY DEFINER fn, EXECUTE authenticated only (no anon, no PUBLIC)',
     (SELECT count(*) FROM fn WHERE fn.prosecdef AND has_function_privilege('authenticated', fn.oid, 'EXECUTE') AND NOT has_function_privilege('anon', fn.oid, 'EXECUTE')
        AND NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) a WHERE a.grantee = 0))::text, '1'),
  ('RPC', 'R-2 wa_context signature (bigint) returns jsonb', (SELECT string_agg(pg_get_function_identity_arguments(fn.oid) || '->' || fn.prorettype::regtype::text, ',') FROM fn), 'p_inbound_id bigint->jsonb'),
  ('RPC', 'R-3 public wa_* functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%')::text, '8'),
  ('RPC', 'R-4 wa_context is not callable by service_role', (SELECT (NOT has_function_privilege('service_role', fn.oid, 'EXECUTE'))::text FROM fn), 'true'),
  ('CATEGORIAS', 'C-1 selectable sim categories', (SELECT string_agg(cats.nombre, ',' ORDER BY cats.nombre) FROM cats), 'Combustible,Insumos,Limpieza,Mantenimiento'),
  ('CATEGORIAS', 'C-2 the 3 new categories exist with the reviewed ids, same group as Insumos, INDIRECT / OPERATING',
     (SELECT count(*) FROM newc WHERE newc.activo AND NOT newc.fiscal_reserved AND newc.pnl_cost_class = 'INDIRECT' AND newc.default_nature::text = 'OPERATING'
        AND newc.group_id = (SELECT c.group_id FROM sim.expense_category c WHERE c.nombre = 'Insumos'))::text, '3'),
  ('CATEGORIAS', 'C-3 no duplicated category names', (SELECT count(*) FROM (SELECT c.nombre FROM sim.expense_category c GROUP BY c.nombre HAVING count(*) > 1) x)::text, '0'),
  ('CATEGORIAS', 'C-4 no purchase uses the new categories yet', (SELECT count(*) FROM sim.purchases x WHERE x.expense_category_id IN (SELECT id FROM newc))::text, '0'),
  ('SIN_CAMBIOS', 'N-1 sim purchases created since the upgrade run', (SELECT count(*) FROM sim.purchases x WHERE x.created_at >= :'since'::timestamptz)::text, '0'),
  ('SIN_CAMBIOS', 'N-2 sim fiscal documents created since the upgrade run', (SELECT count(*) FROM sim.fiscal_document x WHERE x.created_at >= :'since'::timestamptz)::text, '0'),
  ('SIN_CAMBIOS', 'N-3 sim audit events since the upgrade run', (SELECT count(*) FROM sim.audit_events x WHERE x.created_at >= :'since'::timestamptz)::text, '0'),
  ('SIN_CAMBIOS', 'N-4 confirmations since the upgrade run', (SELECT count(*) FROM wa.confirmation x WHERE x.confirmed_at >= :'since'::timestamptz)::text, '0'),
  ('SIN_CAMBIOS', 'N-5 W-0007 purchase intact (one row, 15000.00, current)', (SELECT count(*)::text || '|' || coalesce(min(x.amount_total)::text, '-') || '|' || coalesce(bool_and(x.is_current)::text, '-')
      FROM sim.purchases x JOIN wa.confirmation c ON c.idempotency_key = x.idempotency_key JOIN wa.draft d ON d.id = c.draft_id WHERE d.short_code = 'W-0007'), '1|15000.00|true'))
SELECT 'check|' || grp || '|' || CASE WHEN got IS NULL THEN 'UNKNOWN' WHEN got = expected THEN 'PASS' ELSE 'FAIL' END || '|' || name
       || CASE WHEN got IS DISTINCT FROM expected THEN ' :: got ' || coalesce(got, 'NULL') || ' expected ' || expected ELSE '' END
  FROM checks ORDER BY grp, name COLLATE "C";
SELECT 'info|sim totals: purchases=' || (SELECT count(*) FROM sim.purchases) || ' sum_total=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
       || ' fiscal_documents=' || (SELECT count(*) FROM sim.fiscal_document) || ' mp_pending_outflow=' || (SELECT count(*) FROM sim.mp_pending_outflow)
       || ' audit_events=' || (SELECT count(*) FROM sim.audit_events) || ' last_purchase=' || coalesce((SELECT to_char(max(created_at) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI') FROM sim.purchases), '-');
SELECT 'info|public wa_* functions: ' || string_agg(proname, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\_%';
ROLLBACK;
