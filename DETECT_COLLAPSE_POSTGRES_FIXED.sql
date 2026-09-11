-- Find all Report FM with collapse in June
WITH fm_with_june_le AS (
  SELECT DISTINCT fm.id
  FROM mp_financial_movement fm
  INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  WHERE (fm.account_id = 1054315166 OR fm.account_id IS NULL)
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
),
sr_counts_per_fm AS (
  SELECT msl.financial_movement_id AS fm_id, COUNT(DISTINCT sr.id) AS sr_count
  FROM mp_movement_source_link msl
  INNER JOIN mp_source_record sr ON msl.source_record_id = sr.id
  WHERE sr.source_type = 'report'
  GROUP BY msl.financial_movement_id
),
le_counts_per_fm AS (
  SELECT fm.id AS fm_id, COUNT(DISTINCT le.id) AS le_count
  FROM mp_financial_movement fm
  INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  WHERE DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  GROUP BY fm.id
),
fm_le_details AS (
  SELECT DISTINCT ON (fm.id, le.id)
    fm.id AS fm_id,
    fm.settlement_amount,
    le.id AS le_id,
    le.balance_impact
  FROM mp_financial_movement fm
  INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  WHERE (fm.account_id = 1054315166 OR fm.account_id IS NULL)
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
)
SELECT
  'MULTI_SETTLEMENT_COLLAPSE' AS finding,
  fm.id AS fm_id,
  fm.settlement_amount,
  sr.id AS sr_id,
  sr.raw_data->>'SOURCE_ID' AS source_id,
  fle.le_id,
  fle.balance_impact,
  COALESCE(sc.sr_count, 0) AS sr_count_per_fm,
  COALESCE(lc.le_count, 0) AS le_count_per_fm,
  CASE
    WHEN COALESCE(sc.sr_count, 0) > 1 THEN 'MULTI_SR_SAME_FM'
    WHEN COALESCE(lc.le_count, 0) > 1 THEN 'MULTI_LE_SAME_FM'
    WHEN ABS(fm.settlement_amount - COALESCE(fle.balance_impact, 0)) > 0.01 THEN 'FM_LE_MISMATCH'
    ELSE 'OK'
  END AS collapse_type
FROM fm_with_june_le fjl
INNER JOIN mp_financial_movement fm ON fm.id = fjl.id
INNER JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
INNER JOIN mp_source_record sr ON msl.source_record_id = sr.id
LEFT JOIN sr_counts_per_fm sc ON fm.id = sc.fm_id
LEFT JOIN le_counts_per_fm lc ON fm.id = lc.fm_id
INNER JOIN fm_le_details fle ON fm.id = fle.fm_id
WHERE sr.source_type = 'report'
  AND (COALESCE(sc.sr_count, 0) > 1
    OR COALESCE(lc.le_count, 0) > 1
    OR ABS(fm.settlement_amount - COALESCE(fle.balance_impact, 0)) > 0.01)
ORDER BY fm.id, sr.id;

-- Check SR3903 and SR3909 by payload_hash
SELECT
  'KNOWN_SR_CHECK' AS finding,
  CASE
    WHEN sr.payload_hash = '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50' THEN 'SR3903 (+1629.44)'
    WHEN sr.payload_hash = 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f' THEN 'SR3909 (+463.84)'
    ELSE 'UNKNOWN'
  END AS sr_description,
  sr.id AS sr_id,
  sr.payload_hash,
  fm.id AS fm_id,
  fm.settlement_amount,
  le.id AS le_id,
  le.balance_impact,
  STRING_AGG(DISTINCT sr2.id::TEXT, ',') AS other_sr_same_fm
FROM mp_source_record sr
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
LEFT JOIN mp_movement_source_link msl2 ON fm.id = msl2.financial_movement_id
LEFT JOIN mp_source_record sr2 ON msl2.source_record_id = sr2.id AND sr2.id != sr.id
WHERE sr.payload_hash IN ('00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50', 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f')
GROUP BY sr.id, sr.payload_hash, fm.id, fm.settlement_amount, le.id, le.balance_impact;
