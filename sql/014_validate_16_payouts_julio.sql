-- VALIDAR 16 PAYOUTS CREADOS EN FIRST_RUN_JULIO
-- READ-ONLY: Confirmar que los 16 FM/LE nuevos son payouts con montos correctos
-- FM IDs: 4208-4223 (16 total)
-- LE IDs: 4149-4164 (16 total)

WITH fm_16_new AS (
  -- Los 16 FM creados por FIRST_RUN_JULIO
  SELECT
    fm.id,
    fm.movement_class,
    fm.transaction_date,
    fm.settlement_amount,
    fm.needs_review,
    STRING_AGG(DISTINCT sr.source_external_id, ', ' ORDER BY sr.source_external_id) as source_ids,
    STRING_AGG(DISTINCT sr.source_type, ', ' ORDER BY sr.source_type) as source_types
  FROM mp_financial_movement fm
  WHERE fm.id BETWEEN 4208 AND 4223
  LEFT JOIN mp_movement_source_link l ON l.financial_movement_id = fm.id
  LEFT JOIN mp_source_record sr ON sr.id = l.source_record_id
  GROUP BY fm.id, fm.movement_class, fm.transaction_date, fm.settlement_amount, fm.needs_review
)

SELECT
  (SELECT COUNT(*) FROM fm_16_new) as cantidad_fm_16,
  (SELECT COALESCE(SUM(settlement_amount), 0)::NUMERIC(15,2)
   FROM fm_16_new) as neto_settlement_amount,
  (SELECT COALESCE(SUM(le.balance_impact), 0)::NUMERIC(15,2)
   FROM ledger_entry le
   WHERE le.id BETWEEN 4149 AND 4164) as neto_ledger_entries,
  (SELECT COUNT(DISTINCT movement_class)
   FROM fm_16_new) as distinct_movement_classes,
  (SELECT STRING_AGG(DISTINCT movement_class, ', ' ORDER BY movement_class)
   FROM fm_16_new) as movement_classes_list,
  -- Bonus: verificar que TODOS son payout
  (SELECT COUNT(*)
   FROM fm_16_new
   WHERE movement_class = 'payout') as count_payout_class,
  -- Bonus: verificar source_types
  (SELECT STRING_AGG(DISTINCT source_types, ' | ')
   FROM fm_16_new) as all_source_types;
