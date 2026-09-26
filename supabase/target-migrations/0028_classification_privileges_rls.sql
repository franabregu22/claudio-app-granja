-- ============================================================================
-- TARGET V1 — 0028 CLASSIFICATION PRIVILEGE PERIMETER AND RLS (Phase 19)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md §4 (no write privilege for any
--            application role), §8 (ADMIN all; OPERATOR own sessions only; no
--            INSERT policy — RPC 25 is the only writer), §10 coverage matrix.
--
-- Both tables use UUID keys: no sequences. Since 0013 new tables are born
-- owner-only; the explicit reset keeps this migration correct on its own.
-- ============================================================================

REVOKE ALL ON classification, classification_line FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON classification, classification_line TO authenticated;

CREATE POLICY classification_admin_select ON classification FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY classification_operator_select ON classification FOR SELECT
  USING (current_app_role() = 'OPERATOR' AND created_by = auth.uid());

CREATE POLICY classification_line_admin_select ON classification_line FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY classification_line_operator_select ON classification_line FOR SELECT
  USING (
    current_app_role() = 'OPERATOR'
    AND classification_id IN (SELECT id FROM classification WHERE created_by = auth.uid())
  );
