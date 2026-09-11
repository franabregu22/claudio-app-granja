-- ============================================================================
-- FASE 2 PRE-CHECK: FEB-MAR-APR LIBERACIONES IMPORT VALIDATION
-- File: 022_precheck_feb_mar_apr_import.sql
-- Status: READ-ONLY (verification only)
-- Purpose: Verify expected ledger values before executing Liberaciones imports
-- ============================================================================

-- ============================================================================
-- FEBRUARY 2026 PRE-CHECK
-- ============================================================================

SELECT
  'FEB 2026 PRE-CHECK' as month,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date) as fm_count,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date) as current_ledger_net,
  5934805.68::NUMERIC(15,2) as expected_ledger_current,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date
     AND needs_review = TRUE) as needs_review_count;

-- ============================================================================
-- MARCH 2026 PRE-CHECK
-- ============================================================================

SELECT
  'MAR 2026 PRE-CHECK' as month,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as fm_count,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as current_ledger_net,
  10073544.80::NUMERIC(15,2) as expected_ledger_current,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date
     AND needs_review = TRUE) as needs_review_count;

-- ============================================================================
-- APRIL 2026 PRE-CHECK
-- ============================================================================

SELECT
  'APR 2026 PRE-CHECK' as month,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as fm_count,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date) as current_ledger_net,
  7673095.83::NUMERIC(15,2) as expected_ledger_current,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01'::date AND '2026-04-30'::date
     AND needs_review = TRUE) as needs_review_count;

-- ============================================================================
-- BASELINE: NEEDS_REVIEW COUNT (FEB-APR)
-- ============================================================================

SELECT
  'NEEDS_REVIEW_BASELINE (FEB-APR)' as check_type,
  (SELECT COUNT(*) FROM mp_financial_movement
   WHERE account_id = 1054315166
     AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-04-30'::date
     AND needs_review = TRUE) as total_needs_review;

-- ============================================================================
-- PRE-IMPORT SUMMARY
-- ============================================================================

SELECT
  'PRE-CHECK_READY' as status,
  'Ledger values verified. Import can proceed if all checks match expectations.' as message;
