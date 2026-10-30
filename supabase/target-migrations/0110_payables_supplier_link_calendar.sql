-- ============================================================================
-- TARGET V1 — 0110 CUENTAS A PAGAR: GASTO PENDIENTE → PROVEEDOR, VENCIMIENTO / FECHA ESTIMADA, CALENDARIO (owner GO Lote 3B, 2026-10-29)
--
-- Nothing here moves money, creates an expense, a fiscal document or an IVA line. Reused, not duplicated: purchases (versions),
-- supplier_ledger, expense_payable / expense_payable_payment (0106), purchase_payment_allocation (0104), financial_instrument.
--   1. assign_payable_to_supplier (RPC, ADMIN, idempotent, audited): a pending expense without supplier (0106) is linked to an
--      existing supplier, ONCE, in one transaction:
--        · a new version of the purchase with the supplier (same date, category, amounts, fiscal document, lines, files: the
--          P&L and the IVA are unchanged; the chain root is kept, so its payments / dates / documents follow it);
--        · supplier_ledger: PURCHASE +total at the expense date and one PAYMENT −amount per payment ALREADY made, at its own
--          date, pointing to that existing payment (no new financial operation / posting: the money had moved already);
--        · purchase_payment_allocation: each earlier payment → that invoice (its pending balance = total − paid);
--        · expense_payable_supplier_link: the record of the link (one per obligation; replay by key).
--      From then on the obligation is paid from the supplier account (pay_supplier / own cheques / Pagos de facturas):
--      pay_pending_expense on a linked obligation is refused (a trigger on expense_payable_payment), so it is never paid twice.
--   2. purchase_payment_date (append-only) + set_payment_date (RPC, ADMIN, audited): two different dates per obligation
--      (supplier invoice or pending expense, by its chain root):
--        · DUE — the contractual due date (a pending expense's own due_date is its first value); a change of an existing due
--          date needs a reason;
--        · PLANNED — the internal estimated payment date, editable (or cleared) at any time.
--      "Overdue" is decided by DUE only. No date ever generates a payment. fin_purchase_payment_status / fin_expense_payables
--      show the dates in force (planned_date appended; fin_expense_payables.due_date is now the due date in force).
--   3. fin_payment_calendar (view, security_invoker, ADMIN): every future commitment, once:
--        · FACTURA — a supplier invoice's pending (it already excludes the own cheques / payments allocated to it);
--        · GASTO — a pending expense without supplier, its pending;
--        · CHEQUE / ECHEQ — an own instrument still to be debited, by maturity; IMPUTADO when allocated to an invoice,
--          SIN_IMPUTAR when not (its link to an invoice is NOT determined: it is never matched to an older invoice here).
--      Debited instruments and payments are real movements: they are not in the calendar.
-- ============================================================================

-- ── 1. the link of a pending expense to a supplier ─────────────────────────
CREATE TABLE expense_payable_supplier_link (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payable_id       UUID NOT NULL UNIQUE REFERENCES expense_payable(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  supplier_id      UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  from_purchase_id UUID NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the version without supplier
  to_purchase_id   UUID NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the version with the supplier
  amount           NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  paid_before      NUMERIC(15,2) NOT NULL CHECK (paid_before >= 0 AND paid_before < amount),
  idempotency_key  VARCHAR(100) NOT NULL UNIQUE,
  reason           TEXT NOT NULL CHECK (btrim(reason) <> ''),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TRIGGER trg_expense_payable_supplier_link_immutable BEFORE UPDATE OR DELETE ON expense_payable_supplier_link
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE expense_payable_supplier_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE expense_payable_supplier_link FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE expense_payable_supplier_link TO authenticated;
CREATE POLICY expense_payable_supplier_link_admin_select ON expense_payable_supplier_link FOR SELECT USING (current_app_role() = 'ADMIN');

-- a linked obligation is paid from the supplier account only (integrity rule: runs as its owner, whoever commits — 0107)
CREATE FUNCTION expense_payable_payment_link_guard() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM expense_payable_supplier_link l WHERE l.payable_id = NEW.payable_id) THEN
    RAISE EXCEPTION 'PAYABLE_LINKED_TO_SUPPLIER: this obligation belongs to a supplier now; pay it from the supplier account';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION expense_payable_payment_link_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_payable_payment_link_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_expense_payable_payment_link_guard BEFORE INSERT ON expense_payable_payment
  FOR EACH ROW EXECUTE FUNCTION expense_payable_payment_link_guard();

CREATE FUNCTION assign_payable_to_supplier(
  p_payable_id              UUID,
  p_supplier_id             UUID,
  p_reason                  TEXT,
  p_idempotency_key         VARCHAR,
  p_supplier_invoice_number VARCHAR DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid(); v_link expense_payable_supplier_link; v_pay expense_payable; v_cur purchases; v_new UUID := gen_random_uuid();
  v_paid NUMERIC; v_invoice VARCHAR := nullif(btrim(p_supplier_invoice_number), ''); v_pp expense_payable_payment; v_link_id UUID := gen_random_uuid();
  v_reason TEXT := nullif(btrim(p_reason), ''); v_payments INT := 0;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payable_supplier_link:' || coalesce(p_payable_id::text, ''), 0));
  -- replay: the same key returns what was linked; the same key for another link is a conflict
  SELECT * INTO v_link FROM expense_payable_supplier_link WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_link.payable_id IS DISTINCT FROM p_payable_id OR v_link.supplier_id IS DISTINCT FROM p_supplier_id THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN jsonb_build_object('replayed', true, 'link_id', v_link.id, 'purchase_id', v_link.to_purchase_id, 'supplier_id', v_link.supplier_id,
                              'amount', v_link.amount, 'paid_before', v_link.paid_before, 'pending', v_link.amount - v_link.paid_before);
  END IF;
  SELECT * INTO v_pay FROM expense_payable WHERE id = p_payable_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYABLE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM expense_payable_supplier_link WHERE payable_id = v_pay.id) THEN
    RAISE EXCEPTION 'PAYABLE_ALREADY_LINKED: this obligation already belongs to a supplier';
  END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_supplier_id IS NULL OR NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF v_invoice IS NOT NULL AND length(v_invoice) > 100 THEN RAISE EXCEPTION 'INVALID_INVOICE_NUMBER: at most 100 characters'; END IF;
  SELECT * INTO v_cur FROM purchases WHERE is_current AND purchase_chain_root(id) = v_pay.purchase_root_id FOR UPDATE;
  IF NOT FOUND OR v_cur.supplier_id IS NOT NULL OR v_cur.paid_operation_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYABLE_NOT_LINKABLE: the expense is not a pending expense without supplier';
  END IF;
  IF v_invoice IS NOT NULL AND v_cur.supplier_invoice_number IS NOT NULL AND v_invoice <> v_cur.supplier_invoice_number THEN
    RAISE EXCEPTION 'INVOICE_NUMBER_MISMATCH: the expense already has the invoice %', v_cur.supplier_invoice_number;
  END IF;
  IF v_cur.amount_total <> v_pay.amount THEN RAISE EXCEPTION 'PAYABLE_AMOUNT_MISMATCH: expense % / obligation %', v_cur.amount_total, v_pay.amount; END IF;
  v_paid := expense_payable_paid(v_pay.id);
  IF v_paid >= v_pay.amount THEN RAISE EXCEPTION 'PAYABLE_SETTLED: a paid obligation is not linked'; END IF;
  -- every date this writes on the supplier account must be in an open period
  PERFORM assert_period_open(v_cur.economic_date);
  FOR v_pp IN SELECT * FROM expense_payable_payment WHERE payable_id = v_pay.id ORDER BY id LOOP PERFORM assert_period_open(v_pp.effective_date); END LOOP;

  -- the new version of the purchase, with the supplier (retire the current one first: one current row per chain)
  UPDATE purchases SET is_current = false WHERE id = v_cur.id;
  BEGIN
    INSERT INTO purchases (id, supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
           project_id, fiscal_document_id, supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
    VALUES (v_new, p_supplier_id, NULL, v_cur.economic_date, v_cur.amount_net, v_cur.amount_total, v_cur.expense_category_id, v_cur.subcategory, v_cur.nature,
            v_cur.project_id, v_cur.fiscal_document_id, coalesce(v_cur.supplier_invoice_number, v_invoice), v_cur.flock_id, NULL, true,
            v_cur.version_seq + 1, 'RECTIFY:' || v_cur.id::text || ':v' || (v_cur.version_seq + 1), v_uid);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_INVOICE: the supplier already has a current invoice %', coalesce(v_cur.supplier_invoice_number, v_invoice);
  END;
  INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario)
  SELECT v_new, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario FROM purchase_line WHERE purchase_id = v_cur.id ORDER BY id;
  INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
  SELECT v_new, storage_path, file_name, content_type, byte_size, uploaded_by FROM purchase_attachment WHERE purchase_id = v_cur.id ORDER BY id;
  INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by)
  SELECT document_file_id, 'PURCHASE', v_new::text, v_uid FROM document_link WHERE target_kind = 'PURCHASE' AND target_id = v_cur.id::text
  ON CONFLICT DO NOTHING;
  UPDATE freight_allocation SET purchase_id = v_new WHERE purchase_id = v_cur.id;

  -- the supplier account: the obligation at its date, then each payment already made at its own date (no new money)
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'PURCHASE', v_cur.amount_total, v_cur.economic_date, 'purchases', v_new::text, v_reason, v_uid);
  FOR v_pp IN SELECT * FROM expense_payable_payment WHERE payable_id = v_pay.id ORDER BY id LOOP
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date, source_entity_type, source_entity_id, reason, created_by)
    VALUES (p_supplier_id, 'PAYMENT', -v_pp.amount, v_pp.effective_date, 'expense_payable_payment', v_pp.id::text,
            'Pago anterior al vínculo con el proveedor', v_uid);
    INSERT INTO purchase_payment_allocation (purchase_root_id, financial_operation_id, amount, idempotency_key, reason, created_by)
    VALUES (v_pay.purchase_root_id, v_pp.financial_operation_id, v_pp.amount, 'PAYABLE-LINK:' || v_link_id::text || ':' || v_pp.id, v_reason, v_uid);
    v_payments := v_payments + 1;
  END LOOP;

  INSERT INTO expense_payable_supplier_link (id, payable_id, supplier_id, from_purchase_id, to_purchase_id, amount, paid_before, idempotency_key, reason, created_by)
  VALUES (v_link_id, v_pay.id, p_supplier_id, v_cur.id, v_new, v_pay.amount, v_paid, p_idempotency_key, v_reason, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('expense_payable', v_pay.id::text, 'LINK_SUPPLIER',
          jsonb_build_object('purchase_id', v_cur.id, 'counterparty_name', v_cur.counterparty_name, 'supplier_invoice_number', v_cur.supplier_invoice_number),
          jsonb_build_object('purchase_id', v_new, 'supplier_id', p_supplier_id, 'supplier_invoice_number', coalesce(v_cur.supplier_invoice_number, v_invoice),
                             'amount', v_pay.amount, 'paid_before', v_paid, 'pending', v_pay.amount - v_paid, 'payments_carried', v_payments),
          v_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'link_id', v_link_id, 'purchase_id', v_new, 'supplier_id', p_supplier_id,
                            'amount', v_pay.amount, 'paid_before', v_paid, 'pending', v_pay.amount - v_paid, 'payments_carried', v_payments,
                            'financial_effect', 'NONE');
END $$;

-- ── 2. due date and estimated payment date ─────────────────────────────────
CREATE TABLE purchase_payment_date (
  id               BIGSERIAL PRIMARY KEY,
  purchase_root_id UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the obligation, whatever its version
  date_kind        TEXT NOT NULL CHECK (date_kind IN ('DUE', 'PLANNED')),
  value            DATE,                                                                         -- NULL: estimated date cleared
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_ppd_due_value CHECK (date_kind = 'PLANNED' OR value IS NOT NULL)
);
CREATE INDEX idx_ppd_root_kind ON purchase_payment_date(purchase_root_id, date_kind, id DESC);
CREATE TRIGGER trg_purchase_payment_date_immutable BEFORE UPDATE OR DELETE ON purchase_payment_date FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE purchase_payment_date ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purchase_payment_date FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE purchase_payment_date_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE purchase_payment_date TO authenticated;
CREATE POLICY purchase_payment_date_admin_select ON purchase_payment_date FOR SELECT USING (current_app_role() = 'ADMIN');

-- the date in force: the latest row of its kind; a pending expense's own due_date (0106) is its first due date
CREATE FUNCTION payment_date_current(p_root UUID, p_kind TEXT) RETURNS DATE LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM purchase_payment_date d WHERE d.purchase_root_id = p_root AND d.date_kind = p_kind)
              THEN (SELECT d.value FROM purchase_payment_date d WHERE d.purchase_root_id = p_root AND d.date_kind = p_kind ORDER BY d.id DESC LIMIT 1)
              WHEN p_kind = 'DUE' THEN (SELECT e.due_date FROM expense_payable e WHERE e.purchase_root_id = p_root) END;
$$;
ALTER FUNCTION payment_date_current(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION payment_date_current(UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION payment_date_current(UUID, TEXT) TO authenticated;

CREATE FUNCTION set_payment_date(p_purchase_id UUID, p_kind TEXT, p_date DATE, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_p purchases; v_root UUID; v_prev DATE; v_reason TEXT := nullif(btrim(p_reason), '');
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('DUE', 'PLANNED') THEN RAISE EXCEPTION 'INVALID_DATE_KIND: DUE or PLANNED'; END IF;
  SELECT * INTO v_p FROM purchases WHERE id = p_purchase_id AND is_current;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND: not a current purchase'; END IF;
  v_root := purchase_chain_root(v_p.id);
  IF v_p.supplier_id IS NULL AND NOT EXISTS (SELECT 1 FROM expense_payable WHERE purchase_root_id = v_root) THEN
    RAISE EXCEPTION 'NOT_AN_OBLIGATION: only a supplier invoice or a pending expense has payment dates';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment_date:' || v_root::text, 0));
  IF p_kind = 'DUE' AND p_date IS NULL THEN RAISE EXCEPTION 'INVALID_PAYMENT_DATE: a due date cannot be cleared'; END IF;
  IF p_date IS NOT NULL AND p_date < v_p.economic_date THEN RAISE EXCEPTION 'INVALID_PAYMENT_DATE: the date is before the expense date'; END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN RAISE EXCEPTION 'INVALID_REASON: at most 500 characters'; END IF;
  v_prev := payment_date_current(v_root, p_kind);
  IF v_prev IS NOT DISTINCT FROM p_date THEN
    RETURN jsonb_build_object('replayed', true, 'date_kind', p_kind, 'value', p_date);
  END IF;
  IF p_kind = 'DUE' AND v_prev IS NOT NULL AND v_reason IS NULL THEN
    RAISE EXCEPTION 'REASON_REQUIRED: changing a due date needs a reason';
  END IF;
  INSERT INTO purchase_payment_date (purchase_root_id, date_kind, value, reason, created_by) VALUES (v_root, p_kind, p_date, v_reason, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', v_root::text, CASE p_kind WHEN 'DUE' THEN 'SET_DUE_DATE' ELSE 'SET_PLANNED_PAYMENT_DATE' END,
          jsonb_build_object('value', v_prev), jsonb_build_object('value', p_date), v_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'date_kind', p_kind, 'value', p_date, 'previous', v_prev, 'financial_effect', 'NONE');
END $$;

DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT unnest(ARRAY['assign_payable_to_supplier(uuid,uuid,text,varchar,varchar)', 'set_payment_date(uuid,text,date,text)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $p$;

-- the two read models show the dates in force (same columns, same order; planned_date appended). fin_expense_payables.due_date
-- was the obligation's own due date: it is now the due date in force, which starts as that same date.
CREATE OR REPLACE VIEW fin_purchase_payment_status WITH (security_invoker = true) AS
  WITH cur AS (SELECT p.*, purchase_chain_root(p.id) AS root FROM purchases p WHERE p.is_current AND p.supplier_id IS NOT NULL),
  al AS (SELECT a.purchase_root_id,
                coalesce(sum(a.amount) FILTER (WHERE i.estado = 'ISSUED'), 0) AS scheduled,
                coalesce(sum(a.amount) FILTER (WHERE i.estado = 'DEBITED'), 0) AS debited,
                coalesce(sum(a.amount) FILTER (WHERE a.financial_operation_id IS NOT NULL), 0) AS other_payments,
                count(*) FILTER (WHERE i.estado IN ('REJECTED', 'CANCELLED')) AS voided_instruments
           FROM purchase_payment_allocation a LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id GROUP BY a.purchase_root_id)
  SELECT cur.id AS purchase_id, cur.root AS purchase_root_id, cur.supplier_id, s.nombre AS supplier_name, cur.supplier_invoice_number,
         cur.fiscal_document_id, cur.economic_date, cur.amount_total,
         coalesce(al.scheduled, 0) AS scheduled, coalesce(al.debited, 0) AS debited, coalesce(al.other_payments, 0) AS other_payments,
         cur.amount_total - coalesce(al.scheduled, 0) - coalesce(al.debited, 0) - coalesce(al.other_payments, 0) AS pending,
         coalesce(al.voided_instruments, 0) AS voided_instruments,
         payment_date_current(cur.root, 'DUE') AS due_date, payment_date_current(cur.root, 'PLANNED') AS planned_date
    FROM cur JOIN suppliers s ON s.id = cur.supplier_id LEFT JOIN al ON al.purchase_root_id = cur.root;
CREATE OR REPLACE VIEW fin_expense_payables WITH (security_invoker = true) AS
  SELECT e.id AS payable_id, cur.id AS purchase_id, e.purchase_root_id, cur.economic_date, cur.subcategory AS concept, cur.counterparty_name,
         cur.expense_category_id, ec.nombre AS category_name, cur.nature, cur.fiscal_document_id, e.amount,
         expense_payable_paid(e.id) AS paid, e.amount - expense_payable_paid(e.id) AS pending, payment_date_current(e.purchase_root_id, 'DUE') AS due_date,
         CASE WHEN expense_payable_paid(e.id) = 0 THEN 'PENDIENTE' WHEN expense_payable_paid(e.id) < e.amount THEN 'PARCIAL' ELSE 'PAGADO' END AS status,
         e.origin, e.created_at, e.created_by, payment_date_current(e.purchase_root_id, 'PLANNED') AS planned_date
    FROM expense_payable e
    JOIN purchases cur ON cur.is_current AND cur.supplier_id IS NULL AND cur.paid_operation_id IS NULL AND purchase_chain_root(cur.id) = e.purchase_root_id
    JOIN expense_category ec ON ec.id = cur.expense_category_id;

-- ── 3. the payment calendar: every future commitment once, never a real movement ──
CREATE VIEW fin_payment_calendar WITH (security_invoker = true) AS
  SELECT 'FACTURA'::text AS item_kind, s.purchase_id::text AS item_id, s.purchase_root_id, s.purchase_id, s.supplier_id, s.supplier_name,
         NULL::varchar AS concept, s.supplier_invoice_number AS document_number, s.economic_date, s.amount_total, s.pending AS amount,
         s.due_date, s.planned_date,
         'CONFIRMADO'::text AS link_status, NULL::text AS bank_account_name, NULL::varchar AS linked_invoice_number
    FROM fin_purchase_payment_status s WHERE s.pending > 0
  UNION ALL
  SELECT 'GASTO', g.payable_id::text, g.purchase_root_id, g.purchase_id, NULL::uuid, g.counterparty_name,
         g.concept, NULL::varchar, g.economic_date, g.amount, g.pending,
         g.due_date, g.planned_date,
         'CONFIRMADO', NULL, NULL
    FROM fin_expense_payables g WHERE g.pending > 0
  UNION ALL
  SELECT i.instrument_type::text, i.instrument_id::text, i.purchase_root_id, NULL::uuid, i.supplier_id, i.supplier_name,
         NULL, i.cheque_number, i.issued_date, i.amount, i.amount,
         i.maturity_date, NULL::date,
         CASE WHEN i.purchase_root_id IS NULL THEN 'SIN_IMPUTAR' ELSE 'IMPUTADO' END, i.bank_account_name, i.supplier_invoice_number
    FROM fin_scheduled_payments i;
ALTER VIEW fin_payment_calendar OWNER TO postgres;
REVOKE ALL ON fin_payment_calendar FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_payment_calendar TO authenticated;
