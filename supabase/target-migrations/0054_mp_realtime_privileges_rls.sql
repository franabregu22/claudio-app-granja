-- ============================================================================
-- TARGET V1 — 0054 MERCADO PAGO REAL-TIME PRIVILEGES / RLS (ADR-006, Step 9)
-- Authority: ADR006_RLS_AND_SECURITY_V1 §1–§5 (the planned file name "0051" in that design is
--            this migration; the ledger's next free number is 0054);
--            RLS_IMPLEMENTATION_SPEC_V1 §2 / §11; ADR006_TEST_MATRIX_V1 S-1…S-7, B4 / D7 (§P23-T).
--
-- Tables: the 0041 pattern — REVOKE ALL from PUBLIC, anon, authenticated, service_role, then
-- narrow SELECT grants; RLS enabled; SELECT policies only. No INSERT / UPDATE / DELETE grant for
-- any application role on any ADR-006 table: every write is a SECURITY DEFINER RPC.
--   mp_webhook_delivery, mp_transition_identity, mp_report_match:
--       authenticated SELECT (ADMIN policy) + service_role SELECT (service policy)
--   mp_client_allocation, mp_payer_client_map, mp_attribution_flag:
--       authenticated SELECT (ADMIN policy); service_role none (§5: C2 / A1 are definers)
--   mp_source_record: grants unchanged (0041); mp_source_service_insert narrowed (R4) to the
--       report source types — api_payment / api_refund rows come only from definer RPCs (S4).
--       service_role has BYPASSRLS, so R4 is enforced by the INVOKER guard trg_mp_source_insert_guard.
--   mp_financial_movement, mp_reconciliation: unchanged (0041), restated read-only.
-- Functions: the §3 EXECUTE table restated exactly (REVOKE ALL from PUBLIC, anon first).
-- No function body, no business rule and no SECURITY DEFINER inventory change (still 60).
-- ============================================================================

-- ── ADR-006 tables (0047): reset, then narrow ─────────────────────────────────
REVOKE ALL ON TABLE mp_webhook_delivery, mp_transition_identity, mp_report_match,
                    mp_client_allocation, mp_payer_client_map, mp_attribution_flag
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE mp_webhook_delivery    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_transition_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_report_match        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_client_allocation   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_payer_client_map    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_attribution_flag    ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE mp_webhook_delivery, mp_transition_identity, mp_report_match TO authenticated, service_role;
GRANT SELECT ON TABLE mp_client_allocation, mp_payer_client_map, mp_attribution_flag TO authenticated;

CREATE POLICY mp_delivery_admin_select ON mp_webhook_delivery
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_delivery_service_select ON mp_webhook_delivery
  FOR SELECT USING (auth.role() = 'service_role');

CREATE POLICY mp_identity_admin_select ON mp_transition_identity
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_identity_service_select ON mp_transition_identity
  FOR SELECT USING (auth.role() = 'service_role');

CREATE POLICY mp_match_admin_select ON mp_report_match
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_match_service_select ON mp_report_match
  FOR SELECT USING (auth.role() = 'service_role');

CREATE POLICY mp_allocation_admin_select ON mp_client_allocation
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_payer_map_admin_select ON mp_payer_client_map
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_attribution_flag_admin_select ON mp_attribution_flag
  FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── pre-existing MP tables (0041) ─────────────────────────────────────────────
-- mp_source_record: report-row INSERT narrowed (R4); SELECT perimeter unchanged
DROP POLICY mp_source_service_insert ON mp_source_record;
CREATE POLICY mp_source_service_insert ON mp_source_record
  FOR INSERT WITH CHECK (auth.role() = 'service_role' AND source_type IN ('csv_import', 'account_money_csv'));

-- R4 enforcement. On Supabase service_role holds BYPASSRLS (see 0009), so the policy above never
-- binds it: it is kept as the declared rule and as defence in depth. The rule itself is enforced by
-- this SECURITY INVOKER guard, the same mechanism as trg_mp_source_raw_guard: a direct INSERT made
-- by an application role may create only report sources. SECURITY DEFINER RPCs (S4
-- mp_ingest_api_snapshot) run as the owner, so current_user is postgres and they are unaffected.
CREATE OR REPLACE FUNCTION mp_source_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('service_role', 'authenticated', 'anon')
     AND NEW.source_type NOT IN ('csv_import', 'account_money_csv') THEN
    RAISE EXCEPTION 'SOURCE_TYPE_NOT_INSERTABLE: % rows are created only by SECURITY DEFINER RPCs', NEW.source_type;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION mp_source_insert_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_source_insert_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_mp_source_insert_guard
  BEFORE INSERT ON mp_source_record
  FOR EACH ROW EXECUTE FUNCTION mp_source_insert_guard();

-- mp_financial_movement / mp_reconciliation: read-only for ADMIN / service (restated, no change)
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE mp_source_record, mp_financial_movement, mp_reconciliation
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE mp_source_record, mp_financial_movement, mp_reconciliation FROM PUBLIC, anon;
GRANT SELECT ON TABLE mp_source_record, mp_financial_movement, mp_reconciliation TO authenticated, service_role;
GRANT INSERT ON TABLE mp_source_record TO service_role;

-- ── sequences ────────────────────────────────────────────────────────────────
REVOKE ALL ON SEQUENCE mp_transition_identity_id_seq FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE mp_financial_movement_id_seq  FROM PUBLIC, anon, authenticated, service_role;

-- ── function EXECUTE perimeter (§3), restated exactly ─────────────────────────
REVOKE ALL ON FUNCTION
  mp_register_delivery(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB, BOOLEAN, UUID),
  mp_claim_deliveries(INTEGER, INTEGER),
  mp_delivery_transition(UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, INTEGER, VARCHAR),
  mp_requeue_config_blocked(TEXT),
  mp_ingest_api_snapshot(UUID, UUID, VARCHAR, JSONB),
  mp_normalize_source(UUID),
  mp_apply_transition(BIGINT),
  mp_auto_allocate(BIGINT),
  mp_check_report_coverage(VARCHAR, DATE, DATE),
  mp_record_balance_check(UUID),
  mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT),
  mp_allocate_to_client(BIGINT, UUID, NUMERIC, DATE, VARCHAR, TEXT),
  mp_reverse_client_allocation(UUID, NUMERIC, VARCHAR, TEXT),
  mp_flag_for_attribution(BIGINT, TEXT),
  mp_clear_attribution_flag(UUID, TEXT),
  mp_map_payer_to_client(VARCHAR, UUID, TEXT),
  mp_unmap_payer(UUID, TEXT),
  mp_resolve_match(UUID, VARCHAR, TEXT),
  mp_normalize_report_fallback(UUID, TEXT),
  mp_request_refetch(VARCHAR, TEXT),
  mp_resolve_chargeback_signal(UUID, VARCHAR, VARCHAR, TEXT),
  mp_is_auto_applicable(BIGINT),
  mp_v4_verified(),
  mp_parse_report_row(mp_source_record),
  mp_claim_report_payment_fallback(UUID, UUID, TEXT),
  mp_delivery_immutable_guard(),
  mp_report_match_guard(),
  mp_source_raw_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- service role (backend)
GRANT EXECUTE ON FUNCTION
  mp_register_delivery(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB, BOOLEAN, UUID),
  mp_claim_deliveries(INTEGER, INTEGER),
  mp_delivery_transition(UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, INTEGER, VARCHAR),
  mp_ingest_api_snapshot(UUID, UUID, VARCHAR, JSONB),
  mp_normalize_source(UUID),
  mp_apply_transition(BIGINT),
  mp_auto_allocate(BIGINT),
  mp_check_report_coverage(VARCHAR, DATE, DATE),
  mp_record_balance_check(UUID)
  TO service_role;

-- ADMIN or service (in-body actor check)
GRANT EXECUTE ON FUNCTION
  mp_requeue_config_blocked(TEXT),
  mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT)
  TO authenticated, service_role;

-- ADMIN (in-body ADMIN check)
GRANT EXECUTE ON FUNCTION
  mp_allocate_to_client(BIGINT, UUID, NUMERIC, DATE, VARCHAR, TEXT),
  mp_reverse_client_allocation(UUID, NUMERIC, VARCHAR, TEXT),
  mp_flag_for_attribution(BIGINT, TEXT),
  mp_clear_attribution_flag(UUID, TEXT),
  mp_map_payer_to_client(VARCHAR, UUID, TEXT),
  mp_unmap_payer(UUID, TEXT),
  mp_resolve_match(UUID, VARCHAR, TEXT),
  mp_normalize_report_fallback(UUID, TEXT),
  mp_request_refetch(VARCHAR, TEXT),
  mp_resolve_chargeback_signal(UUID, VARCHAR, VARCHAR, TEXT)
  TO authenticated;

-- helpers and trigger functions (SECURITY INVOKER): owner only — nothing granted
