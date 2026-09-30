-- ============================================================================
-- TARGET V1 — 0060 FERIA ADMIN-ONLY READS (ADR-009, owner follow-up to D-F27F-1)
-- Authority: .planning/adr/ADR-009_FERIA_ADMIN_ONLY_V1.md (ACCEPTED: "Feria is completely ADMIN-only in V1,
--            including reads")
--            RLS_IMPLEMENTATION_SPEC_V1.md §5 audit, §8 Feria, §10 coverage matrix [ADR-009]
--
-- Audit of every Feria read surface exposed to API roles (before 0060):
--   sales_session              ADMIN all   · OPERATOR OPEN sessions (sales_session_operator_select)   → dropped
--   sales_session_movement     ADMIN all   · OPERATOR movements of OPEN sessions                       → dropped
--   sales_session_cash_event   ADMIN all   · OPERATOR none                                             → unchanged
--   report_feria_session_cash  security_invoker view over the three tables → follows their RLS: ADMIN only after 0060
--   report_sales_line / pnl_line_item  also reference sales_session; already ADMIN-only through pedidos / pnl RLS
--   audit_events_operator_own  let OPERATOR read its own 'sales_session_movement' audit rows          → entity removed
--
-- ADMIN keeps every Feria read and write. The SELECT grants to authenticated stay (RLS now returns no Feria row to
-- OPERATOR). No other policy, grant, table, function, product or price_history change. The audit policy is re-created
-- with the same name, role and expression minus the Feria entity type; its other entity types are unchanged.
-- ============================================================================

DROP POLICY sales_session_operator_select ON sales_session;
DROP POLICY sales_session_movement_operator_select ON sales_session_movement;

DROP POLICY audit_events_operator_own ON audit_events;
CREATE POLICY audit_events_operator_own ON audit_events FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND performed_by = auth.uid()
    AND entity_type IN ('daily_production','population_events','classification',
                        'flock_weighing','temperature_record','feed_manufacturing',
                        'feed_inventory_count')
  );
