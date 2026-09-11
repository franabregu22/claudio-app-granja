-- PRE-CORRELATE JULIO payment/asset_management
-- READ-ONLY: identifica payment/asset que correlacionarían vs sin correlación
-- Ejecutar en Supabase SQL Editor

-- Query 1: Contar payment/asset del CSV que ya tienen report FM correlacionado
-- Los SOURCE_IDs únicos de payment/asset de julio son: 554 + 18 = 572

SELECT
  'JULIO PRE-CORRELACIÓN' as test,

  -- Total definitive-only records that WOULD need correlation
  572 as payment_asset_filas_julio,

  -- Count how many of those SOURCE_IDs have existing report FMs for this account
  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   WHERE sr.source_type = 'report'
     AND sr.id IN (
       SELECT DISTINCT l.source_record_id
       FROM mp_movement_source_link l
       WHERE l.financial_movement_id IN (
         SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
       )
     )
  ) as report_source_ids_existing,

  -- For each report SOURCE_ID, count how many FMs exist
  (SELECT COUNT(*)
   FROM (
     SELECT DISTINCT sr.source_external_id, COUNT(DISTINCT l.financial_movement_id) as fm_count
     FROM mp_source_record sr
     JOIN mp_movement_source_link l ON l.source_record_id = sr.id
     WHERE sr.source_type = 'report'
       AND sr.id IN (
         SELECT DISTINCT l2.source_record_id
         FROM mp_movement_source_link l2
         WHERE l2.financial_movement_id IN (
           SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
         )
       )
     GROUP BY sr.source_external_id
     HAVING COUNT(DISTINCT l.financial_movement_id) > 1
   ) t
  ) as report_source_with_multiple_fms;

-- Query 2: Verify all report FMs have corresponding LE (1:1 check)
SELECT
  'FM sin LE check' as test,
  COUNT(*) as report_fm_without_le
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND fm.id NOT IN (
    SELECT DISTINCT financial_movement_id FROM ledger_entry
  )
  AND fm.id IN (
    SELECT l.financial_movement_id
    FROM mp_movement_source_link l
    WHERE l.source_record_id IN (
      SELECT id FROM mp_source_record WHERE source_type = 'report'
    )
  );

-- Query 3: List all report SOURCE_IDs that could potentially correlate with JULIO
-- (this is for manual inspection if needed)
SELECT
  sr.source_external_id,
  COUNT(DISTINCT l.financial_movement_id) as fm_count,
  ARRAY_AGG(DISTINCT fm.settlement_amount) as settlement_amounts,
  ARRAY_AGG(DISTINCT le.balance_impact) as balance_impacts
FROM mp_source_record sr
JOIN mp_movement_source_link l ON l.source_record_id = sr.id
JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
LEFT JOIN ledger_entry le ON le.financial_movement_id = fm.id
WHERE sr.source_type = 'report'
  AND fm.account_id = 1054315166
ORDER BY sr.source_external_id
LIMIT 50;
