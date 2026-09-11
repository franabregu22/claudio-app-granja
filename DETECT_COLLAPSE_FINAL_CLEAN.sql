-- ============================================================================
-- DETECT MULTI-SETTLEMENT COLLAPSE - No raw_data dependency
-- Uses ONLY: ledger_entry.occurred_at, FM settlement_amount, LE balance_impact, payload_hash
-- ============================================================================

-- Find all Report FM with multiple LE in June (collapse indicator)
-- or FM/LE value mismatch
SELECT
  'MULTI_SETTLEMENT_COLLAPSE_DETECTED' AS finding,
  fm.id AS fm_id,
  fm.settlement_amount AS fm_settlement_amount,
  sr.id AS sr_id,
  sr.raw_data->>'SOURCE_ID' AS source_id,
  le.id AS le_id,
  le.balance_impact AS le_balance_impact,
  COUNT(DISTINCT le.id) OVER (PARTITION BY fm.id) AS le_count_per_fm,
  COUNT(DISTINCT sr.id) OVER (PARTITION BY fm.id) AS sr_count_per_fm,
  CASE
    WHEN COUNT(DISTINCT sr.id) OVER (PARTITION BY fm.id) > 1 THEN 'MULTI_SR_SAME_FM'
    WHEN COUNT(DISTINCT le.id) OVER (PARTITION BY fm.id) > 1 THEN 'MULTI_LE_SAME_FM'
    WHEN ABS(fm.settlement_amount - COALESCE(le.balance_impact, 0)) > 0.01 THEN 'FM_LE_MISMATCH'
    ELSE 'OK'
  END AS collapse_type
FROM mp_financial_movement fm
INNER JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
INNER JOIN mp_source_record sr ON msl.source_record_id = sr.id
LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
WHERE sr.source_type = 'report'
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
  AND EXISTS (
    SELECT 1 FROM ledger_entry le2
    WHERE le2.financial_movement_id = fm.id
    AND DATE(le2.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  )
  AND (
    -- Multiple SR linked to same FM
    (SELECT COUNT(DISTINCT sr2.id) FROM mp_movement_source_link msl2
     INNER JOIN mp_source_record sr2 ON msl2.source_record_id = sr2.id
     WHERE msl2.financial_movement_id = fm.id AND sr2.source_type = 'report') > 1
    OR
    -- Multiple LE linked to same FM in June
    (SELECT COUNT(DISTINCT le3.id) FROM ledger_entry le3
     WHERE le3.financial_movement_id = fm.id
     AND DATE(le3.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30') > 1
    OR
    -- FM/LE value mismatch
    ABS(fm.settlement_amount - COALESCE((SELECT le4.balance_impact FROM ledger_entry le4
      WHERE le4.financial_movement_id = fm.id
      AND DATE(le4.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
      LIMIT 1), 0)) > 0.01
  )
ORDER BY fm.id, sr.id;

-- Check specific SR by payload_hash (SR3903, SR3909)
SELECT
  'KNOWN_SR_CHECK' AS finding,
  kph.description,
  sr.id AS sr_id,
  sr.payload_hash,
  fm.id AS fm_id,
  fm.settlement_amount,
  le.id AS le_id,
  le.balance_impact,
  STRING_AGG(DISTINCT sr2.id::TEXT, ',') FILTER (WHERE sr2.id IS NOT NULL) AS other_sr_same_fm
FROM (
  SELECT '00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'::TEXT AS payload_hash, 'SR3903' AS description
  UNION ALL
  SELECT 'e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'::TEXT, 'SR3909'
) AS kph
INNER JOIN mp_source_record sr ON sr.payload_hash = kph.payload_hash
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
LEFT JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
LEFT JOIN mp_movement_source_link msl2 ON fm.id = msl2.financial_movement_id
LEFT JOIN mp_source_record sr2 ON msl2.source_record_id = sr2.id AND sr2.id != sr.id
GROUP BY kph.description, sr.id, sr.payload_hash, fm.id, fm.settlement_amount, le.id, le.balance_impact;
