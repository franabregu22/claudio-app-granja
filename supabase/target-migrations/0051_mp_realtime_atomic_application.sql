-- ============================================================================
-- TARGET V1 — 0051 MERCADO PAGO ATOMIC FINANCIAL APPLICATION (ADR-006, Step 7 ONLY)
-- Authority: ADR-006 (ACCEPTED) §5.1; V-4 direction correction (c0e19dc);
--            ADR006_V2_PAYMENT_FIELD_EVIDENCE.md §15 (1f51e8a: refunds fail closed);
--            ADR006_RPC_CONTRACTS_V1 A1, §41 amendment, R2 (+ internal helper);
--            ADR006_IMPLEMENTATION_ORDER_V1 step 7.
--
-- Contents:
--   * A1 mp_apply_transition — the only automatic treasury writer (service role).
--   * RPC 41 mp_reconcile_movement — 0042 body plus the AUTO_APPLICATION_PENDING guard.
--   * R2 mp_normalize_report_fallback (ADMIN) + internal helper
--     mp_claim_report_payment_fallback (SECURITY INVOKER, owner-only).
--
-- Step-7 scope of A1: the evidenced auto-applicable pairs payment/APPROVAL and yield/YIELD.
-- refund/REFUND, chargeback/CHARGEBACK and account_tax/ACCOUNT_TAX stay auto-applicable in
-- mp_is_auto_applicable (unchanged) but A1 refuses them with TRANSITION_KIND_NOT_SUPPORTED:
-- no such movement can exist yet (api_refund / refund discovery disabled, V-2 §15.1;
-- chargeback / account-tax report rows unobserved, V-3), and the OD-1 unwinding ships with
-- the amendment that evidences them. transfer/PAYOUT and OUTBOUND_PAYMENT are never applied.
--
-- mp_v4_verified() stays false: R2 is gated by it (V4_NOT_VERIFIED) until step 19.
-- NOT here: worker (8), RLS (9), views (10), scheduler, Account Money parser (16), V-4 enablement (19).
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- A1 mp_apply_transition (service role)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mp_apply_transition(
  p_movement_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mv        mp_financial_movement;
  v_t         mp_transition_identity;
  v_src       mp_source_record;
  v_acct      UUID;
  v_plan      JSONB := '[]'::jsonb;
  v_c         JSONB;
  v_sum       NUMERIC(15,2);
  v_e_count   INTEGER;
  v_equiv     INTEGER;
  v_op_id     BIGINT;
  v_ops       JSONB := '[]'::jsonb;
  v_status    mp_processing_status;
  v_settle    NUMERIC(15,2);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;

  -- 1. L3
  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOVEMENT_NOT_FOUND';
  END IF;

  -- 2. auto-applicable (the same helper RPC 41 uses)
  IF NOT mp_is_auto_applicable(p_movement_id) THEN
    RAISE EXCEPTION 'NOT_AUTO_APPLICABLE';
  END IF;
  SELECT * INTO v_t FROM mp_transition_identity WHERE mp_financial_movement_id = p_movement_id;
  IF (v_mv.movement_kind, v_t.transition) NOT IN (('payment', 'APPROVAL'), ('yield', 'YIELD')) THEN
    RAISE EXCEPTION 'TRANSITION_KIND_NOT_SUPPORTED: %/% application is deferred (refunds / chargebacks / account taxes, V-2 §15.1, V-3)',
      v_mv.movement_kind, v_t.transition;
  END IF;

  -- 3. L4
  SELECT * INTO v_src FROM mp_source_record WHERE id = v_mv.mp_source_record_id FOR UPDATE;
  IF v_src.processing_status IN ('ERROR', 'IGNORED') THEN
    RAISE EXCEPTION 'SOURCE_NOT_APPLICABLE: source is %', v_src.processing_status;
  END IF;

  -- 4. the MP account (0008 seed), resolved here, never passed in
  SELECT id INTO v_acct FROM financial_account
   WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_acct IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  -- movement invariants
  IF v_mv.movement_kind = 'payment' THEN
    IF NOT (v_mv.gross_amount > 0 AND v_mv.fee_amount <= 0 AND v_mv.tax_amount <= 0 AND v_mv.net_amount > 0
            AND v_mv.gross_amount + v_mv.fee_amount + v_mv.tax_amount = v_mv.net_amount) THEN
      RAISE EXCEPTION 'MOVEMENT_INVALID: payment requires gross > 0, fee <= 0, tax <= 0, net > 0 and gross + fee + tax = net';
    END IF;
    v_settle := v_mv.gross_amount;
  ELSE  -- yield: the whole effect is carried in net
    IF NOT (v_mv.net_amount > 0 AND v_mv.fee_amount <= 0 AND v_mv.tax_amount <= 0) THEN
      RAISE EXCEPTION 'MOVEMENT_INVALID: yield requires net > 0, fee <= 0 and tax <= 0';
    END IF;
    v_settle := v_mv.net_amount;
  END IF;

  -- 5. the plan P: non-zero components only
  IF v_settle <> 0 THEN
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('k', format('MPA:%s:SETTLE', v_t.id), 'type', 'MP_SETTLEMENT', 'amount', v_settle));
  END IF;
  IF v_mv.fee_amount <> 0 THEN
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('k', format('MPA:%s:FEE', v_t.id), 'type', 'FEE', 'amount', v_mv.fee_amount));
  END IF;
  IF v_mv.tax_amount <> 0 THEN
    v_plan := v_plan || jsonb_build_array(jsonb_build_object('k', format('MPA:%s:TAX', v_t.id), 'type', 'ADJUSTMENT', 'amount', v_mv.tax_amount));
  END IF;

  -- 6. Σ(P) = net exactly
  SELECT coalesce(sum((c->>'amount')::NUMERIC), 0) INTO v_sum FROM jsonb_array_elements(v_plan) c;
  IF v_sum <> v_mv.net_amount THEN
    RAISE EXCEPTION 'APPLICATION_NET_MISMATCH: plan % <> net %', v_sum, v_mv.net_amount;
  END IF;

  -- 7. existing-row equivalence
  SELECT count(*) INTO v_e_count FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id;
  IF v_e_count > 0 THEN
    SELECT count(*) INTO v_equiv
      FROM jsonb_array_elements(v_plan) c
      JOIN mp_reconciliation r ON r.mp_financial_movement_id = p_movement_id
                              AND r.idempotency_key = c->>'k'
                              AND r.assigned_amount = (c->>'amount')::NUMERIC
                              AND r.financial_account_id = v_acct
      JOIN financial_operation o ON o.id = r.financial_operation_id
                                AND o.operation_type = (c->>'type')::financial_operation_type
                                AND o.external_ref = 'MP:' || (c->>'k')
                                AND o.effective_date = v_mv.occurred_date
                                AND o.source_entity_type = 'mp_financial_movement'
                                AND o.source_entity_id = p_movement_id::TEXT
     WHERE (SELECT count(*) FROM financial_posting p WHERE p.financial_operation_id = o.id) = 1
       AND EXISTS (SELECT 1 FROM financial_posting p
                    WHERE p.financial_operation_id = o.id AND p.financial_account_id = v_acct
                      AND p.signed_amount = (c->>'amount')::NUMERIC);
    IF v_e_count = jsonb_array_length(v_plan) AND v_equiv = jsonb_array_length(v_plan) THEN
      RETURN jsonb_build_object('status', 'ALREADY_APPLIED', 'movement_id', p_movement_id, 'transition_id', v_t.id,
                                'source_status', v_src.processing_status);
    END IF;
    RAISE EXCEPTION 'TRANSITION_ALREADY_ASSIGNED: movement % has reconciliations that differ from the application plan', p_movement_id;
  END IF;
  IF EXISTS (SELECT 1 FROM financial_operation o JOIN jsonb_array_elements(v_plan) c ON o.external_ref = 'MP:' || (c->>'k')) THEN
    RAISE EXCEPTION 'EXTERNAL_REF_CONFLICT: an MPA operation exists without its reconciliation (movement %)', p_movement_id;
  END IF;

  -- 9. L6 period guard
  PERFORM assert_period_open(v_mv.occurred_date);

  -- 10. write every component (one transaction: any failure rolls everything back)
  FOR v_c IN SELECT c FROM jsonb_array_elements(v_plan) c LOOP
    BEGIN
      INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                       source_entity_type, source_entity_id, reason, created_by)
      VALUES ((v_c->>'type')::financial_operation_type, v_mv.occurred_date, 'MP:' || (v_c->>'k'),
              'mp_financial_movement', p_movement_id::TEXT, 'ADR-006 auto-apply', NULL)
      RETURNING id INTO v_op_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'EXTERNAL_REF_CONFLICT: % already exists', 'MP:' || (v_c->>'k');
    END;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op_id, v_acct, (v_c->>'amount')::NUMERIC, v_mv.occurred_date, NULL);
    INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id,
                                   assigned_amount, idempotency_key, reconciled_by)
    VALUES (p_movement_id, v_op_id, v_acct, (v_c->>'amount')::NUMERIC, v_c->>'k', NULL);
    v_ops := v_ops || jsonb_build_array(jsonb_build_object('key', v_c->>'k', 'type', v_c->>'type',
                                                           'amount', (v_c->>'amount')::NUMERIC, 'operation_id', v_op_id));
  END LOOP;

  -- 11. source status: the ADR-003 D4 equivalence (the same expression as 0042)
  v_status := (CASE WHEN NOT EXISTS (
                      SELECT 1 FROM mp_financial_movement m
                       WHERE m.mp_source_record_id = v_mv.mp_source_record_id
                         AND m.net_amount <> COALESCE((SELECT SUM(r.assigned_amount) FROM mp_reconciliation r
                                                        WHERE r.mp_financial_movement_id = m.id), 0))
                   THEN 'RECONCILED' ELSE 'NORMALIZED' END)::mp_processing_status;
  IF v_status IS DISTINCT FROM v_src.processing_status THEN
    UPDATE mp_source_record SET processing_status = v_status, processed_at = NOW() WHERE id = v_mv.mp_source_record_id;
  END IF;

  -- 13. audit
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_financial_movement', p_movement_id::TEXT, 'MP_APPLY_TRANSITION',
          jsonb_build_object('transition_id', v_t.id, 'components', v_ops, 'source_status', v_status, 'client_restored', 0),
          'ADR-006 auto-apply', NULL);

  RETURN jsonb_build_object('status', 'APPLIED', 'movement_id', p_movement_id, 'transition_id', v_t.id,
                            'operations', v_ops, 'source_status', v_status, 'client_restored', 0);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- RPC 41 mp_reconcile_movement — 0042 body + the AUTO_APPLICATION_PENDING guard
-- ════════════════════════════════════════════════════════════════════════════
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

  -- ADR-006 §41 guard: an auto-applicable transition awaiting A1 cannot be consumed manually
  IF mp_is_auto_applicable(p_movement_id)
     AND NOT EXISTS (SELECT 1 FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id) THEN
    RAISE EXCEPTION 'AUTO_APPLICATION_PENDING: movement % awaits mp_apply_transition', p_movement_id;
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

-- ════════════════════════════════════════════════════════════════════════════
-- Internal helper: mp_claim_report_payment_fallback (SECURITY INVOKER, owner-only)
-- Called only by mp_normalize_report_fallback; RPC 40 never calls it.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mp_claim_report_payment_fallback(
  p_source_id UUID,
  p_actor     UUID,
  p_reason    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_src      mp_source_record;
  v_p        RECORD;
  v_pid      TEXT;
  v_tid      BIGINT;
  v_mv_id    BIGINT;
  v_claimed  mp_financial_movement;
  v_note     TEXT;
BEGIN
  SELECT * INTO v_src FROM mp_source_record WHERE id = p_source_id;
  SELECT * INTO v_p FROM mp_parse_report_row(v_src);
  IF v_p.o_status IS DISTINCT FROM 'NORMALIZED' OR v_p.o_kind IS DISTINCT FROM 'payment' THEN
    -- refused with the parser's code; the source is NOT moved to ERROR
    RAISE EXCEPTION 'FALLBACK_REFUSED: %', coalesce(v_p.o_note, 'not a valid payment row');
  END IF;
  v_pid := v_src.event_data->>'SOURCE_ID';
  IF v_pid IS NULL OR v_pid !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;

  SELECT id INTO v_tid FROM mp_transition_identity
   WHERE resource_type = 'payment' AND resource_id = v_pid AND transition = 'APPROVAL' AND transition_ref = '';

  IF v_tid IS NULL THEN
    BEGIN
      INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount,
                                         fee_amount, tax_amount, net_amount, occurred_date)
      VALUES (p_source_id, 'payment', v_p.o_gross, v_p.o_fee, v_p.o_tax, v_p.o_net, v_src.occurred_date)
      RETURNING id INTO v_mv_id;
      INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref,
                                          claimed_by_source_id, mp_financial_movement_id)
      VALUES ('payment', v_pid, 'APPROVAL', '', p_source_id, v_mv_id)
      RETURNING id INTO v_tid;
    EXCEPTION WHEN unique_violation THEN
      v_mv_id := NULL;
      SELECT id INTO v_tid FROM mp_transition_identity
       WHERE resource_type = 'payment' AND resource_id = v_pid AND transition = 'APPROVAL' AND transition_ref = '';
    END;
  END IF;

  IF v_mv_id IS NOT NULL THEN
    UPDATE mp_source_record SET processing_status = 'NORMALIZED', processed_at = NOW(), processing_note = 'REPORT_FALLBACK'
     WHERE id = p_source_id;
    INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
    VALUES ('REPORT_ONLY', p_source_id, v_tid, jsonb_build_object('fallback', true), false);
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_source_record', p_source_id::TEXT, 'MP_REPORT_FALLBACK',
            jsonb_build_object('movement_id', v_mv_id, 'transition_id', v_tid, 'payment_id', v_pid),
            p_reason, p_actor);
    RETURN jsonb_build_object('status', 'CREATED', 'movement_id', v_mv_id, 'transition_id', v_tid);
  END IF;

  -- identity already claimed (an API snapshot arrived meanwhile): §40.4 — IGNORED + MATCHED / DISCREPANCY
  SELECT m.* INTO v_claimed FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
   WHERE t.id = v_tid;
  v_note := format('MATCHED_TO_TRANSITION %s', v_tid);
  UPDATE mp_source_record SET processing_status = 'IGNORED', processed_at = NOW(), processing_note = v_note
   WHERE id = p_source_id;
  INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
  SELECT CASE WHEN d = '{}'::jsonb THEN 'MATCHED'::mp_match_outcome ELSE 'DISCREPANCY'::mp_match_outcome END,
         p_source_id, v_tid, d, d <> '{}'::jsonb
    FROM (SELECT coalesce(jsonb_object_agg(f, jsonb_build_object('report', r, 'recorded', c)) FILTER (WHERE r IS DISTINCT FROM c), '{}'::jsonb) AS d
            FROM (VALUES ('gross', v_p.o_gross::TEXT, v_claimed.gross_amount::TEXT),
                         ('fee',   v_p.o_fee::TEXT,   v_claimed.fee_amount::TEXT),
                         ('tax',   v_p.o_tax::TEXT,   v_claimed.tax_amount::TEXT),
                         ('net',   v_p.o_net::TEXT,   v_claimed.net_amount::TEXT),
                         ('occurred_date', v_src.occurred_date::TEXT, v_claimed.occurred_date::TEXT)) x(f, r, c)) y
  ON CONFLICT (report_source_id, outcome) DO NOTHING;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_source_record', p_source_id::TEXT, 'MP_REPORT_FALLBACK',
          jsonb_build_object('status', 'ALREADY_CLAIMED', 'transition_id', v_tid, 'payment_id', v_pid), p_reason, p_actor);
  RETURN jsonb_build_object('status', 'ALREADY_CLAIMED', 'transition_id', v_tid);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- R2 mp_normalize_report_fallback (ADMIN)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mp_normalize_report_fallback(
  p_source_record_id UUID,
  p_reason           TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src  mp_source_record;
  v_p    RECORD;
  v_d    mp_webhook_delivery;
BEGIN
  -- 1. ADMIN
  IF auth.role() IS NOT DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  -- 2. V-4 gate (false until step 19)
  IF NOT mp_v4_verified() THEN
    RAISE EXCEPTION 'V4_NOT_VERIFIED';
  END IF;
  -- 3. reason
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  -- 4. L2: a report row parked DEFERRED_BACKFILL
  SELECT * INTO v_src FROM mp_source_record WHERE id = p_source_record_id FOR UPDATE;
  IF NOT FOUND OR v_src.source_type NOT IN ('csv_import', 'account_money_csv')
     OR v_src.processing_status <> 'PENDING' OR coalesce(v_src.processing_note, '') NOT LIKE 'DEFERRED_BACKFILL:%' THEN
    RAISE EXCEPTION 'NOT_DEFERRED';
  END IF;
  -- 5. its back-fill is exhausted
  SELECT * INTO v_d FROM mp_webhook_delivery
   WHERE report_source_id = p_source_record_id AND origin = 'report_backfill'
   ORDER BY received_at DESC LIMIT 1;
  IF NOT FOUND OR v_d.status <> 'FAILED_PERMANENT' THEN
    RAISE EXCEPTION 'BACKFILL_NOT_EXHAUSTED';
  END IF;
  -- 6. inbound candidate only (direction C / net > 0)
  SELECT * INTO v_p FROM mp_parse_report_row(v_src);
  IF v_p.o_net IS NULL OR v_p.o_net <= 0 THEN
    RAISE EXCEPTION 'OUTBOUND_NOT_ELIGIBLE';
  END IF;
  -- 7. the API did not contradict the direction
  IF v_d.last_error_code IS NOT DISTINCT FROM 'COLLECTOR_MISMATCH' THEN
    RAISE EXCEPTION 'DIRECTION_CONFLICT';
  END IF;

  RETURN mp_claim_report_payment_fallback(p_source_record_id, auth.uid(), p_reason);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- Ownership and grants (ADR006_RLS_AND_SECURITY_V1 §3): exact
-- ════════════════════════════════════════════════════════════════════════════
ALTER FUNCTION mp_apply_transition(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_apply_transition(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mp_apply_transition(BIGINT) TO service_role;

ALTER  FUNCTION mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION mp_reconcile_movement(BIGINT, NUMERIC, VARCHAR, UUID, financial_operation_type, BIGINT, TEXT) TO authenticated, service_role;

ALTER FUNCTION mp_claim_report_payment_fallback(UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_claim_report_payment_fallback(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION mp_normalize_report_fallback(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_normalize_report_fallback(UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION mp_normalize_report_fallback(UUID, TEXT) TO authenticated;
