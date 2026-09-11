-- ============================================================================
-- COLLAPSE DETECTION: Batch monto vs DB LE
-- Compare SETTLEMENT_NET_AMOUNT (from batch) vs LE.balance_impact (from DB)
-- Only this comparison detects collapses where FM/LE coincide but differ from batch
-- ============================================================================

-- Create temp table with batch data (682 Report rows)
-- Then join to DB to compare monto_batch vs LE.balance_impact
WITH batch_data AS (
  SELECT * FROM (VALUES
    -- SR3902 replica
    ('0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c'::TEXT, '123456789'::TEXT, 471.71::NUMERIC),
    -- SR3903 replica
    ('00507eae3761e2185c7a63a9fd3cb888b9a5070870d188cb23c8a4363e164c50'::TEXT, '123456790'::TEXT, 1629.44::NUMERIC),
    -- SR3908 replica
    ('c404fc99c6028e8caa261229fa822bb96909555480bd432905bbd3c91858a9ce'::TEXT, '123456791'::TEXT, 1854.71::NUMERIC),
    -- SR3909 replica
    ('e5b8b5db527ffa015df5a6ec85268ec86dadaa613c3bbbcadb07fb63b912390f'::TEXT, '123456792'::TEXT, 463.84::NUMERIC)
  ) AS t(payload_hash, source_id_example, monto_batch)
)
SELECT
  'KNOWN_TEST_CASES' AS type,
  sr.id AS sr_id,
  bd.source_id_example AS source_id_batch,
  sr.raw_data->>'SOURCE_ID' AS source_id_actual,
  fm.id AS fm_id,
  fm.settlement_amount,
  le.id AS le_id,
  le.balance_impact AS monto_le,
  bd.monto_batch,
  ABS(bd.monto_batch - le.balance_impact) AS discrepancia
FROM batch_data bd
INNER JOIN mp_source_record sr ON sr.payload_hash = bd.payload_hash
INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
WHERE sr.source_type = 'report'
  AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
  AND ABS(bd.monto_batch - le.balance_impact) > 0.01
ORDER BY sr.id;

-- ============================================================================
-- Now scan ALL 682 Report SR to find collapses
-- Generate payload_hash values from actual DB and compare against batch
-- ============================================================================
-- NOTE: This requires all 682 payload_hashes from batch
-- Below is a placeholder for the full list
-- To get full results, you need to provide all 682 hashes

WITH all_report_sr AS (
  SELECT
    sr.id,
    sr.payload_hash,
    sr.raw_data->>'SOURCE_ID' AS source_id,
    fm.id AS fm_id,
    fm.settlement_amount,
    le.id AS le_id,
    le.balance_impact
  FROM mp_source_record sr
  INNER JOIN mp_movement_source_link msl ON sr.id = msl.source_record_id
  INNER JOIN mp_financial_movement fm ON msl.financial_movement_id = fm.id
  INNER JOIN ledger_entry le ON fm.id = le.financial_movement_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  WHERE sr.source_type = 'report'
    AND (fm.account_id = 1054315166 OR fm.account_id IS NULL)
)
-- Without batch reference values, we can only detect where multiple SR share same FM
-- This catches the collapse symptom but not the root cause
SELECT
  'ALL_REPORT_SR_SUSPECT' AS type,
  rs1.id AS sr_id,
  rs1.source_id,
  rs1.fm_id,
  rs1.settlement_amount,
  rs1.le_id,
  rs1.balance_impact,
  STRING_AGG(DISTINCT rs2.id::TEXT, ',') AS other_sr_same_fm
FROM all_report_sr rs1
LEFT JOIN all_report_sr rs2 ON rs1.fm_id = rs2.fm_id AND rs1.id != rs2.id
GROUP BY rs1.id, rs1.source_id, rs1.fm_id, rs1.settlement_amount, rs1.le_id, rs1.balance_impact
HAVING STRING_AGG(DISTINCT rs2.id::TEXT, ',') IS NOT NULL
ORDER BY rs1.fm_id, rs1.id;
