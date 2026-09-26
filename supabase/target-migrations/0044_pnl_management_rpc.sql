-- ============================================================================
-- TARGET V1 — 0044 MANAGEMENT EVENT RPC (Phase 24, ADR-004)
-- RPC 43 register_management_event — ADMIN only, append-only, idempotent,
-- period guarded (effective_date), audited.
--
--   RETIRO           creates exactly one OWNER_WITHDRAWAL operation with one
--                    posting on the account: −amount (original) / +amount
--                    (compensation: money returned). external_ref = 'MGMT:' || key.
--   RESERVA_INTERNA  creates no operation and no posting.
--
-- Compensation / release (p_compensates_event_id): the target must exist, be an
-- original (not itself a compensation), share the event type, and the
-- cumulative compensations may never exceed its amount. A RETIRO compensation
-- uses the original's account. History is never updated or deleted.
-- ============================================================================

CREATE OR REPLACE FUNCTION register_management_event(
  p_event_type           management_event_type,
  p_effective_date       DATE,
  p_amount               NUMERIC,
  p_idempotency_key      VARCHAR,
  p_reason               TEXT,
  p_financial_account_id UUID DEFAULT NULL,
  p_compensates_event_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_event_id     UUID := gen_random_uuid();
  v_original     management_event;
  v_compensated  NUMERIC(15,2);
  v_account      UUID := p_financial_account_id;
  v_operation_id BIGINT := NULL;
  v_sign         INTEGER := -1;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_event_type IS NULL THEN
    RAISE EXCEPTION 'INVALID_EVENT_TYPE';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 95 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 95 characters required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a management decision must be explained';
  END IF;
  IF EXISTS (SELECT 1 FROM management_event WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_MANAGEMENT_EVENT';
  END IF;

  IF p_compensates_event_id IS NOT NULL THEN
    SELECT * INTO v_original FROM management_event WHERE id = p_compensates_event_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'EVENT_NOT_FOUND';
    END IF;
    IF v_original.compensates_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_COMPENSATION_TARGET: a compensation cannot itself be compensated';
    END IF;
    IF v_original.event_type <> p_event_type THEN
      RAISE EXCEPTION 'COMPENSATION_TYPE_MISMATCH';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO v_compensated
      FROM management_event WHERE compensates_event_id = p_compensates_event_id;
    IF v_compensated + p_amount > v_original.amount THEN
      RAISE EXCEPTION 'COMPENSATION_EXCEEDS_ORIGINAL: compensating % exceeds the outstanding % of the original',
        p_amount, v_original.amount - v_compensated;
    END IF;
    IF p_event_type = 'RETIRO' THEN
      IF v_account IS NULL THEN
        v_account := v_original.financial_account_id;
      ELSIF v_account <> v_original.financial_account_id THEN
        RAISE EXCEPTION 'ACCOUNT_MISMATCH: a RETIRO compensation returns money to the original account';
      END IF;
    END IF;
    v_sign := 1;
  END IF;

  IF p_event_type = 'RETIRO' AND v_account IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_REQUIRED: a RETIRO moves money out of a financial account';
  END IF;
  IF p_event_type = 'RESERVA_INTERNA' AND v_account IS NOT NULL THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_ALLOWED: a RESERVA_INTERNA moves no money';
  END IF;

  PERFORM assert_period_open(p_effective_date);

  IF p_event_type = 'RETIRO' THEN
    BEGIN
      INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                       source_entity_type, source_entity_id, reason, created_by)
      VALUES ('OWNER_WITHDRAWAL', p_effective_date, 'MGMT:' || p_idempotency_key,
              'management_event', v_event_id::TEXT, p_reason, v_uid)
      RETURNING id INTO v_operation_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'DUPLICATE_MANAGEMENT_EVENT';
    END;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount,
                                   effective_date, created_by)
    VALUES (v_operation_id, v_account, v_sign * p_amount, p_effective_date, v_uid);
  END IF;

  BEGIN
    INSERT INTO management_event (id, event_type, effective_date, amount, compensates_event_id,
                                  financial_account_id, financial_operation_id, idempotency_key,
                                  reason, created_by)
    VALUES (v_event_id, p_event_type, p_effective_date, p_amount, p_compensates_event_id,
            v_account, v_operation_id, p_idempotency_key, p_reason, v_uid);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_MANAGEMENT_EVENT';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('management_event', v_event_id::TEXT,
          CASE WHEN p_compensates_event_id IS NULL THEN 'CREATE' ELSE 'COMPENSATE' END,
          jsonb_build_object('event_type', p_event_type, 'effective_date', p_effective_date,
                             'amount', p_amount, 'compensates_event_id', p_compensates_event_id,
                             'financial_account_id', v_account, 'financial_operation_id', v_operation_id),
          p_reason, v_uid);

  RETURN jsonb_build_object('management_event_id', v_event_id, 'financial_operation_id', v_operation_id);
END;
$$;

ALTER  FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_management_event(management_event_type, DATE, NUMERIC, VARCHAR, TEXT, UUID, UUID) TO authenticated;
