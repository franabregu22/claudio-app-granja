-- ============================================================================
-- TARGET V1 — 0094 HISTORICAL MERCADO PAGO RECONSTRUCTION 01/02 → CUTOVER (ADR-022, ACCEPTED 2026-10-16)
--
-- The pre-cutover-ignore rule (ADR-017 / 0071) stays for every runtime path; ONLY this ADMIN path imports pre-cutover release
-- report rows, and only if they independently reach the Mercado Pago cutover opening to the cent.
--   1. mp_historical_run / mp_historical_row (immutable evidence, one row per identity <SOURCE_ID>:<DESCRIPTION>:<C|D>; a repeated
--      identity must be identical) / mp_historical_destination (payout destination of a 16-column report; private, no API grant).
--   2. mp_historical_stage(file_name, file_sha256, rows) (SECURITY DEFINER, ADMIN): stages one release report file (control rows
--      skipped; rows at/after mp_cutover_boundary.cutover_at excluded and counted); replay of the same file writes nothing.
--   3. mp_historical_reconstruct(expected_total, reason) (SECURITY DEFINER, ADMIN), ONE transaction:
--      continuity (every BALANCE_AMOUNT = running balance from 0.00), final balance = the Mercado Pago phase31_opening = the
--      expected total (exact) — else nothing is written; then every staged row once:
--        receipt (account money / card / digital currency)  → A1 plan (MP_SETTLEMENT gross + FEE + tax ADJUSTMENT), unassigned
--        yield                                              → A1 plan; financial income in the P&L (as every yield)
--        CVU / DEBIN inflow, outbound payment, payout       → ADR-021 provisional (MP-PENDING:<SOURCE_ID>), pending classification
--        reserve                                            → evidence only
--      own-account payout (destination = an active own CBU) → tagged OWN_ACCOUNT_TRANSFER_CANDIDATE (mp_historical_payout); the
--      bank side is NOT created. Then the explicit neutralization of the Mercado Pago phase31_opening (ADJUSTMENT
--      MP-HIST-OPENING-NEUTRALIZATION:<opening>, −opening, audited source exception OPENING_NEUTRALIZATION) and the immutable
--      mp_historical_reconstruction record. A replay writes nothing. No assert_period_open: the narrow, audited ADR-022 exception
--      (staged pre-cutover evidence only); every normal route keeps its period guard.
--   4. mp_pending_outflow accepts kind INFLOW (amount > 0); fin_mp_pending_classification / mp_pending_classification_totals count
--      historical inflows as incoming pendings.
--   5. Views (security_invoker, ADMIN): fin_mp_historical_status (classes, totals, reconstruction state), fin_mp_historical_payouts
--      (destination status, matched own account, last 4 digits only).
-- SECURITY DEFINER set 91 → 93.
-- ============================================================================

ALTER TABLE mp_source_exception DROP CONSTRAINT chk_mse_kind;
ALTER TABLE mp_source_exception ADD CONSTRAINT chk_mse_kind CHECK (kind IN ('ADMIN_CORRECTION', 'COLLECTION_CORRECTION', 'OPENING_NEUTRALIZATION'));
ALTER TABLE mp_pending_outflow DROP CONSTRAINT chk_mpo_kind;
ALTER TABLE mp_pending_outflow DROP CONSTRAINT chk_mpo_amount;
ALTER TABLE mp_pending_outflow ADD CONSTRAINT chk_mpo_kind CHECK (kind IN ('PAYOUT', 'OUTBOUND', 'INFLOW'));
ALTER TABLE mp_pending_outflow ADD CONSTRAINT chk_mpo_amount CHECK ((kind = 'INFLOW' AND amount > 0) OR (kind <> 'INFLOW' AND amount < 0));

-- ── 1. evidence ───────────────────────────────────────────────────────────────
CREATE TABLE mp_historical_run (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name   VARCHAR(255) NOT NULL,
  file_sha256 CHAR(64)     NOT NULL UNIQUE,
  created_by  UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_mhr_sha CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_mhr_name CHECK (btrim(file_name) <> '')
);
CREATE TABLE mp_historical_row (
  id             BIGSERIAL PRIMARY KEY,
  run_id         UUID         NOT NULL REFERENCES mp_historical_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  row_number     INTEGER      NOT NULL,
  identity       VARCHAR(80)  NOT NULL UNIQUE,
  source_id      VARCHAR(30)  NOT NULL,
  description    VARCHAR(40)  NOT NULL,
  direction      CHAR(1)      NOT NULL,
  occurred_at    TIMESTAMPTZ  NOT NULL,
  occurred_date  DATE         NOT NULL,
  payment_method VARCHAR(60),
  net_amount     NUMERIC(15,2) NOT NULL,
  gross_amount   NUMERIC(15,2) NOT NULL,
  fee_amount     NUMERIC(15,2) NOT NULL,
  tax_amount     NUMERIC(15,2) NOT NULL,
  raw_row        JSONB        NOT NULL,   -- the report's BALANCE_AMOUNT stays evidence here (never a stored balance column)
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mhrow_dir CHECK (direction IN ('C', 'D')),
  CONSTRAINT chk_mhrow_sid CHECK (source_id ~ '^[0-9]{1,20}$'),
  CONSTRAINT chk_mhrow_identity CHECK (identity = source_id || ':' || description || ':' || direction)
);
CREATE TABLE mp_historical_destination (
  identity          VARCHAR(80) PRIMARY KEY REFERENCES mp_historical_row(identity) ON DELETE RESTRICT ON UPDATE CASCADE,
  run_id            UUID        NOT NULL REFERENCES mp_historical_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_value VARCHAR(40) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mhd_value CHECK (destination_value ~ '^[0-9]{6,40}$')
);
CREATE TABLE mp_historical_reconstruction (
  id                          BIGSERIAL PRIMARY KEY,
  singleton                   BOOLEAN     NOT NULL DEFAULT true UNIQUE,
  cutover_at                  TIMESTAMPTZ NOT NULL,
  rows_applied                INTEGER     NOT NULL,
  reconstructed_total         NUMERIC(15,2) NOT NULL,
  opening_operation_id        BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  opening_amount              NUMERIC(15,2) NOT NULL,
  neutralization_operation_id BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  summary                     JSONB       NOT NULL,
  reason                      TEXT        NOT NULL,
  created_by                  UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mhrec_singleton CHECK (singleton),
  CONSTRAINT chk_mhrec_exact CHECK (reconstructed_total = opening_amount)
);
CREATE TABLE mp_historical_payout (
  identity             VARCHAR(80) PRIMARY KEY REFERENCES mp_historical_row(identity) ON DELETE RESTRICT ON UPDATE CASCADE,
  source_id            VARCHAR(30) NOT NULL,
  occurred_date        DATE        NOT NULL,
  amount               NUMERIC(15,2) NOT NULL,
  destination_status   VARCHAR(40) NOT NULL,
  matched_account_id   UUID REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_last4    CHAR(4),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mhp_status CHECK (destination_status IN ('OWN_ACCOUNT_TRANSFER_CANDIDATE', 'THIRD_PARTY', 'UNKNOWN_DESTINATION')),
  CONSTRAINT chk_mhp_own CHECK ((destination_status = 'OWN_ACCOUNT_TRANSFER_CANDIDATE') = (matched_account_id IS NOT NULL))
);
CREATE INDEX idx_mhrow_run ON mp_historical_row(run_id, row_number);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['mp_historical_run', 'mp_historical_row', 'mp_historical_destination', 'mp_historical_reconstruction', 'mp_historical_payout'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard()', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE mp_historical_row_id_seq, mp_historical_reconstruction_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_historical_run, mp_historical_row, mp_historical_reconstruction, mp_historical_payout TO authenticated;   -- the destination stays private
CREATE POLICY mp_historical_run_admin_select ON mp_historical_run FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_historical_row_admin_select ON mp_historical_row FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_historical_reconstruction_admin_select ON mp_historical_reconstruction FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_historical_payout_admin_select ON mp_historical_payout FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── 2. staging of one release report file ─────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_historical_stage(p_file_name TEXT, p_file_sha256 TEXT, p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_keys   CONSTANT TEXT[] := ARRAY['BALANCE_AMOUNT','BUSINESS_UNIT','DATE','DESCRIPTION','GROSS_AMOUNT','MP_FEE_AMOUNT','NET_CREDIT_AMOUNT',
    'NET_DEBIT_AMOUNT','PAYMENT_METHOD','PAYMENT_METHOD_TYPE','PURCHASE_ID','SOURCE_ID','SUB_UNIT','TAXES_AMOUNT','TRANSACTION_APPROVAL_DATE'];
  c_amount CONSTANT TEXT := '^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
  c_ts     CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
  v_uid    UUID := auth.uid();
  v_cut    TIMESTAMPTZ;
  v_run    mp_historical_run%ROWTYPE;
  v_run_id UUID;
  r        JSONB;
  v_raw    JSONB;
  v_n      INTEGER := 0;
  v_ctl    INTEGER := 0;
  v_new    INTEGER := 0;
  v_dup    INTEGER := 0;
  v_excl   INTEGER := 0;
  v_dest   INTEGER := 0;
  v_keys   TEXT[];
  v_sid    TEXT;
  v_desc   TEXT;
  v_net    NUMERIC(15,2);
  v_at     TIMESTAMPTZ;
  v_ident  TEXT;
  v_ex     mp_historical_row%ROWTYPE;
  v_dv     TEXT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_file_name IS NULL OR btrim(p_file_name) = '' OR p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_FILE_METADATA';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: rows must be a JSON array of {row_number, raw_row}';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_historical_reconstruction', 0));
  IF EXISTS (SELECT 1 FROM mp_historical_reconstruction) THEN
    RAISE EXCEPTION 'HISTORICAL_ALREADY_APPLIED: the reconstruction is closed; richer evidence needs its own path';
  END IF;
  SELECT cutover_at INTO v_cut FROM mp_cutover_boundary;
  IF v_cut IS NULL THEN
    RAISE EXCEPTION 'CUTOVER_BOUNDARY_MISSING';
  END IF;
  SELECT * INTO v_run FROM mp_historical_run WHERE file_sha256 = p_file_sha256;
  IF FOUND THEN
    RETURN jsonb_build_object('run_id', v_run.id, 'replayed', true);
  END IF;
  INSERT INTO mp_historical_run (file_name, file_sha256, created_by) VALUES (left(p_file_name, 255), p_file_sha256, v_uid) RETURNING id INTO v_run_id;

  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_n := v_n + 1;
    IF jsonb_typeof(r) <> 'object' OR (r ->> 'row_number') IS DISTINCT FROM v_n::TEXT OR jsonb_typeof(r -> 'raw_row') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: row % must be {row_number = %, raw_row}', v_n, v_n;
    END IF;
    v_raw := r -> 'raw_row';
    SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(v_raw) k WHERE k <> 'PAYOUT_BANK_ACCOUNT_NUMBER';
    IF v_keys IS DISTINCT FROM c_keys OR EXISTS (SELECT 1 FROM jsonb_each(v_raw) x WHERE jsonb_typeof(x.value) <> 'string') THEN
      RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: row % must hold the 15 Liberaciones keys (+ PAYOUT_BANK_ACCOUNT_NUMBER) as strings', v_n;
    END IF;
    v_sid := v_raw ->> 'SOURCE_ID'; v_desc := v_raw ->> 'DESCRIPTION';
    IF v_sid = '' AND v_desc = '' THEN
      v_ctl := v_ctl + 1;   -- opening / totals control row: evidence of the file, no movement
      CONTINUE;
    END IF;
    IF v_sid !~ '^[0-9]{1,20}$' OR v_desc !~ '^[a-z_]{1,40}$' OR (v_raw ->> 'DATE') !~ c_ts
       OR (v_raw ->> 'NET_CREDIT_AMOUNT') !~ c_amount OR (v_raw ->> 'NET_DEBIT_AMOUNT') !~ c_amount OR (v_raw ->> 'GROSS_AMOUNT') !~ c_amount
       OR (v_raw ->> 'MP_FEE_AMOUNT') !~ c_amount OR (v_raw ->> 'TAXES_AMOUNT') !~ c_amount OR (v_raw ->> 'BALANCE_AMOUNT') !~ c_amount THEN
      RAISE EXCEPTION 'INVALID_ROW: row % fails the release report contract', v_n;
    END IF;
    v_net := (v_raw ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (v_raw ->> 'NET_DEBIT_AMOUNT')::NUMERIC;
    PERFORM (v_raw ->> 'BALANCE_AMOUNT')::NUMERIC(15,2);   -- malformed report balance → refused
    v_at := (v_raw ->> 'DATE')::TIMESTAMPTZ;
    v_ident := v_sid || ':' || v_desc || ':' || CASE WHEN v_net > 0 THEN 'C' ELSE 'D' END;
    IF v_at >= v_cut THEN
      v_excl := v_excl + 1;   -- post-cutover production history: never imported historically
      CONTINUE;
    END IF;
    SELECT * INTO v_ex FROM mp_historical_row WHERE identity = v_ident;
    IF FOUND THEN
      IF v_ex.occurred_at <> v_at OR v_ex.net_amount <> v_net OR v_ex.gross_amount <> (v_raw ->> 'GROSS_AMOUNT')::NUMERIC
         OR v_ex.fee_amount <> (v_raw ->> 'MP_FEE_AMOUNT')::NUMERIC OR v_ex.tax_amount <> (v_raw ->> 'TAXES_AMOUNT')::NUMERIC
         OR (v_ex.raw_row ->> 'BALANCE_AMOUNT')::NUMERIC <> (v_raw ->> 'BALANCE_AMOUNT')::NUMERIC THEN
        RAISE EXCEPTION 'HISTORICAL_ROW_CONFLICT: % differs from the staged evidence', v_ident;
      END IF;
      v_dup := v_dup + 1;
    ELSE
      IF EXISTS (SELECT 1 FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = v_ident) THEN
        RAISE EXCEPTION 'HISTORICAL_IDENTITY_COLLISION: % already exists in production history', v_ident;
      END IF;
      INSERT INTO mp_historical_row (run_id, row_number, identity, source_id, description, direction, occurred_at, occurred_date, payment_method,
             net_amount, gross_amount, fee_amount, tax_amount, raw_row)
      VALUES (v_run_id, v_n, v_ident, v_sid, v_desc, CASE WHEN v_net > 0 THEN 'C' ELSE 'D' END, v_at,
              (v_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE, nullif(v_raw ->> 'PAYMENT_METHOD', ''), v_net,
              (v_raw ->> 'GROSS_AMOUNT')::NUMERIC, (v_raw ->> 'MP_FEE_AMOUNT')::NUMERIC, (v_raw ->> 'TAXES_AMOUNT')::NUMERIC,
              v_raw);
      v_new := v_new + 1;
    END IF;
    v_dv := nullif(btrim(coalesce(v_raw ->> 'PAYOUT_BANK_ACCOUNT_NUMBER', '')), '');
    IF v_dv IS NOT NULL AND v_desc = 'payout' THEN
      IF v_dv !~ '^[0-9]{6,40}$' THEN
        RAISE EXCEPTION 'INVALID_ROW: row % has a malformed payout destination', v_n;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM mp_historical_destination WHERE identity = v_ident) THEN
        INSERT INTO mp_historical_destination (identity, run_id, destination_value) VALUES (v_ident, v_run_id, v_dv);
        v_dest := v_dest + 1;
      ELSIF (SELECT destination_value FROM mp_historical_destination WHERE identity = v_ident) <> v_dv THEN
        RAISE EXCEPTION 'HISTORICAL_DESTINATION_CONFLICT: % has two destinations', v_ident;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_historical_run', v_run_id::TEXT, 'MP_HISTORICAL_STAGED',
          jsonb_build_object('file_name', p_file_name, 'file_sha256', p_file_sha256, 'rows', v_n, 'control_rows', v_ctl, 'staged', v_new,
                             'duplicates', v_dup, 'excluded_post_cutover', v_excl, 'destinations', v_dest),
          'ADR-022: historical release report evidence', v_uid);
  RETURN jsonb_build_object('run_id', v_run_id, 'replayed', false, 'rows', v_n, 'control_rows', v_ctl, 'staged', v_new, 'duplicates', v_dup,
                            'excluded_post_cutover', v_excl, 'destinations', v_dest);
END;
$$;
ALTER FUNCTION mp_historical_stage(TEXT, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_historical_stage(TEXT, TEXT, JSONB) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_historical_stage(TEXT, TEXT, JSONB) TO authenticated;

-- ── 3. reconstruction + opening neutralization (one transaction) ──────────────
CREATE OR REPLACE FUNCTION mp_historical_reconstruct(p_expected_total NUMERIC, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_rec     mp_historical_reconstruction%ROWTYPE;
  v_cut     TIMESTAMPTZ;
  v_mp      UUID;
  v_open    financial_operation%ROWTYPE;
  v_open_n  INTEGER;
  v_open_amt NUMERIC(15,2);
  v_run     NUMERIC(15,2) := 0;
  v_posted  NUMERIC(15,2) := 0;
  h         mp_historical_row%ROWTYPE;
  v_class   TEXT;
  v_kind    TEXT;
  v_src     UUID;
  v_mv      BIGINT;
  v_tid     BIGINT;
  v_op      BIGINT;
  v_key     TEXT;
  v_c       RECORD;
  v_plan    JSONB;
  v_dest    TEXT;
  v_own     UUID;
  v_neut    BIGINT;
  v_rows    INTEGER := 0;
  v_cnt     JSONB := '{}'::jsonb;
  v_sum     JSONB := '{}'::jsonb;
  v_id      BIGINT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_expected_total IS NULL OR p_expected_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: the expected total is the cutover opening';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_historical_reconstruction', 0));
  SELECT * INTO v_rec FROM mp_historical_reconstruction;
  IF FOUND THEN
    RETURN jsonb_build_object('reconstruction_id', v_rec.id, 'replayed', true, 'rows_applied', v_rec.rows_applied,
      'reconstructed_total', v_rec.reconstructed_total, 'neutralization_operation_id', v_rec.neutralization_operation_id);
  END IF;
  SELECT cutover_at INTO v_cut FROM mp_cutover_boundary;
  IF v_cut IS NULL THEN
    RAISE EXCEPTION 'CUTOVER_BOUNDARY_MISSING';
  END IF;
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;
  -- the Mercado Pago cutover opening: exactly one, one posting on Mercado Pago
  SELECT count(*) INTO v_open_n FROM financial_operation o
   WHERE o.source_entity_type = 'phase31_opening' AND EXISTS (SELECT 1 FROM financial_posting p WHERE p.financial_operation_id = o.id AND p.financial_account_id = v_mp);
  IF v_open_n <> 1 THEN
    RAISE EXCEPTION 'OPENING_NOT_FOUND: % Mercado Pago cutover openings', v_open_n;
  END IF;
  SELECT o.* INTO v_open FROM financial_operation o
   WHERE o.source_entity_type = 'phase31_opening' AND EXISTS (SELECT 1 FROM financial_posting p WHERE p.financial_operation_id = o.id AND p.financial_account_id = v_mp);
  SELECT sum(signed_amount) INTO v_open_amt FROM financial_posting WHERE financial_operation_id = v_open.id AND financial_account_id = v_mp;
  IF EXISTS (SELECT 1 FROM mp_source_exception WHERE kind = 'OPENING_NEUTRALIZATION') THEN
    RAISE EXCEPTION 'OPENING_ALREADY_NEUTRALIZED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mp_historical_row) THEN
    RAISE EXCEPTION 'HISTORICAL_NOT_STAGED';
  END IF;

  -- gate 1: continuity from 0.00 and the exact total, before ANY write
  FOR h IN SELECT * FROM mp_historical_row ORDER BY id LOOP
    IF h.occurred_at >= v_cut THEN
      RAISE EXCEPTION 'HISTORICAL_ROW_AFTER_CUTOVER: %', h.identity;
    END IF;
    v_run := v_run + h.net_amount;
    IF v_run <> (h.raw_row ->> 'BALANCE_AMOUNT')::NUMERIC THEN
      RAISE EXCEPTION 'HISTORICAL_CONTINUITY_BREAK: % reconstructed % report %', h.identity, v_run, h.raw_row ->> 'BALANCE_AMOUNT';
    END IF;
  END LOOP;
  IF v_run <> v_open_amt OR v_run <> p_expected_total THEN
    RAISE EXCEPTION 'HISTORICAL_TOTAL_MISMATCH: reconstructed % opening % expected %', v_run, v_open_amt, p_expected_total;
  END IF;

  -- every staged row once
  FOR h IN SELECT * FROM mp_historical_row ORDER BY id LOOP
    v_class := CASE
      WHEN h.description LIKE 'reserve\_%' THEN 'RESERVE'
      WHEN h.description = 'asset_management' AND h.direction = 'C' THEN 'YIELD'
      WHEN h.description = 'payment' AND h.direction = 'C' AND h.payment_method IN ('cvu', 'debin_transfer') THEN 'INFLOW'
      WHEN h.description = 'payment' AND h.direction = 'C' THEN 'RECEIPT'
      WHEN h.description = 'payment' AND h.direction = 'D' THEN 'OUTBOUND'
      WHEN h.description = 'payout' AND h.direction = 'D' THEN 'PAYOUT'
      ELSE NULL END;
    IF v_class IS NULL THEN
      RAISE EXCEPTION 'HISTORICAL_UNSUPPORTED_ROW: %', h.identity;
    END IF;
    v_rows := v_rows + 1;
    v_cnt := jsonb_set(v_cnt, ARRAY[v_class], to_jsonb(coalesce((v_cnt ->> v_class)::INTEGER, 0) + 1));
    v_sum := jsonb_set(v_sum, ARRAY[v_class], to_jsonb(coalesce((v_sum ->> v_class)::NUMERIC, 0) + h.net_amount));
    BEGIN
      INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date, processing_status, processing_note, processed_at)
      VALUES ('csv_import', h.identity, h.raw_row, h.occurred_at, h.occurred_date,
              (CASE v_class WHEN 'RESERVE' THEN 'IGNORED' WHEN 'RECEIPT' THEN 'RECONCILED' WHEN 'YIELD' THEN 'RECONCILED' ELSE 'NORMALIZED' END)::mp_processing_status,
              CASE v_class WHEN 'RESERVE' THEN 'ADR-022: RESERVE_ROW (historical evidence only)' ELSE 'ADR-022: historical reconstruction' END, NOW())
      RETURNING id INTO v_src;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'HISTORICAL_IDENTITY_COLLISION: %', h.identity;
    END;
    CONTINUE WHEN v_class = 'RESERVE';
    v_kind := CASE v_class WHEN 'RECEIPT' THEN 'payment' WHEN 'YIELD' THEN 'yield' WHEN 'INFLOW' THEN 'inflow' WHEN 'OUTBOUND' THEN 'outbound' ELSE 'transfer' END;
    IF h.gross_amount + h.fee_amount + h.tax_amount <> h.net_amount AND v_class <> 'YIELD' THEN
      RAISE EXCEPTION 'HISTORICAL_AMOUNTS_INVALID: % gross % fee % tax % net %', h.identity, h.gross_amount, h.fee_amount, h.tax_amount, h.net_amount;
    END IF;
    INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES (v_src, v_kind, h.gross_amount, h.fee_amount, h.tax_amount, h.net_amount, h.occurred_date)
    RETURNING id INTO v_mv;
    BEGIN
      INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
      VALUES (CASE v_class WHEN 'RECEIPT' THEN 'payment' ELSE 'report' END,
              CASE v_class WHEN 'RECEIPT' THEN h.source_id ELSE h.identity END,
              CASE v_class WHEN 'RECEIPT' THEN 'APPROVAL' WHEN 'INFLOW' THEN 'APPROVAL' WHEN 'YIELD' THEN 'YIELD' WHEN 'OUTBOUND' THEN 'OUTBOUND' ELSE 'PAYOUT' END,
              '', v_src, v_mv)
      RETURNING id INTO v_tid;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'HISTORICAL_IDENTITY_COLLISION: % (transition)', h.identity;
    END;
    IF v_class IN ('RECEIPT', 'YIELD') THEN
      -- the A1 application plan (0051): settlement + fee + tax, keys MPA:<transition>:…
      v_plan := '[]'::jsonb;
      IF v_class = 'RECEIPT' THEN
        v_plan := v_plan || jsonb_build_array(jsonb_build_object('k', format('MPA:%s:SETTLE', v_tid), 'type', 'MP_SETTLEMENT', 'amount', h.gross_amount));
        IF h.fee_amount <> 0 THEN v_plan := v_plan || jsonb_build_array(jsonb_build_object('k', format('MPA:%s:FEE', v_tid), 'type', 'FEE', 'amount', h.fee_amount)); END IF;
        IF h.tax_amount <> 0 THEN v_plan := v_plan || jsonb_build_array(jsonb_build_object('k', format('MPA:%s:TAX', v_tid), 'type', 'ADJUSTMENT', 'amount', h.tax_amount)); END IF;
      ELSE
        v_plan := jsonb_build_array(jsonb_build_object('k', format('MPA:%s:SETTLE', v_tid), 'type', 'MP_SETTLEMENT', 'amount', h.net_amount));
      END IF;
      FOR v_c IN SELECT c FROM jsonb_array_elements(v_plan) c LOOP
        INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
        VALUES ((v_c.c ->> 'type')::financial_operation_type, h.occurred_date, 'MP:' || (v_c.c ->> 'k'), 'mp_financial_movement', v_mv::TEXT,
                'ADR-022 historical reconstruction', v_uid)
        RETURNING id INTO v_op;
        INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
        VALUES (v_op, v_mp, (v_c.c ->> 'amount')::NUMERIC, h.occurred_date, v_uid);
        INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_by)
        VALUES (v_mv, v_op, v_mp, (v_c.c ->> 'amount')::NUMERIC, v_c.c ->> 'k', v_uid);
        v_posted := v_posted + (v_c.c ->> 'amount')::NUMERIC;
      END LOOP;
    ELSE
      -- the ADR-021 provisional: the real effect now, the classification later
      v_key := 'MP-PENDING:' || h.source_id;
      INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
      VALUES ('ADJUSTMENT', h.occurred_date, v_key, 'mp_financial_movement', v_mv::TEXT,
              'Mercado Pago: pendiente de clasificar (' || h.source_id || ', histórico ADR-022)', v_uid)
      RETURNING id INTO v_op;
      INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
      VALUES (v_op, v_mp, h.net_amount, h.occurred_date, v_uid);
      INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_by)
      VALUES (v_mv, v_op, v_mp, h.net_amount, v_key, v_uid);
      BEGIN
        INSERT INTO mp_pending_outflow (source_id, kind, mp_financial_movement_id, mp_account_id, provisional_operation_id, amount, occurred_date, run_id, created_by)
        VALUES (h.source_id, v_class, v_mv, v_mp, v_op, h.net_amount, h.occurred_date, NULL, v_uid);
      EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'HISTORICAL_IDENTITY_COLLISION: % (pending)', h.identity;
      END;
      v_posted := v_posted + h.net_amount;
      IF v_class = 'PAYOUT' THEN
        SELECT destination_value INTO v_dest FROM mp_historical_destination WHERE identity = h.identity;
        v_own := NULL;
        IF v_dest IS NOT NULL THEN
          SELECT i.financial_account_id INTO v_own FROM financial_account_identifier i JOIN financial_account a ON a.id = i.financial_account_id
           WHERE i.active AND a.activo AND a.account_type = 'BANK_ACCOUNT' AND i.identifier_type IN ('CBU', 'CVU') AND i.normalized_value = v_dest
             AND (i.valid_from IS NULL OR i.valid_from <= h.occurred_date) AND (i.valid_to IS NULL OR i.valid_to >= h.occurred_date)
           LIMIT 1;
        END IF;
        INSERT INTO mp_historical_payout (identity, source_id, occurred_date, amount, destination_status, matched_account_id, destination_last4)
        VALUES (h.identity, h.source_id, h.occurred_date, h.net_amount,
                CASE WHEN v_own IS NOT NULL THEN 'OWN_ACCOUNT_TRANSFER_CANDIDATE' WHEN v_dest IS NOT NULL THEN 'THIRD_PARTY' ELSE 'UNKNOWN_DESTINATION' END,
                v_own, right(v_dest, 4));
      END IF;
    END IF;
  END LOOP;

  -- gate 2: what was posted is exactly the reconstructed total (= the opening)
  IF v_posted <> v_run THEN
    RAISE EXCEPTION 'HISTORICAL_POSTING_MISMATCH: posted % reconstructed %', v_posted, v_run;
  END IF;

  -- the explicit neutralization of the cutover opening (never deleted nor modified)
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', v_open.effective_date, 'MP-HIST-OPENING-NEUTRALIZATION:' || v_open.id, 'phase31_opening_neutralization', v_open.id::TEXT,
          'ADR-022: la historia reconstruida reemplaza la apertura del corte de Mercado Pago', v_uid)
  RETURNING id INTO v_neut;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_neut, v_mp, -v_open_amt, v_open.effective_date, v_uid);
  INSERT INTO mp_source_exception (financial_operation_id, kind, amount, reason, evidence_ref, created_by)
  VALUES (v_neut, 'OPENING_NEUTRALIZATION', -v_open_amt, p_reason, 'ADR-022:opening:' || v_open.id, v_uid);

  INSERT INTO mp_historical_reconstruction (cutover_at, rows_applied, reconstructed_total, opening_operation_id, opening_amount,
         neutralization_operation_id, summary, reason, created_by)
  VALUES (v_cut, v_rows, v_run, v_open.id, v_open_amt, v_neut, jsonb_build_object('counts', v_cnt, 'amounts', v_sum), p_reason, v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_historical_reconstruction', v_id::TEXT, 'MP_HISTORICAL_RECONSTRUCTED',
          jsonb_build_object('rows', v_rows, 'total', v_run, 'opening_operation', v_open.id, 'neutralization_operation', v_neut,
                             'counts', v_cnt, 'amounts', v_sum, 'cutover_at', v_cut), p_reason, v_uid);
  RETURN jsonb_build_object('reconstruction_id', v_id, 'replayed', false, 'rows_applied', v_rows, 'reconstructed_total', v_run,
    'opening_amount', v_open_amt, 'neutralization_operation_id', v_neut, 'counts', v_cnt, 'amounts', v_sum);
END;
$$;
ALTER FUNCTION mp_historical_reconstruct(NUMERIC, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_historical_reconstruct(NUMERIC, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_historical_reconstruct(NUMERIC, TEXT) TO authenticated;

-- ── 4. pending classification with historical inflows (0093 bodies; [0094] INFLOW = incoming) ──
CREATE OR REPLACE FUNCTION mp_pending_classification_totals(p_from DATE, p_to DATE)
RETURNS TABLE (pending_count BIGINT, outgoing NUMERIC, incoming NUMERIC, unposted_count BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH o AS (
    SELECT p.amount, p.kind FROM mp_pending_outflow p
     WHERE p.occurred_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
  ), i AS (
    SELECT m.gross_amount FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
      JOIN mp_source_record ps ON ps.id = m.mp_source_record_id
     WHERE t.resource_type = 'payment' AND t.transition = 'APPROVAL' AND t.transition_ref = ''
       AND ps.event_data ->> 'operation_type' = 'account_fund' AND ps.event_data ->> 'payment_method_id' = 'debin_transfer'
       AND NOT EXISTS (SELECT 1 FROM mp_reconciliation rc WHERE rc.mp_financial_movement_id = m.id)
       AND m.occurred_date BETWEEN p_from AND p_to
  ), u AS (
    SELECT s.id FROM mp_source_record s
     WHERE s.source_type = 'csv_import' AND (s.external_id LIKE '%:payment:D' OR EXISTS (SELECT 1 FROM mp_transition_identity tp WHERE tp.resource_type = 'report' AND tp.resource_id = s.external_id AND tp.transition = 'PAYOUT'))
       AND s.processing_status NOT IN ('IGNORED', 'ERROR')
       AND (s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC < 0
       AND NOT EXISTS (SELECT 1 FROM mp_transition_identity t JOIN mp_reconciliation r ON r.mp_financial_movement_id = t.mp_financial_movement_id
                        WHERE t.resource_type = 'report' AND t.resource_id = s.external_id)
       AND s.occurred_date BETWEEN p_from AND p_to
  )
  SELECT (SELECT count(*) FROM o) + (SELECT count(*) FROM i), coalesce((SELECT sum(amount) FROM o WHERE kind <> 'INFLOW'), 0),   -- [0094] INFLOW = incoming
         coalesce((SELECT sum(gross_amount) FROM i), 0) + coalesce((SELECT sum(amount) FROM o WHERE kind = 'INFLOW'), 0), (SELECT count(*) FROM u)
$$;
ALTER FUNCTION mp_pending_classification_totals(DATE, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_pending_classification_totals(DATE, DATE) FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE VIEW fin_mp_pending_classification
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT CASE p.kind WHEN 'INFLOW' THEN 'HIN:' ELSE 'OUT:' END || p.source_id AS pending_key, p.source_id::TEXT AS source_id, p.kind::TEXT AS kind,
         CASE p.kind WHEN 'INFLOW' THEN 'IN' ELSE 'OUT' END::TEXT AS direction,   -- [0094] historical CVU / DEBIN inflow (ADR-022)
         p.occurred_date AS business_date, s.occurred_at, p.amount, abs(m.gross_amount) AS economic_amount,
         (m.fee_amount + m.tax_amount) AS charges_amount, a.nombre::TEXT AS account_name,
         CASE p.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END AS description,
         'PENDING'::TEXT AS status, true AS already_posted, p.provisional_operation_id AS financial_operation_id
    FROM mp_pending_outflow p
    JOIN mp_financial_movement m ON m.id = p.mp_financial_movement_id
    JOIN mp_source_record s ON s.id = m.mp_source_record_id
    JOIN financial_account a ON a.id = p.mp_account_id
   WHERE NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
  UNION ALL
  SELECT 'IN:' || t.resource_id, t.resource_id::TEXT, 'CLASSIFY_INFLOW', 'IN', m.occurred_date, ps.occurred_at, m.gross_amount, m.gross_amount,
         (m.fee_amount + m.tax_amount), 'Mercado Pago', 'payment', 'PENDING', false, NULL::BIGINT
    FROM mp_transition_identity t
    JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
    JOIN mp_source_record ps ON ps.id = m.mp_source_record_id
   WHERE t.resource_type = 'payment' AND t.transition = 'APPROVAL' AND t.transition_ref = ''
     AND ps.event_data ->> 'operation_type' = 'account_fund' AND ps.event_data ->> 'payment_method_id' = 'debin_transfer'
     AND NOT EXISTS (SELECT 1 FROM mp_reconciliation rc WHERE rc.mp_financial_movement_id = m.id)
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_pending_classification OWNER TO postgres;
REVOKE ALL    ON fin_mp_pending_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_pending_classification TO authenticated;

-- ── 5. historical status / payouts (ADMIN; never a full account number) ───────
CREATE OR REPLACE VIEW fin_mp_historical_status
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT c.class, count(*) AS row_count, coalesce(sum(h.net_amount), 0)::NUMERIC(15,2) AS amount,
         (SELECT count(*) FROM mp_historical_reconstruction) = 1 AS reconstructed,
         (SELECT reconstructed_total FROM mp_historical_reconstruction) AS reconstructed_total,
         (SELECT neutralization_operation_id FROM mp_historical_reconstruction) AS neutralization_operation_id
    FROM mp_historical_row h
    CROSS JOIN LATERAL (SELECT CASE
      WHEN h.description LIKE 'reserve\_%' THEN 'RESERVE'
      WHEN h.description = 'asset_management' AND h.direction = 'C' THEN 'YIELD'
      WHEN h.description = 'payment' AND h.direction = 'C' AND h.payment_method = 'cvu' THEN 'INFLOW_CVU'
      WHEN h.description = 'payment' AND h.direction = 'C' AND h.payment_method = 'debin_transfer' THEN 'INFLOW_DEBIN'
      WHEN h.description = 'payment' AND h.direction = 'C' THEN 'RECEIPT'
      WHEN h.description = 'payment' AND h.direction = 'D' THEN 'OUTBOUND'
      WHEN h.description = 'payout' AND h.direction = 'D' THEN 'PAYOUT'
      ELSE 'UNSUPPORTED' END AS class) c
   GROUP BY c.class
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_historical_status OWNER TO postgres;
REVOKE ALL    ON fin_mp_historical_status FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_historical_status TO authenticated;

CREATE OR REPLACE VIEW fin_mp_historical_payouts
WITH (security_invoker = true)
AS
SELECT p.source_id::TEXT AS source_id, p.occurred_date AS business_date, p.amount, p.destination_status::TEXT AS destination_status,
       (SELECT a.nombre::TEXT FROM financial_account a WHERE a.id = p.matched_account_id) AS matched_account_name, p.destination_last4::TEXT AS destination_last4,
       NOT EXISTS (SELECT 1 FROM mp_pending_outflow po JOIN mp_pending_outflow_resolution r ON r.pending_id = po.id WHERE po.source_id = p.source_id) AS pending
  FROM mp_historical_payout p
 WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_historical_payouts OWNER TO postgres;
REVOKE ALL    ON fin_mp_historical_payouts FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_historical_payouts TO authenticated;
