-- ============================================================================
-- TARGET V1 — 0075 FINANCIAL STATEMENT FUNCTIONS (ADR-018, bank branch, step 3)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md §6 (evidence model, K-4 anchor rule),
--            §7 (ingestion), §7.1 (exact description_norm, fingerprint hashing, INVALID precedence),
--            §7.2 / §7.3 (frozen adapters BNA_MONTHLY_PDF_V1 / PATAGONIA_STATEMENT_PDF_V1), §8 (reconciliation),
--            §11 (security), §12 (idempotency), §14 (cutover), §17 (failure handling).
--            Tables 0073 (06e691d), privileges / storage / config seed 0074 (df48efb).
--
-- Helpers (SECURITY INVOKER, IMMUTABLE, search_path = pg_catalog; no application-role EXECUTE):
--   fin_norm_description(text)      the single production authority for description_norm (§7.1)
--   fin_statement_fingerprint(...)  the frozen per-adapter fingerprint; built-in sha256(bytea) over UTF-8,
--                                   fields joined with U+001F; format_code selects the formula, never hashed
-- Functions (SECURITY DEFINER, owner postgres, search_path = public): the SECURITY DEFINER set grows 69 → 73.
--   fin_import_bank_statement       service_role only; validates completely, then writes the run already final,
--                                   its new lines and every appearance in one transaction (runs, lines and
--                                   appearances are immutable since 0073)
--   fin_match_statement_line        ADMIN; 1 line ↔ 1 posting of the same account, exact amount, POST_CUTOVER only
--   fin_reverse_statement_match     ADMIN; append-only reversal with mandatory reason
--   fin_resolve_statement_cutover   ADMIN; K-4 anchor rule, Patagonia same-day ambiguity, audited supersession
--
-- No table, grant on tables, view, Storage object or existing function changes. Bank cut decisions never use
-- the global cutover instant or the Mercado Pago cutover boundary.
--
-- p_rows contract of fin_import_bank_statement (JSON array; one object per physical row of the statement):
--   common:   row_number (integer > 0, unique), kind ('ECONOMIC' | 'CONTROL' | 'DETAIL'), raw_row (object),
--             appearance_meta (object, optional), review_code (non-blank string, optional), note (string, optional)
--   ECONOMIC: statement_position (integer 1..n, consecutive in row_number order), value_date ('YYYY-MM-DD'),
--             description_raw (string), bank_reference (string, optional → ''), fecha_valor ('YYYY-MM-DD',
--             optional), signed_amount (canonical '-?d+.dd'), running_balance (canonical, optional)
--   CONTROL:  control_type (non-blank string, e.g. SALDO_ANTERIOR, SALDO_FINAL, SALDO_ACTUAL, TRANSPORTE, TOTAL),
--             balance (canonical, optional; a TRANSPORTE balance must equal the running balance at that point)
--   DETAIL:   secondary detail rows (Patagonia TRANSFERENCIAS RECIBIDAS); never create a statement line
--   Never accepted from the caller: description_norm, fingerprint, outcome, statement_line_id, mp_source_record_id.
-- p_source_meta: object with opening_balance and closing_balance (canonical strings); other keys are kept.
-- A malformed contract (types, keys, duplicate row numbers) is a caller defect → exception, nothing persisted.
-- A statement-content failure (§7.1–§7.3, §17) → a persisted REJECTED run with zero lines and zero appearances.
-- ============================================================================

-- ── helper: exact description_norm (§7.1) ──────────────────────────────────
CREATE OR REPLACE FUNCTION fin_norm_description(p_text TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  v TEXT;
BEGIN
  -- 1. Unicode NFKD
  v := normalize(p_text, NFKD);
  -- 2. forbidden controls after NFKD: U+0001–U+0008, U+000E–U+001F, U+007F (U+0000 cannot occur in text)
  IF v ~ ('[' || chr(1) || '-' || chr(8) || chr(14) || '-' || chr(31) || chr(127) || ']') THEN
    RAISE EXCEPTION 'DESCRIPTION_CONTROL_CHAR' USING ERRCODE = '22000';
  END IF;
  -- 3. remove every code point above U+007F
  v := coalesce((SELECT string_agg(t.c, '' ORDER BY t.i)
                   FROM regexp_split_to_table(v, '') WITH ORDINALITY AS t(c, i)
                  WHERE ascii(t.c) < 128), '');
  -- 4. a-z → A-Z, ASCII only, locale-independent
  v := translate(v, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  -- 5. every run of TAB, LF, VT, FF, CR, SPACE → one SPACE
  v := regexp_replace(v, '[' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32) || ']+', ' ', 'g');
  -- 6. trim leading / trailing SPACE
  RETURN btrim(v, ' ');
END;
$$;
ALTER FUNCTION fin_norm_description(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_norm_description(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── helper: frozen per-adapter fingerprint (§7.1–§7.3) ─────────────────────
CREATE OR REPLACE FUNCTION fin_statement_fingerprint(
  p_format_code      TEXT,
  p_value_date       DATE,
  p_description_norm TEXT,
  p_bank_reference   TEXT,
  p_fecha_valor      DATE,
  p_signed_amount    NUMERIC,
  p_running_balance  NUMERIC
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  sep CONSTANT TEXT := chr(31);
  v   TEXT;
BEGIN
  IF p_value_date IS NULL OR p_description_norm IS NULL OR p_signed_amount IS NULL THEN
    RAISE EXCEPTION 'FINGERPRINT_FIELD_MISSING';
  END IF;
  IF p_format_code = 'BNA_MONTHLY_PDF_V1' THEN
    IF p_running_balance IS NULL THEN
      RAISE EXCEPTION 'FINGERPRINT_BALANCE_REQUIRED: BNA_MONTHLY_PDF_V1 lines carry a running balance';
    END IF;
    IF p_fecha_valor IS NOT NULL THEN
      RAISE EXCEPTION 'FINGERPRINT_UNEXPECTED_FECHA_VALOR: BNA_MONTHLY_PDF_V1 has no FECHA VALOR';
    END IF;
    v := to_char(p_value_date, 'YYYY-MM-DD')
      || sep || p_description_norm
      || sep || coalesce(p_bank_reference, '')
      || sep || (p_signed_amount::NUMERIC(15,2))::TEXT
      || sep || (p_running_balance::NUMERIC(15,2))::TEXT;
  ELSIF p_format_code = 'PATAGONIA_STATEMENT_PDF_V1' THEN
    v := to_char(p_value_date, 'YYYY-MM-DD')
      || sep || p_description_norm
      || sep || coalesce(p_bank_reference, '')
      || sep || coalesce(to_char(p_fecha_valor, 'YYYY-MM-DD'), '')
      || sep || (p_signed_amount::NUMERIC(15,2))::TEXT
      || sep || coalesce((p_running_balance::NUMERIC(15,2))::TEXT, '');
  ELSE
    RAISE EXCEPTION 'FINGERPRINT_UNKNOWN_FORMAT: %', coalesce(p_format_code, '(null)');
  END IF;
  RETURN encode(sha256(convert_to(v, 'UTF8')), 'hex');
END;
$$;
ALTER FUNCTION fin_statement_fingerprint(TEXT, DATE, TEXT, TEXT, DATE, NUMERIC, NUMERIC) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_fingerprint(TEXT, DATE, TEXT, TEXT, DATE, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;

-- ── fin_import_bank_statement (service_role) ───────────────────────────────
CREATE OR REPLACE FUNCTION fin_import_bank_statement(
  p_actor           UUID,
  p_account_id      UUID,
  p_parser_version  TEXT,
  p_format_code     TEXT,
  p_file_sha256     TEXT,
  p_storage_path    TEXT,
  p_file_name       TEXT,
  p_byte_size       BIGINT,
  p_coverage_from   DATE,
  p_coverage_to     DATE,
  p_source_meta     JSONB,
  p_previous_run_id UUID,
  p_reject_reason   TEXT,
  p_rows            JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_amount  CONSTANT TEXT := '^-?[0-9]{1,13}\.[0-9]{2}$';
  c_date    CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  c_ref     CONSTANT TEXT := '^([!-~]([ -~]*[!-~])?)?$';
  v_cfg      fin_statement_account_config;
  v_run      fin_import_run;
  v_latest   fin_import_run;
  v_run_id   UUID := gen_random_uuid();
  v_reject   TEXT;
  v_opening  NUMERIC(15,2);
  v_closing  NUMERIC(15,2);
  v_bal      NUMERIC(15,2);
  v_rows     JSONB := '[]'::jsonb;    -- validated rows, row_number order, with database-computed fields
  r          JSONB;
  v_kind     TEXT;
  v_pos      INTEGER;
  v_next_pos INTEGER := 1;
  v_date     DATE;
  v_fv       DATE;
  v_norm     TEXT;
  v_ref      TEXT;
  v_amt      NUMERIC(15,2);
  v_rbal     NUMERIC(15,2);
  v_ctl_bal  NUMERIC(15,2);
  v_fp       TEXT;
  v_line_id  BIGINT;
  v_outcome  TEXT;
  v_total    INTEGER := 0;
  v_new      INTEGER := 0;
  v_known    INTEGER := 0;
  v_ignored  INTEGER := 0;
BEGIN
  -- ── caller, actor, account, configuration ──
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM perfiles WHERE id = p_actor AND activo AND rol_type = 'ADMIN') THEN
    RAISE EXCEPTION 'FORBIDDEN: the initiating actor is not an active ADMIN';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account
                  WHERE id = p_account_id AND activo AND account_type = 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_NOT_BANK';
  END IF;
  SELECT * INTO v_cfg FROM fin_statement_account_config WHERE financial_account_id = p_account_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STATEMENT_CONFIG_MISSING: no active statement configuration for the account';
  END IF;

  -- ── attempt fields ──
  IF p_parser_version IS NULL OR btrim(p_parser_version) = '' THEN
    RAISE EXCEPTION 'PARSER_VERSION_REQUIRED';
  END IF;
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_FILE_SHA256';
  END IF;
  IF p_storage_path IS NULL OR btrim(p_storage_path) = '' OR p_file_name IS NULL OR btrim(p_file_name) = ''
     OR p_byte_size IS NULL OR p_byte_size <= 0 THEN
    RAISE EXCEPTION 'INVALID_FILE_METADATA';
  END IF;
  IF p_coverage_from IS NOT NULL AND p_coverage_to IS NOT NULL AND p_coverage_from > p_coverage_to THEN
    RAISE EXCEPTION 'INVALID_COVERAGE';
  END IF;
  IF p_reject_reason IS NOT NULL AND btrim(p_reject_reason) = '' THEN
    RAISE EXCEPTION 'REJECT_REASON_BLANK';
  END IF;
  -- an unrecognised file is recorded with format_code NULL; a recognised one must be the account's adapter
  IF (p_reject_reason IS NULL AND p_format_code IS DISTINCT FROM v_cfg.format_code)
     OR (p_reject_reason IS NOT NULL AND p_format_code IS NOT NULL AND p_format_code <> v_cfg.format_code) THEN
    RAISE EXCEPTION 'FORMAT_NOT_ALLOWED_FOR_ACCOUNT: %', coalesce(p_format_code, '(null)');
  END IF;

  -- ── idempotency (§6.1, §12), serialised per account and file ──
  PERFORM pg_advisory_xact_lock(hashtextextended(p_account_id::TEXT || ':' || p_file_sha256, 0));

  SELECT * INTO v_run FROM fin_import_run
   WHERE financial_account_id = p_account_id AND file_sha256 = p_file_sha256
     AND mode = 'NORMAL' AND parser_version = p_parser_version;
  IF NOT FOUND THEN
    SELECT * INTO v_run FROM fin_import_run
     WHERE financial_account_id = p_account_id AND file_sha256 = p_file_sha256
       AND mode = 'NORMAL' AND status <> 'REJECTED';
  END IF;
  IF FOUND THEN
    RETURN jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'replayed', true,
      'rows_total', v_run.rows_total, 'lines_new', v_run.lines_new, 'lines_known', v_run.lines_known,
      'rows_ignored', v_run.rows_ignored, 'rows_invalid', v_run.rows_invalid, 'rows_captured', v_run.rows_captured,
      'reject_reason', v_run.reject_reason);
  END IF;

  -- reprocess chain: every new attempt over the same bytes links to the latest one (REJECTED / VALIDATED)
  SELECT * INTO v_latest FROM fin_import_run
   WHERE financial_account_id = p_account_id AND file_sha256 = p_file_sha256
   ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_latest.id IS NULL THEN
    IF p_previous_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'PREVIOUS_RUN_INVALID: there is no earlier attempt for this file';
    END IF;
  ELSIF p_previous_run_id IS DISTINCT FROM v_latest.id OR v_latest.status NOT IN ('REJECTED', 'VALIDATED') THEN
    RAISE EXCEPTION 'PREVIOUS_RUN_INVALID: a reprocess must reference the latest attempt % of this file', v_latest.id;
  END IF;

  -- ── parser-level rejection (unknown / unsupported file): REJECTED run, no lines, no appearances ──
  IF p_reject_reason IS NOT NULL THEN
    v_reject := p_reject_reason;
  ELSE
    -- ── contract of the parsed statement ──
    IF p_coverage_to IS NULL THEN
      RAISE EXCEPTION 'COVERAGE_TO_REQUIRED';
    END IF;
    IF p_source_meta IS NULL OR jsonb_typeof(p_source_meta) <> 'object'
       OR jsonb_typeof(p_source_meta -> 'opening_balance') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_source_meta -> 'closing_balance') IS DISTINCT FROM 'string'
       OR (p_source_meta ->> 'opening_balance') !~ c_amount OR (p_source_meta ->> 'closing_balance') !~ c_amount THEN
      RAISE EXCEPTION 'INVALID_SOURCE_META: opening_balance and closing_balance are required canonical amounts';
    END IF;
    v_opening := (p_source_meta ->> 'opening_balance')::NUMERIC(15,2);
    v_closing := (p_source_meta ->> 'closing_balance')::NUMERIC(15,2);
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: rows must be a JSON array';
    END IF;

    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
      IF jsonb_typeof(r) <> 'object' THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: every row must be an object';
      END IF;
      IF r ?| ARRAY['description_norm', 'fingerprint', 'outcome', 'statement_line_id', 'mp_source_record_id'] THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: description_norm, fingerprint, outcome and destinations are computed by the database';
      END IF;
      IF jsonb_typeof(r -> 'row_number') IS DISTINCT FROM 'number' OR (r ->> 'row_number') !~ '^[1-9][0-9]{0,8}$' THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: row_number must be a positive integer';
      END IF;
      v_kind := r ->> 'kind';
      IF v_kind IS NULL OR v_kind NOT IN ('ECONOMIC', 'CONTROL', 'DETAIL') THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: kind must be ECONOMIC, CONTROL or DETAIL (row %)', r ->> 'row_number';
      END IF;
      IF jsonb_typeof(r -> 'raw_row') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: raw_row must be an object (row %)', r ->> 'row_number';
      END IF;
      IF (r ? 'appearance_meta' AND jsonb_typeof(r -> 'appearance_meta') <> 'object')
         OR (r ? 'review_code' AND jsonb_typeof(r -> 'review_code') NOT IN ('string', 'null'))
         OR (jsonb_typeof(r -> 'review_code') = 'string' AND btrim(r ->> 'review_code') = '')
         OR (r ? 'note' AND jsonb_typeof(r -> 'note') NOT IN ('string', 'null')) THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: appearance_meta, review_code or note malformed (row %)', r ->> 'row_number';
      END IF;
      IF v_kind = 'ECONOMIC' THEN
        IF jsonb_typeof(r -> 'statement_position') IS DISTINCT FROM 'number' OR (r ->> 'statement_position') !~ '^[1-9][0-9]{0,8}$'
           OR jsonb_typeof(r -> 'value_date') IS DISTINCT FROM 'string' OR (r ->> 'value_date') !~ c_date
           OR jsonb_typeof(r -> 'description_raw') IS DISTINCT FROM 'string'
           OR (r ? 'bank_reference' AND jsonb_typeof(r -> 'bank_reference') NOT IN ('string', 'null'))
           OR (r ? 'fecha_valor' AND jsonb_typeof(r -> 'fecha_valor') NOT IN ('string', 'null'))
           OR (jsonb_typeof(r -> 'fecha_valor') = 'string' AND (r ->> 'fecha_valor') !~ c_date)
           OR jsonb_typeof(r -> 'signed_amount') IS DISTINCT FROM 'string' OR (r ->> 'signed_amount') !~ c_amount
           OR (r ? 'running_balance' AND jsonb_typeof(r -> 'running_balance') NOT IN ('string', 'null'))
           OR (jsonb_typeof(r -> 'running_balance') = 'string' AND (r ->> 'running_balance') !~ c_amount) THEN
          RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: economic row fields malformed (row %)', r ->> 'row_number';
        END IF;
      ELSE
        IF r ? 'statement_position' AND jsonb_typeof(r -> 'statement_position') <> 'null' THEN
          RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: only economic rows carry statement_position (row %)', r ->> 'row_number';
        END IF;
        IF v_kind = 'CONTROL' AND (jsonb_typeof(r -> 'control_type') IS DISTINCT FROM 'string' OR btrim(r ->> 'control_type') = ''
           OR (r ? 'balance' AND jsonb_typeof(r -> 'balance') NOT IN ('string', 'null'))
           OR (jsonb_typeof(r -> 'balance') = 'string' AND (r ->> 'balance') !~ c_amount)) THEN
          RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: control row fields malformed (row %)', r ->> 'row_number';
        END IF;
      END IF;
    END LOOP;
    IF (SELECT count(DISTINCT (value ->> 'row_number')::INTEGER) FROM jsonb_array_elements(p_rows)) <> jsonb_array_length(p_rows) THEN
      RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: row_number values must be unique';
    END IF;

    -- ── statement content (adapter rules, §7.1–§7.3); the first failure rejects the run ──
    v_bal := v_opening;
    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) ORDER BY (value ->> 'row_number')::INTEGER LOOP
      v_kind := r ->> 'kind';
      IF v_kind = 'ECONOMIC' THEN
        v_pos := (r ->> 'statement_position')::INTEGER;
        IF v_pos <> v_next_pos THEN
          v_reject := 'STATEMENT_POSITION_SEQUENCE'; EXIT;
        END IF;
        v_next_pos := v_next_pos + 1;
        BEGIN
          v_date := (r ->> 'value_date')::DATE;
          v_fv   := (r ->> 'fecha_valor')::DATE;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: impossible date (row %)', r ->> 'row_number';
        END;
        IF v_date > p_coverage_to OR (p_coverage_from IS NOT NULL AND v_date <= p_coverage_from) THEN
          v_reject := 'DATE_OUTSIDE_COVERAGE'; EXIT;
        END IF;
        IF btrim(r ->> 'description_raw') = '' THEN
          v_reject := 'EMPTY_DESCRIPTION'; EXIT;
        END IF;
        BEGIN
          v_norm := fin_norm_description(r ->> 'description_raw');
        EXCEPTION WHEN SQLSTATE '22000' THEN
          v_reject := 'DESCRIPTION_CONTROL_CHAR'; EXIT;
        END;
        IF v_norm = '' THEN
          v_reject := 'EMPTY_DESCRIPTION'; EXIT;
        END IF;
        v_ref := coalesce(r ->> 'bank_reference', '');
        IF v_ref !~ c_ref OR length(v_ref) > 100 THEN
          v_reject := 'INVALID_BANK_REFERENCE'; EXIT;
        END IF;
        IF v_cfg.format_code = 'BNA_MONTHLY_PDF_V1' AND v_fv IS NOT NULL THEN
          v_reject := 'UNEXPECTED_FECHA_VALOR'; EXIT;
        END IF;
        v_amt := (r ->> 'signed_amount')::NUMERIC(15,2);
        IF v_amt = 0 THEN
          v_reject := 'ZERO_AMOUNT'; EXIT;
        END IF;
        v_rbal := (r ->> 'running_balance')::NUMERIC(15,2);
        IF v_cfg.format_code = 'BNA_MONTHLY_PDF_V1' AND v_rbal IS NULL THEN
          v_reject := 'RUNNING_BALANCE_REQUIRED'; EXIT;
        END IF;
        v_bal := v_bal + v_amt;
        IF v_rbal IS NOT NULL AND v_rbal <> v_bal THEN
          v_reject := 'BALANCE_CHAIN_MISMATCH'; EXIT;
        END IF;
        v_fp := fin_statement_fingerprint(v_cfg.format_code, v_date, v_norm, v_ref, v_fv, v_amt, v_rbal);
        v_rows := v_rows || jsonb_build_array(r || jsonb_build_object(
          '_value_date', v_date, '_fecha_valor', v_fv, '_norm', v_norm, '_ref', v_ref,
          '_amount', v_amt, '_balance', v_rbal, '_fp', v_fp));
      ELSIF v_kind = 'CONTROL' THEN
        v_ctl_bal := (r ->> 'balance')::NUMERIC(15,2);
        IF upper(r ->> 'control_type') = 'TRANSPORTE' AND v_ctl_bal IS NOT NULL AND v_ctl_bal <> v_bal THEN
          v_reject := 'TRANSPORTE_MISMATCH'; EXIT;
        END IF;
        v_rows := v_rows || jsonb_build_array(r);
      ELSE  -- DETAIL
        IF v_cfg.format_code <> 'PATAGONIA_STATEMENT_PDF_V1' THEN
          v_reject := 'UNSUPPORTED_STRUCTURE'; EXIT;
        END IF;
        v_rows := v_rows || jsonb_build_array(r);
      END IF;
    END LOOP;

    IF v_reject IS NULL AND v_bal <> v_closing THEN
      v_reject := 'CLOSING_BALANCE_MISMATCH';
    END IF;
    IF v_reject IS NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) e WHERE e ? '_fp'
                                     GROUP BY e ->> '_fp' HAVING count(*) > 1) THEN
      v_reject := CASE v_cfg.format_code WHEN 'PATAGONIA_STATEMENT_PDF_V1' THEN 'DUPLICATE_CONTENT_IN_STATEMENT'
                                         ELSE 'DUPLICATE_FINGERPRINT_IN_STATEMENT' END;
    END IF;
    -- BNA: a new line equal to a stored fact on (date, description, reference, amount) with another balance
    IF v_reject IS NULL AND v_cfg.format_code = 'BNA_MONTHLY_PDF_V1' AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_rows) e
           JOIN fin_statement_line l
             ON l.financial_account_id = p_account_id
            AND l.value_date = (e ->> '_value_date')::DATE
            AND l.description_norm = e ->> '_norm'
            AND l.bank_reference = e ->> '_ref'
            AND l.signed_amount = (e ->> '_amount')::NUMERIC
            AND l.running_balance IS DISTINCT FROM (e ->> '_balance')::NUMERIC
          WHERE e ? '_fp'
            AND NOT EXISTS (SELECT 1 FROM fin_statement_line k
                             WHERE k.financial_account_id = p_account_id AND k.fingerprint = e ->> '_fp')) THEN
      v_reject := 'REISSUE_SUSPECTED';
    END IF;
  END IF;

  -- ── rejected: the run is written final, with no lines and no appearances ──
  IF v_reject IS NOT NULL THEN
    INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256,
                                storage_path, file_name, byte_size, coverage_from, coverage_to, status, reject_reason,
                                source_meta, previous_run_id, created_by)
    VALUES (v_run_id, 'BANK_STATEMENT', 'NORMAL', p_account_id, p_format_code, p_parser_version, p_file_sha256,
            p_storage_path, p_file_name, p_byte_size, p_coverage_from, p_coverage_to, 'REJECTED', v_reject,
            coalesce(p_source_meta, '{}'::jsonb), p_previous_run_id, p_actor);
    RETURN jsonb_build_object('run_id', v_run_id, 'status', 'REJECTED', 'replayed', false,
      'rows_total', 0, 'lines_new', 0, 'lines_known', 0, 'rows_ignored', 0, 'rows_invalid', 0, 'rows_captured', 0,
      'reject_reason', v_reject);
  END IF;

  -- ── parsed: counters derived from the final data, the run written once, then lines and appearances ──
  v_total := jsonb_array_length(v_rows);
  SELECT count(*) FILTER (WHERE e ? '_fp' AND NOT EXISTS (SELECT 1 FROM fin_statement_line k
                                                           WHERE k.financial_account_id = p_account_id AND k.fingerprint = e ->> '_fp')),
         count(*) FILTER (WHERE e ? '_fp' AND EXISTS (SELECT 1 FROM fin_statement_line k
                                                       WHERE k.financial_account_id = p_account_id AND k.fingerprint = e ->> '_fp')),
         count(*) FILTER (WHERE NOT e ? '_fp')
    INTO v_new, v_known, v_ignored
    FROM jsonb_array_elements(v_rows) e;

  INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256,
                              storage_path, file_name, byte_size, coverage_from, coverage_to, status, reject_reason,
                              rows_total, lines_new, lines_known, rows_ignored, rows_invalid, rows_captured,
                              source_meta, previous_run_id, created_by)
  VALUES (v_run_id, 'BANK_STATEMENT', 'NORMAL', p_account_id, p_format_code, p_parser_version, p_file_sha256,
          p_storage_path, p_file_name, p_byte_size, p_coverage_from, p_coverage_to, 'PARSED', NULL,
          v_total, v_new, v_known, v_ignored, 0, 0,
          p_source_meta, p_previous_run_id, p_actor);

  FOR r IN SELECT value FROM jsonb_array_elements(v_rows) ORDER BY (value ->> 'row_number')::INTEGER LOOP
    v_line_id := NULL;
    IF r ? '_fp' THEN
      SELECT id INTO v_line_id FROM fin_statement_line
       WHERE financial_account_id = p_account_id AND fingerprint = r ->> '_fp';
      IF v_line_id IS NULL THEN
        INSERT INTO fin_statement_line (financial_account_id, value_date, description_raw, description_norm, bank_reference,
                                        fecha_valor, signed_amount, running_balance, fingerprint, first_run_id)
        VALUES (p_account_id, (r ->> '_value_date')::DATE, r ->> 'description_raw', r ->> '_norm', r ->> '_ref',
                (r ->> '_fecha_valor')::DATE, (r ->> '_amount')::NUMERIC(15,2), (r ->> '_balance')::NUMERIC(15,2),
                r ->> '_fp', v_run_id)
        RETURNING id INTO v_line_id;
        v_outcome := 'NEW';
      ELSE
        v_outcome := 'ALREADY_KNOWN';
      END IF;
    ELSE
      v_outcome := 'IGNORED';
    END IF;
    INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, statement_line_id,
                                     statement_position, appearance_meta, review_code)
    VALUES (v_run_id, (r ->> 'row_number')::INTEGER, 'BANK_STATEMENT', 'NORMAL', r -> 'raw_row', v_outcome,
            CASE WHEN r ->> 'kind' = 'CONTROL' THEN coalesce(r ->> 'note', 'CONTROL:' || (r ->> 'control_type'))
                 WHEN r ->> 'kind' = 'DETAIL'  THEN coalesce(r ->> 'note', 'DETAIL')
                 ELSE r ->> 'note' END,
            v_line_id, (r ->> 'statement_position')::INTEGER,
            coalesce(r -> 'appearance_meta', '{}'::jsonb), nullif(r ->> 'review_code', ''));
  END LOOP;

  RETURN jsonb_build_object('run_id', v_run_id, 'status', 'PARSED', 'replayed', false,
    'rows_total', v_total, 'lines_new', v_new, 'lines_known', v_known, 'rows_ignored', v_ignored,
    'rows_invalid', 0, 'rows_captured', 0, 'reject_reason', NULL);
END;
$$;
ALTER FUNCTION fin_import_bank_statement(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, UUID, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_import_bank_statement(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fin_import_bank_statement(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, UUID, TEXT, JSONB) TO service_role;

-- ── fin_match_statement_line (ADMIN) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION fin_match_statement_line(
  p_statement_line_id    BIGINT,
  p_financial_posting_id BIGINT,
  p_reason               TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_line    fin_statement_line;
  v_post    financial_posting;
  v_cut     fin_statement_cutover;
  v_anchor  fin_statement_line;
  v_fmt     TEXT;
  v_l_cov   DATE;
  v_l_pos   INTEGER;
  v_a_cov   DATE;
  v_a_pos   INTEGER;
  v_active  fin_statement_match;
  v_id      BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN only';
  END IF;
  SELECT * INTO v_line FROM fin_statement_line WHERE id = p_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STATEMENT_LINE_NOT_FOUND';
  END IF;
  SELECT * INTO v_post FROM financial_posting WHERE id = p_financial_posting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POSTING_NOT_FOUND';
  END IF;
  IF v_post.financial_account_id <> v_line.financial_account_id THEN
    RAISE EXCEPTION 'ACCOUNT_MISMATCH: the posting and the statement line belong to different accounts';
  END IF;
  IF v_post.signed_amount <> v_line.signed_amount THEN
    RAISE EXCEPTION 'AMOUNT_MISMATCH: posting % vs statement line %', v_post.signed_amount, v_line.signed_amount;
  END IF;

  -- cut classification (§6.6, §7.2, §7.3): only POST_CUTOVER lines are reconcilable
  SELECT * INTO v_cut FROM fin_statement_cutover
   WHERE financial_account_id = v_line.financial_account_id AND superseded_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUTOVER_UNRESOLVED: the account has no active statement cut';
  END IF;
  SELECT format_code INTO v_fmt FROM fin_statement_account_config WHERE financial_account_id = v_line.financial_account_id;
  SELECT * INTO v_anchor FROM fin_statement_line WHERE id = v_cut.cutoff_statement_line_id;
  IF v_line.id = v_anchor.id THEN
    RAISE EXCEPTION 'PRE_CUTOVER_LINE: the line is the cut anchor';
  END IF;
  IF v_fmt = 'BNA_MONTHLY_PDF_V1' THEN
    -- position = (statement period end, balance-chain index) of the appearance in the run that created the line
    SELECT r.coverage_to, a.statement_position INTO v_l_cov, v_l_pos
      FROM fin_import_run r JOIN fin_import_run_line a ON a.run_id = r.id AND a.statement_line_id = v_line.id
     WHERE r.id = v_line.first_run_id;
    SELECT r.coverage_to, a.statement_position INTO v_a_cov, v_a_pos
      FROM fin_import_run r JOIN fin_import_run_line a ON a.run_id = r.id AND a.statement_line_id = v_anchor.id
     WHERE r.id = v_anchor.first_run_id;
    IF v_l_cov IS NULL OR v_l_pos IS NULL OR v_a_cov IS NULL OR v_a_pos IS NULL THEN
      RAISE EXCEPTION 'CUTOVER_ORDER_UNAVAILABLE';
    END IF;
    IF (v_l_cov, v_l_pos) <= (v_a_cov, v_a_pos) THEN
      RAISE EXCEPTION 'PRE_CUTOVER_LINE: the line is included in the opening balance';
    END IF;
  ELSIF v_fmt = 'PATAGONIA_STATEMENT_PDF_V1' THEN
    IF v_line.value_date < v_anchor.value_date THEN
      RAISE EXCEPTION 'PRE_CUTOVER_LINE: the line is included in the opening balance';
    ELSIF v_line.value_date = v_anchor.value_date THEN
      RAISE EXCEPTION 'CUTOVER_AMBIGUOUS_DAY: same-day order relative to the anchor is not verifiable';
    END IF;
  ELSE
    RAISE EXCEPTION 'STATEMENT_CONFIG_MISSING';
  END IF;

  -- one active match per line and per posting; an identical replay returns the existing match
  SELECT * INTO v_active FROM fin_statement_match WHERE statement_line_id = v_line.id AND reversed_at IS NULL;
  IF FOUND THEN
    IF v_active.financial_posting_id = v_post.id THEN
      RETURN jsonb_build_object('match_id', v_active.id, 'financial_operation_id', v_active.financial_operation_id, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'LINE_ALREADY_MATCHED: statement line % has active match %', v_line.id, v_active.id;
  END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_match WHERE financial_posting_id = v_post.id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'POSTING_ALREADY_MATCHED: posting % already has an active match', v_post.id;
  END IF;

  BEGIN
    INSERT INTO fin_statement_match (statement_line_id, financial_operation_id, financial_posting_id, matched_by, reason)
    VALUES (v_line.id, v_post.financial_operation_id, v_post.id, v_uid, nullif(btrim(p_reason), ''))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MATCH_CONFLICT: a concurrent active match exists';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fin_statement_match', v_id::TEXT, 'FIN_STATEMENT_MATCH',
          jsonb_build_object('statement_line_id', v_line.id, 'financial_operation_id', v_post.financial_operation_id,
                             'financial_posting_id', v_post.id, 'account', v_line.financial_account_id,
                             'signed_amount', v_line.signed_amount),
          nullif(btrim(p_reason), ''), v_uid);

  RETURN jsonb_build_object('match_id', v_id, 'financial_operation_id', v_post.financial_operation_id, 'replayed', false);
END;
$$;
ALTER FUNCTION fin_match_statement_line(BIGINT, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_match_statement_line(BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_match_statement_line(BIGINT, BIGINT, TEXT) TO authenticated;

-- ── fin_reverse_statement_match (ADMIN) ────────────────────────────────────
CREATE OR REPLACE FUNCTION fin_reverse_statement_match(
  p_match_id BIGINT,
  p_reason   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_match fin_statement_match;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN only';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  SELECT * INTO v_match FROM fin_statement_match WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MATCH_NOT_FOUND';
  END IF;
  IF v_match.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'MATCH_ALREADY_REVERSED';
  END IF;

  UPDATE fin_statement_match
     SET reversed_by = v_uid, reversed_at = NOW(), reverse_reason = btrim(p_reason)
   WHERE id = p_match_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('fin_statement_match', p_match_id::TEXT, 'FIN_STATEMENT_MATCH_REVERSE',
          jsonb_build_object('active', true),
          jsonb_build_object('active', false, 'statement_line_id', v_match.statement_line_id,
                             'financial_posting_id', v_match.financial_posting_id),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('match_id', p_match_id, 'reversed', true);
END;
$$;
ALTER FUNCTION fin_reverse_statement_match(BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_reverse_statement_match(BIGINT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_reverse_statement_match(BIGINT, TEXT) TO authenticated;

-- ── fin_resolve_statement_cutover (ADMIN) ──────────────────────────────────
CREATE OR REPLACE FUNCTION fin_resolve_statement_cutover(
  p_account_id               UUID,
  p_cutoff_statement_line_id BIGINT,
  p_opening_balance          NUMERIC,
  p_evidence_note            TEXT,
  p_supersede_reason         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_fmt    TEXT;
  v_anchor fin_statement_line;
  v_active fin_statement_cutover;
  v_new    BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account
                  WHERE id = p_account_id AND activo AND account_type = 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_NOT_BANK';
  END IF;
  SELECT format_code INTO v_fmt FROM fin_statement_account_config WHERE financial_account_id = p_account_id AND activo;
  IF v_fmt IS NULL THEN
    RAISE EXCEPTION 'STATEMENT_CONFIG_MISSING';
  END IF;
  IF p_evidence_note IS NULL OR btrim(p_evidence_note) = '' THEN
    RAISE EXCEPTION 'EVIDENCE_REQUIRED';
  END IF;
  SELECT * INTO v_anchor FROM fin_statement_line WHERE id = p_cutoff_statement_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ANCHOR_NOT_FOUND';
  END IF;
  IF v_anchor.financial_account_id <> p_account_id THEN
    RAISE EXCEPTION 'ANCHOR_NOT_IN_ACCOUNT';
  END IF;
  -- K-4: the anchor carries a balance and the opening balance equals it exactly
  IF v_anchor.running_balance IS NULL THEN
    RAISE EXCEPTION 'ANCHOR_WITHOUT_BALANCE: a line without a running balance cannot be the anchor';
  END IF;
  IF p_opening_balance IS NULL OR p_opening_balance <> v_anchor.running_balance THEN
    RAISE EXCEPTION 'OPENING_BALANCE_MISMATCH: opening % vs anchor balance %', p_opening_balance, v_anchor.running_balance;
  END IF;
  -- Patagonia: same-day order is not verifiable, so the anchor must be alone on its date
  IF v_fmt = 'PATAGONIA_STATEMENT_PDF_V1' AND EXISTS (
       SELECT 1 FROM fin_statement_line
        WHERE financial_account_id = p_account_id AND value_date = v_anchor.value_date AND id <> v_anchor.id) THEN
    RAISE EXCEPTION 'ANCHOR_AMBIGUOUS_DAY: another statement line shares the anchor date';
  END IF;

  SELECT * INTO v_active FROM fin_statement_cutover
   WHERE financial_account_id = p_account_id AND superseded_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    IF p_supersede_reason IS NOT NULL THEN
      RAISE EXCEPTION 'SUPERSEDE_REASON_NOT_ALLOWED: there is no active cut to supersede';
    END IF;
    INSERT INTO fin_statement_cutover (financial_account_id, opening_balance, cutoff_statement_line_id, resolved_by, evidence_note)
    VALUES (p_account_id, p_opening_balance, v_anchor.id, v_uid, btrim(p_evidence_note))
    RETURNING id INTO v_new;
  ELSE
    IF p_supersede_reason IS NULL OR btrim(p_supersede_reason) = '' THEN
      RAISE EXCEPTION 'SUPERSEDE_REASON_REQUIRED: the account already has an active cut';
    END IF;
    v_new := nextval('fin_statement_cutover_id_seq');
    UPDATE fin_statement_cutover
       SET superseded_by = v_new, superseded_at = NOW(), supersede_reason = btrim(p_supersede_reason)
     WHERE id = v_active.id;
    INSERT INTO fin_statement_cutover (id, financial_account_id, opening_balance, cutoff_statement_line_id, resolved_by, evidence_note)
    VALUES (v_new, p_account_id, p_opening_balance, v_anchor.id, v_uid, btrim(p_evidence_note));
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('fin_statement_cutover', v_new::TEXT, 'FIN_STATEMENT_CUTOVER',
          CASE WHEN v_active.id IS NULL THEN NULL
               ELSE jsonb_build_object('cutover_id', v_active.id, 'cutoff_statement_line_id', v_active.cutoff_statement_line_id,
                                       'opening_balance', v_active.opening_balance) END,
          jsonb_build_object('account', p_account_id, 'cutoff_statement_line_id', v_anchor.id,
                             'opening_balance', p_opening_balance, 'superseded_id', v_active.id),
          coalesce(btrim(p_supersede_reason), btrim(p_evidence_note)), v_uid);

  RETURN jsonb_build_object('cutover_id', v_new, 'superseded_id', v_active.id);
END;
$$;
ALTER FUNCTION fin_resolve_statement_cutover(UUID, BIGINT, NUMERIC, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_resolve_statement_cutover(UUID, BIGINT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_resolve_statement_cutover(UUID, BIGINT, NUMERIC, TEXT, TEXT) TO authenticated;
