-- ============================================================================
-- TARGET V1 — 0048 MERCADO PAGO REAL-TIME CORE RPCs (ADR-006, Step 2, PRE-V-2)
-- Authority: ADR-006 (ACCEPTED; commit 0f19603)
--            .planning/implementation-design/ADR006_RPC_CONTRACTS_V1.md §0, S1–S3, S5–S7,
--            §40 (csv_import only), C1–C7, R1, R3, R4 (commit 81e0a6a)
--            ADR006_IMPLEMENTATION_ORDER_V1 step 2.
--
-- PRE-V-2: no function here reads or names a Mercado Pago payment-resource field.
-- NOT here (post-V-2 / later steps): mp_ingest_api_snapshot, the api_payment /
-- api_refund parsers, mp_apply_transition, the RPC 41 AUTO_APPLICATION_PENDING
-- guard, mp_normalize_report_fallback and its internal claim helper (0049);
-- grants/policies on the ADR-006 tables (0050); views (0051).
--
-- Every SECURITY DEFINER function: OWNER postgres, SET search_path = public, no
-- PUBLIC / anon EXECUTE, exact EXECUTE grant (ADR006_RLS_AND_SECURITY_V1 §3).
-- Helpers are SECURITY INVOKER with owner-only EXECUTE.
-- ============================================================================

-- ════════════════════════════════════════════════════════════════════════════
-- HELPERS (SECURITY INVOKER, owner-only)
-- ════════════════════════════════════════════════════════════════════════════

-- V-4 gate: Liberaciones SOURCE_ID ↔ payment-id equivalence is unverified.
-- Redefined to return true only by a later migration after V-4 evidence.
CREATE OR REPLACE FUNCTION mp_v4_verified()
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$ SELECT false $$;

-- A movement is auto-applicable when its claimed transition is one that
-- mp_apply_transition (0049) owns. PAYOUT is never auto-applicable (its bank side
-- belongs to transfer_between_accounts, ADR-003 D7).
CREATE OR REPLACE FUNCTION mp_is_auto_applicable(p_movement_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM mp_financial_movement m
      JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
     WHERE m.id = p_movement_id
       AND (m.movement_kind, t.transition) IN (('payment','APPROVAL'), ('refund','REFUND'), ('chargeback','CHARGEBACK'),
                                               ('yield','YIELD'), ('account_tax','ACCOUNT_TAX')))
$$;

-- The ADR-003 D1 Liberaciones parser, verbatim in content and order from 0042,
-- factored out so RPC 40 and the report fallback (0049) share it. Pure: no writes.
-- o_status: 'ERROR' | 'IGNORED' | 'NORMALIZED' (= valid and classifiable).
CREATE OR REPLACE FUNCTION mp_parse_report_row(
  p_src       mp_source_record,
  OUT o_status mp_processing_status,
  OUT o_note   TEXT,
  OUT o_desc   TEXT,
  OUT o_kind   TEXT,
  OUT o_gross  NUMERIC(15,2),
  OUT o_fee    NUMERIC(15,2),
  OUT o_tax    NUMERIC(15,2),
  OUT o_net    NUMERIC(15,2)
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_ev       JSONB := p_src.event_data;
  v_credit   NUMERIC(15,2);
  v_debit    NUMERIC(15,2);
  v_at       TIMESTAMPTZ;
  v_field    TEXT;
  c_keys     CONSTANT TEXT[] := ARRAY['BALANCE_AMOUNT','BUSINESS_UNIT','DATE','DESCRIPTION','GROSS_AMOUNT',
    'MP_FEE_AMOUNT','NET_CREDIT_AMOUNT','NET_DEBIT_AMOUNT','PAYMENT_METHOD','PAYMENT_METHOD_TYPE',
    'PURCHASE_ID','SOURCE_ID','SUB_UNIT','TAXES_AMOUNT','TRANSACTION_APPROVAL_DATE'];
  c_amount   CONSTANT TEXT := '^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
  c_ts       CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
BEGIN
  <<parse>>
  BEGIN
    IF p_src.source_type <> 'csv_import' THEN
      o_status := 'ERROR';
      o_note := format('UNSUPPORTED_SOURCE_TYPE: %s is not normalized in V1', p_src.source_type);
      EXIT parse;
    END IF;
    IF jsonb_typeof(v_ev) <> 'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_ev) k) IS DISTINCT FROM c_keys THEN
      o_status := 'ERROR';
      o_note := 'UNSUPPORTED_CSV_FORMAT: event_data is not exactly the 15-column Liberaciones layout';
      EXIT parse;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(v_ev) e WHERE jsonb_typeof(e.value) <> 'string') THEN
      o_status := 'ERROR';
      o_note := 'MALFORMED_EVENT_DATA: every Liberaciones value must be a raw string';
      EXIT parse;
    END IF;

    o_desc := v_ev->>'DESCRIPTION';
    IF o_desc IS NULL OR o_desc NOT IN ('payment', 'asset_management', 'payout',
                                        'reserve_for_payment', 'reserve_for_payout') THEN
      o_status := 'ERROR';
      o_note := format('UNKNOWN_DESCRIPTION: %s', coalesce(o_desc, '(null)'));
      EXIT parse;
    END IF;
    o_kind := CASE o_desc WHEN 'payment' THEN 'payment'
                          WHEN 'asset_management' THEN 'yield'
                          WHEN 'payout' THEN 'transfer' END;   -- NULL for reserve rows

    FOREACH v_field IN ARRAY ARRAY['NET_CREDIT_AMOUNT','NET_DEBIT_AMOUNT','GROSS_AMOUNT','MP_FEE_AMOUNT','TAXES_AMOUNT'] LOOP
      IF coalesce(v_ev->>v_field, '') = '' THEN
        o_status := 'ERROR';
        o_note := format('MISSING_AMOUNT: %s', v_field);
        EXIT parse;
      END IF;
      IF (v_ev->>v_field) !~ c_amount THEN
        o_status := 'ERROR';
        o_note := format('MALFORMED_AMOUNT: %s = %s', v_field, v_ev->>v_field);
        EXIT parse;
      END IF;
    END LOOP;
    v_credit := (v_ev->>'NET_CREDIT_AMOUNT')::NUMERIC;
    v_debit  := (v_ev->>'NET_DEBIT_AMOUNT')::NUMERIC;
    o_gross  := (v_ev->>'GROSS_AMOUNT')::NUMERIC;
    o_fee    := (v_ev->>'MP_FEE_AMOUNT')::NUMERIC;
    o_tax    := (v_ev->>'TAXES_AMOUNT')::NUMERIC;

    IF (v_credit <> 0) = (v_debit <> 0) THEN
      o_status := 'ERROR';
      o_note := 'CREDIT_DEBIT_INVALID: exactly one of NET_CREDIT_AMOUNT / NET_DEBIT_AMOUNT must be non-zero';
      EXIT parse;
    END IF;
    o_net := v_credit - v_debit;
    IF o_net = 0 THEN
      o_status := 'ERROR';
      o_note := 'ZERO_NET: a supported movement must have a non-zero net';
      EXIT parse;
    END IF;
    IF o_fee > 0 OR o_tax > 0 THEN
      o_status := 'ERROR';
      o_note := 'SIGN_INVALID: MP_FEE_AMOUNT and TAXES_AMOUNT must be <= 0';
      EXIT parse;
    END IF;
    IF o_gross + o_fee + o_tax <> o_net THEN
      o_status := 'ERROR';
      o_note := format('ARITHMETIC_MISMATCH: gross %s + fee %s + tax %s <> net %s', o_gross, o_fee, o_tax, o_net);
      EXIT parse;
    END IF;

    IF coalesce(v_ev->>'SOURCE_ID', '') = '' OR coalesce(v_ev->>'DATE', '') = '' THEN
      o_status := 'ERROR';
      o_note := 'MISSING_IDENTITY: rows without SOURCE_ID or DATE are not source events';
      EXIT parse;
    END IF;
    IF (p_src.external_id IS DISTINCT FROM
        ((v_ev->>'SOURCE_ID') || ':' || o_desc || ':' || (CASE WHEN o_net > 0 THEN 'C' ELSE 'D' END))) THEN
      o_status := 'ERROR';
      o_note := 'IDENTITY_MISMATCH: external_id is not SOURCE_ID:DESCRIPTION:direction';
      EXIT parse;
    END IF;
    IF (v_ev->>'DATE') !~ c_ts THEN
      o_status := 'ERROR';
      o_note := format('MALFORMED_DATE: %s', v_ev->>'DATE');
      EXIT parse;
    END IF;
    v_at := (v_ev->>'DATE')::TIMESTAMPTZ;
    IF p_src.occurred_at IS DISTINCT FROM v_at
       OR p_src.occurred_date IS DISTINCT FROM (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE THEN
      o_status := 'ERROR';
      o_note := 'DATE_MISMATCH: occurred_at / occurred_date differ from the DATE field';
      EXIT parse;
    END IF;

    IF o_desc IN ('reserve_for_payment', 'reserve_for_payout') THEN
      o_status := 'IGNORED';
      o_note := format('RESERVE_ROW: %s is a valid MP internal reserve, outside the financial-movement scope', o_desc);
      EXIT parse;
    END IF;
    o_status := 'NORMALIZED';
  END parse;
END;
$$;

ALTER FUNCTION mp_v4_verified() OWNER TO postgres;
ALTER FUNCTION mp_is_auto_applicable(BIGINT) OWNER TO postgres;
ALTER FUNCTION mp_parse_report_row(mp_source_record) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_v4_verified() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION mp_is_auto_applicable(BIGINT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION mp_parse_report_row(mp_source_record) FROM PUBLIC, anon, authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- 40. mp_normalize_source — csv_import redefinition (ADR-006 §40, §40.1, §40.4)
-- Unchanged: service role only, FOR UPDATE on the source, SOURCE_NOT_FOUND,
-- ALREADY_PROCESSED when not PENDING, raw columns never written, NORMALIZE audit,
-- no period guard, the ADR-003 D1 parser (now mp_parse_report_row), result keys.
-- Changed: yield / payout rows claim a transition identity + REPORT_ONLY match;
-- payment rows are parked PENDING DEFERRED_V4 while mp_v4_verified() is false.
-- api_payment / api_refund are still UNSUPPORTED_SOURCE_TYPE (parsers are post-V-2).
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
-- QUEUE / DELIVERY (S1, S2, S3, S5, S6, S7)
-- ════════════════════════════════════════════════════════════════════════════

-- ── S1 mp_register_delivery ────────────────────────────────────────────────
-- The database is the only authority for notification_sha256 (N-SHA) and delivery_key.
CREATE OR REPLACE FUNCTION mp_register_delivery(
  p_origin                   VARCHAR,
  p_topic                    VARCHAR,
  p_topic_class              VARCHAR,
  p_action                   VARCHAR,
  p_resource_id              VARCHAR,
  p_notification_id          VARCHAR,
  p_x_request_id             VARCHAR,
  p_notification_payload     JSONB,
  p_signature_verified       BOOLEAN,
  p_triggered_by_delivery_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload  JSONB := coalesce(p_notification_payload, '{}'::jsonb);
  v_hash     CHAR(64);
  v_key      VARCHAR(200);
  v_ck       VARCHAR(200);
  v_id       UUID;
  v_existing mp_webhook_delivery;
  v_conflict mp_webhook_delivery;
  v_status   mp_delivery_status;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('webhook', 'chargeback_refresh') THEN
    RAISE EXCEPTION 'INVALID_DELIVERY: origin must be webhook or chargeback_refresh';
  END IF;
  IF p_topic_class IS NULL OR p_topic_class NOT IN ('payment', 'chargeback', 'unsupported') THEN
    RAISE EXCEPTION 'INVALID_DELIVERY: topic_class must be payment, chargeback or unsupported';
  END IF;

  -- N-SHA (ADR006_RPC_CONTRACTS_V1 §S1): fixed order; NULL action / resource_id → JSON null; NULL payload → {}
  v_hash := encode(sha256(convert_to((
              jsonb_build_array(p_origin, p_topic_class, p_topic, p_action, p_resource_id, v_payload))::text, 'UTF8')), 'hex');

  IF p_origin = 'chargeback_refresh' THEN
    v_key := 'cbrefresh:' || p_triggered_by_delivery_id::TEXT || ':' || coalesce(p_resource_id, '');
  ELSIF p_notification_id IS NOT NULL AND p_notification_id ~ '^[A-Za-z0-9._:-]{1,120}$' THEN
    v_key := 'n:' || p_topic_class || ':' || p_notification_id;
  ELSE
    v_key := 'h:' || v_hash;
  END IF;
  v_status := CASE WHEN p_topic_class = 'unsupported' THEN 'UNSUPPORTED' ELSE 'RECEIVED' END;

  BEGIN
    INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, action, resource_id,
                                     x_request_id, notification_payload, signature_verified, triggered_by_delivery_id, status)
    VALUES (v_key, v_hash, p_origin, p_topic, p_topic_class, p_action, p_resource_id,
            p_x_request_id, v_payload, coalesce(p_signature_verified, false), p_triggered_by_delivery_id, v_status)
    ON CONFLICT (delivery_key) DO NOTHING
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
    RAISE EXCEPTION 'INVALID_DELIVERY: %', SQLERRM;
  END;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_webhook_delivery', v_id::TEXT, 'MP_DELIVERY_REGISTER',
            jsonb_build_object('origin', p_origin, 'topic_class', p_topic_class, 'status', v_status, 'key_conflict', false),
            NULL, NULL);
    RETURN jsonb_build_object('delivery_id', v_id, 'created', true, 'key_conflict', false);
  END IF;

  SELECT * INTO v_existing FROM mp_webhook_delivery WHERE delivery_key = v_key;
  IF v_existing.notification_sha256 = v_hash THEN
    RETURN jsonb_build_object('delivery_id', v_existing.id, 'created', false, 'key_conflict', false);
  END IF;

  -- same natural key, different content: a bounded, deterministic conflict row (never merged)
  v_ck := 'conflict:' || encode(sha256(convert_to(v_existing.delivery_key || ':' || v_hash, 'UTF8')), 'hex');
  BEGIN
    INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, key_conflict_of, origin, topic, topic_class, action,
                                     resource_id, x_request_id, notification_payload, signature_verified,
                                     triggered_by_delivery_id, status)
    VALUES (v_ck, v_hash, v_existing.id, p_origin, p_topic, p_topic_class, p_action,
            p_resource_id, p_x_request_id, v_payload, coalesce(p_signature_verified, false),
            p_triggered_by_delivery_id, v_status)
    ON CONFLICT (delivery_key) DO NOTHING
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation OR foreign_key_violation OR not_null_violation THEN
    RAISE EXCEPTION 'INVALID_DELIVERY: %', SQLERRM;
  END;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_webhook_delivery', v_id::TEXT, 'MP_DELIVERY_REGISTER',
            jsonb_build_object('origin', p_origin, 'topic_class', p_topic_class, 'status', v_status,
                               'key_conflict', true, 'key_conflict_of', v_existing.id),
            NULL, NULL);
    RETURN jsonb_build_object('delivery_id', v_id, 'created', true, 'key_conflict', true);
  END IF;

  SELECT * INTO v_conflict FROM mp_webhook_delivery WHERE delivery_key = v_ck;
  IF v_conflict.notification_sha256 <> v_hash THEN
    RAISE EXCEPTION 'DELIVERY_KEY_COLLISION';
  END IF;
  RETURN jsonb_build_object('delivery_id', v_conflict.id, 'created', false, 'key_conflict', true);
END;
$$;

-- ── S2 mp_claim_deliveries ─────────────────────────────────────────────────
-- Return columns, exactly in this order: delivery_id, claim_token, origin, topic_class, topic, resource_id, attempts.
-- CONFIG_BLOCKED, SIGNAL_RECORDED, FETCHED, FAILED_PERMANENT and UNSUPPORTED rows are never selected.
CREATE OR REPLACE FUNCTION mp_claim_deliveries(
  p_limit         INTEGER,
  p_lease_seconds INTEGER
)
RETURNS TABLE (delivery_id UUID, claim_token UUID, origin VARCHAR, topic_class VARCHAR, topic VARCHAR,
               resource_id VARCHAR, attempts INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_limit must be 1..50';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_lease_seconds must be 30..600';
  END IF;

  RETURN QUERY
  WITH picked AS (
    SELECT d.id
      FROM mp_webhook_delivery d
     WHERE (d.status IN ('RECEIVED', 'FAILED_RETRYABLE') AND d.next_attempt_at <= NOW())
        OR (d.status = 'PROCESSING' AND d.lease_expires_at < NOW())
     ORDER BY d.next_attempt_at, d.received_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE mp_webhook_delivery u
     SET status = 'PROCESSING', claim_token = gen_random_uuid(),
         lease_expires_at = NOW() + make_interval(secs => p_lease_seconds),
         attempts = u.attempts + 1, updated_at = NOW()
    FROM picked
   WHERE u.id = picked.id
  RETURNING u.id, u.claim_token, u.origin, u.topic_class, u.topic, u.resource_id, u.attempts;
END;
$$;

-- ── S3 mp_delivery_transition ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_delivery_transition(
  p_delivery_id         UUID,
  p_claim_token         UUID,
  p_outcome             VARCHAR,
  p_source_record_id    UUID DEFAULT NULL,
  p_error_code          VARCHAR DEFAULT NULL,
  p_error_detail        VARCHAR DEFAULT NULL,
  p_retry_after_seconds INTEGER DEFAULT NULL,
  p_link_payment_id     VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_d        mp_webhook_delivery;
  v_status   mp_delivery_status;
  v_next     TIMESTAMPTZ;
  v_first    TIMESTAMPTZ;
  v_attempts INTEGER;
  v_delay    INTEGER;
  v_hash     CHAR(64);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  -- argument validation, before any write
  IF p_outcome IS NULL OR p_outcome NOT IN ('FETCHED', 'SIGNAL_RECORDED', 'RETRY', 'CONFIG_BLOCKED', 'RELEASE', 'PERMANENT') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME: %', coalesce(p_outcome, '(null)');
  END IF;
  IF p_link_payment_id IS NOT NULL AND p_outcome <> 'SIGNAL_RECORDED' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_link_payment_id only for SIGNAL_RECORDED';
  END IF;
  IF p_link_payment_id IS NOT NULL AND p_link_payment_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;
  IF p_source_record_id IS NOT NULL AND p_outcome <> 'FETCHED' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_source_record_id only for FETCHED';
  END IF;
  IF p_retry_after_seconds IS NOT NULL AND p_outcome <> 'RETRY' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_retry_after_seconds only for RETRY';
  END IF;
  IF p_outcome = 'RETRY' AND (p_error_code IS NULL OR p_error_code NOT IN ('MP_NOT_FOUND', 'MP_RATE_LIMIT', 'MP_UNAVAILABLE')) THEN
    RAISE EXCEPTION 'INVALID_OUTCOME: RETRY is for transient classes only (got %)', coalesce(p_error_code, '(null)');
  END IF;
  IF p_outcome = 'CONFIG_BLOCKED' AND p_error_code IS DISTINCT FROM 'AUTH_CONFIGURATION_ERROR' THEN
    RAISE EXCEPTION 'INVALID_OUTCOME: CONFIG_BLOCKED requires AUTH_CONFIGURATION_ERROR';
  END IF;

  SELECT * INTO v_d FROM mp_webhook_delivery WHERE id = p_delivery_id FOR UPDATE;   -- L1
  IF NOT FOUND OR v_d.status <> 'PROCESSING' OR v_d.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'CLAIM_LOST';
  END IF;

  v_next := v_d.next_attempt_at;
  v_first := v_d.first_failed_at;
  v_attempts := v_d.attempts;

  CASE p_outcome
    WHEN 'FETCHED' THEN
      IF v_d.topic_class <> 'payment' OR p_source_record_id IS NULL THEN
        RAISE EXCEPTION 'INVALID_OUTCOME: FETCHED needs a payment delivery and a source record';
      END IF;
      v_status := 'FETCHED';
    WHEN 'SIGNAL_RECORDED' THEN
      IF v_d.topic_class <> 'chargeback' THEN
        RAISE EXCEPTION 'INVALID_OUTCOME: SIGNAL_RECORDED is for chargeback signals only';
      END IF;
      v_status := 'SIGNAL_RECORDED';
    WHEN 'RETRY' THEN
      v_first := coalesce(v_d.first_failed_at, NOW());
      IF NOW() - v_first > INTERVAL '48 hours' THEN            -- internal policy, not an MP guarantee
        v_status := 'FAILED_PERMANENT';
      ELSE
        v_status := 'FAILED_RETRYABLE';
        IF p_retry_after_seconds IS NOT NULL THEN
          v_delay := least(greatest(p_retry_after_seconds, 60), 3600);
        ELSE
          v_delay := 60 * (CASE WHEN v_d.attempts >= 7 THEN 60 ELSE (2 ^ (greatest(v_d.attempts, 1) - 1))::INTEGER END);
        END IF;
        v_next := NOW() + make_interval(secs => v_delay);
      END IF;
    WHEN 'CONFIG_BLOCKED' THEN
      v_status := 'CONFIG_BLOCKED';
    WHEN 'RELEASE' THEN
      v_status := CASE WHEN v_d.first_failed_at IS NULL THEN 'RECEIVED' ELSE 'FAILED_RETRYABLE' END;
      v_attempts := greatest(v_d.attempts - 1, 0);            -- the claim never ran
    WHEN 'PERMANENT' THEN
      v_status := 'FAILED_PERMANENT';
  END CASE;

  UPDATE mp_webhook_delivery
     SET status = v_status, claim_token = NULL, lease_expires_at = NULL,
         attempts = v_attempts, next_attempt_at = v_next, first_failed_at = v_first,
         source_record_id = coalesce(p_source_record_id, source_record_id),
         last_error_code = CASE WHEN p_outcome IN ('RETRY', 'CONFIG_BLOCKED', 'PERMANENT') THEN p_error_code ELSE last_error_code END,
         last_error_detail = CASE WHEN p_outcome IN ('RETRY', 'CONFIG_BLOCKED', 'PERMANENT') THEN left(p_error_detail, 500)
                                  ELSE last_error_detail END,
         updated_at = NOW()
   WHERE id = p_delivery_id;

  IF p_outcome = 'SIGNAL_RECORDED' AND p_link_payment_id IS NOT NULL THEN
    -- automatic link from a documented payment reference: payment refresh + resolution LINKED; no financial write
    v_hash := encode(sha256(convert_to((
                jsonb_build_array('chargeback_refresh', 'payment', 'payment', NULL::TEXT, p_link_payment_id, '{}'::jsonb))::text,
                'UTF8')), 'hex');
    INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id,
                                     notification_payload, signature_verified, triggered_by_delivery_id, status)
    VALUES ('cbrefresh:' || p_delivery_id::TEXT || ':' || p_link_payment_id, v_hash, 'chargeback_refresh', 'payment', 'payment',
            p_link_payment_id, '{}'::jsonb, false, p_delivery_id, 'RECEIVED')
    ON CONFLICT (delivery_key) DO NOTHING;
    UPDATE mp_webhook_delivery
       SET signal_resolution = 'LINKED', signal_resolution_reason = 'auto: documented payment reference',
           signal_resolved_by = NULL, signal_resolved_at = NOW()
     WHERE id = p_delivery_id AND signal_resolution IS NULL;
  END IF;

  RETURN jsonb_build_object('delivery_id', p_delivery_id, 'status', v_status);
END;
$$;

-- ── S5 mp_requeue_config_blocked ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_requeue_config_blocked(
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID;
  v_count INTEGER;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF current_app_role() <> 'ADMIN' THEN
      RAISE EXCEPTION 'FORBIDDEN: ADMIN or backend service role required';
    END IF;
    v_uid := auth.uid();
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  WITH blocked AS (
    SELECT id FROM mp_webhook_delivery WHERE status = 'CONFIG_BLOCKED' FOR UPDATE SKIP LOCKED
  )
  UPDATE mp_webhook_delivery d
     SET status = 'RECEIVED', next_attempt_at = NOW(), claim_token = NULL, lease_expires_at = NULL, updated_at = NOW()
    FROM blocked
   WHERE d.id = blocked.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_webhook_delivery', 'CONFIG_BLOCKED', 'MP_DELIVERY_REQUEUE',
            jsonb_build_object('requeued', v_count), p_reason, v_uid);
  END IF;
  RETURN jsonb_build_object('requeued', v_count);
END;
$$;

-- ── S6 mp_request_refetch (ADMIN) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_request_refetch(
  p_payment_id VARCHAR,
  p_reason     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID;
  v_id   UUID;
  v_hash CHAR(64);
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_payment_id IS NULL OR p_payment_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  v_hash := encode(sha256(convert_to((
              jsonb_build_array('manual_refetch', 'payment', 'payment', NULL::TEXT, p_payment_id, '{}'::jsonb))::text, 'UTF8')), 'hex');
  INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id,
                                   notification_payload, signature_verified, status)
  VALUES ('refetch:' || p_payment_id || ':' || gen_random_uuid()::TEXT, v_hash, 'manual_refetch', 'payment', 'payment',
          p_payment_id, '{}'::jsonb, false, 'RECEIVED')
  RETURNING id INTO v_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_webhook_delivery', v_id::TEXT, 'MP_REFETCH_REQUEST', jsonb_build_object('payment_id', p_payment_id), p_reason, v_uid);
  RETURN jsonb_build_object('delivery_id', v_id);
END;
$$;

-- ── S7 mp_resolve_chargeback_signal (ADMIN) ────────────────────────────────
CREATE OR REPLACE FUNCTION mp_resolve_chargeback_signal(
  p_delivery_id UUID,
  p_resolution  VARCHAR,
  p_payment_id  VARCHAR DEFAULT NULL,
  p_reason      TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID;
  v_d    mp_webhook_delivery;
  v_hash CHAR(64);
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_resolution IS NULL OR p_resolution NOT IN ('LINKED', 'DISMISSED') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_resolution = 'LINKED' AND (p_payment_id IS NULL OR p_payment_id !~ '^[0-9]{1,20}$') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;
  IF p_resolution = 'DISMISSED' AND p_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: p_payment_id only for LINKED';
  END IF;

  SELECT * INTO v_d FROM mp_webhook_delivery WHERE id = p_delivery_id FOR UPDATE;   -- L1
  IF NOT FOUND OR v_d.topic_class <> 'chargeback' OR v_d.status <> 'SIGNAL_RECORDED' THEN
    RAISE EXCEPTION 'NOT_A_CHARGEBACK_SIGNAL';
  END IF;
  IF v_d.signal_resolution IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_RESOLVED';
  END IF;

  IF p_resolution = 'LINKED' THEN
    v_hash := encode(sha256(convert_to((
                jsonb_build_array('chargeback_refresh', 'payment', 'payment', NULL::TEXT, p_payment_id, '{}'::jsonb))::text,
                'UTF8')), 'hex');
    INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id,
                                     notification_payload, signature_verified, triggered_by_delivery_id, status)
    VALUES ('cbrefresh:' || p_delivery_id::TEXT || ':' || p_payment_id, v_hash, 'chargeback_refresh', 'payment', 'payment',
            p_payment_id, '{}'::jsonb, false, p_delivery_id, 'RECEIVED')
    ON CONFLICT (delivery_key) DO NOTHING;
  END IF;

  UPDATE mp_webhook_delivery
     SET signal_resolution = p_resolution, signal_resolution_reason = p_reason,
         signal_resolved_by = v_uid, signal_resolved_at = NOW(), updated_at = NOW()
   WHERE id = p_delivery_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_webhook_delivery', p_delivery_id::TEXT, 'MP_CHARGEBACK_SIGNAL_RESOLVE',
          jsonb_build_object('resolution', p_resolution, 'payment_id', p_payment_id), p_reason, v_uid);
  RETURN jsonb_build_object('delivery_id', p_delivery_id, 'resolution', p_resolution);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- OPTIONAL CLIENT ATTRIBUTION (C1–C7) — client_ledger only, never money
-- ════════════════════════════════════════════════════════════════════════════

-- ── C1 mp_allocate_to_client (MANUAL) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_allocate_to_client(
  p_movement_id     BIGINT,
  p_cliente_id      UUID,
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_idempotency_key VARCHAR,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID;
  v_mv       mp_financial_movement;
  v_tr       mp_transition_identity;
  v_src_st   mp_processing_status;
  v_assigned NUMERIC(15,2);
  v_client   TEXT;
  v_active   NUMERIC(15,2);
  v_bound    NUMERIC(15,2);
  v_alloc    UUID := gen_random_uuid();
  v_ledger   BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 97
     OR p_idempotency_key LIKE 'MPA:%' OR p_idempotency_key LIKE 'MPAUTO:%' OR p_idempotency_key LIKE 'MPREV:%' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 97 characters, no reserved prefix';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM mp_client_allocation WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_ALLOCATION';
  END IF;

  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE;   -- L5
  SELECT * INTO v_tr FROM mp_transition_identity WHERE mp_financial_movement_id = p_movement_id;
  IF v_mv.id IS NULL OR v_mv.movement_kind <> 'payment' OR v_tr.transition IS DISTINCT FROM 'APPROVAL' THEN
    RAISE EXCEPTION 'NOT_A_RECEIPT';
  END IF;
  SELECT processing_status INTO v_src_st FROM mp_source_record WHERE id = v_mv.mp_source_record_id;
  SELECT coalesce(sum(assigned_amount), 0) INTO v_assigned FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id;
  IF v_src_st = 'ERROR' OR v_assigned <> v_mv.net_amount THEN
    RAISE EXCEPTION 'RECEIPT_NOT_POSTED';
  END IF;
  SELECT nombre INTO v_client FROM clients WHERE id = p_cliente_id AND activo = true;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF p_effective_date IS NULL OR p_effective_date < v_mv.occurred_date THEN
    RAISE EXCEPTION 'EFFECTIVE_DATE_BEFORE_RECEIPT';
  END IF;
  PERFORM assert_period_open(p_effective_date);                                      -- L6

  -- bound = effective applied receipt: gross − Σ │gross│ of REFUND / CHARGEBACK movements of the
  -- same payment that mp_apply_transition has successfully applied (key MPA:{t}:SETTLE exists)
  SELECT coalesce(sum(amount), 0) INTO v_active FROM mp_client_allocation WHERE mp_financial_movement_id = p_movement_id;
  SELECT v_mv.gross_amount - coalesce(sum(abs(m2.gross_amount)), 0) INTO v_bound
    FROM mp_transition_identity t2
    JOIN mp_financial_movement m2 ON m2.id = t2.mp_financial_movement_id
   WHERE t2.resource_type = v_tr.resource_type AND t2.resource_id = v_tr.resource_id
     AND t2.transition IN ('REFUND', 'CHARGEBACK')
     AND EXISTS (SELECT 1 FROM mp_reconciliation r
                  WHERE r.mp_financial_movement_id = m2.id AND r.idempotency_key = 'MPA:' || t2.id || ':SETTLE');
  IF v_active + p_amount > v_bound THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_RECEIPT: % + % exceeds effective receipt %', v_active, p_amount, v_bound;
  END IF;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name,
                             source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'COLLECTION', -p_amount, p_effective_date, v_client,
          'mp_client_allocation', v_alloc::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger;

  INSERT INTO mp_client_allocation (id, mp_financial_movement_id, cliente_id, amount, origin, mode, effective_date,
                                    evidence, idempotency_key, client_ledger_id, reason, created_by)
  VALUES (v_alloc, p_movement_id, p_cliente_id, p_amount, 'ALLOCATION', 'MANUAL', p_effective_date,
          jsonb_build_object('reason', p_reason), p_idempotency_key, v_ledger, p_reason, v_uid);

  IF v_active + p_amount = v_bound THEN
    UPDATE mp_attribution_flag
       SET cleared_by = v_uid, cleared_at = NOW(), clear_reason = 'FULLY_ASSIGNED'
     WHERE mp_financial_movement_id = p_movement_id AND cleared_at IS NULL;
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_client_allocation', v_alloc::TEXT, 'MP_CLIENT_ALLOCATION',
          jsonb_build_object('movement_id', p_movement_id, 'cliente_id', p_cliente_id, 'amount', p_amount,
                             'mode', 'MANUAL', 'client_ledger_id', v_ledger),
          p_reason, v_uid);

  RETURN jsonb_build_object('allocation_id', v_alloc, 'client_ledger_id', v_ledger,
                            'active_attributed', v_active + p_amount, 'effective_receipt', v_bound);
END;
$$;

-- ── C2 mp_auto_allocate (AUTO; deterministic evidence only) ────────────────
-- PRE-V-2 form: the evidence sources (external_reference and the payer id of the
-- claiming api_payment snapshot) are MP payment-resource fields whose mapping is
-- fixed by V-2. No such field is read here, so the candidate set is empty and the
-- result is always NONE (NO_EVIDENCE). The post-V-2 migration redefines the
-- evidence derivation; the guards below are the accepted contract.
CREATE OR REPLACE FUNCTION mp_auto_allocate(
  p_movement_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mv       mp_financial_movement;
  v_tr       mp_transition_identity;
  v_src_st   mp_processing_status;
  v_assigned NUMERIC(15,2);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;

  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE;   -- L5
  SELECT * INTO v_tr FROM mp_transition_identity WHERE mp_financial_movement_id = p_movement_id;
  IF v_mv.id IS NULL OR v_mv.movement_kind <> 'payment' OR v_tr.transition IS DISTINCT FROM 'APPROVAL' THEN
    RAISE EXCEPTION 'NOT_A_RECEIPT';
  END IF;
  SELECT processing_status INTO v_src_st FROM mp_source_record WHERE id = v_mv.mp_source_record_id;
  SELECT coalesce(sum(assigned_amount), 0) INTO v_assigned FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id;
  IF v_src_st = 'ERROR' OR v_assigned <> v_mv.net_amount THEN
    RAISE EXCEPTION 'RECEIPT_NOT_POSTED';
  END IF;
  IF EXISTS (SELECT 1 FROM mp_client_allocation WHERE idempotency_key = 'MPAUTO:' || v_tr.id) THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'ALREADY_ALLOCATED');
  END IF;

  RETURN jsonb_build_object('allocated', false, 'reason', 'NO_EVIDENCE');
END;
$$;

-- ── C3 mp_reverse_client_allocation (MANUAL correction) ────────────────────
CREATE OR REPLACE FUNCTION mp_reverse_client_allocation(
  p_allocation_id   UUID,
  p_amount          NUMERIC,
  p_idempotency_key VARCHAR,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID;
  v_a         mp_client_allocation;
  v_remaining NUMERIC(15,2);
  v_client    TEXT;
  v_rev       UUID := gen_random_uuid();
  v_ledger    BIGINT;
  v_today     DATE := (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();

  SELECT * INTO v_a FROM mp_client_allocation WHERE id = p_allocation_id;
  IF NOT FOUND OR v_a.origin <> 'ALLOCATION' THEN
    RAISE EXCEPTION 'ALLOCATION_NOT_FOUND';
  END IF;
  PERFORM 1 FROM mp_financial_movement WHERE id = v_a.mp_financial_movement_id FOR UPDATE;   -- L5
  SELECT v_a.amount + coalesce(sum(amount), 0) INTO v_remaining FROM mp_client_allocation WHERE reversal_of_id = v_a.id;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) OR p_amount > v_remaining THEN
    RAISE EXCEPTION 'REVERSAL_EXCEEDS_ALLOCATION: % of remaining %', p_amount, v_remaining;
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 97
     OR p_idempotency_key LIKE 'MPA:%' OR p_idempotency_key LIKE 'MPAUTO:%' OR p_idempotency_key LIKE 'MPREV:%' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 97 characters, no reserved prefix';
  END IF;
  IF EXISTS (SELECT 1 FROM mp_client_allocation WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_ALLOCATION';
  END IF;
  PERFORM assert_period_open(v_today);                                                  -- L6

  SELECT nombre INTO v_client FROM clients WHERE id = v_a.cliente_id;
  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name,
                             source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
  VALUES (v_a.cliente_id, 'REVERSAL', p_amount, v_today, v_client,
          'mp_client_allocation', v_rev::TEXT, v_a.client_ledger_id, p_reason, v_uid)
  RETURNING id INTO v_ledger;

  INSERT INTO mp_client_allocation (id, mp_financial_movement_id, cliente_id, amount, origin, reversal_of_id, effective_date,
                                    evidence, idempotency_key, client_ledger_id, reason, created_by)
  VALUES (v_rev, v_a.mp_financial_movement_id, v_a.cliente_id, -p_amount, 'MANUAL_REVERSAL', v_a.id, v_today,
          jsonb_build_object('reason', p_reason), p_idempotency_key, v_ledger, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_client_allocation', v_rev::TEXT, 'MP_CLIENT_ALLOCATION_REVERSAL',
          jsonb_build_object('reversal_of_id', v_a.id, 'amount', p_amount, 'client_ledger_id', v_ledger),
          p_reason, v_uid);

  RETURN jsonb_build_object('reversal_id', v_rev, 'client_ledger_id', v_ledger, 'remaining', v_remaining - p_amount);
END;
$$;

-- ── C4 mp_flag_for_attribution / C5 mp_clear_attribution_flag (ADMIN) ──────
CREATE OR REPLACE FUNCTION mp_flag_for_attribution(
  p_movement_id BIGINT,
  p_reason      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_id  UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mp_financial_movement m JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
                  WHERE m.id = p_movement_id AND m.movement_kind = 'payment' AND t.transition = 'APPROVAL') THEN
    RAISE EXCEPTION 'NOT_A_RECEIPT';
  END IF;
  BEGIN
    INSERT INTO mp_attribution_flag (mp_financial_movement_id, reason, requested_by)
    VALUES (p_movement_id, p_reason, v_uid)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'FLAG_ALREADY_OPEN';
  END;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_attribution_flag', v_id::TEXT, 'MP_ATTRIBUTION_FLAG', jsonb_build_object('movement_id', p_movement_id), p_reason, v_uid);
  RETURN jsonb_build_object('flag_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION mp_clear_attribution_flag(
  p_flag_id UUID,
  p_reason  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_f   mp_attribution_flag;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  SELECT * INTO v_f FROM mp_attribution_flag WHERE id = p_flag_id FOR UPDATE;
  IF NOT FOUND OR v_f.cleared_at IS NOT NULL THEN
    RAISE EXCEPTION 'FLAG_NOT_OPEN';
  END IF;
  UPDATE mp_attribution_flag SET cleared_by = v_uid, cleared_at = NOW(), clear_reason = p_reason WHERE id = p_flag_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_attribution_flag', p_flag_id::TEXT, 'MP_ATTRIBUTION_FLAG_CLEAR',
          jsonb_build_object('movement_id', v_f.mp_financial_movement_id), p_reason, v_uid);
  RETURN jsonb_build_object('flag_id', p_flag_id, 'cleared', true);
END;
$$;

-- ── C6 mp_map_payer_to_client / C7 mp_unmap_payer (ADMIN) ──────────────────
CREATE OR REPLACE FUNCTION mp_map_payer_to_client(
  p_mp_payer_id VARCHAR,
  p_cliente_id  UUID,
  p_reason      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_id  UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_mp_payer_id IS NULL OR p_mp_payer_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYER_ID';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_cliente_id AND activo = true) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  BEGIN
    INSERT INTO mp_payer_client_map (mp_payer_id, cliente_id, created_by)
    VALUES (p_mp_payer_id, p_cliente_id, v_uid)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'PAYER_ALREADY_MAPPED';
  END;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_payer_client_map', v_id::TEXT, 'MP_PAYER_MAP',
          jsonb_build_object('mp_payer_id', p_mp_payer_id, 'cliente_id', p_cliente_id), p_reason, v_uid);
  RETURN jsonb_build_object('mapping_id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION mp_unmap_payer(
  p_mapping_id UUID,
  p_reason     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_m   mp_payer_client_map;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  SELECT * INTO v_m FROM mp_payer_client_map WHERE id = p_mapping_id FOR UPDATE;
  IF NOT FOUND OR NOT v_m.activo THEN
    RAISE EXCEPTION 'MAPPING_NOT_ACTIVE';
  END IF;
  UPDATE mp_payer_client_map
     SET activo = false, deactivated_at = NOW(), deactivated_by = v_uid, deactivation_reason = p_reason
   WHERE id = p_mapping_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_payer_client_map', p_mapping_id::TEXT, 'MP_PAYER_UNMAP', jsonb_build_object('mp_payer_id', v_m.mp_payer_id), p_reason, v_uid);
  RETURN jsonb_build_object('mapping_id', p_mapping_id, 'activo', false);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- REPORT RECONCILIATION (R1, R3, R4) — evidence only, never a financial write
-- ════════════════════════════════════════════════════════════════════════════

-- ── R1 mp_resolve_match (ADMIN) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_resolve_match(
  p_match_id   UUID,
  p_resolution VARCHAR,
  p_reason     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_m   mp_report_match;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  SELECT * INTO v_m FROM mp_report_match WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;
  IF NOT v_m.is_exception THEN
    RAISE EXCEPTION 'NOT_AN_EXCEPTION';
  END IF;
  IF v_m.resolution IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_RESOLVED';
  END IF;
  IF p_resolution IS NULL OR p_resolution NOT IN ('EXPLAINED', 'CORRECTED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'INVALID_RESOLUTION';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_resolution = 'CORRECTED' AND NOT EXISTS (
       SELECT 1 FROM mp_transition_identity t
         JOIN mp_reconciliation r ON r.mp_financial_movement_id = t.mp_financial_movement_id
        WHERE t.id = v_m.transition_id AND r.reconciled_at > v_m.created_at) THEN
    RAISE EXCEPTION 'NO_CORRECTION_FOUND';
  END IF;

  UPDATE mp_report_match
     SET resolution = p_resolution, resolution_reason = p_reason, resolved_by = v_uid, resolved_at = NOW()
   WHERE id = p_match_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_report_match', p_match_id::TEXT, 'MP_MATCH_RESOLVE',
          jsonb_build_object('outcome', v_m.outcome, 'resolution', p_resolution), p_reason, v_uid);
  RETURN jsonb_build_object('match_id', p_match_id, 'resolution', p_resolution);
END;
$$;

-- ── R3 mp_check_report_coverage (service role) ─────────────────────────────
-- A transition is covered by a report type when a MATCHED / DISCREPANCY / REPORT_ONLY
-- match exists from a source of that type. Coverage per report type:
--   csv_import (Liberaciones): payment APPROVAL / REFUND only once V-4 is verified
--   (while V-4 is open no payment transition can be matched, so none is reported
--   missing); report-only kinds are always matched by the report row that claimed them.
--   account_money_csv: V-3 blocked → REPORT_TYPE_NOT_SUPPORTED.
-- Idempotent: re-running a window inserts nothing new; the audit row is written only
-- when rows were inserted.
CREATE OR REPLACE FUNCTION mp_check_report_coverage(
  p_report_type VARCHAR,
  p_from        DATE,
  p_to          DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF p_report_type IS DISTINCT FROM 'csv_import' THEN
    RAISE EXCEPTION 'REPORT_TYPE_NOT_SUPPORTED: %', coalesce(p_report_type, '(null)');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_ARGUMENT: coverage window';
  END IF;

  IF mp_v4_verified() THEN
    INSERT INTO mp_report_match (outcome, transition_id, coverage_from, coverage_to, detail, is_exception)
    SELECT 'MISSING_IN_REPORT', t.id, p_from, p_to, jsonb_build_object('report_type', p_report_type), true
      FROM mp_transition_identity t
      JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
     WHERE t.resource_type = 'payment' AND t.transition IN ('APPROVAL', 'REFUND')
       AND m.occurred_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM mp_report_match x JOIN mp_source_record s ON s.id = x.report_source_id
                        WHERE x.transition_id = t.id AND x.outcome IN ('MATCHED', 'DISCREPANCY', 'REPORT_ONLY')
                          AND s.source_type = p_report_type)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  IF v_count > 0 THEN
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_report_match', p_report_type, 'MP_COVERAGE_CHECK',
            jsonb_build_object('from', p_from, 'to', p_to, 'missing', v_count), NULL, NULL);
  END IF;
  RETURN jsonb_build_object('report_type', p_report_type, 'missing_inserted', v_count, 'v4_verified', mp_v4_verified());
END;
$$;

-- ── R4 mp_record_balance_check (service role) ──────────────────────────────
CREATE OR REPLACE FUNCTION mp_record_balance_check(
  p_report_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src      mp_source_record;
  v_last     UUID;
  v_acc      UUID;
  v_reported NUMERIC(15,2);
  v_computed NUMERIC(15,2);
  v_id       UUID;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  SELECT * INTO v_src FROM mp_source_record WHERE id = p_report_source_id;
  IF NOT FOUND OR v_src.source_type <> 'csv_import' THEN
    RAISE EXCEPTION 'NOT_A_REPORT_ROW';
  END IF;
  IF coalesce(v_src.event_data->>'BALANCE_AMOUNT', '') !~ '^-?[0-9]{1,13}(\.[0-9]{1,2})?$' THEN
    RAISE EXCEPTION 'MALFORMED_BALANCE';
  END IF;
  -- day granularity: only the last report row of that day (postings are dated, not timed)
  SELECT id INTO v_last FROM mp_source_record
   WHERE source_type = 'csv_import' AND occurred_date = v_src.occurred_date
   ORDER BY occurred_at DESC, external_id DESC LIMIT 1;
  IF v_last IS DISTINCT FROM p_report_source_id THEN
    RAISE EXCEPTION 'NOT_DAY_CLOSING_ROW';
  END IF;
  SELECT id INTO v_acc FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  v_reported := (v_src.event_data->>'BALANCE_AMOUNT')::NUMERIC;
  SELECT coalesce(sum(signed_amount), 0) INTO v_computed FROM financial_posting
   WHERE financial_account_id = v_acc AND effective_date <= v_src.occurred_date;

  INSERT INTO mp_report_match (outcome, report_source_id, detail, is_exception)
  VALUES ('BALANCE_CHECK', p_report_source_id,
          jsonb_build_object('reported', v_reported, 'computed', v_computed, 'difference', v_reported - v_computed,
                             'as_of_date', v_src.occurred_date),
          (v_reported - v_computed) <> 0)
  ON CONFLICT (report_source_id, outcome) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
    VALUES ('mp_report_match', v_id::TEXT, 'MP_BALANCE_CHECK',
            jsonb_build_object('reported', v_reported, 'computed', v_computed, 'as_of_date', v_src.occurred_date), NULL, NULL);
  END IF;
  RETURN jsonb_build_object('match_id', v_id, 'created', v_id IS NOT NULL, 'reported', v_reported, 'computed', v_computed,
                            'difference', v_reported - v_computed);
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- OWNERSHIP AND EXECUTE PERIMETER (ADR006_RLS_AND_SECURITY_V1 §3)
-- ════════════════════════════════════════════════════════════════════════════
ALTER FUNCTION mp_normalize_source(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_normalize_source(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mp_normalize_source(UUID) TO service_role;

ALTER FUNCTION mp_register_delivery(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB, BOOLEAN, UUID) OWNER TO postgres;
ALTER FUNCTION mp_claim_deliveries(INTEGER, INTEGER) OWNER TO postgres;
ALTER FUNCTION mp_delivery_transition(UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, INTEGER, VARCHAR) OWNER TO postgres;
ALTER FUNCTION mp_requeue_config_blocked(TEXT) OWNER TO postgres;
ALTER FUNCTION mp_request_refetch(VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_resolve_chargeback_signal(UUID, VARCHAR, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_allocate_to_client(BIGINT, UUID, NUMERIC, DATE, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_auto_allocate(BIGINT) OWNER TO postgres;
ALTER FUNCTION mp_reverse_client_allocation(UUID, NUMERIC, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_flag_for_attribution(BIGINT, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_clear_attribution_flag(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_map_payer_to_client(VARCHAR, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_unmap_payer(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_resolve_match(UUID, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION mp_check_report_coverage(VARCHAR, DATE, DATE) OWNER TO postgres;
ALTER FUNCTION mp_record_balance_check(UUID) OWNER TO postgres;

-- service role only
REVOKE ALL ON FUNCTION mp_register_delivery(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mp_claim_deliveries(INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mp_delivery_transition(UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, INTEGER, VARCHAR) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mp_auto_allocate(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mp_check_report_coverage(VARCHAR, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION mp_record_balance_check(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mp_register_delivery(VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, JSONB, BOOLEAN, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION mp_claim_deliveries(INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION mp_delivery_transition(UUID, UUID, VARCHAR, UUID, VARCHAR, VARCHAR, INTEGER, VARCHAR) TO service_role;
GRANT EXECUTE ON FUNCTION mp_auto_allocate(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION mp_check_report_coverage(VARCHAR, DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION mp_record_balance_check(UUID) TO service_role;

-- ADMIN or service role
REVOKE ALL ON FUNCTION mp_requeue_config_blocked(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mp_requeue_config_blocked(TEXT) TO authenticated, service_role;

-- ADMIN only (checked in the body)
REVOKE ALL ON FUNCTION mp_request_refetch(VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_resolve_chargeback_signal(UUID, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_allocate_to_client(BIGINT, UUID, NUMERIC, DATE, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_reverse_client_allocation(UUID, NUMERIC, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_flag_for_attribution(BIGINT, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_clear_attribution_flag(UUID, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_map_payer_to_client(VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_unmap_payer(UUID, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION mp_resolve_match(UUID, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION mp_request_refetch(VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_resolve_chargeback_signal(UUID, VARCHAR, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_allocate_to_client(BIGINT, UUID, NUMERIC, DATE, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_reverse_client_allocation(UUID, NUMERIC, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_flag_for_attribution(BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_clear_attribution_flag(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_map_payer_to_client(VARCHAR, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_unmap_payer(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION mp_resolve_match(UUID, VARCHAR, TEXT) TO authenticated;
