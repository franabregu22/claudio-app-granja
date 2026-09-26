-- ============================================================================
-- TARGET V1 — 0041 MERCADO PAGO PRIVILEGE PERIMETER AND RLS (Phase 23)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md §9 (MP), §4, §10:
--              mp_source_record       ADMIN S | — | service S,I | backend INSERT only
--              mp_financial_movement  ADMIN S | — | service S   | RPC 40 only
--              mp_reconciliation      ADMIN S | — | service S   | RPC 41 only
--
-- No UPDATE / DELETE privilege for any application or service role: raw
-- columns are immutable (trigger) and processing metadata changes only through
-- the SECURITY DEFINER RPCs 40/41. OPERATOR has no policy. SERVICE_ROLE gets
-- nothing beyond these tables (and financial_account SELECT from 0009).
-- ============================================================================

REVOKE ALL ON mp_source_record, mp_financial_movement, mp_reconciliation
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE mp_financial_movement_id_seq FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON mp_source_record, mp_financial_movement, mp_reconciliation TO authenticated, service_role;
GRANT INSERT ON mp_source_record TO service_role;

-- backend ingestion: INSERT only. No UPDATE policy: metadata changes go through RPCs 40/41.
CREATE POLICY mp_source_service_insert ON mp_source_record FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY mp_source_service_select ON mp_source_record FOR SELECT
  USING (auth.role() = 'service_role');

-- ADMIN may audit raw MP data read-only
CREATE POLICY mp_source_admin_select ON mp_source_record FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY mp_movement_service_select ON mp_financial_movement FOR SELECT
  USING (auth.role() = 'service_role');
CREATE POLICY mp_movement_admin_select ON mp_financial_movement FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY mp_reconciliation_service_select ON mp_reconciliation FOR SELECT
  USING (auth.role() = 'service_role');
CREATE POLICY mp_reconciliation_admin_select ON mp_reconciliation FOR SELECT
  USING (current_app_role() = 'ADMIN');
