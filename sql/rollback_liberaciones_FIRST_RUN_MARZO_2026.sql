-- ============================================================================
-- ROLLBACK: LIBERACIONES MAR 2026 IMPORT
-- File: rollback_liberaciones_FIRST_RUN_MARZO_2026.sql
-- Status: READ-WRITE (DELETE only, idempotent)
-- Purpose: Rollback MAR import if needed
-- DO NOT EXECUTE unless explicitly requested
-- ============================================================================

BEGIN;

-- Delete ledger entries created in MAR import (15 rows)
-- ledger_entry_ids: 4172-4186
DELETE FROM ledger_entry
WHERE id IN (4172, 4173, 4174, 4175, 4176, 4177, 4178, 4179, 4180, 4181, 4182, 4183, 4184, 4185, 4186);

-- Delete financial movements created in MAR import (15 rows)
-- financial_movement_ids: 4231-4245
DELETE FROM mp_financial_movement
WHERE id IN (4231, 4232, 4233, 4234, 4235, 4236, 4237, 4238, 4239, 4240, 4241, 4242, 4243, 4244, 4245);

-- Delete movement source links created in MAR import (648 rows)
-- link_ids: 5972-6619
DELETE FROM mp_movement_source_link
WHERE id >= 5972 AND id <= 6619;

-- Delete source records created in MAR import (692 rows)
-- source_record_ids: 8352-9043
DELETE FROM mp_source_record
WHERE id >= 8352 AND id <= 9043;

COMMIT;

-- ============================================================================
-- VALIDATION AFTER ROLLBACK
-- ============================================================================

SELECT
  'MAR ROLLBACK VALIDATION' as check_type,
  (SELECT COUNT(*) FROM ledger_entry WHERE id BETWEEN 4172 AND 4186) as ledger_entries_remaining,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE id BETWEEN 4231 AND 4245) as fm_remaining,
  (SELECT COUNT(*) FROM mp_movement_source_link WHERE id BETWEEN 5972 AND 6619) as links_remaining,
  (SELECT COUNT(*) FROM mp_source_record WHERE id BETWEEN 8352 AND 9043) as sr_remaining;
