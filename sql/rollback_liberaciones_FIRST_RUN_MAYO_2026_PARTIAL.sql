-- ============================================================================
-- ROLLBACK: LIBERACIONES MAY 2026 PARTIAL IMPORT (Batches 1-8 only)
-- File: rollback_liberaciones_FIRST_RUN_MAYO_2026_PARTIAL.sql
-- Status: READ-WRITE (DELETE only, idempotent)
-- Purpose: Rollback MAY partial import (failed at batch 9)
-- DO NOT EXECUTE unless explicitly requested
-- ============================================================================

BEGIN;

-- Delete ledger entries created in MAY partial import (13 rows)
-- ledger_entry_ids: [4199, 4200, 4201, 4202, 4203, 4204, 4205, 4206, 4207, 4208, 4209, 4210, 4211]
DELETE FROM ledger_entry WHERE id IN (4199, 4200, 4201, 4202, 4203, 4204, 4205, 4206, 4207, 4208, 4209, 4210, 4211);

-- Delete movement source links created in MAY partial import (756 rows)
-- link_ids: 7062-7817
DELETE FROM mp_movement_source_link WHERE id BETWEEN 7062 AND 7817;

-- Delete financial movements created in MAY partial import (13 rows)
-- financial_movement_ids: [4258, 4259, 4260, 4261, 4262, 4263, 4264, 4265, 4266, 4267, 4268, 4269, 4270]
DELETE FROM mp_financial_movement WHERE id IN (4258, 4259, 4260, 4261, 4262, 4263, 4264, 4265, 4266, 4267, 4268, 4269, 4270);

-- Delete source records created in MAY partial import (800 rows)
-- source_record_ids: 9520-10319
DELETE FROM mp_source_record WHERE id BETWEEN 9520 AND 10319;

COMMIT;

-- ============================================================================
-- VALIDATION AFTER ROLLBACK
-- ============================================================================

SELECT
  'MAY PARTIAL ROLLBACK VALIDATION' as check_type,
  (SELECT COUNT(*) FROM ledger_entry WHERE id IN (4199, 4200, 4201, 4202, 4203, 4204, 4205, 4206, 4207, 4208, 4209, 4210, 4211)) as ledger_entries_remaining,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE id IN (4258, 4259, 4260, 4261, 4262, 4263, 4264, 4265, 4266, 4267, 4268, 4269, 4270)) as fm_remaining,
  (SELECT COUNT(*) FROM mp_movement_source_link WHERE id BETWEEN 7062 AND 7817) as links_remaining,
  (SELECT COUNT(*) FROM mp_source_record WHERE id BETWEEN 9520 AND 10319) as sr_remaining;