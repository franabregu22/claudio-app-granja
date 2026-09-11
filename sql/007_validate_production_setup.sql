-- VALIDACIÓN POST-INSTALACIÓN RPC PRODUCTIVA (UN SOLO RESULT SET)
-- READ-ONLY: Solo una SELECT con subqueries escalares
-- Ejecutar DESPUÉS de 006_import_liberaciones_primary_PRODUCTION.sql

SELECT
  COALESCE(
    (SELECT pg_get_function_identity_arguments(oid)
     FROM pg_proc WHERE proname = 'calc_liberaciones_economic_hash'),
    'NO ENCONTRADA'
  ) as calc_liberaciones_signature,

  COALESCE(
    (SELECT pg_get_function_identity_arguments(oid)
     FROM pg_proc WHERE proname = 'import_liberaciones_primary'),
    'NO ENCONTRADA'
  ) as import_liberaciones_signature,

  (SELECT COUNT(*) FROM mp_financial_movement) as fm_total,

  (SELECT COUNT(*) FROM ledger_entry) as le_total,

  (SELECT COUNT(*) FROM mp_financial_movement WHERE needs_review = TRUE) as needs_review_total,

  (SELECT COALESCE(SUM(balance_impact), 0)::NUMERIC(15,2)
   FROM ledger_entry
   WHERE account_id = 1054315166
     AND occurred_at >= '2026-08-01'::timestamp
     AND occurred_at < '2026-09-01'::timestamp
  ) as ledger_agosto,

  (SELECT COUNT(*) FROM mp_source_record WHERE source_type = 'liberaciones') as liberaciones_sr,

  (SELECT COUNT(*)
   FROM mp_movement_source_link
   WHERE source_record_id IN (
     SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
   )
  ) as liberaciones_links,

  (SELECT COUNT(DISTINCT fm.id)
   FROM mp_financial_movement fm
   WHERE fm.id IN (
     SELECT l.financial_movement_id
     FROM mp_movement_source_link l
     WHERE l.source_record_id IN (
       SELECT id FROM mp_source_record WHERE source_type = 'liberaciones'
     )
   )
  ) as liberaciones_fm;
