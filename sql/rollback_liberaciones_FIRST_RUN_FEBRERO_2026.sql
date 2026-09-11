-- ============================================================================
-- ROLLBACK: LIBERACIONES FEB 2026 IMPORT
-- File: rollback_liberaciones_FIRST_RUN_FEBRERO_2026.sql
-- Status: READ-WRITE (DELETE only, idempotent)
-- Purpose: Rollback FEB import if needed
-- DO NOT EXECUTE unless explicitly requested
-- ============================================================================

BEGIN;

-- Delete ledger entries created in FEB import (7 rows)
-- ledger_entry_ids: 4165-4171
DELETE FROM ledger_entry
WHERE id IN (4165, 4166, 4167, 4168, 4169, 4170, 4171);

-- Delete financial movements created in FEB import (7 rows)
-- financial_movement_ids: 4224-4230
DELETE FROM mp_financial_movement
WHERE id IN (4224, 4225, 4226, 4227, 4228, 4229, 4230);

-- Delete movement source links created in FEB import (449 rows)
-- link_ids: 5523-5970
DELETE FROM mp_movement_source_link
WHERE id >= 5523 AND id <= 5970;

-- Delete source records created in FEB import (475 rows)
-- source_record_ids: 7877-8351
DELETE FROM mp_source_record
WHERE id >= 7877 AND id <= 8351;

COMMIT;

-- ============================================================================
-- VALIDATION AFTER ROLLBACK
-- ============================================================================

SELECT
  'FEB ROLLBACK VALIDATION' as check_type,
  (SELECT COUNT(*) FROM ledger_entry WHERE id BETWEEN 4165 AND 4171) as ledger_entries_remaining,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE id BETWEEN 4224 AND 4230) as fm_remaining,
  (SELECT COUNT(*) FROM mp_movement_source_link WHERE id BETWEEN 5523 AND 5970) as links_remaining,
  (SELECT COUNT(*) FROM mp_source_record WHERE id BETWEEN 7877 AND 8351) as sr_remaining;
