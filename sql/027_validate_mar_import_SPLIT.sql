-- ============================================================================
-- VALIDATE MAR 2026 IMPORT RESULTS — SPLIT INTO 5 INDEPENDENT QUERIES
-- File: 027_validate_mar_import_SPLIT.sql
-- Status: READ-ONLY
-- Execute EACH query separately in Supabase SQL Editor
-- ============================================================================

-- ============================================================================
-- QUERY 1: MAR LEDGER SUMMARY
-- ============================================================================
-- Execute this first

SELECT
  COUNT(*) as ledger_count,
  COALESCE(SUM(balance_impact), 0) as ledger_net
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date;

-- ============================================================================
-- QUERY 2: MAR LIBERACIONES DESCRIPTION SUMMARY
-- ============================================================================
-- Execute this second
-- Deduplicate by (DESCRIPTION + financial_movement_id) to avoid counting same FM twice

WITH fm_by_description AS (
  SELECT DISTINCT
    msr.raw_data->>'DESCRIPTION' as description,
    mfm.id as financial_movement_id,
    mfm.settlement_amount
  FROM mp_source_record msr
  INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
  INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
  WHERE msr.source_type = 'liberaciones'
    AND mfm.account_id = 1054315166
    AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date
)
SELECT
  fm_by_description.description,
  (SELECT COUNT(DISTINCT msr.id) FROM mp_source_record msr
   INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
   INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
   WHERE msr.source_type = 'liberaciones'
     AND msr.raw_data->>'DESCRIPTION' = fm_by_description.description
     AND mfm.account_id = 1054315166
     AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as source_rows,
  COUNT(DISTINCT fm_by_description.financial_movement_id) as distinct_fm,
  COALESCE(SUM(fm_by_description.settlement_amount), 0) as settlement_sum
FROM fm_by_description
GROUP BY fm_by_description.description
ORDER BY description;

-- ============================================================================
-- QUERY 3: MAR PAYOUT DETAIL
-- ============================================================================
-- Execute this third

SELECT
  msr.source_external_id,
  msr.id as source_record_id,
  mmsl.financial_movement_id,
  mmsl.is_primary,
  mfm.settlement_amount,
  mfm.movement_class,
  mfm.needs_review,
  le.id as ledger_entry_id,
  le.balance_impact
FROM mp_source_record msr
INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE msr.source_type = 'liberaciones'
  AND msr.raw_data->>'DESCRIPTION' = 'payout'
  AND mfm.account_id = 1054315166
  AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date
ORDER BY msr.source_external_id, msr.id;

-- ============================================================================
-- QUERY 4: MAR PAYOUT AGGREGATE
-- ============================================================================
-- Execute this fourth
-- Deduplicate by financial_movement_id to avoid summing same FM multiple times

WITH payout_fm_dedup AS (
  SELECT DISTINCT
    mfm.id as financial_movement_id,
    mfm.settlement_amount
  FROM mp_source_record msr
  INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
  INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
  WHERE msr.source_type = 'liberaciones'
    AND msr.raw_data->>'DESCRIPTION' = 'payout'
    AND mfm.account_id = 1054315166
    AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date
),
payout_le_dedup AS (
  SELECT DISTINCT
    mfm.id as financial_movement_id,
    le.balance_impact
  FROM mp_source_record msr
  INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
  INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
  INNER JOIN ledger_entry le ON mfm.id = le.financial_movement_id
  WHERE msr.source_type = 'liberaciones'
    AND msr.raw_data->>'DESCRIPTION' = 'payout'
    AND mfm.account_id = 1054315166
    AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date
)
SELECT
  (SELECT COUNT(DISTINCT msr.id) FROM mp_source_record msr
   INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
   INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
   WHERE msr.source_type = 'liberaciones'
     AND msr.raw_data->>'DESCRIPTION' = 'payout'
     AND mfm.account_id = 1054315166
     AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date) as payout_source_records,
  COUNT(DISTINCT payout_fm_dedup.financial_movement_id) as distinct_payout_fm,
  (SELECT COUNT(DISTINCT payout_le_dedup.financial_movement_id) FROM payout_le_dedup) as payout_fm_with_ledger,
  COALESCE(SUM(payout_fm_dedup.settlement_amount), 0) as payout_settlement_sum,
  COALESCE((SELECT SUM(payout_le_dedup.balance_impact) FROM payout_le_dedup), 0) as payout_ledger_impact_sum
FROM payout_fm_dedup;

-- ============================================================================
-- QUERY 5: NEEDS REVIEW
-- ============================================================================
-- Execute this fifth

SELECT
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND needs_review = TRUE) as total_needs_review_account,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01'::date AND '2026-03-31'::date AND needs_review = TRUE) as mar_needs_review;
