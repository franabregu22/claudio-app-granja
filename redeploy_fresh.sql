-- Force recreate all functions fresh

-- Drop RPC functions
DROP FUNCTION IF EXISTS preview_financial_movements_reconciliation_v2(BIGINT, JSONB[], TEXT, DATE, DATE) CASCADE;
DROP FUNCTION IF EXISTS import_financial_movements_reconciliation_v2(BIGINT, JSONB[], TEXT, DATE, DATE, TEXT) CASCADE;

-- Drop helper functions
DROP FUNCTION IF EXISTS compute_economic_row_fp(BIGINT, TEXT, TEXT, NUMERIC, TIMESTAMP, TEXT) CASCADE;
DROP FUNCTION IF EXISTS compute_cross_source_fp(NUMERIC, TIMESTAMP, TEXT) CASCADE;
DROP FUNCTION IF EXISTS map_to_economic_class(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS is_raw_only(TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS get_existing_fm_by_econ_fp(BIGINT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS get_fm_candidates_by_cross_fp(BIGINT, TEXT) CASCADE;
