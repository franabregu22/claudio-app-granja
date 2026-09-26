-- ============================================================================
-- TARGET V1 — 0016 INSTRUMENT RPCs (Phase 16, Cheques / eCheqs)
-- Authority: RPC_CONTRACTS_V1.md  5 receive_cheque          9 reject_cheque
--                                 6 deposit_cheque         10 issue_supplier_instrument
--                                 7 clear_cheque           11 mark_supplier_instrument_debited
--                                 8 endorse_cheque         12 reject_supplier_instrument
--            DATABASE_INVARIANTS_V1.md 18 (state machine), 19 (economics)
--
-- Frozen economics:
--   received: reception reduces client debt and does NOT touch the bank;
--             deposit is a custody state change only; clearing credits the bank;
--             endorsement reduces supplier debt and leaves the client paid;
--             rejection compensates according to the stage actually reached.
--   issued:   issuing reduces supplier debt and does NOT touch the bank; debit
--             moves the bank; rejection reopens supplier debt and reverses the
--             bank only if the debit actually happened.
--
-- Every function: SECURITY DEFINER, search_path = public, owner postgres,
-- actor = auth.uid(), role = current_app_role(); transitions lock the
-- instrument FOR UPDATE and validate estado before any write; period guard
-- before the first write; one transaction per call.
--
-- Technical completions (contract behaviour unchanged):
--   * NULL p_amount is INVALID_AMOUNT (NULL <= 0 would otherwise pass).
--   * receive/issue: a concurrent duplicate receipt_id / external_ref can pass
--     the EXISTS pre-check and then hit the UNIQUE index; that unique_violation
--     is reported as the contract's DUPLICATE_RECEIPT / DUPLICATE_EXTERNAL_REF.
-- ============================================================================

-- ── 5. receive_cheque ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION receive_cheque(
  p_cliente_id      UUID,
  p_instrument_type financial_instrument_type,
  p_cheque_number   VARCHAR,
  p_amount          NUMERIC,
  p_maturity_date   DATE,
  p_received_at     TIMESTAMPTZ,
  p_receipt_id      VARCHAR,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_received_date DATE;
  v_client_name   TEXT;
  v_instrument_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_cliente_id AND activo = true) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM financial_instrument WHERE receipt_id = p_receipt_id) THEN
    RAISE EXCEPTION 'DUPLICATE_RECEIPT: instrument with receipt_id % already exists', p_receipt_id;
  END IF;

  v_received_date := (p_received_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  PERFORM assert_period_open(v_received_date);

  SELECT nombre INTO v_client_name FROM clients WHERE id = p_cliente_id;

  BEGIN
    INSERT INTO financial_instrument (instrument_type, direction, estado, cheque_number, amount,
           maturity_date, cliente_id, receipt_id, received_date, created_by)
    VALUES (p_instrument_type, 'RECEIVED', 'RECEIVED', p_cheque_number, p_amount,
            p_maturity_date, p_cliente_id, p_receipt_id, v_received_date, v_uid)
    RETURNING id INTO v_instrument_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_RECEIPT: instrument with receipt_id % already exists', p_receipt_id;
  END;

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date, reason, created_by)
  VALUES (v_instrument_id, 'RECEIVED', v_received_date, p_reason, v_uid);

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'CHEQUE_RECEIVED', -p_amount, v_received_date, v_client_name,
          'financial_instrument', v_instrument_id::TEXT, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_instrument', v_instrument_id::TEXT, 'RECEIVE',
          jsonb_build_object('amount', p_amount, 'cheque_number', p_cheque_number,
                             'received_date', v_received_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', v_instrument_id, 'estado', 'RECEIVED',
                            'received_date', v_received_date);
END;
$$;

-- ── 6. deposit_cheque ──────────────────────────────────────────────────────
-- Custody state change only: no ledger, no posting.

CREATE OR REPLACE FUNCTION deposit_cheque(
  p_instrument_id  UUID,
  p_deposited_date DATE,
  p_reason         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_inst financial_instrument;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'RECEIVED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION: deposit applies to received instruments';
  END IF;
  IF v_inst.estado <> 'RECEIVED' THEN
    RAISE EXCEPTION 'INVALID_STATE: expected RECEIVED, found %', v_inst.estado;
  END IF;

  PERFORM assert_period_open(p_deposited_date);

  UPDATE financial_instrument SET estado = 'DEPOSITED', deposited_date = p_deposited_date
   WHERE id = p_instrument_id;

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date, reason, created_by)
  VALUES (p_instrument_id, 'DEPOSITED', p_deposited_date, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'DEPOSIT',
          jsonb_build_object('estado', 'RECEIVED'),
          jsonb_build_object('estado', 'DEPOSITED', 'deposited_date', p_deposited_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'estado', 'DEPOSITED',
                            'deposited_date', p_deposited_date);
END;
$$;

-- ── 7. clear_cheque ────────────────────────────────────────────────────────
-- The only step of the received lifecycle that moves the bank.

CREATE OR REPLACE FUNCTION clear_cheque(
  p_instrument_id   UUID,
  p_cleared_date    DATE,
  p_bank_account_id UUID,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_inst         financial_instrument;
  v_operation_id BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'RECEIVED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION';
  END IF;
  IF v_inst.estado <> 'DEPOSITED' THEN
    RAISE EXCEPTION 'INVALID_STATE: expected DEPOSITED, found %', v_inst.estado;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_bank_account_id AND activo = true) THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;

  PERFORM assert_period_open(p_cleared_date);

  -- bank_account_id is persisted so a later rejection reverses the correct account
  UPDATE financial_instrument
     SET estado = 'CLEARED', cleared_date = p_cleared_date, bank_account_id = p_bank_account_id
   WHERE id = p_instrument_id;

  INSERT INTO financial_operation (operation_type, effective_date, external_ref,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES ('CHEQUE_CLEAR', p_cleared_date, 'CLEAR:' || p_instrument_id::TEXT,
          'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_operation_id;

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (v_operation_id, p_bank_account_id, v_inst.amount, p_cleared_date, v_uid);

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'CLEARED', p_cleared_date, v_operation_id, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'CLEAR',
          jsonb_build_object('estado', 'DEPOSITED'),
          jsonb_build_object('estado', 'CLEARED', 'cleared_date', p_cleared_date,
                             'bank_account_id', p_bank_account_id),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'estado', 'CLEARED',
                            'cleared_date', p_cleared_date, 'financial_operation_id', v_operation_id);
END;
$$;

-- ── 8. endorse_cheque ──────────────────────────────────────────────────────
-- Supplier debt -amount; client untouched (payment final); no bank movement.

CREATE OR REPLACE FUNCTION endorse_cheque(
  p_instrument_id UUID,
  p_supplier_id   UUID,
  p_endorsed_date DATE,
  p_reason        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_inst financial_instrument;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'RECEIVED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION';
  END IF;
  IF v_inst.estado <> 'RECEIVED' THEN
    RAISE EXCEPTION 'INVALID_STATE: only an in-portfolio instrument can be endorsed, found %', v_inst.estado;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE';
  END IF;

  PERFORM assert_period_open(p_endorsed_date);

  UPDATE financial_instrument
     SET estado = 'ENDORSED', endorsed_date = p_endorsed_date, endorsed_to_supplier_id = p_supplier_id
   WHERE id = p_instrument_id;

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date, reason, created_by)
  VALUES (p_instrument_id, 'ENDORSED', p_endorsed_date, p_reason, v_uid);

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'CHEQUE_ENDORSED', -v_inst.amount, p_endorsed_date,
          'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'ENDORSE',
          jsonb_build_object('estado', 'RECEIVED'),
          jsonb_build_object('estado', 'ENDORSED', 'supplier_id', p_supplier_id,
                             'endorsed_date', p_endorsed_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'estado', 'ENDORSED',
                            'endorsed_date', p_endorsed_date, 'supplier_id', p_supplier_id);
END;
$$;

-- ── 9. reject_cheque ───────────────────────────────────────────────────────
-- Compensation branches deterministically on the stage actually reached:
--   RECEIVED | DEPOSITED -> client debt reopens; no bank movement ever occurred
--   CLEARED              -> client debt reopens AND the bank credit is reversed
--   ENDORSED             -> supplier debt reopens; the client stays paid

CREATE OR REPLACE FUNCTION reject_cheque(
  p_instrument_id UUID,
  p_rejected_date DATE,
  p_reason        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_inst         financial_instrument;
  v_prior        instrument_estado;
  v_client_name  TEXT;
  v_operation_id BIGINT := NULL;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'RECEIVED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION: use reject_supplier_instrument';
  END IF;
  IF v_inst.estado = 'REJECTED' THEN
    RAISE EXCEPTION 'ALREADY_REJECTED';
  END IF;

  v_prior := v_inst.estado;
  PERFORM assert_period_open(p_rejected_date);

  UPDATE financial_instrument SET estado = 'REJECTED', rejected_date = p_rejected_date
   WHERE id = p_instrument_id;

  IF v_prior IN ('RECEIVED', 'DEPOSITED') THEN
    SELECT nombre INTO v_client_name FROM clients WHERE id = v_inst.cliente_id;
    INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
           ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_inst.cliente_id, 'CHEQUE_REJECTED', v_inst.amount, p_rejected_date, v_client_name,
            'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid);

  ELSIF v_prior = 'CLEARED' THEN
    SELECT nombre INTO v_client_name FROM clients WHERE id = v_inst.cliente_id;
    INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
           ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_inst.cliente_id, 'CHEQUE_REJECTED', v_inst.amount, p_rejected_date, v_client_name,
            'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid);

    INSERT INTO financial_operation (operation_type, effective_date, external_ref,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES ('CHEQUE_REJECTION', p_rejected_date, 'REJECT:' || p_instrument_id::TEXT,
            'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid)
    RETURNING id INTO v_operation_id;

    INSERT INTO financial_posting (financial_operation_id, financial_account_id,
           signed_amount, effective_date, created_by)
    VALUES (v_operation_id, v_inst.bank_account_id, -v_inst.amount, p_rejected_date, v_uid);

  ELSIF v_prior = 'ENDORSED' THEN
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_inst.endorsed_to_supplier_id, 'INSTRUMENT_REJECTED', v_inst.amount, p_rejected_date,
            'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid);
  END IF;

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'REJECTED', p_rejected_date, v_operation_id, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'REJECT',
          jsonb_build_object('estado', v_prior),
          jsonb_build_object('estado', 'REJECTED', 'rejected_date', p_rejected_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'prior_estado', v_prior,
                            'estado', 'REJECTED', 'rejected_date', p_rejected_date,
                            'financial_operation_id', v_operation_id);
END;
$$;

-- ── 10. issue_supplier_instrument ──────────────────────────────────────────
-- Supplier debt -amount at issue; no bank movement until debit.

CREATE OR REPLACE FUNCTION issue_supplier_instrument(
  p_supplier_id     UUID,
  p_instrument_type financial_instrument_type,
  p_cheque_number   VARCHAR,
  p_amount          NUMERIC,
  p_maturity_date   DATE,
  p_issued_date     DATE,
  p_bank_account_id UUID,
  p_external_ref    VARCHAR,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_instrument_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_bank_account_id AND activo = true) THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM financial_instrument WHERE external_ref = p_external_ref) THEN
    RAISE EXCEPTION 'DUPLICATE_EXTERNAL_REF';
  END IF;

  PERFORM assert_period_open(p_issued_date);

  BEGIN
    INSERT INTO financial_instrument (instrument_type, direction, estado, cheque_number, amount,
           maturity_date, supplier_id, bank_account_id, external_ref, issued_date, created_by)
    VALUES (p_instrument_type, 'ISSUED', 'ISSUED', p_cheque_number, p_amount,
            p_maturity_date, p_supplier_id, p_bank_account_id, p_external_ref, p_issued_date, v_uid)
    RETURNING id INTO v_instrument_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_EXTERNAL_REF';
  END;

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date, reason, created_by)
  VALUES (v_instrument_id, 'ISSUED', p_issued_date, p_reason, v_uid);

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'INSTRUMENT_ISSUED', -p_amount, p_issued_date,
          'financial_instrument', v_instrument_id::TEXT, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_instrument', v_instrument_id::TEXT, 'ISSUE',
          jsonb_build_object('amount', p_amount, 'supplier_id', p_supplier_id,
                             'issued_date', p_issued_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', v_instrument_id, 'estado', 'ISSUED',
                            'issued_date', p_issued_date);
END;
$$;

-- ── 11. mark_supplier_instrument_debited ───────────────────────────────────
-- The bank moves: -amount on the issuing account. Supplier debt untouched.

CREATE OR REPLACE FUNCTION mark_supplier_instrument_debited(
  p_instrument_id UUID,
  p_debited_date  DATE,
  p_reason        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_inst         financial_instrument;
  v_operation_id BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'ISSUED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION';
  END IF;
  IF v_inst.estado <> 'ISSUED' THEN
    RAISE EXCEPTION 'INVALID_STATE: expected ISSUED, found %', v_inst.estado;
  END IF;

  PERFORM assert_period_open(p_debited_date);

  UPDATE financial_instrument SET estado = 'DEBITED', debited_date = p_debited_date
   WHERE id = p_instrument_id;

  INSERT INTO financial_operation (operation_type, effective_date, external_ref,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES ('INSTRUMENT_DEBIT', p_debited_date, 'DEBIT:' || p_instrument_id::TEXT,
          'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_operation_id;

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (v_operation_id, v_inst.bank_account_id, -v_inst.amount, p_debited_date, v_uid);

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'DEBITED', p_debited_date, v_operation_id, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'DEBIT',
          jsonb_build_object('estado', 'ISSUED'),
          jsonb_build_object('estado', 'DEBITED', 'debited_date', p_debited_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'estado', 'DEBITED',
                            'debited_date', p_debited_date, 'financial_operation_id', v_operation_id);
END;
$$;

-- ── 12. reject_supplier_instrument ─────────────────────────────────────────
-- Supplier debt reopens in both stages; the bank is reversed only after DEBITED.

CREATE OR REPLACE FUNCTION reject_supplier_instrument(
  p_instrument_id UUID,
  p_rejected_date DATE,
  p_reason        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_inst         financial_instrument;
  v_prior        instrument_estado;
  v_operation_id BIGINT := NULL;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'ISSUED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION: use reject_cheque';
  END IF;
  IF v_inst.estado NOT IN ('ISSUED', 'DEBITED') THEN
    RAISE EXCEPTION 'INVALID_STATE: expected ISSUED or DEBITED, found %', v_inst.estado;
  END IF;

  v_prior := v_inst.estado;
  PERFORM assert_period_open(p_rejected_date);

  UPDATE financial_instrument SET estado = 'REJECTED', rejected_date = p_rejected_date
   WHERE id = p_instrument_id;

  -- supplier debt reopens in both cases: the obligation was never actually settled
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_inst.supplier_id, 'INSTRUMENT_REJECTED', v_inst.amount, p_rejected_date,
          'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid);

  IF v_prior = 'DEBITED' THEN
    -- the bank had already been debited; reverse it on the same account
    INSERT INTO financial_operation (operation_type, effective_date, external_ref,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES ('INSTRUMENT_DEBIT_REVERSAL', p_rejected_date, 'DEBIT_REV:' || p_instrument_id::TEXT,
            'financial_instrument', p_instrument_id::TEXT, p_reason, v_uid)
    RETURNING id INTO v_operation_id;

    INSERT INTO financial_posting (financial_operation_id, financial_account_id,
           signed_amount, effective_date, created_by)
    VALUES (v_operation_id, v_inst.bank_account_id, v_inst.amount, p_rejected_date, v_uid);
  END IF;

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'REJECTED', p_rejected_date, v_operation_id, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'REJECT_ISSUED',
          jsonb_build_object('estado', v_prior),
          jsonb_build_object('estado', 'REJECTED', 'rejected_date', p_rejected_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'prior_estado', v_prior,
                            'estado', 'REJECTED', 'rejected_date', p_rejected_date,
                            'financial_operation_id', v_operation_id);
END;
$$;

-- ── ownership and EXECUTE perimeter (RLS spec section 4) ───────────────────

ALTER FUNCTION receive_cheque(UUID, financial_instrument_type, VARCHAR, NUMERIC, DATE, TIMESTAMPTZ, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION deposit_cheque(UUID, DATE, TEXT) OWNER TO postgres;
ALTER FUNCTION clear_cheque(UUID, DATE, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION endorse_cheque(UUID, UUID, DATE, TEXT) OWNER TO postgres;
ALTER FUNCTION reject_cheque(UUID, DATE, TEXT) OWNER TO postgres;
ALTER FUNCTION issue_supplier_instrument(UUID, financial_instrument_type, VARCHAR, NUMERIC, DATE, DATE, UUID, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION mark_supplier_instrument_debited(UUID, DATE, TEXT) OWNER TO postgres;
ALTER FUNCTION reject_supplier_instrument(UUID, DATE, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION receive_cheque(UUID, financial_instrument_type, VARCHAR, NUMERIC, DATE, TIMESTAMPTZ, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION deposit_cheque(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION clear_cheque(UUID, DATE, UUID, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION endorse_cheque(UUID, UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION reject_cheque(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION issue_supplier_instrument(UUID, financial_instrument_type, VARCHAR, NUMERIC, DATE, DATE, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mark_supplier_instrument_debited(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION reject_supplier_instrument(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION receive_cheque(UUID, financial_instrument_type, VARCHAR, NUMERIC, DATE, TIMESTAMPTZ, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION deposit_cheque(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION clear_cheque(UUID, DATE, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION endorse_cheque(UUID, UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION reject_cheque(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION issue_supplier_instrument(UUID, financial_instrument_type, VARCHAR, NUMERIC, DATE, DATE, UUID, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mark_supplier_instrument_debited(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION reject_supplier_instrument(UUID, DATE, TEXT) TO authenticated;
