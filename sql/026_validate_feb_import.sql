-- ============================================================================
-- VALIDATE FEB 2026 IMPORT RESULTS (CORRECTED - No scalar subquery issues)
-- File: 026_validate_feb_import.sql
-- Status: READ-ONLY
-- ============================================================================

-- ============================================================================
-- 1. FEB LEDGER SUMMARY
-- ============================================================================

SELECT
  'FEB 2026 LEDGER SUMMARY' as check_type,
  COUNT(*) as ledger_count,
  COALESCE(SUM(balance_impact), 0) as ledger_net_actual,
  1475153.73::NUMERIC(15,2) as ledger_net_expected
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date;

-- ============================================================================
-- 2. FEB NEW LIBERACIONES MOVEMENTS
-- ============================================================================

SELECT
  'FEB 2026 LIBERACIONES MOVEMENTS' as check_type,
  COUNT(DISTINCT msr.id) as linked_source_records,
  COUNT(DISTINCT mfm.id) as distinct_financial_movements,
  mfm.movement_class as class,
  COUNT(*) as count_by_class,
  COALESCE(SUM(mfm.settlement_amount), 0) as settlement_sum_by_class
FROM mp_source_record msr
INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
  AND msr.source_type = 'liberaciones'
  AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date
GROUP BY mfm.movement_class;

-- ============================================================================
-- 3. FEB PAYOUT DETAIL (identify payouts by raw DESCRIPTION)
-- ============================================================================

SELECT
  'FEB 2026 PAYOUT DETAIL' as check_type,
  msr.source_external_id,
  msr.raw_data->>'DESCRIPTION' as description,
  mfm.id as financial_movement_id,
  mfm.movement_class,
  mfm.settlement_amount,
  mfm.needs_review,
  CASE WHEN le.id IS NOT NULL THEN 'YES' ELSE 'NO' END as has_ledger_entry,
  COALESCE(le.balance_impact, 0) as ledger_balance_impact
FROM mp_source_record msr
INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
LEFT JOIN ledger_entry le ON mfm.id = le.financial_movement_id
WHERE mfm.account_id = 1054315166
  AND msr.source_type = 'liberaciones'
  AND msr.raw_data->>'DESCRIPTION' = 'payout'
  AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date
ORDER BY msr.source_external_id;

-- ============================================================================
-- 4. NEEDS_REVIEW STATUS
-- ============================================================================

SELECT
  'NEEDS_REVIEW BASELINE' as check_type,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND needs_review = TRUE) as total_needs_review_account,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166 AND DATE(transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date AND needs_review = TRUE) as feb_needs_review,
  2 as expected_total;

-- ============================================================================
-- 5. DUPLICATION CHECK
-- ============================================================================

SELECT
  'DUPLICATE FM LEDGER ENTRIES' as check_type,
  COUNT(*) as duplicate_count,
  'Should be 0' as expected
FROM (
  SELECT financial_movement_id, COUNT(*) as le_count
  FROM ledger_entry
  WHERE account_id = 1054315166
    AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date
  GROUP BY financial_movement_id
  HAVING COUNT(*) > 1
) dup_check;

-- ============================================================================
-- DUPLICATE LIBERACIONES LINKS (same FM + SR)
-- ============================================================================

SELECT
  'DUPLICATE LIBERACIONES LINKS' as check_type,
  COUNT(*) as duplicate_count,
  'Should be 0' as expected
FROM (
  SELECT financial_movement_id, source_record_id, COUNT(*) as link_count
  FROM mp_movement_source_link mmsl
  WHERE EXISTS (
    SELECT 1 FROM mp_source_record msr
    WHERE msr.id = mmsl.source_record_id AND msr.source_type = 'liberaciones'
  )
    AND EXISTS (
    SELECT 1 FROM mp_financial_movement mfm
    WHERE mfm.id = mmsl.financial_movement_id
      AND mfm.account_id = 1054315166
      AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date
  )
  GROUP BY financial_movement_id, source_record_id
  HAVING COUNT(*) > 1
) dup_links;

-- ============================================================================
-- LIBERACIONES SOURCE_IDS LINKED TO MULTIPLE FM
-- ============================================================================

SELECT
  'LIBERACIONES SOURCE_ID TO MULTIPLE FM' as check_type,
  msr.source_external_id,
  COUNT(DISTINCT mfm.id) as distinct_fm_count,
  STRING_AGG(DISTINCT mfm.id::text, ', ') as fm_ids
FROM mp_source_record msr
INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166
  AND msr.source_type = 'liberaciones'
  AND DATE(mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01'::date AND '2026-02-28'::date
GROUP BY msr.source_external_id
HAVING COUNT(DISTINCT mfm.id) > 1
ORDER BY source_external_id;
