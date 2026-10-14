-- ============================================================================
-- TARGET V1 — 0081 MERCADO PAGO DAILY RELEASE REPORT — SUPPORT ONLY (ADR-018 §9.1, owner GO 2026-10-14)
-- Authority: ADR-018 §9.1 ("the scheduler invokes the MP report-ingest … daily for the previous Buenos Aires day"),
--            §6.1 (created_by NULL for the scheduler), §11 (service role only), §12 (idempotency), §15 (observability).
--
-- Support for the daily scheduled run; it does NOT schedule anything. No cron job is created here: activation is a
-- separate, owner-approved migration (cron.schedule of 'mp_release_report_daily', the statement kept in
-- scripts/target-db/mp_report_daily_schedule.sql). The existing job 'mp_worker_every_minute' is untouched.
--
--   1. fin_ingest_mp_release_report — the 0080 body with exactly one change [0081]: p_actor NULL is accepted (the
--      scheduler, through the service-role-only Edge Function mp-report-daily); the run is recorded with
--      created_by NULL. A non-NULL actor must still be an active ADMIN. Same signature, owner, grants.
--   2. fin_mp_report_schedule_log — one append-only row per scheduled execution: target_date, outcome
--      (SUCCESS | SUCCESS_EMPTY | ALREADY_PROCESSED | FAILED), run_id, task_id, error_code, summary (row classes and
--      effects only: no report content, no payer data). Immutable (fin_evidence_immutable_guard); RLS: SELECT for an
--      ADMIN and for service_role (the scheduler reads the last outcome of a day to resume a timed-out MP task).
--   3. fin_record_mp_report_schedule — SECURITY DEFINER, service_role only: validates and inserts one log row.
-- SECURITY DEFINER set 76 → 77.
-- ============================================================================

-- ── 1. NORMAL ingestion: the scheduler may call it without a user actor ────
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
  -- [0081] p_actor NULL = the daily scheduler (mp-report-daily, service_role; created_by NULL, ADR-018 §6.1);
  --        a non-NULL actor must still be an active ADMIN
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM perfiles WHERE id = p_actor AND activo AND rol_type = 'ADMIN') THEN
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
        IF fin_mp_control_row_valid(v_raw) THEN   -- [0080] a control row must itself be well-formed
          v_ctl := v_ctl + 1;
          v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'CONTROL', 'invalid', false);
        ELSE
          v_ninv := v_ninv + 1;
          v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'CONTROL', 'invalid', true,
                                                 'note', 'INVALID_CONTROL_ROW: control row amounts / DATE / empty fields do not match the layout');
        END IF;
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
    END IF;   -- [0080] a valid report without movement rows is PARSED with 0 effects (owner decision 2026-10-14)
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

-- ── 2. scheduler log ─────────────────────────────────────────────────────────
CREATE TABLE fin_mp_report_schedule_log (
  id          BIGSERIAL PRIMARY KEY,
  target_date DATE        NOT NULL,
  outcome     VARCHAR(20) NOT NULL,
  run_id      UUID REFERENCES fin_import_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  task_id     VARCHAR(20),
  error_code  VARCHAR(80),
  summary     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mrsl_outcome  CHECK (outcome IN ('SUCCESS', 'SUCCESS_EMPTY', 'ALREADY_PROCESSED', 'FAILED')),
  CONSTRAINT chk_mrsl_error    CHECK ((outcome = 'FAILED') = (error_code IS NOT NULL AND btrim(error_code) <> '')),
  CONSTRAINT chk_mrsl_run      CHECK (outcome = 'FAILED' OR run_id IS NOT NULL),
  CONSTRAINT chk_mrsl_task     CHECK (task_id IS NULL OR task_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_mrsl_summary  CHECK (jsonb_typeof(summary) = 'object')
);
ALTER TABLE fin_mp_report_schedule_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mrsl_target ON fin_mp_report_schedule_log(target_date, created_at);
CREATE TRIGGER trg_fin_mp_report_schedule_log_immutable
  BEFORE UPDATE OR DELETE ON fin_mp_report_schedule_log
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE fin_mp_report_schedule_log FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE fin_mp_report_schedule_log TO authenticated, service_role;
REVOKE ALL ON SEQUENCE fin_mp_report_schedule_log_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY fin_mp_schedule_admin_select ON fin_mp_report_schedule_log
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY fin_mp_schedule_service_select ON fin_mp_report_schedule_log
  FOR SELECT USING (auth.role() = 'service_role');

-- ── 3. record one scheduled execution ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fin_record_mp_report_schedule(
  p_target_date DATE,
  p_outcome     TEXT,
  p_run_id      UUID,
  p_task_id     TEXT,
  p_error_code  TEXT,
  p_summary     JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_keys CONSTANT TEXT[] := ARRAY['backfills_created', 'backfills_existing', 'control', 'payments_in', 'payments_out', 'payouts',
                                  'reserves', 'rows', 'yields', 'yields_applied', 'yields_not_applied'];
  v_id   BIGINT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF p_target_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_TARGET_DATE';
  END IF;
  -- only counters: every key known, every value a non-negative integer
  IF p_summary IS NULL OR jsonb_typeof(p_summary) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(p_summary) e WHERE e.key <> ALL (c_keys) OR jsonb_typeof(e.value) <> 'number' OR (e.value)::TEXT !~ '^[0-9]{1,9}$') THEN
    RAISE EXCEPTION 'INVALID_SUMMARY: counters only';
  END IF;
  IF p_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_import_run WHERE id = p_run_id AND source_kind = 'MP_RELEASE_REPORT'
                                                AND coverage_from = p_target_date) THEN
    RAISE EXCEPTION 'RUN_MISMATCH: the run is not an MP report run for the target date';
  END IF;
  BEGIN
    INSERT INTO fin_mp_report_schedule_log (target_date, outcome, run_id, task_id, error_code, summary)
    VALUES (p_target_date, p_outcome, p_run_id, nullif(btrim(p_task_id), ''), left(nullif(btrim(p_error_code), ''), 80), p_summary)
    RETURNING id INTO v_id;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'INVALID_SCHEDULE_RECORD: %', SQLERRM;
  END;
  RETURN v_id;
END;
$$;
ALTER FUNCTION fin_record_mp_report_schedule(DATE, TEXT, UUID, TEXT, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_record_mp_report_schedule(DATE, TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fin_record_mp_report_schedule(DATE, TEXT, UUID, TEXT, TEXT, JSONB) TO service_role;
