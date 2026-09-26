-- ============================================================================
-- TARGET V1 — 0033 FERIA RPCs (Phase 21)
-- Authority: RPC_CONTRACTS_V1.md 30 open_sales_session
--                                31 register_session_movement
--                                32 register_session_cash_event
--                                33 close_sales_session
--            RPC 1 deliver_order (0011) is reused unchanged for the aggregated sale
--            RLS_IMPLEMENTATION_SPEC_V1.md §4, §8 (RPCs 30–33 are the only writers)
--
-- Lock order everywhere: session row (FOR UPDATE) → period row (assert_period_open).
-- One transaction per call: any RAISE rolls back every write of the call.
--
-- Technical completions (contract behaviour unchanged; each is tested):
--   * RPC 30: a NULL or negative opening fund is INVALID_AMOUNT (NULL > 0 and
--     -5 > 0 would otherwise silently skip the fund). A concurrent retry that
--     passes the EXISTS pre-check is reported as DUPLICATE_SESSION.
--   * RPC 31: NULL quantity is INVALID_QUANTITY.
--   * RPC 32: NULL amount is INVALID_AMOUNT; a NULL event type is
--     INVALID_EVENT_TYPE; OPENING_FUND is rejected (INVALID_EVENT_TYPE): the
--     opening fund is registered only by open_sales_session, whose frozen
--     semantics are "a transfer into the session, not income" with no posting.
--     The generic non-COUNT branch of RPC 32 would instead post −amount on an
--     account, which is a different meaning. See PHASE_21_FERIA.md §34.
--   * RPC 33: NULL / non-array p_aggregated_lines is INVALID_AGGREGATED_LINES
--     (jsonb_array_length(NULL) would otherwise close the session silently
--     without its sale). Every aggregated line is validated before the first
--     write with the Commercial codes INVALID_QUANTITY / INVALID_PRICE /
--     PRODUCT_NOT_FOUND. aggregated_total is SUM(current pedido_lineas.subtotal)
--     of the aggregated Pedido (0 when there is none).
-- ============================================================================

-- ── 30. open_sales_session ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION open_sales_session(
  p_session_date    DATE,
  p_location        VARCHAR,
  p_idempotency_key VARCHAR,
  p_opening_fund    NUMERIC DEFAULT 0,
  p_cash_account_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_session_id   UUID;
  v_operation_id BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_opening_fund IS NULL OR p_opening_fund < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_session WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_SESSION';
  END IF;
  IF p_opening_fund > 0 AND p_cash_account_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_REQUIRED: an opening fund needs a cash account';
  END IF;

  PERFORM assert_period_open(p_session_date);

  BEGIN
    INSERT INTO sales_session (session_date, location, estado, opened_by, idempotency_key)
    VALUES (p_session_date, p_location, 'OPEN', v_uid, p_idempotency_key)
    RETURNING id INTO v_session_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_SESSION';
  END;

  IF p_opening_fund > 0 THEN
    -- a transfer into the session, not income: an operation without postings
    INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                     source_entity_type, source_entity_id, created_by)
    VALUES ('SESSION_CASH', p_session_date, 'SESSION_FUND:' || v_session_id::TEXT,
            'sales_session', v_session_id::TEXT, v_uid)
    RETURNING id INTO v_operation_id;

    INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount,
           financial_account_id, financial_operation_id, event_date, created_by)
    VALUES (v_session_id, 'OPENING_FUND', p_opening_fund, p_cash_account_id, v_operation_id,
            p_session_date, v_uid);
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, performed_by)
  VALUES ('sales_session', v_session_id::TEXT, 'OPEN',
          jsonb_build_object('session_date', p_session_date, 'location', p_location,
                             'opening_fund', p_opening_fund),
          v_uid);

  RETURN jsonb_build_object('session_id', v_session_id, 'estado', 'OPEN');
END;
$$;

-- ── 31. register_session_movement ──────────────────────────────────────────
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
  v_role        TEXT;
  v_session     sales_session;
  v_movement_id BIGINT;
BEGIN
  v_role := current_app_role();                    -- raises if the user is unknown or inactive
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

-- ── 32. register_session_cash_event ────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_session_cash_event(
  p_session_id             UUID,
  p_event_type             session_cash_event_type,
  p_amount                 NUMERIC,
  p_financial_account_id   UUID DEFAULT NULL,
  p_expense_category_id    UUID DEFAULT NULL,
  p_destination_account_id UUID DEFAULT NULL,
  p_reason                 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_session      sales_session;
  v_event_date   DATE;
  v_operation_id BIGINT;
  v_event_id     BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_event_type IS NULL THEN
    RAISE EXCEPTION 'INVALID_EVENT_TYPE';
  END IF;
  IF p_event_type = 'OPENING_FUND' THEN
    RAISE EXCEPTION 'INVALID_EVENT_TYPE: the opening fund is registered only by open_sales_session';
  END IF;

  SELECT * INTO v_session FROM sales_session WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND';
  END IF;
  IF v_session.estado <> 'OPEN' THEN
    RAISE EXCEPTION 'SESSION_CLOSED';
  END IF;

  v_event_date := v_session.session_date;
  PERFORM assert_period_open(v_event_date);

  IF p_event_type = 'EXPENSE' AND p_expense_category_id IS NULL THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED: a session expense needs an expense category';
  END IF;
  IF p_event_type IN ('EXPENSE','WITHDRAWAL','TRANSFER_OUT') AND p_financial_account_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_REQUIRED';
  END IF;
  IF p_event_type = 'TRANSFER_OUT' AND p_destination_account_id IS NULL THEN
    RAISE EXCEPTION 'DESTINATION_REQUIRED';
  END IF;

  v_operation_id := NULL;

  IF p_event_type <> 'COUNT' THEN
    -- a physical cash COUNT is an observation and creates no operation or posting
    INSERT INTO financial_operation (operation_type, effective_date, source_entity_type,
                                     source_entity_id, reason, created_by)
    VALUES ('SESSION_CASH', v_event_date, 'sales_session', p_session_id::TEXT, p_reason, v_uid)
    RETURNING id INTO v_operation_id;

    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount,
                                   effective_date, created_by)
    VALUES (v_operation_id, p_financial_account_id, -p_amount, v_event_date, v_uid);

    IF p_event_type = 'TRANSFER_OUT' THEN
      -- money moves to another account: both legs share one operation
      INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount,
                                     effective_date, created_by)
      VALUES (v_operation_id, p_destination_account_id, p_amount, v_event_date, v_uid);
    END IF;
  END IF;

  INSERT INTO sales_session_cash_event (sales_session_id, event_type, amount, financial_account_id,
         expense_category_id, financial_operation_id, event_date, reason, created_by)
  VALUES (p_session_id, p_event_type, p_amount, p_financial_account_id,
          p_expense_category_id, v_operation_id, v_event_date, p_reason, v_uid)
  RETURNING id INTO v_event_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('sales_session_cash_event', v_event_id::TEXT, 'CREATE',
          jsonb_build_object('session_id', p_session_id, 'event_type', p_event_type,
                             'amount', p_amount),
          p_reason, v_uid);

  RETURN jsonb_build_object('event_id', v_event_id, 'financial_operation_id', v_operation_id);
END;
$$;

-- ── 33. close_sales_session ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_sales_session(
  p_session_id       UUID,
  p_aggregated_lines JSONB,
  p_reason           TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid                  UUID := auth.uid();
  v_session              sales_session;
  v_line                 JSONB;
  v_cantidad             NUMERIC;
  v_precio               NUMERIC;
  v_producto_id          UUID;
  v_cf_client_id         UUID;
  v_aggregated_pedido_id UUID;
  v_total                NUMERIC(15,2) := 0;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_aggregated_lines IS NULL OR jsonb_typeof(p_aggregated_lines) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_AGGREGATED_LINES: an array is required (empty when there was no retail sale)';
  END IF;

  SELECT * INTO v_session FROM sales_session WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND';
  END IF;
  IF v_session.estado <> 'OPEN' THEN
    RAISE EXCEPTION 'SESSION_ALREADY_CLOSED';
  END IF;

  PERFORM assert_period_open(v_session.session_date);

  v_aggregated_pedido_id := NULL;

  IF jsonb_array_length(p_aggregated_lines) > 0 THEN
    -- validate the whole aggregated line set before the first write
    FOR v_line IN SELECT value FROM jsonb_array_elements(p_aggregated_lines) LOOP
      v_cantidad    := (v_line->>'cantidad')::NUMERIC;
      v_precio      := (v_line->>'precio_unitario')::NUMERIC;
      v_producto_id := (v_line->>'producto_id')::UUID;
      IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
      END IF;
      IF v_precio IS NULL OR v_precio < 0 THEN
        RAISE EXCEPTION 'INVALID_PRICE';
      END IF;
      IF v_producto_id IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = v_producto_id) THEN
        RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', v_producto_id;
      END IF;
    END LOOP;

    SELECT id INTO v_cf_client_id FROM clients WHERE nombre = 'CONSUMIDOR FINAL' AND activo = true;
    IF v_cf_client_id IS NULL THEN
      RAISE EXCEPTION 'CONSUMIDOR_FINAL_MISSING: the aggregated retail client master is not configured';
    END IF;

    INSERT INTO pedidos (cliente_id, estado, sales_session_id, is_aggregated_retail, created_by, updated_by)
    VALUES (v_cf_client_id, 'PENDING', p_session_id, true, v_uid, v_uid)
    RETURNING id INTO v_aggregated_pedido_id;

    -- one line per supplied line: the same product at different prices stays itemised
    FOR v_line IN SELECT value FROM jsonb_array_elements(p_aggregated_lines) LOOP
      INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario,
                                 producto_nombre, version_seq, is_current, created_by)
      VALUES (v_aggregated_pedido_id, (v_line->>'producto_id')::UUID, (v_line->>'cantidad')::NUMERIC,
              (v_line->>'precio_unitario')::NUMERIC,
              (SELECT nombre FROM products WHERE id = (v_line->>'producto_id')::UUID), 0, true, v_uid);
    END LOOP;

    -- the retail sale becomes economic through the normal delivery path
    PERFORM deliver_order(v_aggregated_pedido_id,
                          (v_session.session_date + TIME '23:59') AT TIME ZONE 'America/Argentina/Buenos_Aires',
                          'Feria aggregated retail sale');

    SELECT COALESCE(SUM(subtotal), 0) INTO v_total
      FROM pedido_lineas WHERE pedido_id = v_aggregated_pedido_id AND is_current = true;
  END IF;

  UPDATE sales_session
     SET estado = 'CLOSED', closed_at = NOW(), closed_by = v_uid,
         aggregated_pedido_id = v_aggregated_pedido_id
   WHERE id = p_session_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('sales_session', p_session_id::TEXT, 'CLOSE',
          jsonb_build_object('estado', 'OPEN'),
          jsonb_build_object('estado', 'CLOSED', 'aggregated_pedido_id', v_aggregated_pedido_id),
          p_reason, v_uid);

  RETURN jsonb_build_object('session_id', p_session_id, 'estado', 'CLOSED',
                            'aggregated_pedido_id', v_aggregated_pedido_id,
                            'aggregated_total', v_total);
END;
$$;

-- ── ownership and EXECUTE perimeter ────────────────────────────────────────
ALTER  FUNCTION open_sales_session(DATE, VARCHAR, VARCHAR, NUMERIC, UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION open_sales_session(DATE, VARCHAR, VARCHAR, NUMERIC, UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION open_sales_session(DATE, VARCHAR, VARCHAR, NUMERIC, UUID) TO authenticated;

ALTER  FUNCTION register_session_movement(UUID, session_movement_type, UUID, DECIMAL, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_session_movement(UUID, session_movement_type, UUID, DECIMAL, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_session_movement(UUID, session_movement_type, UUID, DECIMAL, TEXT) TO authenticated;

ALTER  FUNCTION register_session_cash_event(UUID, session_cash_event_type, NUMERIC, UUID, UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_session_cash_event(UUID, session_cash_event_type, NUMERIC, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_session_cash_event(UUID, session_cash_event_type, NUMERIC, UUID, UUID, UUID, TEXT) TO authenticated;

ALTER  FUNCTION close_sales_session(UUID, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION close_sales_session(UUID, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION close_sales_session(UUID, JSONB, TEXT) TO authenticated;
