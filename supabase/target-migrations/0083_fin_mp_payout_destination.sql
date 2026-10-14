-- ============================================================================
-- TARGET V1 — 0083 MERCADO PAGO PAYOUT DESTINATION (PRIVATE STORAGE) (ADR-018 §9.3, owner GO 2026-10-14)
--
-- Parser mp-release-report-csv/1.2.0 accepts PAYOUT_BANK_ACCOUNT_NUMBER ("número completo de la cuenta a la que se envió
-- dinero desde Mercado Pago") as ONE optional column. The value never enters fin_import_run_line.raw_row: the frozen
-- 15-key D1 row, the SOURCE_ID:DESCRIPTION:C/D identity and fin_capture/fin_ingest_mp_release_report are unchanged.
-- The Edge Function sends the non-empty values of a recorded run here, apart from the rows.
--
--   1. fin_mp_payout_destination — one row per (run, row_number) holding a value: the original string, a minimally
--      normalized form (trim, inner whitespace removed) and value_class 'UNVERIFIED' (the format — CBU, CVU, account
--      number — is not assumed until a real value is seen). Immutable (fin_evidence_immutable_guard). PRIVATE: RLS on,
--      no policy for any user role, SELECT for service_role only (the future matcher runs server-side); anon and
--      authenticated (ADMIN included) have no privilege. The original file in Storage remains the raw evidence.
--   2. fin_record_mp_payout_destinations — SECURITY DEFINER, service_role only, idempotent: the run must be an MP report
--      run, every row_number an appearance of that run; the same value again is a no-op, a different value for the same
--      appearance is refused (DESTINATION_CONFLICT). Error messages never contain the value.
-- No matching, no transfer, no financial effect. SECURITY DEFINER set 77 → 78.
-- ============================================================================

CREATE TABLE fin_mp_payout_destination (
  run_id           UUID        NOT NULL,
  row_number       INTEGER     NOT NULL,
  source_id        VARCHAR(40) NOT NULL,
  description      VARCHAR(60) NOT NULL,
  original_value   TEXT        NOT NULL,
  normalized_value TEXT        NOT NULL,
  value_class      VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, row_number),
  CONSTRAINT fk_mpd_appearance FOREIGN KEY (run_id, row_number) REFERENCES fin_import_run_line(run_id, row_number)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_mpd_original   CHECK (btrim(original_value) <> '' AND length(original_value) <= 64),
  CONSTRAINT chk_mpd_normalized CHECK (normalized_value <> '' AND normalized_value !~ '\s' AND length(normalized_value) <= 64),
  CONSTRAINT chk_mpd_class      CHECK (value_class IN ('UNVERIFIED'))
);
ALTER TABLE fin_mp_payout_destination ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mpd_normalized ON fin_mp_payout_destination(normalized_value);
CREATE INDEX idx_mpd_source ON fin_mp_payout_destination(source_id);
CREATE TRIGGER trg_fin_mp_payout_destination_immutable
  BEFORE UPDATE OR DELETE ON fin_mp_payout_destination
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE fin_mp_payout_destination FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE fin_mp_payout_destination TO service_role;
CREATE POLICY fin_mp_payout_destination_service_select ON fin_mp_payout_destination
  FOR SELECT USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION fin_record_mp_payout_destinations(p_run_id UUID, p_items JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  it      JSONB;
  v_rn    INTEGER;
  v_val   TEXT;
  v_norm  TEXT;
  v_line  fin_import_run_line%ROWTYPE;
  v_prev  TEXT;
  v_n     INTEGER := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_import_run WHERE id = p_run_id AND source_kind = 'MP_RELEASE_REPORT') THEN
    RAISE EXCEPTION 'RUN_MISMATCH: not an MP report run';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 5000 THEN
    RAISE EXCEPTION 'INVALID_ITEMS: a non-empty array is required';
  END IF;
  FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(it) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(it) k) IS DISTINCT FROM ARRAY['row_number', 'value']
       OR jsonb_typeof(it -> 'row_number') <> 'number' OR jsonb_typeof(it -> 'value') <> 'string' OR (it ->> 'row_number') !~ '^[1-9][0-9]{0,5}$' THEN
      RAISE EXCEPTION 'INVALID_ITEMS: every item is exactly {row_number, value}';
    END IF;
    v_rn := (it ->> 'row_number')::INTEGER;
    v_val := it ->> 'value';
    -- control characters, empty or oversized values are refused; the message never echoes the value
    IF btrim(v_val) = '' OR length(v_val) > 64 OR v_val ~ '[\x00-\x08\x0a-\x1f\x7f]' THEN
      RAISE EXCEPTION 'INVALID_VALUE: row %', v_rn;
    END IF;
    v_norm := regexp_replace(btrim(v_val), '\s+', '', 'g');
    SELECT * INTO v_line FROM fin_import_run_line WHERE run_id = p_run_id AND row_number = v_rn;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ROW_MISMATCH: row % is not an appearance of the run', v_rn;
    END IF;
    SELECT original_value INTO v_prev FROM fin_mp_payout_destination WHERE run_id = p_run_id AND row_number = v_rn;
    IF FOUND THEN
      IF v_prev IS DISTINCT FROM v_val THEN
        RAISE EXCEPTION 'DESTINATION_CONFLICT: row % already holds another value', v_rn;
      END IF;
    ELSE
      INSERT INTO fin_mp_payout_destination (run_id, row_number, source_id, description, original_value, normalized_value)
      VALUES (p_run_id, v_rn, left(coalesce(v_line.raw_row ->> 'SOURCE_ID', ''), 40), left(coalesce(v_line.raw_row ->> 'DESCRIPTION', ''), 60), v_val, v_norm);
    END IF;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
ALTER FUNCTION fin_record_mp_payout_destinations(UUID, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_record_mp_payout_destinations(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fin_record_mp_payout_destinations(UUID, JSONB) TO service_role;
