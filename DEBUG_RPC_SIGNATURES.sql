-- ============================================================================
-- READ-ONLY DIAGNOSTIC: Inspect deployed RPC signatures
-- Execute this in Supabase SQL Editor to debug movement_class = NULL issue
-- ============================================================================

-- Check 1: Get full definition of import_financial_movements_reconciliation_v2
SELECT
  proname,
  pg_get_functiondef(oid) as full_definition
FROM pg_proc
WHERE proname = 'import_financial_movements_reconciliation_v2'
LIMIT 1;

-- Check 2: Get full definition of map_to_economic_class
SELECT
  proname,
  pg_get_functiondef(oid) as full_definition
FROM pg_proc
WHERE proname = 'map_to_economic_class'
LIMIT 1;

-- Check 3: Inspect the recently inserted row that failed (id 4284)
SELECT
  id,
  account_id,
  source_id,
  movement_class,
  settlement_amount,
  transaction_date,
  created_at
FROM mp_financial_movement
WHERE id = 4284
LIMIT 1;

-- Check 4: Verify mp_financial_movement schema constraints
SELECT
  column_name,
  is_nullable,
  column_default,
  data_type
FROM information_schema.columns
WHERE table_name = 'mp_financial_movement'
  AND column_name IN ('movement_class', 'source_id', 'settlement_amount')
ORDER BY ordinal_position;

-- Check 5: Look for any triggers on mp_financial_movement that might NULL fields
SELECT
  trigger_name,
  event_manipulation,
  action_statement
FROM information_schema.triggers
WHERE event_object_table = 'mp_financial_movement'
LIMIT 10;
