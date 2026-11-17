-- ============================================================================
-- TARGET V1 — 0130 REVERTIR EL PAGO DE UN GASTO SIN PROVEEDOR (owner 2026-11-17; backlog B1)
--
--   «Un gasto pagado puedo revertirlo a pendiente de pago». Scope chosen by the owner: expenses WITHOUT a registered supplier paid
--   from a cash or bank account. Supplier invoices keep their own circuit (supplier payments, allocations, cheques).
--   reverse_expense_payment(p_purchase_id, p_payment_operation_id, p_reason, p_idempotency_key) — SECURITY DEFINER, ADMIN:
--     AT_REGISTRATION  the current version was born paid (paid_operation_id = the operation): a new version of the expense without
--                      the payment (RECTIFY:<old>:v<n>, lines / attachments / freight copied) and its obligation (expense_payable,
--                      amount = the expense total) — a normal pending expense from now on;
--     PAYABLE_PAYMENT  a payment of a pending expense (expense_payable_payment): it stops counting (expense_payable_paid).
--     Both: ADJUSTMENT operation 'EXPENSE-PAYMENT-REVERSAL:<op>' on the ORIGINAL date with ONE posting +amount on the original
--     account (append-only: the payment stays as evidence, its effect is compensated), the expense_payment_reversal row and
--     audit_events REVERSE_PAYMENT. P&L untouched (pnl_line_item reads purchases by economic date, never operations).
--   Guards (before any write): ADMIN; reason; idempotency key (same key → replay; other → ALREADY_REVERSED); serialised per
--   operation; current version, no supplier, not annulled; the operation IS that expense's payment; paying account CASH /
--   BANK_ACCOUNT (Mercado Pago never); its posting not matched with a bank statement line (BANK_MATCHED); a pending-expense
--   payment not linked to a payment-plan item (PAYMENT_IN_PLAN); period of the original date open (assert_period_open).
--   Readers: expense_payable_paid excludes reversed payments (fin_expense_payables, pay_pending_expense, annul_expense,
--   rectify_purchase_details follow); fin_movement_class labels the reversal «Reversión de pago» (kind PAGO); fin_cash_flow
--   counts it as an EGRESO of the same expense (it nets in its category); a payable with a reversed payment is never linked to
--   a supplier (expense_payable_supplier_link guard: its paid_before copies payments).
-- ============================================================================

CREATE TABLE expense_payment_reversal (
  id                         BIGSERIAL PRIMARY KEY,
  kind                       VARCHAR(20) NOT NULL CHECK (kind IN ('AT_REGISTRATION', 'PAYABLE_PAYMENT')),
  purchase_root_id           UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id                UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the version reversed
  new_purchase_id            UUID UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,     -- AT_REGISTRATION: the unpaid version
  payable_id                 UUID NOT NULL REFERENCES expense_payable(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  payment_operation_id       BIGINT NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_payable_payment_id BIGINT UNIQUE REFERENCES expense_payable_payment(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id       UUID NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  effective_date             DATE NOT NULL,
  reversal_operation_id      BIGINT NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key            VARCHAR(100) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  reason                     TEXT NOT NULL CHECK (btrim(reason) <> ''),
  created_by                 UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_epr_kind CHECK ((kind = 'AT_REGISTRATION') = (new_purchase_id IS NOT NULL)
                             AND (kind = 'PAYABLE_PAYMENT') = (expense_payable_payment_id IS NOT NULL))
);
CREATE INDEX idx_epr_root ON expense_payment_reversal(purchase_root_id);
CREATE INDEX idx_epr_payable ON expense_payment_reversal(payable_id);
ALTER TABLE expense_payment_reversal ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_expense_payment_reversal_immutable BEFORE UPDATE OR DELETE ON expense_payment_reversal
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE expense_payment_reversal FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE expense_payment_reversal TO authenticated;
REVOKE ALL ON SEQUENCE expense_payment_reversal_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY expense_payment_reversal_admin_select ON expense_payment_reversal FOR SELECT USING (current_app_role() = 'ADMIN');

-- what is paid of a pending expense: its payments that were not reversed (0106 body + the reversal filter)
CREATE OR REPLACE FUNCTION expense_payable_paid(p_payable UUID) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(sum(p.amount), 0) FROM expense_payable_payment p
   WHERE p.payable_id = p_payable
     AND NOT EXISTS (SELECT 1 FROM expense_payment_reversal r WHERE r.expense_payable_payment_id = p.id);
$$;

-- a pending expense with a reversed payment is not linked to a supplier (the link copies its payments as paid_before)
CREATE FUNCTION expense_payable_link_reversal_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM expense_payment_reversal WHERE payable_id = NEW.payable_id) THEN
    RAISE EXCEPTION 'PAYMENT_REVERSED: this pending expense had a payment reversed; it cannot be linked to a supplier';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION expense_payable_link_reversal_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_payable_link_reversal_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_epsl_reversal_guard BEFORE INSERT ON expense_payable_supplier_link FOR EACH ROW EXECUTE FUNCTION expense_payable_link_reversal_guard();

CREATE FUNCTION reverse_expense_payment(p_purchase_id UUID, p_payment_operation_id BIGINT, p_reason TEXT, p_idempotency_key VARCHAR)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_rsn     TEXT := nullif(btrim(p_reason), '');
  v_row     expense_payment_reversal;
  v_old     purchases;
  v_root    UUID;
  v_kind    TEXT;
  v_epp     expense_payable_payment;
  v_payable UUID;
  v_op      financial_operation;
  v_post    financial_posting;
  v_type    TEXT;
  v_rev     BIGINT;
  v_new     UUID;
  v_version INT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF v_rsn IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED'; END IF;
  IF p_purchase_id IS NULL OR p_payment_operation_id IS NULL THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('expense_payment_reversal:' || p_payment_operation_id::text, 0));
  SELECT * INTO v_row FROM expense_payment_reversal WHERE payment_operation_id = p_payment_operation_id;
  IF FOUND THEN
    IF v_row.idempotency_key = p_idempotency_key THEN
      RETURN jsonb_build_object('replayed', true, 'reversal_id', v_row.id, 'kind', v_row.kind, 'reversal_operation_id', v_row.reversal_operation_id,
        'purchase_root_id', v_row.purchase_root_id, 'payable_id', v_row.payable_id, 'new_purchase_id', v_row.new_purchase_id);
    END IF;
    RAISE EXCEPTION 'ALREADY_REVERSED: that payment was already reversed';
  END IF;
  IF EXISTS (SELECT 1 FROM expense_payment_reversal WHERE idempotency_key = p_idempotency_key) THEN RAISE EXCEPTION 'DUPLICATE_IDEMPOTENCY_KEY'; END IF;

  SELECT * INTO v_old FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF NOT v_old.is_current THEN RAISE EXCEPTION 'PURCHASE_SUPERSEDED: use the current version'; END IF;
  IF v_old.supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLIER_EXPENSE: the payment of a supplier invoice is reversed in its own circuit';
  END IF;
  v_root := purchase_chain_root(v_old.id);
  IF EXISTS (SELECT 1 FROM purchase_annulment WHERE purchase_root_id = v_root) THEN RAISE EXCEPTION 'EXPENSE_ANNULLED'; END IF;

  IF v_old.paid_operation_id = p_payment_operation_id THEN
    v_kind := 'AT_REGISTRATION';
  ELSE
    SELECT p.* INTO v_epp FROM expense_payable_payment p JOIN expense_payable e ON e.id = p.payable_id
     WHERE e.purchase_root_id = v_root AND p.financial_operation_id = p_payment_operation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND: that operation is not a payment of this expense'; END IF;
    v_kind := 'PAYABLE_PAYMENT';
    v_payable := v_epp.payable_id;
    IF EXISTS (SELECT 1 FROM payment_plan_item_link WHERE financial_operation_id = p_payment_operation_id) THEN
      RAISE EXCEPTION 'PAYMENT_IN_PLAN: the payment covers a payment-plan item';
    END IF;
  END IF;

  SELECT * INTO v_op FROM financial_operation WHERE id = p_payment_operation_id;
  IF (SELECT count(*) FROM financial_posting WHERE financial_operation_id = v_op.id) <> 1 THEN
    RAISE EXCEPTION 'PAYMENT_NOT_SUPPORTED: the payment does not have exactly one posting';
  END IF;
  SELECT * INTO v_post FROM financial_posting WHERE financial_operation_id = v_op.id FOR UPDATE;   -- the row fin_match_statement_line locks
  IF v_post.signed_amount >= 0 THEN RAISE EXCEPTION 'PAYMENT_NOT_SUPPORTED: the operation is not an outflow'; END IF;
  SELECT account_type::TEXT INTO v_type FROM financial_account WHERE id = v_post.financial_account_id;
  IF v_type IS DISTINCT FROM 'CASH' AND v_type IS DISTINCT FROM 'BANK_ACCOUNT' THEN
    RAISE EXCEPTION 'PAYMENT_ACCOUNT_NOT_SUPPORTED: only cash and bank payments are reversed here (Mercado Pago never)';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_match WHERE financial_posting_id = v_post.id AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'BANK_MATCHED: the payment is reconciled with a bank statement line; reverse that match first';
  END IF;
  PERFORM assert_period_open(v_post.effective_date);

  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', v_post.effective_date, 'EXPENSE-PAYMENT-REVERSAL:' || v_op.id, 'purchases', v_root::TEXT, v_rsn, v_uid)
  RETURNING id INTO v_rev;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_rev, v_post.financial_account_id, -v_post.signed_amount, v_post.effective_date, v_uid);

  IF v_kind = 'AT_REGISTRATION' THEN
    -- the expense becomes a pending one: a version without the payment (the chain keeps its root) and its obligation
    v_version := v_old.version_seq + 1;
    UPDATE purchases SET is_current = false WHERE id = v_old.id;
    INSERT INTO purchases (supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
           project_id, fiscal_document_id, supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
    VALUES (NULL, v_old.counterparty_name, v_old.economic_date, v_old.amount_net, v_old.amount_total, v_old.expense_category_id, v_old.subcategory,
            v_old.nature, v_old.project_id, v_old.fiscal_document_id, v_old.supplier_invoice_number, v_old.flock_id, NULL, true, v_version,
            'RECTIFY:' || v_old.id::TEXT || ':v' || v_version, v_uid)
    RETURNING id INTO v_new;
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario)
    SELECT v_new, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario FROM purchase_line WHERE purchase_id = v_old.id;
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
    SELECT v_new, storage_path, file_name, content_type, byte_size, v_uid FROM purchase_attachment WHERE purchase_id = v_old.id;
    UPDATE freight_allocation SET purchase_id = v_new WHERE purchase_id = v_old.id;
    INSERT INTO expense_payable (purchase_root_id, amount, due_date, origin, idempotency_key, reason, created_by)
    VALUES (v_root, v_old.amount_total, NULL, 'ERP', 'PAYMENT-REVERSAL:' || p_idempotency_key, v_rsn, v_uid)
    RETURNING id INTO v_payable;
  END IF;

  INSERT INTO expense_payment_reversal (kind, purchase_root_id, purchase_id, new_purchase_id, payable_id, payment_operation_id, expense_payable_payment_id,
         financial_account_id, amount, effective_date, reversal_operation_id, idempotency_key, reason, created_by)
  VALUES (v_kind, v_root, v_old.id, v_new, v_payable, v_op.id, CASE WHEN v_kind = 'PAYABLE_PAYMENT' THEN v_epp.id END,
          v_post.financial_account_id, -v_post.signed_amount, v_post.effective_date, v_rev, p_idempotency_key, v_rsn, v_uid)
  RETURNING * INTO v_row;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', v_old.id::TEXT, 'REVERSE_PAYMENT',
          jsonb_build_object('estado', 'PAGADO', 'payment_operation_id', v_op.id, 'amount', v_row.amount, 'account_id', v_row.financial_account_id,
                             'effective_date', v_row.effective_date),
          jsonb_build_object('estado', 'PENDIENTE', 'kind', v_kind, 'reversal_operation_id', v_rev, 'payable_id', v_payable, 'new_id', v_new, 'root_id', v_root),
          v_rsn, v_uid);
  RETURN jsonb_build_object('replayed', false, 'reversal_id', v_row.id, 'kind', v_kind, 'reversal_operation_id', v_rev,
    'purchase_root_id', v_root, 'payable_id', v_payable, 'new_purchase_id', v_new);
END $$;
ALTER FUNCTION reverse_expense_payment(UUID, BIGINT, TEXT, VARCHAR) OWNER TO postgres;
REVOKE ALL ON FUNCTION reverse_expense_payment(UUID, BIGINT, TEXT, VARCHAR) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION reverse_expense_payment(UUID, BIGINT, TEXT, VARCHAR) TO authenticated;

-- ── Caja → Movimientos: the reversal reads «Reversión de pago» (0114 classifier, one reference added first) ─────────────
CREATE OR REPLACE FUNCTION fin_movement_class(p_type TEXT, p_ref TEXT, OUT kind TEXT, OUT label TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      WHEN p_ref LIKE 'PURCHASE-PAY:STMT-LINE:%' THEN 'CARGO'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'EXPENSE-PAYMENT-REVERSAL:%' THEN 'PAGO'
      WHEN p_ref LIKE 'MP-PENDING%' THEN 'PENDIENTE_MP'
      WHEN p_type = 'TRANSFER' THEN 'TRANSFERENCIA'
      WHEN p_ref LIKE 'MP-INBOUND-RECLASS:%' THEN 'OTRO'
      WHEN p_type IN ('COLLECTION', 'MP_SETTLEMENT', 'CHEQUE_CLEAR') THEN 'COBRO'
      WHEN p_type IN ('SUPPLIER_PAYMENT', 'PURCHASE_PAYMENT', 'FREIGHT_PAYMENT', 'INSTRUMENT_DEBIT', 'FISCAL_PAYMENT') THEN 'PAGO'
      WHEN p_type IN ('BANK_TAX', 'FEE') OR p_ref LIKE 'MP-OUTFLOW-TAX:%' OR (p_type = 'ADJUSTMENT' AND p_ref LIKE 'MP:%') THEN 'CARGO'
      ELSE 'OTRO'
    END,
    CASE
      WHEN p_ref LIKE 'PURCHASE-PAY:STMT-LINE:%' THEN 'Cargo bancario'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'EXPENSE-PAYMENT-REVERSAL:%' THEN 'Reversión de pago'
      WHEN p_ref LIKE 'MP-PENDING-RELEASE:%' THEN 'Clasificación de salida'
      WHEN p_ref LIKE 'MP-PENDING:%' THEN 'Pendiente de clasificar'
      WHEN p_ref LIKE 'EXPENSE-PENDING:%' THEN 'Gasto (sin clasificar al registrarse)'
      WHEN p_ref LIKE 'MP-INBOUND-RECLASS:%' THEN 'Reclasificación de entrada Mercado Pago'
      WHEN p_ref LIKE 'MP-OUTFLOW-TAX:%' THEN 'Impuesto Débitos/Créditos (Mercado Pago)'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'MP:%' THEN 'Impuesto de Mercado Pago'
      WHEN p_ref LIKE 'COLLECTION-CORRECTION%' THEN 'Corrección de cobro'
      WHEN p_ref LIKE 'PHASE31-OPENING%' THEN 'Saldo inicial'
      WHEN p_ref LIKE 'MP-HIST-OPENING-NEUTRALIZATION:%' THEN 'Neutralización de saldo inicial'
      WHEN p_type = 'TRANSFER' THEN 'Transferencia'
      WHEN p_type = 'FEE' THEN 'Comisión'
      WHEN p_type = 'COLLECTION' THEN 'Cobro'
      WHEN p_type = 'CHEQUE_CLEAR' THEN 'Cheque acreditado'
      WHEN p_type = 'CHEQUE_REJECTION' THEN 'Cheque rechazado'
      WHEN p_type = 'SUPPLIER_PAYMENT' THEN 'Pago a proveedor'
      WHEN p_type = 'PURCHASE_PAYMENT' THEN 'Pago de compra'
      WHEN p_type = 'FREIGHT_PAYMENT' THEN 'Pago de flete'
      WHEN p_type = 'INSTRUMENT_DEBIT' THEN 'Cheque debitado'
      WHEN p_type = 'INSTRUMENT_DEBIT_REVERSAL' THEN 'Reversión de cheque debitado'
      WHEN p_type = 'FISCAL_PAYMENT' THEN 'Pago fiscal'
      WHEN p_type = 'SESSION_CASH' THEN 'Efectivo de feria'
      WHEN p_type = 'MP_SETTLEMENT' THEN 'Cobro Mercado Pago'
      WHEN p_type = 'OWNER_WITHDRAWAL' THEN 'Retiro de socios'
      WHEN p_type = 'BANK_TAX' THEN 'Impuesto bancario'
      WHEN p_type = 'ADJUSTMENT' THEN 'Ajuste'
      ELSE p_type
    END;
$$;

-- ── Flujo de caja: the reversal is an EGRESO of the same expense (0122 body, two additions) ─────────────
CREATE OR REPLACE FUNCTION fin_cash_flow(p_from DATE, p_to DATE, p_grain TEXT DEFAULT 'MONTH')
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
                WHEN c.label = 'Reversión de pago' THEN 'EGRESO'                   -- 0130: gives back an expense payment (nets in its category)
                WHEN pa.total > 0 THEN 'INGRESO' ELSE 'EGRESO' END AS tipo
      FROM financial_operation op
     CROSS JOIN LATERAL fin_movement_class(op.operation_type::TEXT, op.external_ref) c
     CROSS JOIN LATERAL (SELECT sum(p.signed_amount) AS total, bool_or(p.signed_amount > 0) AS has_in, bool_or(p.signed_amount < 0) AS has_out
                           FROM financial_posting p WHERE p.financial_operation_id = op.id) pa
     WHERE op.effective_date BETWEEN p_from AND p_to AND pa.total IS NOT NULL
  ), lk AS MATERIALIZED (   -- the expense an EGRESO belongs to (the 0120 link priority), only for the operations of the range
    SELECT DISTINCT ON (x.op) x.op, x.root FROM (
      SELECT r.reversal_operation_id AS op, r.purchase_root_id AS root, 0 AS prio FROM expense_payment_reversal r   -- 0130
       WHERE r.reversal_operation_id IN (SELECT id FROM o WHERE tipo = 'EGRESO')
      UNION ALL
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
