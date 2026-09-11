-- ============================================================================
-- DEBUG: Layer 1 search for Report SR
-- Test with 4 known Report rows (SR 3902, 3903, 3908, 3909)
-- ============================================================================

-- Test data: 4 known payloads from Report
WITH known_hashes AS (
  SELECT
    '0d4ae5fcceaf937640f9c219483ea24a95e8b25794c4196cdfe6eccd3e73989c'::TEXT AS payload_hash,
    3902 AS expected_sr_id
  UNION ALL
  SELECT '882c1ea31e0bfebcc1f7f1e9cc34fea02e0b51da8d2cde92399e1a40f24b39e6'::TEXT, 3903
  UNION ALL
  SELECT 'a8ec2c3f01e6b4cf5d43835c6c1f39a50c6a8adb373fce8f4e1e3fa4e7b8c3d0'::TEXT, 3908
  UNION ALL
  SELECT '5c9f3e4a2b1d6e7f8c9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d'::TEXT, 3909
)
SELECT
  kh.expected_sr_id,
  kh.payload_hash,
  -- Attempt Layer 1 search exactly as function does it
  (SELECT msr.id FROM mp_source_record msr
   WHERE msr.source_type = 'report'
     AND msr.payload_hash = kh.payload_hash
     AND msr.account_id = 1054315166
   LIMIT 1) AS found_sr_id,
  -- Also try without account_id filter to see if SR exists at all
  (SELECT msr.id FROM mp_source_record msr
   WHERE msr.source_type = 'report'
     AND msr.payload_hash = kh.payload_hash
   LIMIT 1) AS found_sr_id_anywhere,
  -- Check if SR exists but with different account_id
  (SELECT DISTINCT msr.account_id FROM mp_source_record msr
   WHERE msr.source_type = 'report'
     AND msr.payload_hash = kh.payload_hash
   LIMIT 1) AS actual_account_id
FROM known_hashes kh
ORDER BY kh.expected_sr_id;

-- ============================================================================
-- Check: Do these SR exist in the DB at all?
-- ============================================================================

SELECT
  id,
  source_type,
  payload_hash,
  account_id
FROM mp_source_record
WHERE id IN (3902, 3903, 3908, 3909)
ORDER BY id;

-- ============================================================================
-- Check: Sample of Report SR in DB (account 1054315166)
-- ============================================================================

SELECT
  id,
  source_type,
  payload_hash,
  account_id
FROM mp_source_record
WHERE source_type = 'report'
  AND account_id = 1054315166
LIMIT 10;
