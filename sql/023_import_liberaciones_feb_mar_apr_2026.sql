-- ============================================================================
-- FASE 2 IMPORT: LIBERACIONES FEB-MAR-APR 2026 (Payouts + Payments only)
-- File: 023_import_liberaciones_feb_mar_apr_2026.sql
-- Status: READ + WRITE (INSERT only, no DELETE/UPDATE)
-- Purpose: Add Liberaciones-specific payouts to complete monthly ledger
-- Architecture: Same RPC + pipeline as July/August implementation
-- ============================================================================

BEGIN;

-- ============================================================================
-- IMPORT FEBRUARY 2026 LIBERACIONES
-- ============================================================================

-- Source: LIBERACIONES_FEB_2026_IMPORT.csv (475 rows, filtered to definitive only)
-- Expected: 21 new payouts + 454 shared payments (reutilize existing)
-- Current ledger: 5,934,805.68
-- Expected after: 1,475,153.73

-- Call existing import_financial_pipeline RPC for February batch
-- (This RPC already handles: deduplication, shared FM reuse, new payout FM creation, ledger impact)

SELECT import_financial_pipeline(
  p_account_id := 1054315166,
  p_source_type := 'liberaciones',
  p_period_start := '2026-02-01'::DATE,
  p_period_end := '2026-02-28'::DATE,
  p_csv_path := 'scripts/import_prep_feb_jun_2026/LIBERACIONES_FEB_2026_IMPORT.csv'
);

-- ============================================================================
-- IMPORT MARCH 2026 LIBERACIONES
-- ============================================================================

-- Source: LIBERACIONES_MAR_2026_IMPORT.csv (692 rows, filtered to definitive only)
-- Expected: 45 new payouts + 647 shared payments (reutilize existing)
-- Current ledger: 10,073,544.80
-- Expected after: 1,902,908.89

SELECT import_financial_pipeline(
  p_account_id := 1054315166,
  p_source_type := 'liberaciones',
  p_period_start := '2026-03-01'::DATE,
  p_period_end := '2026-03-31'::DATE,
  p_csv_path := 'scripts/import_prep_feb_jun_2026/LIBERACIONES_MAR_2026_IMPORT.csv'
);

-- ============================================================================
-- IMPORT APRIL 2026 LIBERACIONES
-- ============================================================================

-- Source: LIBERACIONES_APR_2026_IMPORT.csv (476 rows, filtered to definitive only)
-- Expected: 36 new payouts + 440 shared payments (reutilize existing)
-- Current ledger: 7,673,095.83
-- Expected after: -914,712.70

SELECT import_financial_pipeline(
  p_account_id := 1054315166,
  p_source_type := 'liberaciones',
  p_period_start := '2026-04-01'::DATE,
  p_period_end := '2026-04-30'::DATE,
  p_csv_path := 'scripts/import_prep_feb_jun_2026/LIBERACIONES_APR_2026_IMPORT.csv'
);

COMMIT;

-- ============================================================================
-- POST-IMPORT VALIDATION
-- ============================================================================

-- Verify February import
SELECT
  'FEB 2026 POST-IMPORT' as validation,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-29'::date) as total_fm,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-29'::date AND movement_class = 'payment_out') as payout_fm_new,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-29'::date) as final_ledger_net,
  1475153.73::NUMERIC(15,2) as expected;

-- Verify March import
SELECT
  'MAR 2026 POST-IMPORT' as validation,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as total_fm,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date AND movement_class = 'payment_out') as payout_fm_new,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as final_ledger_net,
  1902908.89::NUMERIC(15,2) as expected;

-- Verify April import
SELECT
  'APR 2026 POST-IMPORT' as validation,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as total_fm,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date AND movement_class = 'payment_out') as payout_fm_new,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as final_ledger_net,
  -914712.70::NUMERIC(15,2) as expected;

-- Check needs_review status
SELECT
  'NEEDS_REVIEW_CHECK' as validation_type,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-04-30'::date AND needs_review = TRUE) as needs_review_count,
  'Should be 0 if no economic mismatches detected' as expected;

-- Status summary for remaining months
SELECT
  'STATUS_SUMMARY' as check_type,
  'FEB 2026' as month,
  'IMPORTED' as status
UNION ALL
SELECT 'STATUS_SUMMARY', 'MAR 2026', 'IMPORTED'
UNION ALL
SELECT 'STATUS_SUMMARY', 'APR 2026', 'IMPORTED'
UNION ALL
SELECT 'STATUS_SUMMARY', 'MAY 2026', 'HOLD (1 unknown balance row + needs review)'
UNION ALL
SELECT 'STATUS_SUMMARY', 'JUN 2026', 'HOLD (2 economic mismatches + 2 lib-only payments)'
UNION ALL
SELECT 'STATUS_SUMMARY', 'JAN 2026', 'NEEDS_EXTERNAL_REPORT';
