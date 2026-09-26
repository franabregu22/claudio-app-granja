-- ============================================================================
-- TARGET V1 — 0042 MP CONTRACT HARDENING (Phase 23, owner corrections)
-- Authority: ADR-003 as updated 2026-09-25 (§2 D1/D3, §8 D7):
--   * RPC 40: IGNORED means "valid, deterministically recognised event outside
--     the financial-movement scope". reserve_for_payment / reserve_for_payout now
--     pass EVERY common validation (amounts, credit XOR debit, net, fee/tax sign,
--     arithmetic, SOURCE_ID / DATE, external_id, occurred_at / occurred_date)
--     before being classified IGNORED; any failure is ERROR. Validation order:
--     source_type / layout / raw strings → DESCRIPTION recognised → amounts →
--     credit XOR debit → net → fee, tax <= 0 → arithmetic → SOURCE_ID, DATE →
--     external_id → timestamp / occurred_date → classify (IGNORED | NORMALIZED).
--   * RPC 41 Mode 1 may create only MP_SETTLEMENT, FEE or ADJUSTMENT operations;
--     any other type → INVALID_MP_OPERATION_TYPE before any write. Mode 2 creates
--     no operation and ignores p_operation_type.
--
-- Applied migrations are immutable: 0040 is untouched; both functions are
-- redefined here (CREATE OR REPLACE, same signatures, same grants).
-- ============================================================================

-- ── 40. mp_normalize_source ────────────────────────────────────────────────
-- SERVICE_ROLE only. Raw columns are never written; only processing_status,
-- processed_at and processing_note change. No period guard (frozen): the
-- movement merely carries the source's occurred_date as its period determinant.
CREATE OR REPLACE FUNCTION mp_normalize_source(
  p_source_record_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src      mp_source_record;
  v_ev       JSONB;
  v_desc     TEXT;
  v_kind     TEXT;
  v_status   mp_processing_status;
  v_note     TEXT := NULL;
  v_credit   NUMERIC(15,2);
  v_debit    NUMERIC(15,2);
  v_gross    NUMERIC(15,2);
  v_fee      NUMERIC(15,2);
  v_tax      NUMERIC(15,2);
  v_net      NUMERIC(15,2);
  v_at       TIMESTAMPTZ;
  v_count    INTEGER := 0;
  v_field    TEXT;
  c_keys     CONSTANT TEXT[] := ARRAY['BALANCE_AMOUNT','BUSINESS_UNIT','DATE','DESCRIPTION','GROSS_AMOUNT',
    'MP_FEE_AMOUNT','NET_CREDIT_AMOUNT','NET_DEBIT_AMOUNT','PAYMENT_METHOD','PAYMENT_METHOD_TYPE',
    'PURCHASE_ID','SOURCE_ID','SUB_UNIT','TAXES_AMOUNT','TRANSACTION_APPROVAL_DATE'];
  c_amount   CONSTANT TEXT := '^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
  c_ts       CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;

  SELECT * INTO v_src FROM mp_source_record WHERE id = p_source_record_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_NOT_FOUND';
  END IF;
  IF v_src.processing_status <> 'PENDING' THEN
    RAISE EXCEPTION 'ALREADY_PROCESSED: status is %', v_src.processing_status;
  END IF;

  v_ev := v_src.event_data;

  -- parse_mp_payload (ADR-003): the Liberaciones csv_import contract, evaluated
  -- in a fixed order; the first failing rule decides the outcome.
  <<parse>>
  BEGIN
    IF v_src.source_type <> 'csv_import' THEN
      v_status := 'ERROR';
      v_note := format('UNSUPPORTED_SOURCE_TYPE: %s is not normalized in V1', v_src.source_type);
      EXIT parse;
    END IF;
    IF jsonb_typeof(v_ev) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_ev) k) IS DISTINCT FROM c_keys THEN
      v_status := 'ERROR';
      v_note := 'UNSUPPORTED_CSV_FORMAT: event_data is not exactly the 15-column Liberaciones layout';
      EXIT parse;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(v_ev) e WHERE jsonb_typeof(e.value) <> 'string') THEN
      v_status := 'ERROR';
      v_note := 'MALFORMED_EVENT_DATA: every Liberaciones value must be a raw string';
      EXIT parse;
    END IF;

    -- the DESCRIPTION must be recognised; reserve rows are recognised but, as
    -- IGNORED means "valid event outside scope", they pass every check below first
    v_desc := v_ev->>'DESCRIPTION';
    IF v_desc IS NULL OR v_desc NOT IN ('payment', 'asset_management', 'payout',
                                        'reserve_for_payment', 'reserve_for_payout') THEN
      v_status := 'ERROR';
      v_note := format('UNKNOWN_DESCRIPTION: %s', coalesce(v_desc, '(null)'));
      EXIT parse;
    END IF;
    v_kind := CASE v_desc WHEN 'payment' THEN 'payment'
                          WHEN 'asset_management' THEN 'yield'
                          WHEN 'payout' THEN 'transfer' END;   -- NULL for reserve rows

    FOREACH v_field IN ARRAY ARRAY['NET_CREDIT_AMOUNT','NET_DEBIT_AMOUNT','GROSS_AMOUNT','MP_FEE_AMOUNT','TAXES_AMOUNT'] LOOP
      IF coalesce(v_ev->>v_field, '') = '' THEN
        v_status := 'ERROR';
        v_note := format('MISSING_AMOUNT: %s', v_field);
        EXIT parse;
      END IF;
      IF (v_ev->>v_field) !~ c_amount THEN
        v_status := 'ERROR';
        v_note := format('MALFORMED_AMOUNT: %s = %s', v_field, v_ev->>v_field);
        EXIT parse;
      END IF;
    END LOOP;
    v_credit := (v_ev->>'NET_CREDIT_AMOUNT')::NUMERIC;
    v_debit  := (v_ev->>'NET_DEBIT_AMOUNT')::NUMERIC;
    v_gross  := (v_ev->>'GROSS_AMOUNT')::NUMERIC;
    v_fee    := (v_ev->>'MP_FEE_AMOUNT')::NUMERIC;
    v_tax    := (v_ev->>'TAXES_AMOUNT')::NUMERIC;

    IF (v_credit <> 0) = (v_debit <> 0) THEN
      v_status := 'ERROR';
      v_note := 'CREDIT_DEBIT_INVALID: exactly one of NET_CREDIT_AMOUNT / NET_DEBIT_AMOUNT must be non-zero';
      EXIT parse;
    END IF;
    v_net := v_credit - v_debit;
    IF v_net = 0 THEN
      v_status := 'ERROR';
      v_note := 'ZERO_NET: a supported movement must have a non-zero net';
      EXIT parse;
    END IF;
    IF v_fee > 0 OR v_tax > 0 THEN
      v_status := 'ERROR';
      v_note := 'SIGN_INVALID: MP_FEE_AMOUNT and TAXES_AMOUNT must be <= 0';
      EXIT parse;
    END IF;
    IF v_gross + v_fee + v_tax <> v_net THEN
      v_status := 'ERROR';
      v_note := format('ARITHMETIC_MISMATCH: gross %s + fee %s + tax %s <> net %s', v_gross, v_fee, v_tax, v_net);
      EXIT parse;
    END IF;

    -- raw identity / date must be exactly what the contract derives from the row
    IF coalesce(v_ev->>'SOURCE_ID', '') = '' OR coalesce(v_ev->>'DATE', '') = '' THEN
      v_status := 'ERROR';
      v_note := 'MISSING_IDENTITY: rows without SOURCE_ID or DATE are not source events';
      EXIT parse;
    END IF;
    IF (v_src.external_id IS DISTINCT FROM
        ((v_ev->>'SOURCE_ID') || ':' || v_desc || ':' || (CASE WHEN v_net > 0 THEN 'C' ELSE 'D' END))) THEN
      v_status := 'ERROR';
      v_note := 'IDENTITY_MISMATCH: external_id is not SOURCE_ID:DESCRIPTION:direction';
      EXIT parse;
    END IF;
    IF (v_ev->>'DATE') !~ c_ts THEN
      v_status := 'ERROR';
      v_note := format('MALFORMED_DATE: %s', v_ev->>'DATE');
      EXIT parse;
    END IF;
    v_at := (v_ev->>'DATE')::TIMESTAMPTZ;
    IF v_src.occurred_at IS DISTINCT FROM v_at
       OR v_src.occurred_date IS DISTINCT FROM (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE THEN
      v_status := 'ERROR';
      v_note := 'DATE_MISMATCH: occurred_at / occurred_date differ from the DATE field';
      EXIT parse;
    END IF;

    -- every common validation passed: classify
    IF v_desc IN ('reserve_for_payment', 'reserve_for_payout') THEN
      v_status := 'IGNORED';
      v_note := format('RESERVE_ROW: %s is a valid MP internal reserve, outside the financial-movement scope', v_desc);
      EXIT parse;
    END IF;
    v_status := 'NORMALIZED';
  END parse;

  IF v_status = 'NORMALIZED' THEN
    INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount,
                                       fee_amount, tax_amount, net_amount, occurred_date)
    VALUES (p_source_record_id, v_kind, v_gross, v_fee, v_tax, v_net, v_src.occurred_date)
    ON CONFLICT (mp_source_record_id, movement_kind) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  -- ONLY processing metadata is updated
  UPDATE mp_source_record
     SET processing_status = v_status, processed_at = NOW(), processing_note = v_note
   WHERE id = p_source_record_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('mp_source_record', p_source_record_id::TEXT, 'NORMALIZE',
          jsonb_build_object('processing_status', 'PENDING'),
          jsonb_build_object('processing_status', v_status, 'movements', v_count, 'processing_note', v_note),
          v_note, NULL);

  RETURN jsonb_build_object('source_record_id', p_source_record_id, 'processing_status', v_status,
                            'movements_created', v_count);
END;
$$;

-- ── 41. mp_reconcile_movement ──────────────────────────────────────────────
-- SERVICE_ROLE or ADMIN. Mode 1 (p_existing_financial_operation_id IS NULL):
-- new operation + one posting + reconciliation. Mode 2: link the caller-chosen
-- existing operation's single posting on p_financial_account_id; no operation,
-- no posting. Both caps (movement, and operation per account) are abs caps.
CREATE OR REPLACE FUNCTION mp_reconcile_movement(
  p_movement_id                     BIGINT,
  p_assigned_amount                 NUMERIC,
  p_idempotency_key                 VARCHAR,
  p_financial_account_id            UUID,
  p_operation_type                  financial_operation_type DEFAULT 'MP_SETTLEMENT',
  p_existing_financial_operation_id BIGINT DEFAULT NULL,
  p_reason                          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID;
  v_mv             mp_financial_movement;
  v_already        NUMERIC(15,2);
  v_op_id          BIGINT;
  v_capacity       NUMERIC(15,2);
  v_postings       INTEGER;
  v_linked         NUMERIC(15,2);
  v_recon_id       UUID;
  v_mode           INTEGER;
  v_src_status     mp_processing_status;
  v_new_status     mp_processing_status;
  v_constraint     TEXT;
BEGIN
  -- service_role has no perfiles row: current_app_role() is only consulted for users
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF current_app_role() <> 'ADMIN' THEN
      RAISE EXCEPTION 'FORBIDDEN: ADMIN or backend service role required';
    END IF;
    v_uid := auth.uid();
  END IF;

  IF p_assigned_amount IS NULL OR p_assigned_amount = 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 97 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 97 characters required';
  END IF;
  IF p_financial_account_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_REQUIRED';
  END IF;
  v_mode := CASE WHEN p_existing_financial_operation_id IS NULL THEN 1 ELSE 2 END;
  -- Mode 1 creates an operation: only MP-owned types. Cross-domain types stay owned by
  -- their RPCs (TRANSFER needs exactly 2 postings, COLLECTION, cheque/instrument types,
  -- SUPPLIER_PAYMENT / FREIGHT_PAYMENT, FISCAL_PAYMENT, SESSION_CASH). Mode 2 creates no
  -- operation, so p_operation_type is not consulted there (ignored).
  IF v_mode = 1 AND (p_operation_type IS NULL OR p_operation_type NOT IN ('MP_SETTLEMENT', 'FEE', 'ADJUSTMENT')) THEN
    RAISE EXCEPTION 'INVALID_MP_OPERATION_TYPE: Mode 1 may create MP_SETTLEMENT, FEE or ADJUSTMENT only (got %)', p_operation_type;
  END IF;
  IF EXISTS (SELECT 1 FROM mp_reconciliation WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_RECONCILIATION';
  END IF;

  -- lock order: movement → (Mode 2) operation → source
  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOVEMENT_NOT_FOUND';
  END IF;

  -- the reconciliation timestamp never changes the original fact's period
  PERFORM assert_period_open(v_mv.occurred_date);

  SELECT COALESCE(SUM(assigned_amount), 0) INTO v_already
    FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id;
  IF abs(v_already + p_assigned_amount) > abs(v_mv.net_amount) THEN
    RAISE EXCEPTION 'OVER_ASSIGNMENT: assigning % exceeds movement net % (already %)',
      p_assigned_amount, v_mv.net_amount, v_already;
  END IF;

  IF v_mode = 2 THEN
    PERFORM 1 FROM financial_operation WHERE id = p_existing_financial_operation_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OPERATION_NOT_FOUND';
    END IF;
    SELECT count(*), min(signed_amount) INTO v_postings, v_capacity
      FROM financial_posting
     WHERE financial_operation_id = p_existing_financial_operation_id
       AND financial_account_id = p_financial_account_id;
    IF v_postings = 0 THEN
      RAISE EXCEPTION 'OPERATION_ACCOUNT_POSTING_NOT_FOUND';
    END IF;
    IF v_postings > 1 THEN
      RAISE EXCEPTION 'OPERATION_ACCOUNT_POSTING_AMBIGUOUS';
    END IF;
    IF EXISTS (SELECT 1 FROM mp_reconciliation
                WHERE mp_financial_movement_id = p_movement_id
                  AND financial_operation_id = p_existing_financial_operation_id) THEN
      RAISE EXCEPTION 'DUPLICATE_LINK';
    END IF;
    SELECT COALESCE(SUM(assigned_amount), 0) INTO v_linked
      FROM mp_reconciliation
     WHERE financial_operation_id = p_existing_financial_operation_id
       AND financial_account_id = p_financial_account_id;
    IF abs(v_linked + p_assigned_amount) > abs(v_capacity) THEN
      RAISE EXCEPTION 'OPERATION_OVER_ASSIGNMENT: linking % exceeds posting capacity % (already linked %)',
        p_assigned_amount, v_capacity, v_linked;
    END IF;
    v_op_id := p_existing_financial_operation_id;
  ELSE
    BEGIN
      INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                       source_entity_type, source_entity_id, reason, created_by)
      VALUES (p_operation_type, v_mv.occurred_date, 'MP:' || p_idempotency_key,
              'mp_financial_movement', p_movement_id::TEXT, p_reason, v_uid)
      RETURNING id INTO v_op_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'DUPLICATE_RECONCILIATION';
    END;

    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount,
                                   effective_date, created_by)
    VALUES (v_op_id, p_financial_account_id, p_assigned_amount, v_mv.occurred_date, v_uid);
  END IF;

  BEGIN
    INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id,
                                   assigned_amount, idempotency_key, reconciled_by)
    VALUES (p_movement_id, v_op_id, p_financial_account_id, p_assigned_amount, p_idempotency_key, v_uid)
    RETURNING id INTO v_recon_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'mp_reconciliation_idempotency_key_key' THEN
      RAISE EXCEPTION 'DUPLICATE_RECONCILIATION';
    END IF;
    RAISE EXCEPTION 'DUPLICATE_LINK';
  END;

  -- RECONCILED iff every movement of the source is fully assigned (signed)
  SELECT processing_status INTO v_src_status FROM mp_source_record WHERE id = v_mv.mp_source_record_id FOR UPDATE;
  v_new_status := (CASE WHEN NOT EXISTS (
                          SELECT 1 FROM mp_financial_movement m
                           WHERE m.mp_source_record_id = v_mv.mp_source_record_id
                             AND m.net_amount <> COALESCE((SELECT SUM(r.assigned_amount) FROM mp_reconciliation r
                                                            WHERE r.mp_financial_movement_id = m.id), 0))
                       THEN 'RECONCILED' ELSE 'NORMALIZED' END)::mp_processing_status;
  IF v_new_status IS DISTINCT FROM v_src_status THEN
    UPDATE mp_source_record SET processing_status = v_new_status, processed_at = NOW()
     WHERE id = v_mv.mp_source_record_id;
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_reconciliation', v_recon_id::TEXT, 'RECONCILE',
          jsonb_build_object('movement_id', p_movement_id, 'assigned_amount', p_assigned_amount,
                             'financial_operation_id', v_op_id, 'financial_account_id', p_financial_account_id,
                             'mode', v_mode, 'source_status', v_new_status),
          p_reason, v_uid);

  RETURN jsonb_build_object('reconciliation_id', v_recon_id, 'financial_operation_id', v_op_id,
                            'remaining_unassigned', v_mv.net_amount - (v_already + p_assigned_amount));
END;
$$;

-- ── ownership and EXECUTE perimeter ────────────────────────────────────────
ALTER  FUNCTION mp_normalize_source(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_normalize_source(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mp_normalize_source(UUID) TO service_role;

ALTER  FUNCTION mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT) TO authenticated, service_role;
