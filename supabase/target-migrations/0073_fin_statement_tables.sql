-- ============================================================================
-- TARGET V1 — 0073 FINANCIAL STATEMENT IMPORT TABLES (ADR-018, bank branch, step 1)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md (ACCEPTED; commit 8165fd6)
--            §6.1–§6.6 (evidence model, cutover), §7.1 (canonical fields), §7.4 (K-1 config),
--            §12–§13 (idempotency, immutability), §16 (invariants).
--
-- Structure only:
--   fin_statement_account_config  expected identifiers per bank account (K-1; seeded by a later migration)
--   fin_import_run                one processing attempt over one stored original file (§6.1)
--   fin_statement_line            one unique, immutable bank fact (§6.2)
--   fin_import_run_line           one row's appearance in one run (§6.3), common to BANK_STATEMENT / MP_RELEASE_REPORT
--   fin_statement_match           manual, append-only 1:1 reconciliation (§6.4, §8)
--   fin_statement_cutover         owner decision fixing the opening cut of one bank account (§6.6)
-- plus SECURITY INVOKER guard triggers (immutability, append-only, structural integrity).
--
-- NOT here (later migrations): RLS policies, grants, Storage bucket, config seed, SECURITY DEFINER
-- functions (import, match, reverse, cutover), the K-4 anchor-balance rule, previous_run_id semantics,
-- views. Existing tables receive no DDL.
--
-- Privileges: every new table is created fail-closed, as 0047 does (RLS enabled, no policy, all
-- privileges revoked from PUBLIC / anon / authenticated / service_role). Nothing is granted here.
--
-- Guards are SECURITY INVOKER (as mp_source_raw_guard, 0039): they compare OLD/NEW or read rows that
-- the future SECURITY DEFINER functions (owner postgres) can already read. They are not part of the
-- SECURITY DEFINER inventory.
-- ============================================================================

-- ── fin_statement_account_config — expected bank identifiers (§7.4, K-1) ────
CREATE TABLE fin_statement_account_config (
  financial_account_id     UUID PRIMARY KEY REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  format_code              VARCHAR(50) NOT NULL,
  expected_account_number  VARCHAR(30) NOT NULL,
  expected_cbu             CHAR(22)    NOT NULL,
  expected_extra           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  activo                   BOOLEAN     NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fsac_format_code  CHECK (btrim(format_code) <> ''),
  CONSTRAINT chk_fsac_account_nr   CHECK (btrim(expected_account_number) <> ''),
  CONSTRAINT chk_fsac_cbu          CHECK (expected_cbu ~ '^[0-9]{22}$'),
  CONSTRAINT chk_fsac_extra_object CHECK (jsonb_typeof(expected_extra) = 'object')
);
ALTER TABLE fin_statement_account_config ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION fin_statement_account_config_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM financial_account
                  WHERE id = NEW.financial_account_id AND account_type = 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'FIN_CONFIG_NOT_BANK_ACCOUNT: financial_account % is not a BANK_ACCOUNT', NEW.financial_account_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION fin_statement_account_config_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_account_config_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fin_statement_account_config_guard
  BEFORE INSERT OR UPDATE ON fin_statement_account_config
  FOR EACH ROW EXECUTE FUNCTION fin_statement_account_config_guard();

-- ── fin_import_run — one processing attempt (§6.1) ─────────────────────────
CREATE TABLE fin_import_run (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind           VARCHAR(20)  NOT NULL,
  mode                  VARCHAR(10)  NOT NULL,
  financial_account_id  UUID         NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  format_code           VARCHAR(50),
  parser_version        VARCHAR(50)  NOT NULL,
  file_sha256           CHAR(64)     NOT NULL,
  storage_path          TEXT         NOT NULL,
  file_name             VARCHAR(255) NOT NULL,
  byte_size             BIGINT       NOT NULL,
  coverage_from         DATE,
  coverage_to           DATE,
  status                VARCHAR(10)  NOT NULL,
  reject_reason         TEXT,
  rows_total            INTEGER      NOT NULL DEFAULT 0,
  lines_new             INTEGER      NOT NULL DEFAULT 0,
  lines_known           INTEGER      NOT NULL DEFAULT 0,
  rows_ignored          INTEGER      NOT NULL DEFAULT 0,
  rows_invalid          INTEGER      NOT NULL DEFAULT 0,
  rows_captured         INTEGER      NOT NULL DEFAULT 0,
  source_meta           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  previous_run_id       UUID REFERENCES fin_import_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fir_source_kind    CHECK (source_kind IN ('BANK_STATEMENT', 'MP_RELEASE_REPORT')),
  CONSTRAINT chk_fir_mode           CHECK (mode IN ('NORMAL', 'VALIDATION')),
  CONSTRAINT chk_fir_status         CHECK (status IN ('PARSED', 'VALIDATED', 'REJECTED')),
  CONSTRAINT chk_fir_mode_status    CHECK ((mode = 'NORMAL'     AND status IN ('PARSED', 'REJECTED'))
                                        OR (mode = 'VALIDATION' AND status IN ('VALIDATED', 'REJECTED'))),
  CONSTRAINT chk_fir_parser_version CHECK (btrim(parser_version) <> ''),
  CONSTRAINT chk_fir_format_code    CHECK (format_code IS NULL OR btrim(format_code) <> ''),
  CONSTRAINT chk_fir_sha256         CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_fir_storage_path   CHECK (btrim(storage_path) <> ''),
  CONSTRAINT chk_fir_file_name      CHECK (btrim(file_name) <> ''),
  CONSTRAINT chk_fir_byte_size      CHECK (byte_size > 0),
  CONSTRAINT chk_fir_coverage       CHECK (coverage_from IS NULL OR coverage_to IS NULL OR coverage_from <= coverage_to),
  CONSTRAINT chk_fir_counters       CHECK (rows_total >= 0 AND lines_new >= 0 AND lines_known >= 0
                                           AND rows_ignored >= 0 AND rows_invalid >= 0 AND rows_captured >= 0),
  CONSTRAINT chk_fir_reject_reason  CHECK ((status = 'REJECTED') = (reject_reason IS NOT NULL AND btrim(reject_reason) <> '')),
  CONSTRAINT chk_fir_bank_actor     CHECK (source_kind <> 'BANK_STATEMENT' OR created_by IS NOT NULL),
  CONSTRAINT chk_fir_source_meta    CHECK (jsonb_typeof(source_meta) = 'object'),
  CONSTRAINT chk_fir_not_self_prev  CHECK (previous_run_id IS DISTINCT FROM id),
  CONSTRAINT uq_fir_attempt         UNIQUE (financial_account_id, file_sha256, mode, parser_version),
  CONSTRAINT uq_fir_id_kind_mode    UNIQUE (id, source_kind, mode)
);
ALTER TABLE fin_import_run ENABLE ROW LEVEL SECURITY;

-- one effective NORMAL processing per file and account; REJECTED attempts do not block a reprocess (§6.1)
CREATE UNIQUE INDEX uq_fir_effective_file ON fin_import_run(financial_account_id, file_sha256)
  WHERE mode = 'NORMAL' AND status <> 'REJECTED';
CREATE INDEX idx_fir_account_created ON fin_import_run(financial_account_id, created_at);
CREATE INDEX idx_fir_previous_run    ON fin_import_run(previous_run_id);

-- ── fin_statement_line — one unique, immutable bank fact (§6.2) ────────────
-- No page, row, parser, format or position data: those belong to the appearance (§6.3).
CREATE TABLE fin_statement_line (
  id                    BIGSERIAL PRIMARY KEY,
  financial_account_id  UUID          NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  value_date            DATE          NOT NULL,
  description_raw       TEXT          NOT NULL,
  description_norm      TEXT          NOT NULL,
  bank_reference        VARCHAR(100)  NOT NULL DEFAULT '',
  fecha_valor           DATE,
  signed_amount         NUMERIC(15,2) NOT NULL,
  running_balance       NUMERIC(15,2),
  fingerprint           CHAR(64)      NOT NULL,
  first_run_id          UUID          NOT NULL REFERENCES fin_import_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fsl_description_raw  CHECK (btrim(description_raw) <> ''),
  CONSTRAINT chk_fsl_description_norm CHECK (description_norm <> ''),
  -- printable ASCII (U+0020–U+007E), no leading/trailing SPACE; empty when absent (§7.1)
  CONSTRAINT chk_fsl_bank_reference   CHECK (bank_reference ~ '^([!-~]([ -~]*[!-~])?)?$'),
  CONSTRAINT chk_fsl_signed_amount    CHECK (signed_amount <> 0),
  CONSTRAINT chk_fsl_fingerprint      CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT uq_fsl_account_fingerprint UNIQUE (financial_account_id, fingerprint),
  CONSTRAINT uq_fsl_id_account          UNIQUE (id, financial_account_id)
);
ALTER TABLE fin_statement_line ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_fsl_account_date ON fin_statement_line(financial_account_id, value_date);
CREATE INDEX idx_fsl_first_run    ON fin_statement_line(first_run_id);

-- ── fin_import_run_line — appearance of one row in one run (§6.3) ──────────
-- source_kind / mode are carried from the run through the composite FK, so the destination
-- rules below are declarative and accept future MP_RELEASE_REPORT rows unchanged.
CREATE TABLE fin_import_run_line (
  run_id               UUID        NOT NULL,
  row_number           INTEGER     NOT NULL,
  source_kind          VARCHAR(20) NOT NULL,
  mode                 VARCHAR(10) NOT NULL,
  raw_row              JSONB       NOT NULL,
  outcome              VARCHAR(15) NOT NULL,
  note                 TEXT,
  statement_line_id    BIGINT REFERENCES fin_statement_line(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mp_source_record_id  UUID   REFERENCES mp_source_record(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  statement_position   INTEGER,
  appearance_meta      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  review_code          VARCHAR(40),
  PRIMARY KEY (run_id, row_number),
  CONSTRAINT fk_firl_run FOREIGN KEY (run_id, source_kind, mode)
    REFERENCES fin_import_run(id, source_kind, mode) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_firl_row_number      CHECK (row_number > 0),
  CONSTRAINT chk_firl_position        CHECK (statement_position IS NULL OR statement_position > 0),
  CONSTRAINT chk_firl_outcome         CHECK (outcome IN ('NEW', 'ALREADY_KNOWN', 'IGNORED', 'INVALID', 'CAPTURED')),
  CONSTRAINT chk_firl_one_destination CHECK (num_nonnulls(statement_line_id, mp_source_record_id) <= 1),
  CONSTRAINT chk_firl_bank_dest       CHECK (statement_line_id IS NULL OR source_kind = 'BANK_STATEMENT'),
  CONSTRAINT chk_firl_mp_dest         CHECK (mp_source_record_id IS NULL OR source_kind = 'MP_RELEASE_REPORT'),
  CONSTRAINT chk_firl_normalized_dest CHECK (outcome NOT IN ('NEW', 'ALREADY_KNOWN')
                                             OR num_nonnulls(statement_line_id, mp_source_record_id) = 1),
  CONSTRAINT chk_firl_captured        CHECK (outcome <> 'CAPTURED'
                                             OR (mode = 'VALIDATION' AND num_nonnulls(statement_line_id, mp_source_record_id) = 0)),
  CONSTRAINT chk_firl_review_code     CHECK (review_code IS NULL OR btrim(review_code) <> ''),
  CONSTRAINT chk_firl_meta_object     CHECK (jsonb_typeof(appearance_meta) = 'object')
);
ALTER TABLE fin_import_run_line ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_firl_run_statement_line ON fin_import_run_line(run_id, statement_line_id)
  WHERE statement_line_id IS NOT NULL;
CREATE UNIQUE INDEX uq_firl_run_mp_source ON fin_import_run_line(run_id, mp_source_record_id)
  WHERE mp_source_record_id IS NOT NULL;
CREATE INDEX idx_firl_statement_line ON fin_import_run_line(statement_line_id);
CREATE INDEX idx_firl_mp_source      ON fin_import_run_line(mp_source_record_id);

-- ── immutable evidence guard: runs, lines and appearances (§13) ────────────
CREATE OR REPLACE FUNCTION fin_evidence_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FIN_EVIDENCE_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$;
ALTER FUNCTION fin_evidence_immutable_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_evidence_immutable_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fin_import_run_immutable
  BEFORE UPDATE OR DELETE ON fin_import_run
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_fin_statement_line_immutable
  BEFORE UPDATE OR DELETE ON fin_statement_line
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_fin_import_run_line_immutable
  BEFORE UPDATE OR DELETE ON fin_import_run_line
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();

-- ── fin_statement_match — manual, append-only 1:1 reconciliation (§6.4, §8) ─
CREATE TABLE fin_statement_match (
  id                      BIGSERIAL PRIMARY KEY,
  statement_line_id       BIGINT      NOT NULL REFERENCES fin_statement_line(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id  BIGINT      NOT NULL REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_posting_id    BIGINT      NOT NULL REFERENCES financial_posting(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  matched_by              UUID        NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  matched_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason                  TEXT,
  reversed_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reversed_at             TIMESTAMPTZ,
  reverse_reason          TEXT,
  CONSTRAINT chk_fsm_reversal_set CHECK (
        (reversed_by IS NULL AND reversed_at IS NULL AND reverse_reason IS NULL)
     OR (reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reverse_reason IS NOT NULL
         AND btrim(reverse_reason) <> ''))
);
ALTER TABLE fin_statement_match ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_fsm_active_line    ON fin_statement_match(statement_line_id)    WHERE reversed_at IS NULL;
CREATE UNIQUE INDEX uq_fsm_active_posting ON fin_statement_match(financial_posting_id) WHERE reversed_at IS NULL;
CREATE INDEX idx_fsm_operation ON fin_statement_match(financial_operation_id);

-- structural integrity on insert: the posting belongs to the operation, to the line's account,
-- and carries exactly the line's signed amount; a match is born active.
-- ADMIN role, cut resolution and POST_CUTOVER are checked by the reconciliation function (later migration).
CREATE OR REPLACE FUNCTION fin_statement_match_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_posting financial_posting;
  v_line    fin_statement_line;
BEGIN
  IF NEW.reversed_by IS NOT NULL OR NEW.reversed_at IS NOT NULL OR NEW.reverse_reason IS NOT NULL THEN
    RAISE EXCEPTION 'FIN_MATCH_BORN_REVERSED: a match is inserted active';
  END IF;
  SELECT * INTO v_posting FROM financial_posting WHERE id = NEW.financial_posting_id;
  SELECT * INTO v_line    FROM fin_statement_line WHERE id = NEW.statement_line_id;
  IF v_posting.id IS NULL OR v_line.id IS NULL THEN
    RETURN NEW;   -- the foreign keys report the missing row
  END IF;
  IF v_posting.financial_operation_id <> NEW.financial_operation_id THEN
    RAISE EXCEPTION 'FIN_MATCH_POSTING_OPERATION_MISMATCH: posting % does not belong to operation %',
      NEW.financial_posting_id, NEW.financial_operation_id;
  END IF;
  IF v_posting.financial_account_id <> v_line.financial_account_id THEN
    RAISE EXCEPTION 'FIN_MATCH_ACCOUNT_MISMATCH: posting % and statement line % belong to different accounts',
      NEW.financial_posting_id, NEW.statement_line_id;
  END IF;
  IF v_posting.signed_amount <> v_line.signed_amount THEN
    RAISE EXCEPTION 'FIN_MATCH_AMOUNT_MISMATCH: posting % (%) and statement line % (%) differ',
      NEW.financial_posting_id, v_posting.signed_amount, NEW.statement_line_id, v_line.signed_amount;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION fin_statement_match_insert_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_match_insert_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fin_statement_match_insert_guard
  BEFORE INSERT ON fin_statement_match
  FOR EACH ROW EXECUTE FUNCTION fin_statement_match_insert_guard();

-- append-only: the only UPDATE is setting the reversal fields once; DELETE is forbidden
CREATE OR REPLACE FUNCTION fin_statement_match_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_MATCH_APPEND_ONLY: DELETE on fin_statement_match is not allowed';
  END IF;
  IF NEW.id                     IS DISTINCT FROM OLD.id
  OR NEW.statement_line_id      IS DISTINCT FROM OLD.statement_line_id
  OR NEW.financial_operation_id IS DISTINCT FROM OLD.financial_operation_id
  OR NEW.financial_posting_id   IS DISTINCT FROM OLD.financial_posting_id
  OR NEW.matched_by             IS DISTINCT FROM OLD.matched_by
  OR NEW.matched_at             IS DISTINCT FROM OLD.matched_at
  OR NEW.reason                 IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'FIN_MATCH_APPEND_ONLY: only the reversal fields may be set';
  END IF;
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIN_MATCH_REVERSAL_ONCE: match % is already reversed', OLD.id;
  END IF;
  IF NEW.reversed_at IS NULL THEN
    RAISE EXCEPTION 'FIN_MATCH_APPEND_ONLY: an UPDATE must set the reversal';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION fin_statement_match_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_match_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fin_statement_match_guard
  BEFORE UPDATE OR DELETE ON fin_statement_match
  FOR EACH ROW EXECUTE FUNCTION fin_statement_match_guard();

-- ── fin_statement_cutover — opening cut per bank account (§6.6) ────────────
-- The anchor belongs to the same account (composite FK). superseded_by is DEFERRABLE so a
-- correction can supersede the active row and insert its successor in one transaction while the
-- one-active-row index is never violated. The K-4 anchor-balance rule and the never-use-cutover_at
-- rule are enforced by the cut-registration function (later migration).
CREATE TABLE fin_statement_cutover (
  id                        BIGSERIAL PRIMARY KEY,
  financial_account_id      UUID          NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  opening_balance           NUMERIC(15,2) NOT NULL,
  cutoff_statement_line_id  BIGINT        NOT NULL,
  resolved_by               UUID          NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  resolved_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  evidence_note             TEXT          NOT NULL,
  superseded_by             BIGINT,
  superseded_at             TIMESTAMPTZ,
  supersede_reason          TEXT,
  CONSTRAINT fk_fsc_anchor_same_account FOREIGN KEY (cutoff_statement_line_id, financial_account_id)
    REFERENCES fin_statement_line(id, financial_account_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_fsc_superseded_by FOREIGN KEY (superseded_by)
    REFERENCES fin_statement_cutover(id) ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT chk_fsc_evidence_note CHECK (btrim(evidence_note) <> ''),
  CONSTRAINT chk_fsc_supersession_set CHECK (
        (superseded_by IS NULL AND superseded_at IS NULL AND supersede_reason IS NULL)
     OR (superseded_by IS NOT NULL AND superseded_at IS NOT NULL AND supersede_reason IS NOT NULL
         AND btrim(supersede_reason) <> '')),
  CONSTRAINT chk_fsc_not_self_superseded CHECK (superseded_by IS DISTINCT FROM id)
);
ALTER TABLE fin_statement_cutover ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_fsc_active_account ON fin_statement_cutover(financial_account_id) WHERE superseded_at IS NULL;
CREATE INDEX idx_fsc_anchor ON fin_statement_cutover(cutoff_statement_line_id);

-- a cut is born active; the only UPDATE sets the supersession fields once; DELETE is forbidden
CREATE OR REPLACE FUNCTION fin_statement_cutover_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.superseded_by IS NOT NULL OR NEW.superseded_at IS NOT NULL OR NEW.supersede_reason IS NOT NULL THEN
      RAISE EXCEPTION 'FIN_CUTOVER_BORN_SUPERSEDED: a cut is inserted active';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'FIN_CUTOVER_APPEND_ONLY: DELETE on fin_statement_cutover is not allowed';
  END IF;
  IF NEW.id                       IS DISTINCT FROM OLD.id
  OR NEW.financial_account_id     IS DISTINCT FROM OLD.financial_account_id
  OR NEW.opening_balance          IS DISTINCT FROM OLD.opening_balance
  OR NEW.cutoff_statement_line_id IS DISTINCT FROM OLD.cutoff_statement_line_id
  OR NEW.resolved_by              IS DISTINCT FROM OLD.resolved_by
  OR NEW.resolved_at              IS DISTINCT FROM OLD.resolved_at
  OR NEW.evidence_note            IS DISTINCT FROM OLD.evidence_note THEN
    RAISE EXCEPTION 'FIN_CUTOVER_APPEND_ONLY: only the supersession fields may be set';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'FIN_CUTOVER_SUPERSEDE_ONCE: cut % is already superseded', OLD.id;
  END IF;
  IF NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'FIN_CUTOVER_APPEND_ONLY: an UPDATE must set the supersession';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION fin_statement_cutover_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_cutover_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_fin_statement_cutover_guard
  BEFORE INSERT OR UPDATE OR DELETE ON fin_statement_cutover
  FOR EACH ROW EXECUTE FUNCTION fin_statement_cutover_guard();

-- ── fail-closed privileges until the privileges migration ──────────────────
REVOKE ALL ON fin_statement_account_config, fin_import_run, fin_statement_line, fin_import_run_line,
              fin_statement_match, fin_statement_cutover
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE fin_statement_line_id_seq, fin_statement_match_id_seq, fin_statement_cutover_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
