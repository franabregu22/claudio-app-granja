-- ============================================================================
-- TARGET V1 — 0074 FINANCIAL STATEMENT PRIVILEGES, STORAGE AND CONFIG SEED (ADR-018, bank branch, step 2)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md §7.4 (K-1 identifiers), §11 (security and
--            permissions), §13 (evidence retention); tables from 0073 (commit 06e691d).
--
-- Tables: the 0041 / 0054 pattern — REVOKE ALL from PUBLIC, anon, authenticated, service_role, then narrow
-- SELECT grants; RLS enabled; SELECT policies only. No INSERT / UPDATE / DELETE grant for any application
-- role on any ADR-018 table: every write is a SECURITY DEFINER function (later migration).
--   all six tables:                         authenticated SELECT (ADMIN policy; OPERATOR sees no row)
--   fin_statement_account_config:           + service_role SELECT (the import Edge Function reads the
--                                             expected identifiers of the selected account before parsing)
--   fin_import_run:                         + service_role SELECT (the import Edge Function reads a run's
--                                             account, hash and storage path to reprocess it)
--   fin_statement_line, fin_import_run_line,
--   fin_statement_match, fin_statement_cutover: service_role none (written and read by definer functions)
-- Sequences: no application-role privilege (the definer functions own the writes).
--
-- Storage: PRIVATE bucket `financial-statements` (10 MB, application/pdf). One storage.objects policy:
-- ADMIN SELECT (enables signed URLs). No INSERT / UPDATE / DELETE policy for authenticated: only
-- service_role (BYPASSRLS) writes, and the normal flow never deletes an original. `purchase-attachments`
-- and every other bucket are untouched.
--
-- Seed: the two owner-approved rows of fin_statement_account_config (K-1), resolved by name and
-- account_type; fails if either account is missing or ambiguous. financial_account is not modified.
-- No function, view or SECURITY DEFINER inventory change.
-- ============================================================================

-- ── 1. tables: reset, then narrow ──────────────────────────────────────────
REVOKE ALL ON TABLE fin_statement_account_config, fin_import_run, fin_statement_line, fin_import_run_line,
                    fin_statement_match, fin_statement_cutover
  FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE fin_statement_account_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_import_run               ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_statement_line           ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_import_run_line          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_statement_match          ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_statement_cutover        ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE fin_statement_account_config, fin_import_run TO authenticated, service_role;
GRANT SELECT ON TABLE fin_statement_line, fin_import_run_line, fin_statement_match, fin_statement_cutover TO authenticated;

CREATE POLICY fin_config_admin_select ON fin_statement_account_config
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY fin_config_service_select ON fin_statement_account_config
  FOR SELECT USING (auth.role() = 'service_role');
CREATE POLICY fin_run_admin_select ON fin_import_run
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY fin_run_service_select ON fin_import_run
  FOR SELECT USING (auth.role() = 'service_role');
CREATE POLICY fin_line_admin_select ON fin_statement_line
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY fin_run_line_admin_select ON fin_import_run_line
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY fin_match_admin_select ON fin_statement_match
  FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY fin_cutover_admin_select ON fin_statement_cutover
  FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── 2. sequences: no application-role privilege ────────────────────────────
REVOKE ALL ON SEQUENCE fin_statement_line_id_seq, fin_statement_match_id_seq, fin_statement_cutover_id_seq
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. seed: owner-approved expected identifiers (K-1) ─────────────────────
DO $$
DECLARE
  v_bna INTEGER;
  v_pat INTEGER;
BEGIN
  SELECT count(*) INTO v_bna FROM financial_account WHERE nombre = 'BNA'       AND account_type = 'BANK_ACCOUNT';
  SELECT count(*) INTO v_pat FROM financial_account WHERE nombre = 'Patagonia' AND account_type = 'BANK_ACCOUNT';
  IF v_bna <> 1 THEN
    RAISE EXCEPTION 'FIN_CONFIG_SEED: expected exactly one BANK_ACCOUNT named BNA, found %', v_bna;
  END IF;
  IF v_pat <> 1 THEN
    RAISE EXCEPTION 'FIN_CONFIG_SEED: expected exactly one BANK_ACCOUNT named Patagonia, found %', v_pat;
  END IF;
END;
$$;

INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu, expected_extra)
SELECT id, 'BNA_MONTHLY_PDF_V1', '5460109893', '0110546920054601098937', '{}'::jsonb
  FROM financial_account WHERE nombre = 'BNA' AND account_type = 'BANK_ACCOUNT';

INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu, expected_extra)
SELECT id, 'PATAGONIA_STATEMENT_PDF_V1', '299038195', '0340299500299038195002', '{"subcta": "0", "suc": "299"}'::jsonb
  FROM financial_account WHERE nombre = 'Patagonia' AND account_type = 'BANK_ACCOUNT';

-- ── 4. storage: private bucket for original statements ─────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('financial-statements', 'financial-statements', false, 10485760, ARRAY['application/pdf']);

CREATE POLICY financial_statements_admin_select ON storage.objects
  FOR SELECT TO authenticated
  USING (CASE WHEN bucket_id = 'financial-statements' THEN public.current_app_role() = 'ADMIN' ELSE false END);
