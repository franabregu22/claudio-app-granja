-- ============================================================================
-- ROLLBACK: LIBERACIONES APR 2026 IMPORT
-- File: rollback_liberaciones_FIRST_RUN_ABRIL_2026.sql
-- Status: READ-WRITE (DELETE only, idempotent)
-- Purpose: Rollback APR import if needed
-- DO NOT EXECUTE unless explicitly requested
-- ============================================================================

BEGIN;

-- Delete ledger entries created in APR import (12 rows)
-- ledger_entry_ids: 4187-4198
DELETE FROM ledger_entry
WHERE id IN (4187, 4188, 4189, 4190, 4191, 4192, 4193, 4194, 4195, 4196, 4197, 4198);

-- Delete financial movements created in APR import (12 rows)
-- financial_movement_ids: 4246-4257
DELETE FROM mp_financial_movement
WHERE id IN (4246, 4247, 4248, 4249, 4250, 4251, 4252, 4253, 4254, 4255, 4256, 4257);

-- Delete movement source links created in APR import (442 rows)
-- link_ids: 6620-7061
DELETE FROM mp_movement_source_link
WHERE id >= 6620 AND id <= 7061;

-- Delete source records created in APR import (476 rows)
-- source_record_ids: 9044-9519
DELETE FROM mp_source_record
WHERE id >= 9044 AND id <= 9519;

COMMIT;

-- ============================================================================
-- VALIDATION AFTER ROLLBACK
-- ============================================================================

SELECT
  'APR ROLLBACK VALIDATION' as check_type,
  (SELECT COUNT(*) FROM ledger_entry WHERE id BETWEEN 4187 AND 4198) as ledger_entries_remaining,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE id BETWEEN 4246 AND 4257) as fm_remaining,
  (SELECT COUNT(*) FROM mp_movement_source_link WHERE id BETWEEN 6620 AND 7061) as links_remaining,
  (SELECT COUNT(*) FROM mp_source_record WHERE id BETWEEN 9044 AND 9519) as sr_remaining;
