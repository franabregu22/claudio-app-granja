-- ============================================================================
-- TARGET V1 — 0038 FISCAL INSTALLMENT OWNERSHIP (Phase 22, owner decision)
-- Authority: RPC_CONTRACTS_V1.md 36 pay_fiscal_obligation, as completed by the
--            Phase 22 owner decision (2026-09-25, PHASE_22_FISCAL.md §19, §36.2):
--
--   "If RPC 36 receives p_installment_id IS NOT NULL, that installment MUST
--    belong to p_obligation_id."
--
-- Applied migrations are immutable (runner checksum), so the correction enters
-- as a new migration, exactly as ADR-001 (0018) and ADR-002 (0022) did.
--
-- The ONLY change to 0036 is the ownership check, placed after the obligation
-- lock and status/period checks and BEFORE any write (operation, posting,
-- payment, status, audit). A nonexistent installment and an installment of
-- another obligation both raise INSTALLMENT_NOT_FOUND_OR_MISMATCH.
--
-- Deliberately NOT added (owner decision): installment status, installment
-- balance, per-installment overpayment, full-installment payment, installment
-- order. The amount control stays at obligation level only.
-- ============================================================================

CREATE OR REPLACE FUNCTION pay_fiscal_obligation(
  p_obligation_id        UUID,
  p_effective_date       DATE,
  p_amount               NUMERIC,
  p_financial_account_id UUID,
  p_idempotency_key      VARCHAR,
  p_installment_id       UUID DEFAULT NULL,
  p_reason               TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_ob           fiscal_obligation;
  v_paid_so_far  NUMERIC(15,2);
  v_operation_id BIGINT;
  v_payment_id   UUID;
  v_new_status   fiscal_obligation_status;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF EXISTS (SELECT 1 FROM fiscal_payment WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END IF;

  SELECT * INTO v_ob FROM fiscal_obligation WHERE id = p_obligation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OBLIGATION_NOT_FOUND';
  END IF;
  IF v_ob.status = 'PAID' THEN
    RAISE EXCEPTION 'ALREADY_PAID';
  END IF;
  IF v_ob.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'OBLIGATION_CANCELLED';
  END IF;

  PERFORM assert_period_open(p_effective_date);

  -- owner decision: a supplied installment must belong to this obligation
  IF p_installment_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fiscal_obligation_installment
                      WHERE id = p_installment_id AND fiscal_obligation_id = p_obligation_id) THEN
    RAISE EXCEPTION 'INSTALLMENT_NOT_FOUND_OR_MISMATCH: installment % does not belong to obligation %',
      p_installment_id, p_obligation_id;
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid_so_far
    FROM fiscal_payment WHERE fiscal_obligation_id = p_obligation_id;
  IF v_paid_so_far + p_amount > v_ob.amount THEN
    RAISE EXCEPTION 'OVERPAYMENT: paying % exceeds the outstanding balance', p_amount;
  END IF;

  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                     source_entity_type, source_entity_id, reason, created_by)
    VALUES ('FISCAL_PAYMENT', p_effective_date, p_idempotency_key,
            'fiscal_obligation', p_obligation_id::TEXT, p_reason, v_uid)
    RETURNING id INTO v_operation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;

  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount,
                                 effective_date, created_by)
  VALUES (v_operation_id, p_financial_account_id, -p_amount, p_effective_date, v_uid);

  BEGIN
    INSERT INTO fiscal_payment (fiscal_obligation_id, installment_id, effective_date, amount,
                                financial_account_id, financial_operation_id, idempotency_key, created_by)
    VALUES (p_obligation_id, p_installment_id, p_effective_date, p_amount,
            p_financial_account_id, v_operation_id, p_idempotency_key, v_uid)
    RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;

  v_new_status := CASE WHEN v_paid_so_far + p_amount = v_ob.amount THEN 'PAID'
                       ELSE 'PARTIALLY_PAID' END;
  UPDATE fiscal_obligation SET status = v_new_status WHERE id = p_obligation_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('fiscal_obligation', p_obligation_id::TEXT, 'PAY',
          jsonb_build_object('status', v_ob.status, 'paid_so_far', v_paid_so_far),
          jsonb_build_object('status', v_new_status, 'payment', p_amount),
          p_reason, v_uid);

  RETURN jsonb_build_object('payment_id', v_payment_id, 'financial_operation_id', v_operation_id,
                            'obligation_status', v_new_status);
END;
$$;

-- CREATE OR REPLACE keeps the owner and ACL of 0036; restated so this
-- migration is correct on its own.
ALTER  FUNCTION pay_fiscal_obligation(UUID, DATE, NUMERIC, UUID, VARCHAR, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION pay_fiscal_obligation(UUID, DATE, NUMERIC, UUID, VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION pay_fiscal_obligation(UUID, DATE, NUMERIC, UUID, VARCHAR, UUID, TEXT) TO authenticated;
