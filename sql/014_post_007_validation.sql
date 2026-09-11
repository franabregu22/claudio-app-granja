-- FASE 1: POST-007 VALIDATION SCRIPT
-- File: 014_post_007_validation.sql
-- Status: READ-ONLY (no modifications)
-- Purpose: Validate 007 migration success and FASE 0 data preservation
-- Output: Single result set with complete validation

-- ============================================================
-- VALIDATION: EXISTENCIA DE OBJETOS 007
-- ============================================================

WITH table_checks AS (
  SELECT 'TABLE_EXISTS' as check_type, 'import_period_coverage' as check_item,
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='import_period_coverage') THEN 'PASS' ELSE 'FAIL' END as status,
    'REQUIRED' as value
  UNION ALL
  SELECT 'TABLE_EXISTS', 'reconciliation_snapshot',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='reconciliation_snapshot') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
  UNION ALL
  SELECT 'TABLE_EXISTS', 'period_flow_observation',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='period_flow_observation') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
  UNION ALL
  SELECT 'TABLE_EXISTS', 'monthly_reconciliation',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='monthly_reconciliation') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
),

view_checks AS (
  SELECT 'VIEW_EXISTS' as check_type, 'v_latest_coverage_evidence' as check_item,
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_latest_coverage_evidence') THEN 'PASS' ELSE 'FAIL' END as status,
    'REQUIRED' as value
  UNION ALL
  SELECT 'VIEW_EXISTS', 'v_period_coverage_status',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_period_coverage_status') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
  UNION ALL
  SELECT 'VIEW_EXISTS', 'v_balance_chain_coverage',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_balance_chain_coverage') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
  UNION ALL
  SELECT 'VIEW_EXISTS', 'v_monthly_reconciliation_summary',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_monthly_reconciliation_summary') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
),

function_checks AS (
  SELECT 'FUNCTION_EXISTS' as check_type, 'calculate_account_balance_as_of(bigint,date)' as check_item,
    CASE WHEN EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_account_balance_as_of') THEN 'PASS' ELSE 'FAIL' END as status,
    'REQUIRED' as value
  UNION ALL
  SELECT 'FUNCTION_EXISTS', 'calculate_balance_chain_coverage(bigint,date,date)',
    CASE WHEN EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_balance_chain_coverage') THEN 'PASS' ELSE 'FAIL' END,
    'REQUIRED'
),

-- ============================================================
-- VALIDATION: FASE 0 DATA PRESERVATION
-- ============================================================

fase0_counts AS (
  SELECT 'ROW_COUNT' as check_type, 'mp_financial_movement' as check_item,
    'INFO' as status,
    CAST(COUNT(*) AS TEXT) as value
  FROM mp_financial_movement
  UNION ALL
  SELECT 'ROW_COUNT', 'ledger_entry', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM ledger_entry
  UNION ALL
  SELECT 'ROW_COUNT', 'mp_source_record', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM mp_source_record
  UNION ALL
  SELECT 'ROW_COUNT', 'mp_movement_source_link', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM mp_movement_source_link
  UNION ALL
  SELECT 'ROW_COUNT', 'account_balance', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM account_balance
),

needs_review_count AS (
  SELECT 'ROW_COUNT' as check_type, 'mp_financial_movement.needs_review=true' as check_item,
    'INFO' as status,
    CAST(COUNT(*) AS TEXT) as value
  FROM mp_financial_movement
  WHERE needs_review = true
),

fase0_sums AS (
  SELECT 'LEDGER_SUM' as check_type, 'total_all_accounts' as check_item,
    'INFO' as status,
    CAST(COALESCE(SUM(balance_impact), 0) AS TEXT) as value
  FROM ledger_entry
  UNION ALL
  SELECT 'LEDGER_SUM', 'account_1054315166', 'INFO', CAST(COALESCE(SUM(balance_impact), 0) AS TEXT)
  FROM ledger_entry
  WHERE account_id = 1054315166
  UNION ALL
  SELECT 'LEDGER_SUM', 'julio_2026', 'INFO', CAST(COALESCE(SUM(balance_impact), 0) AS TEXT)
  FROM ledger_entry
  WHERE DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01'::DATE AND '2026-07-31'::DATE
  UNION ALL
  SELECT 'LEDGER_SUM', 'agosto_2026', 'INFO', CAST(COALESCE(SUM(balance_impact), 0) AS TEXT)
  FROM ledger_entry
  WHERE DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01'::DATE AND '2026-08-31'::DATE
),

-- ============================================================
-- VALIDATION: HELPER ACCOUNT BALANCE (signature exists)
-- ============================================================

helper_test AS (
  SELECT 'HELPER_EXISTS' as check_type, 'calculate_account_balance_as_of(bigint,date)' as check_item,
    CASE WHEN EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_account_balance_as_of' AND pronargs=2) THEN 'PASS' ELSE 'FAIL' END as status,
    'Helper function signature verified' as value
),

-- ============================================================
-- VALIDATION: COVERAGE TABLES EMPTY (PHASE 1 NOT YET LOADED)
-- ============================================================

coverage_counts AS (
  SELECT 'COVERAGE_COUNT' as check_type, 'import_period_coverage' as check_item,
    'INFO' as status,
    CAST(COUNT(*) AS TEXT) as value
  FROM import_period_coverage
  UNION ALL
  SELECT 'COVERAGE_COUNT', 'reconciliation_snapshot', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM reconciliation_snapshot
  UNION ALL
  SELECT 'COVERAGE_COUNT', 'period_flow_observation', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM period_flow_observation
  UNION ALL
  SELECT 'COVERAGE_COUNT', 'monthly_reconciliation', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM monthly_reconciliation
)

-- ============================================================
-- FINAL UNIFIED RESULT SET
-- ============================================================

SELECT * FROM table_checks
UNION ALL
SELECT * FROM view_checks
UNION ALL
SELECT * FROM function_checks
UNION ALL
SELECT * FROM fase0_counts
UNION ALL
SELECT * FROM needs_review_count
UNION ALL
SELECT * FROM fase0_sums
UNION ALL
SELECT * FROM helper_test
UNION ALL
SELECT * FROM coverage_counts
ORDER BY check_type, check_item;
