-- ============================================================================
-- TARGET V1 — 0036 FISCAL RPCs (Phase 22)
-- Authority: RPC_CONTRACTS_V1.md 34 register_fiscal_document
--                                35 register_fiscal_obligation
--                                36 pay_fiscal_obligation
--            RLS_IMPLEMENTATION_SPEC_V1.md §4, §9 (RPC-written; ADMIN only)
--            DATABASE_INVARIANTS_V1.md 12 (fiscal_obligation.status by RPC 36 only)
--
-- RPCs 34 and 35 create NO supplier_ledger / client_ledger row, NO
-- financial_operation and NO posting. RPC 36 is the only fiscal money
-- movement: one FISCAL_PAYMENT operation, one −amount posting, one payment row.
-- One transaction per call.
--
-- Technical completions (contract behaviour unchanged; each is tested):
--   * NULL fiscal_period is INVALID_FISCAL_PERIOD (NULL <> … would otherwise pass
--     and fail later on a raw NOT NULL error).
--   * NULL amount is INVALID_AMOUNT (RPCs 35, 36).
--   * A concurrent duplicate that passes the EXISTS pre-check and hits the frozen
--     UNIQUE backstop is reported with the contract code:
--       idx_fiscal_document_supplier_number → DUPLICATE_FISCAL_DOCUMENT
--       fiscal_obligation (tax_kind, fiscal_period) → DUPLICATE_OBLIGATION
--       fiscal_payment.idempotency_key / financial_operation.external_ref → DUPLICATE_PAYMENT
--   * Components and installments are inserted exactly as supplied: no rate
--     lookup, no recomputation of tax_amount (not frozen), no installment-level
--     rule beyond the frozen columns, UNIQUE and the INSTALLMENT_MISMATCH sum.
-- ============================================================================

-- ── 34. register_fiscal_document ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_fiscal_document(
  p_document_type   fiscal_document_type,
  p_direction       fiscal_direction,
  p_document_date   DATE,
  p_fiscal_period   DATE,
  p_net_amount      NUMERIC,
  p_total_amount    NUMERIC,
  p_components      JSONB,
  p_supplier_id     UUID DEFAULT NULL,
  p_cliente_id      UUID DEFAULT NULL,
  p_external_number VARCHAR DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_document_id UUID;
  v_comp        JSONB;
  v_count       INTEGER := 0;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_direction = 'CREDITO' AND p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_REQUIRED';
  END IF;
  IF p_direction = 'DEBITO' AND p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'CLIENT_REQUIRED';
  END IF;
  IF p_fiscal_period IS NULL OR p_fiscal_period <> date_trunc('month', p_fiscal_period)::DATE THEN
    RAISE EXCEPTION 'INVALID_FISCAL_PERIOD: must be the first day of a month';
  END IF;

  PERFORM assert_period_open(p_document_date);

  IF p_supplier_id IS NOT NULL AND p_external_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM fiscal_document
                  WHERE supplier_id = p_supplier_id AND external_number = p_external_number) THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_DOCUMENT';
  END IF;

  BEGIN
    INSERT INTO fiscal_document (document_type, direction, document_date, fiscal_period,
                                 supplier_id, cliente_id, external_number, net_amount,
                                 total_amount, created_by)
    VALUES (p_document_type, p_direction, p_document_date, p_fiscal_period,
            p_supplier_id, p_cliente_id, p_external_number, p_net_amount,
            p_total_amount, v_uid)
    RETURNING id INTO v_document_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_DOCUMENT';
  END;

  -- components exactly as supplied: rate_applied is the snapshot of the rate used
  FOR v_comp IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    INSERT INTO fiscal_document_component (fiscal_document_id, tax_kind, direction,
                                           base_amount, rate_applied, tax_amount)
    VALUES (v_document_id, (v_comp->>'tax_kind')::tax_kind, (v_comp->>'direction')::fiscal_direction,
            (v_comp->>'base_amount')::NUMERIC, (v_comp->>'rate_applied')::NUMERIC,
            (v_comp->>'tax_amount')::NUMERIC);
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fiscal_document', v_document_id::TEXT, 'CREATE',
          jsonb_build_object('document_type', p_document_type, 'direction', p_direction,
                             'fiscal_period', p_fiscal_period, 'total_amount', p_total_amount),
          p_reason, v_uid);

  RETURN jsonb_build_object('fiscal_document_id', v_document_id, 'component_count', v_count);
END;
$$;

-- ── 35. register_fiscal_obligation ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_fiscal_obligation(
  p_tax_kind      tax_kind,
  p_fiscal_period DATE,
  p_amount        NUMERIC,
  p_due_date      DATE DEFAULT NULL,
  p_installments  JSONB DEFAULT NULL,
  p_reason        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_obligation_id UUID;
  v_inst          JSONB;
  v_sum           NUMERIC(15,2) := 0;
  v_count         INTEGER := 0;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_fiscal_period IS NULL OR p_fiscal_period <> date_trunc('month', p_fiscal_period)::DATE THEN
    RAISE EXCEPTION 'INVALID_FISCAL_PERIOD';
  END IF;
  IF EXISTS (SELECT 1 FROM fiscal_obligation
              WHERE tax_kind = p_tax_kind AND fiscal_period = p_fiscal_period) THEN
    RAISE EXCEPTION 'DUPLICATE_OBLIGATION';
  END IF;

  PERFORM assert_period_open(p_fiscal_period);

  BEGIN
    INSERT INTO fiscal_obligation (tax_kind, fiscal_period, amount, due_date, status, created_by)
    VALUES (p_tax_kind, p_fiscal_period, p_amount, p_due_date, 'PENDING', v_uid)
    RETURNING id INTO v_obligation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_OBLIGATION';
  END;

  IF p_installments IS NOT NULL THEN
    FOR v_inst IN SELECT value FROM jsonb_array_elements(p_installments) LOOP
      INSERT INTO fiscal_obligation_installment (fiscal_obligation_id, installment_number, amount, due_date)
      VALUES (v_obligation_id, (v_inst->>'installment_number')::INTEGER,
              (v_inst->>'amount')::NUMERIC, (v_inst->>'due_date')::DATE);
      v_sum := v_sum + (v_inst->>'amount')::NUMERIC;
      v_count := v_count + 1;
    END LOOP;
    IF v_sum <> p_amount THEN
      RAISE EXCEPTION 'INSTALLMENT_MISMATCH: installments total % but obligation is %', v_sum, p_amount;
    END IF;
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fiscal_obligation', v_obligation_id::TEXT, 'CREATE',
          jsonb_build_object('tax_kind', p_tax_kind, 'fiscal_period', p_fiscal_period,
                             'amount', p_amount),
          p_reason, v_uid);

  RETURN jsonb_build_object('obligation_id', v_obligation_id, 'installment_count', v_count);
END;
$$;

-- ── 36. pay_fiscal_obligation ──────────────────────────────────────────────
-- The obligation row lock serialises every payment of one obligation, so the
-- paid-so-far read after it sees every committed payment.
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

-- ── ownership and EXECUTE perimeter ────────────────────────────────────────
ALTER  FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT) TO authenticated;

ALTER  FUNCTION register_fiscal_obligation(tax_kind, DATE, NUMERIC, DATE, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_fiscal_obligation(tax_kind, DATE, NUMERIC, DATE, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_fiscal_obligation(tax_kind, DATE, NUMERIC, DATE, JSONB, TEXT) TO authenticated;

ALTER  FUNCTION pay_fiscal_obligation(UUID, DATE, NUMERIC, UUID, VARCHAR, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION pay_fiscal_obligation(UUID, DATE, NUMERIC, UUID, VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION pay_fiscal_obligation(UUID, DATE, NUMERIC, UUID, VARCHAR, UUID, TEXT) TO authenticated;
