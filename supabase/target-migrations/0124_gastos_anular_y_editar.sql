-- ============================================================================
-- TARGET V1 — 0124 GASTOS: ANULAR UN GASTO SIN PAGOS Y CORREGIR EL IMPORTE DE UN PENDIENTE SIN PROVEEDOR (owner GO 2026-11-13, caja-mejoras-v2)
--
-- Owner decisions 2026-11-13: an expense with payments or cheques is NOT annulled (the payment / cheque is reversed first); annulling an
-- expense with its fiscal document also takes its IVA out of the period, unless that period is already declared (an IVA fiscal
-- obligation recorded for it) — then a credit note is required; a pending expense without supplier may change its amount while nothing
-- is paid. Nothing is deleted: the annulment is a row of its own (who, when, why) and the expense stays visible, struck through.
--   1. purchase_annulment (append-only) + annul_expense (ADMIN, idempotent, audited ANNUL_EXPENSE): the current version of ONE expense
--      (supplier invoice, pending expense or casual purchase) is annulled when nothing is paid, allocated, issued, endorsed or linked to a
--      Mercado Pago movement, no freight is allocated to it, its management period is open and its IVA period is not declared. A supplier
--      expense books a REVERSAL in the supplier ledger (−total at the annulment date). No financial operation or posting is touched.
--   2. Read models without the annulled expense (same columns, same order): fin_expense_payables (its amount in force is its current
--      version's total, 0124 §3), fin_purchase_payment_status, pnl_line_item (purchases branch) and report_fiscal_period. The payment
--      calendar, the due list (0121), Todas las operaciones and the P&L summary follow them. fin_expense_annulments lists the annulled ones.
--   3. rectify_purchase_details (0117) re-created: a pending expense without supplier and without payments changes its amount (its
--      obligation follows the current version; with its fiscal document it stays locked); an annulled expense is never rectified.
--      pay_pending_expense (0106) re-created: the pending balance is the current version's total; an annulled expense is never paid.
--   4. fin_annulled_payment_guard (BEFORE INSERT on purchase_payment_allocation and expense_payable_payment): nothing is ever paid,
--      allocated or endorsed against an annulled expense, whatever RPC tries.
-- SECURITY DEFINER set +2 (annul_expense, the guard); two functions re-created with the same identity.
-- ============================================================================

-- ── 1. the annulment ─────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE purchase_annulment (
  id                 BIGSERIAL PRIMARY KEY,
  purchase_root_id   UUID NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the expense, whatever its version
  purchase_id        UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,          -- the version annulled
  amount_total       NUMERIC(15,2) NOT NULL,
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  fiscal_document_id UUID REFERENCES fiscal_document(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  supplier_ledger_id BIGINT REFERENCES supplier_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  annulled_date      DATE NOT NULL,
  reason             TEXT NOT NULL CHECK (btrim(reason) <> ''),
  idempotency_key    VARCHAR(100) NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX idx_purchase_annulment_fiscal ON purchase_annulment(fiscal_document_id) WHERE fiscal_document_id IS NOT NULL;
CREATE TRIGGER trg_purchase_annulment_immutable BEFORE UPDATE OR DELETE ON purchase_annulment FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE purchase_annulment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purchase_annulment FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE purchase_annulment_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE purchase_annulment TO authenticated;
CREATE POLICY purchase_annulment_admin_select ON purchase_annulment FOR SELECT USING (current_app_role() = 'ADMIN');

-- the obligation's amount in force: the current version's total (0124 §3)
CREATE FUNCTION expense_payable_amount(p_payable UUID) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT cur.amount_total FROM expense_payable e JOIN purchases cur ON cur.is_current AND purchase_chain_root(cur.id) = e.purchase_root_id WHERE e.id = p_payable
$$;
ALTER FUNCTION expense_payable_amount(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_payable_amount(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION expense_payable_amount(UUID) TO authenticated;

CREATE FUNCTION annul_expense(p_purchase_id UUID, p_reason TEXT, p_idempotency_key VARCHAR, p_annulled_date DATE DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_root   UUID;
  v_cur    purchases%ROWTYPE;
  v_prev   purchase_annulment%ROWTYPE;
  v_date   DATE := coalesce(p_annulled_date, current_date);
  v_period DATE;
  v_ledger BIGINT;
  v_rsn    TEXT := nullif(btrim(p_reason), '');
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 OR length(p_idempotency_key) > 100 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('annul_expense:' || p_idempotency_key, 0));
  SELECT * INTO v_prev FROM purchase_annulment WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('replayed', true, 'purchase_root_id', v_prev.purchase_root_id, 'annulment_id', v_prev.id); END IF;
  IF v_rsn IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED: an annulment needs a reason'; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  v_root := purchase_chain_root(p_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('payment_plan:' || v_root::text, 0));
  SELECT * INTO v_cur FROM purchases WHERE is_current AND purchase_chain_root(id) = v_root FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_annulment WHERE purchase_root_id = v_root) THEN RAISE EXCEPTION 'ALREADY_ANNULLED'; END IF;
  -- owner decision: nothing paid, allocated, issued, endorsed or linked
  IF v_cur.paid_operation_id IS NOT NULL THEN RAISE EXCEPTION 'EXPENSE_PAID: it was recorded paid; reverse its payment first'; END IF;
  IF EXISTS (SELECT 1 FROM expense_payable e WHERE e.purchase_root_id = v_root AND expense_payable_paid(e.id) > 0) THEN
    RAISE EXCEPTION 'EXPENSE_PAID: it has payments; reverse them first';
  END IF;
  IF purchase_allocated_amount(v_root) > 0 THEN RAISE EXCEPTION 'EXPENSE_PAID: payments or cheques are allocated to it; reverse / cancel them first'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_mp_link WHERE purchase_root_id = v_root) THEN RAISE EXCEPTION 'EXPENSE_PAID: it was paid with Mercado Pago'; END IF;
  IF EXISTS (SELECT 1 FROM freight_allocation fa JOIN purchases p ON p.id = fa.purchase_id WHERE purchase_chain_root(p.id) = v_root) THEN
    RAISE EXCEPTION 'FREIGHT_ALLOCATED: a freight is allocated to it; move it first';
  END IF;
  PERFORM assert_period_open(v_cur.economic_date);   -- its P&L month must still be open
  IF v_cur.fiscal_document_id IS NOT NULL THEN
    SELECT fiscal_period INTO v_period FROM fiscal_document WHERE id = v_cur.fiscal_document_id;
    IF EXISTS (SELECT 1 FROM fiscal_obligation o WHERE o.tax_kind::text = 'IVA' AND o.fiscal_period = v_period) THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_DECLARED: the IVA of % is already declared; annul it with a credit note in Fiscal', to_char(v_period, 'MM/YYYY');
    END IF;
  END IF;
  IF v_cur.supplier_id IS NOT NULL THEN
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_cur.supplier_id, 'REVERSAL', -v_cur.amount_total, v_date, 'purchases', v_cur.id::TEXT, 'Gasto anulado: ' || v_rsn, v_uid)
    RETURNING id INTO v_ledger;
  END IF;
  INSERT INTO purchase_annulment (purchase_root_id, purchase_id, amount_total, supplier_id, fiscal_document_id, supplier_ledger_id, annulled_date, reason, idempotency_key, created_by)
  VALUES (v_root, v_cur.id, v_cur.amount_total, v_cur.supplier_id, v_cur.fiscal_document_id, v_ledger, v_date, v_rsn, p_idempotency_key, v_uid)
  RETURNING * INTO v_prev;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', v_root::text, 'ANNUL_EXPENSE',
          jsonb_build_object('purchase_id', v_cur.id, 'concept', v_cur.subcategory, 'amount_total', v_cur.amount_total, 'supplier_id', v_cur.supplier_id,
                             'economic_date', v_cur.economic_date, 'fiscal_document_id', v_cur.fiscal_document_id),
          jsonb_build_object('annulled_date', v_date, 'supplier_ledger_id', v_ledger, 'annulment_id', v_prev.id), v_rsn, v_uid);
  RETURN jsonb_build_object('replayed', false, 'purchase_root_id', v_root, 'annulment_id', v_prev.id, 'supplier_ledger_id', v_ledger);
END $$;
ALTER FUNCTION annul_expense(UUID, TEXT, VARCHAR, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION annul_expense(UUID, TEXT, VARCHAR, DATE) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION annul_expense(UUID, TEXT, VARCHAR, DATE) TO authenticated;

-- ── 4. nothing is ever paid against an annulled expense ──────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_annulled_payment_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root UUID;
BEGIN
  IF TG_TABLE_NAME = 'purchase_payment_allocation' THEN v_root := NEW.purchase_root_id;
  ELSE SELECT purchase_root_id INTO v_root FROM expense_payable WHERE id = NEW.payable_id; END IF;
  IF EXISTS (SELECT 1 FROM purchase_annulment WHERE purchase_root_id = v_root) THEN RAISE EXCEPTION 'EXPENSE_ANNULLED: an annulled expense is not paid'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION fin_annulled_payment_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_annulled_payment_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_ppa_annulled_guard BEFORE INSERT ON purchase_payment_allocation FOR EACH ROW EXECUTE FUNCTION fin_annulled_payment_guard();
CREATE TRIGGER trg_epp_annulled_guard BEFORE INSERT ON expense_payable_payment FOR EACH ROW EXECUTE FUNCTION fin_annulled_payment_guard();

-- ── 2. read models without the annulled expense (copied from the migration in force; only the marked change) ─────────────
-- 0110 → 0124: amount in force = current version's total; annulled ones out
CREATE OR REPLACE VIEW fin_expense_payables WITH (security_invoker = true) AS
  SELECT e.id AS payable_id, cur.id AS purchase_id, e.purchase_root_id, cur.economic_date, cur.subcategory AS concept, cur.counterparty_name,
         cur.expense_category_id, ec.nombre AS category_name, cur.nature, cur.fiscal_document_id, cur.amount_total AS amount,
         expense_payable_paid(e.id) AS paid, cur.amount_total - expense_payable_paid(e.id) AS pending, payment_date_current(e.purchase_root_id, 'DUE') AS due_date,
         CASE WHEN expense_payable_paid(e.id) = 0 THEN 'PENDIENTE' WHEN expense_payable_paid(e.id) < cur.amount_total THEN 'PARCIAL' ELSE 'PAGADO' END AS status,
         e.origin, e.created_at, e.created_by, payment_date_current(e.purchase_root_id, 'PLANNED') AS planned_date
    FROM expense_payable e
    JOIN purchases cur ON cur.is_current AND cur.supplier_id IS NULL AND cur.paid_operation_id IS NULL AND purchase_chain_root(cur.id) = e.purchase_root_id
    JOIN expense_category ec ON ec.id = cur.expense_category_id
   WHERE NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = e.purchase_root_id);

-- 0123 → 0124: annulled invoices out
CREATE OR REPLACE VIEW fin_purchase_payment_status WITH (security_invoker = true) AS
  WITH cur AS (SELECT p.*, purchase_chain_root(p.id) AS root FROM purchases p WHERE p.is_current AND p.supplier_id IS NOT NULL),
  al AS (SELECT a.purchase_root_id,
                coalesce(sum(a.amount) FILTER (WHERE i.estado = 'ISSUED'), 0) AS scheduled,
                coalesce(sum(a.amount) FILTER (WHERE i.estado IN ('DEBITED', 'ENDORSED')), 0) AS debited,   -- 0123: an endorsed client cheque settles it
                coalesce(sum(a.amount) FILTER (WHERE a.financial_operation_id IS NOT NULL), 0) AS other_payments,
                count(*) FILTER (WHERE i.estado IN ('REJECTED', 'CANCELLED')) AS voided_instruments
           FROM purchase_payment_allocation a LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id GROUP BY a.purchase_root_id)
  SELECT cur.id AS purchase_id, cur.root AS purchase_root_id, cur.supplier_id, s.nombre AS supplier_name, cur.supplier_invoice_number,
         cur.fiscal_document_id, cur.economic_date, cur.amount_total,
         coalesce(al.scheduled, 0) AS scheduled, coalesce(al.debited, 0) AS debited, coalesce(al.other_payments, 0) AS other_payments,
         cur.amount_total - coalesce(al.scheduled, 0) - coalesce(al.debited, 0) - coalesce(al.other_payments, 0) AS pending,
         coalesce(al.voided_instruments, 0) AS voided_instruments,
         payment_date_current(cur.root, 'DUE') AS due_date, payment_date_current(cur.root, 'PLANNED') AS planned_date
    FROM cur JOIN suppliers s ON s.id = cur.supplier_id LEFT JOIN al ON al.purchase_root_id = cur.root
   WHERE NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.purchase_root_id = cur.root);

-- 0101 → 0124: an annulled purchase leaves the P&L (purchases branch)
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
) u
WHERE (SELECT current_app_role()) = 'ADMIN';

-- 0068 → 0124: the fiscal document of an annulled purchase leaves the period
CREATE OR REPLACE VIEW report_fiscal_period
WITH (security_invoker = true)
AS
WITH c AS (
  SELECT d.fiscal_period,
         c.tax_kind,
         d.direction,
         d.id AS fiscal_document_id,
         CASE WHEN d.document_type = 'CREDIT_NOTE' THEN -c.tax_amount ELSE c.tax_amount END AS signed_tax_amount
    FROM fiscal_document d
    JOIN fiscal_document_component c ON c.fiscal_document_id = d.id
   WHERE NOT EXISTS (SELECT 1 FROM purchase_annulment an WHERE an.fiscal_document_id = d.id)
)
SELECT fiscal_period                                                               AS period,
       tax_kind,
       COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'DEBITO'), 0)      AS debit_amount,
       COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'CREDITO'), 0)     AS credit_amount,
       count(DISTINCT fiscal_document_id) FILTER (WHERE direction = 'DEBITO')       AS debit_documents,
       count(DISTINCT fiscal_document_id) FILTER (WHERE direction = 'CREDITO')      AS credit_documents,
       COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'DEBITO'), 0)
         - COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'CREDITO'), 0) AS period_difference
  FROM c
 WHERE (SELECT current_app_role()) = 'ADMIN'
 GROUP BY fiscal_period, tax_kind;

-- the annulled expenses (struck through in the screens)
CREATE VIEW fin_expense_annulments WITH (security_invoker = true) AS
  SELECT a.id AS annulment_id, a.purchase_root_id, a.purchase_id, p.subcategory AS concept, coalesce(s.nombre, p.counterparty_name) AS counterparty,
         a.supplier_id, a.amount_total, p.economic_date, a.annulled_date, a.reason, a.created_at, a.created_by, pf.nombre AS created_by_name,
         a.fiscal_document_id
    FROM purchase_annulment a JOIN purchases p ON p.id = a.purchase_id
    LEFT JOIN suppliers s ON s.id = a.supplier_id LEFT JOIN perfiles pf ON pf.id = a.created_by;
ALTER VIEW fin_expense_annulments OWNER TO postgres;
REVOKE ALL ON fin_expense_annulments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_expense_annulments TO authenticated;

-- ── 3. rectification and pending-expense payment re-created (copied from 0117 / 0106; only the marked changes) ──────────────
CREATE OR REPLACE FUNCTION rectify_purchase_details(
  p_purchase_id         UUID,
  p_concept             VARCHAR,
  p_expense_category_id UUID,
  p_nature              purchase_nature,
  p_economic_date       DATE,
  p_supplier_id         UUID,
  p_invoice_number      VARCHAR,
  p_amount_total        NUMERIC,
  p_amount_net          NUMERIC,
  p_reason              TEXT,
  p_fiscal              JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_old       purchases%ROWTYPE;
  v_root      UUID;
  v_casual    BOOLEAN;
  v_concept   VARCHAR := nullif(btrim(p_concept), '');
  v_invoice   VARCHAR := nullif(btrim(p_invoice_number), '');
  v_supplier  UUID;
  v_net       NUMERIC;
  v_fiscal    UUID;
  v_allocated NUMERIC;
  v_version   INTEGER;
  v_new_id    UUID;
  v_ledger    BOOLEAN;
  v_before    JSONB;
  v_after     JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  SELECT * INTO v_old FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF NOT v_old.is_current THEN RAISE EXCEPTION 'PURCHASE_SUPERSEDED: rectify the current version instead'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_annulment WHERE purchase_root_id = purchase_chain_root(v_old.id)) THEN RAISE EXCEPTION 'EXPENSE_ANNULLED: an annulled expense is not rectified'; END IF;
  v_root := purchase_chain_root(v_old.id);
  v_casual := v_old.supplier_id IS NULL;

  -- the corrected values (validated completely before anything changes)
  IF v_concept IS NULL OR length(v_concept) > 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
  END IF;
  IF p_nature IS NULL THEN RAISE EXCEPTION 'NATURE_REQUIRED'; END IF;
  IF p_economic_date IS NULL THEN RAISE EXCEPTION 'DATE_REQUIRED'; END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_net IS NULL OR p_amount_net < 0 OR p_amount_net > p_amount_total THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_fiscal IS NOT NULL AND jsonb_typeof(p_fiscal) <> 'object' THEN RAISE EXCEPTION 'INVALID_FISCAL_DOCUMENT'; END IF;
  v_supplier := CASE WHEN v_casual THEN NULL ELSE p_supplier_id END;
  v_net := p_amount_net;

  -- what each kind of expense allows
  IF v_casual THEN
    IF p_supplier_id IS NOT NULL THEN
      RAISE EXCEPTION 'SUPPLIER_CHANGE_NOT_ALLOWED: an expense without supplier is linked to one from its pending payment (Vincular a proveedor); a paid one keeps no supplier';
    END IF;
    IF v_invoice IS DISTINCT FROM v_old.supplier_invoice_number THEN
      RAISE EXCEPTION 'INVOICE_NUMBER_NOT_ALLOWED: the number of the invoice of an expense without supplier is its fiscal document''s';
    END IF;
    IF v_old.paid_operation_id IS NOT NULL AND p_economic_date <> v_old.economic_date THEN
      RAISE EXCEPTION 'PAID_EXPENSE_DATE_LOCKED: a paid expense keeps the date of its payment';
    END IF;
    IF p_amount_total <> v_old.amount_total THEN
      IF v_old.paid_operation_id IS NOT NULL THEN
        RAISE EXCEPTION 'CASUAL_PURCHASE_AMOUNT_LOCKED: a paid expense keeps the amount of its payment; a correction needs a reversal / refund';
      END IF;
      -- 0124 (owner decision 2026-11-13): a pending expense without supplier changes its amount while nothing is paid (its obligation follows
      -- the current version); with a payment, or with its fiscal document, it stays
      IF EXISTS (SELECT 1 FROM expense_payable e WHERE e.purchase_root_id = v_root AND expense_payable_paid(e.id) > 0) THEN
        RAISE EXCEPTION 'PENDING_EXPENSE_AMOUNT_LOCKED: the pending expense already has payments: its amount stays';
      END IF;
      IF EXISTS (SELECT 1 FROM expense_payable WHERE purchase_root_id = v_root) AND v_old.fiscal_document_id IS NOT NULL THEN
        RAISE EXCEPTION 'FISCAL_DOCUMENT_LOCKED: the amount of an expense with its fiscal document is a fiscal record (correct it with a credit or debit note)';
      END IF;
      IF EXISTS (SELECT 1 FROM purchase_mp_settlement s WHERE purchase_chain_root(s.purchase_id) = v_root) THEN
        RAISE EXCEPTION 'MP_LINKED_AMOUNT_LOCKED: the purchase is linked to its Mercado Pago movement and keeps its amount';
      END IF;
    END IF;
  ELSE
    IF v_supplier IS NULL THEN RAISE EXCEPTION 'SUPPLIER_REQUIRED: a supplier purchase keeps a supplier'; END IF;
    IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = v_supplier AND activo) THEN RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE'; END IF;
    v_allocated := purchase_allocated_amount(v_root);
    IF v_supplier <> v_old.supplier_id AND v_allocated > 0 THEN
      RAISE EXCEPTION 'PURCHASE_HAS_PAYMENTS: payments or cheques are allocated to this invoice; its supplier cannot change';
    END IF;
    IF p_amount_total < v_allocated THEN
      RAISE EXCEPTION 'OVER_ALLOCATION: % is already allocated to this invoice', v_allocated;
    END IF;
  END IF;
  IF v_old.fiscal_document_id IS NOT NULL THEN
    IF p_fiscal IS NOT NULL THEN RAISE EXCEPTION 'FISCAL_DOCUMENT_LOCKED: the purchase already has its fiscal document'; END IF;
    IF v_supplier IS DISTINCT FROM v_old.supplier_id OR p_amount_total <> v_old.amount_total OR p_amount_net <> v_old.amount_net
       OR v_invoice IS DISTINCT FROM v_old.supplier_invoice_number THEN
      RAISE EXCEPTION 'FISCAL_DOCUMENT_LOCKED: supplier, amounts and invoice number of a purchase with a fiscal document are fiscal records (correct them with a credit or debit note)';
    END IF;
  END IF;
  IF v_supplier IS NOT DISTINCT FROM v_old.supplier_id AND p_economic_date = v_old.economic_date AND p_expense_category_id = v_old.expense_category_id
     AND p_nature = v_old.nature AND v_concept IS NOT DISTINCT FROM v_old.subcategory AND v_invoice IS NOT DISTINCT FROM v_old.supplier_invoice_number
     AND p_amount_total = v_old.amount_total AND p_amount_net = v_old.amount_net AND p_fiscal IS NULL THEN
    RAISE EXCEPTION 'NOTHING_TO_RECTIFY: the corrected expense is identical to the current one';
  END IF;
  IF v_invoice IS NOT NULL AND v_supplier IS NOT NULL AND EXISTS (
       SELECT 1 FROM purchases WHERE is_current AND supplier_id = v_supplier AND supplier_invoice_number = v_invoice AND id <> v_old.id) THEN
    RAISE EXCEPTION 'DUPLICATE_SUPPLIER_INVOICE: % already recorded for this supplier', v_invoice;
  END IF;

  PERFORM assert_period_open(v_old.economic_date);
  PERFORM assert_period_open(p_economic_date);

  -- the received invoice added now (same forms as the registration RPCs: supplier, or issuer CUIT without supplier)
  v_fiscal := v_old.fiscal_document_id;
  IF p_fiscal IS NOT NULL THEN
    IF v_casual AND coalesce(p_fiscal ->> 'issuer_tax_id', '') = '' THEN
      RAISE EXCEPTION 'INVALID_FISCAL_DOCUMENT: an issuer CUIT is required for the invoice of an expense without supplier';
    END IF;
    v_fiscal := (fiscal_document_insert((p_fiscal ->> 'document_type')::fiscal_document_type, 'CREDITO', p_economic_date,
                   (p_fiscal ->> 'fiscal_period')::DATE, (p_fiscal ->> 'net_amount')::NUMERIC, (p_fiscal ->> 'total_amount')::NUMERIC,
                   coalesce(p_fiscal -> 'components', '[]'::jsonb), v_supplier, NULL,
                   CASE WHEN v_casual THEN nullif(btrim(p_fiscal ->> 'external_number'), '') ELSE v_invoice END,
                   CASE WHEN v_casual THEN p_fiscal ->> 'issuer_tax_id' END, CASE WHEN v_casual THEN p_fiscal ->> 'issuer_name' END,
                   p_reason) ->> 'fiscal_document_id')::UUID;
  END IF;

  -- the new version (0022 / 0088 mechanism)
  v_version := v_old.version_seq + 1;
  UPDATE purchases SET is_current = false WHERE id = v_old.id;
  INSERT INTO purchases (supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
         project_id, fiscal_document_id, supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (v_supplier, v_old.counterparty_name, p_economic_date, v_net, p_amount_total, p_expense_category_id, v_concept, p_nature,
          v_old.project_id, v_fiscal, v_invoice, v_old.flock_id, v_old.paid_operation_id, true, v_version,
          'RECTIFY:' || v_old.id::TEXT || ':v' || v_version, v_uid)
  RETURNING id INTO v_new_id;
  INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario)
  SELECT v_new_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario FROM purchase_line WHERE purchase_id = v_old.id;
  INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
  SELECT v_new_id, storage_path, file_name, content_type, byte_size, v_uid FROM purchase_attachment WHERE purchase_id = v_old.id;
  UPDATE freight_allocation SET purchase_id = v_new_id WHERE purchase_id = v_old.id;

  -- supplier debt: the old purchase reversed at its own date and supplier, the corrected one booked (only when one of them changes)
  v_ledger := NOT v_casual AND (v_supplier <> v_old.supplier_id OR p_economic_date <> v_old.economic_date OR p_amount_total <> v_old.amount_total);
  IF v_ledger THEN
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_old.supplier_id, 'REVERSAL', -v_old.amount_total, v_old.economic_date, 'purchases', v_old.id::TEXT, p_reason, v_uid);
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_supplier, 'PURCHASE', p_amount_total, p_economic_date, 'purchases', v_new_id::TEXT, p_reason, v_uid);
  END IF;

  v_before := jsonb_build_object('concept', v_old.subcategory, 'expense_category_id', v_old.expense_category_id, 'nature', v_old.nature,
                'economic_date', v_old.economic_date, 'supplier_id', v_old.supplier_id, 'supplier_invoice_number', v_old.supplier_invoice_number,
                'amount_total', v_old.amount_total, 'amount_net', v_old.amount_net, 'fiscal_document_id', v_old.fiscal_document_id,
                'version', v_old.version_seq);
  v_after := jsonb_build_object('concept', v_concept, 'expense_category_id', p_expense_category_id, 'nature', p_nature,
                'economic_date', p_economic_date, 'supplier_id', v_supplier, 'supplier_invoice_number', v_invoice,
                'amount_total', p_amount_total, 'amount_net', v_net, 'fiscal_document_id', v_fiscal,
                'version', v_version, 'new_id', v_new_id, 'root_id', v_root);
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', v_old.id::TEXT, 'RECTIFY_DETAILS', v_before, v_after, btrim(p_reason), v_uid);

  RETURN jsonb_build_object('previous_purchase_id', v_old.id, 'new_purchase_id', v_new_id, 'purchase_root_id', v_root,
                            'version_seq', v_version, 'supplier_ledger_rebooked', v_ledger, 'fiscal_document_id', v_fiscal);
END $$;

CREATE OR REPLACE FUNCTION pay_pending_expense(
  p_payable_id      UUID,
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_account_id      UUID,
  p_payment_method  payment_method,
  p_idempotency_key VARCHAR,
  p_reason          TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_pay expense_payable; v_prev expense_payable_payment; v_paid NUMERIC; v_acc financial_account; v_op BIGINT; v_cur purchases;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  SELECT * INTO v_prev FROM expense_payable_payment WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_prev.payable_id <> p_payable_id OR v_prev.amount <> p_amount THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('replayed', true, 'payment_id', v_prev.id, 'financial_operation_id', v_prev.financial_operation_id,
                              'paid', expense_payable_paid(p_payable_id), 'pending', expense_payable_amount(p_payable_id) - expense_payable_paid(p_payable_id));
  END IF;
  SELECT * INTO v_pay FROM expense_payable WHERE id = p_payable_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYABLE_NOT_FOUND'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  v_paid := expense_payable_paid(v_pay.id);
  IF EXISTS (SELECT 1 FROM purchase_annulment WHERE purchase_root_id = v_pay.purchase_root_id) THEN RAISE EXCEPTION 'EXPENSE_ANNULLED: an annulled expense is not paid'; END IF;
  IF v_paid + p_amount > expense_payable_amount(v_pay.id) THEN RAISE EXCEPTION 'OVER_PAYMENT: the pending balance is %', expense_payable_amount(v_pay.id) - v_paid; END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('CASH', 'TRANSFER') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: a pending expense is paid by cash or transfer (a Mercado Pago outflow is classified from Pendientes MP)';
  END IF;
  SELECT * INTO v_acc FROM financial_account WHERE id = p_account_id AND activo;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE'; END IF;
  IF v_acc.account_type = 'EXTERNAL_SERVICE' THEN
    RAISE EXCEPTION 'PAYABLE_MP_NOT_SUPPORTED: a Mercado Pago outflow is classified from Pendientes MP';
  END IF;
  IF (p_payment_method = 'CASH') <> (v_acc.account_type = 'CASH') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: cash is paid from a cash account, a transfer from a bank account';
  END IF;
  IF p_effective_date IS NULL THEN RAISE EXCEPTION 'INVALID_DATE'; END IF;
  PERFORM assert_period_open(p_effective_date);
  SELECT * INTO v_cur FROM purchases WHERE is_current AND supplier_id IS NULL AND paid_operation_id IS NULL AND purchase_chain_root(id) = v_pay.purchase_root_id;
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('PURCHASE_PAYMENT', p_effective_date, 'PAYABLE-PAY:' || p_idempotency_key, 'expense_payable', v_pay.id::TEXT,
          coalesce(p_reason, 'Pago de ' || coalesce(v_cur.subcategory, 'gasto a pagar')), v_uid)
  RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_acc.id, -p_amount, p_effective_date, v_uid);
  INSERT INTO expense_payable_payment (payable_id, financial_operation_id, amount, effective_date, idempotency_key, created_by)
  VALUES (v_pay.id, v_op, p_amount, p_effective_date, p_idempotency_key, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('expense_payable', v_pay.id::TEXT, 'PAY', jsonb_build_object('amount', p_amount, 'operation', v_op, 'account', v_acc.id, 'date', p_effective_date),
          p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'financial_operation_id', v_op, 'paid', v_paid + p_amount, 'pending', v_pay.amount - v_paid - p_amount);
END $$;
