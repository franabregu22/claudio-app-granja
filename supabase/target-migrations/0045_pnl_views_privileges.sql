-- ============================================================================
-- TARGET V1 — 0045 P&L DERIVED VIEWS AND PRIVILEGES (Phase 24, ADR-004)
-- Results are DERIVED, never stored: two views, no table, no materialized view,
-- no SECURITY DEFINER reporting function.
--
-- Both views are security_invoker = true: the caller's own RLS applies to every
-- source table (all ADMIN-only for this data), and an explicit ADMIN predicate
-- guards the result. OPERATOR sees zero rows; anon / service_role get no grant.
--
-- pnl_line_item — one row per source-fact contribution; signed_amount is the
-- contribution to the result (income buckets > 0, deduction buckets < 0):
--   VENTAS_NETAS               delivered pedidos, SUM(current pedido_lineas.subtotal), delivered_date
--   COSTOS_DIRECTOS / _INDIRECTOS
--                              OPERATING current purchases (amount_total, economic_date) by
--                              expense_category.pnl_cost_class; allocated freight to OPERATING
--                              purchases (purchase's class, freight.economic_date); unallocated
--                              freight (freight's own class); Feria EXPENSE cash events;
--                              MP fee_amount → INDIRECT, abs(), occurred_date
--   OTROS_INGRESOS_FINANCIEROS MP yield movements, net_amount, occurred_date
--   REINVERSION / INVERSIONES  REINVESTMENT / INVESTMENT current purchases + their allocated freight
--   RETIROS                    Feria WITHDRAWAL cash events + management_event RETIRO (± compensations)
--   RESERVAS_INTERNAS          management_event RESERVA_INTERNA (± releases)
-- Never read: financial_operation / financial_posting (treasury), client_ledger,
-- supplier_ledger, collections, fiscal_*, MP tax_amount, MP payment / transfer.
-- ============================================================================

-- ── management_event perimeter (RPC 43 is the only writer) ─────────────────
REVOKE ALL ON management_event FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON management_event TO authenticated;
CREATE POLICY management_event_admin_select ON management_event FOR SELECT
  USING (current_app_role() = 'ADMIN');

-- ── pnl_line_item ──────────────────────────────────────────────────────────
CREATE VIEW pnl_line_item
WITH (security_invoker = true)
AS
SELECT u.bucket, u.business_date, date_trunc('month', u.business_date)::DATE AS period,
       u.signed_amount, u.source_entity_type, u.source_entity_id,
       u.expense_category_id, u.nature, u.project_id, u.description
FROM (
  -- sales: delivered Pedido, current line set
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
  -- purchases: current version, full amount_total at economic_date
  SELECT CASE pu.nature WHEN 'OPERATING' THEN CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END
                        WHEN 'REINVESTMENT' THEN 'REINVERSION'
                        WHEN 'INVESTMENT' THEN 'INVERSIONES' END,
         pu.economic_date, -pu.amount_total,
         'purchases', pu.id::TEXT, pu.expense_category_id, pu.nature, pu.project_id,
         coalesce(pu.subcategory, ec.nombre)::TEXT
    FROM purchases pu
    JOIN expense_category ec ON ec.id = pu.expense_category_id
   WHERE pu.is_current

  UNION ALL
  -- allocated freight: follows the destination purchase's line, keeps freight.economic_date
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

  UNION ALL
  -- unallocated freight: freight.amount − allocated, own classification
  SELECT CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END,
         f.economic_date,
         -(f.amount - COALESCE((SELECT SUM(fa.allocated_amount) FROM freight_allocation fa WHERE fa.freight_id = f.id), 0)),
         'freight', f.id::TEXT, f.expense_category_id, NULL::purchase_nature, NULL::UUID,
         coalesce(f.document_ref, ec.nombre)::TEXT
    FROM freight f
    JOIN expense_category ec ON ec.id = f.expense_category_id
   WHERE f.is_current
     AND f.amount - COALESCE((SELECT SUM(fa.allocated_amount) FROM freight_allocation fa WHERE fa.freight_id = f.id), 0) <> 0

  UNION ALL
  -- Feria session cash: EXPENSE by class; WITHDRAWAL → Retiros; other subtypes contribute nothing
  SELECT CASE e.event_type WHEN 'WITHDRAWAL' THEN 'RETIROS'
                           ELSE CASE ec.pnl_cost_class WHEN 'DIRECT' THEN 'COSTOS_DIRECTOS' ELSE 'COSTOS_INDIRECTOS' END END,
         e.event_date, -e.amount,
         'sales_session_cash_event', e.id::TEXT, e.expense_category_id, NULL::purchase_nature, NULL::UUID,
         e.reason
    FROM sales_session_cash_event e
    LEFT JOIN expense_category ec ON ec.id = e.expense_category_id
   WHERE e.event_type IN ('EXPENSE', 'WITHDRAWAL')

  UNION ALL
  -- Mercado Pago fee component: indirect cost, exactly once (authority = the movement)
  SELECT 'COSTOS_INDIRECTOS', m.occurred_date, -abs(m.fee_amount),
         'mp_financial_movement', m.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         ('MP fee ' || m.movement_kind)::TEXT
    FROM mp_financial_movement m
   WHERE m.fee_amount <> 0

  UNION ALL
  -- Mercado Pago yield: other financial income
  SELECT 'OTROS_INGRESOS_FINANCIEROS', m.occurred_date, m.net_amount,
         'mp_financial_movement', m.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         'MP yield'::TEXT
    FROM mp_financial_movement m
   WHERE m.movement_kind = 'yield'

  UNION ALL
  -- management decisions: RETIRO / RESERVA_INTERNA; compensations offset their original
  SELECT CASE me.event_type WHEN 'RETIRO' THEN 'RETIROS' ELSE 'RESERVAS_INTERNAS' END,
         me.effective_date,
         CASE WHEN me.compensates_event_id IS NULL THEN -me.amount ELSE me.amount END,
         'management_event', me.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         me.reason
    FROM management_event me
) u
WHERE (SELECT current_app_role()) = 'ADMIN';

-- ── pnl_summary: every subtotal derived from the line items ────────────────
CREATE VIEW pnl_summary
WITH (security_invoker = true)
AS
WITH b AS (
  SELECT period,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'VENTAS_NETAS'), 0)               AS ventas_netas_devengadas,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'COSTOS_DIRECTOS'), 0)            AS costos_directos,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'COSTOS_INDIRECTOS'), 0)          AS costos_indirectos,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'OTROS_INGRESOS_FINANCIEROS'), 0) AS otros_ingresos_financieros,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'REINVERSION'), 0)                AS reinversion,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'RETIROS'), 0)                    AS retiros,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'RESERVAS_INTERNAS'), 0)          AS reservas_internas,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'INVERSIONES'), 0)                AS inversiones
    FROM pnl_line_item
   GROUP BY period
)
SELECT period,
       ventas_netas_devengadas, costos_directos, costos_indirectos,
       ventas_netas_devengadas + costos_directos + costos_indirectos                                   AS resultado_operativo,
       otros_ingresos_financieros,
       ventas_netas_devengadas + costos_directos + costos_indirectos + otros_ingresos_financieros      AS resultado_antes_de_reinversion,
       reinversion,
       ventas_netas_devengadas + costos_directos + costos_indirectos + otros_ingresos_financieros
         + reinversion                                                                                  AS resultado_post_reinversion,
       retiros,
       ventas_netas_devengadas + costos_directos + costos_indirectos + otros_ingresos_financieros
         + reinversion + retiros                                                                        AS disponible_post_retiros,
       reservas_internas,
       ventas_netas_devengadas + costos_directos + costos_indirectos + otros_ingresos_financieros
         + reinversion + retiros + reservas_internas                                                    AS post_reservas,
       inversiones,
       ventas_netas_devengadas + costos_directos + costos_indirectos + otros_ingresos_financieros
         + reinversion + retiros + reservas_internas + inversiones                                      AS resultado_post_inversiones
  FROM b;

ALTER VIEW pnl_line_item OWNER TO postgres;
ALTER VIEW pnl_summary   OWNER TO postgres;
REVOKE ALL ON pnl_line_item, pnl_summary FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON pnl_line_item, pnl_summary TO authenticated;
