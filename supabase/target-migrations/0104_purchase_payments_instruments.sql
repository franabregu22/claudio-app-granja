-- ============================================================================
-- TARGET V1 — 0104 INVOICE PAYMENTS WITH OWN CHEQUES / eCHEQS (owner GO 2026-10-25)
--
-- The economics are the existing ones (0016 / 0018, unchanged): issuing an own cheque reduces the supplier debt and does NOT touch
-- the bank (a SCHEDULED payment); mark_supplier_instrument_debited moves the bank on the effective debit date (the REAL payment);
-- reject / cancel compensate exactly as before. The invoice (purchase) enters the P&L once, by its own date (ADR-004); IVA lives
-- only in its fiscal document. Nothing here posts money by itself.
--   1. purchase_payment_allocation (append-only): WHICH payments settle WHICH invoice — own instruments and / or supplier
--      payments (mixed payments). Informational for the supplier ledger (never re-booked). An allocation counts while its
--      instrument is ISSUED / DEBITED; a REJECTED / CANCELLED instrument frees its amount.
--   2. financial_instrument.replaces_instrument_id: a replacement cheque points to the rejected / cancelled one (history kept).
--   3. RPCs (SECURITY DEFINER, ADMIN): issue_purchase_instruments (one or several cheques for one invoice, with their PDFs,
--      atomic, idempotent, never above the invoice's pending balance), allocate_purchase_payment (a supplier payment already
--      registered → that invoice), attach_instrument_document (a PDF afterwards), register_erp_document (helper for uploads).
--   4. Views (security_invoker, ADMIN): fin_purchase_payment_status (invoice total / scheduled / debited / other payments /
--      pending), fin_purchase_payment_detail (each payment and its history) and fin_scheduled_payments (own instruments still to be
--      debited: the maturity calendar).
-- Third-party cheques (direction RECEIVED) can be allocated later through the same table; their operation is not implemented here.
-- ============================================================================

ALTER TABLE financial_instrument ADD COLUMN replaces_instrument_id UUID UNIQUE REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE CASCADE;

-- the first version of a purchase: rectifications carry 'RECTIFY:<previous version>:v<n>' (0022 / 0088), so the chain is exact
CREATE FUNCTION purchase_chain_root(p_purchase UUID) RETURNS UUID LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v UUID := p_purchase; k TEXT; n INT := 0;
BEGIN
  LOOP
    SELECT idempotency_key INTO k FROM purchases WHERE id = v;
    IF k IS NULL OR k !~ '^RECTIFY:[0-9a-f-]{36}:v[0-9]+$' OR n > 100 THEN RETURN v; END IF;
    v := split_part(k, ':', 2)::uuid; n := n + 1;
  END LOOP;
END $$;
ALTER FUNCTION purchase_chain_root(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION purchase_chain_root(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION purchase_chain_root(UUID) TO authenticated;

CREATE TABLE purchase_payment_allocation (
  id                      BIGSERIAL PRIMARY KEY,
  purchase_root_id        UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the invoice, whatever its version
  financial_instrument_id UUID UNIQUE REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id  BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                  NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  idempotency_key         VARCHAR(120) NOT NULL UNIQUE,
  reason                  TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_ppa_one_payment CHECK ((financial_instrument_id IS NULL) <> (financial_operation_id IS NULL))
);
CREATE INDEX idx_ppa_purchase ON purchase_payment_allocation(purchase_root_id);
CREATE INDEX idx_ppa_operation ON purchase_payment_allocation(financial_operation_id) WHERE financial_operation_id IS NOT NULL;
CREATE TRIGGER trg_ppa_immutable BEFORE UPDATE OR DELETE ON purchase_payment_allocation FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE purchase_payment_allocation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purchase_payment_allocation FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE purchase_payment_allocation_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE purchase_payment_allocation TO authenticated;
CREATE POLICY ppa_admin_select ON purchase_payment_allocation FOR SELECT USING (current_app_role() = 'ADMIN');

-- the amount still allocated to an invoice: instruments ISSUED / DEBITED + supplier payments (rejected / cancelled free theirs)
CREATE FUNCTION purchase_allocated_amount(p_root UUID) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(sum(a.amount), 0) FROM purchase_payment_allocation a LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id
   WHERE a.purchase_root_id = p_root AND (a.financial_operation_id IS NOT NULL OR i.estado IN ('ISSUED', 'DEBITED'));
$$;
ALTER FUNCTION purchase_allocated_amount(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION purchase_allocated_amount(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- an ERP upload (Storage purchase-attachments, own folder) registered as a document (dedupe by sha256; ADMIN only)
CREATE FUNCTION register_erp_document(p_storage_path TEXT, p_sha256 TEXT, p_content_type TEXT, p_byte_size BIGINT, p_file_name TEXT) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF coalesce(p_storage_path, '') !~ ('^' || v_uid::text || '/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$') THEN RAISE EXCEPTION 'INVALID_DOCUMENT: path must be <your user id>/<uuid>.<ext>'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'purchase-attachments' AND o.name = p_storage_path) THEN RAISE EXCEPTION 'INVALID_DOCUMENT: the file was not uploaded'; END IF;
  INSERT INTO document_file (storage_bucket, storage_path, sha256, content_type, byte_size, file_name, origin, received_by)
  VALUES ('purchase-attachments', p_storage_path, lower(p_sha256), p_content_type, p_byte_size, left(coalesce(nullif(btrim(p_file_name), ''), 'documento'), 255), 'ERP', v_uid)
  ON CONFLICT (sha256) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM document_file WHERE sha256 = lower(p_sha256); END IF;
  RETURN v_id;
END $$;

-- ── issue one or several own cheques / eCheqs for ONE invoice (mixed with other payments through allocate_purchase_payment) ──
-- p_instruments: [{instrument_type, cheque_number, amount, maturity_date, issued_date, bank_account_id,
--                  replaces_instrument_id?, document?: {storage_path, sha256, content_type, byte_size, file_name}}]
CREATE FUNCTION issue_purchase_instruments(p_purchase_id UUID, p_instruments JSONB, p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_p purchases; v_root UUID; x JSONB; i INT := 0; v_res JSONB; v_inst UUID; v_old financial_instrument;
        v_total NUMERIC := 0; v_ids JSONB := '[]'::jsonb; v_doc UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF coalesce(btrim(p_idempotency_key), '') = '' OR length(p_idempotency_key) > 80 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY'; END IF;
  -- replay: the same key returns what was issued
  IF EXISTS (SELECT 1 FROM purchase_payment_allocation WHERE idempotency_key LIKE p_idempotency_key || ':%') THEN
    RETURN jsonb_build_object('replayed', true, 'instrument_ids', (SELECT jsonb_agg(financial_instrument_id ORDER BY id) FROM purchase_payment_allocation WHERE idempotency_key LIKE p_idempotency_key || ':%'));
  END IF;
  SELECT * INTO v_p FROM purchases WHERE id = p_purchase_id AND is_current FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND: not a current purchase'; END IF;
  IF v_p.supplier_id IS NULL THEN RAISE EXCEPTION 'SUPPLIER_REQUIRED: own cheques pay a registered supplier'' invoice'; END IF;
  IF jsonb_typeof(p_instruments) <> 'array' OR jsonb_array_length(p_instruments) NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'INVALID_INSTRUMENTS: 1–24 instruments'; END IF;
  v_root := purchase_chain_root(v_p.id);
  FOR x IN SELECT value FROM jsonb_array_elements(p_instruments) LOOP v_total := v_total + (x ->> 'amount')::numeric; END LOOP;
  IF v_total IS NULL OR v_total <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF purchase_allocated_amount(v_root) + v_total > v_p.amount_total THEN
    RAISE EXCEPTION 'OVER_ALLOCATION: the invoice total is %, already allocated %', v_p.amount_total, purchase_allocated_amount(v_root);
  END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_instruments) LOOP
    i := i + 1;
    IF x ? 'replaces_instrument_id' AND x ->> 'replaces_instrument_id' IS NOT NULL THEN
      SELECT * INTO v_old FROM financial_instrument WHERE id = (x ->> 'replaces_instrument_id')::uuid FOR UPDATE;
      IF NOT FOUND OR v_old.direction <> 'ISSUED' OR v_old.estado NOT IN ('REJECTED', 'CANCELLED') THEN
        RAISE EXCEPTION 'INVALID_REPLACEMENT: only a rejected or cancelled own instrument can be replaced';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM purchase_payment_allocation a WHERE a.financial_instrument_id = v_old.id AND a.purchase_root_id = v_root) THEN
        RAISE EXCEPTION 'INVALID_REPLACEMENT: the replaced instrument did not pay this invoice';
      END IF;
    END IF;
    v_res := issue_supplier_instrument(v_p.supplier_id, (x ->> 'instrument_type')::financial_instrument_type, x ->> 'cheque_number',
               (x ->> 'amount')::numeric, (x ->> 'maturity_date')::date, (x ->> 'issued_date')::date, (x ->> 'bank_account_id')::uuid,
               left(p_idempotency_key || ':' || i, 100), coalesce(p_reason, 'Pago de factura ' || coalesce(v_p.supplier_invoice_number, v_p.id::text)));
    v_inst := (v_res ->> 'instrument_id')::uuid;
    IF x ->> 'replaces_instrument_id' IS NOT NULL THEN
      UPDATE financial_instrument SET replaces_instrument_id = (x ->> 'replaces_instrument_id')::uuid WHERE id = v_inst;
    END IF;
    INSERT INTO purchase_payment_allocation (purchase_root_id, financial_instrument_id, amount, idempotency_key, reason, created_by)
    VALUES (v_root, v_inst, (x ->> 'amount')::numeric, p_idempotency_key || ':' || i, p_reason, v_uid);
    IF jsonb_typeof(x -> 'document') = 'object' THEN
      v_doc := register_erp_document(x -> 'document' ->> 'storage_path', x -> 'document' ->> 'sha256', x -> 'document' ->> 'content_type',
                                     (x -> 'document' ->> 'byte_size')::bigint, x -> 'document' ->> 'file_name');
      INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (v_doc, 'FINANCIAL_INSTRUMENT', v_inst::text, v_uid) ON CONFLICT DO NOTHING;
    END IF;
    v_ids := v_ids || to_jsonb(v_inst);
  END LOOP;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_root::text, 'ISSUE_INSTRUMENTS', jsonb_build_object('instruments', v_ids, 'amount', v_total), p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'instrument_ids', v_ids, 'allocated', purchase_allocated_amount(v_root), 'invoice_total', v_p.amount_total);
END $$;

-- a supplier payment already registered (pay_supplier) → part of THIS invoice (mixed payments); never above either amount
CREATE FUNCTION allocate_purchase_payment(p_purchase_id UUID, p_financial_operation_id BIGINT, p_amount NUMERIC, p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid UUID := auth.uid(); v_p purchases; v_root UUID; v_op financial_operation; v_paid NUMERIC; v_used NUMERIC;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF EXISTS (SELECT 1 FROM purchase_payment_allocation WHERE idempotency_key = p_idempotency_key) THEN
    RETURN jsonb_build_object('replayed', true);
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  SELECT * INTO v_p FROM purchases WHERE id = p_purchase_id AND is_current FOR UPDATE;
  IF NOT FOUND OR v_p.supplier_id IS NULL THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND: a current supplier purchase is required'; END IF;
  SELECT * INTO v_op FROM financial_operation WHERE id = p_financial_operation_id FOR UPDATE;
  IF NOT FOUND OR v_op.operation_type::text <> 'SUPPLIER_PAYMENT' OR v_op.source_entity_id IS DISTINCT FROM v_p.supplier_id::text THEN
    RAISE EXCEPTION 'INVALID_PAYMENT: a payment to the same supplier is required';
  END IF;
  v_paid := (SELECT -sum(signed_amount) FROM financial_posting WHERE financial_operation_id = v_op.id);
  v_used := (SELECT coalesce(sum(amount), 0) FROM purchase_payment_allocation WHERE financial_operation_id = v_op.id);
  IF v_used + p_amount > v_paid THEN RAISE EXCEPTION 'OVER_ALLOCATION: the payment is %, already allocated %', v_paid, v_used; END IF;
  v_root := purchase_chain_root(v_p.id);
  IF purchase_allocated_amount(v_root) + p_amount > v_p.amount_total THEN RAISE EXCEPTION 'OVER_ALLOCATION: above the invoice total'; END IF;
  INSERT INTO purchase_payment_allocation (purchase_root_id, financial_operation_id, amount, idempotency_key, reason, created_by)
  VALUES (v_root, v_op.id, p_amount, p_idempotency_key, p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'allocated', purchase_allocated_amount(v_root), 'invoice_total', v_p.amount_total);
END $$;

-- a PDF of an own instrument after the fact
CREATE FUNCTION attach_instrument_document(p_instrument_id UUID, p_document JSONB) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_doc UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_instrument WHERE id = p_instrument_id) THEN RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND'; END IF;
  v_doc := register_erp_document(p_document ->> 'storage_path', p_document ->> 'sha256', p_document ->> 'content_type', (p_document ->> 'byte_size')::bigint, p_document ->> 'file_name');
  INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by) VALUES (v_doc, 'FINANCIAL_INSTRUMENT', p_instrument_id::text, auth.uid()) ON CONFLICT DO NOTHING;
  RETURN v_doc;
END $$;

DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT unnest(ARRAY['register_erp_document(text,text,text,bigint,text)', 'issue_purchase_instruments(uuid,jsonb,varchar,text)',
                               'allocate_purchase_payment(uuid,bigint,numeric,varchar,text)', 'attach_instrument_document(uuid,jsonb)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $p$;

-- ── read models (ADMIN through the underlying RLS) ──────────────────────────
CREATE VIEW fin_purchase_payment_status WITH (security_invoker = true) AS
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
         coalesce(al.voided_instruments, 0) AS voided_instruments
    FROM cur JOIN suppliers s ON s.id = cur.supplier_id LEFT JOIN al ON al.purchase_root_id = cur.root;
CREATE VIEW fin_scheduled_payments WITH (security_invoker = true) AS
  SELECT i.id AS instrument_id, i.instrument_type, i.cheque_number, i.amount, i.issued_date, i.maturity_date, i.estado,
         i.bank_account_id, fa.nombre AS bank_account_name, i.supplier_id, s.nombre AS supplier_name, i.replaces_instrument_id,
         a.purchase_root_id, p.supplier_invoice_number,
         (SELECT count(*) FROM document_link l WHERE l.target_kind = 'FINANCIAL_INSTRUMENT' AND l.target_id = i.id::text) AS document_count
    FROM financial_instrument i
    JOIN financial_account fa ON fa.id = i.bank_account_id
    JOIN suppliers s ON s.id = i.supplier_id
    LEFT JOIN purchase_payment_allocation a ON a.financial_instrument_id = i.id
    LEFT JOIN purchases p ON p.id = a.purchase_root_id
   WHERE i.direction = 'ISSUED' AND i.estado = 'ISSUED';
-- every payment of an invoice with its history (issued / debited / rejected / cancelled / replacement) and documents
CREATE VIEW fin_purchase_payment_detail WITH (security_invoker = true) AS
  SELECT a.id AS allocation_id, a.purchase_root_id, a.amount, a.created_at, a.financial_instrument_id, i.instrument_type, i.cheque_number,
         i.issued_date, i.maturity_date, i.debited_date, i.rejected_date, i.estado, i.replaces_instrument_id, i.bank_account_id, fa.nombre AS bank_account_name,
         a.financial_operation_id, o.effective_date AS payment_date,
         (SELECT count(*) FROM document_link l WHERE l.target_kind = 'FINANCIAL_INSTRUMENT' AND l.target_id = i.id::text) AS document_count
    FROM purchase_payment_allocation a
    LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id
    LEFT JOIN financial_account fa ON fa.id = i.bank_account_id
    LEFT JOIN financial_operation o ON o.id = a.financial_operation_id;
ALTER VIEW fin_purchase_payment_status OWNER TO postgres;
ALTER VIEW fin_scheduled_payments OWNER TO postgres;
ALTER VIEW fin_purchase_payment_detail OWNER TO postgres;
REVOKE ALL ON fin_purchase_payment_status, fin_scheduled_payments, fin_purchase_payment_detail FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_purchase_payment_status, fin_scheduled_payments, fin_purchase_payment_detail TO authenticated;
