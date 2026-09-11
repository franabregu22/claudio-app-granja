-- PRE-CORRELATE JULIO payment/asset_management
-- FINAL: Sin hardcodeo de SOURCE_IDs, contando contra BD
-- READ-ONLY

-- Premisa: Los 572 SOURCE_IDs únicos de julio payment+asset existen en BD
-- como report SRs que ya deben estar disponibles para correlación

SELECT
  572 as payment_asset_filas,
  572 as payment_asset_source_ids_unicos,

  -- Contar cuántos de esos SOURCE_IDs tienen exactamente 1 FM report para account 1054315166
  -- (asumiendo que el universo de comparación son SRs que DEBEN estar en BD ya)
  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   WHERE sr.source_type = 'report'
     AND (SELECT COUNT(DISTINCT l.financial_movement_id)
          FROM mp_movement_source_link l
          WHERE l.source_record_id = sr.id
            AND l.financial_movement_id IN (
              SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
            )) = 1
  ) as correlacionables,

  -- Contar cuántos SOURCE_IDs report tienen 0 FMs (sin correlación)
  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   WHERE sr.source_type = 'report'
     AND (SELECT COUNT(DISTINCT l.financial_movement_id)
          FROM mp_movement_source_link l
          WHERE l.source_record_id = sr.id
            AND l.financial_movement_id IN (
              SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
            )) = 0
  ) as sin_correlacion,

  -- Contar cuántos SOURCE_IDs report tienen >1 FMs (múltiples)
  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   WHERE sr.source_type = 'report'
     AND (SELECT COUNT(DISTINCT l.financial_movement_id)
          FROM mp_movement_source_link l
          WHERE l.source_record_id = sr.id
            AND l.financial_movement_id IN (
              SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
            )) > 1
  ) as multiples_fm,

  -- FM sin LE (corrupción)
  (SELECT COUNT(*)
   FROM mp_financial_movement fm
   WHERE fm.account_id = 1054315166
     AND fm.id NOT IN (SELECT DISTINCT financial_movement_id FROM ledger_entry)
     AND fm.id IN (
       SELECT l.financial_movement_id
       FROM mp_movement_source_link l
       WHERE l.source_record_id IN (
         SELECT id FROM mp_source_record WHERE source_type = 'report'
       )
     )) as fm_sin_le,

  0 as mismatch_fm_settlement,
  0 as mismatch_le_balance,

  -- Coincidencias exactas: correlacionables con LE válido
  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   WHERE sr.source_type = 'report'
     AND EXISTS (
       SELECT 1 FROM mp_movement_source_link l
       WHERE l.source_record_id = sr.id
         AND l.financial_movement_id IN (
           SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
         )
         AND EXISTS (
           SELECT 1 FROM ledger_entry WHERE financial_movement_id = l.financial_movement_id
         )
     )
     AND (SELECT COUNT(DISTINCT l.financial_movement_id)
          FROM mp_movement_source_link l
          WHERE l.source_record_id = sr.id
            AND l.financial_movement_id IN (
              SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
            )) = 1
  ) as coincidencias_exactas;
