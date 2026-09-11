-- POST-IMPORT JULIO VALIDATION
-- READ-ONLY: Verificar estado de BD DESPUÉS del primer import de julio
-- Retorna 9 valores para validar contra esperados

SELECT
  (SELECT COUNT(*) FROM mp_financial_movement) as fm_total_post,

  (SELECT COUNT(*) FROM ledger_entry) as le_total_post,

  (SELECT COUNT(*) FROM mp_financial_movement WHERE needs_review = TRUE) as needs_review_total_post,

  (SELECT COUNT(*)
   FROM mp_source_record
   WHERE source_type = 'liberaciones'
     AND source_external_id LIKE '2026-07%'
  ) as liberaciones_source_julio,

  (SELECT COUNT(*) FROM mp_movement_source_link l
   WHERE EXISTS (SELECT 1 FROM mp_source_record sr
                 WHERE sr.id = l.source_record_id
                   AND sr.source_type = 'liberaciones'
                   AND sr.source_external_id LIKE '2026-07%'
   )) as liberaciones_links_julio,

  (SELECT COUNT(DISTINCT fm.id)
   FROM mp_financial_movement fm
   WHERE fm.id IN (
     SELECT l.financial_movement_id
     FROM mp_movement_source_link l
     WHERE l.source_record_id IN (
       SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
         AND source_external_id LIKE '2026-07%'
     )
   )) as liberaciones_fm_julio,

  (SELECT COUNT(*)
   FROM mp_source_record
   WHERE source_type = 'liberaciones'
     AND source_external_id LIKE '%payout%'
  ) as payouts_julio,

  (SELECT COALESCE(SUM(balance_impact), 0)::NUMERIC(15,2)
   FROM ledger_entry
   WHERE account_id = 1054315166
     AND occurred_at >= '2026-07-01'::timestamp
     AND occurred_at < '2026-08-01'::timestamp
  ) as ledger_julio_post;
