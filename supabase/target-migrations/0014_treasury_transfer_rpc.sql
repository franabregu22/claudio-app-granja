-- ============================================================================
-- TARGET V1 — 0014 TREASURY: transfer_between_accounts (Phase 15)
-- Authority: RPC_CONTRACTS_V1.md 39 transfer_between_accounts
--            DATABASE_INVARIANTS_V1.md 6 (balance = SUM postings), 8 (posting ∈ operation)
--            TARGET_ARCHITECTURE_V2_FROZEN.md Part 19 (transfers do not affect results)
--
-- No new table: Treasury reuses financial_account (0004), financial_operation
-- and financial_posting (0010), whose RLS and grants already are the frozen
-- ones (0012 / 0013: ADMIN SELECT, no application-role write).
--
-- One transfer = ONE financial_operation (TRANSFER) + exactly TWO postings on
-- that operation: -amount on the source, +amount on the destination, same
-- effective_date. Both postings or neither: the RPC is one transaction.
-- No client_ledger, no supplier_ledger, no result: the money only moves.
--
-- Technical completions (contract behaviour unchanged):
--   * NULL p_amount is INVALID_AMOUNT (NULL <= 0 would otherwise pass).
--   * Two concurrent calls with the same external_ref can both pass the
--     EXISTS pre-check; the loser then hits the UNIQUE index on
--     financial_operation.external_ref after the winner commits. That
--     unique_violation is reported as the contract's DUPLICATE_TRANSFER, and
--     the whole loser call rolls back.
-- ============================================================================

CREATE OR REPLACE FUNCTION transfer_between_accounts(
  p_source_account_id UUID,
  p_dest_account_id   UUID,
  p_amount            NUMERIC,
  p_effective_date    DATE,
  p_external_ref      VARCHAR,
  p_reason            TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_operation_id  BIGINT;
  v_source_post   BIGINT;
  v_dest_post     BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_source_account_id = p_dest_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_source_account_id AND activo = true) THEN
    RAISE EXCEPTION 'SOURCE_ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_dest_account_id AND activo = true) THEN
    RAISE EXCEPTION 'DEST_ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM financial_operation WHERE external_ref = p_external_ref) THEN
    RAISE EXCEPTION 'DUPLICATE_TRANSFER: operation with external_ref % already exists', p_external_ref;
  END IF;

  PERFORM assert_period_open(p_effective_date);

  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, reason, created_by)
    VALUES ('TRANSFER', p_effective_date, p_external_ref, p_reason, v_uid)
    RETURNING id INTO v_operation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_TRANSFER: operation with external_ref % already exists', p_external_ref;
  END;

  -- exactly two postings, opposite signs, one shared operation: both or neither
  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (v_operation_id, p_source_account_id, -p_amount, p_effective_date, v_uid)
  RETURNING id INTO v_source_post;

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (v_operation_id, p_dest_account_id, p_amount, p_effective_date, v_uid)
  RETURNING id INTO v_dest_post;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_operation', v_operation_id::TEXT, 'TRANSFER',
          jsonb_build_object('source', p_source_account_id, 'dest', p_dest_account_id,
                             'amount', p_amount, 'effective_date', p_effective_date),
          p_reason, v_uid);

  RETURN jsonb_build_object(
    'financial_operation_id', v_operation_id,
    'posting_ids', jsonb_build_array(v_source_post, v_dest_post));
END;
$$;

ALTER  FUNCTION transfer_between_accounts(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION transfer_between_accounts(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION transfer_between_accounts(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) FROM anon, service_role;
GRANT  EXECUTE ON FUNCTION transfer_between_accounts(UUID, UUID, NUMERIC, DATE, VARCHAR, TEXT) TO authenticated;
