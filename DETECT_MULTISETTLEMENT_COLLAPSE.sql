-- ============================================================================
-- DETECT MULTI-SETTLEMENT COLLAPSE
-- Find Report SR where FM/LE does NOT match the SR's economic value
-- Uses ONLY persistent DB state (payload_hash, FM settlement_amount, LE balance_impact)
-- NO dependency on raw_data reconstruction
-- ============================================================================

-- Strategy:
-- For each Report SR of June 2026 with account_id=1054315166 (or NULL historic):
-- 1. Find its linked FM (should be 1 per SR normally)
-- 2. Find the LE of that FM in June (should be 1 per FM normally)
-- 3. Count HOW MANY distinct LE are linked to the same FM
-- 4. If >1 LE OR if LE.balance_impact differs from other SR linked to same FM → COLLAPSE DETECTED

-- PART 1: Find SR with multiple LE (direct indicator of collapse)
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
    AND DATE(sr.raw_data->>'DATE', 'YYYY-MM-DD') BETWEEN '2026-06-01' AND '2026-06-30'
)
SELECT
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

-- PART 2: Explicit check for known problematic SR
-- This uses the PAYLOAD_HASH to find SR without raw_data dependency
-- (assumes we know the payload hashes from prior Layer 1 verification)
WITH known_problematic_hashes AS (
  SELECT '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'::TEXT AS payload_hash, 'SR3903 (should be +1629.44)' AS description
  UNION ALL
  SELECT 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'::TEXT, 'SR3909 (should be +463.84)'
)
SELECT
  kph.description,
  sr.id AS sr_id,
  sr.payload_hash,
  fm.id AS fm_id,
  fm.settlement_amount AS fm_settlement,
  STRING_AGG(DISTINCT le.balance_impact::TEXT, ', ') AS linked_le_impacts,
  STRING_AGG(DISTINCT sr2.id::TEXT, ', ') AS other_sr_same_fm
FROM known_problematic_hashes kph
INNER JOIN mp_source_record sr ON sr.payload_hash = kph.payload_hash
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
LEFT JOIN mp_movement_source_link msl2 ON fm.id = msl2.financial_movement_id
LEFT JOIN mp_source_record sr2 ON msl2.source_record_id = sr2.id AND sr2.id != sr.id
GROUP BY kph.description, sr.id, sr.payload_hash, fm.id, fm.settlement_amount;

-- PART 3: Summary count
-- How many SR have collapse pattern?
SELECT
  COUNT(DISTINCT sr.id) AS sr_with_collapse,
  COUNT(DISTINCT fm.id) AS fm_with_collapse,
  ARRAY_AGG(DISTINCT sr.id ORDER BY sr.id) AS sr_ids,
  ARRAY_AGG(DISTINCT fm.id ORDER BY fm.id) AS fm_ids
FROM mp_source_record sr
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
WHERE sr.source_type = 'report'
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
  AND DATE(sr.raw_data->>'DATE', 'YYYY-MM-DD') BETWEEN '2026-06-01' AND '2026-06-30'
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
