-- ============================================================================
-- TARGET V1 — 0037 FISCAL PRIVILEGE PERIMETER AND RLS (Phase 22)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md §4 (no write privilege for any
--            application role), §9 (fiscal_document, fiscal_document_component,
--            fiscal_obligation, fiscal_obligation_installment, fiscal_payment:
--            ADMIN SELECT only; RPC-written 34–36), §10 coverage matrix.
--
-- OPERATOR has no policy (no visibility). service_role gets nothing on the
-- fiscal business tables. Since 0013 new objects are born owner-only; the
-- explicit reset keeps this migration correct on its own. UUID keys only: no
-- sequences.
-- ============================================================================

REVOKE ALL ON fiscal_document, fiscal_document_component, fiscal_obligation,
              fiscal_obligation_installment, fiscal_payment
  FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS
GRANT SELECT ON fiscal_document, fiscal_document_component, fiscal_obligation,
                fiscal_obligation_installment, fiscal_payment
  TO authenticated;

CREATE POLICY fiscal_document_admin_select ON fiscal_document FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY fiscal_document_component_admin_select ON fiscal_document_component FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY fiscal_obligation_admin_select ON fiscal_obligation FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY fiscal_obligation_installment_admin_select ON fiscal_obligation_installment FOR SELECT
  USING (current_app_role() = 'ADMIN');
CREATE POLICY fiscal_payment_admin_select ON fiscal_payment FOR SELECT
  USING (current_app_role() = 'ADMIN');
