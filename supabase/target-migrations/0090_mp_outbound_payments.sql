-- ============================================================================
-- TARGET V1 — 0090 MERCADO PAGO OUTBOUND PAYMENTS ARE CLASSIFIABLE (ADR-020, ACCEPTED 2026-10-15)
--
-- A payment made FROM the Mercado Pago balance (QR / in-store, transfer to a third-party CVU / CBU) appears in the release
-- report as a DEBIT `payment` row (`<SOURCE_ID>:payment:D`), parked by RPC 40 (PENDING, DEFERRED_V4) without a movement.
-- It becomes a classifiable outflow exactly like a payout (0087 / 0089), through the SAME routes:
--   1. mp_transition_identity: transition 'OUTBOUND' (identity ('report', '<SOURCE_ID>:payment:D', 'OUTBOUND', '')).
--   2. mp_outflow_resolve(p_source_id) (INVOKER, owner-only): resolves a payout OR an outbound payment under the payout
--      classification lock; an outbound movement (movement_kind 'outbound', gross / fee / tax / net parsed by the frozen
--      mp_parse_report_row) is created only here, i.e. only inside a classification transaction. Pre-cutover / error /
--      ignored rows are refused. Returns kind, amounts, date, MP account, destination match (payouts only), applied flag.
--   3. mp_outflow_apply_charges(…) (INVOKER, owner-only): the debit / credit tax (ADJUSTMENT) and any payer fee (FEE) of the
--      outflow as separate operations reconciled to the movement — the semantics A1 uses for inbound payments; the source
--      record of an outbound payment becomes RECONCILED once the movement is fully assigned (evidence untouched).
--   4. register_casual_purchase and mp_classify_payout_outflow (same signatures): resolve through mp_outflow_resolve; the
--      economic route receives |gross| (the purchase / supplier payment / withdrawal), the charges are applied apart, so the
--      Mercado Pago account goes down once by the report's net debit and the P&L carries the purchase only. The own-account
--      destination rules apply to payouts only (an outbound payment carries no destination evidence).
--   5. fin_mp_report_activity: a classified outbound payment → CLASSIFIED_OUTFLOW (its classification, its operation);
--      an unclassified one stays OUTBOUND (now classifiable from the UI).
-- mp_v4_verified() stays false; inbound report payment rows stay parked; nothing is applied automatically.
-- SECURITY DEFINER set unchanged (85): the two helpers are INVOKER.
-- ============================================================================

ALTER TABLE mp_transition_identity DROP CONSTRAINT chk_transition_kind;
ALTER TABLE mp_transition_identity ADD CONSTRAINT chk_transition_kind
  CHECK (transition IN ('APPROVAL', 'REFUND', 'CHARGEBACK', 'YIELD', 'PAYOUT', 'ACCOUNT_TAX', 'OUTBOUND'));

-- ── resolver: payout or outbound payment ───────────────────────────────────
CREATE OR REPLACE FUNCTION mp_outflow_resolve(p_source_id TEXT)
RETURNS TABLE (movement_id BIGINT, net_amount NUMERIC, occurred_date DATE, mp_account_id UUID, match_status TEXT,
               applied BOOLEAN, destination_run_id UUID, destination_row_number INTEGER,
               kind TEXT, gross_amount NUMERIC, fee_amount NUMERIC, tax_amount NUMERIC)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_mp   UUID;
  v_mv   mp_financial_movement%ROWTYPE;
  v_src  mp_source_record%ROWTYPE;
  v_p    RECORD;
  v_kind TEXT := 'PAYOUT';
  v_m    TEXT;
  v_run  UUID;
  v_row  INTEGER;
  v_tid  BIGINT;
BEGIN
  IF p_source_id IS NULL OR p_source_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_payout_outflow:' || p_source_id, 0));
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  -- a payout: claimed by the release report (0048 / 0071)
  SELECT m.* INTO v_mv FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
   WHERE t.resource_type = 'report' AND t.resource_id = p_source_id || ':payout:D' AND t.transition = 'PAYOUT' AND t.transition_ref = ''
   FOR UPDATE OF m;
  IF FOUND THEN
    IF v_mv.movement_kind <> 'transfer' OR v_mv.net_amount >= 0 THEN
      RAISE EXCEPTION 'NOT_A_PAYOUT';
    END IF;
    SELECT pm.match_status INTO v_m FROM fin_mp_payout_matches(v_mp) pm WHERE pm.source_id = p_source_id;
    SELECT d.run_id, d.row_number INTO v_run, v_row
      FROM fin_mp_payout_destination d JOIN fin_import_run r ON r.id = d.run_id
     WHERE d.source_id = p_source_id AND d.description = 'payout' AND r.source_kind = 'MP_RELEASE_REPORT' AND r.financial_account_id = v_mp
     ORDER BY d.created_at, d.run_id, d.row_number LIMIT 1;
    v_m := coalesce(v_m, 'DESTINATION_UNKNOWN');
  ELSE
    -- [ADR-020] an outbound payment: the parked report row, materialized once under the lock
    v_kind := 'OUTBOUND';
    SELECT * INTO v_src FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = p_source_id || ':payment:D' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYOUT_NOT_FOUND: no payout or outbound payment for %', p_source_id;
    END IF;
    IF v_src.processing_status IN ('ERROR', 'IGNORED') THEN
      RAISE EXCEPTION 'OUTFLOW_NOT_APPLICABLE: the report row is % (%)', v_src.processing_status, coalesce(v_src.processing_note, '-');
    END IF;
    SELECT m.* INTO v_mv FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
     WHERE t.resource_type = 'report' AND t.resource_id = v_src.external_id AND t.transition = 'OUTBOUND' AND t.transition_ref = ''
     FOR UPDATE OF m;
    IF NOT FOUND THEN
      SELECT * INTO v_p FROM mp_parse_report_row(v_src);
      IF v_p.o_status IS DISTINCT FROM 'NORMALIZED' OR v_p.o_desc IS DISTINCT FROM 'payment' OR v_p.o_net >= 0 THEN
        RAISE EXCEPTION 'NOT_AN_OUTBOUND_PAYMENT: % (%)', coalesce(v_p.o_status::text, '-'), coalesce(v_p.o_note, '-');
      END IF;
      INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
      VALUES (v_src.id, 'outbound', v_p.o_gross, v_p.o_fee, v_p.o_tax, v_p.o_net, v_src.occurred_date)
      RETURNING * INTO v_mv;
      INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
      VALUES ('report', v_src.external_id, 'OUTBOUND', '', v_src.id, v_mv.id)
      RETURNING id INTO v_tid;
    END IF;
    IF v_mv.gross_amount >= 0 OR v_mv.net_amount >= 0 OR v_mv.gross_amount + v_mv.fee_amount + v_mv.tax_amount <> v_mv.net_amount THEN
      RAISE EXCEPTION 'NOT_AN_OUTBOUND_PAYMENT: amounts gross % fee % tax % net %', v_mv.gross_amount, v_mv.fee_amount, v_mv.tax_amount, v_mv.net_amount;
    END IF;
    v_m := 'NO_DESTINATION_EVIDENCE';
  END IF;

  RETURN QUERY SELECT v_mv.id, v_mv.net_amount, v_mv.occurred_date, v_mp, v_m,
                      EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = v_mv.id), v_run, v_row,
                      v_kind, v_mv.gross_amount, v_mv.fee_amount, v_mv.tax_amount;
END;
$$;
ALTER FUNCTION mp_outflow_resolve(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_outflow_resolve(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── charges of an outflow: tax (ADJUSTMENT) and payer fee (FEE), reconciled to the movement ──
CREATE OR REPLACE FUNCTION mp_outflow_apply_charges(p_movement_id BIGINT, p_source_id TEXT, p_mp UUID, p_fee NUMERIC, p_tax NUMERIC,
  p_date DATE, p_uid UUID, p_kind TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_c  RECORD;
  v_op BIGINT;
BEGIN
  FOR v_c IN SELECT * FROM (VALUES ('MP-OUTFLOW-TAX:' || p_source_id, 'ADJUSTMENT'::financial_operation_type, p_tax, 'Impuesto débitos y créditos (Mercado Pago)'),
                                   ('MP-OUTFLOW-FEE:' || p_source_id, 'FEE'::financial_operation_type, p_fee, 'Comisión Mercado Pago')) c(k, typ, amount, reason)
              WHERE amount <> 0 LOOP
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_c.typ, p_date, v_c.k, 'mp_financial_movement', p_movement_id::TEXT, v_c.reason, p_uid)
    RETURNING id INTO v_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op, p_mp, v_c.amount, p_date, p_uid);
    INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
    VALUES (p_movement_id, v_op, p_mp, v_c.amount, v_c.k, NOW(), p_uid);
  END LOOP;
  -- [ADR-020] the parked outbound row is now fully assigned: processing metadata only
  IF p_kind = 'OUTBOUND' THEN
    UPDATE mp_source_record s SET processing_status = 'RECONCILED', processed_at = NOW(),
           processing_note = 'ADR-020: outbound payment classified'
     WHERE s.id = (SELECT mp_source_record_id FROM mp_financial_movement WHERE id = p_movement_id)
       AND NOT EXISTS (SELECT 1 FROM mp_financial_movement m WHERE m.mp_source_record_id = s.id
                        AND m.net_amount <> coalesce((SELECT sum(r.assigned_amount) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), 0));
  END IF;
END;
$$;
ALTER FUNCTION mp_outflow_apply_charges(BIGINT, TEXT, UUID, NUMERIC, NUMERIC, DATE, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_outflow_apply_charges(BIGINT, TEXT, UUID, NUMERIC, NUMERIC, DATE, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── register_casual_purchase (ADR-020: payout or outbound payment; charges apart) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_casual_purchase(
  p_economic_date        DATE,
  p_amount_net           NUMERIC,
  p_amount_total         NUMERIC,
  p_expense_category_id  UUID,
  p_concept              VARCHAR,
  p_nature               purchase_nature,
  p_paid_from_account_id UUID,
  p_payment_method       payment_method,
  p_idempotency_key      VARCHAR,
  p_counterparty_name    VARCHAR DEFAULT NULL,
  p_lines                JSONB DEFAULT '[]'::jsonb,
  p_attachments          JSONB DEFAULT '[]'::jsonb,
  p_fiscal               JSONB DEFAULT NULL,
  p_project_id           UUID DEFAULT NULL,
  p_flock_id             UUID DEFAULT NULL,
  p_mp_source_id         TEXT DEFAULT NULL,
  p_reason               TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_concept   VARCHAR := nullif(btrim(p_concept), '');
  v_name      VARCHAR := nullif(btrim(p_counterparty_name), '');
  v_existing  purchases%ROWTYPE;
  v_cls       mp_outflow_classification%ROWTYPE;
  v_out       RECORD;
  v_is_mp     BOOLEAN;
  v_purchase  UUID := gen_random_uuid();
  v_op        BIGINT;
  v_fiscal    UUID;
  v_res       JSONB;
  v_line      JSONB;
  v_att       JSONB;
  v_lines     INTEGER := 0;
  v_atts      INTEGER := 0;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  IF left(p_idempotency_key, 8) = 'RECTIFY:' THEN
    RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefix RECTIFY: is reserved for system-generated version keys';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('casual_purchase:' || p_idempotency_key, 0));

  -- idempotent replay by key
  SELECT * INTO v_existing FROM purchases WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.supplier_id IS NULL THEN
      RETURN jsonb_build_object('purchase_id', v_existing.id, 'replayed', true, 'payment_operation_id', v_existing.paid_operation_id,
                                'amount', v_existing.amount_total, 'fiscal_document_id', v_existing.fiscal_document_id);
    END IF;
    RAISE EXCEPTION 'DUPLICATE_PURCHASE';
  END IF;

  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_net IS NULL OR p_amount_net < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
  END IF;
  IF v_concept IS NULL OR length(v_concept) > 100 THEN
    RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required';
  END IF;
  IF p_nature IS NULL THEN
    RAISE EXCEPTION 'NATURE_REQUIRED';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 120 THEN
    RAISE EXCEPTION 'INVALID_COUNTERPARTY_NAME: at most 120 characters';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method = 'CHEQUE' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: a casual purchase is paid by cash, transfer or Mercado Pago (a cheque goes to a registered supplier)';
  END IF;
  IF p_paid_from_account_id IS NULL OR NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_paid_from_account_id AND activo) THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF p_attachments IS NOT NULL AND jsonb_typeof(p_attachments) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_ATTACHMENTS: attachments must be an array';
  END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_LINES: lines must be an array';
  END IF;

  -- Mercado Pago money: the single gateway — anchored to the payout SOURCE_ID, classified once
  v_is_mp := EXISTS (SELECT 1 FROM financial_account WHERE id = p_paid_from_account_id AND nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE');
  IF v_is_mp AND p_mp_source_id IS NULL THEN
    RAISE EXCEPTION 'MP_SOURCE_REQUIRED: a purchase paid from Mercado Pago must reference its payout SOURCE_ID';
  END IF;
  IF p_mp_source_id IS NOT NULL THEN
    IF NOT v_is_mp THEN
      RAISE EXCEPTION 'MP_SOURCE_NOT_ALLOWED: a SOURCE_ID is only valid for a purchase paid from Mercado Pago';
    END IF;
    SELECT * INTO v_out FROM mp_outflow_resolve(p_mp_source_id);
    SELECT * INTO v_cls FROM mp_outflow_classification WHERE source_id = p_mp_source_id;
    IF FOUND THEN
      IF v_cls.classification = 'CASUAL_PURCHASE' AND v_cls.expense_category_id = p_expense_category_id AND v_cls.nature = p_nature
         AND v_cls.concept = v_concept AND v_cls.counterparty_name IS NOT DISTINCT FROM v_name THEN
        RETURN jsonb_build_object('purchase_id', v_cls.purchase_id, 'replayed', true, 'payment_operation_id', v_cls.financial_operation_id,
                                  'amount', v_cls.amount, 'fiscal_document_id', (SELECT fiscal_document_id FROM purchases WHERE id = v_cls.purchase_id));
      END IF;
      RAISE EXCEPTION 'ALREADY_CLASSIFIED: payout % is already classified as %', p_mp_source_id, v_cls.classification;
    END IF;
    IF v_out.applied THEN
      RAISE EXCEPTION 'PAYOUT_ALREADY_APPLIED: the payout movement already has a financial operation';
    END IF;
    IF v_out.kind = 'PAYOUT' AND v_out.match_status = 'OWN_ACCOUNT_EXACT' THEN
      RAISE EXCEPTION 'OWN_ACCOUNT_PAYOUT: payout % goes to an own account — confirm it as a transfer', p_mp_source_id;
    END IF;
    IF v_out.kind = 'PAYOUT' AND v_out.match_status <> 'NO_OWN_ACCOUNT_MATCH' THEN
      RAISE EXCEPTION 'DESTINATION_REVIEW_REQUIRED: payout % is %', p_mp_source_id, v_out.match_status;
    END IF;
    IF p_amount_total <> -v_out.gross_amount THEN
      RAISE EXCEPTION 'MP_AMOUNT_MISMATCH: the economic amount of the outflow is %', -v_out.gross_amount;
    END IF;
    IF p_economic_date IS DISTINCT FROM v_out.occurred_date THEN
      RAISE EXCEPTION 'MP_DATE_MISMATCH: the payout date is %', v_out.occurred_date;
    END IF;
  END IF;

  PERFORM assert_period_open(p_economic_date);

  -- optional received fiscal document, issuer form (no recurring supplier)
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

  -- the payment: ONE operation, ONE posting on the paying account
  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('PURCHASE_PAYMENT', p_economic_date,
            CASE WHEN p_mp_source_id IS NOT NULL THEN 'MP-OUTFLOW:' || p_mp_source_id ELSE 'PURCHASE-PAY:' || p_idempotency_key END,
            'purchases', v_purchase::TEXT, coalesce(p_reason, v_concept), v_uid)
    RETURNING id INTO v_op;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, p_paid_from_account_id, -p_amount_total, p_economic_date, v_uid);

  -- the purchase: the cost (P&L), no supplier, no supplier ledger
  INSERT INTO purchases (id, supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
         project_id, fiscal_document_id, supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (v_purchase, NULL, v_name, p_economic_date, p_amount_net, p_amount_total, p_expense_category_id, v_concept, p_nature,
          p_project_id, v_fiscal, CASE WHEN p_fiscal IS NOT NULL THEN p_fiscal ->> 'external_number' END, p_flock_id, v_op, true, 0, p_idempotency_key, v_uid);
  FOR v_line IN SELECT value FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) LOOP
    INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario)
    VALUES (v_purchase, (v_line->>'producto_id')::UUID, (v_line->>'feed_ingredient_id')::UUID, v_line->>'descripcion',
            (v_line->>'cantidad')::NUMERIC, (v_line->>'unit_type')::unit_type, (v_line->>'precio_unitario')::NUMERIC);
    v_lines := v_lines + 1;
  END LOOP;
  FOR v_att IN SELECT value FROM jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) LOOP
    INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
    VALUES (v_purchase, v_att->>'storage_path', v_att->>'file_name', v_att->>'content_type', (v_att->>'byte_size')::BIGINT, v_uid);
    v_atts := v_atts + 1;
  END LOOP;

  -- Mercado Pago: the payout movement is reconciled to the payment, and classified once
  IF p_mp_source_id IS NOT NULL THEN
    INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
    VALUES (v_out.movement_id, v_op, v_out.mp_account_id, v_out.gross_amount, 'MP-OUTFLOW:' || p_mp_source_id, NOW(), v_uid);
    PERFORM mp_outflow_apply_charges(v_out.movement_id, p_mp_source_id, v_out.mp_account_id, v_out.fee_amount, v_out.tax_amount, p_economic_date, v_uid, v_out.kind);
    INSERT INTO mp_outflow_classification (source_id, mp_financial_movement_id, classification, expense_category_id, nature, concept, counterparty_name,
           purchase_id, financial_operation_id, destination_run_id, destination_row_number, amount, reason, created_by)
    VALUES (p_mp_source_id, v_out.movement_id, 'CASUAL_PURCHASE', p_expense_category_id, p_nature, v_concept, v_name,
            v_purchase, v_op, v_out.destination_run_id, v_out.destination_row_number, p_amount_total, p_reason, v_uid);
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_purchase::TEXT, 'CREATE_CASUAL',
          jsonb_build_object('amount_total', p_amount_total, 'economic_date', p_economic_date, 'payment_operation', v_op,
                             'paid_from', p_paid_from_account_id, 'fiscal_document_id', v_fiscal, 'mp_source_id', p_mp_source_id),
          coalesce(p_reason, v_concept), v_uid);
  RETURN jsonb_build_object('purchase_id', v_purchase, 'replayed', false, 'payment_operation_id', v_op, 'amount', p_amount_total,
                            'fiscal_document_id', v_fiscal, 'line_count', v_lines, 'attachment_count', v_atts);
END;
$$;
ALTER FUNCTION register_casual_purchase(DATE, NUMERIC, NUMERIC, UUID, VARCHAR, purchase_nature, UUID, payment_method, VARCHAR, VARCHAR, JSONB, JSONB, JSONB, UUID, UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_casual_purchase(DATE, NUMERIC, NUMERIC, UUID, VARCHAR, purchase_nature, UUID, payment_method, VARCHAR, VARCHAR, JSONB, JSONB, JSONB, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_casual_purchase(DATE, NUMERIC, NUMERIC, UUID, VARCHAR, purchase_nature, UUID, payment_method, VARCHAR, VARCHAR, JSONB, JSONB, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated;

-- ── outflows (ADR-020: payout or outbound payment; charges apart) ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_classify_payout_outflow(
  p_source_id           TEXT,
  p_classification      TEXT,
  p_supplier_id         UUID DEFAULT NULL,
  p_expense_category_id UUID DEFAULT NULL,
  p_nature              purchase_nature DEFAULT NULL,
  p_concept             TEXT DEFAULT NULL,
  p_counterparty_name   TEXT DEFAULT NULL,
  p_reason              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_row      mp_outflow_classification%ROWTYPE;
  v_out      RECORD;
  v_amt      NUMERIC(15,2);
  v_ref      TEXT;
  v_reason   TEXT;
  v_res      JSONB;
  v_op       BIGINT;
  v_purchase UUID;
  v_event    UUID;
  v_concept  TEXT := nullif(btrim(p_concept), '');
  v_name     TEXT := nullif(btrim(p_counterparty_name), '');
  v_nature   purchase_nature := coalesce(p_nature, 'OPERATING');
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_source_id IS NULL OR p_source_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID';
  END IF;
  IF p_classification IS NULL OR p_classification NOT IN ('SUPPLIER_PAYMENT', 'EXPENSE', 'CASUAL_PURCHASE', 'OWNER_WITHDRAWAL') THEN
    RAISE EXCEPTION 'INVALID_CLASSIFICATION: SUPPLIER_PAYMENT, EXPENSE, CASUAL_PURCHASE or OWNER_WITHDRAWAL';
  END IF;
  -- shape of the choice (identifiers only)
  IF p_classification IN ('SUPPLIER_PAYMENT', 'EXPENSE') THEN
    IF p_supplier_id IS NULL OR NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo) THEN
      RAISE EXCEPTION 'SUPPLIER_REQUIRED: an active supplier is required';
    END IF;
  ELSIF p_supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_ALLOWED: a casual purchase / partner withdrawal has no supplier';
  END IF;
  IF p_classification IN ('EXPENSE', 'CASUAL_PURCHASE') THEN
    IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
      RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
    END IF;
    IF v_concept IS NULL OR length(v_concept) > 100 THEN
      RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required';
    END IF;
  ELSIF p_expense_category_id IS NOT NULL OR p_nature IS NOT NULL OR v_concept IS NOT NULL THEN
    RAISE EXCEPTION 'CATEGORY_NOT_ALLOWED: only a purchase / expense carries a category, nature and concept';
  END IF;
  IF v_name IS NOT NULL AND p_classification <> 'CASUAL_PURCHASE' THEN
    RAISE EXCEPTION 'COUNTERPARTY_NOT_ALLOWED: a free counterparty name is only for a purchase without a registered supplier';
  END IF;

  -- lock + resolve the payout (0088), then the single-classification rules
  SELECT * INTO v_out FROM mp_outflow_resolve(p_source_id);
  SELECT * INTO v_row FROM mp_outflow_classification WHERE source_id = p_source_id;
  IF FOUND THEN
    IF v_row.classification = p_classification AND v_row.supplier_id IS NOT DISTINCT FROM p_supplier_id
       AND (p_classification NOT IN ('EXPENSE', 'CASUAL_PURCHASE')
            OR (v_row.expense_category_id IS NOT DISTINCT FROM p_expense_category_id AND v_row.concept IS NOT DISTINCT FROM v_concept
                AND v_row.nature IS NOT DISTINCT FROM v_nature AND v_row.counterparty_name IS NOT DISTINCT FROM v_name)) THEN
      RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', true, 'classification', v_row.classification,
        'financial_operation_id', v_row.financial_operation_id, 'purchase_id', v_row.purchase_id, 'amount', v_row.amount);
    END IF;
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: payout % is already classified as %', p_source_id, v_row.classification;
  END IF;
  IF v_out.applied THEN
    RAISE EXCEPTION 'PAYOUT_ALREADY_APPLIED: the payout movement already has a financial operation';
  END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status = 'DESTINATION_UNKNOWN' THEN
    RAISE EXCEPTION 'DESTINATION_UNKNOWN: no stored destination for payout %', p_source_id;
  END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status = 'OWN_ACCOUNT_EXACT' THEN
    RAISE EXCEPTION 'OWN_ACCOUNT_PAYOUT: payout % goes to an own account — confirm it as a transfer', p_source_id;
  END IF;
  IF v_out.kind = 'PAYOUT' AND v_out.match_status IS DISTINCT FROM 'NO_OWN_ACCOUNT_MATCH' THEN
    RAISE EXCEPTION 'DESTINATION_REVIEW_REQUIRED: payout % is %', p_source_id, v_out.match_status;
  END IF;

  v_amt := -v_out.gross_amount;   -- [ADR-020] the economic amount; the tax / fee are applied apart
  v_ref := 'MP-OUTFLOW:' || p_source_id;
  v_reason := coalesce(nullif(btrim(p_reason), ''),
    CASE p_classification WHEN 'SUPPLIER_PAYMENT' THEN 'Compra / gasto: pago de deuda a proveedor por Mercado Pago (retiro ' || p_source_id || ')'
                          WHEN 'OWNER_WITHDRAWAL' THEN 'Retiro de socios por Mercado Pago (retiro ' || p_source_id || ')'
                          ELSE v_concept || ' — compra / gasto pagado por Mercado Pago (retiro ' || p_source_id || ')' END);

  -- ADR-019: a purchase without a registered supplier goes through the casual-purchase gateway (it reconciles and classifies)
  IF p_classification = 'CASUAL_PURCHASE' THEN
    v_res := register_casual_purchase(v_out.occurred_date, v_amt, v_amt, p_expense_category_id, v_concept, v_nature, v_out.mp_account_id,
               'MERCADOPAGO', 'MP-OUTFLOW-PURCHASE:' || p_source_id, v_name, '[]'::jsonb, '[]'::jsonb, NULL, NULL, NULL, p_source_id, v_reason);
    SELECT * INTO v_row FROM mp_outflow_classification WHERE source_id = p_source_id;
    RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', (v_res ->> 'replayed')::BOOLEAN, 'classification', 'CASUAL_PURCHASE',
      'financial_operation_id', v_row.financial_operation_id, 'purchase_id', v_row.purchase_id, 'amount', v_row.amount);
  END IF;

  IF p_classification = 'OWNER_WITHDRAWAL' THEN
    v_res := register_management_event('RETIRO', v_out.occurred_date, v_amt, v_ref, v_reason, v_out.mp_account_id, NULL);
    v_event := (v_res ->> 'management_event_id')::UUID;
    v_op := (v_res ->> 'financial_operation_id')::BIGINT;
  ELSE
    IF p_classification = 'EXPENSE' THEN
      v_res := register_purchase(p_supplier_id, v_out.occurred_date, v_amt, v_amt, p_expense_category_id, v_concept,
                                 v_nature, '[]'::jsonb, '[]'::jsonb, 'MP-OUTFLOW-PURCHASE:' || p_source_id,
                                 NULL, NULL, NULL, NULL, v_reason);
      v_purchase := (v_res ->> 'purchase_id')::UUID;
    END IF;
    v_res := pay_supplier(p_supplier_id, v_amt, v_out.occurred_date, 'MERCADOPAGO', v_out.mp_account_id, v_ref, v_reason);
    v_op := (v_res ->> 'financial_operation_id')::BIGINT;
  END IF;

  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_out.movement_id, v_op, v_out.mp_account_id, v_out.gross_amount, v_ref, NOW(), v_uid);
  PERFORM mp_outflow_apply_charges(v_out.movement_id, p_source_id, v_out.mp_account_id, v_out.fee_amount, v_out.tax_amount, v_out.occurred_date, v_uid, v_out.kind);

  INSERT INTO mp_outflow_classification (source_id, mp_financial_movement_id, classification, supplier_id, expense_category_id, nature, concept,
         purchase_id, management_event_id, financial_operation_id, destination_run_id, destination_row_number, amount, reason, created_by)
  VALUES (p_source_id, v_out.movement_id, p_classification, p_supplier_id,
          CASE WHEN p_classification = 'EXPENSE' THEN p_expense_category_id END, CASE WHEN p_classification = 'EXPENSE' THEN v_nature END,
          CASE WHEN p_classification = 'EXPENSE' THEN v_concept END,
          v_purchase, v_event, v_op, v_out.destination_run_id, v_out.destination_row_number, v_amt, v_reason, v_uid)
  RETURNING * INTO v_row;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_outflow_classification', v_row.id::TEXT, 'CLASSIFY_MP_OUTFLOW',
          jsonb_build_object('source_id', p_source_id, 'classification', p_classification, 'amount', v_amt, 'supplier_id', p_supplier_id,
                             'purchase_id', v_purchase, 'management_event_id', v_event, 'financial_operation', v_op), v_reason, v_uid);
  RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', false, 'classification', p_classification,
    'financial_operation_id', v_op, 'purchase_id', v_purchase, 'amount', v_amt);
END;
$$;
ALTER FUNCTION mp_classify_payout_outflow(TEXT, TEXT, UUID, UUID, purchase_nature, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_classify_payout_outflow(TEXT, TEXT, UUID, UUID, purchase_nature, TEXT, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_classify_payout_outflow(TEXT, TEXT, UUID, UUID, purchase_nature, TEXT, TEXT, TEXT) TO authenticated;

-- ── activity view: classified payouts and outbound payments (ADR-020) ───────────────────────────────────────
CREATE OR REPLACE VIEW fin_mp_report_activity
WITH (security_invoker = true)
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
           -- the CURRENT version of a casual purchase (its classification may have been rectified, ADR-019 §7)
           LEFT JOIN purchases cp ON oc.classification = 'CASUAL_PURCHASE' AND cp.paid_operation_id = oc.financial_operation_id AND cp.is_current
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
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' THEN 'PAYOUT'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D' AND x.outflow_classification IS NOT NULL THEN 'CLASSIFIED_OUTFLOW'
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
