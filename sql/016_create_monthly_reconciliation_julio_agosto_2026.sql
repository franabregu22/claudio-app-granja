-- FASE 1 FUNCIONAL: CREATE MONTHLY_RECONCILIATION JULIO/AGOSTO 2026
-- File: 016_create_monthly_reconciliation_julio_agosto_2026.sql
-- Status: READ + WRITE (INSERT only, idempotent)
-- Purpose: Create monthly reconciliation entries for July and August 2026
-- Precondition: import_period_coverage complete for both months
-- Scope: period_flow + account_balance (status=pending, no snapshots yet)
-- Account: 1054315166

BEGIN;

-- ============================================================
-- PRE-CHECK: COVERAGE MUST BE COMPLETE
-- ============================================================

DO $$
DECLARE
  v_julio_coverage VARCHAR;
  v_agosto_coverage VARCHAR;
BEGIN
  SELECT period_coverage INTO v_julio_coverage
  FROM v_period_coverage_status
  WHERE account_id = 1054315166
    AND period_start = '2026-07-01'::DATE;

  SELECT period_coverage INTO v_agosto_coverage
  FROM v_period_coverage_status
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE;

  IF v_julio_coverage IS NULL OR v_julio_coverage != 'complete' THEN
    RAISE EXCEPTION 'BLOCKER: Julio coverage not complete. Found: %', COALESCE(v_julio_coverage, 'NULL');
  END IF;

  IF v_agosto_coverage IS NULL OR v_agosto_coverage != 'complete' THEN
    RAISE EXCEPTION 'BLOCKER: Agosto coverage not complete. Found: %', COALESCE(v_agosto_coverage, 'NULL');
  END IF;
END $$;

-- ============================================================
-- JULIO 2026: PERIOD_FLOW RECONCILIATION
-- ============================================================
INSERT INTO monthly_reconciliation (
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status
)
SELECT
  1054315166,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'period_flow',
  'pending'
WHERE NOT EXISTS (
  SELECT 1 FROM monthly_reconciliation
  WHERE account_id = 1054315166
    AND period_start = '2026-07-01'::DATE
    AND period_end = '2026-07-31'::DATE
    AND reconciliation_scope = 'period_flow'
);

-- ============================================================
-- JULIO 2026: ACCOUNT_BALANCE RECONCILIATION
-- ============================================================
INSERT INTO monthly_reconciliation (
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status
)
SELECT
  1054315166,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'account_balance',
  'pending'
WHERE NOT EXISTS (
  SELECT 1 FROM monthly_reconciliation
  WHERE account_id = 1054315166
    AND period_start = '2026-07-01'::DATE
    AND period_end = '2026-07-31'::DATE
    AND reconciliation_scope = 'account_balance'
);

-- ============================================================
-- AGOSTO 2026: PERIOD_FLOW RECONCILIATION
-- ============================================================
INSERT INTO monthly_reconciliation (
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status
)
SELECT
  1054315166,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'period_flow',
  'pending'
WHERE NOT EXISTS (
  SELECT 1 FROM monthly_reconciliation
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE
    AND period_end = '2026-08-31'::DATE
    AND reconciliation_scope = 'period_flow'
);

-- ============================================================
-- AGOSTO 2026: ACCOUNT_BALANCE RECONCILIATION
-- ============================================================
INSERT INTO monthly_reconciliation (
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status
)
SELECT
  1054315166,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'account_balance',
  'pending'
WHERE NOT EXISTS (
  SELECT 1 FROM monthly_reconciliation
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE
    AND period_end = '2026-08-31'::DATE
    AND reconciliation_scope = 'account_balance'
);

COMMIT;

-- ============================================================
-- READ-ONLY: VALIDATION
-- ============================================================

-- Show all monthly_reconciliation rows for July and August
SELECT
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status,
  closing_snapshot_id,
  period_flow_observation_id,
  variance_approval_note,
  approved_by,
  approved_at,
  created_at,
  updated_at
FROM monthly_reconciliation
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE
ORDER BY period_start, reconciliation_scope;

-- Show reconciliation summary via view
SELECT
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status
FROM v_monthly_reconciliation_summary
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE
ORDER BY period_start, reconciliation_scope;

-- Summary count
SELECT
  'Monthly Reconciliation Summary' as validation_type,
  'total_rows_julio_agosto' as check_item,
  CAST(COUNT(*) AS TEXT) as value,
  CASE WHEN COUNT(*) = 4 THEN 'PASS' ELSE 'FAIL' END as status
FROM monthly_reconciliation
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE

UNION ALL

SELECT
  'Monthly Reconciliation Summary',
  'all_status_pending',
  CAST(COUNT(CASE WHEN status = 'pending' THEN 1 END) AS TEXT),
  CASE WHEN COUNT(CASE WHEN status = 'pending' THEN 1 END) = 4 THEN 'PASS' ELSE 'FAIL' END
FROM monthly_reconciliation
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE

UNION ALL

SELECT
  'Monthly Reconciliation Summary',
  'no_snapshots_assigned_yet',
  CAST(COUNT(CASE WHEN closing_snapshot_id IS NULL THEN 1 END) AS TEXT),
  CASE WHEN COUNT(CASE WHEN closing_snapshot_id IS NULL THEN 1 END) = 4 THEN 'PASS' ELSE 'FAIL' END
FROM monthly_reconciliation
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE

UNION ALL

SELECT
  'Monthly Reconciliation Summary',
  'no_period_flow_obs_assigned_yet',
  CAST(COUNT(CASE WHEN period_flow_observation_id IS NULL THEN 1 END) AS TEXT),
  CASE WHEN COUNT(CASE WHEN period_flow_observation_id IS NULL THEN 1 END) = 4 THEN 'PASS' ELSE 'FAIL' END
FROM monthly_reconciliation
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE

ORDER BY validation_type, check_item;
