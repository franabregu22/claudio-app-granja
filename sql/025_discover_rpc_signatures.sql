-- ============================================================================
-- DISCOVER RPC SIGNATURES: Find correct function signatures in production
-- File: 025_discover_rpc_signatures.sql
-- Status: READ-ONLY (introspection only)
-- Purpose: Determine which RPCs exist and their exact parameter signatures
-- ============================================================================

SELECT
    n.nspname AS schema_name,
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS identity_arguments,
    pg_get_function_arguments(p.oid) AS full_arguments,
    pg_get_function_result(p.oid) AS result_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
      'import_liberaciones_primary',
      'import_financial_pipeline'
  )
ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);
