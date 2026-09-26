-- ============================================================================
-- TARGET V1 — 0006 FOUNDATION FUNCTIONS
-- Authority: RLS_IMPLEMENTATION_SPEC_V1.md section 2 (current_app_role)
--            RPC_CONTRACTS_V1.md "Canonical period guard" (ASSERT_PERIOD_OPEN)
--
-- Both are SECURITY DEFINER with a fixed search_path, derive their inputs
-- internally, and have PUBLIC execute revoked.
-- ============================================================================

-- ── current_app_role() ─────────────────────────────────────────────────────
-- The only source of a business role. perfiles.rol_type resolved from auth.uid().
-- auth.jwt() is never consulted: a JWT claim is deployment configuration, is not
-- validated against `activo`, and is shaped by whoever mints the token.

CREATE OR REPLACE FUNCTION current_app_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_uid  UUID := auth.uid();          -- derived internally; never a parameter
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT rol_type::TEXT INTO v_role
    FROM perfiles
   WHERE id = v_uid
     AND activo = true;

  IF v_role IS NULL THEN
    RAISE EXCEPTION 'USER_NOT_FOUND_OR_INACTIVE';
  END IF;

  RETURN v_role;                      -- 'ADMIN' or 'OPERATOR', nothing else
END;
$$;

REVOKE ALL     ON FUNCTION current_app_role() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION current_app_role() TO authenticated;

-- ── assert_period_open(DATE) ───────────────────────────────────────────────
-- The canonical period guard. Every period-sensitive RPC calls this before any
-- write. Locking the period row FOR UPDATE also serialises against
-- close_management_period, so a fact cannot slip in while a period is closing.

CREATE OR REPLACE FUNCTION assert_period_open(p_business_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period management_period;
BEGIN
  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'BUSINESS_DATE_REQUIRED';
  END IF;

  SELECT * INTO v_period
    FROM management_period
   WHERE periodo_fecha = date_trunc('month', p_business_date)::DATE
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERIOD_NOT_FOUND: no management_period for %', p_business_date;
  END IF;

  IF v_period.status <> 'OPEN' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: period % is CLOSED; reopen it first', v_period.periodo_fecha;
  END IF;
END;
$$;

REVOKE ALL     ON FUNCTION assert_period_open(DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION assert_period_open(DATE) TO authenticated;
