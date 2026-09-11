-- ROLLBACK: FIRST_RUN_JULIO_2026
-- Restore DB to state BEFORE first Liberaciones julio import
-- Generated from checkpoint: liberaciones_import_result_FIRST_RUN_JULIO_2026.json
-- Timestamp: 2026-09-07T09:37:14
-- Account: 1054315166
--
-- DESTRUYE (en orden):
-- LE: 4149-4164 (16 rows)
-- LINK: 4935-5522 (588 rows)
-- FM: 4208-4223 (16 rows)
-- SR: 6597-7236 (640 rows)
--
-- NO EJECUTAR AUTOMÁTICAMENTE. Solo usar si import falla o se necesita rollback.

BEGIN;

DELETE FROM ledger_entry
WHERE id IN (
  4149, 4150, 4151, 4152, 4153, 4154, 4155, 4156, 4157, 4158,
  4159, 4160, 4161, 4162, 4163, 4164
);

DELETE FROM mp_movement_source_link
WHERE id >= 4935 AND id <= 5522;

DELETE FROM mp_financial_movement
WHERE id IN (
  4208, 4209, 4210, 4211, 4212, 4213, 4214, 4215, 4216, 4217,
  4218, 4219, 4220, 4221, 4222, 4223
);

DELETE FROM mp_source_record
WHERE id >= 6597 AND id <= 7236;

COMMIT;
