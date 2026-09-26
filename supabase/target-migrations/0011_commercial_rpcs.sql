-- ============================================================================
-- TARGET V1 — 0011 COMMERCIAL RPCs (Phase 14, Slice 1)
-- Authority: RPC_CONTRACTS_V1.md  1 deliver_order
--                                 2 rectify_delivered_order
--                                 3 cancel_order
--                                 4 register_collection
--            RPC_CONTRACTS_V1.md "SECURITY DEFINER hardening", RLS spec section 4
--
-- Every function:
--   * is SECURITY DEFINER owned by postgres (BYPASSRLS) with search_path = public;
--   * derives the actor from auth.uid() and the business role from
--     current_app_role() -- no parameter can name a user or a role;
--   * calls the Foundation guard assert_period_open() before any write when the
--     contract names a period determinant;
--   * runs as ONE transaction: any RAISE rolls back every write of the call.
-- ============================================================================

-- ── 1. deliver_order ───────────────────────────────────────────────────────
-- PENDING -> DELIVERED. Creates the sale's client debt (+total, SALE_DELIVERY).
-- Creates NO financial_operation / financial_posting: a credit sale moves no cash.

CREATE OR REPLACE FUNCTION deliver_order(
  p_order_id     UUID,
  p_delivered_at TIMESTAMPTZ,
  p_reason       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_order          pedidos;
  v_delivered_date DATE;
  v_total          NUMERIC(15,2);
  v_client_name    TEXT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_order FROM pedidos WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF v_order.estado <> 'PENDING' THEN
    RAISE EXCEPTION 'ORDER_NOT_PENDING: current state is %', v_order.estado;
  END IF;

  v_delivered_date := (p_delivered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  PERFORM assert_period_open(v_delivered_date);

  SELECT COALESCE(SUM(subtotal), 0) INTO v_total
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'ORDER_HAS_NO_LINES';
  END IF;

  -- contract validation list: client activo = true
  SELECT nombre INTO v_client_name FROM clients WHERE id = v_order.cliente_id AND activo = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;

  UPDATE pedidos
     SET estado = 'DELIVERED', delivered_at = p_delivered_at, delivered_date = v_delivered_date,
         updated_at = NOW(), updated_by = v_uid
   WHERE id = p_order_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_order.cliente_id, 'SALE_DELIVERY', v_total, v_delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'DELIVER',
          jsonb_build_object('estado', 'PENDING'),
          jsonb_build_object('estado', 'DELIVERED', 'delivered_date', v_delivered_date, 'total', v_total),
          p_reason, v_uid);

  RETURN jsonb_build_object(
    'id', p_order_id, 'estado', 'DELIVERED', 'delivered_at', p_delivered_at,
    'delivered_date', v_delivered_date, 'order_total', v_total);
END;
$$;

ALTER  FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

-- ── 2. rectify_delivered_order ─────────────────────────────────────────────
-- Replaces the CURRENT line set of a delivered order with a new version.
-- Order of mutation is mandatory: validate everything, RETIRE the current
-- version, THEN insert the new one (excl_pedido_lineas_single_current_version
-- rejects the reverse order). The ledger reversal always cancels the CURRENT
-- version's total, so N rectifications net to the Nth total. Both ledger rows
-- are dated at the ORIGINAL delivered_date. No money moves.

CREATE OR REPLACE FUNCTION rectify_delivered_order(
  p_order_id  UUID,
  p_new_lines JSONB,
  p_reason    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid             UUID := auth.uid();
  v_order           pedidos;
  v_delivered_date  DATE;
  v_current_version INTEGER;
  v_current_total   NUMERIC(15,2);
  v_current_count   INTEGER;
  v_new_version     INTEGER;
  v_new_total       NUMERIC(15,2);
  v_client_name     TEXT;
  v_reversal_id     BIGINT;
  v_line            JSONB;
  v_producto_id     UUID;
  v_cantidad        NUMERIC;
  v_precio          NUMERIC;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  -- NULL or non-array would make jsonb_array_length() NULL and skip the check
  IF p_new_lines IS NULL OR jsonb_typeof(p_new_lines) <> 'array'
     OR jsonb_array_length(p_new_lines) = 0 THEN
    RAISE EXCEPTION 'EMPTY_LINE_SET';
  END IF;

  SELECT * INTO v_order FROM pedidos WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF v_order.estado <> 'DELIVERED' THEN
    RAISE EXCEPTION 'ORDER_NOT_DELIVERED: current state is %', v_order.estado;
  END IF;

  v_delivered_date := v_order.delivered_date;          -- never re-dates the sale
  PERFORM assert_period_open(v_delivered_date);

  -- 1. the version being replaced
  v_current_version := v_order.rectification_seq;
  SELECT COALESCE(SUM(subtotal), 0), COUNT(*) INTO v_current_total, v_current_count
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true;
  IF v_current_count = 0 THEN
    RAISE EXCEPTION 'NO_CURRENT_LINES';
  END IF;

  -- 2. validate the whole replacement set before the first mutation
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_new_lines) LOOP
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

  -- 3. new version number
  v_new_version := v_current_version + 1;

  -- 4. RETIRE the current version first (only is_current flips; snapshots untouched)
  UPDATE pedido_lineas SET is_current = false
   WHERE pedido_id = p_order_id AND is_current = true AND version_seq = v_current_version;

  -- 5. THEN insert the new current version
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_new_lines) LOOP
    INSERT INTO pedido_lineas (pedido_id, producto_id, cantidad, precio_unitario,
           producto_nombre, version_seq, is_current, created_by)
    VALUES (p_order_id,
            (v_line->>'producto_id')::UUID,
            (v_line->>'cantidad')::NUMERIC,
            (v_line->>'precio_unitario')::NUMERIC,
            (SELECT nombre FROM products WHERE id = (v_line->>'producto_id')::UUID),
            v_new_version, true, v_uid);
  END LOOP;

  -- 6. total of the version just written
  SELECT COALESCE(SUM(subtotal), 0) INTO v_new_total
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true AND version_seq = v_new_version;

  -- 7. advance the version pointer
  UPDATE pedidos SET rectification_seq = v_new_version, updated_at = NOW(), updated_by = v_uid
   WHERE id = p_order_id;

  -- 8. compensating entries at the original delivered_date
  SELECT nombre INTO v_client_name FROM clients WHERE id = v_order.cliente_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_order.cliente_id, 'REVERSAL', -v_current_total, v_delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_reversal_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reversal_of_id,
         reason, created_by)
  VALUES (v_order.cliente_id, 'SALE_DELIVERY', v_new_total, v_delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, v_reversal_id, p_reason, v_uid);

  -- 9. audit
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'RECTIFY_DELIVERED_ORDER',
          jsonb_build_object('version', v_current_version, 'total', v_current_total,
                             'line_count', v_current_count),
          jsonb_build_object('version', v_new_version, 'total', v_new_total,
                             'line_count', jsonb_array_length(p_new_lines)),
          p_reason, v_uid);

  RETURN jsonb_build_object(
    'id', p_order_id, 'version_seq', v_new_version, 'previous_total', v_current_total,
    'new_total', v_new_total, 'adjustment', v_new_total - v_current_total);
END;
$$;

ALTER  FUNCTION rectify_delivered_order(UUID, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_delivered_order(UUID, JSONB, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rectify_delivered_order(UUID, JSONB, TEXT) TO authenticated;

-- ── 3. cancel_order ────────────────────────────────────────────────────────
-- PENDING -> CANCELLED only. A PENDING order is not an economic fact: no period
-- guard, no ledger. A DELIVERED order is never cancelled (use rectification).

CREATE OR REPLACE FUNCTION cancel_order(
  p_order_id     UUID,
  p_cancelled_at TIMESTAMPTZ,
  p_reason       TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid            UUID := auth.uid();
  v_order          pedidos;
  v_cancelled_date DATE;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  SELECT * INTO v_order FROM pedidos WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF v_order.estado <> 'PENDING' THEN
    RAISE EXCEPTION 'ONLY_PENDING_CAN_CANCEL: current state is %', v_order.estado;
  END IF;

  v_cancelled_date := (p_cancelled_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;

  UPDATE pedidos
     SET estado = 'CANCELLED', cancelled_at = p_cancelled_at, cancelled_date = v_cancelled_date,
         updated_at = NOW(), updated_by = v_uid
   WHERE id = p_order_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'CANCEL', jsonb_build_object('estado', 'PENDING'),
          jsonb_build_object('estado', 'CANCELLED'), p_reason, v_uid);

  RETURN jsonb_build_object('id', p_order_id, 'estado', 'CANCELLED', 'cancelled_date', v_cancelled_date);
END;
$$;

ALTER  FUNCTION cancel_order(UUID, TIMESTAMPTZ, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION cancel_order(UUID, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION cancel_order(UUID, TIMESTAMPTZ, TEXT) TO authenticated;

-- ── 4. register_collection ─────────────────────────────────────────────────
-- A real receipt of money: client debt -amount (COLLECTION), one COLLECTION
-- financial_operation, one +amount posting on the receiving account.
-- CHEQUE belongs to receive_cheque (Phase 16). Prepayment is not prohibited:
-- a negative client balance is a credit.

CREATE OR REPLACE FUNCTION register_collection(
  p_cliente_id           UUID,
  p_amount               NUMERIC,
  p_payment_method       payment_method,
  p_receipt_id           VARCHAR,
  p_effective_date       DATE,
  p_financial_account_id UUID,
  p_sales_session_id     UUID DEFAULT NULL,
  p_reason               TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_client_name   TEXT;
  v_collection_id UUID;
  v_ledger_id     BIGINT;
  v_operation_id  BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_payment_method = 'CHEQUE' THEN
    RAISE EXCEPTION 'USE_RECEIVE_CHEQUE: cheque reception is handled by receive_cheque, not register_collection';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_financial_account_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_REQUIRED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = p_cliente_id AND activo = true) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM collections WHERE receipt_id = p_receipt_id) THEN
    RAISE EXCEPTION 'DUPLICATE_RECEIPT: collection with receipt_id % already exists', p_receipt_id;
  END IF;

  PERFORM assert_period_open(p_effective_date);

  SELECT nombre INTO v_client_name FROM clients WHERE id = p_cliente_id;

  INSERT INTO collections (cliente_id, amount, payment_method, receipt_id,
         effective_date, financial_account_id, sales_session_id, created_by)
  VALUES (p_cliente_id, p_amount, p_payment_method, p_receipt_id,
          p_effective_date, p_financial_account_id, p_sales_session_id, v_uid)
  RETURNING id INTO v_collection_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'COLLECTION', -p_amount, p_effective_date, v_client_name,
          'collections', v_collection_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger_id;

  INSERT INTO financial_operation (operation_type, effective_date, external_ref,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES ('COLLECTION', p_effective_date, p_receipt_id,
          'collections', v_collection_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_operation_id;

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (v_operation_id, p_financial_account_id, p_amount, p_effective_date, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('collections', v_collection_id::TEXT, 'CREATE',
          jsonb_build_object('amount', p_amount, 'method', p_payment_method,
                             'effective_date', p_effective_date),
          p_reason, v_uid);

  RETURN jsonb_build_object(
    'collection_id', v_collection_id, 'financial_operation_id', v_operation_id,
    'client_ledger_id', v_ledger_id);
END;
$$;

ALTER  FUNCTION register_collection(UUID, NUMERIC, payment_method, VARCHAR, DATE, UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_collection(UUID, NUMERIC, payment_method, VARCHAR, DATE, UUID, UUID, TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION register_collection(UUID, NUMERIC, payment_method, VARCHAR, DATE, UUID, UUID, TEXT) TO authenticated;
