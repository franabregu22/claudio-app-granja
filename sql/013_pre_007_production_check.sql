-- FASE A: PRE-EXECUTION CHECK FOR 007_reconciliation_tables.sql
-- File: 013_pre_007_production_check.sql
-- Status: READ-ONLY (no modifications)
-- Purpose: Verify schema state before executing 007 migration
-- Output: Single result set with complete pre-check

WITH timezone_check AS (
  SELECT
    'TIMEZONE' as check_type,
    'America/Argentina/Buenos_Aires' as check_item,
    CASE WHEN NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires' IS NOT NULL THEN 'PASS' ELSE 'FAIL' END as status,
    CAST(NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires' as TEXT) as value
),

table_exists_check AS (
  SELECT 'TABLE_EXISTS' as check_type, 'account_balance' as check_item,
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='account_balance') THEN 'PASS' ELSE 'FAIL' END as status,
    'required' as value
  UNION ALL
  SELECT 'TABLE_EXISTS', 'ledger_entry',
    CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='ledger_entry') THEN 'PASS' ELSE 'FAIL' END,
    'required'
),

columns_account_balance AS (
  SELECT 'COLUMN_EXISTS' as check_type, 'account_balance.' || column_name as check_item,
    CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END as status,
    data_type as value
  FROM information_schema.columns
  WHERE table_name='account_balance'
    AND column_name IN ('account_id', 'opening_balance', 'opening_balance_date', 'balance_date')
  GROUP BY table_name, column_name, data_type
  UNION ALL
  SELECT 'COLUMN_MISSING', 'account_balance.account_id', 'FAIL', 'not_found'
  WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='account_balance' AND column_name='account_id')
  UNION ALL
  SELECT 'COLUMN_MISSING', 'account_balance.opening_balance', 'FAIL', 'not_found'
  WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='account_balance' AND column_name='opening_balance')
  UNION ALL
  SELECT 'COLUMN_MISSING', 'account_balance.opening_balance_date', 'FAIL', 'not_found'
  WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='account_balance' AND column_name='opening_balance_date')
  UNION ALL
  SELECT 'COLUMN_MISSING', 'account_balance.balance_date', 'FAIL', 'not_found'
  WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='account_balance' AND column_name='balance_date')
),

columns_ledger_entry AS (
  SELECT 'COLUMN_EXISTS' as check_type, 'ledger_entry.' || column_name as check_item,
    CASE WHEN COUNT(*) > 0 THEN 'PASS' ELSE 'FAIL' END as status,
    data_type as value
  FROM information_schema.columns
  WHERE table_name='ledger_entry'
    AND column_name IN ('account_id', 'balance_impact', 'occurred_at')
  GROUP BY table_name, column_name, data_type
),

new_tables_check AS (
  SELECT 'TABLE_SHOULD_NOT_EXIST' as check_type, 'import_period_coverage' as check_item,
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='import_period_coverage') THEN 'PASS' ELSE 'FAIL' END as status,
    'not_yet_created' as value
  UNION ALL
  SELECT 'TABLE_SHOULD_NOT_EXIST', 'reconciliation_snapshot',
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='reconciliation_snapshot') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
  UNION ALL
  SELECT 'TABLE_SHOULD_NOT_EXIST', 'period_flow_observation',
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='period_flow_observation') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
  UNION ALL
  SELECT 'TABLE_SHOULD_NOT_EXIST', 'monthly_reconciliation',
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='monthly_reconciliation') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
),

new_views_check AS (
  SELECT 'VIEW_SHOULD_NOT_EXIST' as check_type, 'v_latest_coverage_evidence' as check_item,
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_latest_coverage_evidence') THEN 'PASS' ELSE 'FAIL' END as status,
    'not_yet_created' as value
  UNION ALL
  SELECT 'VIEW_SHOULD_NOT_EXIST', 'v_period_coverage_status',
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_period_coverage_status') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
  UNION ALL
  SELECT 'VIEW_SHOULD_NOT_EXIST', 'v_balance_chain_coverage',
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_balance_chain_coverage') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
  UNION ALL
  SELECT 'VIEW_SHOULD_NOT_EXIST', 'v_monthly_reconciliation_summary',
    CASE WHEN NOT EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_monthly_reconciliation_summary') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
),

new_functions_check AS (
  SELECT 'FUNCTION_SHOULD_NOT_EXIST' as check_type, 'calculate_account_balance_as_of(bigint,date)' as check_item,
    CASE WHEN NOT EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_account_balance_as_of') THEN 'PASS' ELSE 'FAIL' END as status,
    'not_yet_created' as value
  UNION ALL
  SELECT 'FUNCTION_SHOULD_NOT_EXIST', 'calculate_balance_chain_coverage(bigint,date,date)',
    CASE WHEN NOT EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_balance_chain_coverage') THEN 'PASS' ELSE 'FAIL' END,
    'not_yet_created'
),

row_counts AS (
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
  UNION ALL
  SELECT 'ROW_COUNT', 'mp_financial_movement.needs_review=true', 'INFO', CAST(COUNT(*) AS TEXT)
  FROM mp_financial_movement
  WHERE needs_review = true
),

ledger_sums AS (
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
)

-- FINAL UNIFIED RESULT SET
SELECT * FROM timezone_check
UNION ALL
SELECT * FROM table_exists_check
UNION ALL
SELECT * FROM columns_account_balance
UNION ALL
SELECT * FROM columns_ledger_entry
UNION ALL
SELECT * FROM new_tables_check
UNION ALL
SELECT * FROM new_views_check
UNION ALL
SELECT * FROM new_functions_check
UNION ALL
SELECT * FROM row_counts
UNION ALL
SELECT * FROM ledger_sums
ORDER BY check_type, check_item;
