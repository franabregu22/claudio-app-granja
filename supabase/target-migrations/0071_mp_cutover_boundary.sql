-- ============================================================================
-- TARGET V1 — 0071 MERCADO PAGO CUTOVER BOUNDARY (ADR-017, Phase 31 Step 1, G-7)
--
-- The target MP account starts from an owner-validated opening balance at the cutover
-- instant. That opening already contains every pre-cutover payment, so a notification /
-- retry / late report row for a pre-cutover economic event must never be financially
-- applied again in the target.
--
-- 1. mp_cutover_boundary — singleton authority: one exact `cutover_at` (timestamptz).
--    Written ONCE by the Phase 31 cutover procedure (`migrate-clean-cutover.mjs load
--    --mode cutover`, as the database owner). No API role (anon / authenticated /
--    service_role) has any privilege on it: it is never written by the application or
--    its UI, and nothing defaults it (no DEFAULT now(), no seed row).
-- 2. RPC 40 mp_normalize_source — the 0050 body, byte-for-byte, plus ONE guard before
--    any branch (marked [ADR-017]):
--      * no boundary row  → RAISE CUTOVER_BOUNDARY_MISSING (fail safe: the source stays
--        PENDING, no movement, no posting; the worker retries once the boundary is set);
--      * api_payment, status approved + accredited, a valid date_approved, no refund
--        evidence (refunds[] empty / absent and transaction_amount_refunded = 0), and
--        date_approved < cutover_at  → IGNORED with note
--        'PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE …', no movement;
--      * report rows (csv_import) with occurred_at < cutover_at → the same IGNORED
--        classification, no movement;
--      * everything else (refund / chargeback / dispute evidence, missing or malformed
--        date_approved, any timestamp >= cutover_at) → the unchanged 0050 logic, which
--        stays fail-closed (REFUND_UNSUPPORTED, DATE_MISMATCH, …).
--    The webhook delivery, the immutable API snapshot (S4) and the source record are
--    kept; the audit NORMALIZE row records the classification.
-- Boundary: timestamp < cutover_at → included in the opening (not reapplied);
--           timestamp >= cutover_at → normal target processing.
-- No new function, trigger or grant: the SECURITY DEFINER set is unchanged (69).
-- ============================================================================

CREATE TABLE mp_cutover_boundary (
  singleton     BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  cutover_at    TIMESTAMPTZ NOT NULL,
  import_batch  TEXT NOT NULL CHECK (btrim(import_batch) <> ''),
  evidence_ref  TEXT NOT NULL CHECK (btrim(evidence_ref) <> ''),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mp_cutover_boundary ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_cutover_boundary OWNER TO postgres;
REVOKE ALL ON mp_cutover_boundary FROM PUBLIC, anon, authenticated, service_role;

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
  v_at       TIMESTAMPTZ;
  v_appr     TIMESTAMPTZ;
  v_crt      TIMESTAMPTZ;
  v_fd       JSONB;
  v_bad      BOOLEAN;
  v_cut      TIMESTAMPTZ;   -- [ADR-017]
  v_tsg      TIMESTAMPTZ;   -- [ADR-017]
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
  -- [ADR-017] cutover boundary. Fail safe without it; pre-cutover payments / report
  -- rows are included in the opening balance and are never applied again.
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT cutover_at INTO v_cut FROM mp_cutover_boundary;
  IF v_cut IS NULL THEN
    RAISE EXCEPTION 'CUTOVER_BOUNDARY_MISSING: mp_cutover_boundary is not configured; no financial normalization before the cutover boundary is set';
  END IF;
  v_tsg := NULL;
  IF v_src.source_type = 'api_payment' THEN
    v_ev := v_src.event_data;
    -- only a payment that would pass the 0050 identity / currency / collector checks; otherwise
    -- the unchanged logic below records its ERROR (no integrity failure is hidden by this guard)
    IF jsonb_typeof(v_ev) = 'object'
       AND jsonb_typeof(v_ev->'id') IN ('number', 'string') AND (v_ev->>'id') ~ '^[0-9]{1,20}$'
       AND v_src.external_id = ('MPPAY:' || (v_ev->>'id') || ':' || left(encode(sha256(convert_to(v_ev::TEXT, 'UTF8')), 'hex'), 32))
       AND (v_ev->>'currency_id') = 'ARS'
       AND coalesce(jsonb_typeof(v_ev->'collector_id'), 'null') IN ('number', 'string') AND coalesce(v_ev->>'collector_id', '') <> ''
       AND (v_ev->>'status') = 'approved' AND (v_ev->>'status_detail') = 'accredited'
       AND coalesce(v_ev->>'date_approved', '') ~ c_ts
       AND coalesce(jsonb_typeof(v_ev->'refunds'), 'null') IN ('null', 'array')
       AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(v_ev->'refunds') = 'array' THEN v_ev->'refunds' END), 0) = 0
       AND coalesce(v_ev->>'transaction_amount_refunded', '0') ~ c_amount
       AND coalesce((v_ev->>'transaction_amount_refunded')::NUMERIC, 0) = 0 THEN
      BEGIN
        v_tsg := (v_ev->>'date_approved')::TIMESTAMPTZ;
      EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        v_tsg := NULL;   -- well-shaped but impossible value: the unchanged logic records DATE_MISMATCH
      END;
    END IF;
  ELSIF v_src.source_type = 'csv_import' THEN
    v_tsg := v_src.occurred_at;
  END IF;
  IF v_tsg IS NOT NULL AND v_tsg < v_cut THEN
    v_status := 'IGNORED';
    v_note := format('PRE_CUTOVER_INCLUDED_IN_OPENING_BALANCE: %s < cutover %s', to_char(v_tsg AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                     to_char(v_cut AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
    UPDATE mp_source_record
       SET processing_status = v_status, processed_at = NOW(), processing_note = v_note
     WHERE id = p_source_record_id;
    INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
    VALUES ('mp_source_record', p_source_record_id::TEXT, 'NORMALIZE',
            jsonb_build_object('processing_status', 'PENDING'),
            jsonb_build_object('processing_status', v_status, 'movements', 0, 'processing_note', v_note),
            v_note, NULL);
    RETURN jsonb_build_object('source_record_id', p_source_record_id, 'processing_status', v_status,
                              'movements_created', 0, 'pre_cutover', true);
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

      -- 8. dates. approved + accredited: occurred_at MUST be a valid date_approved (never date_created).
      --    Other states: the S4 derivation (valid date_approved, else valid date_created).
      v_appr := NULL;
      v_crt := NULL;
      IF (v_ev->>'date_approved') ~ c_ts THEN
        BEGIN
          v_appr := (v_ev->>'date_approved')::TIMESTAMPTZ;
        EXCEPTION WHEN OTHERS THEN
          v_appr := NULL;
        END;
      END IF;
      IF (v_ev->>'date_created') ~ c_ts THEN
        BEGIN
          v_crt := (v_ev->>'date_created')::TIMESTAMPTZ;
        EXCEPTION WHEN OTHERS THEN
          v_crt := NULL;
        END;
      END IF;
      IF v_st = 'approved' AND v_sd IS NOT DISTINCT FROM 'accredited' THEN
        IF v_appr IS NULL THEN
          v_status := 'ERROR'; v_note := 'DATE_MISMATCH: approved + accredited requires a valid date_approved'; EXIT api;
        END IF;
        v_at := v_appr;
      ELSE
        v_at := coalesce(v_appr, v_crt);
        IF v_at IS NULL THEN
          v_status := 'ERROR'; v_note := 'DATE_MISMATCH: no valid date_approved / date_created'; EXIT api;
        END IF;
      END IF;
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

ALTER FUNCTION mp_normalize_source(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_normalize_source(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mp_normalize_source(UUID) TO service_role;
