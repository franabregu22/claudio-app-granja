-- ============================================================================
-- TARGET V1 — 0122 CAJA: FLUJO DE CAJA REAL, MENSUAL / SEMANAL (owner GO 2026-11-13, caja-mejoras-v2; design approved on the prototype)
--
-- Read only: no row, balance, posting or classification changes. Nothing is backfilled.
-- fin_cash_flow (RPC, ADMIN, STABLE): the money of every account by period (calendar month, or Monday–Sunday week), from p_from to p_to:
--   · opening — Σ financial_posting before p_from (all accounts: the same source as the balance cards, report_balance_period);
--   · per period and per row: each financial operation ONCE, classified exactly as Todas las operaciones (0119 / 0120) does —
--     TRANSFERENCIA (operation type TRANSFER, or money in and out with a zero total) is left out; a collection (kind COBRO, its corrections
--     included, signed) is income; a "Clasificación de salida" (it reverses a provisional Mercado Pago outflow) is on the outflow side,
--     signed; anything else by the sign of its postings:
--       INGRESO: grouped by its movement label (Cobro, Cobro Mercado Pago, …);
--       EGRESO: grouped by the expense category group and subcategory of the expense it belongs to
--         (recorded links only: paid purchase, pending-expense payment, invoice allocation, debited cheque, Mercado Pago settlement);
--         without one, "Sin categoría" and its movement label (fees, taxes, payments without an invoice, …);
--       OTRO (kind OTRO: opening balances, collection corrections, partner withdrawals, …) apart, by its label — not income nor expense;
--   · per period, net — Σ financial_posting of the period. A transfer whose two sides do not net to zero is the only gap between net
--     and the rows; it is returned as its own row (AJUSTE) so the closing balance always equals opening + net (never reconciled silently).
-- SECURITY DEFINER set +1.
-- ============================================================================

CREATE FUNCTION fin_cash_flow(p_from DATE, p_to DATE, p_grain TEXT DEFAULT 'MONTH')
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_unit TEXT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'INVALID_RANGE: from after to'; END IF;
  IF p_to - p_from > 800 THEN RAISE EXCEPTION 'INVALID_RANGE: at most 800 days'; END IF;
  v_unit := CASE coalesce(p_grain, 'MONTH') WHEN 'MONTH' THEN 'month' WHEN 'WEEK' THEN 'week' END;   -- date_trunc('week') starts on Monday
  IF v_unit IS NULL THEN RAISE EXCEPTION 'INVALID_GRAIN: MONTH or WEEK'; END IF;

  RETURN (
  WITH o AS MATERIALIZED (
    SELECT op.id, date_trunc(v_unit, op.effective_date)::date AS period, c.kind, c.label, pa.total,
           CASE WHEN op.operation_type::TEXT = 'TRANSFER' OR (pa.has_in AND pa.has_out AND pa.total = 0) THEN 'TRANSFERENCIA'
                WHEN c.kind = 'OTRO' THEN 'OTRO'
                WHEN c.kind = 'COBRO' THEN 'INGRESO'                               -- a collection correction subtracts from income
                WHEN c.label = 'Clasificación de salida' THEN 'EGRESO'             -- reverses a provisional Mercado Pago outflow
                WHEN pa.total > 0 THEN 'INGRESO' ELSE 'EGRESO' END AS tipo
      FROM financial_operation op
     CROSS JOIN LATERAL fin_movement_class(op.operation_type::TEXT, op.external_ref) c
     CROSS JOIN LATERAL (SELECT sum(p.signed_amount) AS total, bool_or(p.signed_amount > 0) AS has_in, bool_or(p.signed_amount < 0) AS has_out
                           FROM financial_posting p WHERE p.financial_operation_id = op.id) pa
     WHERE op.effective_date BETWEEN p_from AND p_to AND pa.total IS NOT NULL
  ), lk AS MATERIALIZED (   -- the expense an EGRESO belongs to (the 0120 link priority), only for the operations of the range
    SELECT DISTINCT ON (x.op) x.op, x.root FROM (
      SELECT p.paid_operation_id AS op, purchase_chain_root(p.id) AS root, 1 AS prio FROM purchases p
       WHERE p.paid_operation_id IN (SELECT id FROM o WHERE tipo = 'EGRESO')
      UNION ALL SELECT ep.financial_operation_id, e.purchase_root_id, 2 FROM expense_payable_payment ep JOIN expense_payable e ON e.id = ep.payable_id
       WHERE ep.financial_operation_id IN (SELECT id FROM o WHERE tipo = 'EGRESO')
      UNION ALL SELECT a.financial_operation_id, a.purchase_root_id, 3 FROM purchase_payment_allocation a
       WHERE a.financial_operation_id IN (SELECT id FROM o WHERE tipo = 'EGRESO')
      UNION ALL SELECT ev.financial_operation_id, a.purchase_root_id, 4 FROM financial_instrument_event ev
        JOIN purchase_payment_allocation a ON a.financial_instrument_id = ev.financial_instrument_id
       WHERE ev.financial_operation_id IN (SELECT id FROM o WHERE tipo = 'EGRESO')
      UNION ALL SELECT s.financial_operation_id, s.purchase_root_id, 5 FROM purchase_mp_settlement s
       WHERE s.financial_operation_id IN (SELECT id FROM o WHERE tipo = 'EGRESO')
    ) x ORDER BY x.op, x.prio, x.root
  ), cat AS (   -- the current version of that expense → its subcategory (expense category) and group
    SELECT lk.op, g.nombre AS grupo, ec.nombre AS sub
      FROM lk JOIN purchases pu ON pu.is_current AND purchase_chain_root(pu.id) = lk.root
      LEFT JOIN expense_category ec ON ec.id = pu.expense_category_id
      LEFT JOIN expense_category_group g ON g.id = ec.group_id
  ), filas AS (
    SELECT o.period, o.tipo,
           CASE o.tipo WHEN 'EGRESO' THEN coalesce(cat.grupo, 'Sin categoría') ELSE o.label END AS grupo,
           CASE o.tipo WHEN 'EGRESO' THEN coalesce(cat.sub, o.label) ELSE NULL END AS sub,
           o.total AS amount
      FROM o LEFT JOIN cat ON cat.op = o.id
     WHERE o.tipo <> 'TRANSFERENCIA'
  ), net AS (
    SELECT date_trunc(v_unit, p.effective_date)::date AS period, sum(p.signed_amount) AS net
      FROM financial_posting p WHERE p.effective_date BETWEEN p_from AND p_to GROUP BY 1
  ), agg AS (
    SELECT period, tipo, grupo, sub, sum(amount) AS amount FROM filas GROUP BY period, tipo, grupo, sub
    UNION ALL   -- a transfer whose sides do not net to zero: the only gap between the period's postings and its rows
    SELECT n.period, 'AJUSTE', 'Transferencias con diferencia', NULL, n.net - coalesce((SELECT sum(f.amount) FROM filas f WHERE f.period = n.period), 0)
      FROM net n WHERE n.net - coalesce((SELECT sum(f.amount) FROM filas f WHERE f.period = n.period), 0) <> 0
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'grain', coalesce(p_grain, 'MONTH'),
    'opening', (SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE effective_date < p_from),
    'net', coalesce((SELECT jsonb_agg(jsonb_build_object('period', period, 'net', net) ORDER BY period) FROM net), '[]'::jsonb),
    'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('period', period, 'tipo', tipo, 'grupo', grupo, 'sub', sub, 'amount', amount)
                                       ORDER BY period, tipo, grupo, sub) FROM agg WHERE amount <> 0), '[]'::jsonb)
  ));
END $$;
ALTER FUNCTION fin_cash_flow(DATE, DATE, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_cash_flow(DATE, DATE, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION fin_cash_flow(DATE, DATE, TEXT) TO authenticated;
