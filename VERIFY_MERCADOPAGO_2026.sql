-- ============================================================================
-- VERIFY_MERCADOPAGO_2026.sql
-- Purpose: Validate MercadoPago reconstruction for account_id 1054315166
-- Post-import verification queries
-- ============================================================================

-- Run after import to confirm data integrity

-- ============================================================================
-- 1. MONTHLY SUMMARY: Net balance, movement counts, ledger integrity
-- ============================================================================

SELECT
  DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS month,
  COUNT(DISTINCT mfm.id) AS financial_movements,
  COUNT(DISTINCT le.id) AS ledger_entries,
  COALESCE(SUM(le.balance_impact), 0::numeric) AS neto_mensual,
  SUM(CASE WHEN le.balance_impact > 0 THEN le.balance_impact ELSE 0 END) AS ingresos,
  SUM(CASE WHEN le.balance_impact < 0 THEN ABS(le.balance_impact) ELSE 0 END) AS egresos,
  COUNT(CASE WHEN mfm.needs_review THEN 1 END) AS needs_review_count
FROM ledger_entry le
INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
GROUP BY DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
ORDER BY month;

-- ============================================================================
-- 2. CUMULATIVE BALANCE by month
-- ============================================================================

WITH monthly_balance AS (
  SELECT
    DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS month,
    COALESCE(SUM(le.balance_impact), 0::numeric) AS neto_mensual
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = 1054315166
  GROUP BY DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  ORDER BY month
)
SELECT
  month,
  neto_mensual,
  SUM(neto_mensual) OVER (ORDER BY month) AS balance_acumulado
FROM monthly_balance;

-- ============================================================================
-- 3. DUPLICATE LEDGER ENTRIES detection
-- ============================================================================

SELECT
  mfm.id AS financial_movement_id,
  mfm.source_external_id,
  COUNT(*) AS duplicate_count,
  STRING_AGG(le.id::text, ', ') AS ledger_entry_ids
FROM ledger_entry le
INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
GROUP BY mfm.id, mfm.source_external_id
HAVING COUNT(*) > 1;

-- ============================================================================
-- 4. NEEDS_REVIEW flagged movements
-- ============================================================================

SELECT
  mfm.id AS financial_movement_id,
  mfm.source_external_id,
  mfm.movement_class,
  mfm.settlement_amount,
  mfm.transaction_date,
  mfm.needs_review
FROM mp_financial_movement mfm
WHERE mfm.account_id = 1054315166
  AND mfm.needs_review = TRUE
ORDER BY mfm.transaction_date;

-- ============================================================================
-- 5. OVERALL STATISTICS
-- ============================================================================

SELECT
  'Account ID' AS metric,
  '1054315166' AS value
UNION ALL
SELECT
  'Total financial movements',
  COUNT(*)::text
FROM mp_financial_movement
WHERE account_id = 1054315166
UNION ALL
SELECT
  'Total ledger entries',
  COUNT(*)::text
FROM ledger_entry
WHERE financial_movement_id IN (
  SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
)
UNION ALL
SELECT
  'Total source records',
  COUNT(*)::text
FROM mp_source_record
WHERE account_id = 1054315166
UNION ALL
SELECT
  'Total movement-source links',
  COUNT(*)::text
FROM mp_movement_source_link
WHERE financial_movement_id IN (
  SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
)
UNION ALL
SELECT
  'Total net balance',
  '$' || COALESCE(SUM(le.balance_impact), 0::numeric)::text
FROM ledger_entry le
INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
UNION ALL
SELECT
  'Date range (min)',
  MIN(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::text
FROM ledger_entry le
INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
UNION ALL
SELECT
  'Date range (max)',
  MAX(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::text
FROM ledger_entry le
INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166;

-- ============================================================================
-- 6. DATA QUALITY: Check for NULL balance_impact
-- ============================================================================

SELECT COUNT(*) AS null_balance_impact_count
FROM ledger_entry le
WHERE le.balance_impact IS NULL;

-- ============================================================================
-- 7. CONSISTENCY CHECK: FM count must equal LE count
-- ============================================================================

WITH fm_count AS (
  SELECT COUNT(*) AS count
  FROM mp_financial_movement
  WHERE account_id = 1054315166
),
le_count AS (
  SELECT COUNT(*) AS count
  FROM ledger_entry le
  INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
  WHERE mfm.account_id = 1054315166
)
SELECT
  fm_count.count AS financial_movements,
  le_count.count AS ledger_entries,
  (fm_count.count = le_count.count) AS consistency_check
FROM fm_count, le_count;

-- ============================================================================
-- 8. CROSS-VALIDATION: compare with BASECSV.csv total
-- ============================================================================
-- Run after import:
-- SELECT
--   'Expected (from BASECSV)' AS source,
--   '$172,814.62' AS total_net
-- UNION ALL
-- SELECT
--   'Actual (from DB)',
--   '$' || COALESCE(SUM(le.balance_impact), 0::numeric)::text
-- FROM ledger_entry le
-- INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
-- WHERE mfm.account_id = 1054315166;
