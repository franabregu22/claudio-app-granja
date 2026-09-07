-- ============================================================================
-- HELPER FUNCTIONS FOR RECONCILIATION ENGINE (READ-ONLY)
-- File: 008_reconciliation_helpers.sql
-- Status: Support functions for Layer 1-4 classification
-- ============================================================================

-- ============================================================================
-- LAYER 2: Compute economic_row_fp within a single source
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_economic_row_fp(
  p_account_id BIGINT,
  p_source_type TEXT,
  p_source_external_id TEXT,
  p_signed_impact NUMERIC,
  p_timestamp TIMESTAMP,
  p_description_or_type TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(
    CONCAT(
      p_account_id::text, '|',
      p_source_type, '|',
      p_source_external_id, '|',
      SIGN(p_signed_impact)::text, '|',
      ROUND(ABS(p_signed_impact), 2)::text, '|',
      DATE_TRUNC('second', p_timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')::text, '|',
      p_description_or_type
    )
  )
$$;

-- ============================================================================
-- LAYER 3: Compute cross_source_fp (candidate generation, not globally unique)
-- ============================================================================

CREATE OR REPLACE FUNCTION compute_cross_source_fp(
  p_signed_impact NUMERIC,
  p_timestamp TIMESTAMP,
  p_economic_class TEXT
) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(
    CONCAT(
      SIGN(p_signed_impact)::text, '|',
      ROUND(ABS(p_signed_impact), 2)::text, '|',
      DATE_TRUNC('day', p_timestamp AT TIME ZONE 'America/Argentina/Buenos_Aires')::text, '|',
      p_economic_class
    )
  )
$$;

-- ============================================================================
-- Map DESCRIPTION/TYPE to economic_class
-- ============================================================================

CREATE OR REPLACE FUNCTION map_to_economic_class(
  p_source_type TEXT,
  p_description_or_type TEXT
) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_class TEXT;
BEGIN
  IF p_source_type = 'liberaciones' THEN
    CASE p_description_or_type
      WHEN 'payment' THEN v_class := 'PAYMENT';
      WHEN 'payout' THEN v_class := 'PAYOUT';
      WHEN 'asset_management' THEN v_class := 'ASSET_MANAGEMENT';
      WHEN 'reserve_for_payment' THEN v_class := 'RESERVE';
      WHEN 'reserve_for_payout' THEN v_class := 'RESERVE';
      ELSE v_class := 'UNKNOWN';
    END CASE;
  ELSIF p_source_type = 'report' THEN
    CASE p_description_or_type
      WHEN 'SETTLEMENT' THEN v_class := 'PAYMENT';
      ELSE v_class := 'PAYMENT';  -- Report rows are generally payments
    END CASE;
  ELSE
    v_class := 'UNKNOWN';
  END IF;

  RETURN v_class;
END;
$$;

-- ============================================================================
-- Check if row is RAW-only (reserves)
-- ============================================================================

CREATE OR REPLACE FUNCTION is_raw_only(
  p_source_type TEXT,
  p_description TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_source_type = 'liberaciones' AND p_description IN ('reserve_for_payment', 'reserve_for_payout')
$$;

-- ============================================================================
-- Get existing FM by economic_row_fp (Layer 2 within-source)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_existing_fm_by_econ_fp(
  p_account_id BIGINT,
  p_economic_row_fp TEXT
) RETURNS TABLE(fm_id BIGINT, settlement_amount NUMERIC, needs_review BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, mfm.settlement_amount, mfm.needs_review
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id
    AND msr.economic_row_fp = p_economic_row_fp
  LIMIT 1
$$;

-- ============================================================================
-- Get existing FM by cross_source_fp (Layer 3 candidate)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_fm_candidates_by_cross_fp(
  p_account_id BIGINT,
  p_cross_source_fp TEXT
) RETURNS TABLE(fm_id BIGINT, source_count BIGINT, settlement_amount NUMERIC)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT mfm.id, COUNT(DISTINCT msr.id), mfm.settlement_amount
  FROM mp_financial_movement mfm
  INNER JOIN mp_movement_source_link mmsl ON mfm.id = mmsl.financial_movement_id
  INNER JOIN mp_source_record msr ON mmsl.source_record_id = msr.id
  WHERE mfm.account_id = p_account_id
    AND msr.cross_source_fp = p_cross_source_fp
  GROUP BY mfm.id, mfm.settlement_amount
$$;

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- Helper functions created: 7
-- These support preview and import functions with deterministic logic
-- ============================================================================
