-- ============================================================================
-- VERIFY PRE-CHECK VALUES: Confirm DB state before import
-- File: 024_verify_precheck_values.sql
-- Status: READ-ONLY
-- ============================================================================

SELECT
  'FEB 2026' as month,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date) as fm_count,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date) as ledger_count,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date) as ledger_net,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date AND needs_review = TRUE) as needs_review_count,
  (SELECT COUNT(*) FROM mp_source_record WHERE source_type = 'liberaciones' AND DATE(observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date) as liberaciones_existing

UNION ALL

SELECT
  'MAR 2026' as month,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as fm_count,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as ledger_count,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as ledger_net,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date AND needs_review = TRUE) as needs_review_count,
  (SELECT COUNT(*) FROM mp_source_record WHERE source_type = 'liberaciones' AND DATE(observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as liberaciones_existing

UNION ALL

SELECT
  'APR 2026' as month,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as fm_count,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as ledger_count,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as ledger_net,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date AND needs_review = TRUE) as needs_review_count,
  (SELECT COUNT(*) FROM mp_source_record WHERE source_type = 'liberaciones' AND DATE(observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as liberaciones_existing

UNION ALL

SELECT
  'TOTAL needs_review (all acct 1054315166)' as month,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND needs_review = TRUE) as fm_count,
  NULL::INTEGER as ledger_count,
  NULL::NUMERIC as ledger_net,
  NULL::INTEGER as needs_review_count,
  NULL::INTEGER as liberaciones_existing

ORDER BY month;
