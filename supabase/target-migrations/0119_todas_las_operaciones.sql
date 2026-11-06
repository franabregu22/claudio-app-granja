-- ============================================================================
-- TARGET V1 — 0119 CAJA: TODAS LAS OPERACIONES (owner GO 2026-11-06, rediseño de Caja)
--
-- No existing row, balance, posting, allocation or instrument changes. Nothing is backfilled. fin_movement_list (0116) stays.
--   1. fin_operation_list (RPC, ADMIN, STABLE): ONE paginated list of everything recorded, each amount once:
--      · OP — every financial operation with postings (a transfer between own accounts is one row): Ingreso / Egreso / Transferencia,
--        always completed (Cobrado / Pagado / Realizada); its bank reconciliation and its classification are separate fields;
--      · GASTO — a pending expense without supplier (0106) while something is unpaid: the UNPAID remainder (its partial payments
--        are their own OP rows), no account;
--      · FACTURA — a supplier invoice while something is unpaid: amount_total − debited cheques − other payments (cheques issued
--        and not yet debited are inside it and shown in its detail, never as rows of their own), no account;
--      · CHEQUE — an own cheque / eCheq ISSUED and allocated to no invoice: pending egreso on its bank account;
--      · CHEQUE_RECIBIDO — a client cheque received or deposited, not yet credited: pending ingreso;
--      · TRANSFERENCIA — an anticipated transfer (0116) still PENDIENTE.
--      Filters: dates (operation / document date), type, account (or "Sin asignar"), state, text or amount; order by date or by
--      loading time; p_focus returns exactly one row by its key (a just-recorded operation, whatever its date).
--   2. pay_purchase_invoice (ADMIN): pays a supplier invoice from its row by cash or transfer — pay_supplier (ONE movement on the
--      account) + allocate_purchase_payment to that invoice, in one transaction; never above what is unpaid (debited and scheduled
--      cheques count); Mercado Pago refused (0091); replay by key returns the recorded result; one audit row PAY_INVOICE.
--   3. fin_operation_timeline (RPC, ADMIN, STABLE): the audited chronology of one row — only recorded facts (creation rows,
--      audit_events, statement matches, payments, allocations, cheque events, payment-date history); nothing is invented.
-- SECURITY DEFINER set +3.
-- ============================================================================

-- ── 1. the unified list ───────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_operation_list(
  p_from       DATE    DEFAULT NULL,
  p_to         DATE    DEFAULT NULL,
  p_tipo       TEXT    DEFAULT NULL,
  p_account_id UUID    DEFAULT NULL,
  p_sin_cuenta BOOLEAN DEFAULT false,
  p_estado     TEXT    DEFAULT NULL,
  p_search     TEXT    DEFAULT NULL,
  p_amount     NUMERIC DEFAULT NULL,
  p_order      TEXT    DEFAULT 'FECHA',
  p_focus      TEXT    DEFAULT NULL,
  p_limit      INTEGER DEFAULT 50,
  p_offset     INTEGER DEFAULT 0
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
  IF p_estado IS NOT NULL AND p_estado NOT IN ('PENDIENTE', 'COMPLETADA') THEN RAISE EXCEPTION 'INVALID_ESTADO'; END IF;
  IF coalesce(p_order, 'FECHA') NOT IN ('FECHA', 'CARGA') THEN RAISE EXCEPTION 'INVALID_ORDER'; END IF;
  IF length(v_search) > 100 OR length(v_focus) > 120 THEN RAISE EXCEPTION 'INVALID_SEARCH: too long'; END IF;
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE';

  RETURN (
  WITH ops AS MATERIALIZED (
    SELECT o.id, o.effective_date, o.created_at, o.created_by, o.operation_type::TEXT AS operation_type, o.external_ref, o.reason, o.source_entity_type,
           o.source_entity_id, c.kind, c.label, pa.total, pa.has_in, pa.has_out,
           CASE WHEN o.operation_type::TEXT = 'TRANSFER' OR (pa.has_in AND pa.has_out AND pa.total = 0) THEN 'TRANSFERENCIA'
                WHEN pa.total > 0 THEN 'INGRESO' ELSE 'EGRESO' END AS tipo,
           concat_ws(' ', sp.nombre, cl.nombre, pu.subcategory, pu.counterparty_name, ie.nm, al.nm) AS names
      FROM financial_operation o
     CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c
     CROSS JOIN LATERAL (SELECT sum(p.signed_amount) AS total, bool_or(p.signed_amount > 0) AS has_in, bool_or(p.signed_amount < 0) AS has_out
                           FROM financial_posting p WHERE p.financial_operation_id = o.id) pa
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
    SELECT f.purchase_id, f.purchase_root_id, f.supplier_name, f.supplier_invoice_number, f.economic_date, f.amount_total, f.scheduled, f.debited,
           f.other_payments, f.amount_total - f.debited - f.other_payments AS unpaid, f.due_date, f.planned_date,
           (SELECT min(pu.created_at) FROM purchases pu WHERE purchase_chain_root(pu.id) = f.purchase_root_id) AS created_at,
           (SELECT pu.subcategory FROM purchases pu WHERE pu.id = f.purchase_id) AS concept
      FROM fin_purchase_payment_status f WHERE f.amount_total - f.debited - f.other_payments > 0
  ), u AS (
    SELECT 'OP:' || o.id AS row_key, 'OP' AS row_kind, o.effective_date AS d, o.created_at AS ca, o.tipo,
           CASE WHEN o.tipo = 'INGRESO' THEN o.total ELSE -abs(CASE WHEN o.tipo = 'TRANSFERENCIA' THEN (SELECT sum(p.signed_amount) FILTER (WHERE p.signed_amount > 0) FROM financial_posting p WHERE p.financial_operation_id = o.id) ELSE o.total END) END AS amount,
           'COMPLETADA' AS estado, NULL::TEXT AS concepto, o.label AS detalle,
           (SELECT array_agg(DISTINCT p.financial_account_id) FROM financial_posting p WHERE p.financial_operation_id = o.id) AS accounts,
           o.id AS op_id, NULL::UUID AS ref_uuid, NULL::BIGINT AS ref_id,
           concat_ws(' ', o.names, o.label, o.reason, o.external_ref) AS hay
      FROM ops o
    UNION ALL
    SELECT 'GASTO:' || e.payable_id, 'GASTO', e.economic_date, e.created_at, 'EGRESO', -e.pending, 'PENDIENTE', coalesce(e.concept, e.counterparty_name, 'Gasto a pagar'),
           'Gasto pendiente de pago' || CASE WHEN e.paid > 0 THEN ' (resto)' ELSE '' END, NULL::UUID[], NULL::BIGINT, e.payable_id, NULL::BIGINT,
           concat_ws(' ', e.concept, e.counterparty_name, e.category_name)
      FROM pend_exp e
    UNION ALL
    SELECT 'FACTURA:' || f.purchase_root_id, 'FACTURA', f.economic_date, f.created_at, 'EGRESO', -f.unpaid, 'PENDIENTE',
           f.supplier_name || coalesce(' · Factura ' || f.supplier_invoice_number, ''),
           'Factura de proveedor pendiente' || CASE WHEN f.scheduled > 0 THEN ' · con cheques por debitar' ELSE '' END, NULL::UUID[], NULL::BIGINT, f.purchase_root_id, NULL::BIGINT,
           concat_ws(' ', f.supplier_name, f.supplier_invoice_number, f.concept)
      FROM pend_inv f
    UNION ALL
    SELECT 'CHEQUE:' || i.id, 'CHEQUE', coalesce(i.maturity_date, i.issued_date), i.created_at, 'EGRESO', -i.amount, 'PENDIENTE',
           CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || coalesce(' · ' || s.nombre, ''),
           'Cheque propio por debitar', ARRAY[i.bank_account_id], NULL::BIGINT, i.id, NULL::BIGINT,
           concat_ws(' ', i.cheque_number, s.nombre)
      FROM financial_instrument i LEFT JOIN suppliers s ON s.id = i.supplier_id
     WHERE i.direction::TEXT = 'ISSUED' AND i.estado::TEXT = 'ISSUED'
       AND NOT EXISTS (SELECT 1 FROM purchase_payment_allocation a WHERE a.financial_instrument_id = i.id)
    UNION ALL
    SELECT 'CHEQUE_RECIBIDO:' || i.id, 'CHEQUE_RECIBIDO', coalesce(i.maturity_date, i.received_date), i.created_at, 'INGRESO', i.amount, 'PENDIENTE',
           CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || coalesce(' · ' || cl.nombre, ''),
           CASE i.estado::TEXT WHEN 'DEPOSITED' THEN 'Cheque recibido depositado, por acreditar' ELSE 'Cheque recibido en cartera' END,
           CASE WHEN i.bank_account_id IS NOT NULL THEN ARRAY[i.bank_account_id] END, NULL::BIGINT, i.id, NULL::BIGINT,
           concat_ws(' ', i.cheque_number, cl.nombre)
      FROM financial_instrument i LEFT JOIN clients cl ON cl.id = i.cliente_id
     WHERE i.direction::TEXT = 'RECEIVED' AND i.estado::TEXT IN ('RECEIVED', 'DEPOSITED')
    UNION ALL
    SELECT 'TRANSFERENCIA:' || t.id, 'TRANSFERENCIA', t.effective_date, t.created_at, 'TRANSFERENCIA', -t.amount, 'PENDIENTE',
           fa.nombre || ' → ' || ta.nombre, 'Transferencia anticipada, esperando su movimiento', ARRAY[t.from_account_id, t.to_account_id], NULL::BIGINT, NULL::UUID, t.id,
           concat_ws(' ', fa.nombre, ta.nombre, t.reason)
      FROM fin_transfer_intent t JOIN financial_account fa ON fa.id = t.from_account_id JOIN financial_account ta ON ta.id = t.to_account_id
     WHERE t.status = 'PENDIENTE'
  ), fl AS MATERIALIZED (
    SELECT * FROM u
     WHERE (v_focus IS NOT NULL AND u.row_key = v_focus)
        OR (v_focus IS NULL
            AND (p_from IS NULL OR u.d >= p_from) AND (p_to IS NULL OR u.d <= p_to)
            AND (p_tipo IS NULL OR u.tipo = p_tipo)
            AND (p_estado IS NULL OR u.estado = p_estado)
            AND (p_account_id IS NULL OR p_account_id = ANY (u.accounts))
            AND (NOT coalesce(p_sin_cuenta, false) OR u.accounts IS NULL)
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
    'rows', coalesce((SELECT jsonb_agg(r.j ORDER BY r.n) FROM (
      SELECT row_number() OVER (ORDER BY CASE WHEN coalesce(p_order, 'FECHA') = 'CARGA' THEN pg.ca END DESC NULLS LAST, pg.d DESC NULLS LAST, pg.ca DESC NULLS LAST, pg.row_key DESC) AS n,
             jsonb_build_object(
               'row_key', pg.row_key, 'row_kind', pg.row_kind, 'date', pg.d, 'created_at', pg.ca, 'tipo', pg.tipo, 'amount', pg.amount,
               'estado', pg.estado, 'concepto', coalesce(pg.concepto, (SELECT coalesce(
             (SELECT coalesce(pu.subcategory, pu.counterparty_name) FROM purchases pu WHERE pu.paid_operation_id = o2.id AND pu.is_current LIMIT 1),
             (SELECT coalesce(pu.subcategory, pu.counterparty_name) FROM expense_payable_payment ep JOIN expense_payable e ON e.id = ep.payable_id
                JOIN purchases pu ON pu.is_current AND purchase_chain_root(pu.id) = e.purchase_root_id WHERE ep.financial_operation_id = o2.id LIMIT 1),
             (SELECT 'Pago a ' || s.nombre || coalesce(' · Factura ' || string_agg(DISTINCT pu.supplier_invoice_number, ', '), '')
                FROM purchase_payment_allocation a JOIN purchases pu ON pu.is_current AND purchase_chain_root(pu.id) = a.purchase_root_id
                JOIN suppliers s ON s.id = pu.supplier_id WHERE a.financial_operation_id = o2.id GROUP BY s.nombre LIMIT 1),
             (SELECT CASE i.instrument_type::TEXT WHEN 'ECHEQ' THEN 'eCheq ' ELSE 'Cheque ' END || coalesce(i.cheque_number, '') || ' · ' || coalesce(s.nombre, cl.nombre, '')
                FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id
                LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN clients cl ON cl.id = i.cliente_id WHERE ev.financial_operation_id = o2.id LIMIT 1),
             (SELECT 'Cobro · ' || cl.nombre FROM collections co JOIN clients cl ON cl.id = co.cliente_id
               WHERE o2.source_entity_type = 'collections' AND co.id::TEXT = o2.source_entity_id),
             (SELECT 'Pago a ' || s.nombre FROM suppliers s WHERE o2.operation_type::TEXT = 'SUPPLIER_PAYMENT' AND s.id::TEXT = o2.source_entity_id),
             CASE WHEN o2.reason IS NOT NULL AND o2.reason !~* '^(ADR-?\d|phase\d)' THEN o2.reason END,
             c2.label)
                   FROM financial_operation o2 CROSS JOIN LATERAL fin_movement_class(o2.operation_type::TEXT, o2.external_ref) c2 WHERE o2.id = pg.op_id)), 'detalle', pg.detalle, 'operation_id', pg.op_id, 'ref_uuid', pg.ref_uuid, 'ref_id', pg.ref_id,
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
                   WHEN pg.op_id IS NULL THEN NULL
                   WHEN (SELECT c.kind FROM financial_operation o CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c WHERE o.id = pg.op_id) = 'PENDIENTE_MP' THEN 'MP_SIN_CLASIFICAR'
                   WHEN EXISTS (SELECT 1 FROM expense_pending_classification e WHERE e.payment_operation_id = pg.op_id
                                 AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = e.payment_operation_id AND pu.is_current)) THEN 'GASTO_SIN_CLASIFICAR' END,
               'pendiente', CASE pg.row_kind
                   WHEN 'GASTO' THEN (SELECT jsonb_build_object('total', e.amount, 'pagado', e.paid, 'pendiente', e.pending, 'vence', e.due_date, 'estimada', e.planned_date) FROM pend_exp e WHERE e.payable_id = pg.ref_uuid)
                   WHEN 'FACTURA' THEN (SELECT jsonb_build_object('purchase_id', f.purchase_id, 'total', f.amount_total, 'pagado', f.debited + f.other_payments, 'cheques_por_debitar', f.scheduled,
                                         'sin_cubrir', f.amount_total - f.debited - f.other_payments - f.scheduled, 'pendiente', f.unpaid, 'vence', f.due_date, 'estimada', f.planned_date)
                                          FROM pend_inv f WHERE f.purchase_root_id = pg.ref_uuid) END
             ) AS j
        FROM page pg) r), '[]'::jsonb))
  );
END $$;
ALTER FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION fin_operation_list(DATE, DATE, TEXT, UUID, BOOLEAN, TEXT, TEXT, NUMERIC, TEXT, TEXT, INTEGER, INTEGER) TO authenticated;

-- ── 2. paying a supplier invoice from its row ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION pay_purchase_invoice(
  p_purchase_root_id UUID,
  p_amount           NUMERIC,
  p_effective_date   DATE,
  p_payment_method   payment_method,
  p_account_id       UUID,
  p_idempotency_key  VARCHAR,
  p_reference        TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_cur    purchases%ROWTYPE;
  v_acc    financial_account%ROWTYPE;
  v_op     BIGINT;
  v_unpaid NUMERIC;
  v_ref    TEXT := nullif(btrim(p_reference), '');
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 90 characters required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pay_purchase_invoice:' || p_idempotency_key, 0));
  SELECT financial_operation_id INTO v_op FROM purchase_payment_allocation WHERE idempotency_key = p_idempotency_key || ':ALLOC';
  IF FOUND THEN
    RETURN jsonb_build_object('replayed', true, 'financial_operation_id', v_op, 'purchase_root_id', p_purchase_root_id);
  END IF;

  SELECT * INTO v_cur FROM purchases WHERE is_current AND supplier_id IS NOT NULL AND purchase_chain_root(id) = p_purchase_root_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND: a current supplier invoice is required'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_effective_date IS NULL THEN RAISE EXCEPTION 'PAYMENT_DATE_REQUIRED'; END IF;
  IF p_payment_method IS NULL OR p_payment_method::text NOT IN ('CASH', 'TRANSFER') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: cash or transfer (a cheque is issued from the invoice; a Mercado Pago payment is classified from its movement)';
  END IF;
  SELECT * INTO v_acc FROM financial_account WHERE id = p_account_id AND activo;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE'; END IF;
  IF (p_payment_method::text = 'CASH') <> (v_acc.account_type::text = 'CASH')
     OR (p_payment_method::text = 'TRANSFER' AND v_acc.account_type::text <> 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ACCOUNT: cash is paid from a cash account, a transfer from a bank account';
  END IF;
  v_unpaid := v_cur.amount_total - purchase_allocated_amount(p_purchase_root_id);
  IF p_amount > v_unpaid THEN
    RAISE EXCEPTION 'OVER_PAYMENT: % is still to pay on this invoice (cheques already issued count)', v_unpaid;
  END IF;

  v_op := (pay_supplier(v_cur.supplier_id, p_amount, p_effective_date, p_payment_method, p_account_id,
                        ('FACTURA-PAGO:' || p_idempotency_key)::VARCHAR,
                        coalesce('Pago factura ' || v_cur.supplier_invoice_number, 'Pago de factura') || coalesce(' · ref. ' || v_ref, '')) ->> 'financial_operation_id')::BIGINT;
  PERFORM allocate_purchase_payment(v_cur.id, v_op, p_amount, (p_idempotency_key || ':ALLOC')::VARCHAR, v_ref);

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', p_purchase_root_id::TEXT, 'PAY_INVOICE',
          jsonb_build_object('amount', p_amount, 'operation', v_op, 'account', v_acc.id, 'date', p_effective_date, 'method', p_payment_method, 'reference', v_ref),
          v_ref, v_uid);
  RETURN jsonb_build_object('replayed', false, 'financial_operation_id', v_op, 'purchase_root_id', p_purchase_root_id,
                            'pending', v_unpaid - p_amount);
END $$;
ALTER FUNCTION pay_purchase_invoice(UUID, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION pay_purchase_invoice(UUID, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION pay_purchase_invoice(UUID, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) TO authenticated;

-- ── 3. the audited chronology of one row ──────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_operation_timeline(p_row_key TEXT) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_kind TEXT := split_part(p_row_key, ':', 1);
  v_ref  TEXT := substr(p_row_key, length(split_part(p_row_key, ':', 1)) + 2);
  v_op   BIGINT;
  v_root UUID;
  v_ins  UUID[];
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF v_kind NOT IN ('OP', 'GASTO', 'FACTURA', 'CHEQUE', 'CHEQUE_RECIBIDO', 'TRANSFERENCIA') OR v_ref = '' THEN RAISE EXCEPTION 'INVALID_ROW_KEY'; END IF;

  IF v_kind = 'OP' THEN
    v_op := v_ref::BIGINT;
    IF NOT EXISTS (SELECT 1 FROM financial_operation WHERE id = v_op) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
    -- the expense / invoice it pays (its history belongs to this operation too)
    v_root := coalesce(
      (SELECT purchase_chain_root(pu.id) FROM purchases pu WHERE pu.paid_operation_id = v_op LIMIT 1),
      (SELECT e.purchase_root_id FROM expense_payable_payment ep JOIN expense_payable e ON e.id = ep.payable_id WHERE ep.financial_operation_id = v_op LIMIT 1),
      (SELECT a.purchase_root_id FROM purchase_payment_allocation a WHERE a.financial_operation_id = v_op ORDER BY a.id LIMIT 1));
    v_ins := ARRAY(SELECT ev.financial_instrument_id FROM financial_instrument_event ev WHERE ev.financial_operation_id = v_op);
  ELSIF v_kind = 'GASTO' THEN
    SELECT purchase_root_id INTO v_root FROM expense_payable WHERE id = v_ref::UUID;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
  ELSIF v_kind = 'FACTURA' THEN
    v_root := v_ref::UUID;
    v_ins := ARRAY(SELECT a.financial_instrument_id FROM purchase_payment_allocation a WHERE a.purchase_root_id = v_root AND a.financial_instrument_id IS NOT NULL);
  ELSIF v_kind IN ('CHEQUE', 'CHEQUE_RECIBIDO') THEN
    v_ins := ARRAY[v_ref::UUID];
  END IF;

  RETURN coalesce((SELECT jsonb_agg(x.j ORDER BY x.at, x.ord) FROM (
    -- the operation itself (its creation row) and its own audit rows
    SELECT o.created_at AS at, 1 AS ord, jsonb_build_object('at', o.created_at, 'by', o.created_by, 'action', 'OPERACION_REGISTRADA',
             'detail', jsonb_build_object('operation_id', o.id, 'type', o.operation_type, 'date', o.effective_date, 'reason', o.reason,
                        'postings', (SELECT jsonb_agg(jsonb_build_object('account', a.nombre, 'amount', p.signed_amount) ORDER BY p.signed_amount) FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id WHERE p.financial_operation_id = o.id))) AS j
      FROM financial_operation o WHERE o.id = v_op
    UNION ALL
    SELECT a.performed_at, 2, jsonb_build_object('at', a.performed_at, 'by', a.performed_by, 'action', a.action, 'entity', a.entity_type, 'before', a.before_values, 'after', a.after_values, 'reason', a.reason)
      FROM audit_events a WHERE a.entity_type = 'financial_operation' AND a.entity_id = v_op::TEXT
    -- bank reconciliation of its postings
    UNION ALL
    SELECT m.matched_at, 3, jsonb_build_object('at', m.matched_at, 'by', m.matched_by, 'action', 'CONCILIADA',
             'detail', jsonb_build_object('line_date', l.value_date, 'line', l.description_raw, 'amount', l.signed_amount), 'reason', m.reason)
      FROM fin_statement_match m JOIN financial_posting p ON p.id = m.financial_posting_id JOIN fin_statement_line l ON l.id = m.statement_line_id
     WHERE p.financial_operation_id = v_op
    UNION ALL
    SELECT m.reversed_at, 4, jsonb_build_object('at', m.reversed_at, 'by', m.reversed_by, 'action', 'CONCILIACION_REVERTIDA', 'reason', m.reverse_reason)
      FROM fin_statement_match m JOIN financial_posting p ON p.id = m.financial_posting_id WHERE p.financial_operation_id = v_op AND m.reversed_at IS NOT NULL
    -- the expense / invoice chain: creation, rectifications, reclassifications, links, payments (audit rows of every version)
    UNION ALL
    SELECT a.performed_at, 5, jsonb_build_object('at', a.performed_at, 'by', a.performed_by, 'action', a.action, 'entity', a.entity_type, 'before', a.before_values, 'after', a.after_values, 'reason', a.reason)
      FROM audit_events a
     WHERE v_root IS NOT NULL AND a.entity_type = 'purchases'
       AND a.entity_id IN (SELECT pu.id::TEXT FROM purchases pu WHERE purchase_chain_root(pu.id) = v_root UNION SELECT v_root::TEXT)
    UNION ALL
    SELECT a.performed_at, 6, jsonb_build_object('at', a.performed_at, 'by', a.performed_by, 'action', a.action, 'entity', a.entity_type, 'before', a.before_values, 'after', a.after_values, 'reason', a.reason)
      FROM audit_events a JOIN expense_payable e ON e.id::TEXT = a.entity_id
     WHERE v_root IS NOT NULL AND a.entity_type = 'expense_payable' AND e.purchase_root_id = v_root
    UNION ALL
    SELECT d.created_at, 7, jsonb_build_object('at', d.created_at, 'by', d.created_by, 'action', 'FECHA_' || d.date_kind, 'after', jsonb_build_object('date', d.value), 'reason', d.reason)
      FROM purchase_payment_date d WHERE v_root IS NOT NULL AND d.purchase_root_id = v_root
    UNION ALL
    SELECT a.created_at, 8, jsonb_build_object('at', a.created_at, 'by', a.created_by, 'action', 'IMPUTACION',
             'detail', jsonb_build_object('amount', a.amount, 'operation_id', a.financial_operation_id, 'instrument', i.cheque_number), 'reason', a.reason)
      FROM purchase_payment_allocation a LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id
     WHERE (v_kind = 'FACTURA' AND a.purchase_root_id = v_root) OR (v_kind = 'OP' AND a.financial_operation_id = v_op AND v_root IS NULL)
        OR (v_kind = 'OP' AND v_root IS NOT NULL AND a.purchase_root_id = v_root AND a.financial_operation_id = v_op)
    -- cheques: their events and audit rows (payment-date corrections included)
    UNION ALL
    SELECT ev.created_at, 9, jsonb_build_object('at', ev.created_at, 'by', ev.created_by, 'action', 'CHEQUE_' || ev.event_type,
             'detail', jsonb_build_object('cheque', i.cheque_number, 'date', ev.event_date, 'operation_id', ev.financial_operation_id), 'reason', ev.reason)
      FROM financial_instrument_event ev JOIN financial_instrument i ON i.id = ev.financial_instrument_id WHERE ev.financial_instrument_id = ANY (v_ins)
    UNION ALL
    SELECT a.performed_at, 10, jsonb_build_object('at', a.performed_at, 'by', a.performed_by, 'action', a.action, 'entity', a.entity_type, 'before', a.before_values, 'after', a.after_values, 'reason', a.reason,
             'detail', jsonb_build_object('cheque', i.cheque_number))
      FROM audit_events a JOIN financial_instrument i ON i.id::TEXT = a.entity_id
     WHERE a.entity_type = 'financial_instrument' AND i.id = ANY (v_ins)
       -- the lifecycle step already listed by its event (issue, debit, cancellation…) is not repeated by its audit row
       AND NOT EXISTS (SELECT 1 FROM financial_instrument_event ev2 WHERE ev2.financial_instrument_id = i.id AND abs(extract(epoch FROM ev2.created_at - a.performed_at)) < 5)
    -- anticipated transfer
    UNION ALL
    SELECT t.created_at, 11, jsonb_build_object('at', t.created_at, 'by', t.created_by, 'action', 'TRANSFERENCIA_ANTICIPADA', 'detail', jsonb_build_object('amount', t.amount, 'date', t.effective_date), 'reason', t.reason)
      FROM fin_transfer_intent t WHERE (v_kind = 'TRANSFERENCIA' AND t.id::TEXT = v_ref) OR (v_kind = 'OP' AND t.transfer_operation_id = v_op)
    UNION ALL
    SELECT t.linked_at, 12, jsonb_build_object('at', t.linked_at, 'by', t.linked_by, 'action', 'TRANSFERENCIA_VINCULADA', 'detail', jsonb_build_object('operation_id', t.transfer_operation_id))
      FROM fin_transfer_intent t WHERE t.linked_at IS NOT NULL AND ((v_kind = 'TRANSFERENCIA' AND t.id::TEXT = v_ref) OR (v_kind = 'OP' AND t.transfer_operation_id = v_op))
    UNION ALL
    SELECT t.cancelled_at, 13, jsonb_build_object('at', t.cancelled_at, 'by', t.cancelled_by, 'action', 'TRANSFERENCIA_ANULADA', 'reason', t.cancel_reason)
      FROM fin_transfer_intent t WHERE t.cancelled_at IS NOT NULL AND v_kind = 'TRANSFERENCIA' AND t.id::TEXT = v_ref
  ) x WHERE x.at IS NOT NULL), '[]'::jsonb);
END $$;
ALTER FUNCTION fin_operation_timeline(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_operation_timeline(TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION fin_operation_timeline(TEXT) TO authenticated;
