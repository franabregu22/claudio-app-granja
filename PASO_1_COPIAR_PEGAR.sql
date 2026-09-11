-- PASO 1: TEST TRANSACCIONAL - COPIAR TODO Y PEGAR EN SUPABASE SQL EDITOR
-- ============================================================================

BEGIN;

-- Capture baseline counts dynamically
CREATE TEMPORARY TABLE baseline AS
SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_baseline,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_baseline,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_baseline,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_baseline;

-- FIRST EXECUTION: 4 test rows
SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object('DATE', '2026-09-11T10:00:00.000-03:00', 'SOURCE_ID', 'test_payment_plus_001', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '100.00', 'NET_DEBIT_AMOUNT', '0.00', 'GROSS_AMOUNT', '100.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money'),
    jsonb_build_object('DATE', '2026-09-11T11:00:00.000-03:00', 'SOURCE_ID', 'test_payment_minus_001', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '40.00', 'GROSS_AMOUNT', '40.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money'),
    jsonb_build_object('DATE', '2026-09-11T12:00:00.000-03:00', 'SOURCE_ID', 'test_asset_mgmt_001', 'DESCRIPTION', 'asset_management', 'NET_CREDIT_AMOUNT', '5.00', 'NET_DEBIT_AMOUNT', '0.00', 'GROSS_AMOUNT', '5.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money'),
    jsonb_build_object('DATE', '2026-09-11T13:00:00.000-03:00', 'SOURCE_ID', 'test_payout_001', 'DESCRIPTION', 'payout', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '20.00', 'GROSS_AMOUNT', '20.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money')
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'test-batch-001'
) as result_first;

-- Capture state after first execution
CREATE TEMPORARY TABLE after_first AS
SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_cnt,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_cnt,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_cnt,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_cnt,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'payment_in') as fm_payment_in,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'payment_out') as fm_payment_out,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'yield') as fm_yield,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND movement_class = 'transfer_out') as fm_transfer_out;

-- Validate classifications
SELECT
  mfm.id,
  mfm.movement_class,
  msr.source_external_id,
  le.category,
  le.balance_impact
FROM mp_financial_movement mfm
LEFT JOIN mp_movement_source_link msl ON mfm.id = msl.financial_movement_id
LEFT JOIN mp_source_record msr ON msl.source_record_id = msr.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE mfm.account_id = 1054315166 AND msr.source_external_id LIKE 'test_%'
ORDER BY mfm.id;

-- SECOND EXECUTION: Identical 4 rows (idempotence test)
SELECT import_financial_movements_reconciliation_v2(
  1054315166,
  ARRAY[
    jsonb_build_object('DATE', '2026-09-11T10:00:00.000-03:00', 'SOURCE_ID', 'test_payment_plus_001', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '100.00', 'NET_DEBIT_AMOUNT', '0.00', 'GROSS_AMOUNT', '100.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money'),
    jsonb_build_object('DATE', '2026-09-11T11:00:00.000-03:00', 'SOURCE_ID', 'test_payment_minus_001', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '40.00', 'GROSS_AMOUNT', '40.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money'),
    jsonb_build_object('DATE', '2026-09-11T12:00:00.000-03:00', 'SOURCE_ID', 'test_asset_mgmt_001', 'DESCRIPTION', 'asset_management', 'NET_CREDIT_AMOUNT', '5.00', 'NET_DEBIT_AMOUNT', '0.00', 'GROSS_AMOUNT', '5.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money'),
    jsonb_build_object('DATE', '2026-09-11T13:00:00.000-03:00', 'SOURCE_ID', 'test_payout_001', 'DESCRIPTION', 'payout', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '20.00', 'GROSS_AMOUNT', '20.00', 'MP_FEE_AMOUNT', '0.00', 'TAXES_AMOUNT', '0.00', 'PAYMENT_METHOD', 'available_money')
  ],
  'report',
  '2026-09-01'::DATE,
  '2026-09-30'::DATE,
  'test-batch-002'
) as result_second;

-- Capture state after second execution
CREATE TEMPORARY TABLE after_second AS
SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_cnt,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_cnt,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_cnt,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_cnt;

-- VALIDATION
SELECT
  b.sr_baseline,
  a1.sr_cnt as sr_after_first,
  a2.sr_cnt as sr_after_second,
  (a1.sr_cnt - b.sr_baseline) as sr_added_first,
  (a2.sr_cnt - a1.sr_cnt) as sr_added_second,
  CASE WHEN (a2.sr_cnt - a1.sr_cnt) = 0 THEN '✓ IDEMPOTENT' ELSE '✗ DUPLICATED' END as idempotence_check,
  b.fm_baseline,
  a1.fm_cnt as fm_after_first,
  a2.fm_cnt as fm_after_second,
  a1.fm_payment_in as expected_payment_in,
  a1.fm_payment_out as expected_payment_out,
  a1.fm_yield as expected_yield,
  a1.fm_transfer_out as expected_transfer_out
FROM baseline b, after_first a1, after_second a2;

-- Verify totals
SELECT
  'Expected totals' as check_type,
  4 as expected_sr,
  4 as expected_fm,
  4 as expected_le,
  4 as expected_links,
  45.00 as expected_delta
UNION ALL
SELECT
  'Actual after first',
  a1.sr_cnt,
  a1.fm_cnt,
  a1.le_cnt,
  a1.link_cnt,
  COALESCE((SELECT SUM(le.balance_impact) FROM ledger_entry le
    INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
    INNER JOIN mp_movement_source_link msl ON mfm.id = msl.financial_movement_id
    INNER JOIN mp_source_record msr ON msl.source_record_id = msr.id
    WHERE mfm.account_id = 1054315166 AND msr.source_external_id LIKE 'test_%'), 0)
FROM after_first a1;

-- ROLLBACK: Automatic cleanup
ROLLBACK;

-- VERIFICATION: State restored to baseline
SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE account_id = 1054315166) as sr_final,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166) as fm_final,
  (SELECT COUNT(*) FROM mp_movement_source_link) as link_final,
  (SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166) as le_final;

-- Verify no test records exist
SELECT
  (SELECT COUNT(*) FROM mp_source_record WHERE source_external_id LIKE 'test_%') as orphaned_test_sr,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND id > (SELECT MAX(id) - 10 FROM mp_financial_movement)) as recent_fm_count;
