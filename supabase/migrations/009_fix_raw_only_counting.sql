-- Force recreation of RPC functions with latest code
-- Migration: 009_fix_raw_only_counting

-- Drop existing functions in correct order (RPC first, then helpers)
DROP FUNCTION IF EXISTS preview_financial_movements_reconciliation_v2(BIGINT, JSONB[], TEXT, DATE, DATE);
DROP FUNCTION IF EXISTS import_financial_movements_reconciliation_v2(BIGINT, JSONB[], TEXT, DATE, DATE, TEXT);

-- Drop helper functions
DROP FUNCTION IF EXISTS compute_economic_row_fp(BIGINT, TEXT, TEXT, NUMERIC, TIMESTAMP, TEXT);
DROP FUNCTION IF EXISTS compute_cross_source_fp(NUMERIC, TIMESTAMP, TEXT);
DROP FUNCTION IF EXISTS map_to_economic_class(TEXT, TEXT);
DROP FUNCTION IF EXISTS is_raw_only(TEXT, TEXT);
DROP FUNCTION IF EXISTS get_existing_fm_by_econ_fp(BIGINT, TEXT);
DROP FUNCTION IF EXISTS get_fm_candidates_by_cross_fp(BIGINT, TEXT);

-- Note: Functions recreated inline below (Supabase doesn't support \i includes)
-- Original source: 008_reconciliation_helpers.sql and 008_reconciliation_rpc.sql
