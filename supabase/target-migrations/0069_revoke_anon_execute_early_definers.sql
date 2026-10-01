-- ============================================================================
-- TARGET V1 — 0069 REVOKE anon EXECUTE ON THE EARLY SECURITY DEFINER FUNCTIONS
-- (pre-cutover finding B-1, owner-approved 2026-10-01)
--
-- 0006 / 0011 revoke EXECUTE only FROM PUBLIC, and 0013 removes the default
-- privileges of `postgres` in `public` for TABLES and SEQUENCES only. The current
-- Supabase platform image grants EXECUTE to anon on newly created functions, so
-- on a canonical rebuild (and on a fresh project) these six functions were
-- executable by anon, against the frozen privilege contract (RLS spec: anon
-- executes no RPC; mp_privileges S-1b, commercial I4). Later migrations already
-- revoke anon explicitly. The intended authenticated EXECUTE is kept unchanged.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION current_app_role()                    FROM anon;
REVOKE EXECUTE ON FUNCTION assert_period_open(DATE)              FROM anon;
REVOKE EXECUTE ON FUNCTION cancel_order(UUID, TIMESTAMPTZ, TEXT)  FROM anon;
REVOKE EXECUTE ON FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION rectify_delivered_order(UUID, JSONB, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION register_collection(UUID, NUMERIC, payment_method, VARCHAR, DATE, UUID, UUID, TEXT) FROM anon;

-- authenticated keeps the EXECUTE that 0006 / 0011 granted (re-stated, idempotent)
GRANT EXECUTE ON FUNCTION current_app_role()                    TO authenticated;
GRANT EXECUTE ON FUNCTION assert_period_open(DATE)              TO authenticated;
GRANT EXECUTE ON FUNCTION cancel_order(UUID, TIMESTAMPTZ, TEXT)  TO authenticated;
GRANT EXECUTE ON FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rectify_delivered_order(UUID, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION register_collection(UUID, NUMERIC, payment_method, VARCHAR, DATE, UUID, UUID, TEXT) TO authenticated;
