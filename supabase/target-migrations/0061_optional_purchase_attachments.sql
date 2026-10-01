-- ============================================================================
-- TARGET V1 — 0061 OPTIONAL PURCHASE ATTACHMENTS (ADR-010)
-- Authority: .planning/adr/ADR-010_OPTIONAL_PURCHASE_ATTACHMENTS.md (ACCEPTED, owner decision D-WALK-5)
--            TARGET_ARCHITECTURE_V2_FROZEN.md Part 8 [ADR-010 amendment note]
--            DATABASE_INVARIANTS_V1.md invariant 23 [ADR-010]
--            RPC_CONTRACTS_V1.md 13 register_purchase, 14 rectify_purchase [ADR-010]
--            ADR-008 (the Storage perimeter is unchanged; attachments stay private and ADMIN-only)
--
-- Owner rule: a purchase MAY be registered with zero attachments. Re-defines RPC 13 and RPC 14 from 0022 with the
-- same signatures and exactly these changes (every other line is 0022 verbatim):
--   RPC 13: NULL or [] attachments are accepted (ATTACHMENT_REQUIRED is superseded); a supplied value must be a JSON
--           array (INVALID_ATTACHMENTS); each supplied attachment is still validated by purchase_attachment's
--           NOT NULL / CHECK / UNIQUE constraints exactly as before.
--   RPC 14: the replacement version carries forward whatever attachments exist, possibly none.
-- CREATE OR REPLACE keeps owner and EXECUTE grants. No table, column, grant or policy change.
-- ============================================================================

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
  -- [ADR-010] attachments are optional: NULL or [] records no attachment; a supplied value must be an array
  IF p_attachments IS NOT NULL AND jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ATTACHMENTS: attachments must be an array';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo = true) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND_OR_INACTIVE';
  END IF;
  -- [ADR-002] the exact, case-sensitive ASCII prefix 'RECTIFY:' is reserved for
  -- system-generated rectified-version keys
  IF left(p_idempotency_key, 8) = 'RECTIFY:' THEN
    RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefix RECTIFY: is reserved for system-generated version keys';
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

  FOR v_att IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::jsonb)) LOOP
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
                             'attachments', jsonb_array_length(COALESCE(p_attachments, '[]'::jsonb))),
          p_reason, v_uid);

  RETURN jsonb_build_object('purchase_id', v_purchase_id, 'supplier_ledger_id', v_ledger_id,
                            'line_count', v_line_count, 'attachment_count', v_att_count);
END;
$$;

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

  -- [ADR-010] the replacement inherits whatever attachments exist (possibly none)
  SELECT count(*) INTO v_carried FROM purchase_attachment WHERE purchase_id = p_purchase_id;

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
          'RECTIFY:' || p_purchase_id::TEXT || ':v' || v_new_version,   -- [ADR-002] bounded, non-recursive
          v_uid)
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

  -- 7. carry the existing attachments forward (none is valid, ADR-010)
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
