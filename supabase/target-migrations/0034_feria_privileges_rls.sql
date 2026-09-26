-- ============================================================================
-- TARGET V1 — 0034 FERIA PRIVILEGE PERIMETER AND RLS (Phase 21)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md §4 (no write privilege for any
--            application role), §8 "Feria", §10 coverage matrix:
--              sales_session             S | S OPEN          | RPC 30/33 only
--              sales_session_movement    S | S of OPEN sess. | RPC 31 only
--              sales_session_cash_event  S | —               | RPC 30/32 only
--
-- OPERATOR executes RPC 31 but receives NO write privilege and NO write policy.
-- Cash is financial: ADMIN only. Since 0013 new objects are born owner-only;
-- the explicit reset keeps this migration correct on its own.
-- ============================================================================

REVOKE ALL ON sales_session, sales_session_movement, sales_session_cash_event
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE sales_session_movement_id_seq, sales_session_cash_event_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON sales_session, sales_session_movement, sales_session_cash_event TO authenticated;

CREATE POLICY sales_session_admin_select ON sales_session FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY sales_session_operator_select ON sales_session FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND estado = 'OPEN');

CREATE POLICY sales_session_movement_admin_select ON sales_session_movement FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY sales_session_movement_operator_select ON sales_session_movement FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND sales_session_id IN (SELECT id FROM sales_session WHERE estado = 'OPEN')
  );

-- cash is financial: ADMIN only.
CREATE POLICY sales_session_cash_event_admin_select ON sales_session_cash_event FOR SELECT
  USING (current_app_role() = 'ADMIN');
