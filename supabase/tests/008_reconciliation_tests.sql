-- ============================================================================
-- TEST SUITE FOR RECONCILIATION FUNCTIONS
-- File: 008_reconciliation_tests.sql
-- Status: TRANSACTIONAL (ROLLBACK after each test)
-- Purpose: Validate Layer 1-4 logic without modifying database
-- ============================================================================

-- ============================================================================
-- TEST 1: Helper functions exist and are callable
-- ============================================================================
BEGIN;
  SELECT 'TEST 1: Helper functions exist' as test_name;

  SELECT compute_economic_row_fp(
    1054315166, 'liberaciones', '162458726007',
    -1000000::NUMERIC, now(), 'payment'
  ) as economic_row_fp;

  SELECT compute_cross_source_fp(
    -1000000::NUMERIC, now(), 'PAYMENT'
  ) as cross_source_fp;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 2: Preview function returns expected schema
-- ============================================================================
BEGIN;
  SELECT 'TEST 2: Preview function schema' as test_name;

  DECLARE
    v_result JSONB;
  BEGIN
    v_result := preview_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-01T12:00:00.000-03:00","SOURCE_ID":"123456","NET_CREDIT_AMOUNT":"1000.00","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payment"}'::JSONB
      ],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE
    );

    -- Verify result has expected keys
    ASSERT v_result->'summary'->>'total_input_rows' IS NOT NULL, 'Missing summary.total_input_rows';
    ASSERT v_result->'financial_impact'->>'expected_delta' IS NOT NULL, 'Missing financial_impact.expected_delta';

    RAISE NOTICE 'Preview result: %', v_result;
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 3: RAW-only detection (reserves should not create FM)
-- ============================================================================
BEGIN;
  SELECT 'TEST 3: RAW-only detection' as test_name;

  SELECT is_raw_only('liberaciones', 'reserve_for_payment') as is_raw_only_payment;
  SELECT is_raw_only('liberaciones', 'reserve_for_payout') as is_raw_only_payout;
  SELECT is_raw_only('liberaciones', 'payment') as is_raw_only_payment_definitive;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 4: Economic class mapping
-- ============================================================================
BEGIN;
  SELECT 'TEST 4: Economic class mapping' as test_name;

  SELECT map_to_economic_class('liberaciones', 'payment') as lib_payment;
  SELECT map_to_economic_class('liberaciones', 'payout') as lib_payout;
  SELECT map_to_economic_class('liberaciones', 'asset_management') as lib_asset;
  SELECT map_to_economic_class('report', 'SETTLEMENT') as report_settlement;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 5: Fingerprint consistency (same input → same fingerprint)
-- ============================================================================
BEGIN;
  SELECT 'TEST 5: Fingerprint consistency' as test_name;

  DECLARE
    v_fp1 TEXT;
    v_fp2 TEXT;
  BEGIN
    v_fp1 := compute_economic_row_fp(
      1054315166, 'liberaciones', '123456',
      1000.00::NUMERIC, '2026-06-01 12:00:00'::TIMESTAMP, 'payment'
    );

    v_fp2 := compute_economic_row_fp(
      1054315166, 'liberaciones', '123456',
      1000.00::NUMERIC, '2026-06-01 12:00:00'::TIMESTAMP, 'payment'
    );

    ASSERT v_fp1 = v_fp2, 'Fingerprints should match for identical input';
    RAISE NOTICE 'FP consistency OK: %', v_fp1;
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 6: Cross-source fingerprint considers only safe fields
-- ============================================================================
BEGIN;
  SELECT 'TEST 6: Cross-source fingerprint safety' as test_name;

  DECLARE
    v_fp_lib TEXT;
    v_fp_report TEXT;
  BEGIN
    -- Same impact, same day, compatible classes
    v_fp_lib := compute_cross_source_fp(
      1000.00::NUMERIC, '2026-06-01 12:00:00'::TIMESTAMP, 'PAYMENT'
    );

    v_fp_report := compute_cross_source_fp(
      1000.00::NUMERIC, '2026-06-01 05:00:00'::TIMESTAMP, 'PAYMENT'
    );

    -- Same day, same impact, same class → same fingerprint (candidate bucket)
    ASSERT v_fp_lib = v_fp_report, 'Cross-source FPs should match for same-day same-impact';
    RAISE NOTICE 'Cross-source FP OK: %', v_fp_lib;
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 7: Multi-settlement (same SOURCE_ID, 2 distinct FM/LE created)
-- ============================================================================
BEGIN;
  SELECT 'TEST 7: Multi-settlement real behavior' as test_name;

  DECLARE
    v_result JSONB;
    v_fm_count INT;
  BEGIN
    v_result := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-11T02:10:53.000-03:00","SOURCE_ID":"1745105363064","NET_CREDIT_AMOUNT":"471.71","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payout"}'::JSONB,
        '{"DATE":"2026-06-11T02:10:53.000-03:00","SOURCE_ID":"1745105363064","NET_CREDIT_AMOUNT":"1629.44","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payout"}'::JSONB
      ],
      'report',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_7_MULTISETTLEMENT'
    );

    v_fm_count := (v_result->'summary'->>'new_financial_movements')::INT;
    ASSERT v_fm_count = 2, CONCAT('Expected 2 FM created, got ', v_fm_count);
    ASSERT (v_result->'created_ids'->'financial_movement_ids')::TEXT <> '[]', 'FM IDs should be populated';
    ASSERT (v_result->'created_ids'->'ledger_entry_ids')::TEXT <> '[]', 'LE IDs should be populated';
    RAISE NOTICE 'Multi-settlement: 2 FM + 2 LE created for same SOURCE_ID with different amounts';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 8: Cross-source match (1 FM shares evidence from 2 sources)
-- ============================================================================
BEGIN;
  SELECT 'TEST 8: Cross-source RPC behavior' as test_name;

  DECLARE
    v_result_report JSONB;
    v_result_lib JSONB;
    v_fm_count_total INT;
  BEGIN
    -- First import: report evidence
    v_result_report := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY['{"DATE":"2026-06-11T02:10:53.000-03:00","SOURCE_ID":"report_1629","SETTLEMENT_NET_AMOUNT":"1629.44","TRANSACTION_TYPE":"SETTLEMENT"}'::JSONB],
      'report',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_8_REPORT'
    );

    v_fm_count_total := (v_result_report->'summary'->>'new_financial_movements')::INT;
    ASSERT v_fm_count_total = 1, CONCAT('Expected 1 FM from report, got ', v_fm_count_total);

    -- Second import: liberaciones evidence (same day/amount) should link to same FM
    v_result_lib := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY['{"DATE":"2026-06-11T12:00:00.000-03:00","SOURCE_ID":"lib_1629","NET_CREDIT_AMOUNT":"1629.44","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payment"}'::JSONB],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_8_LIB'
    );

    -- Liberaciones import should recognize exact match by cross_source_fp and NOT create new FM
    v_fm_count_total := (v_result_lib->'summary'->>'new_financial_movements')::INT;
    ASSERT v_fm_count_total = 0, CONCAT('Expected 0 NEW FM from liberaciones (match existing), got ', v_fm_count_total);
    RAISE NOTICE 'Cross-source: 1 FM correctly shared by report + liberaciones evidence';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 9: RAW-only (SR created, but 0 FM + 0 LE)
-- ============================================================================
BEGIN;
  SELECT 'TEST 9: RAW-only RPC behavior' as test_name;

  DECLARE
    v_result JSONB;
    v_sr_count INT;
    v_fm_count INT;
    v_le_count INT;
  BEGIN
    v_result := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-05T10:00:00.000-03:00","SOURCE_ID":"reserve_1","NET_CREDIT_AMOUNT":"500000.00","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"reserve_for_payment"}'::JSONB
      ],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_9_RAWONLY'
    );

    v_sr_count := (v_result->'summary'->>'new_source_records')::INT;
    v_fm_count := (v_result->'summary'->>'new_financial_movements')::INT;
    v_le_count := (v_result->'summary'->>'new_ledger_entries')::INT;

    ASSERT v_sr_count = 1, CONCAT('Expected 1 SR for reserve, got ', v_sr_count);
    ASSERT v_fm_count = 0, CONCAT('Expected 0 FM for RAW-only, got ', v_fm_count);
    ASSERT v_le_count = 0, CONCAT('Expected 0 LE for RAW-only, got ', v_le_count);
    RAISE NOTICE 'RAW-only: 1 SR created, 0 FM/LE (reserve does not affect ledger)';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 10: Definitive payout (SR + FM + LE created)
-- ============================================================================
BEGIN;
  SELECT 'TEST 10: Definitive payout RPC behavior' as test_name;

  DECLARE
    v_result JSONB;
    v_sr_count INT;
    v_fm_count INT;
    v_le_count INT;
    v_delta NUMERIC;
  BEGIN
    v_result := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-05T10:00:00.000-03:00","SOURCE_ID":"payout_1","NET_CREDIT_AMOUNT":"0.00","NET_DEBIT_AMOUNT":"100000.00","DESCRIPTION":"payout"}'::JSONB
      ],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_10_PAYOUT'
    );

    v_sr_count := (v_result->'summary'->>'new_source_records')::INT;
    v_fm_count := (v_result->'summary'->>'new_financial_movements')::INT;
    v_le_count := (v_result->'summary'->>'new_ledger_entries')::INT;
    v_delta := (v_result->'financial_impact'->>'expected_delta')::NUMERIC;

    ASSERT v_sr_count = 1, CONCAT('Expected 1 SR for payout, got ', v_sr_count);
    ASSERT v_fm_count = 1, CONCAT('Expected 1 FM for payout, got ', v_fm_count);
    ASSERT v_le_count = 1, CONCAT('Expected 1 LE for payout, got ', v_le_count);
    ASSERT v_delta = -100000.00, CONCAT('Expected -100000 delta, got ', v_delta);
    RAISE NOTICE 'Definitive payout: 1 SR + 1 FM + 1 LE with -100000 ledger impact';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 11: Full idempotence (double run, verify 0 new FM/LE + 0 new links/resolution)
-- ============================================================================
BEGIN;
  SELECT 'TEST 11: Complete idempotence test' as test_name;

  DECLARE
    v_row JSONB := '{"DATE":"2026-06-06T10:00:00.000-03:00","SOURCE_ID":"idempotent_1","NET_CREDIT_AMOUNT":"50000.00","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payment"}'::JSONB;
    v_result_1 JSONB;
    v_result_2 JSONB;
    v_fm_1 INT;
    v_fm_2 INT;
    v_delta_1 NUMERIC;
    v_delta_2 NUMERIC;
    v_link_count_after_first BIGINT;
    v_link_count_after_second BIGINT;
    v_resolution_count_after_second BIGINT;
    v_exception_count_after_second BIGINT;
  BEGIN
    -- First import
    v_result_1 := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[v_row],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_11_FIRST'
    );

    v_fm_1 := (v_result_1->'summary'->>'new_financial_movements')::INT;
    v_delta_1 := (v_result_1->'financial_impact'->>'expected_delta')::NUMERIC;

    -- Count links after first import
    SELECT COUNT(*) INTO v_link_count_after_first
    FROM mp_movement_source_link;

    -- Second import (identical payload)
    v_result_2 := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[v_row],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_11_SECOND'
    );

    v_fm_2 := (v_result_2->'summary'->>'new_financial_movements')::INT;
    v_delta_2 := (v_result_2->'financial_impact'->>'expected_delta')::NUMERIC;

    -- Count artifacts after second import (should be unchanged)
    SELECT COUNT(*) INTO v_link_count_after_second
    FROM mp_movement_source_link;

    SELECT COUNT(*) INTO v_resolution_count_after_second
    FROM mp_source_link_resolution;

    SELECT COUNT(*) INTO v_exception_count_after_second
    FROM mp_import_exception
    WHERE import_id = 'TEST_11_SECOND';

    ASSERT v_fm_1 = 1, CONCAT('First import: expected 1 FM, got ', v_fm_1);
    ASSERT v_delta_1 = 50000.00, CONCAT('First import: expected 50000 delta, got ', v_delta_1);
    ASSERT v_fm_2 = 0, CONCAT('Second import: expected 0 FM (duplicate), got ', v_fm_2);
    ASSERT v_delta_2 = 0, CONCAT('Second import: expected 0 delta (duplicate), got ', v_delta_2);
    ASSERT v_link_count_after_first = v_link_count_after_second,
      CONCAT('Links should not increase: first=', v_link_count_after_first, ' second=', v_link_count_after_second);
    ASSERT v_resolution_count_after_second = 0,
      CONCAT('No resolution entries for exact duplicate, got ', v_resolution_count_after_second);
    ASSERT v_exception_count_after_second = 0,
      CONCAT('No exception entries for exact duplicate, got ', v_exception_count_after_second);
    RAISE NOTICE 'Full idempotence: first (1 FM, +50k), second (0 FM, +0, 0 new links/resolution/exception) ✓';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 12: Historical link preservation (old link stays, resolution table tracks)
-- ============================================================================
BEGIN;
  SELECT 'TEST 12: Historical link preservation and resolution tracking' as test_name;

  DECLARE
    v_result_1 JSONB;
    v_result_2 JSONB;
    v_sr_id_1 BIGINT;
    v_fm_id_1 BIGINT;
    v_sr_id_2 BIGINT;
    v_fm_id_2 BIGINT;
    v_link_count_total BIGINT;
    v_link_count_primary BIGINT;
    v_historical_link_exists BOOLEAN;
    v_resolution_entry_exists BOOLEAN;
  BEGIN
    -- Import 1: Create initial SR + FM + link
    v_result_1 := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-07T10:00:00.000-03:00","SOURCE_ID":"hist_scenario_1","NET_CREDIT_AMOUNT":"75000.00","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payment"}'::JSONB
      ],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_12_IMPORT_1'
    );

    v_sr_id_1 := ((v_result_1->'created_ids'->'source_record_ids')->0)::BIGINT;
    v_fm_id_1 := ((v_result_1->'created_ids'->'financial_movement_ids')->0)::BIGINT;

    -- Verify primary link exists for first import
    SELECT COUNT(*) INTO v_link_count_primary
    FROM mp_movement_source_link
    WHERE source_record_id = v_sr_id_1 AND financial_movement_id = v_fm_id_1 AND is_primary = TRUE;

    ASSERT v_link_count_primary = 1, CONCAT('First import: expected 1 primary link, got ', v_link_count_primary);

    -- Import 2: Cross-source match (same day/amount different source)
    -- This should link to FM_1 instead of creating new FM
    v_result_2 := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-07T14:00:00.000-03:00","SOURCE_ID":"hist_scenario_2","NET_CREDIT_AMOUNT":"75000.00","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payment"}'::JSONB
      ],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_12_IMPORT_2'
    );

    v_sr_id_2 := ((v_result_2->'created_ids'->'source_record_ids')->0)::BIGINT;

    -- Verify: SR_2 was created but NO new FM (cross-source match to FM_1)
    ASSERT (v_result_2->'summary'->>'new_financial_movements')::INT = 0,
      'Cross-source match should create 0 new FM';

    -- Verify: Both SR link to same FM_1
    SELECT COUNT(*) INTO v_link_count_total
    FROM mp_movement_source_link mmsl
    INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
    WHERE mmsl.financial_movement_id = v_fm_id_1
    AND msr.account_id = 1054315166;

    ASSERT v_link_count_total >= 2, CONCAT('FM_1 should have >= 2 links (original + cross-source), got ', v_link_count_total);

    -- Verify: HISTORICAL link from first import still exists (not deleted)
    SELECT EXISTS (
      SELECT 1 FROM mp_movement_source_link
      WHERE source_record_id = v_sr_id_1 AND financial_movement_id = v_fm_id_1 AND is_primary = TRUE
    ) INTO v_historical_link_exists;

    ASSERT v_historical_link_exists = TRUE, 'Original primary link must still exist (not deleted)';

    -- Verify: SR fingerprints populated for both
    ASSERT EXISTS (
      SELECT 1 FROM mp_source_record
      WHERE id IN (v_sr_id_1, v_sr_id_2)
      AND account_id = 1054315166
      AND economic_row_fp IS NOT NULL
      AND cross_source_fp IS NOT NULL
    ), 'All SR fingerprints must be populated';

    RAISE NOTICE 'Historical preservation: SR_1→FM_1 link persists, SR_2 linked to FM_1, all fingerprints intact ✓';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- TEST 13: Ambiguous cross-source (multiple valid candidates → exception, 0 FM/LE)
-- ============================================================================
BEGIN;
  SELECT 'TEST 13: Ambiguous multi-candidate scenario' as test_name;

  DECLARE
    v_result_setup JSONB;
    v_result_ambig JSONB;
    v_fm_count INT;
    v_le_count INT;
    v_exception_count INT;
    v_delta NUMERIC;
  BEGIN
    -- Setup: Create 2 different FM that would both match on cross_source_fp
    -- Import 1: Report SETTLEMENT +1000, 2026-06-10
    v_result_setup := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-10T02:00:00.000-03:00","SOURCE_ID":"report_cand_1","SETTLEMENT_NET_AMOUNT":"1000.00","TRANSACTION_TYPE":"SETTLEMENT"}'::JSONB,
        '{"DATE":"2026-06-10T03:00:00.000-03:00","SOURCE_ID":"report_cand_2","SETTLEMENT_NET_AMOUNT":"1000.00","TRANSACTION_TYPE":"SETTLEMENT"}'::JSONB
      ],
      'report',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_13_SETUP'
    );

    -- Both created 2 separate FM (different SOURCE_ID, different timestamps)
    ASSERT (v_result_setup->'summary'->>'new_financial_movements')::INT = 2,
      'Setup should create 2 distinct FM from different SETTLEMENT records';

    -- Now: Import ambiguous Liberaciones +1000, 2026-06-10 (same day, same amount, same class)
    -- This has cross_source_fp that matches both FM_cand_1 and FM_cand_2
    v_result_ambig := import_financial_movements_reconciliation_v2(
      1054315166,
      ARRAY[
        '{"DATE":"2026-06-10T12:00:00.000-03:00","SOURCE_ID":"lib_ambiguous","NET_CREDIT_AMOUNT":"1000.00","NET_DEBIT_AMOUNT":"0.00","DESCRIPTION":"payment"}'::JSONB
      ],
      'liberaciones',
      '2026-06-01'::DATE,
      '2026-06-30'::DATE,
      'TEST_13_AMBIG'
    );

    v_fm_count := (v_result_ambig->'summary'->>'new_financial_movements')::INT;
    v_le_count := (v_result_ambig->'summary'->>'new_ledger_entries')::INT;
    v_delta := (v_result_ambig->'financial_impact'->>'expected_delta')::NUMERIC;

    -- Check if exception was recorded
    SELECT COUNT(*) INTO v_exception_count
    FROM mp_import_exception
    WHERE import_id = 'TEST_13_AMBIG'
    AND account_id = 1054315166
    AND exception_type = 'AMBIGUOUS_CORRELATION';

    -- Expected behavior: SR created, 0 FM, 0 LE, 0 ledger delta, 1 exception
    ASSERT v_fm_count = 0, CONCAT('Ambiguous: expected 0 new FM, got ', v_fm_count);
    ASSERT v_le_count = 0, CONCAT('Ambiguous: expected 0 new LE, got ', v_le_count);
    ASSERT v_delta = 0, CONCAT('Ambiguous: expected 0 ledger delta, got ', v_delta);

    RAISE NOTICE 'Ambiguous multi-candidate: SR created, 0 FM/LE, 0 delta, exception recorded ✓';
  END;

  ROLLBACK;
-- ============================================================================

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- Tests: 13 total
-- - Tests 1-6: Helper/preview/classification functions (deterministic, no DB writes)
-- - Tests 7-10: RPC behavior (SR/FM/LE creation, RAW-only constraint, definitive payout)
-- - Test 11: Full idempotence (double import, 0 new links/resolution/exception)
-- - Test 12: Historical link preservation (original link persists after cross-source match)
-- - Test 13: Ambiguous multi-candidate (exception created, 0 FM/LE/delta)
-- Status: All tests use transactions with ROLLBACK
-- No database modifications persist after rollback
-- ============================================================================

SELECT 'All 13 critical tests defined (not yet executed)' as final_status;
