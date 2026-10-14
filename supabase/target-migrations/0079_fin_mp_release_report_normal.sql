-- ============================================================================
-- TARGET V1 — 0079 MERCADO PAGO RELEASE REPORT, NORMAL MODE + REPORT BACK-FILL (ADR-018, MP branch)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md §2.3, §6.1 / §6.3, §9.1 (NORMAL flow), §9.2 (cases),
--            §10 (ADR-006 amendment: inbound report-payment back-fill by a NEW service_role function), §12, §15
--            (coverage), §16 #2 / #3 / #5 / #16, §21 G-4 (PASS in production, 2026-10-13);
--            ADR-006 §8 (report reconciliation) and ADR006_WEBHOOK_WORKER_DESIGN_V1 (yield applied by A1; payout waits
--            for the ADMIN transfer link); ADR-017 (mp_cutover_boundary is the only MP cut authority).
--
-- Adds (SECURITY DEFINER set 74 → 76):
--   mp_register_report_backfill(source)  service_role only. For ONE csv_import report row that is an inbound payment
--                                         (DESCRIPTION payment, direction C, numeric SOURCE_ID), still PENDING after
--                                         RPC 40 (i.e. parked DEFERRED_V4 — not IGNORED by ADR-017, not ERROR), at or
--                                         after the cutover boundary, and whose ('payment', SOURCE_ID, 'APPROVAL', '')
--                                         is not yet claimed: registers exactly one mp_webhook_delivery
--                                         origin = 'report_backfill', topic_class payment, resource_id = SOURCE_ID,
--                                         report_source_id = the row, deterministic key 'report:payment:<SOURCE_ID>'.
--                                         Already claimed / already requested → no-op. It creates no money: the
--                                         unchanged worker fetches GET /v1/payments/{id} → S4 → RPC 40 → claim → A1.
--   fin_ingest_mp_release_report(...)     service_role only, actor = active ADMIN; same signature / p_rows contract as
--                                         fin_capture_mp_release_report (0078, unchanged). One fin_import_run
--                                         MP_RELEASE_REPORT / NORMAL (PARSED | REJECTED) per file:
--                                           * row validity by the frozen D1 parser (as 0078); any INVALID row, or no
--                                             movement row → REJECTED, nothing reaches mp_source_record (fail closed);
--                                           * CONTROL rows (no SOURCE_ID / DESCRIPTION) → appearance IGNORED;
--                                           * movement rows → mp_source_record csv_import (unique (source_type,
--                                             external_id): NEW or ALREADY_KNOWN) → RPC 40 for NEW rows, UNCHANGED:
--                                             payment parked DEFERRED_V4; pre-cutover IGNORED (ADR-017); reserve
--                                             IGNORED; yield / payout claim + movement + REPORT_ONLY;
--                                           * inbound payment rows → mp_register_report_backfill (NEW and
--                                             ALREADY_KNOWN; idempotent);
--                                           * a NEW yield movement → A1 mp_apply_transition (the frozen auto-applicable
--                                             pair yield / YIELD, 0052), isolated: a refusal (e.g. PERIOD_CLOSED) is
--                                             recorded on the appearance (review_code YIELD_NOT_APPLIED) and never
--                                             aborts the ingestion; payout is never applied (waits for the ADMIN
--                                             transfer link); outbound payments stay parked (V-4).
--                                         Serialised by one transaction-level advisory lock for all MP report ingestion.
--   view fin_mp_report_activity           read-only coverage per appearance of NORMAL runs (§15), ADMIN only.
-- Unchanged: 0078 (VALIDATION), RPC 40, mp_register_delivery, the worker / webhook contracts, mp_v4_verified() (false),
-- mp_normalize_report_fallback (still refused while V-4 is false), cron (no job added), Storage.
-- ============================================================================

-- ── report back-fill (ADR-018 §10) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_register_report_backfill(
  p_report_source_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src  mp_source_record;
  v_cut  TIMESTAMPTZ;
  v_sid  TEXT;
  v_key  VARCHAR(200);
  v_hash CHAR(64);
  v_id   UUID;
  v_ex   mp_webhook_delivery;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  SELECT * INTO v_src FROM mp_source_record WHERE id = p_report_source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOURCE_NOT_FOUND';
  END IF;
  v_sid := v_src.event_data ->> 'SOURCE_ID';
  IF v_src.source_type <> 'csv_import' OR (v_src.event_data ->> 'DESCRIPTION') IS DISTINCT FROM 'payment'
     OR v_src.external_id IS DISTINCT FROM (v_sid || ':payment:C') THEN
    RAISE EXCEPTION 'NOT_INBOUND_REPORT_PAYMENT: only inbound (direction C) report payment rows are back-filled';
  END IF;
  IF v_sid IS NULL OR v_sid !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID: a back-fill needs a numeric SOURCE_ID';
  END IF;
  SELECT cutover_at INTO v_cut FROM mp_cutover_boundary;
  IF v_cut IS NULL THEN
    RAISE EXCEPTION 'CUTOVER_BOUNDARY_MISSING';
  END IF;
  IF v_src.processing_status <> 'PENDING' OR v_src.occurred_at < v_cut THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE: the row is % (pre-cutover rows and processed rows are never back-filled)', v_src.processing_status;
  END IF;
  -- first claimant wins: an APPROVAL already claimed (webhook / API first) needs no back-fill
  IF EXISTS (SELECT 1 FROM mp_transition_identity WHERE resource_type = 'payment' AND resource_id = v_sid
                AND transition = 'APPROVAL' AND transition_ref = '') THEN
    RETURN jsonb_build_object('created', false, 'reason', 'ALREADY_CLAIMED', 'delivery_id', NULL);
  END IF;

  v_key := 'report:payment:' || v_sid;
  v_hash := encode(sha256(convert_to((jsonb_build_array('report_backfill', 'payment', 'payment', NULL, v_sid, '{}'::jsonb))::text, 'UTF8')), 'hex');
  INSERT INTO mp_webhook_delivery (delivery_key, notification_sha256, origin, topic, topic_class, resource_id,
                                   notification_payload, signature_verified, report_source_id, status)
  VALUES (v_key, v_hash, 'report_backfill', 'payment', 'payment', v_sid, '{}'::jsonb, false, v_src.id, 'RECEIVED')
  ON CONFLICT (delivery_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT * INTO v_ex FROM mp_webhook_delivery WHERE delivery_key = v_key;
    RETURN jsonb_build_object('created', false, 'reason', 'ALREADY_REQUESTED', 'delivery_id', v_ex.id);
  END IF;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_webhook_delivery', v_id::TEXT, 'MP_DELIVERY_REGISTER',
          jsonb_build_object('origin', 'report_backfill', 'topic_class', 'payment', 'status', 'RECEIVED', 'key_conflict', false,
                             'report_source_id', v_src.id),
          NULL, NULL);
  RETURN jsonb_build_object('created', true, 'reason', 'REQUESTED', 'delivery_id', v_id);
END;
$$;
ALTER FUNCTION mp_register_report_backfill(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_register_report_backfill(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mp_register_report_backfill(UUID) TO service_role;

-- ── NORMAL ingestion (ADR-018 §9.1) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fin_ingest_mp_release_report(
  p_actor          UUID,
  p_parser_version TEXT,
  p_format_code    TEXT,
  p_file_sha256    TEXT,
  p_storage_path   TEXT,
  p_file_name      TEXT,
  p_byte_size      BIGINT,
  p_coverage_from  DATE,
  p_coverage_to    DATE,
  p_source_meta    JSONB,
  p_reject_reason  TEXT,
  p_rows           JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_format  CONSTANT TEXT := 'MP_RELEASE_REPORT_CSV_V1';
  c_keys    CONSTANT TEXT[] := ARRAY['BALANCE_AMOUNT','BUSINESS_UNIT','DATE','DESCRIPTION','GROSS_AMOUNT',
    'MP_FEE_AMOUNT','NET_CREDIT_AMOUNT','NET_DEBIT_AMOUNT','PAYMENT_METHOD','PAYMENT_METHOD_TYPE',
    'PURCHASE_ID','SOURCE_ID','SUB_UNIT','TAXES_AMOUNT','TRANSACTION_APPROVAL_DATE'];
  c_amount  CONSTANT TEXT := '^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
  c_ts      CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
  v_acc      UUID;
  v_run      fin_import_run;
  v_latest   fin_import_run;
  v_run_id   UUID := gen_random_uuid();
  v_reject   TEXT := p_reject_reason;
  v_rows     JSONB := '[]'::jsonb;    -- validated rows with database-decided class / identity / outcome
  r          JSONB;
  e          JSONB;
  v_raw      JSONB;
  v_src      mp_source_record;
  v_p        RECORD;
  v_net      NUMERIC;
  v_xid      TEXT;
  v_seen     TEXT[] := ARRAY[]::TEXT[];
  v_invalid  BOOLEAN;
  v_note     TEXT;
  v_desc     TEXT;
  v_known    UUID;
  v_sid      UUID;
  v_status   mp_processing_status;
  v_mv       BIGINT;
  v_review   TEXT;
  v_bf       JSONB;
  v_n        INTEGER := 0;
  v_moves    INTEGER := 0;
  v_ninv     INTEGER := 0;
  v_new      INTEGER := 0;
  v_old      INTEGER := 0;
  v_ctl      INTEGER := 0;
  v_bf_new   INTEGER := 0;
  v_bf_skip  INTEGER := 0;
  v_yield    INTEGER := 0;
  v_yield_ko INTEGER := 0;
BEGIN
  -- ── caller, actor, account ──
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM perfiles WHERE id = p_actor AND activo AND rol_type = 'ADMIN') THEN
    RAISE EXCEPTION 'FORBIDDEN: the initiating actor is not an active ADMIN';
  END IF;
  SELECT id INTO v_acc FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  -- ── attempt fields (identical contract to 0078) ──
  IF p_parser_version IS NULL OR btrim(p_parser_version) = '' THEN
    RAISE EXCEPTION 'PARSER_VERSION_REQUIRED';
  END IF;
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_FILE_SHA256';
  END IF;
  IF p_storage_path IS DISTINCT FROM ('mp/' || v_acc::TEXT || '/' || p_file_sha256 || '.csv') THEN
    RAISE EXCEPTION 'EVIDENCE_PATH_INVALID: the original must be stored at mp/<account>/<sha256>.csv';
  END IF;
  IF p_file_name IS NULL OR btrim(p_file_name) = '' OR p_byte_size IS NULL OR p_byte_size <= 0 THEN
    RAISE EXCEPTION 'INVALID_FILE_METADATA';
  END IF;
  IF p_coverage_from IS NULL OR p_coverage_to IS NULL OR p_coverage_from > p_coverage_to THEN
    RAISE EXCEPTION 'INVALID_COVERAGE';
  END IF;
  IF p_source_meta IS NULL OR jsonb_typeof(p_source_meta) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_META';
  END IF;
  IF p_reject_reason IS NOT NULL AND btrim(p_reject_reason) = '' THEN
    RAISE EXCEPTION 'REJECT_REASON_BLANK';
  END IF;
  IF (p_reject_reason IS NULL AND p_format_code IS DISTINCT FROM c_format)
     OR (p_reject_reason IS NOT NULL AND (p_format_code IS NOT NULL OR p_rows IS NOT NULL)) THEN
    RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: format_code / rows do not match the reject reason';
  END IF;

  -- ── one MP report ingestion at a time (report rows of different files may overlap) ──
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_mp_release_report_normal', 0));

  -- ── idempotency (§6.1, §12): same attempt, or an effective NORMAL run of these bytes → replay ──
  SELECT * INTO v_run FROM fin_import_run
   WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256 AND mode = 'NORMAL' AND parser_version = p_parser_version;
  IF NOT FOUND THEN
    SELECT * INTO v_run FROM fin_import_run
     WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256 AND mode = 'NORMAL' AND status <> 'REJECTED';
  END IF;
  IF FOUND THEN
    RETURN jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'replayed', true, 'rows_total', v_run.rows_total,
      'lines_new', v_run.lines_new, 'lines_known', v_run.lines_known, 'rows_ignored', v_run.rows_ignored,
      'rows_invalid', v_run.rows_invalid, 'reject_reason', v_run.reject_reason);
  END IF;
  -- the NORMAL attempt links to the latest attempt over the same bytes (e.g. the VALIDATION run, §9.3)
  SELECT * INTO v_latest FROM fin_import_run
   WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256
   ORDER BY created_at DESC, id DESC LIMIT 1;

  -- ── pass 1: validate every row with the frozen D1 parser; decide class and identity ──
  IF v_reject IS NULL THEN
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: rows must be a JSON array';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
      v_n := v_n + 1;
      IF jsonb_typeof(r) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM ARRAY['raw_row', 'row_number'] THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: every row is exactly {row_number, raw_row}';
      END IF;
      IF jsonb_typeof(r -> 'row_number') IS DISTINCT FROM 'number' OR (r ->> 'row_number') IS DISTINCT FROM v_n::TEXT THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: row_number must be 1..n in file order';
      END IF;
      v_raw := r -> 'raw_row';
      IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object'
         OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_raw) k) IS DISTINCT FROM c_keys
         OR EXISTS (SELECT 1 FROM jsonb_each(v_raw) x WHERE jsonb_typeof(x.value) <> 'string') THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: raw_row must hold exactly the 15 Liberaciones keys as strings';
      END IF;
      v_desc := v_raw ->> 'DESCRIPTION';
      IF v_raw ->> 'SOURCE_ID' = '' AND v_desc = '' THEN
        v_ctl := v_ctl + 1;
        v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'CONTROL');
        CONTINUE;
      END IF;
      v_moves := v_moves + 1;
      v_invalid := false; v_note := NULL; v_xid := NULL; v_src := NULL;
      v_net := NULL;
      IF (v_raw ->> 'NET_CREDIT_AMOUNT') ~ c_amount AND (v_raw ->> 'NET_DEBIT_AMOUNT') ~ c_amount THEN
        v_net := (v_raw ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (v_raw ->> 'NET_DEBIT_AMOUNT')::NUMERIC;
      END IF;
      v_xid := (v_raw ->> 'SOURCE_ID') || ':' || v_desc || ':' || CASE WHEN v_net > 0 THEN 'C' ELSE 'D' END;
      IF length(v_raw ->> 'SOURCE_ID') > 40 OR length(v_desc) > 40 THEN
        v_invalid := true; v_note := 'IDENTITY_TOO_LONG: SOURCE_ID / DESCRIPTION exceed the identity width';
      ELSE
        v_src.source_type := 'csv_import';
        v_src.external_id := v_xid;
        v_src.event_data := v_raw;
        IF (v_raw ->> 'DATE') ~ c_ts THEN
          v_src.occurred_at := (v_raw ->> 'DATE')::TIMESTAMPTZ;
          v_src.occurred_date := (v_src.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
        END IF;
        SELECT * INTO v_p FROM mp_parse_report_row(v_src);
        IF v_p.o_status = 'ERROR' THEN
          v_invalid := true; v_note := v_p.o_note;
        ELSIF v_desc = 'payment' AND (v_raw ->> 'SOURCE_ID') !~ '^[0-9]{1,20}$' THEN
          v_invalid := true; v_note := 'INVALID_SOURCE_ID: a payment row needs a numeric SOURCE_ID';
        ELSIF v_xid = ANY (v_seen) THEN
          v_invalid := true; v_note := format('DUPLICATE_IDENTITY: %s appears twice in the report', v_xid);
        END IF;
        v_seen := v_seen || v_xid;
      END IF;
      IF v_invalid THEN v_ninv := v_ninv + 1; END IF;
      v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'MOVEMENT', 'xid', v_xid, 'invalid', v_invalid,
                                             'note', v_note, 'at', v_src.occurred_at, 'date', v_src.occurred_date);
    END LOOP;
    IF v_ninv > 0 THEN
      v_reject := format('INVALID_ROWS: %s row(s) fail the Liberaciones contract', v_ninv);
    ELSIF v_moves = 0 THEN
      v_reject := 'NO_MOVEMENT_ROWS: the report has no movement row';
    END IF;
  END IF;

  -- ── REJECTED: the run and its appearances as evidence; nothing reaches mp_source_record ──
  IF v_reject IS NOT NULL THEN
    INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path,
                                file_name, byte_size, coverage_from, coverage_to, status, reject_reason, rows_total, rows_ignored,
                                rows_invalid, source_meta, previous_run_id, created_by)
    VALUES (v_run_id, 'MP_RELEASE_REPORT', 'NORMAL', v_acc, p_format_code, p_parser_version, p_file_sha256, p_storage_path,
            left(p_file_name, 255), p_byte_size, p_coverage_from, p_coverage_to, 'REJECTED', v_reject, v_n, v_n - v_ninv, v_ninv,
            p_source_meta, v_latest.id, p_actor);
    INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, appearance_meta)
    SELECT v_run_id, (x ->> 'n')::INTEGER, 'MP_RELEASE_REPORT', 'NORMAL', x -> 'raw',
           CASE WHEN (x ->> 'invalid')::BOOLEAN THEN 'INVALID' ELSE 'IGNORED' END,
           CASE WHEN (x ->> 'invalid')::BOOLEAN THEN x ->> 'note' ELSE 'RUN_REJECTED' END,
           jsonb_build_object('row_class', x ->> 'class')
      FROM jsonb_array_elements(v_rows) x;
    RETURN jsonb_build_object('run_id', v_run_id, 'status', 'REJECTED', 'replayed', false, 'rows_total', v_n,
      'lines_new', 0, 'lines_known', 0, 'rows_ignored', v_n - v_ninv, 'rows_invalid', v_ninv, 'reject_reason', v_reject,
      'backfills_created', 0, 'backfills_existing', 0, 'yields_applied', 0, 'yields_not_applied', 0);
  END IF;

  -- ── outcome of every movement row (NEW / ALREADY_KNOWN), decided under the lock ──
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) WHERE value ->> 'class' = 'MOVEMENT' LOOP
    IF EXISTS (SELECT 1 FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = e ->> 'xid') THEN
      v_old := v_old + 1;
    ELSE
      v_new := v_new + 1;
    END IF;
  END LOOP;

  INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path,
                              file_name, byte_size, coverage_from, coverage_to, status, rows_total, lines_new, lines_known,
                              rows_ignored, source_meta, previous_run_id, created_by)
  VALUES (v_run_id, 'MP_RELEASE_REPORT', 'NORMAL', v_acc, p_format_code, p_parser_version, p_file_sha256, p_storage_path,
          left(p_file_name, 255), p_byte_size, p_coverage_from, p_coverage_to, 'PARSED', v_n, v_new, v_old, v_ctl,
          p_source_meta, v_latest.id, p_actor);

  -- ── pass 2: every row → source (if new) → RPC 40 (unchanged) → back-fill / yield application → appearance ──
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    IF e ->> 'class' = 'CONTROL' THEN
      INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, appearance_meta)
      VALUES (v_run_id, (e ->> 'n')::INTEGER, 'MP_RELEASE_REPORT', 'NORMAL', e -> 'raw', 'IGNORED', 'CONTROL_ROW',
              jsonb_build_object('row_class', 'CONTROL'));
      CONTINUE;
    END IF;
    v_review := NULL; v_note := NULL; v_mv := NULL;
    SELECT id INTO v_known FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = e ->> 'xid';
    IF v_known IS NULL THEN
      INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
      VALUES ('csv_import', e ->> 'xid', e -> 'raw', (e ->> 'at')::TIMESTAMPTZ, (e ->> 'date')::DATE)
      RETURNING id INTO v_sid;
      PERFORM mp_normalize_source(v_sid);   -- RPC 40, unchanged: claims / parks / ignores exactly as frozen
      -- yield: the frozen auto-applicable pair (0052) is applied by A1, isolated from the ingestion
      SELECT m.id INTO v_mv FROM mp_financial_movement m WHERE m.mp_source_record_id = v_sid AND m.movement_kind = 'yield';
      IF v_mv IS NOT NULL THEN
        BEGIN
          PERFORM mp_apply_transition(v_mv);
          v_yield := v_yield + 1;
        EXCEPTION WHEN OTHERS THEN
          v_yield_ko := v_yield_ko + 1;
          v_review := 'YIELD_NOT_APPLIED';
          v_note := left(split_part(SQLERRM, ':', 1), 100);
        END;
      END IF;
    ELSE
      v_sid := v_known;
      IF (SELECT event_data FROM mp_source_record WHERE id = v_sid) IS DISTINCT FROM e -> 'raw' THEN
        v_review := 'CONTENT_DIFFERS';
        v_note := 'the report row differs from the stored source with the same identity (stored source kept)';
      END IF;
    END IF;
    -- inbound payment still parked after RPC 40 (not pre-cutover, not ERROR) → report back-fill (idempotent)
    SELECT processing_status INTO v_status FROM mp_source_record WHERE id = v_sid;
    IF e ->> 'xid' LIKE '%:payment:C' AND v_status = 'PENDING' THEN
      v_bf := mp_register_report_backfill(v_sid);
      IF (v_bf ->> 'created')::BOOLEAN THEN v_bf_new := v_bf_new + 1; ELSE v_bf_skip := v_bf_skip + 1; END IF;
    END IF;
    INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, mp_source_record_id,
                                     appearance_meta, review_code)
    VALUES (v_run_id, (e ->> 'n')::INTEGER, 'MP_RELEASE_REPORT', 'NORMAL', e -> 'raw',
            CASE WHEN v_known IS NULL THEN 'NEW' ELSE 'ALREADY_KNOWN' END, v_note, v_sid,
            jsonb_build_object('row_class', 'MOVEMENT'), v_review);
  END LOOP;

  RETURN jsonb_build_object('run_id', v_run_id, 'status', 'PARSED', 'replayed', false, 'rows_total', v_n,
    'lines_new', v_new, 'lines_known', v_old, 'rows_ignored', v_ctl, 'rows_invalid', 0, 'reject_reason', NULL,
    'backfills_created', v_bf_new, 'backfills_existing', v_bf_skip, 'yields_applied', v_yield, 'yields_not_applied', v_yield_ko);
END;
$$;
ALTER FUNCTION fin_ingest_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_ingest_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fin_ingest_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) TO service_role;

-- ── coverage / activity view (ADR-018 §15) ─────────────────────────────────
-- One row per appearance of a NORMAL, non-rejected MP report run. Pattern of 0055 / 0076: security_invoker = true
-- (base-table RLS applies) and an explicit ADMIN filter. coverage_status:
--   CONTROL            opening-balance / totals row of the report (not a movement)
--   PRE_CUTOVER        row before mp_cutover_boundary: included in the opening balance (ADR-017), no effect
--   RESERVE            MP internal reserve row (IGNORED by RPC 40)
--   COVERED            inbound payment whose APPROVAL was claimed without a report back-fill (webhook / API first)
--   BACKFILL_PROCESSED inbound payment claimed after the report back-fill was fetched
--   BACKFILL_PENDING   inbound payment, back-fill queued / retrying, not yet claimed
--   EXCEPTION          RPC 40 ERROR, back-fill FAILED_PERMANENT, fetched without a claim, or no back-fill
--   YIELD              asset_management (rendimiento); financial_operation_id set once A1 applied it
--   PAYOUT             retiro: movement recorded, never auto-applied (waits for the ADMIN transfer link)
--   OUTBOUND           outbound payment (direction D): parked while V-4 is open, no effect
CREATE VIEW fin_mp_report_activity
WITH (security_invoker = true)
AS
WITH a AS (
  SELECT l.run_id, l.row_number, l.raw_row, l.outcome, l.review_code, l.mp_source_record_id, l.appearance_meta ->> 'row_class' AS row_class,
         r.financial_account_id, r.coverage_from, r.coverage_to
    FROM fin_import_run_line l
    JOIN fin_import_run r ON r.id = l.run_id
   WHERE r.source_kind = 'MP_RELEASE_REPORT' AND r.mode = 'NORMAL' AND r.status = 'PARSED'
), s AS (
  SELECT a.*, src.processing_status, src.processing_note, src.occurred_at, src.occurred_date, src.external_id,
         (SELECT t.id FROM mp_transition_identity t
           WHERE t.resource_type = 'payment' AND t.resource_id = a.raw_row ->> 'SOURCE_ID' AND t.transition = 'APPROVAL'
             AND t.transition_ref = '' AND (a.raw_row ->> 'DESCRIPTION') = 'payment') AS approval_id,
         (SELECT d.status::TEXT FROM mp_webhook_delivery d WHERE d.report_source_id = a.mp_source_record_id
           ORDER BY d.received_at DESC LIMIT 1) AS backfill_status
    FROM a LEFT JOIN mp_source_record src ON src.id = a.mp_source_record_id
)
SELECT s.run_id, s.row_number, s.financial_account_id,
       s.occurred_at,
       coalesce(s.occurred_date, s.coverage_from) AS business_date,
       nullif(s.raw_row ->> 'DESCRIPTION', '') AS description,
       nullif(s.raw_row ->> 'SOURCE_ID', '') AS source_id,
       CASE WHEN s.row_class = 'MOVEMENT'
            THEN (s.raw_row ->> 'NET_CREDIT_AMOUNT')::NUMERIC(15,2) - (s.raw_row ->> 'NET_DEBIT_AMOUNT')::NUMERIC(15,2) END AS net_amount,
       CASE WHEN s.row_class = 'MOVEMENT' THEN (s.raw_row ->> 'GROSS_AMOUNT')::NUMERIC(15,2) END AS gross_amount,
       nullif(s.raw_row ->> 'PAYMENT_METHOD', '') AS payment_method,
       nullif(s.raw_row ->> 'PAYMENT_METHOD_TYPE', '') AS payment_method_type,
       s.outcome AS appearance_outcome, s.review_code, s.mp_source_record_id, s.processing_status::TEXT AS processing_status,
       s.backfill_status,
       CASE
         WHEN s.row_class = 'CONTROL' THEN 'CONTROL'
         WHEN s.processing_status = 'IGNORED' AND s.processing_note LIKE 'PRE\_CUTOVER%' THEN 'PRE_CUTOVER'
         WHEN s.processing_status = 'ERROR' THEN 'EXCEPTION'
         WHEN s.raw_row ->> 'DESCRIPTION' IN ('reserve_for_payment', 'reserve_for_payout') THEN 'RESERVE'
         WHEN s.raw_row ->> 'DESCRIPTION' = 'asset_management' THEN 'YIELD'
         WHEN s.raw_row ->> 'DESCRIPTION' = 'payout' THEN 'PAYOUT'
         WHEN s.raw_row ->> 'DESCRIPTION' = 'payment' AND s.external_id LIKE '%:D' THEN 'OUTBOUND'
         WHEN s.raw_row ->> 'DESCRIPTION' = 'payment' AND s.approval_id IS NOT NULL
              THEN CASE WHEN s.backfill_status = 'FETCHED' THEN 'BACKFILL_PROCESSED' ELSE 'COVERED' END
         WHEN s.raw_row ->> 'DESCRIPTION' = 'payment' AND s.backfill_status IN ('RECEIVED', 'PROCESSING', 'FAILED_RETRYABLE', 'CONFIG_BLOCKED')
              THEN 'BACKFILL_PENDING'
         ELSE 'EXCEPTION'
       END AS coverage_status,
       (SELECT min(rc.financial_operation_id) FROM mp_transition_identity t
          JOIN mp_reconciliation rc ON rc.mp_financial_movement_id = t.mp_financial_movement_id
         WHERE t.id = s.approval_id
            OR (s.raw_row ->> 'DESCRIPTION' IN ('asset_management', 'payout') AND t.resource_type = 'report'
                AND t.resource_id = s.external_id)) AS financial_operation_id
  FROM s
 WHERE (SELECT current_app_role()) = 'ADMIN';

ALTER VIEW fin_mp_report_activity OWNER TO postgres;
REVOKE ALL    ON fin_mp_report_activity FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_report_activity TO authenticated;
