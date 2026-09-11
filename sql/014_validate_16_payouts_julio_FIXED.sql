-- VALIDAR 16 PAYOUTS CREADOS EN FIRST_RUN_JULIO
-- READ-ONLY: Confirmar que los 16 FM/LE nuevos son payouts con montos correctos

SELECT
  (SELECT COUNT(*)
   FROM mp_financial_movement
   WHERE id BETWEEN 4208 AND 4223) as cantidad_fm_16,

  (SELECT COALESCE(SUM(settlement_amount), 0)::NUMERIC(15,2)
   FROM mp_financial_movement
   WHERE id BETWEEN 4208 AND 4223) as neto_settlement_amount,

  (SELECT COALESCE(SUM(balance_impact), 0)::NUMERIC(15,2)
   FROM ledger_entry
   WHERE id BETWEEN 4149 AND 4164) as neto_ledger_entries,

  (SELECT COUNT(DISTINCT movement_class)
   FROM mp_financial_movement
   WHERE id BETWEEN 4208 AND 4223) as distinct_movement_classes,

  (SELECT STRING_AGG(DISTINCT movement_class, ', ' ORDER BY movement_class)
   FROM mp_financial_movement
   WHERE id BETWEEN 4208 AND 4223) as movement_classes_list,

  (SELECT COUNT(*)
   FROM mp_financial_movement
   WHERE id BETWEEN 4208 AND 4223
     AND movement_class = 'payout') as count_payout_class,

  (SELECT COUNT(DISTINCT sr.source_type)
   FROM mp_source_record sr
   WHERE sr.id IN (
     SELECT l.source_record_id
     FROM mp_movement_source_link l
     WHERE l.financial_movement_id BETWEEN 4208 AND 4223
   )) as distinct_source_types,

  (SELECT STRING_AGG(DISTINCT sr.source_type, ', ' ORDER BY sr.source_type)
   FROM mp_source_record sr
   WHERE sr.id IN (
     SELECT l.source_record_id
     FROM mp_movement_source_link l
     WHERE l.financial_movement_id BETWEEN 4208 AND 4223
   )) as source_types_list;
