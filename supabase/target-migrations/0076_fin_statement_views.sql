-- ============================================================================
-- TARGET V1 — 0076 FINANCIAL STATEMENT STATUS VIEW (ADR-018, bank branch, step 4)
-- Authority: .planning/adr/ADR-018_FINANCIAL_STATEMENT_IMPORT.md §6.6 (derived cutover classification,
--            "view/query; never mutates fin_statement_line"), §8 (reconciliation), §15 (observability: bank
--            lines by account and derived classification, pending = POST_CUTOVER and unmatched).
--            Write model: 0075 (2531f96) fin_match_statement_line — the classification below is the same rule,
--            transcribed structurally; 0075 is not modified and stays the only authority for writes.
--
-- Read model only. One view, no table, no function, no stored value; the SECURITY DEFINER set stays 73.
-- Pattern of 0046 / 0055: security_invoker = true (the caller's base-table RLS applies), an explicit ADMIN
-- filter, OWNER postgres, SELECT for authenticated only. anon and service_role: no access. OPERATOR: 0 rows.
--
-- cutover_classification (per line, against the account's active cut; never the global cutover instant
-- and never the Mercado Pago cutover boundary):
--   CUTOVER_UNRESOLVED     no active cut for the account                     (0075: CUTOVER_UNRESOLVED)
--   PRE_CUTOVER            the anchor itself, or ordered at / before it       (0075: PRE_CUTOVER_LINE)
--   POST_CUTOVER           ordered after the anchor; the only reconcilable class
--   CUTOVER_AMBIGUOUS_DAY  Patagonia: same value_date as the anchor          (0075: CUTOVER_AMBIGUOUS_DAY)
--   NULL                   structurally unreachable states that 0075 also refuses (BNA order data missing,
--                          account without configuration); never reported as reconcilable
-- Order rules (frozen adapters, identical to 0075):
--   BNA_MONTHLY_PDF_V1          (coverage_to, statement_position) of the appearance in the run that created
--                               the line; PRE iff (line) <= (anchor)
--   PATAGONIA_STATEMENT_PDF_V1  value_date; PRE iff earlier, AMBIGUOUS iff the same date, else POST
-- reconciliation_status: MATCHED iff the line has the (single) active, non-reversed match; else UNMATCHED.
-- Match history stays in fin_statement_match.
-- ============================================================================

CREATE VIEW fin_statement_line_status
WITH (security_invoker = true)
AS
SELECT
  l.id                       AS statement_line_id,
  l.financial_account_id,
  l.value_date,
  l.description_raw,
  l.description_norm,
  l.bank_reference,
  l.fecha_valor,
  l.signed_amount,
  l.running_balance,
  l.fingerprint,
  l.first_run_id,
  l.created_at,
  c.id                       AS active_cutover_id,
  c.cutoff_statement_line_id,
  c.opening_balance,
  CASE
    WHEN c.id IS NULL THEN 'CUTOVER_UNRESOLVED'
    WHEN l.id = c.cutoff_statement_line_id THEN 'PRE_CUTOVER'
    WHEN cfg.format_code = 'BNA_MONTHLY_PDF_V1' THEN
      CASE
        WHEN lp.coverage_to IS NULL OR lp.statement_position IS NULL
          OR ap.coverage_to IS NULL OR ap.statement_position IS NULL THEN NULL
        WHEN (lp.coverage_to, lp.statement_position) <= (ap.coverage_to, ap.statement_position) THEN 'PRE_CUTOVER'
        ELSE 'POST_CUTOVER'
      END
    WHEN cfg.format_code = 'PATAGONIA_STATEMENT_PDF_V1' THEN
      CASE
        WHEN l.value_date < a.value_date THEN 'PRE_CUTOVER'
        WHEN l.value_date = a.value_date THEN 'CUTOVER_AMBIGUOUS_DAY'
        ELSE 'POST_CUTOVER'
      END
    ELSE NULL
  END                        AS cutover_classification,
  m.id                       AS active_match_id,
  m.financial_operation_id,
  m.financial_posting_id,
  m.matched_by,
  m.matched_at,
  m.reason                   AS match_reason,
  CASE WHEN m.id IS NULL THEN 'UNMATCHED' ELSE 'MATCHED' END AS reconciliation_status
FROM fin_statement_line l
LEFT JOIN fin_statement_cutover c
  ON c.financial_account_id = l.financial_account_id AND c.superseded_at IS NULL
LEFT JOIN fin_statement_account_config cfg
  ON cfg.financial_account_id = l.financial_account_id
LEFT JOIN fin_statement_line a
  ON a.id = c.cutoff_statement_line_id
LEFT JOIN LATERAL (
  SELECT r.coverage_to, x.statement_position
    FROM fin_import_run r
    JOIN fin_import_run_line x ON x.run_id = r.id AND x.statement_line_id = l.id
   WHERE r.id = l.first_run_id
) lp ON true
LEFT JOIN LATERAL (
  SELECT r.coverage_to, x.statement_position
    FROM fin_import_run r
    JOIN fin_import_run_line x ON x.run_id = r.id AND x.statement_line_id = a.id
   WHERE r.id = a.first_run_id
) ap ON true
LEFT JOIN fin_statement_match m
  ON m.statement_line_id = l.id AND m.reversed_at IS NULL
WHERE (SELECT current_app_role()) = 'ADMIN';

ALTER VIEW fin_statement_line_status OWNER TO postgres;
REVOKE ALL    ON fin_statement_line_status FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_statement_line_status TO authenticated;
