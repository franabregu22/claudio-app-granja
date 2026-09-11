-- ============================================================================
-- DETECT MULTI-SETTLEMENT COLLAPSE - ReadOnly Query
-- Ejecutá en: AppGranja → SQL Editor → Copy-paste y Run
-- ============================================================================

-- PART 1: Find all Report SR of June with collapse indicators
-- Shows: which SR are collapsed into same FM, and which LE they create
WITH june_sr_links AS (
  SELECT
    sr.id AS sr_id,
    sr.payload_hash,
    sr.raw_data->>'SOURCE_ID' AS source_id,
    fm.id AS fm_id,
    fm.settlement_amount AS fm_impact,
    le.id AS le_id,
    le.balance_impact AS le_impact,
    COUNT(DISTINCT le.id) OVER (PARTITION BY fm.id) AS le_count_per_fm,
    COUNT(DISTINCT sr.id) OVER (PARTITION BY fm.id) AS sr_count_per_fm
  FROM mp_source_record sr
  INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
  INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
  LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  WHERE sr.source_type = 'report'
    AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
    AND (sr.raw_data->>'DATE')::TIMESTAMP::DATE BETWEEN '2026-06-01' AND '2026-06-30'
)
SELECT
  'PART 1: All SR with collapse' AS query_part,
  sr_id,
  source_id,
  fm_id,
  fm_impact,
  le_id,
  le_impact,
  sr_count_per_fm,
  le_count_per_fm,
  CASE
    WHEN sr_count_per_fm > 1 THEN 'MULTI_SR_SAME_FM'
    WHEN le_count_per_fm > 1 THEN 'MULTI_LE_SAME_FM'
    WHEN ABS(fm_impact - COALESCE(le_impact, 0)) > 0.01 THEN 'FM_LE_MISMATCH'
    ELSE 'OK'
  END AS collapse_indicator
FROM june_sr_links
WHERE sr_count_per_fm > 1
   OR le_count_per_fm > 1
   OR ABS(fm_impact - COALESCE(le_impact, 0)) > 0.01
ORDER BY fm_id, sr_id;

-- PART 2: Specific check for SR3903 and SR3909 using payload_hash
-- This directly verifies the 2 known problematic SR
SELECT
  'PART 2: SR3903 & SR3909 by payload_hash' AS query_part,
  kph.description,
  sr.id AS sr_id,
  sr.payload_hash,
  fm.id AS fm_id,
  fm.settlement_amount AS fm_settlement,
  STRING_AGG(DISTINCT le.balance_impact::TEXT, ', ') AS linked_le_impacts,
  STRING_AGG(DISTINCT sr2.id::TEXT, ', ') AS other_sr_same_fm
FROM (
  SELECT '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'::TEXT AS payload_hash, 'SR3903 (+1629.44)' AS description
  UNION ALL
  SELECT 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'::TEXT, 'SR3909 (+463.84)'
) AS kph
INNER JOIN mp_source_record sr ON sr.payload_hash = kph.payload_hash
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
LEFT JOIN mp_movement_source_link msl2 ON fm.id = msl2.financial_movement_id
LEFT JOIN mp_source_record sr2 ON msl2.source_record_id = sr2.id AND sr2.id != sr.id
GROUP BY kph.description, sr.id, sr.payload_hash, fm.id, fm.settlement_amount;

-- PART 3: Summary - Count total SR with collapse in June
-- Answer: How many SR need NEW_FM because of collapse?
SELECT
  'PART 3: Summary count' AS query_part,
  COUNT(DISTINCT sr.id) AS sr_with_collapse,
  COUNT(DISTINCT fm.id) AS fm_with_collapse,
  ARRAY_AGG(DISTINCT sr.id ORDER BY sr.id) AS sr_ids,
  ARRAY_AGG(DISTINCT fm.id ORDER BY fm.id) AS fm_ids
FROM mp_source_record sr
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
WHERE sr.source_type = 'report'
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
  AND (sr.raw_data->>'DATE')::TIMESTAMP::DATE BETWEEN '2026-06-01' AND '2026-06-30'
  AND (
    -- Multiple SR linked to same FM
    (SELECT COUNT(DISTINCT sr2.id) FROM mp_movement_source_link msl2
     INNER JOIN mp_source_record sr2 ON msl2.source_record_id = sr2.id
     WHERE msl2.financial_movement_id = fm.id) > 1
    OR
    -- Multiple LE linked to same FM in June
    (SELECT COUNT(DISTINCT le.id) FROM ledger_entry le
     WHERE le.financial_movement_id = fm.id
     AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30') > 1
  );
