-- PRE-CORRELATE JULIO payment/asset_management
-- UN SOLO RESULT SET con 9 columnas
-- READ-ONLY: sin escritura, sin RPC

SELECT
  572 as payment_asset_filas,

  572 as payment_asset_source_ids_unicos,

  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   WHERE sr.source_type = 'report'
     AND EXISTS (
       SELECT 1 FROM mp_movement_source_link l
       WHERE l.source_record_id = sr.id
         AND l.financial_movement_id IN (
           SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
         )
     )
  ) as correlacionables,

  (572 - (SELECT COUNT(DISTINCT sr.source_external_id)
           FROM mp_source_record sr
           WHERE sr.source_type = 'report'
             AND EXISTS (
               SELECT 1 FROM mp_movement_source_link l
               WHERE l.source_record_id = sr.id
                 AND l.financial_movement_id IN (
                   SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
                 )
             ))) as sin_correlacion,

  (SELECT COUNT(*)
   FROM (
     SELECT sr.source_external_id, COUNT(DISTINCT l.financial_movement_id) as fm_count
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
  ) as multiples_fm,

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
     )
  ) as fm_sin_le,

  (SELECT COUNT(*)
   FROM (
     SELECT sr.source_external_id, fm.settlement_amount
     FROM mp_source_record sr
     JOIN mp_movement_source_link l ON l.source_record_id = sr.id
     JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
     WHERE sr.source_type = 'report'
       AND fm.account_id = 1054315166
   ) t1
   WHERE t1.source_external_id NOT IN ('dummy')
     AND ABS(CAST(t1.settlement_amount AS NUMERIC) - t1.settlement_amount) > 0.01
  ) as mismatch_fm_settlement,

  (SELECT COUNT(*)
   FROM (
     SELECT sr.source_external_id, le.balance_impact, fm.settlement_amount
     FROM mp_source_record sr
     JOIN mp_movement_source_link l ON l.source_record_id = sr.id
     JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
     JOIN ledger_entry le ON le.financial_movement_id = fm.id
     WHERE sr.source_type = 'report'
       AND fm.account_id = 1054315166
       AND ABS(CAST(le.balance_impact AS NUMERIC) - CAST(fm.settlement_amount AS NUMERIC)) > 0.01
   ) t2
  ) as mismatch_le_balance,

  (SELECT COUNT(DISTINCT sr.source_external_id)
   FROM mp_source_record sr
   JOIN mp_movement_source_link l ON l.source_record_id = sr.id
   JOIN mp_financial_movement fm ON fm.id = l.financial_movement_id
   JOIN ledger_entry le ON le.financial_movement_id = fm.id
   WHERE sr.source_type = 'report'
     AND fm.account_id = 1054315166
     AND ABS(CAST(le.balance_impact AS NUMERIC) - CAST(fm.settlement_amount AS NUMERIC)) < 0.01
  ) as coincidencias_exactas;
