-- ============================================================================
-- TARGET V1 — 0117 GASTOS: NUEVO GASTO PAGADO A UN PROVEEDOR Y RECTIFICACIÓN AUDITADA DE SUS DATOS (owner GO 2026-11-05)
--
-- No existing row, balance, posting, allocation or fiscal document changes. Nothing is backfilled.
--   1. register_paid_supplier_purchase (ADMIN): "Nuevo gasto" with a supplier, already paid in cash or by transfer — the purchase
--      (register_purchase / register_purchase_with_fiscal_document: P&L, supplier debt, optional invoice + IVA), the payment
--      (pay_supplier: ONE real movement on the account, on the real payment date) and its allocation to that invoice
--      (allocate_purchase_payment), in ONE transaction. Mercado Pago is refused: its outflow is classified from its movement
--      (0091: every Mercado Pago posting needs its movement), so a second movement is never created. Replays by key return the
--      recorded result.
--   2. rectify_purchase_details (ADMIN): a new version of ONE current purchase with a corrected concept, category, nature,
--      economic date, supplier, invoice number and / or amount, or with its received invoice added when it had none — the
--      0022 / 0088 version mechanism (the old version retired, lines, attachments and freight carried, the payment link kept,
--      the supplier ledger reversed and booked again at the new values). Refused when it would break a linked record:
--        · paid expense without supplier (cash / transfer / bank charge): its date and amount are its money movement's;
--        · pending expense without supplier: its amount is the obligation's (immutable; link it to a supplier first);
--          its supplier is set with assign_payable_to_supplier (0110);
--        · Mercado Pago purchase already linked to its movement: its amount is the movement's;
--        · supplier purchase with payments or cheques allocated: no supplier change, no amount below what is allocated;
--        · purchase with a fiscal document: no supplier, amount or invoice-number change (the credit is a fiscal record) and no
--          second document.
--      One audit_events row per rectification: action RECTIFY_DETAILS, every field before and after, the reason and the user.
--   3. fin_purchase_audit (ADMIN, security_invoker): every audit row of a purchase chain (creation, rectifications,
--      reclassifications), keyed by the chain root — the history of ONE expense across its versions.
--   4. trg_purchases_allocation_cover: a current purchase version is never below what is already allocated to it
--      (guards rectify_purchase too, which predates the allocations of 0104).
-- SECURITY DEFINER set +2 (register_paid_supplier_purchase, rectify_purchase_details); +1 trigger function (owner-only).
-- ============================================================================

-- ── 1. supplier expense recorded already paid ────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION register_paid_supplier_purchase(
  p_supplier_id         UUID,
  p_economic_date       DATE,
  p_amount_total        NUMERIC,
  p_expense_category_id UUID,
  p_concept             VARCHAR,
  p_nature              purchase_nature,
  p_idempotency_key     VARCHAR,
  p_payment_date        DATE,
  p_payment_method      payment_method,
  p_account_id          UUID,
  p_invoice_number      VARCHAR DEFAULT NULL,
  p_attachments         JSONB DEFAULT '[]'::jsonb,
  p_fiscal              JSONB DEFAULT NULL,
  p_reason              TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_concept  VARCHAR := nullif(btrim(p_concept), '');
  v_invoice  VARCHAR := nullif(btrim(p_invoice_number), '');
  v_existing purchases%ROWTYPE;
  v_acc      financial_account%ROWTYPE;
  v_net      NUMERIC;
  v_res      JSONB;
  v_purchase UUID;
  v_op       BIGINT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 90 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 90 characters required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('paid_supplier_purchase:' || p_idempotency_key, 0));

  SELECT * INTO v_existing FROM purchases WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    SELECT financial_operation_id INTO v_op FROM purchase_payment_allocation WHERE idempotency_key = p_idempotency_key || ':ALLOC';
    IF v_op IS NULL THEN RAISE EXCEPTION 'DUPLICATE_PURCHASE'; END IF;
    RETURN jsonb_build_object('replayed', true, 'purchase_id', v_existing.id, 'financial_operation_id', v_op,
                              'fiscal_document_id', v_existing.fiscal_document_id);
  END IF;

  IF v_concept IS NULL OR length(v_concept) > 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_payment_date IS NULL THEN RAISE EXCEPTION 'PAYMENT_DATE_REQUIRED'; END IF;
  IF p_payment_method IS NULL OR p_payment_method::text NOT IN ('CASH', 'TRANSFER') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: cash or transfer (a Mercado Pago payment is classified from its movement; a cheque is issued from the invoice)';
  END IF;
  SELECT * INTO v_acc FROM financial_account WHERE id = p_account_id AND activo;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE'; END IF;
  IF (p_payment_method::text = 'CASH') <> (v_acc.account_type::text = 'CASH')
     OR (p_payment_method::text = 'TRANSFER' AND v_acc.account_type::text <> 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ACCOUNT: cash is paid from a cash account, a transfer from a bank account';
  END IF;
  IF p_fiscal IS NOT NULL AND jsonb_typeof(p_fiscal) <> 'object' THEN RAISE EXCEPTION 'INVALID_FISCAL_DOCUMENT'; END IF;

  v_net := CASE WHEN p_fiscal IS NULL THEN p_amount_total ELSE (p_fiscal ->> 'net_amount')::NUMERIC END;
  IF p_fiscal IS NULL THEN
    v_res := register_purchase(p_supplier_id, p_economic_date, v_net, p_amount_total, p_expense_category_id, v_concept, p_nature,
               '[]'::jsonb, coalesce(p_attachments, '[]'::jsonb), p_idempotency_key, NULL, NULL, v_invoice, NULL, p_reason);
  ELSE
    v_res := register_purchase_with_fiscal_document(p_supplier_id, p_economic_date, v_net, p_amount_total, p_expense_category_id, p_nature,
               '[]'::jsonb, coalesce(p_attachments, '[]'::jsonb), p_idempotency_key, (p_fiscal ->> 'document_type')::fiscal_document_type,
               (p_fiscal ->> 'fiscal_period')::DATE, (p_fiscal ->> 'net_amount')::NUMERIC, (p_fiscal ->> 'total_amount')::NUMERIC,
               coalesce(p_fiscal -> 'components', '[]'::jsonb), v_concept, NULL, v_invoice, NULL, p_reason);
  END IF;
  v_purchase := (v_res ->> 'purchase_id')::UUID;

  v_op := (pay_supplier(p_supplier_id, p_amount_total, p_payment_date, p_payment_method, p_account_id,
                        ('GASTO-PAGADO:' || p_idempotency_key)::VARCHAR, p_reason) ->> 'financial_operation_id')::BIGINT;
  PERFORM allocate_purchase_payment(v_purchase, v_op, p_amount_total, (p_idempotency_key || ':ALLOC')::VARCHAR, p_reason);

  RETURN jsonb_build_object('replayed', false, 'purchase_id', v_purchase, 'financial_operation_id', v_op,
                            'fiscal_document_id', v_res -> 'fiscal_document_id');
END $$;
ALTER FUNCTION register_paid_supplier_purchase(UUID, DATE, NUMERIC, UUID, VARCHAR, purchase_nature, VARCHAR, DATE, payment_method, UUID, VARCHAR, JSONB, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION register_paid_supplier_purchase(UUID, DATE, NUMERIC, UUID, VARCHAR, purchase_nature, VARCHAR, DATE, payment_method, UUID, VARCHAR, JSONB, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION register_paid_supplier_purchase(UUID, DATE, NUMERIC, UUID, VARCHAR, purchase_nature, VARCHAR, DATE, payment_method, UUID, VARCHAR, JSONB, JSONB, TEXT) TO authenticated;

-- ── 2. audited rectification of an expense's data ─────────────────────────────────────────────────────────────────────────
CREATE FUNCTION rectify_purchase_details(
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
      IF EXISTS (SELECT 1 FROM expense_payable WHERE purchase_root_id = v_root) THEN
        RAISE EXCEPTION 'PENDING_EXPENSE_AMOUNT_LOCKED: the amount of a pending expense is its obligation''s; link it to a supplier to correct it';
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
ALTER FUNCTION rectify_purchase_details(UUID, VARCHAR, UUID, purchase_nature, DATE, UUID, VARCHAR, NUMERIC, NUMERIC, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION rectify_purchase_details(UUID, VARCHAR, UUID, purchase_nature, DATE, UUID, VARCHAR, NUMERIC, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION rectify_purchase_details(UUID, VARCHAR, UUID, purchase_nature, DATE, UUID, VARCHAR, NUMERIC, NUMERIC, TEXT, JSONB) TO authenticated;

-- ── 3. the history of one expense across its versions ─────────────────────────────────────────────────────────────────────
CREATE VIEW fin_purchase_audit WITH (security_invoker = true) AS
  SELECT a.id AS audit_id, purchase_chain_root(a.entity_id::uuid) AS purchase_root_id, a.entity_id AS purchase_id, a.action,
         a.before_values, a.after_values, a.reason, a.performed_by, a.performed_at
    FROM audit_events a
   WHERE a.entity_type = 'purchases' AND a.entity_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
REVOKE ALL ON fin_purchase_audit FROM PUBLIC, anon, service_role;
GRANT SELECT ON fin_purchase_audit TO authenticated;

-- ── 4. a current version is never below what is allocated to it ───────────────────────────────────────────────────────────
CREATE FUNCTION purchase_allocation_cover_check() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_allocated NUMERIC;
BEGIN
  IF NEW.is_current AND NEW.supplier_id IS NOT NULL THEN
    v_allocated := purchase_allocated_amount(purchase_chain_root(NEW.id));
    IF v_allocated > NEW.amount_total THEN
      RAISE EXCEPTION 'OVER_ALLOCATION: % is already allocated to this invoice, above its new total %', v_allocated, NEW.amount_total;
    END IF;
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION purchase_allocation_cover_check() OWNER TO postgres;
REVOKE ALL ON FUNCTION purchase_allocation_cover_check() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_purchases_allocation_cover AFTER INSERT ON purchases FOR EACH ROW EXECUTE FUNCTION purchase_allocation_cover_check();
