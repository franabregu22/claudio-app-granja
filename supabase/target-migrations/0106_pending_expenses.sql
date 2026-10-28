-- ============================================================================
-- TARGET V1 — 0106 PENDING EXPENSES: THE EXPENSE NOW, THE MONEY WHEN PAID (owner decision 2026-10-28, ADR-026)
--
-- Owner decision: an expense still to pay is recognised in the P&L from its registration, in its category / subcategory, and
-- does NOT move cash / bank until it is actually paid. The P&L already reads purchases by economic_date (accrual: pnl_line_item)
-- and cash / bank are only financial_posting, so the separation needs no report change — only a purchase that is NOT born paid.
--   1. ADR-019 adaptation (minimal): a purchase without a registered supplier (casual) was "born paid" (chk_purchases_casual_paid).
--      Now it is born paid OR pending: without a payment operation it must be a PENDING EXPENSE (an expense_payable on its chain
--      root) — a deferred constraint trigger, so every version of a rectified purchase stays covered. A supplier purchase still
--      has no paid_operation_id (its debt is the supplier ledger, unchanged). Registered suppliers keep the existing circuit
--      (register_purchase → supplier ledger → pay_supplier / Pagos de facturas / own cheques): nothing changes for them.
--   2. expense_payable (the obligation: ONE per expense, its amount = the expense total, optional due date never invented) and
--      expense_payable_payment (each real payment, partial or total; append-only). Pending = amount − payments.
--   3. register_pending_expense (RPC, ADMIN): the purchase (cost in its category, the date of the expense; optional received
--      invoice with its IVA, once) + the obligation. NO financial operation, NO posting.
--   4. pay_pending_expense (RPC, ADMIN): ONE PURCHASE_PAYMENT operation + ONE posting on the paying account (cash / bank) for the
--      amount paid, on the payment date. No purchase, no fiscal document, no P&L line: the expense is never counted twice.
--      Mercado Pago is not a paying account here (a Mercado Pago outflow is classified from Pendientes MP: single gateway).
--   5. Views (security_invoker, ADMIN): fin_expense_payables (Cuentas a pagar / projected flow) and fin_expense_payable_payments.
--   6. WhatsApp: a draft may be a PENDING_EXPENSE ("a pagar", "queda pendiente"…): payload.pending_payment = true; no payment
--      method / account is asked or accepted; the confirmation records it through register_pending_expense. The 0103 wrappers
--      are wrapped again (validate_payload, wa_propose, wa_correct, dispatch); their bodies are kept.
-- Own cheques / eCheqs (0104) are unchanged: they pay registered suppliers' invoices.
-- ============================================================================

-- ── 1. purchases: born paid OR pending ─────────────────────────────────────
ALTER TABLE purchases DROP CONSTRAINT chk_purchases_casual_paid;
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_supplier_unpaid CHECK (supplier_id IS NULL OR paid_operation_id IS NULL);

-- ── 2. the obligation and its payments ─────────────────────────────────────
CREATE TABLE expense_payable (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_root_id UUID NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the expense, whatever its version
  amount           NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  due_date         DATE,                                                                                   -- only when stated
  origin           TEXT NOT NULL CHECK (origin IN ('ERP', 'WHATSAPP')),
  idempotency_key  VARCHAR(100) NOT NULL UNIQUE,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE expense_payable_payment (
  id                     BIGSERIAL PRIMARY KEY,
  payable_id             UUID NOT NULL REFERENCES expense_payable(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id BIGINT NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  effective_date         DATE NOT NULL,
  idempotency_key        VARCHAR(100) NOT NULL UNIQUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX idx_epp_payable ON expense_payable_payment(payable_id);
CREATE TRIGGER trg_expense_payable_immutable BEFORE UPDATE OR DELETE ON expense_payable FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_expense_payable_payment_immutable BEFORE UPDATE OR DELETE ON expense_payable_payment FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE expense_payable ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_payable_payment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE expense_payable, expense_payable_payment FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE expense_payable_payment_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE expense_payable, expense_payable_payment TO authenticated;
CREATE POLICY expense_payable_admin_select ON expense_payable FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY expense_payable_payment_admin_select ON expense_payable_payment FOR SELECT USING (current_app_role() = 'ADMIN');

-- a casual purchase without its payment operation must be a pending expense (checked at commit: the obligation is written after
-- the purchase, and a rectified version keeps its chain root)
CREATE FUNCTION purchase_casual_settlement_check() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.supplier_id IS NULL AND NEW.paid_operation_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM expense_payable e WHERE e.purchase_root_id = purchase_chain_root(NEW.id)) THEN
    RAISE EXCEPTION 'CASUAL_PURCHASE_UNSETTLED: a purchase without a registered supplier is either paid or a pending expense';
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION purchase_casual_settlement_check() OWNER TO postgres;
REVOKE ALL ON FUNCTION purchase_casual_settlement_check() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER trg_purchases_casual_settlement AFTER INSERT OR UPDATE ON purchases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION purchase_casual_settlement_check();

CREATE FUNCTION expense_payable_paid(p_payable UUID) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(sum(amount), 0) FROM expense_payable_payment WHERE payable_id = p_payable;
$$;
ALTER FUNCTION expense_payable_paid(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_payable_paid(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION expense_payable_paid(UUID) TO authenticated;

-- ── 3. register a pending expense: the cost now, no money ──────────────────
CREATE FUNCTION register_pending_expense(
  p_economic_date       DATE,
  p_amount_net          NUMERIC,
  p_amount_total        NUMERIC,
  p_expense_category_id UUID,
  p_concept             VARCHAR,
  p_nature              purchase_nature,
  p_idempotency_key     VARCHAR,
  p_due_date            DATE DEFAULT NULL,
  p_counterparty_name   VARCHAR DEFAULT NULL,
  p_lines               JSONB DEFAULT '[]'::jsonb,
  p_attachments         JSONB DEFAULT '[]'::jsonb,
  p_fiscal              JSONB DEFAULT NULL,
  p_origin              TEXT DEFAULT 'ERP',
  p_reason              TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid(); v_concept VARCHAR := nullif(btrim(p_concept), ''); v_name VARCHAR := nullif(btrim(p_counterparty_name), '');
  v_existing purchases%ROWTYPE; v_purchase UUID := gen_random_uuid(); v_payable UUID; v_fiscal UUID; v_res JSONB; v_line JSONB; v_att JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  IF left(p_idempotency_key, 8) = 'RECTIFY:' THEN RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefix RECTIFY: is reserved'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pending_expense:' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM purchases WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT id INTO v_payable FROM expense_payable WHERE purchase_root_id = v_existing.id;
    IF v_payable IS NULL THEN RAISE EXCEPTION 'DUPLICATE_PURCHASE'; END IF;
    RETURN jsonb_build_object('purchase_id', v_existing.id, 'payable_id', v_payable, 'replayed', true, 'amount', v_existing.amount_total,
                              'fiscal_document_id', v_existing.fiscal_document_id, 'financial_effect', 'NONE');
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_net IS NULL OR p_amount_net < 0 OR p_amount_net > p_amount_total THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
  END IF;
  IF v_concept IS NULL OR length(v_concept) > 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_nature IS NULL THEN RAISE EXCEPTION 'NATURE_REQUIRED'; END IF;
  IF v_name IS NOT NULL AND length(v_name) > 120 THEN RAISE EXCEPTION 'INVALID_COUNTERPARTY_NAME: at most 120 characters'; END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('ERP', 'WHATSAPP') THEN RAISE EXCEPTION 'INVALID_ORIGIN'; END IF;
  IF p_due_date IS NOT NULL AND p_due_date < p_economic_date THEN RAISE EXCEPTION 'INVALID_DUE_DATE: the due date is before the expense date'; END IF;
  IF p_attachments IS NOT NULL AND jsonb_typeof(p_attachments) <> 'array' THEN RAISE EXCEPTION 'INVALID_ATTACHMENTS: attachments must be an array'; END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'INVALID_LINES: lines must be an array'; END IF;
  PERFORM assert_period_open(p_economic_date);
  -- optional received invoice (issuer form, as a casual purchase): its IVA is recorded once, here
  IF p_fiscal IS NOT NULL THEN
    IF jsonb_typeof(p_fiscal) <> 'object' OR coalesce(p_fiscal ->> 'issuer_tax_id', '') = '' THEN
      RAISE EXCEPTION 'INVALID_FISCAL_DOCUMENT: an issuer CUIT is required for the invoice of a casual purchase';
    END IF;
    v_res := fiscal_document_insert((p_fiscal ->> 'document_type')::fiscal_document_type, 'CREDITO', (p_fiscal ->> 'document_date')::DATE,
               (p_fiscal ->> 'fiscal_period')::DATE, (p_fiscal ->> 'net_amount')::NUMERIC, (p_fiscal ->> 'total_amount')::NUMERIC,
               coalesce(p_fiscal -> 'components', '[]'::jsonb), NULL, NULL, p_fiscal ->> 'external_number',
               p_fiscal ->> 'issuer_tax_id', p_fiscal ->> 'issuer_name', p_reason);
    v_fiscal := (v_res ->> 'fiscal_document_id')::UUID;
  END IF;
  -- the expense (P&L, by its date and category); no supplier, no payment operation
  INSERT INTO purchases (id, supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
         project_id, fiscal_document_id, supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (v_purchase, NULL, v_name, p_economic_date, p_amount_net, p_amount_total, p_expense_category_id, v_concept, p_nature,
          NULL, v_fiscal, CASE WHEN p_fiscal IS NOT NULL THEN p_fiscal ->> 'external_number' END, NULL, NULL, true, 0, p_idempotency_key, v_uid);
  FOR v_line IN SELECT value FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario)
    VALUES (v_purchase, (v_line->>'producto_id')::UUID, (v_line->>'feed_ingredient_id')::UUID, v_line->>'descripcion',
            (v_line->>'cantidad')::NUMERIC, (v_line->>'unit_type')::unit_type, (v_line->>'precio_unitario')::NUMERIC);
  END LOOP;
  FOR v_att IN SELECT value FROM jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) LOOP
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
    VALUES (v_purchase, v_att->>'storage_path', v_att->>'file_name', v_att->>'content_type', (v_att->>'byte_size')::BIGINT, v_uid);
  END LOOP;
  -- the obligation
  INSERT INTO expense_payable (purchase_root_id, amount, due_date, origin, idempotency_key, reason, created_by)
  VALUES (v_purchase, p_amount_total, p_due_date, p_origin, p_idempotency_key, p_reason, v_uid)
  RETURNING id INTO v_payable;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_purchase::TEXT, 'CREATE_PENDING_EXPENSE',
          jsonb_build_object('amount_total', p_amount_total, 'economic_date', p_economic_date, 'payable_id', v_payable, 'due_date', p_due_date,
                             'fiscal_document_id', v_fiscal, 'origin', p_origin), coalesce(p_reason, v_concept), v_uid);
  RETURN jsonb_build_object('purchase_id', v_purchase, 'payable_id', v_payable, 'replayed', false, 'amount', p_amount_total,
                            'fiscal_document_id', v_fiscal, 'financial_effect', 'NONE', 'due_date', p_due_date);
END $$;

-- ── 4. pay it later (total or partial): only the real money ────────────────
CREATE FUNCTION pay_pending_expense(
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
                              'paid', expense_payable_paid(p_payable_id), 'pending', (SELECT amount FROM expense_payable WHERE id = p_payable_id) - expense_payable_paid(p_payable_id));
  END IF;
  SELECT * INTO v_pay FROM expense_payable WHERE id = p_payable_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYABLE_NOT_FOUND'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  v_paid := expense_payable_paid(v_pay.id);
  IF v_paid + p_amount > v_pay.amount THEN RAISE EXCEPTION 'OVER_PAYMENT: the pending balance is %', v_pay.amount - v_paid; END IF;
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

DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT unnest(ARRAY['register_pending_expense(date,numeric,numeric,uuid,varchar,purchase_nature,varchar,date,varchar,jsonb,jsonb,jsonb,text,text)',
                               'pay_pending_expense(uuid,numeric,date,uuid,payment_method,varchar,text)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $p$;

-- ── 5. read models ──────────────────────────────────────────────────────────
CREATE VIEW fin_expense_payables WITH (security_invoker = true) AS
  SELECT e.id AS payable_id, cur.id AS purchase_id, e.purchase_root_id, cur.economic_date, cur.subcategory AS concept, cur.counterparty_name,
         cur.expense_category_id, ec.nombre AS category_name, cur.nature, cur.fiscal_document_id, e.amount,
         expense_payable_paid(e.id) AS paid, e.amount - expense_payable_paid(e.id) AS pending, e.due_date,
         CASE WHEN expense_payable_paid(e.id) = 0 THEN 'PENDIENTE' WHEN expense_payable_paid(e.id) < e.amount THEN 'PARCIAL' ELSE 'PAGADO' END AS status,
         e.origin, e.created_at, e.created_by
    FROM expense_payable e
    JOIN purchases cur ON cur.is_current AND cur.supplier_id IS NULL AND cur.paid_operation_id IS NULL AND purchase_chain_root(cur.id) = e.purchase_root_id
    JOIN expense_category ec ON ec.id = cur.expense_category_id;
CREATE VIEW fin_expense_payable_payments WITH (security_invoker = true) AS
  SELECT p.id AS payment_id, p.payable_id, p.amount, p.effective_date, p.financial_operation_id, fp.financial_account_id, fa.nombre AS account_name, p.created_at, p.created_by
    FROM expense_payable_payment p
    JOIN financial_posting fp ON fp.financial_operation_id = p.financial_operation_id
    JOIN financial_account fa ON fa.id = fp.financial_account_id;
ALTER VIEW fin_expense_payables OWNER TO postgres;
ALTER VIEW fin_expense_payable_payments OWNER TO postgres;
REVOKE ALL ON fin_expense_payables, fin_expense_payable_payments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_expense_payables, fin_expense_payable_payments TO authenticated;

-- ── 6. WhatsApp: PENDING_EXPENSE drafts ─────────────────────────────────────
DO $c$ DECLARE n TEXT; BEGIN
  SELECT conname INTO n FROM pg_constraint WHERE conrelid = 'wa.draft'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%CASUAL_EXPENSE%';
  EXECUTE format('ALTER TABLE wa.draft DROP CONSTRAINT %I', n);
END $c$;
ALTER TABLE wa.draft ADD CONSTRAINT draft_type_check CHECK (type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE', 'SUPPLIER_CREDIT_PURCHASE',
  'SUPPLIER_PURCHASE_WITH_INVOICE', 'VAT_ONLY_DOCUMENT', 'PENDING_EXPENSE'));

-- payload rules: a pending expense is a casual expense (with or without its invoice) WITHOUT method / account / Mercado Pago
ALTER FUNCTION wa.validate_payload(TEXT, JSONB) RENAME TO validate_payload_0103;
CREATE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p JSONB := p_payload; v_due DATE; r JSONB;
BEGIN
  IF jsonb_typeof(p) = 'object' AND (p_type = 'PENDING_EXPENSE' OR coalesce((p ->> 'pending_payment')::boolean, false)) THEN
    IF p_type NOT IN ('PENDING_EXPENSE', 'CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: only an expense can be left to pay'; END IF;
    IF p ? 'mp_source_id' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: a pending expense has no Mercado Pago outflow'; END IF;
    IF coalesce(p ->> 'due_date', '') <> '' THEN
      IF (p ->> 'due_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: due_date'; END IF;
      v_due := (p ->> 'due_date')::date;
      IF v_due < (p ->> 'date')::date OR v_due > (p ->> 'date')::date + 730 THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: due_date outside the expense date + 2 years'; END IF;
    END IF;
    r := wa.validate_payload_0103(CASE WHEN jsonb_typeof(p -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END,
                                  p - 'method' - 'account_id' - 'method_pending' - 'account_pending' - 'pending_payment' - 'due_date');
    RETURN (r - 'method' - 'account_id' - 'method_pending' - 'account_pending' - 'needs_mp')
           || jsonb_build_object('pending_payment', true, 'needs_mp', false) || CASE WHEN v_due IS NOT NULL THEN jsonb_build_object('due_date', v_due) ELSE '{}'::jsonb END;
  END IF;
  RETURN wa.validate_payload_0103(p_type, p);
END $$;

-- the draft type follows the payload: n8n proposes / corrects a casual expense with pending_payment, the draft becomes PENDING_EXPENSE
ALTER FUNCTION public.wa_propose(BIGINT, TEXT, JSONB) SET SCHEMA wa;
ALTER FUNCTION wa.wa_propose(BIGINT, TEXT, JSONB) RENAME TO propose_0103;
REVOKE ALL ON FUNCTION wa.propose_0103(BIGINT, TEXT, JSONB) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_propose(p_inbound_id BIGINT, p_type TEXT, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_pending BOOLEAN := p_type = 'PENDING_EXPENSE' OR (jsonb_typeof(p_payload) = 'object' AND coalesce((p_payload ->> 'pending_payment')::boolean, false));
        r JSONB;
BEGIN
  PERFORM wa.gate();
  IF v_pending AND p_type NOT IN ('PENDING_EXPENSE', 'CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') THEN RAISE EXCEPTION 'WA_INVALID_TYPE: %', p_type; END IF;
  r := wa.propose_0103(p_inbound_id,
                       CASE WHEN v_pending THEN CASE WHEN jsonb_typeof(p_payload -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END ELSE p_type END,
                       CASE WHEN v_pending THEN p_payload || jsonb_build_object('pending_payment', true) ELSE p_payload END);
  IF v_pending AND coalesce((r ->> 'ok')::boolean, false) AND r ? 'draft_id' THEN
    UPDATE wa.draft SET type = 'PENDING_EXPENSE' WHERE id = (r ->> 'draft_id')::uuid AND type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE');
    r := r || jsonb_build_object('type', 'PENDING_EXPENSE');
  END IF;
  RETURN r;
END $$;

ALTER FUNCTION public.wa_correct(BIGINT, UUID, INTEGER, JSONB) SET SCHEMA wa;
ALTER FUNCTION wa.wa_correct(BIGINT, UUID, INTEGER, JSONB) RENAME TO correct_0103;
REVOKE ALL ON FUNCTION wa.correct_0103(BIGINT, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_correct(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_pending BOOLEAN := jsonb_typeof(p_payload) = 'object' AND coalesce((p_payload ->> 'pending_payment')::boolean, false); r JSONB;
BEGIN
  PERFORM wa.gate();
  -- paid ⇄ to pay: the type follows the corrected payload (the correction itself re-checks owner, state and version; a refusal
  -- rolls this back with it)
  UPDATE wa.draft SET type = CASE WHEN v_pending THEN 'PENDING_EXPENSE'
                                  WHEN jsonb_typeof(p_payload -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END
   WHERE id = p_draft_id AND state IN ('DRAFT', 'FAILED') AND type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE', 'PENDING_EXPENSE')
     AND (type = 'PENDING_EXPENSE') <> v_pending;
  r := wa.correct_0103(p_inbound_id, p_draft_id, p_expected_version, p_payload);
  RETURN r;
END $$;

-- recording: a PENDING_EXPENSE goes to register_pending_expense (no money); every other type to the 0102 dispatch
ALTER FUNCTION wa.dispatch(wa.draft, TEXT) RENAME TO dispatch_0102;
CREATE FUNCTION wa.dispatch(d wa.draft, p_key TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p JSONB := d.payload; f JSONB := d.payload -> 'fiscal'; v_reason TEXT := 'WhatsApp ' || d.short_code || ' v' || d.version;
BEGIN
  IF d.type = 'PENDING_EXPENSE' THEN
    RETURN register_pending_expense(
      p_economic_date := (p ->> 'date')::date, p_amount_net := coalesce((p ->> 'net')::numeric, (p ->> 'total')::numeric),
      p_amount_total := (p ->> 'total')::numeric, p_expense_category_id := (p ->> 'category_id')::uuid, p_concept := p ->> 'concept',
      p_nature := (p ->> 'nature')::purchase_nature, p_idempotency_key := p_key, p_due_date := (p ->> 'due_date')::date,
      p_counterparty_name := p ->> 'counterparty', p_lines := '[]'::jsonb, p_attachments := '[]'::jsonb,
      p_fiscal := CASE WHEN jsonb_typeof(f) = 'object' THEN f END, p_origin := 'WHATSAPP', p_reason := v_reason);
  END IF;
  RETURN wa.dispatch_0102(d, p_key);
END $$;

-- a draft whose payload says "to pay" must be a PENDING_EXPENSE (and the reverse): never recorded as paid by mistake
ALTER FUNCTION public.wa_confirm(BIGINT, UUID, INTEGER) SET SCHEMA wa;
ALTER FUNCTION wa.wa_confirm(BIGINT, UUID, INTEGER) RENAME TO confirm_0103;
REVOKE ALL ON FUNCTION wa.confirm_0103(BIGINT, UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM wa.gate();
  IF EXISTS (SELECT 1 FROM wa.draft d WHERE d.id = p_draft_id AND d.state = 'DRAFT'
              AND (d.type = 'PENDING_EXPENSE') <> coalesce((d.payload ->> 'pending_payment')::boolean, false)) THEN
    RAISE EXCEPTION 'WA_INVALID_PAYLOAD: the draft type and its payment state differ';
  END IF;
  RETURN wa.confirm_0103(p_inbound_id, p_draft_id, p_expected_version);
END $$;

DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT unnest(ARRAY['public.wa_propose(bigint,text,jsonb)', 'public.wa_correct(bigint,uuid,integer,jsonb)', 'public.wa_confirm(bigint,uuid,integer)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  FOR f IN SELECT unnest(ARRAY['wa.validate_payload(text,jsonb)', 'wa.dispatch(wa.draft,text)', 'wa.validate_payload_0103(text,jsonb)', 'wa.dispatch_0102(wa.draft,text)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $p$;
