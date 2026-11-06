-- ============================================================================
-- TARGET V1 — 0120 CAJA: TODAS LAS OPERACIONES — CATEGORÍA, PROVEEDOR Y FILTROS (owner GO 2026-11-06, rediseño y simplificación)
--
-- No existing row, balance, posting, allocation or instrument changes. Nothing is backfilled.
-- fin_operation_list (0119) is re-created with a wider signature:
--   · every row carries the expense or invoice it belongs to (current purchase + chain root), found through the recorded links only:
--     the purchase paid by the operation, the pending-expense payment, the invoice allocation (payment or debited cheque) and the
--     Mercado Pago settlement — and from it its Categoría (group), Subcategoría (expense category), Naturaleza and Proveedor
--     (a supplier payment without allocation and an own cheque carry their supplier); "—" when none applies;
--   · filters by category group, subcategory, nature and supplier, and the state Por revisar (unclassified / Mercado Pago to classify or link);
--   · a purchase paid with Mercado Pago whose movement is not linked yet (Lote 4, 0111) is a row of its own (MP_PENDIENTE): its money is
--     the provisional Mercado Pago outflow already listed, so its amount is informative (never counted twice);
--   · the unclassified-expense key of an operation (0101) for its classification action;
--   · the money of the filtered rows (each amount once) next to their count.
-- Editing category / subcategory / nature / supplier keeps using rectify_purchase_details (0117): its restrictions and audit apply.
-- SECURITY DEFINER set unchanged (one function replaced).
-- ============================================================================

DROP FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER);

CREATE FUNCTION fin_operation_list(
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
  p_offset      INTEGER DEFAULT 0
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
           o.root, coalesce(c.supplier_id, o.payee) AS supplier_id, c.expense_category_id AS category_id, c.nature, false AS informativo
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
                   CASE WHEN o2.reason IS NOT NULL AND o2.reason !~* '^(ADR-?\d|phase\d)' THEN o2.reason END,
                   c2.label)
                   FROM financial_operation o2 CROSS JOIN LATERAL fin_movement_class(o2.operation_type::TEXT, o2.external_ref) c2 WHERE o2.id = pg.op_id)),
               'detalle', pg.detalle, 'operation_id', pg.op_id, 'ref_uuid', pg.ref_uuid, 'ref_id', pg.ref_id,
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
ALTER FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, UUID, UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
