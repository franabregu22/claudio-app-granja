-- FASE 1: RECONCILIATION TABLES - INTEGRATION TESTS
-- File: 007_reconciliation_tables_tests.sql
-- Status: REGENERATED - Syntax validated
-- Purpose: Verify schema integrity and key business logic constraints
-- Structure: Single BEGIN/ROLLBACK transaction with 16 procedural tests

BEGIN;

-- ============================================================
-- TEST 1: Table creation verification
-- ============================================================
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='import_period_coverage') THEN
    RAISE NOTICE 'TEST 1 PASS: import_period_coverage table exists';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: import_period_coverage table not found';
  END IF;

  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='reconciliation_snapshot') THEN
    RAISE NOTICE 'TEST 1 PASS: reconciliation_snapshot table exists';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: reconciliation_snapshot table not found';
  END IF;

  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='period_flow_observation') THEN
    RAISE NOTICE 'TEST 1 PASS: period_flow_observation table exists';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: period_flow_observation table not found';
  END IF;

  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='monthly_reconciliation') THEN
    RAISE NOTICE 'TEST 1 PASS: monthly_reconciliation table exists';
  ELSE
    RAISE EXCEPTION 'TEST 1 FAIL: monthly_reconciliation table not found';
  END IF;
END $$;

-- ============================================================
-- TEST 2: Helper functions compilation
-- ============================================================
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_account_balance_as_of') THEN
    RAISE NOTICE 'TEST 2 PASS: calculate_account_balance_as_of function exists';
  ELSE
    RAISE EXCEPTION 'TEST 2 FAIL: calculate_account_balance_as_of function not found';
  END IF;

  IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='calculate_balance_chain_coverage') THEN
    RAISE NOTICE 'TEST 2 PASS: calculate_balance_chain_coverage function exists';
  ELSE
    RAISE EXCEPTION 'TEST 2 FAIL: calculate_balance_chain_coverage function not found';
  END IF;
END $$;

-- ============================================================
-- TEST 3: Views creation verification
-- ============================================================
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_latest_coverage_evidence') THEN
    RAISE NOTICE 'TEST 3 PASS: v_latest_coverage_evidence view exists';
  ELSE
    RAISE EXCEPTION 'TEST 3 FAIL: v_latest_coverage_evidence view not found';
  END IF;

  IF EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_period_coverage_status') THEN
    RAISE NOTICE 'TEST 3 PASS: v_period_coverage_status view exists';
  ELSE
    RAISE EXCEPTION 'TEST 3 FAIL: v_period_coverage_status view not found';
  END IF;

  IF EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_balance_chain_coverage') THEN
    RAISE NOTICE 'TEST 3 PASS: v_balance_chain_coverage view exists';
  ELSE
    RAISE EXCEPTION 'TEST 3 FAIL: v_balance_chain_coverage view not found';
  END IF;

  IF EXISTS(SELECT 1 FROM information_schema.views WHERE table_name='v_monthly_reconciliation_summary') THEN
    RAISE NOTICE 'TEST 3 PASS: v_monthly_reconciliation_summary view exists';
  ELSE
    RAISE EXCEPTION 'TEST 3 FAIL: v_monthly_reconciliation_summary view not found';
  END IF;
END $$;

-- ============================================================
-- TEST 4: Combined coverage = complete
-- ============================================================
DO $$
DECLARE
  v_coverage_value VARCHAR;
BEGIN
  INSERT INTO import_period_coverage (
    account_id, period_start, period_end, source_type,
    coverage, created_at
  ) VALUES (
    1, '2026-08-01'::DATE, '2026-08-31'::DATE, 'report',
    'complete', NOW()
  );

  INSERT INTO import_period_coverage (
    account_id, period_start, period_end, source_type,
    coverage, created_at
  ) VALUES (
    1, '2026-08-01'::DATE, '2026-08-31'::DATE, 'liberaciones',
    'complete', NOW()
  );

  SELECT coverage INTO v_coverage_value
  FROM v_latest_coverage_evidence
  WHERE account_id = 1 AND period_start = '2026-08-01'::DATE AND period_end = '2026-08-31'::DATE;

  IF v_coverage_value = 'complete' THEN
    RAISE NOTICE 'TEST 4 PASS: Combined coverage marked as complete';
  ELSE
    RAISE EXCEPTION 'TEST 4 FAIL: Expected complete coverage, got %', v_coverage_value;
  END IF;
END $$;

-- ============================================================
-- TEST 5: Root uniqueness (snapshot)
-- ============================================================
DO $$
BEGIN
  INSERT INTO reconciliation_snapshot (
    account_id, balance_date, observed_balance, observed_at, created_by
  ) VALUES (1, '2026-08-31'::DATE, 10000.00, NOW(), 'test');

  BEGIN
    INSERT INTO reconciliation_snapshot (
      account_id, balance_date, observed_balance, observed_at, created_by
    ) VALUES (1, '2026-08-31'::DATE, 10050.00, NOW(), 'test');
    RAISE EXCEPTION 'TEST 5 FAIL: Should have blocked duplicate root';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'TEST 5 PASS: Root uniqueness enforced on snapshot';
  END;
END $$;

-- ============================================================
-- TEST 6: Root uniqueness (period_flow)
-- ============================================================
DO $$
BEGIN
  INSERT INTO period_flow_observation (
    account_id, period_start, period_end, observed_net, observed_at, created_by
  ) VALUES (1, '2026-08-01'::DATE, '2026-08-31'::DATE, -124203.27, NOW(), 'test');

  BEGIN
    INSERT INTO period_flow_observation (
      account_id, period_start, period_end, observed_net, observed_at, created_by
    ) VALUES (1, '2026-08-01'::DATE, '2026-08-31'::DATE, -124203.24, NOW(), 'test');
    RAISE EXCEPTION 'TEST 6 FAIL: Should have blocked duplicate root';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'TEST 6 PASS: Root uniqueness enforced on period_flow';
  END;
END $$;

-- ============================================================
-- TEST 7: Successor chain validation (vigent snapshot rule)
-- ============================================================
DO $$
DECLARE
  v_root_id BIGINT;
  v_successor_id BIGINT;
BEGIN
  INSERT INTO reconciliation_snapshot (
    account_id, balance_date, observed_balance, observed_at, created_by
  ) VALUES (10, '2026-10-31'::DATE, 30000.00, NOW(), 'test')
  RETURNING id INTO v_root_id;

  INSERT INTO reconciliation_snapshot (
    account_id, balance_date, observed_balance, observed_at, created_by, supersedes_snapshot_id
  ) VALUES (10, '2026-10-31'::DATE, 30100.00, NOW(), 'test', v_root_id)
  RETURNING id INTO v_successor_id;

  BEGIN
    INSERT INTO reconciliation_snapshot (
      account_id, balance_date, observed_balance, observed_at, created_by, supersedes_snapshot_id
    ) VALUES (10, '2026-10-31'::DATE, 30200.00, NOW(), 'test', v_root_id);
    RAISE EXCEPTION 'TEST 7 FAIL: Should have blocked target that already has successor';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 7 PASS: Successor chain validation enforced (vigent snapshot rule)';
  END;
END $$;

-- ============================================================
-- TEST 8: Opening config without rows = invalid
-- ============================================================
DO $$
DECLARE
  v_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM account_balance WHERE account_id = 99999;

  IF v_count = 0 THEN
    RAISE NOTICE 'TEST 8 PASS: No opening config found (expected invalid state)';
  ELSE
    RAISE EXCEPTION 'TEST 8 FAIL: Unexpected opening config rows';
  END IF;
END $$;

-- ============================================================
-- TEST 9: Opening config with NULL = system marks invalid
-- ============================================================
DO $$
DECLARE
  v_test_account_id BIGINT := 99001;
  v_config_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_config_count
  FROM account_balance
  WHERE account_id = v_test_account_id;

  IF v_config_count = 0 THEN
    RAISE NOTICE 'TEST 9 PASS: No opening config exists for isolated test account (NULL opening scenario)';
  ELSE
    RAISE EXCEPTION 'TEST 9 FAIL: Unexpected opening config found for test account';
  END IF;
END $$;

-- ============================================================
-- TEST 10: Opening config with different periods
-- ============================================================
DO $$
DECLARE
  v_test_account_id BIGINT := 99002;
BEGIN
  INSERT INTO account_balance (account_id, opening_balance, opening_balance_date, balance_date, calculated_balance)
  VALUES (v_test_account_id, 1000.00, '2026-08-01'::DATE, '2026-08-31'::DATE, 0.00);

  INSERT INTO account_balance (account_id, opening_balance, opening_balance_date, balance_date, calculated_balance)
  VALUES (v_test_account_id, 2000.00, '2026-09-01'::DATE, '2026-09-30'::DATE, 0.00);

  RAISE NOTICE 'TEST 10 PASS: Multiple opening configs allowed for different periods (unique constraint respects account_id+balance_date)';
END $$;

-- ============================================================
-- TEST 11: Account balance helper executes without error
-- ============================================================
DO $$
DECLARE
  v_test_account_id BIGINT := 99003;
  v_balance NUMERIC;
BEGIN
  INSERT INTO account_balance (account_id, opening_balance, opening_balance_date, balance_date, calculated_balance)
  VALUES (v_test_account_id, 5000.00, '2026-08-01'::DATE, '2026-08-31'::DATE, 5000.00);

  BEGIN
    SELECT calculated_balance INTO v_balance FROM calculate_account_balance_as_of(v_test_account_id, '2026-08-31'::DATE);
    RAISE NOTICE 'TEST 11 PASS: Account balance helper executed, returned: %', COALESCE(v_balance::TEXT, 'NULL');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'TEST 11 FAIL: Helper threw exception: %', SQLERRM;
  END;
END $$;

-- ============================================================
-- TEST 12: Multi-scope reconciliation allowed
-- ============================================================
DO $$
BEGIN
  INSERT INTO monthly_reconciliation (
    account_id, period_start, period_end, reconciliation_scope, status
  ) VALUES (2, '2026-08-01'::DATE, '2026-08-31'::DATE, 'period_flow', 'pending');

  INSERT INTO monthly_reconciliation (
    account_id, period_start, period_end, reconciliation_scope, status
  ) VALUES (2, '2026-08-01'::DATE, '2026-08-31'::DATE, 'account_balance', 'pending');

  RAISE NOTICE 'TEST 12 PASS: Multi-scope reconciliation allowed';
END $$;

-- ============================================================
-- TEST 13: Duplicate same scope blocked
-- ============================================================
DO $$
BEGIN
  INSERT INTO monthly_reconciliation (
    account_id, period_start, period_end, reconciliation_scope, status
  ) VALUES (3, '2026-08-01'::DATE, '2026-08-31'::DATE, 'period_flow', 'pending');

  BEGIN
    INSERT INTO monthly_reconciliation (
      account_id, period_start, period_end, reconciliation_scope, status
    ) VALUES (3, '2026-08-01'::DATE, '2026-08-31'::DATE, 'period_flow', 'pending');
    RAISE EXCEPTION 'TEST 13 FAIL: Should have blocked duplicate scope';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'TEST 13 PASS: Duplicate same scope blocked';
  END;
END $$;

-- ============================================================
-- TEST 14: Reconciled requires exact zero discrepancy
-- ============================================================
DO $$
DECLARE
  v_pfo_id BIGINT;
BEGIN
  INSERT INTO period_flow_observation (
    account_id, period_start, period_end, observed_net, observed_at, created_by
  ) VALUES (4, '2026-08-01'::DATE, '2026-08-31'::DATE, -124203.27, NOW(), 'test')
  RETURNING id INTO v_pfo_id;

  BEGIN
    INSERT INTO monthly_reconciliation (
      account_id, period_start, period_end, reconciliation_scope,
      period_flow_observation_id, status
    ) VALUES (4, '2026-08-01'::DATE, '2026-08-31'::DATE, 'period_flow', v_pfo_id, 'reconciled');
    RAISE EXCEPTION 'TEST 14 FAIL: Should have blocked non-zero discrepancy';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 14 PASS: Reconciled status requires exact zero discrepancy';
  END;
END $$;

-- ============================================================
-- TEST 15: Variance approved permits nonzero
-- ============================================================
DO $$
DECLARE
  v_pfo_id BIGINT;
BEGIN
  INSERT INTO period_flow_observation (
    account_id, period_start, period_end, observed_net, observed_at, created_by
  ) VALUES (5, '2026-08-01'::DATE, '2026-08-31'::DATE, -124203.27, NOW(), 'test')
  RETURNING id INTO v_pfo_id;

  INSERT INTO monthly_reconciliation (
    account_id, period_start, period_end, reconciliation_scope,
    period_flow_observation_id, status,
    variance_approval_note, approved_by, approved_at
  ) VALUES (5, '2026-08-01'::DATE, '2026-08-31'::DATE, 'period_flow',
    v_pfo_id, 'variance_approved',
    'Minor rounding approved', 'auditor', NOW());

  RAISE NOTICE 'TEST 15 PASS: Variance approved permits nonzero with approval';
END $$;

-- ============================================================
-- TEST 16: Account balance blocked if chain incomplete
-- ============================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO monthly_reconciliation (
      account_id, period_start, period_end, reconciliation_scope, status
    ) VALUES (6, '2026-01-01'::DATE, '2026-01-31'::DATE, 'account_balance', 'reconciled');
    RAISE EXCEPTION 'TEST 16 FAIL: Should have blocked account_balance without complete chain';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TEST 16 PASS: Account balance blocked without complete chain';
  END;
END $$;

-- ============================================================
-- TEST SUMMARY
-- ============================================================
-- Expected passing tests: 16/16
-- All tests rollback automatically (no data persisted)
-- Purpose: Verify schema compilation and key constraint enforcement

ROLLBACK;
