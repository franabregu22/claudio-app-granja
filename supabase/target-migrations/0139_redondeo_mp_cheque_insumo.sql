-- ============================================================================
-- TARGET V1 — 0139 REDONDEO EN LA VINCULACIÓN MERCADO PAGO + Nº DE CHEQUE EN SU DÉBITO + NOMBRE DEL INSUMO
-- (owner decisions 2026-11-25)
--
--   * Mercado Pago link with rounding: a purchase recorded as paid with Mercado Pago and its real outflow are the same payment when
--     their amounts differ by up to $1.00 (a pump charges $114.014,00, the invoice reads $114.013,98).
--       - fin_purchase_mp_link: the candidates are the pending outflows up to $1 apart, nearest first, each with its difference;
--       - settle_purchase_mp: links them; the payment posts what the movement paid, the difference is stored as the link's
--         rounding (purchase_mp_settlement.rounding, |rounding| <= 1) — more than $1 apart is still MP_AMOUNT_MISMATCH;
--       - pnl_line_item: the rounding is part of THAT expense (same bucket, category, nature, date, exclusions); no other
--         category («la diferencia va al gasto»).
--   * fin_operation_list (same identity): the bank debit of an own cheque / eCheq paid for an expense reads
--     «eCheq 035 · <expense>» (backlog #6).
--   * Renaming an expense subcategory marked as a feed ingredient renames its ingredient (backlog #2), when it is the only
--     category of that ingredient and the name is free (trigger, invoker; never blocks the rename).
--   No data is written by this migration; DEFINER count unchanged (180).
-- ============================================================================

ALTER TABLE purchase_mp_settlement
  ADD COLUMN rounding NUMERIC(15,2) NOT NULL DEFAULT 0 CONSTRAINT chk_purchase_mp_settlement_rounding CHECK (abs(rounding) <= 1.00);

CREATE OR REPLACE FUNCTION settle_purchase_mp(p_purchase_id UUID, p_source_id TEXT, p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid(); v_root UUID; v_link purchase_mp_link; v_set purchase_mp_settlement; v_cur purchases; v_out RECORD; v_cls mp_outflow_classification;
  v_op BIGINT; v_res JSONB; v_paid NUMERIC; v_round NUMERIC;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  IF coalesce(p_source_id, '') !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'INVALID_SOURCE_ID: a Mercado Pago operation number is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  v_root := purchase_chain_root(p_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase_mp:' || v_root, 0));
  SELECT * INTO v_link FROM purchase_mp_link WHERE purchase_root_id = v_root;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_MP_PENDING_PURCHASE: the purchase is not waiting for a Mercado Pago movement'; END IF;
  -- replay / conflicts
  SELECT * INTO v_set FROM purchase_mp_settlement WHERE purchase_root_id = v_root;
  IF FOUND THEN
    IF v_set.source_id = p_source_id THEN RETURN v_set.result || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'PURCHASE_MP_ALREADY_LINKED: the purchase is linked to operation %', v_set.source_id;
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_mp_settlement WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: the key was used for another link';
  END IF;
  SELECT * INTO v_cur FROM purchases WHERE is_current AND purchase_chain_root(id) = v_root FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF v_cur.supplier_id IS NOT NULL OR v_cur.paid_operation_id IS NOT NULL THEN RAISE EXCEPTION 'NOT_MP_PENDING_PURCHASE: the purchase is not an unpaid casual purchase'; END IF;
  -- the real outflow (ADR-020 / ADR-021 checks of register_casual_purchase): never re-pointed, never applied twice
  SELECT * INTO v_out FROM mp_outflow_resolve(p_source_id);
  SELECT * INTO v_cls FROM mp_outflow_classification WHERE source_id = p_source_id;
  IF FOUND THEN
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: operation % is already classified as % %', p_source_id, v_cls.classification,
      CASE WHEN v_cls.purchase_id IS NOT NULL THEN ' (purchase ' || v_cls.purchase_id || ')' ELSE '' END;
  END IF;
  IF v_out.applied THEN RAISE EXCEPTION 'PAYOUT_ALREADY_APPLIED: the movement already has a financial operation'; END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status = 'OWN_ACCOUNT_EXACT' THEN
    RAISE EXCEPTION 'OWN_ACCOUNT_PAYOUT: payout % goes to an own account — confirm it as a transfer', p_source_id;
  END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status <> 'NO_OWN_ACCOUNT_MATCH' THEN
    RAISE EXCEPTION 'DESTINATION_REVIEW_REQUIRED: payout % is %', p_source_id, v_out.match_status;
  END IF;
  IF v_out.mp_account_id IS DISTINCT FROM v_link.mp_account_id THEN RAISE EXCEPTION 'MP_ACCOUNT_MISMATCH: the movement belongs to another account'; END IF;
  -- [0139] the purchase total = the outflow's comparable gross (fees / taxes are separate charges, ADR-020), up to $1.00 of rounding
  -- (owner 2026-11-25): the payment is what the movement paid; the difference is the rounding of THIS expense (P&L: pnl_line_item)
  v_paid := -v_out.gross_amount;
  v_round := v_paid - v_cur.amount_total;
  IF abs(v_round) > 1.00 THEN
    RAISE EXCEPTION 'MP_AMOUNT_MISMATCH: the outflow''s gross is % and the purchase total % (more than $1 apart)', v_paid, v_cur.amount_total;
  END IF;
  -- only the movement's period matters: the purchase (and its period) is not rewritten
  PERFORM assert_period_open(v_out.occurred_date);
  PERFORM mp_pending_outflow_release(v_out.movement_id, v_uid, 'PURCHASE_MP_LINK');
  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('PURCHASE_PAYMENT', v_out.occurred_date, 'MP-OUTFLOW:' || p_source_id, 'purchases', v_cur.id::TEXT,
            coalesce(nullif(btrim(p_reason), ''), 'Pago Mercado Pago de ' || v_cur.subcategory), v_uid)
    RETURNING id INTO v_op;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_out.mp_account_id, -v_paid, v_out.occurred_date, v_uid);
  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_out.movement_id, v_op, v_out.mp_account_id, v_out.gross_amount, 'MP-OUTFLOW:' || p_source_id, NOW(), v_uid);
  PERFORM mp_outflow_apply_charges(v_out.movement_id, p_source_id, v_out.mp_account_id, v_out.fee_amount, v_out.tax_amount, v_out.occurred_date, v_uid, v_out.kind);
  INSERT INTO mp_outflow_classification (source_id, mp_financial_movement_id, classification, expense_category_id, nature, concept, counterparty_name,
         purchase_id, financial_operation_id, destination_run_id, destination_row_number, amount, reason, created_by)
  VALUES (p_source_id, v_out.movement_id, 'CASUAL_PURCHASE', v_cur.expense_category_id, v_cur.nature, v_cur.subcategory, v_cur.counterparty_name,
          v_cur.id, v_op, v_out.destination_run_id, v_out.destination_row_number, v_paid, p_reason, v_uid);
  v_res := jsonb_build_object('replayed', false, 'purchase_id', v_cur.id, 'purchase_root_id', v_root, 'source_id', p_source_id,
                              'financial_operation_id', v_op, 'economic_date', v_cur.economic_date, 'movement_date', v_out.occurred_date,
                              'amount', v_cur.amount_total, 'paid', v_paid, 'rounding', v_round, 'fee', v_out.fee_amount, 'tax', v_out.tax_amount, 'status', 'VINCULADO',
                              'financial_effect', 'EXISTING_MP_OUTFLOW');
  INSERT INTO purchase_mp_settlement (purchase_root_id, purchase_id, source_id, mp_financial_movement_id, financial_operation_id, economic_date,
         movement_date, amount, rounding, idempotency_key, reason, result, created_by)
  VALUES (v_root, v_cur.id, p_source_id, v_out.movement_id, v_op, v_cur.economic_date, v_out.occurred_date, v_cur.amount_total, v_round, p_idempotency_key,
          nullif(btrim(coalesce(p_reason, '')), ''), v_res, v_uid);
  -- the receipt(s) of the purchase also point to the movement
  INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by)
  SELECT l.document_file_id, 'MP_PENDING_OUTFLOW', p_source_id, v_uid FROM document_link l
   WHERE l.target_kind = 'PURCHASE' AND l.target_id IN (SELECT p.id::text FROM purchases p WHERE purchase_chain_root(p.id) = v_root)
  ON CONFLICT DO NOTHING;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_cur.id::TEXT, 'SETTLE_MP', v_res, coalesce(p_reason, 'Vinculación Mercado Pago'), v_uid);
  RETURN v_res;
END $$;

CREATE OR REPLACE VIEW fin_purchase_mp_link WITH (security_invoker = true) AS
  SELECT l.purchase_root_id, cur.id AS purchase_id, cur.economic_date, cur.amount_total, cur.subcategory AS concept, cur.counterparty_name,
         ec.nombre AS category_name, cur.fiscal_document_id, l.origin, l.origin_ref ->> 'short_code' AS origin_code, l.created_at,
         CASE WHEN s.id IS NULL THEN 'PENDIENTE_VINCULACION_MP' ELSE 'VINCULADO' END AS status,
         s.source_id, s.movement_date, s.financial_operation_id, s.created_at AS linked_at,
         (CURRENT_DATE - cur.economic_date) AS age_days,
         CASE WHEN s.id IS NULL THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object('source_id', v.source_id, 'date', v.business_date, 'amount', v.economic_amount,
                                                         'difference', v.economic_amount - cur.amount_total)
                                      ORDER BY abs(v.economic_amount - cur.amount_total), abs(v.business_date - cur.economic_date), v.source_id), '[]'::jsonb)
              FROM fin_mp_pending_classification v
             WHERE v.direction = 'OUT' AND v.status = 'PENDING' AND abs(v.economic_amount - cur.amount_total) <= 1.00)   -- [0139] up to $1 of rounding
         END AS candidates
    FROM purchase_mp_link l
    JOIN purchases cur ON cur.is_current AND purchase_chain_root(cur.id) = l.purchase_root_id
    LEFT JOIN expense_category ec ON ec.id = cur.expense_category_id
    LEFT JOIN purchase_mp_settlement s ON s.purchase_root_id = l.purchase_root_id;

ALTER VIEW fin_purchase_mp_link OWNER TO postgres;
REVOKE ALL ON fin_purchase_mp_link FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_purchase_mp_link TO authenticated;

CREATE OR REPLACE VIEW pnl_line_item
WITH (security_invoker = true)
AS
SELECT u.bucket, u.business_date, date_trunc('month', u.business_date)::DATE AS period,
       u.signed_amount, u.source_entity_type, u.source_entity_id,
       u.expense_category_id, u.nature, u.project_id, u.description
FROM (
  SELECT 'VENTAS_NETAS'::TEXT AS bucket, p.delivered_date AS business_date,
         SUM(l.subtotal)::NUMERIC(15,2) AS signed_amount,
         'pedidos'::TEXT AS source_entity_type, p.id::TEXT AS source_entity_id,
         NULL::UUID AS expense_category_id, NULL::purchase_nature AS nature, NULL::UUID AS project_id,
         c.nombre::TEXT AS description
    FROM pedidos p
    JOIN pedido_lineas l ON l.pedido_id = p.id AND l.is_current
    JOIN clients c ON c.id = p.cliente_id
   WHERE p.estado = 'DELIVERED'
   GROUP BY p.id, p.delivered_date, c.nombre

  UNION ALL
  SELECT CASE pu.nature WHEN 'OPERATING' THEN CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END
                        WHEN 'REINVESTMENT' THEN 'REINVERSION'
                        WHEN 'INVESTMENT' THEN 'INVERSIONES' END,
         pu.economic_date, -pu.amount_total,
         'purchases', pu.id::TEXT, pu.expense_category_id, pu.nature, pu.project_id,
         coalesce(pu.subcategory, ec.nombre)::TEXT
    FROM purchases pu
    JOIN expense_category ec ON ec.id = pu.expense_category_id
   WHERE pu.is_current AND NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = purchase_chain_root(pu.id))
     -- [0126] feed ingredients and feed freight are stock, not expense, from feed_cost_start()
     AND NOT ((ec.feed_ingredient_id IS NOT NULL OR ec.is_feed_freight) AND pu.economic_date >= feed_cost_start())

  UNION ALL
  -- [0139] the rounding of a Mercado Pago link (the movement paid up to $1 more / less than the expense): part of THAT expense — same
  -- bucket, category, nature, date and exclusions (owner 2026-11-25: «la diferencia va al gasto», no other category)
  SELECT CASE pu.nature WHEN 'OPERATING' THEN CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END
                        WHEN 'REINVESTMENT' THEN 'REINVERSION'
                        WHEN 'INVESTMENT' THEN 'INVERSIONES' END,
         pu.economic_date, -s.rounding,
         'purchase_mp_rounding', s.id::TEXT, pu.expense_category_id, pu.nature, pu.project_id,
         (coalesce(pu.subcategory, ec.nombre) || ' (redondeo del pago Mercado Pago)')::TEXT
    FROM purchase_mp_settlement s
    JOIN purchases pu ON pu.is_current AND purchase_chain_root(pu.id) = s.purchase_root_id
    JOIN expense_category ec ON ec.id = pu.expense_category_id
   WHERE s.rounding <> 0
     AND NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = s.purchase_root_id)
     AND NOT ((ec.feed_ingredient_id IS NOT NULL OR ec.is_feed_freight) AND pu.economic_date >= feed_cost_start())

  UNION ALL
  SELECT CASE pu.nature WHEN 'OPERATING' THEN CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END
                        WHEN 'REINVESTMENT' THEN 'REINVERSION'
                        WHEN 'INVESTMENT' THEN 'INVERSIONES' END,
         f.economic_date, -fa.allocated_amount,
         'freight_allocation', fa.id::TEXT, pu.expense_category_id, pu.nature, pu.project_id,
         coalesce(f.document_ref, 'flete asignado')::TEXT
    FROM freight_allocation fa
    JOIN freight f ON f.id = fa.freight_id AND f.is_current
    JOIN purchases pu ON pu.id = fa.purchase_id
    JOIN expense_category ec ON ec.id = pu.expense_category_id
   -- [0126] freight allocated to a feed-ingredient purchase follows the purchase
   WHERE NOT ((ec.feed_ingredient_id IS NOT NULL OR ec.is_feed_freight) AND pu.economic_date >= feed_cost_start())

  UNION ALL
  SELECT CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END,
         f.economic_date,
         -(f.amount - COALESCE((SELECT SUM(fa.allocated_amount) FROM freight_allocation fa WHERE fa.freight_id = f.id), 0)),
         'freight', f.id::TEXT, f.expense_category_id, NULL::purchase_nature, NULL::UUID,
         coalesce(f.document_ref, ec.nombre)::TEXT
    FROM freight f
    JOIN expense_category ec ON ec.id = f.expense_category_id
   WHERE f.is_current
     AND f.amount - COALESCE((SELECT SUM(fa.allocated_amount) FROM freight_allocation fa WHERE fa.freight_id = f.id), 0) <> 0
     -- [0126] unallocated freight of a feed-freight category is not expense either
     AND NOT (ec.is_feed_freight AND f.economic_date >= feed_cost_start())

  UNION ALL
  SELECT CASE e.event_type WHEN 'WITHDRAWAL' THEN 'RETIROS'
                           ELSE CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END END,
         e.event_date, -e.amount,
         'sales_session_cash_event', e.id::TEXT, e.expense_category_id, NULL::purchase_nature, NULL::UUID,
         e.reason
    FROM sales_session_cash_event e
    LEFT JOIN expense_category ec ON ec.id = e.expense_category_id
   WHERE e.event_type IN ('EXPENSE', 'WITHDRAWAL')

  UNION ALL
  -- [ADR-016] summarized Feria closing, current version: the aggregate expense, once, by its category class
  SELECT CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END,
         sc.closing_date, -sc.expenses,
         'sales_session_closing', sc.id::TEXT, sc.expense_category_id, NULL::purchase_nature, NULL::UUID,
         'Gastos de Feria'::TEXT
    FROM sales_session_closing sc
    JOIN expense_category ec ON ec.id = sc.expense_category_id
   WHERE sc.is_current AND sc.expenses <> 0

  UNION ALL
  -- [ADR-016] "Diferencia de caja": counted − expected, current version, once (overage > 0, shortage < 0)
  SELECT 'DIFERENCIA_CAJA',
         sc.closing_date, sc.counted_cash - (sc.opening_float + sc.cash_sales - sc.expenses),
         'sales_session_closing', sc.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         'Diferencia de caja (Feria)'::TEXT
    FROM sales_session_closing sc
   WHERE sc.is_current AND sc.counted_cash - (sc.opening_float + sc.cash_sales - sc.expenses) <> 0

  UNION ALL
  SELECT 'COSTOS_INDIRECTOS', m.occurred_date, -abs(m.fee_amount),
         'mp_financial_movement', m.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         ('MP fee ' || m.movement_kind)::TEXT
    FROM mp_financial_movement m
   WHERE m.fee_amount <> 0

  UNION ALL
  SELECT 'OTROS_INGRESOS_FINANCIEROS', m.occurred_date, m.net_amount,
         'mp_financial_movement', m.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         'MP yield'::TEXT
    FROM mp_financial_movement m
   WHERE m.movement_kind = 'yield'

  UNION ALL
  SELECT CASE me.event_type WHEN 'RETIRO' THEN 'RETIROS' ELSE 'RESERVAS_INTERNAS' END,
         me.effective_date,
         CASE WHEN me.compensates_event_id IS NULL THEN -me.amount ELSE me.amount END,
         'management_event', me.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         me.reason
    FROM management_event me

  UNION ALL
  -- [0101] a registered expense without a current purchase on its payment: SIN CLASIFICAR (once; the purchase replaces it)
  SELECT 'GASTOS_SIN_CLASIFICAR', ep.economic_date, -ep.amount,
         'expense_pending_classification', ep.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         (ep.concept || ' (sin clasificar)')::TEXT
    FROM expense_pending_classification ep
   WHERE NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = ep.payment_operation_id AND pu.is_current)

  UNION ALL
  -- [0126] the feed consumed in a closed month, at its recipe cost per kg (from feed_cost_start())
  SELECT 'COSTOS_DIRECTOS', (cc.period + INTERVAL '1 month - 1 day')::DATE, -cc.consumption_cost,
         'feed_consumption', (cc.feed_type_id::TEXT || ':' || cc.period::TEXT), NULL::UUID, 'OPERATING'::purchase_nature, NULL::UUID,
         ('Alimento consumido — ' || cc.feed_type_nombre)::TEXT
    FROM report_feed_consumption_cost cc
   WHERE cc.period >= feed_cost_start() AND cc.consumption_cost IS NOT NULL AND cc.consumption_cost <> 0
) u
WHERE (SELECT current_app_role()) = 'ADMIN';

ALTER VIEW pnl_line_item OWNER TO postgres;

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
  p_sin_etiqueta BOOLEAN DEFAULT false,  -- [0127] only the rows of expenses WITHOUT a tag
  p_comprobante TEXT    DEFAULT NULL     -- [0137] 'CON': rows of expenses with an invoice number or a file; 'SIN': rows of expenses with neither
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
  IF p_comprobante IS NOT NULL AND p_comprobante NOT IN ('CON', 'SIN') THEN RAISE EXCEPTION 'INVALID_COMPROBANTE'; END IF;
  IF length(v_search) > 100 OR length(v_focus) > 120 THEN RAISE EXCEPTION 'INVALID_SEARCH: too long'; END IF;
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE';

  RETURN (
  WITH cur AS MATERIALIZED (
    -- the current version of every purchase, by chain root (few rows: the chain is resolved once here)
    SELECT pu.id, purchase_chain_root(pu.id) AS root, pu.supplier_id, pu.expense_category_id, pu.nature::TEXT AS nature, pu.subcategory,
           pu.counterparty_name, pu.amount_total, pu.economic_date, pu.created_at, pu.supplier_invoice_number, pu.fiscal_document_id
      FROM purchases pu WHERE pu.is_current
  ), comp AS MATERIALIZED (
    -- [0137] the expenses (by root) with an invoice / receipt: the invoice number or a file (ERP upload or WhatsApp) of the version in
    -- force or of the original one — what the column «Factura / comprobante» shows
    SELECT c.root FROM cur c
     WHERE p_comprobante IS NOT NULL
       AND (nullif(btrim(c.supplier_invoice_number), '') IS NOT NULL
         OR EXISTS (SELECT 1 FROM purchases r WHERE r.id = c.root AND nullif(btrim(r.supplier_invoice_number), '') IS NOT NULL)
         OR EXISTS (SELECT 1 FROM purchase_attachment pa WHERE pa.purchase_id IN (c.id, c.root))
         OR EXISTS (SELECT 1 FROM document_link dl WHERE dl.target_kind = 'PURCHASE' AND dl.target_id IN (c.id::TEXT, c.root::TEXT)))
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
            -- [0137] invoice / receipt: rows linked to an expense (root) with one / without one (rows of no expense are never «sin comprobante»)
            AND (p_comprobante IS NULL
              OR (p_comprobante = 'CON' AND EXISTS (SELECT 1 FROM comp k WHERE k.root = u.root))
              OR (p_comprobante = 'SIN' AND u.root IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comp k WHERE k.root = u.root)))
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
                   -- [0139] the bank debit of an own cheque / eCheq paid for an expense: «eCheq 035 · <expense>» (backlog #6, owner 2026-11-25)
                   (SELECT CASE WHEN o2.operation_type::TEXT = 'INSTRUMENT_DEBIT'
                                THEN coalesce((SELECT CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number || ' · ', '')
                                                 FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                                                WHERE ev.financial_operation_id = o2.id LIMIT 1), '')
                                ELSE '' END || coalesce(c.subcategory, c.counterparty_name) FROM cur c WHERE c.root = pg.root),
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

-- ── backlog #2: the ingredient follows the name of its subcategory ─────────────
CREATE FUNCTION expense_category_feed_rename() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.feed_ingredient_id IS NOT NULL AND NEW.nombre IS DISTINCT FROM OLD.nombre
     AND (SELECT count(*) FROM expense_category WHERE feed_ingredient_id = NEW.feed_ingredient_id) = 1
     AND NOT EXISTS (SELECT 1 FROM feed_ingredient WHERE nombre = NEW.nombre AND id <> NEW.feed_ingredient_id) THEN
    UPDATE feed_ingredient SET nombre = NEW.nombre WHERE id = NEW.feed_ingredient_id AND nombre IS DISTINCT FROM NEW.nombre;
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION expense_category_feed_rename() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_category_feed_rename() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_expense_category_feed_rename AFTER UPDATE OF nombre ON expense_category FOR EACH ROW EXECUTE FUNCTION expense_category_feed_rename();
