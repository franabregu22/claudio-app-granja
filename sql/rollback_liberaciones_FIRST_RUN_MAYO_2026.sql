-- ============================================================================
-- ROLLBACK: LIBERACIONES MAY 2026 IMPORT
-- File: rollback_liberaciones_FIRST_RUN_MAYO_2026.sql
-- Status: READ-WRITE (DELETE only, idempotent)
-- Purpose: Rollback MAY import if needed
-- DO NOT EXECUTE unless explicitly requested
-- ============================================================================

BEGIN;

-- Delete ledger entries created in MAY import (9 rows)
-- ledger_entry_ids: [4213, 4214, 4215, 4216, 4217, 4218, 4219, 4220, 4221]
DELETE FROM ledger_entry WHERE id IN (4213, 4214, 4215, 4216, 4217, 4218, 4219, 4220, 4221);

-- Delete movement source links created in MAY import (616 rows)
-- link_ids: 7895-8510
DELETE FROM mp_movement_source_link WHERE id BETWEEN 7895 AND 8510;

-- Delete financial movements created in MAY import (9 rows)
-- financial_movement_ids: [4272, 4273, 4274, 4275, 4276, 4277, 4278, 4279, 4280]
DELETE FROM mp_financial_movement WHERE id IN (4272, 4273, 4274, 4275, 4276, 4277, 4278, 4279, 4280);

-- Delete source records created in MAY import (652 rows)
-- source_record_ids: 10402-11053
DELETE FROM mp_source_record WHERE id BETWEEN 10402 AND 11053;

COMMIT;

-- ============================================================================
-- VALIDATION AFTER ROLLBACK
-- ============================================================================

SELECT
  'MAY ROLLBACK VALIDATION' as check_type,
  (SELECT COUNT(*) FROM ledger_entry WHERE id IN (4213, 4214, 4215, 4216, 4217, 4218, 4219, 4220, 4221)) as ledger_entries_remaining,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE id IN (4272, 4273, 4274, 4275, 4276, 4277, 4278, 4279, 4280)) as fm_remaining,
  (SELECT COUNT(*) FROM mp_movement_source_link WHERE id BETWEEN 7895 AND 8510) as links_remaining,
  (SELECT COUNT(*) FROM mp_source_record WHERE id BETWEEN 10402 AND 11053) as sr_remaining;