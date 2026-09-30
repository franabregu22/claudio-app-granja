-- ============================================================================
-- TARGET V1 — 0059 FERIA ADMIN-ONLY (ADR-009)
-- Authority: .planning/adr/ADR-009_FERIA_ADMIN_ONLY_V1.md (ACCEPTED, owner decision D-F27F-1)
--            RPC_CONTRACTS_V1.md 31 register_session_movement [ADR-009]
--            RLS_IMPLEMENTATION_SPEC_V1.md §8 Feria [ADR-009]
--
-- Owner rule: Feria is ADMIN-only in V1; OPERATOR has no Feria capability.
-- Audit of every function writing sales_session / sales_session_movement / sales_session_cash_event:
--   RPC 30 open_sales_session           — ADMIN guard already (0033)
--   RPC 31 register_session_movement    — accepted any active role → amended here
--   RPC 32 register_session_cash_event  — ADMIN guard already (0033)
--   RPC 33 close_sales_session          — ADMIN guard already (0033)
--   no other function writes those tables.
--
-- Re-defines RPC 31 with exactly one behavioural change: the role check becomes the standard ADMIN guard
-- (`FORBIDDEN: ADMIN required`) at the top of the body, as in RPCs 30 / 32 / 33. Every other line is unchanged.
-- CREATE OR REPLACE keeps its owner and EXECUTE grants (0033). No table, column, policy, grant or other function
-- changes: products and price_history RLS are untouched; the SECURITY DEFINER set stays at 62.
-- ============================================================================

CREATE OR REPLACE FUNCTION register_session_movement(
  p_session_id    UUID,
  p_movement_type session_movement_type,
  p_producto_id   UUID,
  p_cantidad      DECIMAL,
  p_reason        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_session     sales_session;
  v_movement_id BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN            -- [ADR-009] Feria is ADMIN-only in V1
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  SELECT * INTO v_session FROM sales_session WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND';
  END IF;
  IF v_session.estado <> 'OPEN' THEN
    RAISE EXCEPTION 'SESSION_CLOSED: reopen the session to add movements';
  END IF;

  PERFORM assert_period_open(v_session.session_date);

  IF p_movement_type IN ('LOSS','ADJUSTMENT') AND (p_reason IS NULL OR length(trim(p_reason)) = 0) THEN
    RAISE EXCEPTION 'REASON_REQUIRED: losses and adjustments must be explained';
  END IF;

  INSERT INTO sales_session_movement (sales_session_id, movement_type, producto_id, cantidad,
                                      reason, created_by)
  VALUES (p_session_id, p_movement_type, p_producto_id, p_cantidad, p_reason, v_uid)
  RETURNING id INTO v_movement_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('sales_session_movement', v_movement_id::TEXT, 'CREATE',
          jsonb_build_object('session_id', p_session_id, 'movement_type', p_movement_type,
                             'producto_id', p_producto_id, 'cantidad', p_cantidad),
          p_reason, v_uid);

  RETURN jsonb_build_object('movement_id', v_movement_id);
END;
$$;
