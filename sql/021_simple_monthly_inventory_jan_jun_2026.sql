-- ============================================================================
-- FASE 1: SIMPLE MONTHLY INVENTORY (JAN-JUN 2026)
-- File: 021_simple_monthly_inventory_jan_jun_2026.sql
-- Purpose: Three independent queries to assess raw data availability by month
-- Status: READ-ONLY (SELECT only, no modifications)
-- ============================================================================

-- ============================================================================
-- SELECT 1: mp_financial_movement by month
-- ============================================================================

SELECT
  TO_CHAR(
    DATE_TRUNC('month', mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires'),
    'YYYY-MM'
  ) AS month,
  COUNT(*) AS mfm_count,
  MIN(DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')) AS min_transaction_date,
  MAX(DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')) AS max_transaction_date,
  COALESCE(SUM(mfm.settlement_amount), 0) AS settlement_amount_sum,
  COUNT(*) FILTER (WHERE mfm.needs_review = TRUE) AS needs_review_count
FROM mp_financial_movement mfm
WHERE mfm.account_id = 1054315166
  AND mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
  AND mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
GROUP BY DATE_TRUNC('month', mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')
ORDER BY month;

-- ============================================================================
-- SELECT 2: ledger_entry by month
-- ============================================================================

SELECT
  TO_CHAR(
    DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires'),
    'YYYY-MM'
  ) AS month,
  COUNT(*) AS ledger_count,
  MIN(DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')) AS min_occurred_date,
  MAX(DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')) AS max_occurred_date,
  COALESCE(SUM(le.balance_impact), 0) AS balance_impact_sum
FROM ledger_entry le
WHERE le.account_id = 1054315166
  AND le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
  AND le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
GROUP BY DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
ORDER BY month;

-- ============================================================================
-- SELECT 3: report source records (linked to movements) by month
-- ============================================================================

SELECT
  TO_CHAR(
    DATE_TRUNC('month', mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires'),
    'YYYY-MM'
  ) AS month,
  COUNT(*) AS source_links_count,
  COUNT(DISTINCT msr.id) AS source_records_unique,
  COUNT(DISTINCT mfm.id) AS linked_financial_movements
FROM mp_source_record msr
INNER JOIN mp_movement_source_link mmsl
  ON mmsl.source_record_id = msr.id
INNER JOIN mp_financial_movement mfm
  ON mmsl.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
  AND msr.source_type = 'report'
  AND mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
  AND mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
GROUP BY DATE_TRUNC('month', mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')
ORDER BY month;
