-- ============================================================================
-- RESET_MERCADOPAGO_DATA.sql
-- Purpose: Clean reset of MercadoPago data for account_id 1054315166
-- Author: Francisco Abregú
-- Date: 2026-09-11
--
-- DO NOT EXECUTE WITHOUT MANUAL BACKUP FIRST
-- ============================================================================

-- ============================================================================
-- SECTION 1: BACKUP QUERIES (READ-ONLY) - RUN THESE FIRST
-- ============================================================================
-- STEP 1: Export existing data BEFORE any deletion
-- Copy-paste each query result to a file for backup

-- Backup mp_financial_movement
-- SELECT * FROM mp_financial_movement WHERE account_id = 1054315166 ORDER BY id;
-- Output to: BACKUP_mp_financial_movement_20260911.csv

-- Backup mp_movement_source_link (linked to account 1054315166)
-- SELECT msl.* FROM mp_movement_source_link msl
--   INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
--   WHERE mfm.account_id = 1054315166
--   ORDER BY msl.id;
-- Output to: BACKUP_mp_movement_source_link_20260911.csv

-- Backup mp_source_record (only those linked to account 1054315166)
-- SELECT DISTINCT msr.* FROM mp_source_record msr
--   INNER JOIN mp_movement_source_link msl ON msr.id = msl.source_record_id
--   INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
--   WHERE mfm.account_id = 1054315166
--   ORDER BY msr.id;
-- Output to: BACKUP_mp_source_record_20260911.csv

-- Backup ledger_entry (linked to account 1054315166)
-- SELECT le.* FROM ledger_entry le
--   INNER JOIN mp_financial_movement mfm ON le.financial_movement_id = mfm.id
--   WHERE mfm.account_id = 1054315166
--   ORDER BY le.id;
-- Output to: BACKUP_ledger_entry_20260911.csv

-- Backup account_balance
-- SELECT * FROM account_balance WHERE account_id = 1054315166 ORDER BY id;
-- Output to: BACKUP_account_balance_20260911.csv

-- ============================================================================
-- SECTION 2: DELETION (EXECUTE ONLY AFTER BACKUPS ARE VERIFIED)
-- ============================================================================
-- Delete in REVERSE order of foreign key dependencies
-- Use temp table to capture source_record_ids before deleting links

BEGIN TRANSACTION;

-- Step 0: Create temp table and save source_record_ids linked to this account
CREATE TEMP TABLE temp_source_records_to_delete (id BIGINT);

INSERT INTO temp_source_records_to_delete
SELECT DISTINCT msr.id
FROM mp_source_record msr
INNER JOIN mp_movement_source_link msl ON msr.id = msl.source_record_id
INNER JOIN mp_financial_movement mfm ON msl.financial_movement_id = mfm.id
WHERE mfm.account_id = 1054315166;

-- Step 1: Delete ledger_entry for this account's FM records
DELETE FROM ledger_entry
WHERE financial_movement_id IN (
  SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
);

-- Step 2: Delete mp_movement_source_link for this account's FM records
DELETE FROM mp_movement_source_link
WHERE financial_movement_id IN (
  SELECT id FROM mp_financial_movement WHERE account_id = 1054315166
);

-- Step 3: Delete mp_financial_movement for this account
DELETE FROM mp_financial_movement
WHERE account_id = 1054315166;

-- Step 4: Delete mp_source_record only if not linked to other accounts
DELETE FROM mp_source_record
WHERE id IN (SELECT id FROM temp_source_records_to_delete)
  AND NOT EXISTS (
    SELECT 1 FROM mp_movement_source_link
    WHERE source_record_id = mp_source_record.id
  );

-- Step 5: Delete account_balance for this account
DELETE FROM account_balance
WHERE account_id = 1054315166;

-- Cleanup
DROP TABLE temp_source_records_to_delete;

-- ============================================================================
-- VERIFICATION QUERIES (Run after deletion to confirm)
-- ============================================================================
-- SELECT COUNT(*) as remaining_sr FROM mp_source_record WHERE account_id = 1054315166;
-- SELECT COUNT(*) as remaining_fm FROM mp_financial_movement WHERE account_id = 1054315166;
-- SELECT COUNT(*) as remaining_le FROM ledger_entry
--   WHERE financial_movement_id IN (SELECT id FROM mp_financial_movement WHERE account_id = 1054315166);
-- SELECT COUNT(*) as remaining_links FROM mp_movement_source_link
--   WHERE financial_movement_id IN (SELECT id FROM mp_financial_movement WHERE account_id = 1054315166);
-- SELECT COUNT(*) as remaining_ab FROM account_balance WHERE account_id = 1054315166;

COMMIT;

-- ============================================================================
-- FINAL CHECK
-- ============================================================================
-- Confirm all MP records for this account are gone:
-- SELECT 'mp_source_record' as table_name, COUNT(*) as remaining_records FROM mp_source_record WHERE account_id = 1054315166
-- UNION ALL
-- SELECT 'mp_financial_movement', COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166
-- UNION ALL
-- SELECT 'account_balance', COUNT(*) FROM account_balance WHERE account_id = 1054315166;
