-- ============================================================================
-- TARGET V1 — 0088 OPTIONAL SUPPLIER: CASUAL PURCHASES (ADR-019, ACCEPTED 2026-10-15)
--
-- purchases stays the ONLY general source of purchases / expenses (P&L). A purchase may now exist WITHOUT a registered
-- (recurring) supplier: a CASUAL purchase. It never touches the supplier current account and is born paid.
--
--   1. purchases: supplier_id nullable; counterparty_name (optional free name, trimmed, non-empty, casual only);
--      paid_operation_id (casual ⇔ paid); one current casual purchase per payment operation.
--   2. financial_operation_type PURCHASE_PAYMENT — the payment of a casual purchase (one posting on the paying account,
--      no supplier ledger). SUPPLIER_PAYMENT keeps its meaning (money against a supplier's current account).
--   3. fiscal_document: a received (CREDITO) document may identify its issuer by supplier_id OR by issuer CUIT (+ name);
--      the number is unique per issuer CUIT when there is no supplier. The IVA computation (report_fiscal_period) is
--      unchanged. RPC 34 register_fiscal_document keeps its signature and behaviour: its body now delegates to the
--      internal helper fiscal_document_insert (INVOKER, owner-only), which register_casual_purchase also uses with an
--      issuer. Implementation note to ADR-019 §3: the issuer form is reachable through the casual purchase only (RPC 34's
--      signature is not extended, so no DEFINER identity changes).
--   4. mp_outflow_classification — the single economic classification ledger of a Mercado Pago outflow (payout SOURCE_ID),
--      used by register_casual_purchase here and by the MP classification (0089); internal helper
--      mp_payout_outflow_resolve (INVOKER, owner-only): lock, movement, destination match.
--   5. register_casual_purchase (RPC, SECURITY DEFINER, ADMIN, idempotent): purchase + PURCHASE_PAYMENT in one
--      transaction; optional fiscal document (issuer); paying from Mercado Pago REQUIRES the payout SOURCE_ID (single
--      gateway: the movement is reconciled once and classified once, whatever the entry point).
--   6. rectify_purchase (RPC 14, same signature): casual branch — amount_total locked (CASUAL_PURCHASE_AMOUNT_LOCKED),
--      empty line set accepted, no supplier-ledger compensation, casual columns carried. Supplier branch unchanged.
--   7. rectify_casual_purchase_classification (RPC, SECURITY DEFINER, ADMIN): a new version of a casual purchase with a
--      new category / nature / concept / counterparty name; same amounts and lines; no money effect.
-- register_purchase (RPC 13) is NOT changed: it still requires an active supplier and writes the supplier ledger.
-- SECURITY DEFINER set 81 → 83.
-- ============================================================================

-- ── 1. purchases ────────────────────────────────────────────────────────────
ALTER TABLE purchases ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE purchases ADD COLUMN counterparty_name VARCHAR(120);
ALTER TABLE purchases ADD COLUMN paid_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_counterparty
  CHECK (counterparty_name IS NULL OR (supplier_id IS NULL AND counterparty_name = btrim(counterparty_name) AND counterparty_name <> ''));
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_casual_paid
  CHECK ((supplier_id IS NULL) = (paid_operation_id IS NOT NULL));
CREATE UNIQUE INDEX uq_purchases_paid_operation_current ON purchases(paid_operation_id)
  WHERE paid_operation_id IS NOT NULL AND is_current;

-- ── 2. operation type ───────────────────────────────────────────────────────
-- referenced only inside PL/pgSQL bodies below (not executed here): safe inside the runner's transaction (as 0043 / 0062)
ALTER TYPE financial_operation_type ADD VALUE 'PURCHASE_PAYMENT';

-- ── 3. fiscal documents: issuer identity without a recurring supplier ──────
ALTER TABLE fiscal_document ADD COLUMN issuer_tax_id VARCHAR(13);
ALTER TABLE fiscal_document ADD COLUMN issuer_name VARCHAR(120);
ALTER TABLE fiscal_document DROP CONSTRAINT chk_fiscal_counterparty;
ALTER TABLE fiscal_document ADD CONSTRAINT chk_fiscal_counterparty CHECK (
     (direction = 'CREDITO' AND (supplier_id IS NOT NULL OR issuer_tax_id IS NOT NULL))
  OR (direction = 'DEBITO' AND cliente_id IS NOT NULL));
ALTER TABLE fiscal_document ADD CONSTRAINT chk_fiscal_issuer CHECK (
     (issuer_tax_id IS NULL AND issuer_name IS NULL)
  OR (supplier_id IS NULL AND direction = 'CREDITO' AND issuer_tax_id ~ '^[0-9]{11}$'
      AND (issuer_name IS NULL OR (issuer_name = btrim(issuer_name) AND issuer_name <> ''))));
CREATE UNIQUE INDEX idx_fiscal_document_issuer_number ON fiscal_document(issuer_tax_id, external_number)
  WHERE supplier_id IS NULL AND issuer_tax_id IS NOT NULL AND external_number IS NOT NULL;

-- internal: the body of RPC 34, plus the issuer form (no role check: callers are ADMIN-checked definers)
CREATE OR REPLACE FUNCTION fiscal_document_insert(
  p_document_type   fiscal_document_type,
  p_direction       fiscal_direction,
  p_document_date   DATE,
  p_fiscal_period   DATE,
  p_net_amount      NUMERIC,
  p_total_amount    NUMERIC,
  p_components      JSONB,
  p_supplier_id     UUID,
  p_cliente_id      UUID,
  p_external_number VARCHAR,
  p_issuer_tax_id   VARCHAR,
  p_issuer_name     VARCHAR,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_document_id UUID;
  v_comp        JSONB;
  v_count       INTEGER := 0;
  v_issuer_name VARCHAR := nullif(btrim(p_issuer_name), '');
BEGIN
  IF p_direction = 'CREDITO' AND p_supplier_id IS NULL AND p_issuer_tax_id IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_REQUIRED';
  END IF;
  IF p_issuer_tax_id IS NOT NULL AND (p_supplier_id IS NOT NULL OR p_direction <> 'CREDITO' OR p_issuer_tax_id !~ '^[0-9]{11}$') THEN
    RAISE EXCEPTION 'INVALID_ISSUER: an issuer CUIT (11 digits) identifies a received document without a supplier';
  END IF;
  IF v_issuer_name IS NOT NULL AND p_issuer_tax_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ISSUER: an issuer name requires the issuer CUIT';
  END IF;
  IF p_direction = 'DEBITO' AND p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'CLIENT_REQUIRED';
  END IF;
  IF p_fiscal_period IS NULL OR p_fiscal_period <> date_trunc('month', p_fiscal_period)::DATE THEN
    RAISE EXCEPTION 'INVALID_FISCAL_PERIOD: must be the first day of a month';
  END IF;

  PERFORM assert_period_open(p_document_date);

  IF p_supplier_id IS NOT NULL AND p_external_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM fiscal_document
                  WHERE supplier_id = p_supplier_id AND external_number = p_external_number) THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_DOCUMENT';
  END IF;
  IF p_issuer_tax_id IS NOT NULL AND p_external_number IS NOT NULL
     AND EXISTS (SELECT 1 FROM fiscal_document
                  WHERE supplier_id IS NULL AND issuer_tax_id = p_issuer_tax_id AND external_number = p_external_number) THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_DOCUMENT';
  END IF;

  BEGIN
    INSERT INTO fiscal_document (document_type, direction, document_date, fiscal_period,
                                 supplier_id, cliente_id, external_number, net_amount,
                                 total_amount, issuer_tax_id, issuer_name, created_by)
    VALUES (p_document_type, p_direction, p_document_date, p_fiscal_period,
            p_supplier_id, p_cliente_id, p_external_number, p_net_amount,
            p_total_amount, p_issuer_tax_id, v_issuer_name, v_uid)
    RETURNING id INTO v_document_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_FISCAL_DOCUMENT';
  END;

  -- components exactly as supplied: rate_applied is the snapshot of the rate used
  FOR v_comp IN SELECT value FROM jsonb_array_elements(p_components) LOOP
    INSERT INTO fiscal_document_component (fiscal_document_id, tax_kind, direction,
                                           base_amount, rate_applied, tax_amount)
    VALUES (v_document_id, (v_comp->>'tax_kind')::tax_kind, (v_comp->>'direction')::fiscal_direction,
            (v_comp->>'base_amount')::NUMERIC, (v_comp->>'rate_applied')::NUMERIC,
            (v_comp->>'tax_amount')::NUMERIC);
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('fiscal_document', v_document_id::TEXT, 'CREATE',
          jsonb_build_object('document_type', p_document_type, 'direction', p_direction,
                             'fiscal_period', p_fiscal_period, 'total_amount', p_total_amount)
            || CASE WHEN p_issuer_tax_id IS NOT NULL THEN jsonb_build_object('issuer_tax_id', p_issuer_tax_id) ELSE '{}'::jsonb END,
          p_reason, v_uid);

  RETURN jsonb_build_object('fiscal_document_id', v_document_id, 'component_count', v_count);
END;
$$;
ALTER FUNCTION fiscal_document_insert(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, VARCHAR, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fiscal_document_insert(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, VARCHAR, VARCHAR, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- RPC 34: same signature, same contract; the body delegates (supplier form only)
CREATE OR REPLACE FUNCTION register_fiscal_document(
  p_document_type   fiscal_document_type,
  p_direction       fiscal_direction,
  p_document_date   DATE,
  p_fiscal_period   DATE,
  p_net_amount      NUMERIC,
  p_total_amount    NUMERIC,
  p_components      JSONB,
  p_supplier_id     UUID DEFAULT NULL,
  p_cliente_id      UUID DEFAULT NULL,
  p_external_number VARCHAR DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  RETURN fiscal_document_insert(p_document_type, p_direction, p_document_date, p_fiscal_period, p_net_amount, p_total_amount,
                                p_components, p_supplier_id, p_cliente_id, p_external_number, NULL, NULL, p_reason);
END;
$$;

-- ── 4. MP outflow classification ledger + resolver ─────────────────────────
CREATE TABLE mp_outflow_classification (
  id                         BIGSERIAL PRIMARY KEY,
  source_id                  VARCHAR(40) NOT NULL UNIQUE,
  mp_financial_movement_id   BIGINT      NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  classification             VARCHAR(20) NOT NULL,
  supplier_id                UUID        REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_category_id        UUID        REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  nature                     purchase_nature,
  concept                    VARCHAR(100),
  counterparty_name          VARCHAR(120),
  purchase_id                UUID        REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  management_event_id        UUID        REFERENCES management_event(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id     BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_run_id         UUID,
  destination_row_number     INTEGER,
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason                     TEXT,
  created_by                 UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_moc_classification CHECK (classification IN ('SUPPLIER_PAYMENT', 'EXPENSE', 'CASUAL_PURCHASE', 'OWNER_WITHDRAWAL')),
  CONSTRAINT chk_moc_shape CHECK (
       (classification = 'SUPPLIER_PAYMENT' AND supplier_id IS NOT NULL AND purchase_id IS NULL AND management_event_id IS NULL
          AND expense_category_id IS NULL AND concept IS NULL AND counterparty_name IS NULL)
    OR (classification = 'EXPENSE' AND supplier_id IS NOT NULL AND expense_category_id IS NOT NULL AND nature IS NOT NULL AND concept IS NOT NULL
          AND purchase_id IS NOT NULL AND management_event_id IS NULL AND counterparty_name IS NULL)
    OR (classification = 'CASUAL_PURCHASE' AND supplier_id IS NULL AND expense_category_id IS NOT NULL AND nature IS NOT NULL AND concept IS NOT NULL
          AND purchase_id IS NOT NULL AND management_event_id IS NULL)
    OR (classification = 'OWNER_WITHDRAWAL' AND supplier_id IS NULL AND purchase_id IS NULL AND management_event_id IS NOT NULL
          AND expense_category_id IS NULL AND concept IS NULL AND counterparty_name IS NULL)),
  CONSTRAINT fk_moc_destination FOREIGN KEY (destination_run_id, destination_row_number)
    REFERENCES fin_mp_payout_destination(run_id, row_number) ON DELETE RESTRICT ON UPDATE RESTRICT
);
ALTER TABLE mp_outflow_classification ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_mp_outflow_classification_immutable
  BEFORE UPDATE OR DELETE ON mp_outflow_classification
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE mp_outflow_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_outflow_classification TO authenticated;
REVOKE ALL ON SEQUENCE mp_outflow_classification_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY mp_outflow_classification_admin_select ON mp_outflow_classification
  FOR SELECT USING (current_app_role() = 'ADMIN');

-- internal: take the payout's classification lock and resolve it (movement locked, destination match, evidence row).
-- No decision is taken here: callers check the classification / application state and the match status.
CREATE OR REPLACE FUNCTION mp_payout_outflow_resolve(p_source_id TEXT)
RETURNS TABLE (movement_id BIGINT, net_amount NUMERIC, occurred_date DATE, mp_account_id UUID, match_status TEXT,
               applied BOOLEAN, destination_run_id UUID, destination_row_number INTEGER)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_mp  UUID;
  v_mv  mp_financial_movement%ROWTYPE;
  v_m   TEXT;
  v_run UUID;
  v_row INTEGER;
BEGIN
  IF p_source_id IS NULL OR p_source_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_payout_outflow:' || p_source_id, 0));
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;
  -- the payout movement claimed by the release report (0048 / 0071: ('report', '<SOURCE_ID>:payout:D', PAYOUT, ''))
  SELECT m.* INTO v_mv FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
   WHERE t.resource_type = 'report' AND t.resource_id = p_source_id || ':payout:D' AND t.transition = 'PAYOUT' AND t.transition_ref = ''
   FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_NOT_FOUND: no payout movement for %', p_source_id;
  END IF;
  IF v_mv.movement_kind <> 'transfer' OR v_mv.net_amount >= 0 THEN
    RAISE EXCEPTION 'NOT_A_PAYOUT';
  END IF;
  SELECT pm.match_status INTO v_m FROM fin_mp_payout_matches(v_mp) pm WHERE pm.source_id = p_source_id;
  SELECT d.run_id, d.row_number INTO v_run, v_row
    FROM fin_mp_payout_destination d JOIN fin_import_run r ON r.id = d.run_id
   WHERE d.source_id = p_source_id AND d.description = 'payout' AND r.source_kind = 'MP_RELEASE_REPORT' AND r.financial_account_id = v_mp
   ORDER BY d.created_at, d.run_id, d.row_number LIMIT 1;
  RETURN QUERY SELECT v_mv.id, v_mv.net_amount, v_mv.occurred_date, v_mp, coalesce(v_m, 'DESTINATION_UNKNOWN'),
                      EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = v_mv.id), v_run, v_row;
END;
$$;
ALTER FUNCTION mp_payout_outflow_resolve(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_payout_outflow_resolve(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. register_casual_purchase ─────────────────────────────────────────────
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
    SELECT * INTO v_out FROM mp_payout_outflow_resolve(p_mp_source_id);
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
    IF v_out.match_status = 'OWN_ACCOUNT_EXACT' THEN
      RAISE EXCEPTION 'OWN_ACCOUNT_PAYOUT: payout % goes to an own account — confirm it as a transfer', p_mp_source_id;
    END IF;
    IF v_out.match_status <> 'NO_OWN_ACCOUNT_MATCH' THEN
      RAISE EXCEPTION 'DESTINATION_REVIEW_REQUIRED: payout % is %', p_mp_source_id, v_out.match_status;
    END IF;
    IF p_amount_total <> -v_out.net_amount THEN
      RAISE EXCEPTION 'MP_AMOUNT_MISMATCH: the payout amount is %', -v_out.net_amount;
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
    VALUES (v_out.movement_id, v_op, v_out.mp_account_id, v_out.net_amount, 'MP-OUTFLOW:' || p_mp_source_id, NOW(), v_uid);
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

-- ── 6. rectify_purchase (RPC 14): casual branch ─────────────────────────────
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
  v_casual           BOOLEAN;
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
  v_casual := v_old.supplier_id IS NULL;

  PERFORM assert_period_open(v_old.economic_date);

  -- 2. validate the replacement COMPLETELY before mutating anything
  IF p_new_amount_total IS NULL OR p_new_amount_total <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_new_amount_net IS NULL OR p_new_amount_net < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  -- [ADR-019] a casual purchase is already paid: its amount never changes by rectification (a future reversal / refund does)
  IF v_casual AND p_new_amount_total <> v_old.amount_total THEN
    RAISE EXCEPTION 'CASUAL_PURCHASE_AMOUNT_LOCKED: a paid casual purchase keeps its amount %; a correction needs a reversal / refund', v_old.amount_total;
  END IF;
  IF p_new_lines IS NULL OR jsonb_typeof(p_new_lines) <> 'array'
     OR (jsonb_array_length(p_new_lines) = 0 AND NOT v_casual) THEN
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
  --    Mandatory: idx_purchases_supplier_invoice / uq_purchases_paid_operation_current forbid two current rows.
  UPDATE purchases SET is_current = false WHERE id = p_purchase_id;

  -- 5. THEN insert the new current version, reusing the captured values ([ADR-019] casual columns carried)
  INSERT INTO purchases (supplier_id, counterparty_name, economic_date, amount_net, amount_total,
         expense_category_id, subcategory, nature, project_id, fiscal_document_id,
         supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (v_supplier_id, v_old.counterparty_name, v_economic_date, p_new_amount_net, p_new_amount_total,
          v_category_id, v_subcategory, v_nature, v_project_id, v_fiscal_doc_id,
          v_invoice_number, v_flock_id, v_old.paid_operation_id, true, v_new_version,
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

  -- 9. compensating supplier ledger entries, both at the ORIGINAL economic_date — supplier purchases only ([ADR-019])
  IF NOT v_casual THEN
    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_supplier_id, 'REVERSAL', -v_old_total, v_economic_date,
            'purchases', p_purchase_id::TEXT, p_reason, v_uid);

    INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
           source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_supplier_id, 'PURCHASE', p_new_amount_total, v_economic_date,
            'purchases', v_new_purchase_id::TEXT, p_reason, v_uid);
  END IF;

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

-- ── 7. rectify_casual_purchase_classification ───────────────────────────────
-- A new version of a CASUAL purchase with a new category / nature / concept / counterparty name: same amounts, same
-- lines, attachments, fiscal link and payment; no money effect; the P&L follows the current version.
CREATE OR REPLACE FUNCTION rectify_casual_purchase_classification(
  p_purchase_id         UUID,
  p_expense_category_id UUID,
  p_nature              purchase_nature,
  p_concept             VARCHAR,
  p_counterparty_name   VARCHAR,
  p_reason              TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_old     purchases;
  v_concept VARCHAR := nullif(btrim(p_concept), '');
  v_name    VARCHAR := nullif(btrim(p_counterparty_name), '');
  v_new_id  UUID;
  v_version INTEGER;
BEGIN
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
  IF v_old.supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'NOT_A_CASUAL_PURCHASE: a supplier purchase is rectified through rectify_purchase';
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
  IF v_old.expense_category_id = p_expense_category_id AND v_old.nature = p_nature AND v_old.subcategory IS NOT DISTINCT FROM v_concept
     AND v_old.counterparty_name IS NOT DISTINCT FROM v_name THEN
    RAISE EXCEPTION 'NO_CHANGE: the classification is already the current one';
  END IF;

  PERFORM assert_period_open(v_old.economic_date);
  v_version := v_old.version_seq + 1;

  UPDATE purchases SET is_current = false WHERE id = p_purchase_id;
  INSERT INTO purchases (supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
         project_id, fiscal_document_id, supplier_invoice_number, flock_id, paid_operation_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (NULL, v_name, v_old.economic_date, v_old.amount_net, v_old.amount_total, p_expense_category_id, v_concept, p_nature,
          v_old.project_id, v_old.fiscal_document_id, v_old.supplier_invoice_number, v_old.flock_id, v_old.paid_operation_id, true, v_version,
          'RECTIFY:' || p_purchase_id::TEXT || ':v' || v_version, v_uid)
  RETURNING id INTO v_new_id;
  INSERT INTO purchase_line (purchase_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario)
  SELECT v_new_id, producto_id, feed_ingredient_id, descripcion, cantidad, unit_type, precio_unitario FROM purchase_line WHERE purchase_id = p_purchase_id;
  INSERT INTO purchase_attachment (purchase_id, storage_path, file_name, content_type, byte_size, uploaded_by)
  SELECT v_new_id, storage_path, file_name, content_type, byte_size, v_uid FROM purchase_attachment WHERE purchase_id = p_purchase_id;
  UPDATE freight_allocation SET purchase_id = v_new_id WHERE purchase_id = p_purchase_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', p_purchase_id::TEXT, 'RECLASSIFY',
          jsonb_build_object('expense_category_id', v_old.expense_category_id, 'nature', v_old.nature, 'concept', v_old.subcategory,
                             'counterparty_name', v_old.counterparty_name, 'version', v_old.version_seq),
          jsonb_build_object('expense_category_id', p_expense_category_id, 'nature', p_nature, 'concept', v_concept,
                             'counterparty_name', v_name, 'version', v_version, 'new_id', v_new_id),
          p_reason, v_uid);
  RETURN jsonb_build_object('previous_purchase_id', p_purchase_id, 'new_purchase_id', v_new_id, 'version_seq', v_version);
END;
$$;
ALTER FUNCTION rectify_casual_purchase_classification(UUID, UUID, purchase_nature, VARCHAR, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_casual_purchase_classification(UUID, UUID, purchase_nature, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_casual_purchase_classification(UUID, UUID, purchase_nature, VARCHAR, VARCHAR, TEXT) TO authenticated;
