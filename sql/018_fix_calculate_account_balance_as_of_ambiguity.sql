-- HOTFIX 018: FIX AMBIGUOUS COLUMN REFERENCES IN calculate_account_balance_as_of
-- File: 018_fix_calculate_account_balance_as_of_ambiguity.sql
-- Status: HOTFIX (function redefinition only, no logic changes)
-- Issue: PL/pgSQL variable scope collision - opening_balance, opening_balance_date, account_id, balance_impact, occurred_at ambiguous
-- Solution: Add explicit table aliases to disambiguate all column references

-- ============================================================
-- HOTFIX: calculate_account_balance_as_of with qualified references
-- ============================================================

CREATE OR REPLACE FUNCTION calculate_account_balance_as_of(
  p_account_id BIGINT,
  p_as_of_date DATE
) RETURNS TABLE (
  opening_config_valid BOOLEAN,
  opening_balance NUMERIC(15,2),
  opening_balance_date DATE,
  calculated_balance NUMERIC(15,2)
) AS $$
DECLARE
  v_balance_count INTEGER;
  v_date_count INTEGER;
  v_opening_balance NUMERIC(15,2);
  v_opening_balance_date DATE;
BEGIN
  -- Validate opening config: count distinct values
  SELECT
    COUNT(DISTINCT ab.opening_balance),
    COUNT(DISTINCT ab.opening_balance_date),
    CASE WHEN COUNT(*) = 0 THEN NULL ELSE MIN(ab.opening_balance) END,
    CASE WHEN COUNT(*) = 0 THEN NULL ELSE MIN(ab.opening_balance_date) END
  INTO v_balance_count, v_date_count, v_opening_balance, v_opening_balance_date
  FROM account_balance ab
  WHERE ab.account_id = p_account_id;

  -- Return exactly ONE row (ISSUE 2 FIX: guarantee one row always)
  IF v_balance_count IS NULL THEN
    -- No account_balance rows at all
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::NUMERIC(15,2), NULL::DATE, NULL::NUMERIC(15,2);
  ELSIF v_balance_count = 1 AND v_date_count = 1 THEN
    -- Config is consistent: return calculated balance
    RETURN QUERY
    SELECT
      TRUE,
      v_opening_balance,
      v_opening_balance_date,
      v_opening_balance + COALESCE(
        (SELECT SUM(le.balance_impact) FROM ledger_entry le
         WHERE le.account_id = p_account_id
           AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= v_opening_balance_date
           AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= p_as_of_date),
        0
      )::NUMERIC(15,2);
  ELSE
    -- Config is inconsistent (multiple distinct values)
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::NUMERIC(15,2), NULL::DATE, NULL::NUMERIC(15,2);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- VALIDATION: Test function execution without errors
-- ============================================================

SELECT
  'Function Hotfix Validation' as validation_type,
  'calculate_account_balance_as_of call' as check_item,
  'PASS' as status,
  'Function executed without ambiguity errors' as detail
WHERE EXISTS (
  SELECT 1 FROM calculate_account_balance_as_of(1054315166, '2026-08-31'::DATE)
);
