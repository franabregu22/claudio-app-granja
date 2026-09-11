-- ============================================================================
-- READ-ONLY: Inspeccionar firma exacta de la función desplegada
-- ============================================================================

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_result(p.oid) AS return_type,
  pg_get_function_arguments(p.oid) AS arguments,
  p.prokind AS function_type,
  p.provolatile AS volatility
FROM pg_proc p
INNER JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE p.proname = 'import_financial_movements_reconciliation_v2'
ORDER BY p.proname, p.oid;
