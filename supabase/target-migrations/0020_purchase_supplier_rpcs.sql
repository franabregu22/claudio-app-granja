-- ============================================================================
-- TARGET V1 — 0020 PURCHASES / SUPPLIERS / FREIGHT RPCs (Phase 17, Slice 2)
-- Authority: RPC_CONTRACTS_V1.md 13 register_purchase
--                                14 rectify_purchase
--                                15 pay_supplier
--                                16 register_freight
--                                17 assign_freight_to_purchase
--            DATABASE_INVARIANTS_V1.md 7, 22, 23, 24, 25
--
-- Every function: SECURITY DEFINER, search_path = public, owner postgres,
-- actor = auth.uid(), role = current_app_role(); period guard on the frozen
-- determinant before the first write; one transaction per call.
--
-- Technical completions (contract behaviour unchanged; each is tested):
--   * NULL amounts raise the contract's INVALID_AMOUNT (NULL <= 0 would pass).
--   * A NULL / non-array p_attachments is ATTACHMENT_REQUIRED; a NULL /
--     non-array p_new_lines is EMPTY_LINE_SET; NULL line quantity / price are
--     INVALID_QUANTITY / INVALID_PRICE.
--   * Concurrent duplicates can pass the EXISTS pre-checks and then hit a
--     UNIQUE index; that unique_violation is reported with the contract's own
--     code (DUPLICATE_PURCHASE / DUPLICATE_SUPPLIER_INVOICE / DUPLICATE_PAYMENT
--     / DUPLICATE_FREIGHT). The losing call rolls back entirely.
--   * assign_freight_to_purchase reads the purchase FOR SHARE, so it cannot
--     attach freight to a version that a concurrent rectify_purchase is
--     retiring: it waits for the rectification and then sees PURCHASE_SUPERSEDED.
-- ============================================================================

-- ── 13. register_purchase ──────────────────────────────────────────────────
-- Liability recognised at economic_date on the global supplier account.
-- Purchase + lines + >=1 attachment + ledger + audit in one transaction.
-- No financial posting: payment is a separate act (pay_supplier).

CREATE OR REPLACE FUNCTION register_purchase(
  p_supplier_id             UUID,
  p_economic_date           DATE,
  p_amount_net              NUMERIC,
  p_amount_total            NUMERIC,
  p_expense_category_id     UUID,
  p_subcategory             VARCHAR,
  p_nature                  purchase_nature,
  p_lines                   JSONB,
  p_attachments             JSONB,
  p_idempotency_key         VARCHAR,
  p_project_id              UUID DEFAULT NULL,
  p_fiscal_document_id      UUID DEFAULT NULL,
  p_supplier_invoice_number VARCHAR DEFAULT NULL,
  p_flock_id                UUID DEFAULT NULL,
  p_reason                  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_purchase_id UUID;
  v_ledger_id   BIGINT;
  v_line        JSONB;
  v_att         JSONB;
  v_line_count  INTEGER := 0;
  v_att_count   INTEGER := 0;
  v_constraint  TEXT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_nature IS NULL THEN
    RAISE EXCEPTION 'NATURE_REQUIRED';
  END IF;
  IF p_expense_category_id IS NULL THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED';
  END IF;
  IF p_attachments IS NULL OR jsonb_typeof(p_attachments) <> 'array'
     OR jsonb_array_length(p_attachments) = 0 THEN
    RAISE EXCEPTION 'ATTACHMENT_REQUIRED: a purchase cannot be recorded without at least one attachment';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM purchases WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_PURCHASE';
  END IF;
  -- invoice number is unique per supplier only, never globally
  IF p_supplier_invoice_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM purchases
                  WHERE supplier_id = p_supplier_id
                    AND supplier_invoice_number = p_supplier_invoice_number
                    AND is_current = true) THEN
    RAISE EXCEPTION 'DUPLICATE_SUPPLIER_INVOICE: % already recorded for this supplier', p_supplier_invoice_number;
  END IF;

  PERFORM assert_period_open(p_economic_date);

  BEGIN
    INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total,
           expense_category_id, subcategory, nature, project_id, fiscal_document_id,
           supplier_invoice_number, flock_id, is_current, version_seq, idempotency_key, created_by)
    VALUES (p_supplier_id, p_economic_date, p_amount_net, p_amount_total,
            p_expense_category_id, p_subcategory, p_nature, p_project_id, p_fiscal_document_id,
            p_supplier_invoice_number, p_flock_id, true, 0, p_idempotency_key, v_uid)
    RETURNING id INTO v_purchase_id;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'idx_purchases_supplier_invoice' THEN
      RAISE EXCEPTION 'DUPLICATE_SUPPLIER_INVOICE: % already recorded for this supplier', p_supplier_invoice_number;
    END IF;
    RAISE EXCEPTION 'DUPLICATE_PURCHASE';
  END;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion,
           cantidad, unit_type, precio_unitario)
    VALUES (v_purchase_id,
            (v_line->>'producto_id')::UUID,
            (v_line->>'feed_ingredient_id')::UUID,
            v_line->>'descripcion',
            (v_line->>'cantidad')::NUMERIC,
            (v_line->>'unit_type')::unit_type,
            (v_line->>'precio_unitario')::NUMERIC);
    v_line_count := v_line_count + 1;
  END LOOP;

  FOR v_att IN SELECT value FROM jsonb_array_elements(p_attachments) LOOP
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type,
           byte_size, uploaded_by)
    VALUES (v_purchase_id, v_att->>'storage_path', v_att->>'file_name', v_att->>'content_type',
            (v_att->>'byte_size')::BIGINT, v_uid);
    v_att_count := v_att_count + 1;
  END LOOP;

  -- liability recognised at economic_date, on the global supplier account
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'PURCHASE', p_amount_total, p_economic_date,
          'purchases', v_purchase_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_purchase_id::TEXT, 'CREATE',
          jsonb_build_object('amount_total', p_amount_total, 'nature', p_nature,
                             'economic_date', p_economic_date,
                             'attachments', jsonb_array_length(p_attachments)),
          p_reason, v_uid);

  RETURN jsonb_build_object('purchase_id', v_purchase_id, 'supplier_ledger_id', v_ledger_id,
                            'line_count', v_line_count, 'attachment_count', v_att_count);
END;
$$;

-- ── 14. rectify_purchase ───────────────────────────────────────────────────
-- Version-set rectification (same discipline as RPC 2). Validate everything,
-- capture the current version, RETIRE it, THEN insert the replacement; carry
-- attachments and freight allocations forward; REVERSAL -old then PURCHASE +new
-- at the ORIGINAL economic_date. N passes telescope to the latest amount.

CREATE OR REPLACE FUNCTION rectify_purchase(
  p_purchase_id      UUID,
  p_new_amount_net   NUMERIC,
  p_new_amount_total NUMERIC,
  p_new_lines        JSONB,
  p_reason           TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              UUID := auth.uid();
  v_old              purchases;
  v_line             JSONB;
  v_cantidad         NUMERIC;
  v_precio           NUMERIC;
  v_producto_id      UUID;
  v_ingredient_id    UUID;
  v_carried          INTEGER;
  v_supplier_id      UUID;
  v_economic_date    DATE;
  v_category_id      UUID;
  v_subcategory      VARCHAR(100);
  v_nature           purchase_nature;
  v_project_id       UUID;
  v_fiscal_doc_id    UUID;
  v_invoice_number   VARCHAR(100);
  v_flock_id         UUID;
  v_old_total        NUMERIC(15,2);
  v_old_version      INTEGER;
  v_old_key          VARCHAR(100);
  v_new_version      INTEGER;
  v_new_purchase_id  UUID;
BEGIN
  -- 1. authorize and lock the current version
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_old FROM purchases WHERE id = p_purchase_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  IF v_old.is_current = false THEN
    RAISE EXCEPTION 'PURCHASE_SUPERSEDED: rectify the current version instead';
  END IF;

  PERFORM assert_period_open(v_old.economic_date);

  -- 2. validate the replacement COMPLETELY before mutating anything
  IF p_new_amount_total IS NULL OR p_new_amount_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_new_amount_net IS NULL OR p_new_amount_net < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_new_lines IS NULL OR jsonb_typeof(p_new_lines) <> 'array'
     OR jsonb_array_length(p_new_lines) = 0 THEN
    RAISE EXCEPTION 'EMPTY_LINE_SET';
  END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_new_lines) LOOP
    v_cantidad      := (v_line->>'cantidad')::NUMERIC;
    v_precio        := (v_line->>'precio_unitario')::NUMERIC;
    v_producto_id   := (v_line->>'producto_id')::UUID;
    v_ingredient_id := (v_line->>'feed_ingredient_id')::UUID;
    IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF v_precio IS NULL OR v_precio < 0 THEN
      RAISE EXCEPTION 'INVALID_PRICE';
    END IF;
    IF v_producto_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM products WHERE id = v_producto_id) THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', v_producto_id;
    END IF;
    IF v_ingredient_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM feed_ingredient WHERE id = v_ingredient_id) THEN
      RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: %', v_ingredient_id;
    END IF;
  END LOOP;

  -- the replacement must inherit at least one attachment (invariant 23)
  SELECT count(*) INTO v_carried FROM purchase_attachment WHERE purchase_id = p_purchase_id;
  IF v_carried = 0 THEN
    RAISE EXCEPTION 'ATTACHMENT_REQUIRED: the current version has no attachment to carry forward';
  END IF;

  -- 3. capture everything needed from the current version BEFORE it is altered
  v_supplier_id    := v_old.supplier_id;
  v_economic_date  := v_old.economic_date;
  v_category_id    := v_old.expense_category_id;
  v_subcategory    := v_old.subcategory;
  v_nature         := v_old.nature;
  v_project_id     := v_old.project_id;
  v_fiscal_doc_id  := v_old.fiscal_document_id;
  v_invoice_number := v_old.supplier_invoice_number;
  v_flock_id       := v_old.flock_id;
  v_old_total      := v_old.amount_total;
  v_old_version    := v_old.version_seq;
  v_old_key        := v_old.idempotency_key;
  v_new_version    := v_old_version + 1;

  -- 4. RETIRE the current version FIRST (only is_current flips; business fields untouched).
  --    Mandatory: idx_purchases_supplier_invoice forbids two current rows with the same invoice.
  UPDATE purchases SET is_current = false WHERE id = p_purchase_id;

  -- 5. THEN insert the new current version, reusing the captured values
  INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total,
         expense_category_id, subcategory, nature, project_id, fiscal_document_id,
         supplier_invoice_number, flock_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (v_supplier_id, v_economic_date, p_new_amount_net, p_new_amount_total,
          v_category_id, v_subcategory, v_nature, v_project_id, v_fiscal_doc_id,
          v_invoice_number, v_flock_id, true, v_new_version,
          v_old_key || ':v' || v_new_version, v_uid)
  RETURNING id INTO v_new_purchase_id;

  -- 6. lines for the new version
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_new_lines) LOOP
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion,
           cantidad, unit_type, precio_unitario)
    VALUES (v_new_purchase_id,
            (v_line->>'producto_id')::UUID,
            (v_line->>'feed_ingredient_id')::UUID,
            v_line->>'descripcion',
            (v_line->>'cantidad')::NUMERIC,
            (v_line->>'unit_type')::unit_type,
            (v_line->>'precio_unitario')::NUMERIC);
  END LOOP;

  -- 7. carry the required attachments forward; the new version is never attachment-less
  INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
  SELECT v_new_purchase_id, storage_path, file_name, content_type, byte_size, v_uid
    FROM purchase_attachment WHERE purchase_id = p_purchase_id;

  -- 8. freight already allocated to the old version follows it (no new economic effect)
  UPDATE freight_allocation SET purchase_id = v_new_purchase_id WHERE purchase_id = p_purchase_id;

  -- 9. compensating supplier ledger entries, both at the ORIGINAL economic_date
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_supplier_id, 'REVERSAL', -v_old_total, v_economic_date,
          'purchases', p_purchase_id::TEXT, p_reason, v_uid);

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_supplier_id, 'PURCHASE', p_new_amount_total, v_economic_date,
          'purchases', v_new_purchase_id::TEXT, p_reason, v_uid);

  -- 10. audit
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', p_purchase_id::TEXT, 'RECTIFY',
          jsonb_build_object('amount_total', v_old_total, 'version', v_old_version),
          jsonb_build_object('amount_total', p_new_amount_total, 'version', v_new_version,
                             'new_id', v_new_purchase_id),
          p_reason, v_uid);

  RETURN jsonb_build_object('previous_purchase_id', p_purchase_id, 'new_purchase_id', v_new_purchase_id,
                            'version_seq', v_new_version, 'adjustment', p_new_amount_total - v_old_total);
END;
$$;

-- ── 15. pay_supplier ───────────────────────────────────────────────────────
-- Global supplier account payment, never allocated to invoices. Partial and
-- over-payments are legitimate (negative balance = supplier credit). Cheque
-- payments are issued instruments (RPC 10), never this RPC.

CREATE OR REPLACE FUNCTION pay_supplier(
  p_supplier_id          UUID,
  p_amount               NUMERIC,
  p_effective_date       DATE,
  p_payment_method       payment_method,
  p_financial_account_id UUID,
  p_external_ref         VARCHAR,
  p_reason               TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_operation_id BIGINT;
  v_ledger_id    BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_payment_method = 'CHEQUE' THEN
    RAISE EXCEPTION 'USE_ISSUE_SUPPLIER_INSTRUMENT: paying by cheque means issuing an instrument';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_financial_account_id AND activo = true) THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM financial_operation WHERE external_ref = p_external_ref) THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END IF;

  PERFORM assert_period_open(p_effective_date);

  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES ('SUPPLIER_PAYMENT', p_effective_date, p_external_ref,
            'suppliers', p_supplier_id::TEXT, p_reason, v_uid)
    RETURNING id INTO v_operation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;

  INSERT INTO financial_posting (financial_operation_id, financial_account_id,
         signed_amount, effective_date, created_by)
  VALUES (v_operation_id, p_financial_account_id, -p_amount, p_effective_date, v_uid);

  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_supplier_id, 'PAYMENT', -p_amount, p_effective_date,
          'payment', v_operation_id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('suppliers', p_supplier_id::TEXT, 'PAY',
          jsonb_build_object('amount', p_amount, 'effective_date', p_effective_date,
                             'method', p_payment_method),
          p_reason, v_uid);

  RETURN jsonb_build_object('financial_operation_id', v_operation_id, 'supplier_ledger_id', v_ledger_id);
END;
$$;

-- ── 16. register_freight ───────────────────────────────────────────────────
-- The ONLY place freight debt is recognised (+FREIGHT when a freight supplier
-- exists). No posting: payment goes through pay_supplier.

CREATE OR REPLACE FUNCTION register_freight(
  p_economic_date       DATE,
  p_amount              NUMERIC,
  p_expense_category_id UUID,
  p_idempotency_key     VARCHAR,
  p_supplier_id         UUID DEFAULT NULL,
  p_document_ref        VARCHAR DEFAULT NULL,
  p_fiscal_document_id  UUID DEFAULT NULL,
  p_reason              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_freight_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF EXISTS (SELECT 1 FROM freight WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_FREIGHT';
  END IF;

  PERFORM assert_period_open(p_economic_date);

  BEGIN
    INSERT INTO freight (supplier_id, economic_date, amount, document_ref, fiscal_document_id,
           expense_category_id, is_current, version_seq, idempotency_key, created_by)
    VALUES (p_supplier_id, p_economic_date, p_amount, p_document_ref, p_fiscal_document_id,
            p_expense_category_id, true, 0, p_idempotency_key, v_uid)
    RETURNING id INTO v_freight_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_FREIGHT';
  END;

  IF p_supplier_id IS NOT NULL THEN
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES (p_supplier_id, 'FREIGHT', p_amount, p_economic_date,
            'freight', v_freight_id::TEXT, p_reason, v_uid);
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('freight', v_freight_id::TEXT, 'CREATE',
          jsonb_build_object('amount', p_amount, 'economic_date', p_economic_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('freight_id', v_freight_id, 'economic_date', p_economic_date, 'amount', p_amount);
END;
$$;

-- ── 17. assign_freight_to_purchase ─────────────────────────────────────────
-- Cost attribution only: exactly one freight_allocation row; no ledger, no
-- posting, no fiscal component. The freight row is locked FOR UPDATE before
-- `already` is computed, so concurrent allocations cannot over-allocate.

CREATE OR REPLACE FUNCTION assign_freight_to_purchase(
  p_freight_id       UUID,
  p_purchase_id      UUID,
  p_allocated_amount NUMERIC,
  p_reason           TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_fr            freight;
  v_pu            purchases;
  v_already       NUMERIC(15,2);
  v_allocation_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_allocated_amount IS NULL OR p_allocated_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  SELECT * INTO v_fr FROM freight WHERE id = p_freight_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FREIGHT_NOT_FOUND';
  END IF;
  IF v_fr.is_current = false THEN
    RAISE EXCEPTION 'FREIGHT_SUPERSEDED';
  END IF;

  SELECT * INTO v_pu FROM purchases WHERE id = p_purchase_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;
  IF v_pu.is_current = false THEN
    RAISE EXCEPTION 'PURCHASE_SUPERSEDED';
  END IF;

  -- historical cost correction is allowed only while the freight period is OPEN
  PERFORM assert_period_open(v_fr.economic_date);

  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_already
    FROM freight_allocation WHERE freight_id = p_freight_id;
  IF v_already + p_allocated_amount > v_fr.amount THEN
    RAISE EXCEPTION 'OVER_ALLOCATION: allocating % exceeds freight amount % (already allocated %)',
      p_allocated_amount, v_fr.amount, v_already;
  END IF;

  IF EXISTS (SELECT 1 FROM freight_allocation WHERE freight_id = p_freight_id AND purchase_id = p_purchase_id) THEN
    RAISE EXCEPTION 'ALREADY_ALLOCATED: this freight is already allocated to this purchase';
  END IF;

  INSERT INTO freight_allocation (freight_id, purchase_id, allocated_amount, allocated_by)
  VALUES (p_freight_id, p_purchase_id, p_allocated_amount, v_uid)
  RETURNING id INTO v_allocation_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('freight_allocation', v_allocation_id::TEXT, 'ALLOCATE',
          jsonb_build_object('freight_id', p_freight_id, 'purchase_id', p_purchase_id,
                             'allocated_amount', p_allocated_amount),
          p_reason, v_uid);

  RETURN jsonb_build_object('allocation_id', v_allocation_id,
                            'freight_remaining', v_fr.amount - v_already - p_allocated_amount);
END;
$$;

-- ── ownership and EXECUTE perimeter (RLS spec section 4) ───────────────────

ALTER FUNCTION register_purchase(UUID, DATE, NUMERIC, NUMERIC, UUID, VARCHAR, purchase_nature, JSONB, JSONB, VARCHAR, UUID, UUID, VARCHAR, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION rectify_purchase(UUID, NUMERIC, NUMERIC, JSONB, TEXT) OWNER TO postgres;
ALTER FUNCTION pay_supplier(UUID, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) OWNER TO postgres;
ALTER FUNCTION register_freight(DATE, NUMERIC, UUID, VARCHAR, UUID, VARCHAR, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION assign_freight_to_purchase(UUID, UUID, NUMERIC, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION register_purchase(UUID, DATE, NUMERIC, NUMERIC, UUID, VARCHAR, purchase_nature, JSONB, JSONB, VARCHAR, UUID, UUID, VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION rectify_purchase(UUID, NUMERIC, NUMERIC, JSONB, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION pay_supplier(UUID, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION register_freight(DATE, NUMERIC, UUID, VARCHAR, UUID, VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION assign_freight_to_purchase(UUID, UUID, NUMERIC, TEXT) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION register_purchase(UUID, DATE, NUMERIC, NUMERIC, UUID, VARCHAR, purchase_nature, JSONB, JSONB, VARCHAR, UUID, UUID, VARCHAR, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rectify_purchase(UUID, NUMERIC, NUMERIC, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION pay_supplier(UUID, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION register_freight(DATE, NUMERIC, UUID, VARCHAR, UUID, VARCHAR, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION assign_freight_to_purchase(UUID, UUID, NUMERIC, TEXT) TO authenticated;
