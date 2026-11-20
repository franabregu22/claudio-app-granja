-- ============================================================================
-- TARGET V1 — 0135 FACTURA A EN PEDIDOS + IMPUESTO DÉBITOS Y CRÉDITOS DE MERCADO PAGO (owner 2026-11-20)
--
--   «Vendí 3 cajas a 36 mil más IVA cada una: no cobré 108 mil, cobré 130 mil y pico.»
--   «Quiero contabilizar todo ese impuesto lo mejor que se pueda.»
--
--   A. Factura A (owner decisions 2026-11-20):
--      1. pedidos.factura_a (default false). The box price is entered WITHOUT IVA (pedido_lineas unchanged: the lines are the net
--         sale, so the P&L and every sales report keep reading the net).
--      2. fiscal_document.pedido_id — the issued Factura A of an order (one per order; written only by the definers below).
--      3. deliver_order (0100 body): a Factura A order needs its client's CUIT (11 digits) and is never an aggregated retail sale;
--         IVA = round(net × 21 %, 2); the client owes net + IVA (client_ledger SALE_DELIVERY); fiscal_document INVOICE_A / DEBITO
--         (document date = delivered date, cliente, number NULL — loaded later) + component IVA DEBITO base net, rate 21, the IVA.
--         Without Factura A nothing changes.
--      4. rectify_delivered_order (0011 body): the reversal and the new SALE_DELIVERY carry the IVA of a Factura A order; its
--         fiscal document follows (net, total, IVA component; audit_events RECTIFY_SALE_INVOICE with before / after).
--      5. set_sale_invoice_number(p_order_id, p_number) — SECURITY DEFINER, ADMIN: the number of the order's Factura A (as issued in
--         ARCA), unique among issued invoices; NULL clears it; audited (SET_SALE_INVOICE_NUMBER).
--   B. Impuesto a los débitos y créditos de Mercado Pago:
--      6. tax_is_debcred_mp(p_ref) — an inflow's Mercado Pago tax (MP:MPA:<n>:TAX, from the report sync) that is exactly 0.6 % of
--         its credit (MP:MPA:<n>:SETTLE): the impuesto a los débitos y créditos (production 2026-11-20: 4178 / 4178).
--      7. report_bank_tax_period (same columns): also the Mercado Pago debits / credits tax — the outflow taxes (MP-OUTFLOW-TAX:)
--         and those inflow taxes — next to the bank ones (bank_tax_charge never holds the Mercado Pago account, 0062).
--      8. fin_operation_list (0133 body, same identity): such an inflow tax reads «Imp. débitos y créditos MP».
--   Nothing existing is rewritten: no posting, ledger row or document changes. SECURITY DEFINER set +1 (set_sale_invoice_number).
-- ============================================================================

-- ── A1–A2 ─────────────────────────────────────────────────────────────────
ALTER TABLE pedidos ADD COLUMN factura_a BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fiscal_document ADD COLUMN pedido_id UUID REFERENCES pedidos(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX idx_fiscal_document_pedido ON fiscal_document(pedido_id) WHERE pedido_id IS NOT NULL;
ALTER TABLE fiscal_document ADD CONSTRAINT chk_fiscal_document_pedido CHECK (pedido_id IS NULL OR (direction = 'DEBITO' AND cliente_id IS NOT NULL));
-- an issued invoice number is unique per type (two Facturas A never share a number)
CREATE UNIQUE INDEX idx_fiscal_document_issued_number ON fiscal_document(document_type, external_number)
  WHERE direction = 'DEBITO' AND external_number IS NOT NULL;

-- the client's CUIT as 11 digits, or NULL (clients.fiscal_id is free text: «CUIT / DNI»)
CREATE FUNCTION client_cuit(p_fiscal_id TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN length(d) = 11 THEN d END FROM (SELECT regexp_replace(coalesce(p_fiscal_id, ''), '[^0-9]', '', 'g') AS d) x
$$;
ALTER FUNCTION client_cuit(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION client_cuit(TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION client_cuit(TEXT) TO authenticated;

-- ── A3 deliver_order (0100 body + Factura A) ─────────────────────────────
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
  v_net            NUMERIC(15,2);
  v_iva            NUMERIC(15,2) := 0;
  v_total          NUMERIC(15,2);
  v_client_name    TEXT;
  v_cuit           TEXT;
  v_doc            UUID;
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

  SELECT COALESCE(SUM(subtotal), 0) INTO v_net
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true;
  IF v_net <= 0 THEN
    RAISE EXCEPTION 'ORDER_HAS_NO_LINES';
  END IF;

  -- contract validation list: client activo = true
  SELECT nombre, client_cuit(fiscal_id) INTO v_client_name, v_cuit FROM clients WHERE id = v_order.cliente_id AND activo = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;

  -- [0135] Factura A: the lines are the net; the client owes net + IVA 21 %
  IF v_order.factura_a THEN
    IF v_order.is_aggregated_retail THEN
      RAISE EXCEPTION 'INVOICE_A_NOT_FOR_RETAIL: an aggregated retail sale has no Factura A';
    END IF;
    IF v_cuit IS NULL THEN
      RAISE EXCEPTION 'CLIENT_CUIT_REQUIRED: a Factura A needs the client''s CUIT (11 digits)';
    END IF;
    v_iva := round(v_net * 0.21, 2);
  END IF;
  v_total := v_net + v_iva;

  UPDATE pedidos
     SET estado = 'DELIVERED', delivered_at = p_delivered_at, delivered_date = v_delivered_date,
         delivered_by = v_uid,   -- [0100] the confirming ADMIN
         updated_at = NOW(), updated_by = v_uid
   WHERE id = p_order_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date,
         ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_order.cliente_id, 'SALE_DELIVERY', v_total, v_delivered_date,
          v_client_name, 'pedido', p_order_id::TEXT, p_reason, v_uid);

  IF v_order.factura_a THEN
    INSERT INTO fiscal_document (document_type, direction, document_date, fiscal_period, cliente_id, external_number,
           net_amount, total_amount, created_by, pedido_id)
    VALUES ('INVOICE_A', 'DEBITO', v_delivered_date, date_trunc('month', v_delivered_date)::DATE, v_order.cliente_id, NULL,
            v_net, v_total, v_uid, p_order_id)
    RETURNING id INTO v_doc;
    INSERT INTO fiscal_document_component (fiscal_document_id, tax_kind, direction, base_amount, rate_applied, tax_amount)
    VALUES (v_doc, 'IVA', 'DEBITO', v_net, 21, v_iva);
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values,
         reason, performed_by)
  VALUES ('pedido', p_order_id::TEXT, 'DELIVER',
          jsonb_build_object('estado', 'PENDING'),
          jsonb_build_object('estado', 'DELIVERED', 'delivered_date', v_delivered_date, 'total', v_total)
            || CASE WHEN v_order.factura_a THEN jsonb_build_object('factura_a', true, 'net', v_net, 'iva', v_iva, 'fiscal_document_id', v_doc) ELSE '{}'::jsonb END,
          p_reason, v_uid);

  RETURN jsonb_build_object(
    'id', p_order_id, 'estado', 'DELIVERED', 'delivered_at', p_delivered_at,
    'delivered_date', v_delivered_date, 'order_total', v_total, 'net', v_net, 'iva', v_iva, 'fiscal_document_id', v_doc);
END;
$$;
-- CREATE OR REPLACE keeps the existing ACL (0011 / 0069: authenticated + service_role, no anon); owner restated only
ALTER  FUNCTION deliver_order(UUID, TIMESTAMPTZ, TEXT) OWNER TO postgres;

-- ── A4 rectify_delivered_order (0011 body + Factura A) ───────────────────
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
  v_current_net     NUMERIC(15,2);
  v_current_total   NUMERIC(15,2);
  v_current_count   INTEGER;
  v_new_version     INTEGER;
  v_new_net         NUMERIC(15,2);
  v_new_total       NUMERIC(15,2);
  v_new_iva         NUMERIC(15,2) := 0;
  v_client_name     TEXT;
  v_reversal_id     BIGINT;
  v_line            JSONB;
  v_producto_id     UUID;
  v_cantidad        NUMERIC;
  v_precio          NUMERIC;
  v_doc             fiscal_document;
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

  -- 1. the version being replaced (what the client was charged: the net, plus its IVA on a Factura A)
  v_current_version := v_order.rectification_seq;
  SELECT COALESCE(SUM(subtotal), 0), COUNT(*) INTO v_current_net, v_current_count
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true;
  IF v_current_count = 0 THEN
    RAISE EXCEPTION 'NO_CURRENT_LINES';
  END IF;
  IF v_order.factura_a THEN
    SELECT * INTO v_doc FROM fiscal_document WHERE pedido_id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SALE_INVOICE_NOT_FOUND: the Factura A of this order is missing';
    END IF;
    v_current_total := v_doc.total_amount;
  ELSE
    v_current_total := v_current_net;
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

  -- 6. total of the version just written (the net; on a Factura A plus its IVA 21 %)
  SELECT COALESCE(SUM(subtotal), 0) INTO v_new_net
    FROM pedido_lineas
   WHERE pedido_id = p_order_id AND is_current = true AND version_seq = v_new_version;
  IF v_order.factura_a THEN
    v_new_iva := round(v_new_net * 0.21, 2);
  END IF;
  v_new_total := v_new_net + v_new_iva;

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

  -- 8b. [0135] the Factura A follows the order: net, total and its IVA (owner: «se recalcula solo»)
  IF v_order.factura_a THEN
    UPDATE fiscal_document SET net_amount = v_new_net, total_amount = v_new_total WHERE id = v_doc.id;
    UPDATE fiscal_document_component SET base_amount = v_new_net, tax_amount = v_new_iva
     WHERE fiscal_document_id = v_doc.id AND tax_kind = 'IVA';
    INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
    VALUES ('fiscal_document', v_doc.id::TEXT, 'RECTIFY_SALE_INVOICE',
            jsonb_build_object('net', v_doc.net_amount, 'total', v_doc.total_amount, 'iva', v_doc.total_amount - v_doc.net_amount),
            jsonb_build_object('net', v_new_net, 'total', v_new_total, 'iva', v_new_iva, 'pedido_id', p_order_id),
            p_reason, v_uid);
  END IF;

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

-- ── A5 set_sale_invoice_number ────────────────────────────────────────────
CREATE FUNCTION set_sale_invoice_number(p_order_id UUID, p_number TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_doc fiscal_document;
  v_num TEXT := nullif(btrim(coalesce(p_number, '')), '');
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF v_num IS NOT NULL AND (length(v_num) > 30 OR v_num !~ '^[0-9A-Za-z -]+$') THEN
    RAISE EXCEPTION 'INVALID_INVOICE_NUMBER: digits, letters, spaces and dashes, up to 30';
  END IF;
  SELECT * INTO v_doc FROM fiscal_document WHERE pedido_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_INVOICE_NOT_FOUND: the order has no Factura A';
  END IF;
  IF v_doc.external_number IS NOT DISTINCT FROM v_num THEN
    RETURN jsonb_build_object('fiscal_document_id', v_doc.id, 'number', v_num, 'changed', false);
  END IF;
  IF v_num IS NOT NULL AND EXISTS (SELECT 1 FROM fiscal_document WHERE direction = 'DEBITO' AND document_type = v_doc.document_type
                                      AND external_number = v_num AND id <> v_doc.id) THEN
    RAISE EXCEPTION 'DUPLICATE_INVOICE_NUMBER: another issued invoice already has that number';
  END IF;
  UPDATE fiscal_document SET external_number = v_num WHERE id = v_doc.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('fiscal_document', v_doc.id::TEXT, 'SET_SALE_INVOICE_NUMBER',
          jsonb_build_object('external_number', v_doc.external_number), jsonb_build_object('external_number', v_num, 'pedido_id', p_order_id),
          'Número de la Factura A', v_uid);
  RETURN jsonb_build_object('fiscal_document_id', v_doc.id, 'number', v_num, 'changed', true);
END $$;
ALTER FUNCTION set_sale_invoice_number(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION set_sale_invoice_number(UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION set_sale_invoice_number(UUID, TEXT) TO authenticated;

-- ── B6 tax_is_debcred_mp ──────────────────────────────────────────────────
-- An inflow's Mercado Pago tax that is exactly 0.6 % of its credit: the impuesto a los débitos y créditos (ley 25.413).
CREATE FUNCTION tax_is_debcred_mp(p_ref TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(p_ref ~ '^MP:MPA:[0-9]+:TAX$', false) AND EXISTS (
    SELECT 1
      FROM financial_operation t
      JOIN financial_operation s ON s.external_ref = regexp_replace(t.external_ref, ':TAX$', ':SETTLE')
     WHERE t.external_ref = p_ref
       AND abs(abs((SELECT sum(p.signed_amount) FROM financial_posting p WHERE p.financial_operation_id = t.id))
               - round(abs((SELECT sum(p.signed_amount) FROM financial_posting p WHERE p.financial_operation_id = s.id)) * 0.006, 2)) <= 0.01)
$$;
ALTER FUNCTION tax_is_debcred_mp(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION tax_is_debcred_mp(TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION tax_is_debcred_mp(TEXT) TO authenticated;

-- ── B7 report_bank_tax_period (same columns; + the Mercado Pago debits / credits tax) ──
CREATE OR REPLACE VIEW report_bank_tax_period
WITH (security_invoker = true)
AS
WITH cargos AS (
  SELECT o.effective_date, b.tax_kind, b.financial_account_id, b.amount
    FROM bank_tax_charge b
    JOIN financial_operation o ON o.id = b.financial_operation_id
  UNION ALL
  SELECT o.effective_date, 'DEBITOS_CREDITOS'::tax_kind, p.financial_account_id, -p.signed_amount
    FROM financial_operation o
    JOIN financial_posting p ON p.financial_operation_id = o.id AND p.signed_amount < 0
   WHERE o.operation_type::TEXT = 'ADJUSTMENT'
     AND (o.external_ref LIKE 'MP-OUTFLOW-TAX:%' OR (o.external_ref LIKE 'MP:MPA:%:TAX' AND tax_is_debcred_mp(o.external_ref)))
)
SELECT date_trunc('month', c.effective_date)::DATE AS period,
       c.tax_kind,
       c.financial_account_id,
       a.nombre::TEXT                               AS account_name,
       SUM(c.amount)                                AS amount_paid,
       count(*)                                     AS charges
  FROM cargos c
  JOIN financial_account a ON a.id = c.financial_account_id
 WHERE (SELECT current_app_role()) = 'ADMIN'
 GROUP BY date_trunc('month', c.effective_date), c.tax_kind, c.financial_account_id, a.nombre;

ALTER  VIEW report_bank_tax_period OWNER TO postgres;
REVOKE ALL    ON report_bank_tax_period FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON report_bank_tax_period TO authenticated;

-- ── B8 fin_operation_list (0133 body + «Imp. débitos y créditos MP» for an inflow tax at 0.6 %) ──
CREATE OR REPLACE FUNCTION fin_operation_list(
  p_from        DATE    DEFAULT NULL,
  p_to          DATE    DEFAULT NULL,
  p_tipo        TEXT    DEFAULT NULL,
  p_account_id  UUID    DEFAULT NULL,
  p_sin_cuenta  BOOLEAN DEFAULT false,
  p_estado      TEXT    DEFAULT NULL,
  p_group_id    UUID    DEFAULT NULL,
  p_category_id UUID    DEFAULT NULL,
  p_nature      TEXT    DEFAULT NULL,
  p_supplier_id UUID    DEFAULT NULL,
  p_search      TEXT    DEFAULT NULL,
  p_amount      NUMERIC DEFAULT NULL,
  p_order       TEXT    DEFAULT 'FECHA',
  p_focus       TEXT    DEFAULT NULL,
  p_limit       INTEGER DEFAULT 50,
  p_offset      INTEGER DEFAULT 0,
  p_tag_id      UUID    DEFAULT NULL,    -- [0127] only the rows of expenses with this tag
  p_sin_etiqueta BOOLEAN DEFAULT false   -- [0127] only the rows of expenses WITHOUT a tag
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_search TEXT := nullif(btrim(p_search), '');
  v_like   TEXT;
  v_amount NUMERIC := abs(p_amount);
  v_focus  TEXT := nullif(btrim(p_focus), '');
  v_mp     UUID;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_LIMIT: 1 to 100'; END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN RAISE EXCEPTION 'INVALID_OFFSET'; END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN RAISE EXCEPTION 'INVALID_RANGE: from after to'; END IF;
  IF p_tipo IS NOT NULL AND p_tipo NOT IN ('INGRESO', 'EGRESO', 'TRANSFERENCIA') THEN RAISE EXCEPTION 'INVALID_TIPO'; END IF;
  IF p_estado IS NOT NULL AND p_estado NOT IN ('PENDIENTE', 'COMPLETADA', 'POR_REVISAR') THEN RAISE EXCEPTION 'INVALID_ESTADO'; END IF;
  IF p_nature IS NOT NULL AND p_nature NOT IN ('OPERATING', 'REINVESTMENT', 'INVESTMENT') THEN RAISE EXCEPTION 'INVALID_NATURE'; END IF;
  IF coalesce(p_order, 'FECHA') NOT IN ('FECHA', 'CARGA') THEN RAISE EXCEPTION 'INVALID_ORDER'; END IF;
  IF length(v_search) > 100 OR length(v_focus) > 120 THEN RAISE EXCEPTION 'INVALID_SEARCH: too long'; END IF;
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE';

  RETURN (
  WITH cur AS MATERIALIZED (
    -- the current version of every purchase, by chain root (few rows: the chain is resolved once here)
    SELECT pu.id, purchase_chain_root(pu.id) AS root, pu.supplier_id, pu.expense_category_id, pu.nature::TEXT AS nature, pu.subcategory,
           pu.counterparty_name, pu.amount_total, pu.economic_date, pu.created_at, pu.supplier_invoice_number, pu.fiscal_document_id
      FROM purchases pu WHERE pu.is_current
  ), lk AS MATERIALIZED (
    -- the expense / invoice an operation belongs to, from the recorded links only (first by link kind, then by root)
    SELECT DISTINCT ON (x.op) x.op, x.root FROM (
      SELECT c.paid_operation_id AS op, c.root, 1 AS prio FROM (SELECT p.paid_operation_id, cu.root FROM purchases p JOIN cur cu ON cu.id = p.id WHERE p.paid_operation_id IS NOT NULL) c
      UNION ALL SELECT ep.financial_operation_id, e.purchase_root_id, 2 FROM expense_payable_payment ep JOIN expense_payable e ON e.id = ep.payable_id
      UNION ALL SELECT a.financial_operation_id, a.purchase_root_id, 3 FROM purchase_payment_allocation a WHERE a.financial_operation_id IS NOT NULL
      UNION ALL SELECT ev.financial_operation_id, a.purchase_root_id, 4 FROM financial_instrument_event ev
                  JOIN purchase_payment_allocation a ON a.financial_instrument_id = ev.financial_instrument_id WHERE ev.financial_operation_id IS NOT NULL
      UNION ALL SELECT s.financial_operation_id, s.purchase_root_id, 5 FROM purchase_mp_settlement s WHERE s.financial_operation_id IS NOT NULL
    ) x ORDER BY x.op, x.prio, x.root
  ), ops AS MATERIALIZED (
    SELECT o.id, o.effective_date, o.created_at, o.operation_type::TEXT AS operation_type, o.external_ref, o.reason, o.source_entity_type,
           o.source_entity_id, c.kind, c.label, pa.total, pa.has_in, pa.has_out,
           CASE WHEN o.operation_type::TEXT = 'TRANSFER' OR (pa.has_in AND pa.has_out AND pa.total = 0) THEN 'TRANSFERENCIA'
                WHEN pa.total > 0 THEN 'INGRESO' ELSE 'EGRESO' END AS tipo,
           lk.root,
           CASE WHEN o.operation_type::TEXT = 'SUPPLIER_PAYMENT' THEN sp.id END AS payee,
           concat_ws(' ', sp.nombre, cl.nombre, pu.subcategory, pu.counterparty_name, ie.nm, al.nm) AS names
      FROM financial_operation o
     CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c
     CROSS JOIN LATERAL (SELECT sum(p.signed_amount) AS total, bool_or(p.signed_amount > 0) AS has_in, bool_or(p.signed_amount < 0) AS has_out
                           FROM financial_posting p WHERE p.financial_operation_id = o.id) pa
      LEFT JOIN lk ON lk.op = o.id
      LEFT JOIN suppliers sp ON o.operation_type::TEXT = 'SUPPLIER_PAYMENT' AND sp.id::TEXT = o.source_entity_id
      LEFT JOIN collections co ON o.source_entity_type = 'collections' AND co.id::TEXT = o.source_entity_id
      LEFT JOIN clients cl ON cl.id = co.cliente_id
      LEFT JOIN LATERAL (SELECT x.subcategory, x.counterparty_name FROM purchases x WHERE x.paid_operation_id = o.id AND x.is_current LIMIT 1) pu ON true
      LEFT JOIN LATERAL (SELECT string_agg(DISTINCT concat_ws(' ', i.cheque_number, s2.nombre, c2.nombre), ' ') AS nm FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                           LEFT JOIN suppliers s2 ON s2.id = i.supplier_id LEFT JOIN clients c2 ON c2.id = i.cliente_id WHERE ev.financial_operation_id = o.id) ie ON true
      LEFT JOIN LATERAL (SELECT string_agg(DISTINCT concat_ws(' ', s3.nombre, r.supplier_invoice_number), ' ') AS nm FROM purchase_payment_allocation x
                           JOIN purchases r ON r.id = x.purchase_root_id LEFT JOIN suppliers s3 ON s3.id = r.supplier_id WHERE x.financial_operation_id = o.id) al ON true
     WHERE pa.total IS NOT NULL
       -- [0132] a CLASSIFIED Mercado Pago outflow: its provisional («pendiente de clasificar») and its release («salida clasificada») are
       -- bookkeeping that nets to zero (ADR-021) — only the classified operation (and its tax) is a movement of the list
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow mpo WHERE mpo.provisional_operation_id = o.id
                          AND EXISTS (SELECT 1 FROM mp_pending_outflow_resolution mpr WHERE mpr.pending_id = mpo.id))
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution mpr WHERE mpr.reversal_operation_id = o.id)
  ), pend_exp AS MATERIALIZED (
    SELECT e.payable_id, e.purchase_root_id, e.economic_date, e.concept, e.counterparty_name, e.category_name, e.pending, e.amount, e.paid, e.due_date,
           e.planned_date, e.created_at, e.created_by
      FROM fin_expense_payables e WHERE e.pending > 0
  ), pend_inv AS MATERIALIZED (
    SELECT f.purchase_id, f.purchase_root_id, f.supplier_id, f.supplier_name, f.supplier_invoice_number, f.economic_date, f.amount_total, f.scheduled, f.debited,
           f.other_payments, f.amount_total - f.debited - f.other_payments AS unpaid, f.due_date, f.planned_date,
           (SELECT pu.created_at FROM purchases pu WHERE pu.id = f.purchase_root_id) AS created_at,
           (SELECT c.subcategory FROM cur c WHERE c.id = f.purchase_id) AS concept
      FROM fin_purchase_payment_status f WHERE f.amount_total - f.debited - f.other_payments > 0
  ), mp_pend AS MATERIALIZED (
    -- paid with Mercado Pago, its movement not linked yet (no settlement)
    SELECT l.purchase_root_id, l.mp_account_id, l.created_at, c.id AS purchase_id, c.economic_date, c.amount_total, c.subcategory, c.counterparty_name
      FROM purchase_mp_link l JOIN cur c ON c.root = l.purchase_root_id
     WHERE NOT EXISTS (SELECT 1 FROM purchase_mp_settlement s WHERE s.purchase_root_id = l.purchase_root_id)
  ), u AS (
    SELECT 'OP:' || o.id AS row_key, 'OP' AS row_kind, o.effective_date AS d, o.created_at AS ca, o.tipo,
           CASE WHEN o.tipo = 'INGRESO' THEN o.total ELSE -abs(CASE WHEN o.tipo = 'TRANSFERENCIA' THEN (SELECT sum(p.signed_amount) FILTER (WHERE p.signed_amount > 0) FROM financial_posting p WHERE p.financial_operation_id = o.id) ELSE o.total END) END AS amount,
           'COMPLETADA' AS estado, NULL::TEXT AS concepto, o.label AS detalle,
           (SELECT array_agg(DISTINCT p.financial_account_id) FROM financial_posting p WHERE p.financial_operation_id = o.id) AS accounts,
           o.id AS op_id, NULL::UUID AS ref_uuid, NULL::BIGINT AS ref_id,
           concat_ws(' ', o.names, o.label, o.reason, o.external_ref) AS hay,
           o.root, coalesce(c.supplier_id, o.payee) AS supplier_id,
           -- [0133] a partner withdrawal: its socio is its subcategory (group «Retiros de socios»)
           coalesce(c.expense_category_id, (SELECT me.socio_category_id FROM management_event me WHERE me.financial_operation_id = o.id LIMIT 1)) AS category_id,
           c.nature, false AS informativo
      FROM ops o LEFT JOIN cur c ON c.root = o.root
    UNION ALL
    SELECT 'GASTO:' || e.payable_id, 'GASTO', e.economic_date, e.created_at, 'EGRESO', -e.pending, 'PENDIENTE', coalesce(e.concept, e.counterparty_name, 'Gasto a pagar'),
           'Gasto pendiente de pago' || CASE WHEN e.paid > 0 THEN ' (resto)' ELSE '' END, NULL::UUID[], NULL::BIGINT, e.payable_id, NULL::BIGINT,
           concat_ws(' ', e.concept, e.counterparty_name, e.category_name),
           e.purchase_root_id, c.supplier_id, c.expense_category_id, c.nature, false
      FROM pend_exp e LEFT JOIN cur c ON c.root = e.purchase_root_id
    UNION ALL
    SELECT 'FACTURA:' || f.purchase_root_id, 'FACTURA', f.economic_date, f.created_at, 'EGRESO', -f.unpaid, 'PENDIENTE',
           coalesce(f.concept, f.supplier_name) || coalesce(' · Factura ' || f.supplier_invoice_number, ''),
           'Factura de proveedor pendiente' || CASE WHEN f.scheduled > 0 THEN ' · con cheques por debitar' ELSE '' END, NULL::UUID[], NULL::BIGINT, f.purchase_root_id, NULL::BIGINT,
           concat_ws(' ', f.supplier_name, f.supplier_invoice_number, f.concept),
           f.purchase_root_id, f.supplier_id, c.expense_category_id, c.nature, false
      FROM pend_inv f LEFT JOIN cur c ON c.root = f.purchase_root_id
    UNION ALL
    SELECT 'CHEQUE:' || i.id, 'CHEQUE', coalesce(i.maturity_date, i.issued_date), i.created_at, 'EGRESO', -i.amount, 'PENDIENTE',
           CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, ''),
           'Cheque propio por debitar', ARRAY[i.bank_account_id], NULL::BIGINT, i.id, NULL::BIGINT,
           concat_ws(' ', i.cheque_number, s.nombre), NULL::UUID, i.supplier_id, NULL::UUID, NULL::TEXT, false
      FROM financial_instrument i LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.direction::TEXT = 'ISSUED' AND i.estado::TEXT = 'ISSUED'
       AND NOT EXISTS (SELECT 1 FROM purchase_payment_allocation a WHERE a.financial_instrument_id = i.id)
    UNION ALL
    SELECT 'CHEQUE_RECIBIDO:' || i.id, 'CHEQUE_RECIBIDO', coalesce(i.maturity_date, i.received_date), i.created_at, 'INGRESO', i.amount, 'PENDIENTE',
           CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || coalesce(' · ' || cl.nombre, ''),
           CASE i.estado::TEXT WHEN 'DEPOSITED' THEN 'Cheque recibido depositado, por acreditar' ELSE 'Cheque recibido en cartera' END,
           CASE WHEN i.bank_account_id IS NOT NULL THEN ARRAY[i.bank_account_id] END, NULL::BIGINT, i.id, NULL::BIGINT,
           concat_ws(' ', i.cheque_number, cl.nombre), NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, false
      FROM financial_instrument i LEFT JOIN clients cl ON cl.id = i.cliente_id
     WHERE i.direction::TEXT = 'RECEIVED' AND i.estado::TEXT IN ('RECEIVED', 'DEPOSITED')
    UNION ALL
    SELECT 'TRANSFERENCIA:' || t.id, 'TRANSFERENCIA', t.effective_date, t.created_at, 'TRANSFERENCIA', -t.amount, 'PENDIENTE',
           fa.nombre || ' → ' || ta.nombre, 'Transferencia anticipada, esperando su movimiento', ARRAY[t.from_account_id, t.to_account_id], NULL::BIGINT, NULL::UUID, t.id,
           concat_ws(' ', fa.nombre, ta.nombre, t.reason), NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, false
      FROM fin_transfer_intent t JOIN financial_account fa ON fa.id = t.from_account_id JOIN financial_account ta ON ta.id = t.to_account_id
     WHERE t.status = 'PENDIENTE'
    UNION ALL
    SELECT 'MP_PENDIENTE:' || m.purchase_root_id, 'MP_PENDIENTE', m.economic_date, m.created_at, 'EGRESO', -m.amount_total, 'COMPLETADA',
           coalesce(m.subcategory, m.counterparty_name, 'Gasto pagado con Mercado Pago'), 'Pagado con Mercado Pago · falta vincular su movimiento',
           ARRAY[m.mp_account_id], NULL::BIGINT, m.purchase_root_id, NULL::BIGINT,
           concat_ws(' ', m.subcategory, m.counterparty_name), m.purchase_root_id, c.supplier_id, c.expense_category_id, c.nature, true
      FROM mp_pend m LEFT JOIN cur c ON c.root = m.purchase_root_id
  ), fl AS MATERIALIZED (
    SELECT * FROM u
     WHERE (v_focus IS NOT NULL AND u.row_key = v_focus)
        OR (v_focus IS NULL
            AND (p_from IS NULL OR u.d >= p_from) AND (p_to IS NULL OR u.d <= p_to)
            AND (p_tipo IS NULL OR u.tipo = p_tipo)
            -- [0127] expense tag: rows linked to an expense (root) with that tag / with none
            AND (p_tag_id IS NULL OR EXISTS (SELECT 1 FROM purchase_tag t WHERE t.purchase_root_id = u.root AND t.project_id = p_tag_id))
            AND (NOT coalesce(p_sin_etiqueta, false) OR (u.root IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_tag t WHERE t.purchase_root_id = u.root)))
            AND (p_estado IS NULL OR u.estado = p_estado
              -- Por revisar: what still needs a classification or its Mercado Pago movement (never money: a filter of the same rows)
              OR (p_estado = 'POR_REVISAR' AND (u.row_kind = 'MP_PENDIENTE'
                    OR EXISTS (SELECT 1 FROM ops o WHERE o.id = u.op_id AND o.kind = 'PENDIENTE_MP')
                    OR EXISTS (SELECT 1 FROM expense_pending_classification e WHERE e.payment_operation_id = u.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current)))))
            AND (p_account_id IS NULL OR p_account_id = ANY (u.accounts))
            AND (NOT coalesce(p_sin_cuenta, false) OR u.accounts IS NULL)
            AND (p_category_id IS NULL OR u.category_id = p_category_id)
            AND (p_group_id IS NULL OR EXISTS (SELECT 1 FROM expense_category ec WHERE ec.id = u.category_id AND ec.group_id = p_group_id))
            AND (p_nature IS NULL OR u.nature = p_nature)
            AND (p_supplier_id IS NULL OR u.supplier_id = p_supplier_id)
            AND ((v_search IS NULL AND v_amount IS NULL)
              OR (v_search IS NOT NULL AND (u.hay ILIKE v_like OR u.op_id::TEXT = v_search))
              OR (v_amount IS NOT NULL AND (abs(u.amount) = v_amount
                    OR (u.op_id IS NOT NULL AND EXISTS (SELECT 1 FROM financial_posting p WHERE p.financial_operation_id = u.op_id AND abs(p.signed_amount) = v_amount))))))
  ), page AS (
    SELECT * FROM fl
     ORDER BY CASE WHEN coalesce(p_order, 'FECHA') = 'CARGA' THEN fl.ca END DESC NULLS LAST, fl.d DESC NULLS LAST, fl.ca DESC NULLS LAST, fl.row_key DESC
     LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM fl),
    -- the money of the filtered rows, each amount once (an informative Mercado Pago row is already its provisional outflow)
    'importe', (SELECT coalesce(sum(fl.amount) FILTER (WHERE NOT fl.informativo), 0) FROM fl),
    'rows', coalesce((SELECT jsonb_agg(r.j ORDER BY r.n) FROM (
      SELECT row_number() OVER (ORDER BY CASE WHEN coalesce(p_order, 'FECHA') = 'CARGA' THEN pg.ca END DESC NULLS LAST, pg.d DESC NULLS LAST, pg.ca DESC NULLS LAST, pg.row_key DESC) AS n,
             jsonb_build_object(
               'row_key', pg.row_key, 'row_kind', pg.row_kind, 'date', pg.d, 'created_at', pg.ca, 'tipo', pg.tipo, 'amount', pg.amount, 'informativo', pg.informativo,
               'estado', pg.estado,
               'concepto', coalesce(pg.concepto, (SELECT coalesce(
                   (SELECT coalesce(c.subcategory, c.counterparty_name) FROM cur c WHERE c.root = pg.root),
                   (SELECT CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || ' · ' || coalesce(s.nombre, cl.nombre, '')
                      FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                      LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN clients cl ON cl.id = i.cliente_id WHERE ev.financial_operation_id = o2.id LIMIT 1),
                   (SELECT 'Cobro · ' || cl.nombre FROM collections co JOIN clients cl ON cl.id = co.cliente_id
                     WHERE o2.source_entity_type = 'collections' AND co.id::TEXT = o2.source_entity_id),
                   (SELECT 'Pago a ' || s.nombre FROM suppliers s WHERE o2.operation_type::TEXT = 'SUPPLIER_PAYMENT' AND s.id::TEXT = o2.source_entity_id),
                   -- [0132] a Mercado Pago inflow says what it is (its movement kind and payment method; never the payer — 0097) and
                   -- its client when one is allocated
                   (SELECT CASE
                             WHEN m.movement_kind = 'yield' THEN 'Rendimiento MP'
                             WHEN coalesce(r.event_data->>'operation_type', '') IN ('money_transfer', 'account_fund')
                               OR coalesce(r.event_data->>'PAYMENT_METHOD_TYPE', r.event_data->>'payment_type_id', '') = 'bank_transfer' THEN 'Transferencia recibida MP'
                             WHEN coalesce(r.event_data->>'PAYMENT_METHOD_TYPE', r.event_data->>'payment_type_id', '') = 'credit_card' THEN 'Cobro con tarjeta MP'
                             ELSE 'Cobro MP' END
                           || coalesce(' · ' || (SELECT string_agg(DISTINCT cl.nombre, ', ') FROM mp_client_allocation a JOIN clients cl ON cl.id = a.cliente_id
                                                  WHERE a.mp_financial_movement_id = m.id AND a.reversal_of_id IS NULL
                                                    AND NOT EXISTS (SELECT 1 FROM mp_client_allocation b WHERE b.reversal_of_id = a.id)), '')
                      FROM mp_financial_movement m JOIN mp_source_record r ON r.id = m.mp_source_record_id
                     WHERE o2.operation_type::TEXT = 'MP_SETTLEMENT'
                       AND m.id = CASE WHEN o2.source_entity_type = 'mp_financial_movement' AND o2.source_entity_id ~ '^[0-9]{1,18}$' THEN o2.source_entity_id::BIGINT
                                       ELSE (SELECT rc.mp_financial_movement_id FROM mp_reconciliation rc WHERE rc.financial_operation_id = o2.id ORDER BY rc.id LIMIT 1) END),
                   -- [0132] short concepts: never the internal reference text (ids, ADR notes, statement line numbers)
                   CASE WHEN o2.external_ref LIKE 'MP-PENDING:%' THEN 'Salida MP sin clasificar'
                        WHEN o2.external_ref LIKE 'MP-OUTFLOW-TAX:%' OR o2.reason ILIKE 'Impuesto débitos y créditos%' OR tax_is_debcred_mp(o2.external_ref)
                          THEN 'Imp. débitos y créditos' || CASE WHEN o2.external_ref LIKE 'MP%' OR o2.reason ILIKE '%Mercado Pago%' THEN ' MP' ELSE '' END
                        WHEN o2.operation_type::TEXT = 'OWNER_WITHDRAWAL' THEN c2.label
                        WHEN o2.reason ~ '→' THEN initcap(left(btrim(substring(regexp_replace(o2.reason, '^(Owner|Meta [A-Z])[^:]*:\s*', '') FROM '^([^(,]+)')), 1))
                                                   || substr(btrim(substring(regexp_replace(o2.reason, '^(Owner|Meta [A-Z])[^:]*:\s*', '') FROM '^([^(,]+)')), 2)
                        WHEN o2.reason IS NOT NULL AND o2.reason !~* '^(ADR-?\d|phase\d)'
                          THEN nullif(btrim(regexp_replace(split_part(regexp_replace(o2.reason, '^(Owner|Meta [A-Z])[^:]*:\s*', ''), ' — ', 1), '\s*\([^)]*\)\s*$', '')), '') END,
                   c2.label)
                   FROM financial_operation o2 CROSS JOIN LATERAL fin_movement_class(o2.operation_type::TEXT, o2.external_ref) c2 WHERE o2.id = pg.op_id)),
               'detalle', pg.detalle, 'operation_id', pg.op_id, 'ref_uuid', pg.ref_uuid, 'ref_id', pg.ref_id,
               -- [0132] the Mercado Pago SOURCE_ID of an outflow still to classify (the cell classifies it; the concept no longer carries it)
               'mp_source_id', (SELECT mpo.source_id FROM mp_pending_outflow mpo WHERE mpo.provisional_operation_id = pg.op_id),
               -- [0133] a partner withdrawal (not a compensation): its socio can be set from the row
               'retiro', (SELECT jsonb_build_object('event_id', me.id, 'socio_id', me.socio_category_id) FROM management_event me
                           WHERE me.financial_operation_id = pg.op_id AND me.event_type::TEXT = 'RETIRO' AND me.compensates_event_id IS NULL LIMIT 1),
               'purchase_root_id', pg.root, 'purchase_id', (SELECT c.id FROM cur c WHERE c.root = pg.root),
               'supplier_id', pg.supplier_id, 'supplier', (SELECT s.nombre FROM suppliers s WHERE s.id = pg.supplier_id),
               'category_id', pg.category_id, 'subcategory', (SELECT ec.nombre FROM expense_category ec WHERE ec.id = pg.category_id),
               'group_id', (SELECT ec.group_id FROM expense_category ec WHERE ec.id = pg.category_id),
               'category', (SELECT g.nombre FROM expense_category ec JOIN expense_category_group g ON g.id = ec.group_id WHERE ec.id = pg.category_id),
               'nature', pg.nature,
               'accounts', coalesce((SELECT jsonb_agg(jsonb_build_object('account_id', a.id, 'account_name', a.nombre, 'signed_amount',
                                  (SELECT sum(p.signed_amount) FROM financial_posting p WHERE p.financial_operation_id = pg.op_id AND p.financial_account_id = a.id))
                                  ORDER BY (SELECT sum(p.signed_amount) FROM financial_posting p WHERE p.financial_operation_id = pg.op_id AND p.financial_account_id = a.id) NULLS FIRST, a.nombre)
                                FROM financial_account a WHERE a.id = ANY (pg.accounts)), '[]'::jsonb),
               'conciliacion', CASE WHEN pg.op_id IS NULL THEN NULL ELSE (
                   SELECT CASE WHEN count(*) FILTER (WHERE q.needs) = 0 THEN CASE WHEN EXISTS (SELECT 1 FROM mp_reconciliation rr WHERE rr.financial_operation_id = pg.op_id) THEN 'MERCADO_PAGO' END
                               WHEN count(*) FILTER (WHERE q.needs AND q.matched) >= count(*) FILTER (WHERE q.needs) THEN 'CONCILIADA' ELSE 'SIN_CONCILIAR' END
                     FROM (SELECT (cut.anchor_date IS NOT NULL AND p.effective_date > cut.anchor_date) OR sm.id IS NOT NULL AS needs, sm.id IS NOT NULL AS matched
                             FROM financial_posting p
                             LEFT JOIN LATERAL (SELECT al.value_date AS anchor_date FROM fin_statement_cutover c JOIN fin_statement_line al ON al.id = c.cutoff_statement_line_id
                                                 WHERE c.financial_account_id = p.financial_account_id AND c.superseded_at IS NULL) cut ON true
                             LEFT JOIN fin_statement_match sm ON sm.financial_posting_id = p.id AND sm.reversed_at IS NULL
                            WHERE p.financial_operation_id = pg.op_id AND p.financial_account_id IS DISTINCT FROM v_mp) q) END,
               'clasificacion', CASE
                   WHEN pg.row_kind = 'MP_PENDIENTE' THEN 'MP_SIN_VINCULAR'
                   WHEN pg.op_id IS NULL THEN NULL
                   WHEN (SELECT c.kind FROM financial_operation o CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c WHERE o.id = pg.op_id) = 'PENDIENTE_MP' THEN 'MP_SIN_CLASIFICAR'
                   WHEN EXISTS (SELECT 1 FROM expense_pending_classification e WHERE e.payment_operation_id = pg.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current)) THEN 'GASTO_SIN_CLASIFICAR' END,
               'pending_class_id', CASE WHEN pg.op_id IS NOT NULL THEN (SELECT e.id FROM expense_pending_classification e WHERE e.payment_operation_id = pg.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current) LIMIT 1) END,
               'pendiente', CASE pg.row_kind
                   WHEN 'GASTO' THEN (SELECT jsonb_build_object('total', e.amount, 'pagado', e.paid, 'pendiente', e.pending, 'vence', e.due_date, 'estimada', e.planned_date) FROM pend_exp e WHERE e.payable_id = pg.ref_uuid)
                   WHEN 'FACTURA' THEN (SELECT jsonb_build_object('purchase_id', f.purchase_id, 'total', f.amount_total, 'pagado', f.debited + f.other_payments, 'cheques_por_debitar', f.scheduled,
                                         'sin_cubrir', f.amount_total - f.debited - f.other_payments - f.scheduled, 'pendiente', f.unpaid, 'vence', f.due_date, 'estimada', f.planned_date)
                                          FROM pend_inv f WHERE f.purchase_root_id = pg.ref_uuid) END
             ) AS j
        FROM page pg) r), '[]'::jsonb))
  );
END $$;

ALTER FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER, UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER, UUID, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER, UUID, BOOLEAN) TO authenticated;

-- ── gate ──────────────────────────────────────────────────────────────────
DO $$
DECLARE v_fa INTEGER; v_doc INTEGER; v_mp INTEGER; v_all INTEGER;
BEGIN
  SELECT count(*) FILTER (WHERE factura_a) INTO v_fa FROM pedidos;
  SELECT count(*) INTO v_doc FROM fiscal_document WHERE pedido_id IS NOT NULL;
  IF v_fa <> 0 OR v_doc <> 0 THEN
    RAISE EXCEPTION '0135_GATE: % Factura A orders / % order invoices right after adding the columns (expected 0 / 0)', v_fa, v_doc;
  END IF;
  SELECT count(*) FILTER (WHERE tax_is_debcred_mp(external_ref)), count(*) INTO v_mp, v_all
    FROM financial_operation WHERE external_ref LIKE 'MP:MPA:%:TAX';
  RAISE NOTICE '0135: Mercado Pago inflow taxes recognised as débitos y créditos: % of %', v_mp, v_all;
END $$;
