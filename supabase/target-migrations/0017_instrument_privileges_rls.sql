-- ============================================================================
-- TARGET V1 — 0017 INSTRUMENT PRIVILEGE PERIMETER AND RLS (Phase 16)
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md section 4 (no write privilege for
--            any application role on these tables), section 7 (ADMIN SELECT
--            only; OPERATOR no policy), section 10 coverage matrix
--            (financial_instrument / _event: RPC 5–12 only; supplier_ledger: RPC only)
--
-- Since 0013 the default privileges of postgres in public grant nothing to
-- application roles, so these tables were born owner-only. The explicit reset
-- below keeps this migration correct on its own, independent of that default.
-- ============================================================================

REVOKE ALL ON supplier_ledger, financial_instrument, financial_instrument_event
       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE supplier_ledger_id_seq, financial_instrument_event_id_seq
       FROM PUBLIC, anon, authenticated, service_role;

-- rows still filtered by RLS; no INSERT / UPDATE / DELETE / TRUNCATE for anyone
GRANT SELECT ON supplier_ledger, financial_instrument, financial_instrument_event TO authenticated;

CREATE POLICY supplier_ledger_admin_select ON supplier_ledger FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY financial_instrument_admin_select ON financial_instrument FOR SELECT
  USING (current_app_role() = 'ADMIN');

CREATE POLICY financial_instrument_event_admin_select ON financial_instrument_event FOR SELECT
  USING (current_app_role() = 'ADMIN');
