-- ============================================================================
-- VERIFICATION QUERY - Run this AFTER deploying DEPLOY_TO_SUPABASE_STUDIO.sql
-- This is READ-ONLY and confirms the new version is deployed
-- ============================================================================

-- Test 1: Verify is_raw_only() works correctly
SELECT
  is_raw_only('liberaciones', 'reserve_for_payment') AS should_be_true_1,
  is_raw_only('liberaciones', 'reserve_for_payout') AS should_be_true_2,
  is_raw_only('liberaciones', 'payment') AS should_be_false_1,
  is_raw_only('report', 'reserve_for_payment') AS should_be_false_2;

-- Test 2: Single Liberaciones reserve - should show raw_only_rows = 1
SELECT (
  preview_financial_movements_reconciliation_v2(
    1054315166,
    ARRAY[jsonb_build_object(
      'DATE', '2026-06-09T09:53:16.000-03:00',
      'SOURCE_ID', '162458726007',
      'DESCRIPTION', 'reserve_for_payment',
      'NET_CREDIT_AMOUNT', '0.00',
      'NET_DEBIT_AMOUNT', '1000000.00'
    )],
    'liberaciones',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  )->'summary'->>'raw_only_rows'
) AS raw_only_rows_in_result;

-- Test 3: Verify raw_only_rows is included in JSON
SELECT
  CASE WHEN preview_financial_movements_reconciliation_v2(
    1054315166,
    ARRAY[jsonb_build_object('DATE', '2026-06-09', 'DESCRIPTION', 'payment')],
    'liberaciones',
    '2026-06-01'::DATE,
    '2026-06-30'::DATE
  )->'summary' ? 'raw_only_rows' THEN 'YES - field exists' ELSE 'NO - field missing' END AS json_has_raw_only_rows;
