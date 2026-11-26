-- ============================================================================
-- TARGET V1 — 0143 FACTURAR LOS COBROS DE MERCADO PAGO (Factura B a consumidor final) (owner decisions 2026-11-26)
--
--   «Van los ingresos con IVA, pero solo para lo facturado: debería facturar solo los ingresos por Mercado Pago.»
--   * mp_cobro (view, ADMIN): every Mercado Pago income to invoice — payments and inflows received (signed: a refund subtracts), except
--     what was reclassified as a transfer from an own account (mp_inbound_reclassification).
--   * report_mp_facturar_dia / report_mp_facturar_mes (ADMIN): by day and month — cobrado, facturado con Factura B (issued to consumidor
--     final, by invoice date) and, by month, the Mercado Pago collections of clients that got a Factura A that month (never invoiced
--     twice: per client the least of what was allocated to them and their Facturas A); pendiente = cobrado − Factura B − Factura A cobrada.
--   * pnl_line_item (re-created from 0139, only the marked lines): the IVA of every issued Factura B leaves VENTAS_NETAS on its date.
--   * attach_fiscal_document_file (ADMIN, DEFINER): the PDF / photo of a fiscal document uploaded from the ERP (sales invoices).
--   No data is written by this migration; DEFINER count 182 → 183.
-- ============================================================================

CREATE VIEW mp_cobro WITH (security_invoker = true) AS
SELECT m.id AS mp_financial_movement_id, m.occurred_date AS business_date, m.gross_amount AS amount, m.movement_kind::TEXT AS movement_kind
  FROM mp_financial_movement m
 WHERE m.movement_kind IN ('payment', 'inflow') AND m.gross_amount <> 0
   AND NOT EXISTS (SELECT 1 FROM mp_inbound_reclassification x WHERE x.mp_financial_movement_id = m.id)
   AND (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW mp_cobro OWNER TO postgres;
REVOKE ALL ON mp_cobro FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON mp_cobro TO authenticated;

CREATE VIEW report_mp_facturar_dia WITH (security_invoker = true) AS
WITH c AS (SELECT business_date AS d, sum(amount) AS cobrado, count(*) AS cobros FROM mp_cobro GROUP BY 1),
     b AS (SELECT document_date AS d, sum(total_amount) AS facturado, count(*) AS facturas FROM fiscal_document
            WHERE direction = 'DEBITO' AND document_type = 'INVOICE_B' GROUP BY 1)
SELECT coalesce(c.d, b.d) AS business_date, date_trunc('month', coalesce(c.d, b.d))::DATE AS period,
       coalesce(c.cobrado, 0)::NUMERIC(15,2) AS cobrado, coalesce(c.cobros, 0) AS cobros,
       coalesce(b.facturado, 0)::NUMERIC(15,2) AS facturado_b, coalesce(b.facturas, 0) AS facturas_b
  FROM c FULL JOIN b ON b.d = c.d
 WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW report_mp_facturar_dia OWNER TO postgres;
REVOKE ALL ON report_mp_facturar_dia FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON report_mp_facturar_dia TO authenticated;

CREATE VIEW report_mp_facturar_mes WITH (security_invoker = true) AS
WITH dia AS (SELECT period, sum(cobrado) AS cobrado, sum(cobros) AS cobros, sum(facturado_b) AS facturado_b, sum(facturas_b) AS facturas_b
               FROM report_mp_facturar_dia GROUP BY period),
     fa AS (SELECT date_trunc('month', document_date)::DATE AS period, cliente_id, sum(total_amount) AS total
              FROM fiscal_document WHERE direction = 'DEBITO' AND document_type = 'INVOICE_A' AND cliente_id IS NOT NULL GROUP BY 1, 2),
     al AS (SELECT date_trunc('month', effective_date)::DATE AS period, cliente_id, sum(amount) AS total FROM mp_client_allocation GROUP BY 1, 2),
     fa_mp AS (SELECT fa.period, sum(least(fa.total, greatest(coalesce(al.total, 0), 0))) AS total
                 FROM fa LEFT JOIN al ON al.period = fa.period AND al.cliente_id = fa.cliente_id GROUP BY fa.period)
SELECT dia.period, dia.cobrado::NUMERIC(15,2), dia.cobros, dia.facturado_b::NUMERIC(15,2), dia.facturas_b,
       coalesce(fa_mp.total, 0)::NUMERIC(15,2) AS cobrado_factura_a,
       (dia.cobrado - dia.facturado_b - coalesce(fa_mp.total, 0))::NUMERIC(15,2) AS pendiente
  FROM dia LEFT JOIN fa_mp ON fa_mp.period = dia.period
 WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW report_mp_facturar_mes OWNER TO postgres;
REVOKE ALL ON report_mp_facturar_mes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON report_mp_facturar_mes TO authenticated;

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

  UNION ALL
  -- [0143] the IVA included in what was invoiced to consumidor final (Factura B issued): the sales are recorded WITH IVA, so the
  -- invoiced part's IVA leaves the net sales (owner 2026-11-26). Only issued Facturas B; on the invoice date.
  SELECT 'VENTAS_NETAS', d.document_date, -sum(c.tax_amount),
         'fiscal_document', d.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         ('IVA de ventas facturadas (Factura B' || coalesce(' ' || d.external_number, '') || ')')::TEXT
    FROM fiscal_document d
    JOIN fiscal_document_component c ON c.fiscal_document_id = d.id AND c.tax_kind = 'IVA'
   WHERE d.direction = 'DEBITO' AND d.document_type = 'INVOICE_B'
   GROUP BY d.id, d.document_date, d.external_number
) u
WHERE (SELECT current_app_role()) = 'ADMIN';


-- the PDF / photo of a fiscal document (a sales invoice issued in ARCA) uploaded from the ERP; same shape as attach_instrument_document
CREATE FUNCTION attach_fiscal_document_file(p_fiscal_document_id UUID, p_document JSONB) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_doc UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM fiscal_document WHERE id = p_fiscal_document_id) THEN RAISE EXCEPTION 'FISCAL_DOCUMENT_NOT_FOUND'; END IF;
  v_doc := register_erp_document(p_document ->> 'storage_path', p_document ->> 'sha256', p_document ->> 'content_type', (p_document ->> 'byte_size')::bigint, p_document ->> 'file_name');
  INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (v_doc, 'FISCAL_DOCUMENT', p_fiscal_document_id::text, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN v_doc;
END $$;
ALTER  FUNCTION attach_fiscal_document_file(UUID, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION attach_fiscal_document_file(UUID, JSONB) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION attach_fiscal_document_file(UUID, JSONB) TO authenticated;
