-- ============================================================================
-- TARGET V1 — 0050 MERCADO PAGO API PAYMENT NORMALIZATION (ADR-006, Step 6 ONLY)
-- Authority: ADR-006 (ACCEPTED) + V-4 direction correction (c0e19dc);
--            ADR006_V2_PAYMENT_FIELD_EVIDENCE.md §15 FINAL GATE (1f51e8a);
--            ADR006_RPC_CONTRACTS_V1 S4, §40.1, §40.2 (as amended by the V-2 gate);
--            ADR006_IMPLEMENTATION_ORDER_V1 step 6.
--
-- Contents:
--   * S4 mp_ingest_api_snapshot — immutable, versioned api_payment snapshots.
--   * RPC 40 mp_normalize_source redefinition — adds the api_payment branch; the
--     csv_import / account_money_csv / other branches are byte-for-byte the 0048 logic.
--
-- NOT here (later steps, own migrations): mp_apply_transition (A1) and the RPC 41
-- AUTO_APPLICATION_PENDING guard (step 7), mp_normalize_report_fallback (R2),
-- report payment matching / mp_v4_verified() enablement (step 19), the Account Money
-- parser (step 16), RLS narrowing (step 9), views (step 10).
--
-- api_payment reads ONLY the V-2 §15 fields: id, currency_id, live_mode, collector_id
-- (presence), operation_type, status, status_detail, transaction_amount,
-- transaction_details.net_received_amount, fee_details[].amount / fee_payer,
-- date_approved, date_created, and refunds[] / transaction_amount_refunded for refund
-- DETECTION only. taxes_amount and charges_details are never read.
-- Refunds are fail-closed (REFUND_UNSUPPORTED); api_refund stays UNSUPPORTED_SOURCE_TYPE
-- (refund discovery disabled, V-2 §15.1). No treasury posting is written here.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- S4 mp_ingest_api_snapshot (service role)
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mp_ingest_api_snapshot(
  p_delivery_id  UUID,
  p_claim_token  UUID,
  p_payment_id   VARCHAR,
  p_payload      JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_d        mp_webhook_delivery;
  v_at_txt   TEXT;
  v_at       TIMESTAMPTZ;
  v_ext      VARCHAR(100);
  v_id       UUID;
  v_created  BOOLEAN := false;
  v_status   mp_processing_status;
  c_ts       CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  -- argument validation, before any write
  IF p_payment_id IS NULL OR p_payment_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'PAYLOAD_INVALID: payload must be a JSON object';
  END IF;
  IF (p_payload->>'id') IS DISTINCT FROM p_payment_id THEN
    RAISE EXCEPTION 'PAYLOAD_ID_MISMATCH';
  END IF;

  -- the claim is valid (as S3)
  SELECT * INTO v_d FROM mp_webhook_delivery WHERE id = p_delivery_id FOR UPDATE;   -- L1
  IF NOT FOUND OR v_d.status <> 'PROCESSING' OR v_d.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'CLAIM_LOST';
  END IF;
  IF v_d.topic_class <> 'payment' THEN
    RAISE EXCEPTION 'NOT_A_PAYMENT_DELIVERY';
  END IF;
  IF v_d.resource_id IS DISTINCT FROM p_payment_id THEN
    RAISE EXCEPTION 'PAYLOAD_ID_MISMATCH';
  END IF;

  -- occurred_at: date_approved when present, otherwise date_created (V-2 §8 / §15)
  v_at_txt := coalesce(nullif(p_payload->>'date_approved', ''), p_payload->>'date_created');
  IF v_at_txt IS NULL OR v_at_txt !~ c_ts THEN
    RAISE EXCEPTION 'PAYLOAD_DATE_INVALID';
  END IF;
  BEGIN
    v_at := v_at_txt::TIMESTAMPTZ;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'PAYLOAD_DATE_INVALID';
  END;

  -- identity computed in the database: canonical jsonb text → version hash
  v_ext := 'MPPAY:' || p_payment_id || ':' || left(encode(sha256(convert_to(p_payload::TEXT, 'UTF8')), 'hex'), 32);

  INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('api_payment', v_ext, p_payload, v_at, (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE)
  ON CONFLICT (source_type, external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    v_created := true;
    -- source id and payment id only; never the payload
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_source_record', v_id::TEXT, 'MP_SNAPSHOT_INGEST',
            jsonb_build_object('source_type', 'api_payment', 'payment_id', p_payment_id), NULL, NULL);
  ELSE
    SELECT id INTO v_id FROM mp_source_record WHERE source_type = 'api_payment' AND external_id = v_ext;
  END IF;

  SELECT processing_status INTO v_status FROM mp_source_record WHERE id = v_id;
  RETURN jsonb_build_object('source_record_id', v_id, 'created', v_created, 'processing_status', v_status);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- RPC 40 mp_normalize_source — adds the api_payment branch (§40.2 as amended by V-2 §15)
-- ════════════════════════════════════════════════════════════════════════════
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
  v_p        RECORD;
  v_kind     TEXT;
  v_gross    NUMERIC(15,2);
  v_fee      NUMERIC(15,2);
  v_tax      NUMERIC(15,2);
  v_net      NUMERIC(15,2);
  v_status   mp_processing_status;
  v_note     TEXT;
  v_count    INTEGER := 0;
  v_trans    TEXT;
  v_tid      BIGINT;
  v_mv_id    BIGINT;
  v_claimed  mp_financial_movement;
  c_v4_note  CONSTANT TEXT := 'DEFERRED_V4: payment/API equivalence unverified';
  -- api_payment
  v_ev       JSONB;
  v_pid      TEXT;
  v_st       TEXT;
  v_sd       TEXT;
  v_at_txt   TEXT;
  v_at       TIMESTAMPTZ;
  v_fd       JSONB;
  v_bad      BOOLEAN;
  c_amount   CONSTANT TEXT := '^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
  c_ts       CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;

  SELECT * INTO v_src FROM mp_source_record WHERE id = p_source_record_id FOR UPDATE;   -- L2
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_NOT_FOUND';
  END IF;
  IF v_src.processing_status <> 'PENDING' THEN
    RAISE EXCEPTION 'ALREADY_PROCESSED: status is %', v_src.processing_status;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- api_payment (Step 6). The first failing check decides; ERROR = REVIEW_REQUIRED.
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_src.source_type = 'api_payment' THEN
    v_ev := v_src.event_data;
    <<api>>
    BEGIN
      -- 1. identity: numeric-shaped id, and external_id equal to the S4 derivation
      v_pid := CASE WHEN jsonb_typeof(v_ev) = 'object' AND jsonb_typeof(v_ev->'id') IN ('number', 'string')
                    THEN v_ev->>'id' END;
      IF v_pid IS NULL OR v_pid !~ '^[0-9]{1,20}$'
         OR v_src.external_id IS DISTINCT FROM
            ('MPPAY:' || v_pid || ':' || left(encode(sha256(convert_to(v_ev::TEXT, 'UTF8')), 'hex'), 32)) THEN
        v_status := 'ERROR'; v_note := 'IDENTITY_MISMATCH: event_data id / external_id do not match the S4 derivation';
        EXIT api;
      END IF;
      -- 2. currency
      IF (v_ev->>'currency_id') IS DISTINCT FROM 'ARS' THEN
        v_status := 'ERROR'; v_note := 'UNSUPPORTED_CURRENCY'; EXIT api;
      END IF;
      -- 3. collector present (equality with the account is enforced by the worker)
      IF coalesce(jsonb_typeof(v_ev->'collector_id'), 'null') NOT IN ('number', 'string') OR coalesce(v_ev->>'collector_id', '') = '' THEN
        v_status := 'ERROR'; v_note := 'MISSING_COLLECTOR'; EXIT api;
      END IF;
      -- 4. live mode
      IF (v_ev->'live_mode') IS DISTINCT FROM 'true'::JSONB THEN
        v_status := 'ERROR'; v_note := 'NOT_LIVE_MODE'; EXIT api;
      END IF;
      -- 5. operation_type: the V-2 inbound set only
      IF (v_ev->>'operation_type') IS NULL OR (v_ev->>'operation_type') NOT IN ('money_transfer', 'account_fund') THEN
        v_status := 'ERROR'; v_note := format('UNKNOWN_OPERATION_TYPE: %s', coalesce(v_ev->>'operation_type', '(null)')); EXIT api;
      END IF;
      -- 6. status: documented values only
      v_st := v_ev->>'status';
      v_sd := v_ev->>'status_detail';
      IF v_st IS NULL OR v_st NOT IN ('pending', 'approved', 'authorized', 'in_process', 'in_mediation',
                                      'rejected', 'cancelled', 'refunded', 'charged_back') THEN
        v_status := 'ERROR'; v_note := format('UNKNOWN_STATUS: %s', coalesce(v_st, '(null)')); EXIT api;
      END IF;
      -- 6b. refund evidence → fail closed (V-2 §15.1); no claim, no movement, no children
      IF (v_ev ? 'refunds' AND v_ev->'refunds' <> '[]'::JSONB AND v_ev->'refunds' <> 'null'::JSONB)
         OR (v_ev ? 'transaction_amount_refunded'
             AND NOT (CASE WHEN jsonb_typeof(v_ev->'transaction_amount_refunded') = 'number'
                           THEN (v_ev->>'transaction_amount_refunded')::NUMERIC = 0 ELSE false END))
         OR v_st = 'refunded'
         OR v_sd IN ('partially_refunded', 'refunded', 'bpp_refunded', 'partially_bpp_refunded') THEN
        v_status := 'ERROR'; v_note := 'REFUND_UNSUPPORTED: refund evidence in the snapshot (refunds fail closed, V-2 §15.1)'; EXIT api;
      END IF;

      -- 7. amounts, only for an approved + accredited snapshot
      IF v_st = 'approved' AND v_sd IS NOT DISTINCT FROM 'accredited' THEN
        IF jsonb_typeof(v_ev->'transaction_amount') IS DISTINCT FROM 'number' OR (v_ev->>'transaction_amount') !~ c_amount
           OR jsonb_typeof(v_ev->'transaction_details'->'net_received_amount') IS DISTINCT FROM 'number'
           OR (v_ev->'transaction_details'->>'net_received_amount') !~ c_amount THEN
          v_status := 'ERROR'; v_note := 'MALFORMED_AMOUNT'; EXIT api;
        END IF;
        v_fd := v_ev->'fee_details';
        IF v_fd IS NULL OR jsonb_typeof(v_fd) <> 'array' THEN
          v_status := 'ERROR'; v_note := 'MALFORMED_FEE_DETAILS: fee_details must be an array'; EXIT api;
        END IF;
        SELECT bool_or(jsonb_typeof(e) IS DISTINCT FROM 'object'
                       OR (e->>'fee_payer') IS NULL OR (e->>'fee_payer') NOT IN ('collector', 'payer')
                       OR jsonb_typeof(e->'amount') IS DISTINCT FROM 'number' OR (e->>'amount') !~ c_amount)
          INTO v_bad FROM jsonb_array_elements(v_fd) e;
        IF coalesce(v_bad, false) THEN
          v_status := 'ERROR'; v_note := 'MALFORMED_FEE_DETAILS'; EXIT api;
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_fd) e WHERE (e->>'amount')::NUMERIC < 0) THEN
          v_status := 'ERROR'; v_note := 'SIGN_INVALID: negative fee_details amount'; EXIT api;
        END IF;
        v_gross := (v_ev->>'transaction_amount')::NUMERIC;
        v_net := (v_ev->'transaction_details'->>'net_received_amount')::NUMERIC;
        -- collector-paid fees only; payer-paid fees are not Santo Tomás money
        SELECT -coalesce(sum((e->>'amount')::NUMERIC), 0) INTO v_fee
          FROM jsonb_array_elements(v_fd) e WHERE e->>'fee_payer' = 'collector';
        IF v_gross <= 0 THEN
          v_status := 'ERROR'; v_note := 'SIGN_INVALID: gross must be > 0'; EXIT api;
        END IF;
        IF v_net <= 0 THEN
          v_status := 'ERROR'; v_note := 'SIGN_INVALID: net must be > 0'; EXIT api;
        END IF;
        -- tax = the documented residual (never taxes_amount / charges_details)
        v_tax := v_net - v_gross - v_fee;
        IF v_tax > 0 THEN
          v_status := 'ERROR'; v_note := 'SIGN_INVALID: residual tax > 0 (net exceeds gross + fee)'; EXIT api;
        END IF;
        IF v_gross + v_fee + v_tax <> v_net THEN
          v_status := 'ERROR'; v_note := 'ARITHMETIC_MISMATCH'; EXIT api;
        END IF;
      END IF;

      -- 8. dates equal the S4 derivation
      v_at_txt := coalesce(nullif(v_ev->>'date_approved', ''), v_ev->>'date_created');
      IF v_at_txt IS NULL OR v_at_txt !~ c_ts THEN
        v_status := 'ERROR'; v_note := 'DATE_MISMATCH: no valid date_approved / date_created'; EXIT api;
      END IF;
      v_at := v_at_txt::TIMESTAMPTZ;
      IF v_src.occurred_at IS DISTINCT FROM v_at
         OR v_src.occurred_date IS DISTINCT FROM (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE THEN
        v_status := 'ERROR'; v_note := 'DATE_MISMATCH'; EXIT api;
      END IF;

      -- classification
      IF v_st IN ('pending', 'in_process', 'authorized', 'rejected', 'cancelled') THEN
        v_status := 'IGNORED'; v_note := format('NO_FINANCIAL_TRANSITION: status %s', v_st); EXIT api;
      END IF;

      SELECT id INTO v_tid FROM mp_transition_identity
       WHERE resource_type = 'payment' AND resource_id = v_pid AND transition = 'APPROVAL' AND transition_ref = '';

      IF v_st IN ('charged_back', 'in_mediation') OR v_sd IN ('bpp_covered', 'partially_bpp_covered') THEN
        -- no movement from the API; an existing APPROVAL is preserved untouched (alert R-7)
        IF v_tid IS NOT NULL THEN
          v_status := 'IGNORED'; v_note := format('NO_NEW_TRANSITION: dispute status %s/%s', v_st, coalesce(v_sd, '-'));
        ELSE
          v_status := 'ERROR'; v_note := format('DISPUTE_WITHOUT_APPROVAL: status %s/%s', v_st, coalesce(v_sd, '-'));
        END IF;
        EXIT api;
      END IF;

      IF NOT (v_st = 'approved' AND v_sd IS NOT DISTINCT FROM 'accredited') THEN
        v_status := 'ERROR'; v_note := format('UNKNOWN_STATUS: %s/%s', v_st, coalesce(v_sd, '(null)')); EXIT api;
      END IF;

      -- §40.1 claim ('payment', id, 'APPROVAL', '')
      IF v_tid IS NOT NULL THEN
        v_status := 'IGNORED'; v_note := 'NO_NEW_TRANSITION'; EXIT api;
      END IF;
      BEGIN
        INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount,
                                           fee_amount, tax_amount, net_amount, occurred_date)
        VALUES (p_source_record_id, 'payment', v_gross, v_fee, v_tax, v_net, v_src.occurred_date)
        RETURNING id INTO v_mv_id;
        INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref,
                                            claimed_by_source_id, mp_financial_movement_id)
        VALUES ('payment', v_pid, 'APPROVAL', '', p_source_record_id, v_mv_id)
        RETURNING id INTO v_tid;
        v_count := 1;
        v_status := 'NORMALIZED'; v_note := NULL;
      EXCEPTION WHEN unique_violation THEN
        -- a concurrent claimer won: no movement from this version
        v_count := 0;
        SELECT id INTO v_tid FROM mp_transition_identity
         WHERE resource_type = 'payment' AND resource_id = v_pid AND transition = 'APPROVAL' AND transition_ref = '';
        v_status := 'IGNORED'; v_note := 'NO_NEW_TRANSITION';
      END;
    END api;

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
                              'movements_created', v_count, 'transition_id', v_tid, 'children_created', 0);
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- report rows and every other source type: unchanged 0048 logic
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_src.source_type = 'account_money_csv' THEN
    -- V-3 blocked: such rows are not ingested; defensive branch only.
    v_status := 'ERROR';
    v_note := 'UNSUPPORTED_CSV_FORMAT: the Account Money parser is not frozen (V-3)';
  ELSE
    SELECT * INTO v_p FROM mp_parse_report_row(v_src);
    v_status := v_p.o_status;
    v_note := v_p.o_note;
    v_kind := v_p.o_kind;
    v_gross := v_p.o_gross;
    v_fee := v_p.o_fee;
    v_tax := v_p.o_tax;
    v_net := v_p.o_net;
  END IF;

  IF v_status = 'NORMALIZED' AND v_kind = 'payment' THEN
    IF mp_v4_verified() THEN
      RAISE EXCEPTION 'V4_PATH_NOT_IMPLEMENTED: report payment matching ships with the V-4 enablement migration';
    END IF;
    -- parked: stays PENDING, no claim, no movement, no match; the note and audit are written once
    IF v_src.processing_note IS DISTINCT FROM c_v4_note THEN
      UPDATE mp_source_record SET processing_note = c_v4_note WHERE id = p_source_record_id;
      INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
      VALUES ('mp_source_record', p_source_record_id::TEXT, 'NORMALIZE',
              jsonb_build_object('processing_status', 'PENDING'),
              jsonb_build_object('processing_status', 'PENDING', 'movements', 0, 'processing_note', c_v4_note),
              c_v4_note, NULL);
    END IF;
    RETURN jsonb_build_object('source_record_id', p_source_record_id, 'processing_status', 'PENDING',
                              'movements_created', 0);
  END IF;

  IF v_status = 'NORMALIZED' THEN
    -- report-only kinds (ADR-006 §40.1): claim ('report', external_id, YIELD | PAYOUT, '')
    v_trans := CASE v_kind WHEN 'yield' THEN 'YIELD' WHEN 'transfer' THEN 'PAYOUT' END;
    SELECT id INTO v_tid FROM mp_transition_identity
     WHERE resource_type = 'report' AND resource_id = v_src.external_id AND transition = v_trans AND transition_ref = '';
    IF v_tid IS NULL THEN
      BEGIN
        INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount,
                                           fee_amount, tax_amount, net_amount, occurred_date)
        VALUES (p_source_record_id, v_kind, v_gross, v_fee, v_tax, v_net, v_src.occurred_date)
        RETURNING id INTO v_mv_id;
        INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref,
                                            claimed_by_source_id, mp_financial_movement_id)
        VALUES ('report', v_src.external_id, v_trans, '', p_source_record_id, v_mv_id)
        RETURNING id INTO v_tid;
        v_count := 1;
      EXCEPTION WHEN unique_violation THEN
        -- a concurrent claimer won: this source records no movement
        v_count := 0;
        SELECT id INTO v_tid FROM mp_transition_identity
         WHERE resource_type = 'report' AND resource_id = v_src.external_id AND transition = v_trans AND transition_ref = '';
      END;
    END IF;

    IF v_count = 1 THEN
      INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
      VALUES ('REPORT_ONLY', p_source_record_id, v_tid, '{}'::jsonb, false);
    ELSE
      -- §40.4: identity already claimed by another source → no movement, IGNORED + MATCHED / DISCREPANCY
      SELECT m.* INTO v_claimed FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
       WHERE t.id = v_tid;
      v_status := 'IGNORED';
      v_note := format('MATCHED_TO_TRANSITION %s', v_tid);
      INSERT INTO mp_report_match (outcome, report_source_id, transition_id, detail, is_exception)
      SELECT CASE WHEN d = '{}'::jsonb THEN 'MATCHED'::mp_match_outcome ELSE 'DISCREPANCY'::mp_match_outcome END,
             p_source_record_id, v_tid, d, d <> '{}'::jsonb
        FROM (SELECT coalesce(jsonb_object_agg(f, jsonb_build_object('report', r, 'recorded', c)) FILTER (WHERE r IS DISTINCT FROM c), '{}'::jsonb) AS d
                FROM (VALUES ('gross', v_gross::TEXT, v_claimed.gross_amount::TEXT),
                             ('fee',   v_fee::TEXT,   v_claimed.fee_amount::TEXT),
                             ('tax',   v_tax::TEXT,   v_claimed.tax_amount::TEXT),
                             ('net',   v_net::TEXT,   v_claimed.net_amount::TEXT),
                             ('occurred_date', v_src.occurred_date::TEXT, v_claimed.occurred_date::TEXT)) x(f, r, c)) y
      ON CONFLICT (report_source_id, outcome) DO NOTHING;
    END IF;
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

-- ════════════════════════════════════════════════════════════════════════════
-- Ownership and grants (ADR006_RLS_AND_SECURITY_V1 §3): exact, service role only
-- ════════════════════════════════════════════════════════════════════════════
ALTER FUNCTION mp_ingest_api_snapshot(UUID, UUID, VARCHAR, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_ingest_api_snapshot(UUID, UUID, VARCHAR, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mp_ingest_api_snapshot(UUID, UUID, VARCHAR, JSONB) TO service_role;

ALTER FUNCTION mp_normalize_source(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_normalize_source(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mp_normalize_source(UUID) TO service_role;
