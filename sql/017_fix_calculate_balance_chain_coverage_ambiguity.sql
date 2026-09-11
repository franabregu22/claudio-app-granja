-- HOTFIX 017: FIX AMBIGUOUS COLUMN REFERENCE IN calculate_balance_chain_coverage
-- File: 017_fix_calculate_balance_chain_coverage_ambiguity.sql
-- Status: HOTFIX (function redefinition only, no logic changes)
-- Issue: PL/pgSQL variable scope collision - account_id ambiguous in FROM clause
-- Solution: Add explicit table aliases to disambiguate all column references

-- ============================================================
-- HOTFIX: calculate_balance_chain_coverage with qualified references
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_balance_chain_coverage(
  p_account_id BIGINT,
  p_period_start DATE,
  p_period_end DATE
) RETURNS TABLE (
  account_id BIGINT,
  period_start DATE,
  period_end DATE,
  opening_config_valid BOOLEAN,
  required_months INTEGER,
  complete_months INTEGER,
  missing_or_incomplete_months INTEGER,
  balance_chain_coverage VARCHAR(20)
) AS $$
DECLARE
  v_opening_config_valid BOOLEAN;
  v_opening_balance_date DATE;
  v_required INTEGER;
  v_complete INTEGER;
BEGIN
  -- Get opening config validity and opening_balance_date
  SELECT ocv.opening_config_valid, ocv.opening_balance_date
  INTO v_opening_config_valid, v_opening_balance_date
  FROM (
    SELECT
      CASE WHEN COUNT(DISTINCT ab.opening_balance) = 1 AND COUNT(DISTINCT ab.opening_balance_date) = 1 THEN TRUE ELSE FALSE END as opening_config_valid,
      CASE WHEN COUNT(DISTINCT ab.opening_balance) = 1 AND COUNT(DISTINCT ab.opening_balance_date) = 1 THEN MIN(ab.opening_balance_date) ELSE NULL END as opening_balance_date
    FROM account_balance ab
    WHERE ab.account_id = p_account_id
  ) ocv;

  -- If config invalid or missing, return unavailable
  IF v_opening_config_valid IS NOT TRUE THEN
    RETURN QUERY SELECT p_account_id, p_period_start, p_period_end, FALSE, NULL, NULL, NULL, 'unavailable'::VARCHAR(20);
    RETURN;
  END IF;

  -- If period_end before opening_date, return unavailable
  IF p_period_end < v_opening_balance_date THEN
    RETURN QUERY SELECT p_account_id, p_period_start, p_period_end, TRUE, NULL, NULL, NULL, 'unavailable'::VARCHAR(20);
    RETURN;
  END IF;

  -- Generate required months and count complete ones
  WITH required_months AS (
    SELECT generate_series(
      DATE_TRUNC('month', v_opening_balance_date)::DATE,
      DATE_TRUNC('month', p_period_end)::DATE,
      INTERVAL '1 month'
    )::DATE as month_start
  ),
  month_periods AS (
    SELECT
      month_start,
      LEAST((month_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE, p_period_end) as month_end
    FROM required_months
  ),
  coverage_check AS (
    SELECT
      COUNT(*) as total_months,
      SUM(CASE WHEN pcs.period_coverage = 'complete' THEN 1 ELSE 0 END) as complete_count
    FROM month_periods mp
    LEFT JOIN v_period_coverage_status pcs ON pcs.account_id = p_account_id
      AND pcs.period_start = mp.month_start
      AND pcs.period_end = mp.month_end
  )
  SELECT cc.total_months, cc.complete_count
  INTO v_required, v_complete
  FROM coverage_check cc;

  -- Determine chain status
  RETURN QUERY SELECT
    p_account_id,
    p_period_start,
    p_period_end,
    TRUE,
    v_required,
    v_complete,
    v_required - COALESCE(v_complete, 0),
    CASE
      WHEN v_complete = v_required THEN 'complete'::VARCHAR(20)
      ELSE 'incomplete'::VARCHAR(20)
    END;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VALIDATION: Test function execution without errors
-- ============================================================

SELECT
  'Function Hotfix Validation' as validation_type,
  'calculate_balance_chain_coverage call' as check_item,
  'PASS' as status,
  'Function executed without ambiguity errors' as detail
WHERE EXISTS (
  SELECT 1 FROM calculate_balance_chain_coverage(1054315166, '2026-07-01'::DATE, '2026-08-31'::DATE)
);
