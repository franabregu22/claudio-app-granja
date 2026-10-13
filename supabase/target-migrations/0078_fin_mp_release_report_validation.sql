-- ============================================================================
-- TARGET V1 — 0078 MERCADO PAGO RELEASE REPORT CAPTURE, VALIDATION MODE ONLY (ADR-018, MP branch, G-4 step 1)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md §2.3, §6.1 / §6.3 (evidence model), §9.3 (validation
--            mode), §11 (security), §12 (idempotency), §13 (immutability), §16 #17 / #18 / #19, §21 G-4;
--            ADR-003 D1 (Liberaciones parser, 15 keys) as implemented by mp_parse_report_row (0048, unchanged).
--
-- Adds ONE function (SECURITY DEFINER set 73 → 74):
--   fin_capture_mp_release_report   service_role only; the initiating actor must be an active ADMIN (checked again
--                                    here after the Edge Function). Writes ONE fin_import_run (MP_RELEASE_REPORT,
--                                    mode VALIDATION, status VALIDATED | REJECTED) and its appearances
--                                    (fin_import_run_line CAPTURED | INVALID) in one transaction. Nothing else:
--                                    no mp_source_record, no RPC 40, no back-fill, no claim, no movement, no operation,
--                                    no posting (§9.3, §16 #17).
-- Row validity is decided HERE by the frozen D1 parser itself (mp_parse_report_row over an in-memory record that is
-- never inserted) plus two capture checks: numeric SOURCE_ID on payment rows (ADR-018 §9.1 / §9.2) and a unique
-- SOURCE_ID:DESCRIPTION:direction identity inside the report. Rows without SOURCE_ID and DESCRIPTION are the report's
-- balance / total rows (ADR-003 D1: "not source events"): CAPTURED with appearance_meta.row_class = 'CONTROL'.
-- Any INVALID row, or a report with no movement row, makes the run REJECTED; its appearances are kept as evidence.
-- A file-level failure found by the Edge parser (layout, encoding, separator) arrives as p_reject_reason with no rows:
-- REJECTED run, format_code NULL, zero appearances.
--
-- Storage: the private bucket financial-statements (0074) also accepts text/csv for the MP original
-- (path mp/<mp account>/<sha256>.csv). Size limit, privacy and the single ADMIN SELECT policy are unchanged.
-- No table, view, policy, grant on tables or existing function changes. No cron, no scheduler, no NORMAL mode.
--
-- p_rows contract (JSON array, one object per data row of the CSV in file order, header excluded):
--   row_number (integer, exactly 1..n in order), raw_row (object with exactly the 15 D1 keys, every value a string).
--   Never accepted from the caller: outcome, note, row_class, destinations.
-- ============================================================================

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['application/pdf', 'text/csv']
 WHERE id = 'financial-statements';

CREATE OR REPLACE FUNCTION fin_capture_mp_release_report(
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
  v_rows     JSONB := '[]'::jsonb;    -- validated appearances with database-decided outcome / note / class
  r          JSONB;
  v_raw      JSONB;
  v_src      mp_source_record;
  v_p        RECORD;
  v_net      NUMERIC;
  v_xid      TEXT;
  v_seen     TEXT[] := ARRAY[]::TEXT[];
  v_outcome  TEXT;
  v_note     TEXT;
  v_class    TEXT;
  v_desc     TEXT;
  v_n        INTEGER := 0;
  v_moves    INTEGER := 0;
  v_captured INTEGER := 0;
  v_invalid  INTEGER := 0;
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

  -- ── attempt fields ──
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
  -- a file the Edge parser could not read carries no rows and no format; a parsed one is exactly this format
  IF (p_reject_reason IS NULL AND p_format_code IS DISTINCT FROM c_format)
     OR (p_reject_reason IS NOT NULL AND (p_format_code IS NOT NULL OR p_rows IS NOT NULL)) THEN
    RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: format_code / rows do not match the reject reason';
  END IF;

  -- ── idempotency (§6.1, §12), serialised per account and file ──
  PERFORM pg_advisory_xact_lock(hashtextextended(v_acc::TEXT || ':' || p_file_sha256, 0));

  SELECT * INTO v_run FROM fin_import_run
   WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256
     AND mode = 'VALIDATION' AND parser_version = p_parser_version;
  IF FOUND THEN
    RETURN jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'replayed', true,
      'rows_total', v_run.rows_total, 'rows_captured', v_run.rows_captured, 'rows_invalid', v_run.rows_invalid,
      'reject_reason', v_run.reject_reason);
  END IF;
  -- a new attempt over the same bytes (another parser version) links to the latest one
  SELECT * INTO v_latest FROM fin_import_run
   WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256
   ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_latest.id IS NOT NULL AND v_latest.status NOT IN ('REJECTED', 'VALIDATED') THEN
    RAISE EXCEPTION 'ALREADY_PROCESSED: run % already processed these bytes', v_latest.id;
  END IF;

  -- ── rows: the frozen D1 parser decides validity; nothing is inserted outside the evidence tables ──
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
         OR EXISTS (SELECT 1 FROM jsonb_each(v_raw) e WHERE jsonb_typeof(e.value) <> 'string') THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: raw_row must hold exactly the 15 Liberaciones keys as strings';
      END IF;

      v_outcome := 'CAPTURED'; v_note := NULL; v_class := 'MOVEMENT';
      v_desc := v_raw ->> 'DESCRIPTION';
      IF v_raw ->> 'SOURCE_ID' = '' AND v_desc = '' THEN
        v_class := 'CONTROL';     -- opening balance / totals row: not a source event (D1)
      ELSE
        v_moves := v_moves + 1;
        -- identity and dates exactly as D1 derives them; malformed values are left for the parser to report
        v_net := NULL;
        IF (v_raw ->> 'NET_CREDIT_AMOUNT') ~ c_amount AND (v_raw ->> 'NET_DEBIT_AMOUNT') ~ c_amount THEN
          v_net := (v_raw ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (v_raw ->> 'NET_DEBIT_AMOUNT')::NUMERIC;
        END IF;
        v_xid := (v_raw ->> 'SOURCE_ID') || ':' || v_desc || ':' || CASE WHEN v_net > 0 THEN 'C' ELSE 'D' END;
        IF length(v_raw ->> 'SOURCE_ID') > 40 OR length(v_desc) > 40 THEN
          v_outcome := 'INVALID'; v_note := 'IDENTITY_TOO_LONG: SOURCE_ID / DESCRIPTION exceed the identity width';
        ELSE
          v_src := NULL;
          v_src.source_type := 'csv_import';
          v_src.external_id := v_xid;
          v_src.event_data := v_raw;
          IF (v_raw ->> 'DATE') ~ c_ts THEN
            v_src.occurred_at := (v_raw ->> 'DATE')::TIMESTAMPTZ;
            v_src.occurred_date := (v_src.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
          END IF;
          SELECT * INTO v_p FROM mp_parse_report_row(v_src);
          IF v_p.o_status = 'ERROR' THEN
            v_outcome := 'INVALID'; v_note := v_p.o_note;
          ELSIF v_desc = 'payment' AND (v_raw ->> 'SOURCE_ID') !~ '^[0-9]{1,20}$' THEN
            v_outcome := 'INVALID'; v_note := 'INVALID_SOURCE_ID: a payment row needs a numeric SOURCE_ID';
          ELSIF v_xid = ANY (v_seen) THEN
            v_outcome := 'INVALID'; v_note := format('DUPLICATE_IDENTITY: %s appears twice in the report', v_xid);
          END IF;
          v_seen := v_seen || v_xid;
        END IF;
      END IF;
      IF v_outcome = 'INVALID' THEN v_invalid := v_invalid + 1; ELSE v_captured := v_captured + 1; END IF;
      v_rows := v_rows || jsonb_build_object('row_number', v_n, 'raw_row', v_raw, 'outcome', v_outcome, 'note', v_note,
                                             'row_class', v_class);
    END LOOP;
    IF v_invalid > 0 THEN
      v_reject := format('INVALID_ROWS: %s row(s) fail the Liberaciones contract', v_invalid);
    ELSIF v_moves = 0 THEN
      v_reject := 'NO_MOVEMENT_ROWS: the report has no movement row to validate';
    END IF;
  END IF;

  -- ── the run, already final, then every appearance ──
  INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path,
                              file_name, byte_size, coverage_from, coverage_to, status, reject_reason, rows_total,
                              rows_invalid, rows_captured, source_meta, previous_run_id, created_by)
  VALUES (v_run_id, 'MP_RELEASE_REPORT', 'VALIDATION', v_acc, p_format_code, p_parser_version, p_file_sha256, p_storage_path,
          left(p_file_name, 255), p_byte_size, p_coverage_from, p_coverage_to,
          CASE WHEN v_reject IS NULL THEN 'VALIDATED' ELSE 'REJECTED' END, v_reject, v_n, v_invalid, v_captured,
          p_source_meta, v_latest.id, p_actor);

  INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, appearance_meta)
  SELECT v_run_id, (e ->> 'row_number')::INTEGER, 'MP_RELEASE_REPORT', 'VALIDATION', e -> 'raw_row', e ->> 'outcome', e ->> 'note',
         jsonb_build_object('row_class', e ->> 'row_class')
    FROM jsonb_array_elements(v_rows) e;

  RETURN jsonb_build_object('run_id', v_run_id, 'status', CASE WHEN v_reject IS NULL THEN 'VALIDATED' ELSE 'REJECTED' END,
    'replayed', false, 'rows_total', v_n, 'rows_captured', v_captured, 'rows_invalid', v_invalid, 'reject_reason', v_reject);
END;
$$;
ALTER FUNCTION fin_capture_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_capture_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fin_capture_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) TO service_role;
