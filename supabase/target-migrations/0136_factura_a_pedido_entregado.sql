-- ============================================================================
-- TARGET V1 — 0136 FACTURA A EN UN PEDIDO YA ENTREGADO (owner 2026-11-20)
--
--   «Me gustaría tildar Factura A en un pedido ya cargado.» The owner accepts that the loaded price is read as the NET: if it already
--   included the IVA, the price is corrected first (rectify_delivered_order) and then the box is ticked.
--   set_order_invoice_a(p_order_id, p_factura_a, p_reason) — SECURITY DEFINER, ADMIN, reason required; a DELIVERED order, its delivery
--   period open:
--     · ON  — the client's CUIT (11 digits) required, never an aggregated retail sale; IVA = round(net × 21 %, 2); the issued Factura A is
--             recorded exactly as deliver_order records it (0135: INVOICE_A / DEBITO, the delivered date, the client, number NULL, IVA
--             component rate 21);
--     · OFF — only while the invoice has no number (once numbered it was issued in ARCA: corrected with a credit note in Fiscal); the
--             unissued document and its component are removed, their full content kept in the audit row;
--     · the client ledger is re-booked like a rectification (0011): REVERSAL of what was charged, then SALE_DELIVERY of the new total on
--       the original delivered date (reversal_of_id set) — the lines (the net, the P&L) are not touched;
--     · audit_events SET_ORDER_INVOICE_A (before / after). The same value again changes nothing.
--   SECURITY DEFINER set +1. Nothing existing is rewritten.
-- ============================================================================

CREATE FUNCTION set_order_invoice_a(p_order_id UUID, p_factura_a BOOLEAN, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_order       pedidos;
  v_doc         fiscal_document;
  v_comp        JSONB;
  v_net         NUMERIC(15,2);
  v_iva         NUMERIC(15,2) := 0;
  v_old_total   NUMERIC(15,2);
  v_new_total   NUMERIC(15,2);
  v_client_name TEXT;
  v_cuit        TEXT;
  v_reversal_id BIGINT;
  v_new_doc     UUID;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_factura_a IS NULL THEN
    RAISE EXCEPTION 'INVALID_INVOICE_FLAG';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  SELECT * INTO v_order FROM pedidos WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF v_order.estado <> 'DELIVERED' THEN
    RAISE EXCEPTION 'ORDER_NOT_DELIVERED: current state is %', v_order.estado;
  END IF;
  IF v_order.factura_a = p_factura_a THEN
    RETURN jsonb_build_object('id', p_order_id, 'factura_a', p_factura_a, 'changed', false);
  END IF;
  PERFORM assert_period_open(v_order.delivered_date);

  SELECT COALESCE(SUM(subtotal), 0) INTO v_net FROM pedido_lineas WHERE pedido_id = p_order_id AND is_current = true;
  IF v_net <= 0 THEN
    RAISE EXCEPTION 'ORDER_HAS_NO_LINES';
  END IF;
  SELECT nombre, client_cuit(fiscal_id) INTO v_client_name, v_cuit FROM clients WHERE id = v_order.cliente_id;

  IF p_factura_a THEN
    IF v_order.is_aggregated_retail THEN
      RAISE EXCEPTION 'INVOICE_A_NOT_FOR_RETAIL: an aggregated retail sale has no Factura A';
    END IF;
    IF v_cuit IS NULL THEN
      RAISE EXCEPTION 'CLIENT_CUIT_REQUIRED: a Factura A needs the client''s CUIT (11 digits)';
    END IF;
    v_old_total := v_net;
    v_iva := round(v_net * 0.21, 2);
    v_new_total := v_net + v_iva;
    INSERT INTO fiscal_document (document_type, direction, document_date, fiscal_period, cliente_id, external_number,
           net_amount, total_amount, created_by, pedido_id)
    VALUES ('INVOICE_A', 'DEBITO', v_order.delivered_date, date_trunc('month', v_order.delivered_date)::DATE, v_order.cliente_id, NULL,
            v_net, v_new_total, v_uid, p_order_id)
    RETURNING id INTO v_new_doc;
    INSERT INTO fiscal_document_component (fiscal_document_id, tax_kind, direction, base_amount, rate_applied, tax_amount)
    VALUES (v_new_doc, 'IVA', 'DEBITO', v_net, 21, v_iva);
  ELSE
    SELECT * INTO v_doc FROM fiscal_document WHERE pedido_id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SALE_INVOICE_NOT_FOUND: the Factura A of this order is missing';
    END IF;
    IF v_doc.external_number IS NOT NULL THEN
      RAISE EXCEPTION 'SALE_INVOICE_ISSUED: the Factura A already has its number (issued in ARCA): correct it with a credit note in Fiscal';
    END IF;
    v_old_total := v_doc.total_amount;
    v_new_total := v_net;
    SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) INTO v_comp FROM fiscal_document_component c WHERE c.fiscal_document_id = v_doc.id;
    DELETE FROM fiscal_document_component WHERE fiscal_document_id = v_doc.id;
    DELETE FROM fiscal_document WHERE id = v_doc.id;
  END IF;

  UPDATE pedidos SET factura_a = p_factura_a, updated_at = NOW(), updated_by = v_uid WHERE id = p_order_id;

  -- the client ledger, re-booked like a rectification on the original delivered date
  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_order.cliente_id, 'REVERSAL', -v_old_total, v_order.delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, btrim(p_reason), v_uid)
  RETURNING id INTO v_reversal_id;
  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
  VALUES (v_order.cliente_id, 'SALE_DELIVERY', v_new_total, v_order.delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, v_reversal_id, btrim(p_reason), v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'SET_ORDER_INVOICE_A',
          jsonb_build_object('factura_a', v_order.factura_a, 'total', v_old_total)
            || CASE WHEN p_factura_a THEN '{}'::jsonb ELSE jsonb_build_object('fiscal_document', to_jsonb(v_doc), 'components', v_comp) END,
          jsonb_build_object('factura_a', p_factura_a, 'total', v_new_total, 'net', v_net, 'iva', v_iva, 'fiscal_document_id', v_new_doc),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('id', p_order_id, 'factura_a', p_factura_a, 'changed', true, 'previous_total', v_old_total,
                            'new_total', v_new_total, 'net', v_net, 'iva', v_iva, 'fiscal_document_id', v_new_doc);
END $$;
ALTER FUNCTION set_order_invoice_a(UUID, BOOLEAN, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION set_order_invoice_a(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION set_order_invoice_a(UUID, BOOLEAN, TEXT) TO authenticated;
