-- ============================================================================
-- TARGET V1 — 0025 PRODUCTION PRIVILEGE PERIMETER AND RLS (Phase 18)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md §4 (no write privilege for any
--            application role), §8 (ADMIN all; OPERATOR assigned flocks),
--            §10 coverage matrix:
--              population_events  S | S assigned | RPC 20–22 only
--              daily_production   S | S assigned | RPC 18/19 only
--
-- OPERATOR executes RPCs 18/19/20/22 but receives NO write privilege and NO
-- write policy: authorization lives inside the SECURITY DEFINER functions.
-- flocks and operator_assignments keep their 0007 policies unchanged.
-- Since 0013 new objects are born owner-only; the explicit reset keeps this
-- migration correct on its own.
-- ============================================================================

REVOKE ALL ON population_events, daily_production FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE population_events_id_seq FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON population_events, daily_production TO authenticated;

CREATE POLICY daily_production_admin_select ON daily_production FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY daily_production_operator_select ON daily_production FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND flock_id IN (SELECT flock_id FROM operator_assignments
                     WHERE operator_id = auth.uid() AND activo = true)
  );

CREATE POLICY population_events_admin_select ON population_events FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY population_events_operator_select ON population_events FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND flock_id IN (SELECT flock_id FROM operator_assignments
                     WHERE operator_id = auth.uid() AND activo = true)
  );
