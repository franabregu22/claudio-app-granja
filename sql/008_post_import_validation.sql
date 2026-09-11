-- POST-IMPORT VALIDATION (READ-ONLY)
-- Ejecutar después de completar importación

SELECT
  (SELECT COUNT(*) FROM mp_financial_movement) as fm_total,
  (SELECT COUNT(*) FROM ledger_entry) as le_total,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE needs_review = TRUE) as needs_review_total,
  (SELECT COUNT(*) FROM mp_source_record WHERE source_type = 'liberaciones') as liberaciones_sr,
  (SELECT COUNT(*) FROM mp_movement_source_link l WHERE l.source_record_id IN (SELECT id FROM mp_source_record WHERE source_type = 'liberaciones')) as liberaciones_links,
  (SELECT COUNT(DISTINCT fm.id) FROM mp_financial_movement fm WHERE fm.id IN (SELECT l.financial_movement_id FROM mp_movement_source_link l WHERE l.source_record_id IN (SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'))) as liberaciones_fm,
  (SELECT COALESCE(SUM(balance_impact), 0)::NUMERIC(15,2) FROM ledger_entry WHERE account_id = 1054315166 AND occurred_at >= '2026-08-01'::timestamp AND occurred_at < '2026-09-01'::timestamp) as ledger_agosto;
