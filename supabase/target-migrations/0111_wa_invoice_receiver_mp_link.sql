-- ============================================================================
-- TARGET V1 — 0111 WHATSAPP: FACTURA A (RECEPTOR / CUIT EMISOR) Y GASTO PAGADO CON MERCADO PAGO REGISTRADO AL CONFIRMAR
-- (owner GO Lote 4 — opción A, 2026-10-30; ADR-021 §2.3(c), ADR-019 §2 and ADR-025 amended)
--
--   1. Factura A (n8n reads, the database guards). Two payload markers keep a draft from being confirmed until the user answers:
--        · vat_receiver_pending — Factura A with IVA discriminated whose receiver CUIT could not be identified: the IVA is neither
--          assumed computable nor assumed foreign (WA_RECEIVER_REQUIRED);
--        · issuer_cuit_pending — an invoice whose issuer CUIT could not be read: its fiscal data wait in payload.fiscal_pending (not
--          validated, never recorded) until the user writes the CUIT or says "sin factura" (WA_ISSUER_CUIT_REQUIRED).
--      wa_correct: a casual draft follows its payload (fiscal present ⇄ CASUAL_WITH_INVOICE / CASUAL_EXPENSE).
--   2. A casual purchase paid with Mercado Pago whose movement is not linked yet (ADR-019 §2 as amended: born paid, OR pending
--      (ADR-026), OR paid by Mercado Pago awaiting its movement — never two of them):
--        · purchase_mp_link (one per purchase chain root, append-only): the explicit state "Gasto registrado · MP pendiente de
--          vincular"; purchase_mp_settlement (append-only): its link to the real outflow (state "Vinculado");
--        · register_casual_purchase_mp_pending (ADMIN): the purchase (P&L at its economic date), its invoice + IVA (once), lines,
--          attachments and the purchase_mp_link — NO financial operation, NO posting, NO supplier debt, NO expense_payable;
--        · settle_purchase_mp (ADMIN, idempotent, audited): ADR-021 §2.3(c) route PURCHASE_MP_LINK — releases the provisional and
--          writes ONLY the payment side (PURCHASE_PAYMENT of |gross| on the MOVEMENT date + its tax / fee charges + the
--          CASUAL_PURCHASE classification pointing to the EXISTING purchase). No purchase, no fiscal document, no P&L line. An
--          outflow already classified / applied is refused (never re-pointed); the purchase total must equal the outflow's
--          comparable gross exactly; only the movement's period must be open (the purchase is not rewritten);
--        · purchase_casual_settlement_check (0106/0107): a casual purchase without payment is a pending expense XOR an MP link;
--        · fin_purchase_mp_link (ADMIN): pending / linked, both dates, age, and the pending outflows of the same amount (listed only);
--        · fin_mp_report_activity: a linked outflow shows its (existing) purchase; management period close: a WARNING (never a
--          block) and an audit row when the period still holds purchases waiting for their Mercado Pago movement.
--   3. WhatsApp: a draft paid with Mercado Pago without its outflow is an ordinary DRAFT (no WAITING_MP, no candidate search, no
--      "mp <número>"); its confirmation records it through register_casual_purchase_mp_pending (P&L + IVA now, money later).
--      Legacy WAITING_MP drafts keep wa_link_mp.
-- ============================================================================

-- ── 1. payload rules (wrap 0106) ──────────────────────────────────────────────
ALTER FUNCTION wa.validate_payload(TEXT, JSONB) RENAME TO validate_payload_0106;
CREATE FUNCTION wa.validate_payload(p_type TEXT, p_payload JSONB) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p JSONB := p_payload; r JSONB;
BEGIN
  IF jsonb_typeof(p) = 'object' THEN
    IF p ? 'fiscal_pending' THEN
      IF jsonb_typeof(p -> 'fiscal_pending') <> 'object' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal_pending'; END IF;
      IF jsonb_typeof(p -> 'fiscal') = 'object' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal and fiscal_pending together'; END IF;
      IF p_type NOT IN ('CASUAL_EXPENSE', 'PENDING_EXPENSE') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: fiscal_pending only on an expense without its invoice yet'; END IF;
    END IF;
    IF (p ? 'issuer_cuit_pending') <> (p ? 'fiscal_pending') THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: issuer_cuit_pending goes with fiscal_pending'; END IF;
    IF p ? 'vat_receiver_pending' AND jsonb_typeof(p -> 'fiscal') IS DISTINCT FROM 'object' AND jsonb_typeof(p -> 'fiscal_pending') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'WA_INVALID_PAYLOAD: vat_receiver_pending without fiscal data';
    END IF;
    IF p ? 'vat_receiver_pending' AND jsonb_array_length(coalesce(coalesce(p -> 'fiscal', p -> 'fiscal_pending') -> 'components', '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'WA_INVALID_PAYLOAD: no computable IVA while the receiver is not identified';
    END IF;
    p := p - 'mp_link_pending';
  END IF;
  r := wa.validate_payload_0106(p_type, p);
  -- Mercado Pago without its outflow: an ordinary draft (confirmable; the purchase now, the money linked later from the ERP)
  IF r ->> 'method' = 'MERCADOPAGO' AND NOT r ? 'mp_source_id' THEN
    r := r || jsonb_build_object('needs_mp', false, 'mp_link_pending', true);
  END IF;
  RETURN r;
END $$;

-- ── 2. correction: a casual draft follows its payload (invoice present or not) ─
ALTER FUNCTION public.wa_correct(BIGINT, UUID, INTEGER, JSONB) SET SCHEMA wa;
ALTER FUNCTION wa.wa_correct(BIGINT, UUID, INTEGER, JSONB) RENAME TO correct_0106;
REVOKE ALL ON FUNCTION wa.correct_0106(BIGINT, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_correct(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER, p_payload JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM wa.gate();
  IF jsonb_typeof(p_payload) = 'object' AND NOT coalesce((p_payload ->> 'pending_payment')::boolean, false) THEN
    UPDATE wa.draft SET type = CASE WHEN jsonb_typeof(p_payload -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END
     WHERE id = p_draft_id AND state IN ('DRAFT', 'FAILED') AND type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE')
       AND type <> CASE WHEN jsonb_typeof(p_payload -> 'fiscal') = 'object' THEN 'CASUAL_WITH_INVOICE' ELSE 'CASUAL_EXPENSE' END;
  END IF;
  RETURN wa.correct_0106(p_inbound_id, p_draft_id, p_expected_version, p_payload);
END $$;

-- ── 3. the explicit state of a purchase paid with Mercado Pago, and its later link ─
CREATE TABLE purchase_mp_link (
  purchase_root_id UUID PRIMARY KEY REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mp_account_id    UUID NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  origin           TEXT NOT NULL CHECK (origin IN ('ERP', 'WHATSAPP')),
  origin_ref       JSONB,
  idempotency_key  VARCHAR(100) NOT NULL UNIQUE,
  reason           TEXT,
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE purchase_mp_settlement (
  id                       BIGSERIAL PRIMARY KEY,
  purchase_root_id         UUID NOT NULL UNIQUE REFERENCES purchase_mp_link(purchase_root_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id              UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the version linked
  source_id                VARCHAR(30) NOT NULL UNIQUE CHECK (source_id ~ '^[0-9]{1,20}$'),
  mp_financial_movement_id BIGINT NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id   BIGINT NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  economic_date            DATE NOT NULL,   -- the purchase / invoice date (P&L, IVA)
  movement_date            DATE NOT NULL,   -- the real Mercado Pago movement date (money)
  amount                   NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  idempotency_key          VARCHAR(100) NOT NULL UNIQUE,
  reason                   TEXT,
  result                   JSONB NOT NULL,
  created_by               UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_purchase_mp_link_immutable BEFORE UPDATE OR DELETE ON purchase_mp_link FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_purchase_mp_settlement_immutable BEFORE UPDATE OR DELETE ON purchase_mp_settlement FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE purchase_mp_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_mp_settlement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purchase_mp_link, purchase_mp_settlement FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE purchase_mp_settlement_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE purchase_mp_link, purchase_mp_settlement TO authenticated;
CREATE POLICY purchase_mp_link_admin_select ON purchase_mp_link FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY purchase_mp_settlement_admin_select ON purchase_mp_settlement FOR SELECT USING (current_app_role() = 'ADMIN');

-- ADR-019 §2 (amended): a casual purchase without its payment operation is a pending expense XOR a purchase paid by Mercado Pago
-- awaiting its movement — never both (0107: SECURITY DEFINER, commit-time, independent of the caller)
CREATE OR REPLACE FUNCTION purchase_casual_settlement_check() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_root UUID; v_payable BOOLEAN; v_mp BOOLEAN;
BEGIN
  IF NEW.supplier_id IS NULL AND NEW.paid_operation_id IS NULL THEN
    v_root := purchase_chain_root(NEW.id);
    v_payable := EXISTS (SELECT 1 FROM expense_payable e WHERE e.purchase_root_id = v_root);
    v_mp := EXISTS (SELECT 1 FROM purchase_mp_link l WHERE l.purchase_root_id = v_root);
    IF NOT v_payable AND NOT v_mp THEN
      RAISE EXCEPTION 'CASUAL_PURCHASE_UNSETTLED: a purchase without a registered supplier is paid, a pending expense or paid by Mercado Pago awaiting its movement';
    END IF;
    IF v_payable AND v_mp THEN
      RAISE EXCEPTION 'CASUAL_PURCHASE_AMBIGUOUS: a purchase is either a pending expense or paid by Mercado Pago, never both';
    END IF;
  END IF;
  RETURN NULL;
END $$;

-- ADR-021 §2.3(c): the route that settles an already recognised purchase
ALTER TABLE mp_pending_outflow_resolution DROP CONSTRAINT chk_mpor_route;
ALTER TABLE mp_pending_outflow_resolution ADD CONSTRAINT chk_mpor_route
  CHECK (route IN ('CASUAL_PURCHASE', 'EXPENSE', 'SUPPLIER_PAYMENT', 'OWNER_WITHDRAWAL', 'OWN_TRANSFER', 'PURCHASE_MP_LINK'));

-- the purchase now (P&L + IVA once), the Mercado Pago movement later — no financial operation, no posting, no debt
CREATE FUNCTION register_casual_purchase_mp_pending(
  p_economic_date       DATE,
  p_amount_net          NUMERIC,
  p_amount_total        NUMERIC,
  p_expense_category_id UUID,
  p_concept             VARCHAR,
  p_nature              purchase_nature,
  p_idempotency_key     VARCHAR,
  p_mp_account_id       UUID,
  p_counterparty_name   VARCHAR DEFAULT NULL,
  p_lines               JSONB DEFAULT '[]'::jsonb,
  p_attachments         JSONB DEFAULT '[]'::jsonb,
  p_fiscal              JSONB DEFAULT NULL,
  p_origin              TEXT DEFAULT 'ERP',
  p_origin_ref          JSONB DEFAULT NULL,
  p_reason              TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid(); v_concept VARCHAR := nullif(btrim(p_concept), ''); v_name VARCHAR := nullif(btrim(p_counterparty_name), '');
  v_existing purchases%ROWTYPE; v_purchase UUID := gen_random_uuid(); v_fiscal UUID; v_res JSONB; v_line JSONB; v_att JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  IF left(p_idempotency_key, 8) = 'RECTIFY:' THEN RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefix RECTIFY: is reserved'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_pending_purchase:' || p_idempotency_key, 0));
  SELECT * INTO v_existing FROM purchases WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM purchase_mp_link WHERE purchase_root_id = v_existing.id) THEN RAISE EXCEPTION 'DUPLICATE_PURCHASE'; END IF;
    RETURN jsonb_build_object('purchase_id', v_existing.id, 'replayed', true, 'amount', v_existing.amount_total, 'fiscal_document_id', v_existing.fiscal_document_id,
                              'mp_link_pending', true, 'financial_effect', 'NONE', 'status', 'PENDIENTE_VINCULACION_MP');
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_net IS NULL OR p_amount_net < 0 OR p_amount_net > p_amount_total THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
  END IF;
  IF v_concept IS NULL OR length(v_concept) > 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_nature IS NULL THEN RAISE EXCEPTION 'NATURE_REQUIRED'; END IF;
  IF v_name IS NOT NULL AND length(v_name) > 120 THEN RAISE EXCEPTION 'INVALID_COUNTERPARTY_NAME: at most 120 characters'; END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('ERP', 'WHATSAPP') THEN RAISE EXCEPTION 'INVALID_ORIGIN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_mp_account_id AND activo AND nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE') THEN
    RAISE EXCEPTION 'MP_ACCOUNT_REQUIRED: the paying account must be the active Mercado Pago account';
  END IF;
  IF p_attachments IS NOT NULL AND jsonb_typeof(p_attachments) <> 'array' THEN RAISE EXCEPTION 'INVALID_ATTACHMENTS: attachments must be an array'; END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'INVALID_LINES: lines must be an array'; END IF;
  PERFORM assert_period_open(p_economic_date);
  -- the received invoice (issuer form, as a casual purchase): its IVA is recorded once, here
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
  -- the expense (P&L, by its economic date and category); no supplier, no payment operation yet
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
  -- the explicit state: paid with Mercado Pago, movement to link
  INSERT INTO purchase_mp_link (purchase_root_id, mp_account_id, origin, origin_ref, idempotency_key, reason, created_by)
  VALUES (v_purchase, p_mp_account_id, p_origin, p_origin_ref, p_idempotency_key, p_reason, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_purchase::TEXT, 'CREATE_MP_PENDING_PURCHASE',
          jsonb_build_object('amount_total', p_amount_total, 'economic_date', p_economic_date, 'fiscal_document_id', v_fiscal, 'origin', p_origin,
                             'origin_ref', p_origin_ref, 'status', 'PENDIENTE_VINCULACION_MP'), coalesce(p_reason, v_concept), v_uid);
  RETURN jsonb_build_object('purchase_id', v_purchase, 'replayed', false, 'amount', p_amount_total, 'fiscal_document_id', v_fiscal,
                            'mp_link_pending', true, 'financial_effect', 'NONE', 'status', 'PENDIENTE_VINCULACION_MP');
END $$;

-- ADR-021 §2.3(c): link the real outflow to the EXISTING purchase — only the payment side, once
CREATE FUNCTION settle_purchase_mp(p_purchase_id UUID, p_source_id TEXT, p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid(); v_root UUID; v_link purchase_mp_link; v_set purchase_mp_settlement; v_cur purchases; v_out RECORD; v_cls mp_outflow_classification;
  v_op BIGINT; v_res JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  IF coalesce(p_source_id, '') !~ '^[0-9]{1,20}$' THEN RAISE EXCEPTION 'INVALID_SOURCE_ID: a Mercado Pago operation number is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  v_root := purchase_chain_root(p_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('purchase_mp:' || v_root, 0));
  SELECT * INTO v_link FROM purchase_mp_link WHERE purchase_root_id = v_root;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_MP_PENDING_PURCHASE: the purchase is not waiting for a Mercado Pago movement'; END IF;
  -- replay / conflicts
  SELECT * INTO v_set FROM purchase_mp_settlement WHERE purchase_root_id = v_root;
  IF FOUND THEN
    IF v_set.source_id = p_source_id THEN RETURN v_set.result || jsonb_build_object('replayed', true); END IF;
    RAISE EXCEPTION 'PURCHASE_MP_ALREADY_LINKED: the purchase is linked to operation %', v_set.source_id;
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_mp_settlement WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: the key was used for another link';
  END IF;
  SELECT * INTO v_cur FROM purchases WHERE is_current AND purchase_chain_root(id) = v_root FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF v_cur.supplier_id IS NOT NULL OR v_cur.paid_operation_id IS NOT NULL THEN RAISE EXCEPTION 'NOT_MP_PENDING_PURCHASE: the purchase is not an unpaid casual purchase'; END IF;
  -- the real outflow (ADR-020 / ADR-021 checks of register_casual_purchase): never re-pointed, never applied twice
  SELECT * INTO v_out FROM mp_outflow_resolve(p_source_id);
  SELECT * INTO v_cls FROM mp_outflow_classification WHERE source_id = p_source_id;
  IF FOUND THEN
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: operation % is already classified as % %', p_source_id, v_cls.classification,
      CASE WHEN v_cls.purchase_id IS NOT NULL THEN ' (purchase ' || v_cls.purchase_id || ')' ELSE '' END;
  END IF;
  IF v_out.applied THEN RAISE EXCEPTION 'PAYOUT_ALREADY_APPLIED: the movement already has a financial operation'; END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status = 'OWN_ACCOUNT_EXACT' THEN
    RAISE EXCEPTION 'OWN_ACCOUNT_PAYOUT: payout % goes to an own account — confirm it as a transfer', p_source_id;
  END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status <> 'NO_OWN_ACCOUNT_MATCH' THEN
    RAISE EXCEPTION 'DESTINATION_REVIEW_REQUIRED: payout % is %', p_source_id, v_out.match_status;
  END IF;
  IF v_out.mp_account_id IS DISTINCT FROM v_link.mp_account_id THEN RAISE EXCEPTION 'MP_ACCOUNT_MISMATCH: the movement belongs to another account'; END IF;
  -- exact amount: the purchase total = the outflow's comparable gross (fees / taxes are separate charges, ADR-020)
  IF v_cur.amount_total <> -v_out.gross_amount THEN
    RAISE EXCEPTION 'MP_AMOUNT_MISMATCH: the outflow''s gross is % and the purchase total %', -v_out.gross_amount, v_cur.amount_total;
  END IF;
  -- only the movement's period matters: the purchase (and its period) is not rewritten
  PERFORM assert_period_open(v_out.occurred_date);
  PERFORM mp_pending_outflow_release(v_out.movement_id, v_uid, 'PURCHASE_MP_LINK');
  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('PURCHASE_PAYMENT', v_out.occurred_date, 'MP-OUTFLOW:' || p_source_id, 'purchases', v_cur.id::TEXT,
            coalesce(nullif(btrim(p_reason), ''), 'Pago Mercado Pago de ' || v_cur.subcategory), v_uid)
    RETURNING id INTO v_op;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_out.mp_account_id, -v_cur.amount_total, v_out.occurred_date, v_uid);
  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_out.movement_id, v_op, v_out.mp_account_id, v_out.gross_amount, 'MP-OUTFLOW:' || p_source_id, NOW(), v_uid);
  PERFORM mp_outflow_apply_charges(v_out.movement_id, p_source_id, v_out.mp_account_id, v_out.fee_amount, v_out.tax_amount, v_out.occurred_date, v_uid, v_out.kind);
  INSERT INTO mp_outflow_classification (source_id, mp_financial_movement_id, classification, expense_category_id, nature, concept, counterparty_name,
         purchase_id, financial_operation_id, destination_run_id, destination_row_number, amount, reason, created_by)
  VALUES (p_source_id, v_out.movement_id, 'CASUAL_PURCHASE', v_cur.expense_category_id, v_cur.nature, v_cur.subcategory, v_cur.counterparty_name,
          v_cur.id, v_op, v_out.destination_run_id, v_out.destination_row_number, v_cur.amount_total, p_reason, v_uid);
  v_res := jsonb_build_object('replayed', false, 'purchase_id', v_cur.id, 'purchase_root_id', v_root, 'source_id', p_source_id,
                              'financial_operation_id', v_op, 'economic_date', v_cur.economic_date, 'movement_date', v_out.occurred_date,
                              'amount', v_cur.amount_total, 'fee', v_out.fee_amount, 'tax', v_out.tax_amount, 'status', 'VINCULADO',
                              'financial_effect', 'EXISTING_MP_OUTFLOW');
  INSERT INTO purchase_mp_settlement (purchase_root_id, purchase_id, source_id, mp_financial_movement_id, financial_operation_id, economic_date,
         movement_date, amount, idempotency_key, reason, result, created_by)
  VALUES (v_root, v_cur.id, p_source_id, v_out.movement_id, v_op, v_cur.economic_date, v_out.occurred_date, v_cur.amount_total, p_idempotency_key,
          nullif(btrim(coalesce(p_reason, '')), ''), v_res, v_uid);
  -- the receipt(s) of the purchase also point to the movement
  INSERT INTO document_link (document_file_id, target_kind, target_id, linked_by)
  SELECT l.document_file_id, 'MP_PENDING_OUTFLOW', p_source_id, v_uid FROM document_link l
   WHERE l.target_kind = 'PURCHASE' AND l.target_id IN (SELECT p.id::text FROM purchases p WHERE purchase_chain_root(p.id) = v_root)
  ON CONFLICT DO NOTHING;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_cur.id::TEXT, 'SETTLE_MP', v_res, coalesce(p_reason, 'Vinculación Mercado Pago'), v_uid);
  RETURN v_res;
END $$;

-- pending / linked, both dates, age, the pending outflows of the same amount (listed only; the user picks)
CREATE VIEW fin_purchase_mp_link WITH (security_invoker = true) AS
  SELECT l.purchase_root_id, cur.id AS purchase_id, cur.economic_date, cur.amount_total, cur.subcategory AS concept, cur.counterparty_name,
         ec.nombre AS category_name, cur.fiscal_document_id, l.origin, l.origin_ref ->> 'short_code' AS origin_code, l.created_at,
         CASE WHEN s.id IS NULL THEN 'PENDIENTE_VINCULACION_MP' ELSE 'VINCULADO' END AS status,
         s.source_id, s.movement_date, s.financial_operation_id, s.created_at AS linked_at,
         (CURRENT_DATE - cur.economic_date) AS age_days,
         CASE WHEN s.id IS NULL THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object('source_id', v.source_id, 'date', v.business_date, 'amount', v.economic_amount)
                                      ORDER BY abs(v.business_date - cur.economic_date), v.source_id), '[]'::jsonb)
              FROM fin_mp_pending_classification v
             WHERE v.direction = 'OUT' AND v.status = 'PENDING' AND v.economic_amount = cur.amount_total)
         END AS candidates
    FROM purchase_mp_link l
    JOIN purchases cur ON cur.is_current AND purchase_chain_root(cur.id) = l.purchase_root_id
    LEFT JOIN expense_category ec ON ec.id = cur.expense_category_id
    LEFT JOIN purchase_mp_settlement s ON s.purchase_root_id = l.purchase_root_id;
ALTER VIEW fin_purchase_mp_link OWNER TO postgres;
REVOKE ALL ON fin_purchase_mp_link FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_purchase_mp_link TO authenticated;

-- a linked outflow shows its (existing) purchase: the 0093 body, the casual purchase found by its payment OR by the link
CREATE OR REPLACE VIEW fin_mp_report_activity
WITH (security_invoker = false)
AS
WITH a AS (
  SELECT l.run_id, l.row_number, l.raw_row, l.outcome, l.review_code, l.mp_source_record_id, l.appearance_meta ->> 'row_class' AS row_class,
         r.financial_account_id, r.coverage_from, r.coverage_to
    FROM fin_import_run_line l
    JOIN fin_import_run r ON r.id = l.run_id
   WHERE r.source_kind = 'MP_RELEASE_REPORT' AND r.mode = 'NORMAL' AND r.status = 'PARSED'
), s AS (
  SELECT a.*, src.processing_status, src.processing_note, src.occurred_at, src.occurred_date, src.external_id,
         (SELECT t.id FROM mp_transition_identity t
           WHERE t.resource_type = 'payment' AND t.resource_id = a.raw_row ->> 'SOURCE_ID' AND t.transition = 'APPROVAL'
             AND t.transition_ref = '' AND (a.raw_row ->> 'DESCRIPTION') = 'payment') AS approval_id,
         (SELECT d.status::TEXT FROM mp_webhook_delivery d WHERE d.report_source_id = a.mp_source_record_id
           ORDER BY d.received_at DESC LIMIT 1) AS backfill_status
    FROM a LEFT JOIN mp_source_record src ON src.id = a.mp_source_record_id
), x AS (
  SELECT s.*, coalesce(ir.source_account_id, pc.destination_account_id) AS own_account_id,
         (SELECT NOT EXISTS (SELECT 1 FROM mp_reconciliation rc WHERE rc.mp_financial_movement_id = t.mp_financial_movement_id)
                 AND ps.event_data ->> 'operation_type' = 'account_fund' AND ps.event_data ->> 'payment_method_id' = 'debin_transfer'
            FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
            JOIN mp_source_record ps ON ps.id = m.mp_source_record_id
           WHERE t.id = s.approval_id) AS classify_inflow,
         oc.classification AS outflow_classification,
         EXISTS (SELECT 1 FROM mp_pending_outflow po
                  WHERE po.source_id = s.raw_row ->> 'SOURCE_ID'
                    AND po.kind = CASE s.raw_row ->> 'DESCRIPTION' WHEN 'payout' THEN 'PAYOUT' ELSE 'OUTBOUND' END
                    AND (s.raw_row ->> 'DESCRIPTION' = 'payout' OR (s.raw_row ->> 'DESCRIPTION' = 'payment' AND s.external_id LIKE '%:D'))
                    AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution pr WHERE pr.pending_id = po.id)) AS pending_open,   -- [0093]
         CASE oc.classification
           WHEN 'EXPENSE' THEN oc.concept || ' · ' || ec.nombre || ' · ' || sp.nombre
           WHEN 'SUPPLIER_PAYMENT' THEN sp.nombre
           WHEN 'CASUAL_PURCHASE' THEN cp.subcategory || ' · ' || cpc.nombre || coalesce(' · ' || cp.counterparty_name, '')
         END::TEXT AS outflow_detail
    FROM s LEFT JOIN mp_inbound_reclassification ir ON ir.payment_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payment'
           LEFT JOIN mp_payout_transfer_confirmation pc ON pc.source_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payout'
           LEFT JOIN mp_outflow_classification oc ON oc.source_id = s.raw_row ->> 'SOURCE_ID'
                 AND (s.raw_row ->> 'DESCRIPTION' = 'payout' OR (s.raw_row ->> 'DESCRIPTION' = 'payment' AND s.external_id LIKE '%:D'))
           LEFT JOIN suppliers sp ON sp.id = oc.supplier_id
           LEFT JOIN expense_category ec ON ec.id = oc.expense_category_id
           -- [0111] a purchase settled later (ADR-021 §2.3(c)) has no paid_operation_id: found through its link
           LEFT JOIN purchase_mp_settlement pms ON pms.financial_operation_id = oc.financial_operation_id
           -- the CURRENT version of a casual purchase (its classification may have been rectified, ADR-019 §7)
           LEFT JOIN purchases cp ON oc.classification = 'CASUAL_PURCHASE' AND cp.is_current
                 AND (cp.paid_operation_id = oc.financial_operation_id OR (pms.purchase_root_id IS NOT NULL AND purchase_chain_root(cp.id) = pms.purchase_root_id))
           LEFT JOIN expense_category cpc ON cpc.id = cp.expense_category_id
)
SELECT x.run_id, x.row_number, x.financial_account_id,
       x.occurred_at,
       coalesce(x.occurred_date, x.coverage_from) AS business_date,
       nullif(x.raw_row ->> 'DESCRIPTION', '') AS description,
       nullif(x.raw_row ->> 'SOURCE_ID', '') AS source_id,
       CASE WHEN x.row_class = 'MOVEMENT'
            THEN (x.raw_row ->> 'NET_CREDIT_AMOUNT')::NUMERIC(15,2) - (x.raw_row ->> 'NET_DEBIT_AMOUNT')::NUMERIC(15,2) END AS net_amount,
       CASE WHEN x.row_class = 'MOVEMENT' THEN (x.raw_row ->> 'GROSS_AMOUNT')::NUMERIC(15,2) END AS gross_amount,
       nullif(x.raw_row ->> 'PAYMENT_METHOD', '') AS payment_method,
       nullif(x.raw_row ->> 'PAYMENT_METHOD_TYPE', '') AS payment_method_type,
       x.outcome AS appearance_outcome, x.review_code, x.mp_source_record_id, x.processing_status::TEXT AS processing_status,
       x.backfill_status,
       CASE
         WHEN x.row_class = 'CONTROL' THEN 'CONTROL'
         WHEN x.processing_status = 'IGNORED' AND x.processing_note LIKE 'PRE\_CUTOVER%' THEN 'PRE_CUTOVER'
         WHEN x.processing_status = 'ERROR' THEN 'EXCEPTION'
         WHEN x.raw_row ->> 'DESCRIPTION' IN ('reserve_for_payment', 'reserve_for_payout') THEN 'RESERVE'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'asset_management' THEN 'YIELD'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' AND x.own_account_id IS NOT NULL THEN 'OWN_TRANSFER'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' AND x.outflow_classification IS NOT NULL THEN 'CLASSIFIED_OUTFLOW'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' AND x.pending_open THEN 'PENDING_CLASSIFICATION'   -- [0093]
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' THEN 'PAYOUT'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D' AND x.outflow_classification IS NOT NULL THEN 'CLASSIFIED_OUTFLOW'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D' AND x.pending_open THEN 'PENDING_CLASSIFICATION'   -- [0093]
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D' THEN 'OUTBOUND'
         WHEN x.own_account_id IS NOT NULL THEN 'OWN_TRANSFER'
         WHEN x.classify_inflow THEN 'CLASSIFY_INFLOW'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.approval_id IS NOT NULL
              THEN CASE WHEN x.backfill_status = 'FETCHED' THEN 'BACKFILL_PROCESSED' ELSE 'COVERED' END
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.backfill_status IN ('RECEIVED', 'PROCESSING', 'FAILED_RETRYABLE', 'CONFIG_BLOCKED')
              THEN 'BACKFILL_PENDING'
         ELSE 'EXCEPTION'
       END AS coverage_status,
       (SELECT min(rc.financial_operation_id) FROM mp_transition_identity t
          JOIN mp_reconciliation rc ON rc.mp_financial_movement_id = t.mp_financial_movement_id
         WHERE t.id = x.approval_id
            OR ((x.raw_row ->> 'DESCRIPTION' IN ('asset_management', 'payout') OR (x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D'))
                AND t.resource_type = 'report'
                AND t.resource_id = x.external_id)) AS financial_operation_id,
       (SELECT fa.nombre::TEXT FROM financial_account fa WHERE fa.id = x.own_account_id) AS counterpart_account_name,
       x.outflow_classification::TEXT AS classification,
       x.outflow_detail AS classification_detail
  FROM x
 WHERE (SELECT current_app_role()) = 'ADMIN';

-- monthly close: a WARNING (never a block) + an audit row while the period holds purchases waiting for their Mercado Pago movement;
-- the ADR-021 blocks (PENDING_CLASSIFICATION / MP_UNPOSTED_OUTFLOWS) are unchanged
CREATE FUNCTION management_period_mp_link_warning() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n INTEGER; v_total NUMERIC;
BEGIN
  IF OLD.status = 'OPEN' AND NEW.status IS DISTINCT FROM 'OPEN' THEN
    SELECT count(*), coalesce(sum(cur.amount_total), 0) INTO v_n, v_total
      FROM purchase_mp_link l JOIN purchases cur ON cur.is_current AND purchase_chain_root(cur.id) = l.purchase_root_id
     WHERE NOT EXISTS (SELECT 1 FROM purchase_mp_settlement s WHERE s.purchase_root_id = l.purchase_root_id)
       AND cur.economic_date BETWEEN NEW.periodo_fecha AND (NEW.periodo_fecha + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    IF v_n > 0 THEN
      RAISE WARNING 'MP_LINK_PENDING: % gasto(s) pagados con Mercado Pago del período % siguen sin su movimiento vinculado ($ %). El cierre no se bloquea por esto.',
        v_n, to_char(NEW.periodo_fecha, 'YYYY-MM'), v_total;
      INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
      VALUES ('management_period', NEW.periodo_fecha::TEXT, 'CLOSE_WITH_MP_LINK_PENDING', jsonb_build_object('count', v_n, 'amount', v_total),
              'Cierre con gastos pagados con Mercado Pago pendientes de vincular', auth.uid());
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_management_period_mp_link_warning BEFORE UPDATE ON management_period FOR EACH ROW EXECUTE FUNCTION management_period_mp_link_warning();

-- ── 4. WhatsApp: Mercado Pago without its outflow → the purchase now, the money later ─
ALTER FUNCTION wa.dispatch(wa.draft, TEXT) RENAME TO dispatch_0106;
CREATE FUNCTION wa.dispatch(d wa.draft, p_key TEXT) RETURNS JSONB LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p JSONB := d.payload; f JSONB := d.payload -> 'fiscal';
BEGIN
  IF d.type IN ('CASUAL_EXPENSE', 'CASUAL_WITH_INVOICE') AND p ->> 'method' = 'MERCADOPAGO' AND p ->> 'mp_source_id' IS NULL THEN
    RETURN register_casual_purchase_mp_pending(
      p_economic_date := (p ->> 'date')::date, p_amount_net := coalesce((p ->> 'net')::numeric, (p ->> 'total')::numeric),
      p_amount_total := (p ->> 'total')::numeric, p_expense_category_id := (p ->> 'category_id')::uuid, p_concept := p ->> 'concept',
      p_nature := (p ->> 'nature')::purchase_nature, p_idempotency_key := p_key, p_mp_account_id := (p ->> 'account_id')::uuid,
      p_counterparty_name := p ->> 'counterparty', p_lines := coalesce(p -> 'lines', '[]'::jsonb), p_attachments := coalesce(p -> 'attachments', '[]'::jsonb),
      p_fiscal := CASE WHEN d.type = 'CASUAL_WITH_INVOICE' THEN f END, p_origin := 'WHATSAPP',
      p_origin_ref := jsonb_build_object('draft_id', d.id, 'short_code', d.short_code, 'version', d.version),
      p_reason := 'WhatsApp ' || d.short_code || ' v' || d.version);
  END IF;
  RETURN wa.dispatch_0106(d, p_key);
END $$;

ALTER FUNCTION public.wa_confirm(BIGINT, UUID, INTEGER) SET SCHEMA wa;
ALTER FUNCTION wa.wa_confirm(BIGINT, UUID, INTEGER) RENAME TO confirm_0106;
REVOKE ALL ON FUNCTION wa.confirm_0106(BIGINT, UUID, INTEGER) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.wa_confirm(p_inbound_id BIGINT, p_draft_id UUID, p_expected_version INTEGER) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r JSONB;
BEGIN
  PERFORM wa.gate();
  IF EXISTS (SELECT 1 FROM wa.draft d WHERE d.id = p_draft_id AND d.state = 'DRAFT' AND d.payload ? 'vat_receiver_pending') THEN
    RAISE EXCEPTION 'WA_RECEIVER_REQUIRED: say whether the invoice is addressed to Santo Tomás first';
  END IF;
  IF EXISTS (SELECT 1 FROM wa.draft d WHERE d.id = p_draft_id AND d.state = 'DRAFT' AND d.payload ? 'issuer_cuit_pending') THEN
    RAISE EXCEPTION 'WA_ISSUER_CUIT_REQUIRED: write the issuer CUIT or say "sin factura" first';
  END IF;
  r := wa.confirm_0106(p_inbound_id, p_draft_id, p_expected_version);
  IF coalesce((r ->> 'ok')::boolean, false) AND r ->> 'state' = 'CONFIRMED' AND coalesce((r -> 'result' ->> 'mp_link_pending')::boolean, false)
     AND NOT coalesce((r ->> 'replay')::boolean, false) THEN
    PERFORM wa.audit('CONFIRM', 'MP_LINK_PENDING', (SELECT owner_perfil_id FROM wa.draft WHERE id = p_draft_id), p_inbound_id, p_draft_id, p_expected_version,
                     jsonb_build_object('purchase_id', r -> 'result' ->> 'purchase_id', 'financial_effect', 'NONE'));
  END IF;
  RETURN r || CASE WHEN coalesce((r -> 'result' ->> 'mp_link_pending')::boolean, false) THEN jsonb_build_object('mp_link_pending', true) ELSE '{}'::jsonb END;
END $$;

-- ── privileges ─────────────────────────────────────────────────────────────────
DO $p$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT unnest(ARRAY['public.wa_correct(bigint,uuid,integer,jsonb)', 'public.wa_confirm(bigint,uuid,integer)',
      'public.register_casual_purchase_mp_pending(date,numeric,numeric,uuid,varchar,purchase_nature,varchar,uuid,varchar,jsonb,jsonb,jsonb,text,jsonb,text)',
      'public.settle_purchase_mp(uuid,text,varchar,text)']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
  FOR f IN SELECT unnest(ARRAY['wa.validate_payload(text,jsonb)', 'wa.validate_payload_0106(text,jsonb)', 'wa.dispatch(wa.draft,text)',
                               'wa.dispatch_0106(wa.draft,text)', 'public.management_period_mp_link_warning()',
                               'public.purchase_casual_settlement_check()']::regprocedure[]) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $p$;
