-- ============================================================================
-- TARGET V1 — 0102 UNCLASSIFIED EXPENSES (ADR-025 owner decision 2026-10-23; CANDIDATE, not applied anywhere)
--
-- A real outflow paid from Caja chica / a bank account is recorded at once (the money left), while its economic
-- classification (category / subcategory / nature) is still unknown. The money event and the classification are separate:
--   1. expense_pending_classification (immutable): ONE pending per payment — the PURCHASE_PAYMENT operation
--      'EXPENSE-PENDING:<id>' with ONE posting −amount on the paying account. No purchase, no P&L category, no guess.
--      expense_pending_resolution (immutable): ONE per pending — the purchase created by its classification.
--   2. register_unclassified_expense (RPC, SECURITY DEFINER, ADMIN, idempotent by key): operation + posting + pending in one
--      transaction. Mercado Pago is refused: its outflow already reaches the balance as the ADR-021 provisional
--      (mp_pending_outflow) and is classified through its own route — never a second outflow.
--   3. classify_pending_expense (RPC, SECURITY DEFINER, ADMIN, idempotent): the purchase (P&L) linked to the EXISTING
--      payment (purchases.paid_operation_id) + the resolution + audit. No operation, no posting, no balance change.
--      Later changes of the classification: rectify_casual_purchase_classification (0088, unchanged).
--   4. expense_pending_integrity (deferred constraint triggers): at commit, every 'EXPENSE-PENDING:' operation has its
--      pending and exactly one matching posting; every pending has that operation; a purchase on a pending payment exists
--      only with its resolution; a resolution's purchase carries the pending's amount, date and payment.
--   5. expense_pending_close_guard (BEFORE UPDATE on management_period, separate trigger; 0093's guard is not modified):
--      a period with unclassified expenses cannot be closed (PENDING_EXPENSE_CLASSIFICATION).
--   6. fin_expense_pending_classification (view, security_invoker, ADMIN): the ERP list of pending / classified expenses.
--   7. pnl_line_item: bucket GASTOS_SIN_CLASIFICAR (pending without a current purchase); pnl_summary: column
--      gastos_sin_clasificar appended, part of resultado_operativo and of every later subtotal. Classifying moves the line
--      from GASTOS_SIN_CLASIFICAR to its category bucket: the total does not change.
-- Not modified: register_casual_purchase, rectify_casual_purchase_classification, ADR-021 / 0091 functions and triggers,
-- management_period_close_guard, fin_match_statement_line. SECURITY DEFINER set +4 (2 RPC + 2 guard functions).
-- ============================================================================

-- ── 1. pending expenses and their resolution ─────────────────────────────────
CREATE TABLE expense_pending_classification (
  id                   BIGSERIAL PRIMARY KEY,
  payment_operation_id BIGINT        NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id UUID          NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  payment_method       payment_method NOT NULL,
  amount               NUMERIC(15,2) NOT NULL,
  economic_date        DATE          NOT NULL,
  concept              VARCHAR(100)  NOT NULL,
  counterparty_name    VARCHAR(120),
  idempotency_key      VARCHAR(100)  NOT NULL UNIQUE,
  origin               VARCHAR(10)   NOT NULL,
  origin_ref           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_by           UUID          NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_epc_amount  CHECK (amount > 0),
  CONSTRAINT chk_epc_method  CHECK (payment_method <> 'CHEQUE'),
  CONSTRAINT chk_epc_concept CHECK (concept = btrim(concept) AND concept <> ''),
  CONSTRAINT chk_epc_name    CHECK (counterparty_name IS NULL OR (counterparty_name = btrim(counterparty_name) AND counterparty_name <> '')),
  CONSTRAINT chk_epc_origin  CHECK (origin IN ('WHATSAPP', 'ERP')),
  CONSTRAINT chk_epc_ref     CHECK (jsonb_typeof(origin_ref) = 'object')
);
CREATE INDEX idx_epc_economic_date ON expense_pending_classification(economic_date);
CREATE TABLE expense_pending_resolution (
  id                  BIGSERIAL PRIMARY KEY,
  pending_id          BIGINT          NOT NULL UNIQUE REFERENCES expense_pending_classification(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id         UUID            NOT NULL UNIQUE REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_category_id UUID            NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  nature              purchase_nature NOT NULL,
  reason              TEXT,
  resolved_by         UUID            NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  resolved_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_expense_pending_immutable BEFORE UPDATE OR DELETE ON expense_pending_classification
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_expense_pending_resolution_immutable BEFORE UPDATE OR DELETE ON expense_pending_resolution
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE expense_pending_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_pending_resolution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE expense_pending_classification, expense_pending_resolution FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE expense_pending_classification, expense_pending_resolution TO authenticated;
REVOKE ALL ON SEQUENCE expense_pending_classification_id_seq, expense_pending_resolution_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY expense_pending_admin_select ON expense_pending_classification FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY expense_pending_resolution_admin_select ON expense_pending_resolution FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── 2. register_unclassified_expense ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_unclassified_expense(
  p_economic_date        DATE,
  p_amount_total         NUMERIC,
  p_concept              VARCHAR,
  p_paid_from_account_id UUID,
  p_payment_method       payment_method,
  p_idempotency_key      VARCHAR,
  p_counterparty_name    VARCHAR DEFAULT NULL,
  p_origin               VARCHAR DEFAULT 'ERP',
  p_origin_ref           JSONB   DEFAULT '{}'::jsonb,
  p_reason               TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_concept VARCHAR := nullif(btrim(p_concept), '');
  v_name    VARCHAR := nullif(btrim(p_counterparty_name), '');
  v_p       expense_pending_classification%ROWTYPE;
  v_acc     financial_account%ROWTYPE;
  v_id      BIGINT;
  v_op      BIGINT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required';
  END IF;
  IF left(p_idempotency_key, 8) = 'RECTIFY:' OR left(p_idempotency_key, 16) = 'EXPENSE-PENDING:' THEN
    RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefixes RECTIFY: and EXPENSE-PENDING: are reserved';
  END IF;
  -- the same lock namespace as register_casual_purchase: one key is either a purchase or a pending expense, never both
  PERFORM pg_advisory_xact_lock(hashtextextended('casual_purchase:' || p_idempotency_key, 0));

  -- idempotent replay by key (a WhatsApp retry, a double confirmation): the same data returns the same pending
  SELECT * INTO v_p FROM expense_pending_classification WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_p.amount = p_amount_total AND v_p.economic_date = p_economic_date AND v_p.financial_account_id = p_paid_from_account_id
       AND v_p.payment_method = p_payment_method AND v_p.concept = v_concept AND v_p.counterparty_name IS NOT DISTINCT FROM v_name THEN
      RETURN jsonb_build_object('pending_id', v_p.id, 'payment_operation_id', v_p.payment_operation_id, 'amount', v_p.amount,
                                'status', 'SIN_CLASIFICAR', 'replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: key % already registered a different expense', p_idempotency_key;
  END IF;
  IF EXISTS (SELECT 1 FROM purchases WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: key % already registered a purchase', p_idempotency_key;
  END IF;

  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_total <> round(p_amount_total, 2) OR p_amount_total >= 1e13 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF v_concept IS NULL OR length(v_concept) > 100 THEN
    RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 120 THEN
    RAISE EXCEPTION 'INVALID_COUNTERPARTY_NAME: at most 120 characters';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method = 'CHEQUE' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: cash, transfer or Mercado Pago (a cheque goes to a registered supplier)';
  END IF;
  SELECT * INTO v_acc FROM financial_account WHERE id = p_paid_from_account_id AND activo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  -- ADR-021 / 0091: Mercado Pago money moves only through its movements; the outflow is already pending there
  IF (v_acc.nombre = 'Mercado Pago' AND v_acc.account_type = 'EXTERNAL_SERVICE') OR p_payment_method = 'MERCADOPAGO' THEN
    RAISE EXCEPTION 'MP_USE_PENDING_OUTFLOW: a Mercado Pago outflow is already pending classification (fin_mp_pending_classification)';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('WHATSAPP', 'ERP') THEN
    RAISE EXCEPTION 'INVALID_ORIGIN';
  END IF;
  IF p_origin_ref IS NULL OR jsonb_typeof(p_origin_ref) <> 'object' OR length(p_origin_ref::text) > 2000 THEN
    RAISE EXCEPTION 'INVALID_ORIGIN_REF';
  END IF;
  PERFORM assert_period_open(p_economic_date);

  -- the money: ONE operation, ONE posting on the paying account (the authoritative balance event)
  v_id := nextval('expense_pending_classification_id_seq');
  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('PURCHASE_PAYMENT', p_economic_date, 'EXPENSE-PENDING:' || v_id, 'expense_pending_classification', v_id::TEXT,
            coalesce(nullif(btrim(p_reason), ''), v_concept) || ' (sin clasificar)', v_uid)
    RETURNING id INTO v_op;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PAYMENT';
  END;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, p_paid_from_account_id, -p_amount_total, p_economic_date, v_uid);
  INSERT INTO expense_pending_classification (id, payment_operation_id, financial_account_id, payment_method, amount, economic_date, concept,
         counterparty_name, idempotency_key, origin, origin_ref, created_by)
  VALUES (v_id, v_op, p_paid_from_account_id, p_payment_method, p_amount_total, p_economic_date, v_concept, v_name, p_idempotency_key,
          p_origin, p_origin_ref, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('expense_pending_classification', v_id::TEXT, 'EXPENSE_PENDING_REGISTERED',
          jsonb_build_object('amount', p_amount_total, 'economic_date', p_economic_date, 'paid_from', p_paid_from_account_id,
                             'payment_method', p_payment_method, 'payment_operation', v_op, 'origin', p_origin, 'origin_ref', p_origin_ref),
          coalesce(nullif(btrim(p_reason), ''), 'egreso registrado, pendiente de clasificar'), v_uid);
  RETURN jsonb_build_object('pending_id', v_id, 'payment_operation_id', v_op, 'amount', p_amount_total, 'status', 'SIN_CLASIFICAR', 'replayed', false);
END;
$$;
ALTER FUNCTION register_unclassified_expense(DATE, NUMERIC, VARCHAR, UUID, payment_method, VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_unclassified_expense(DATE, NUMERIC, VARCHAR, UUID, payment_method, VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_unclassified_expense(DATE, NUMERIC, VARCHAR, UUID, payment_method, VARCHAR, VARCHAR, VARCHAR, JSONB, TEXT) TO authenticated;

-- ── 3. classify_pending_expense ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION classify_pending_expense(
  p_pending_id          BIGINT,
  p_expense_category_id UUID,
  p_nature              purchase_nature,
  p_concept             VARCHAR DEFAULT NULL,
  p_counterparty_name   VARCHAR DEFAULT NULL,
  p_reason              TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_p        expense_pending_classification%ROWTYPE;
  v_r        expense_pending_resolution%ROWTYPE;
  v_cur      purchases%ROWTYPE;
  v_concept  VARCHAR;
  v_name     VARCHAR;
  v_purchase UUID := gen_random_uuid();
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  -- concurrency: the pending row is the lock (a second classifier waits, then sees the resolution)
  SELECT * INTO v_p FROM expense_pending_classification WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PENDING_NOT_FOUND';
  END IF;
  v_concept := coalesce(nullif(btrim(p_concept), ''), v_p.concept);
  v_name    := CASE WHEN p_counterparty_name IS NULL THEN v_p.counterparty_name ELSE nullif(btrim(p_counterparty_name), '') END;

  SELECT * INTO v_r FROM expense_pending_resolution WHERE pending_id = v_p.id;
  IF FOUND THEN
    -- an identical replay returns the classification; anything else is a reclassification (rectify_casual_purchase_classification)
    SELECT * INTO v_cur FROM purchases WHERE paid_operation_id = v_p.payment_operation_id AND is_current;
    IF v_cur.id = v_r.purchase_id AND v_cur.expense_category_id = p_expense_category_id AND v_cur.nature = p_nature
       AND v_cur.subcategory IS NOT DISTINCT FROM v_concept AND v_cur.counterparty_name IS NOT DISTINCT FROM v_name THEN
      RETURN jsonb_build_object('pending_id', v_p.id, 'purchase_id', v_r.purchase_id, 'payment_operation_id', v_p.payment_operation_id,
                                'status', 'CLASIFICADO', 'replayed', true);
    END IF;
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: pending % is classified (purchase %); change it with rectify_casual_purchase_classification',
      v_p.id, coalesce(v_cur.id, v_r.purchase_id);
  END IF;

  IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
    RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
  END IF;
  -- owner decision (stage 2): the same selectability as the WhatsApp bot — the subcategory AND its category must be active
  -- (stricter than the general purchase validation of the ERP, which is not changed)
  IF NOT EXISTS (SELECT 1 FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
                  WHERE c.id = p_expense_category_id AND g.activo) THEN
    RAISE EXCEPTION 'CATEGORY_GROUP_INACTIVE: the category of this subcategory is inactive';
  END IF;
  IF p_nature IS NULL THEN
    RAISE EXCEPTION 'NATURE_REQUIRED';
  END IF;
  IF length(v_concept) > 100 THEN
    RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required';
  END IF;
  IF v_name IS NOT NULL AND length(v_name) > 120 THEN
    RAISE EXCEPTION 'INVALID_COUNTERPARTY_NAME: at most 120 characters';
  END IF;
  PERFORM assert_period_open(v_p.economic_date);

  -- the classification: the purchase (P&L) on the EXISTING payment — no operation, no posting, no balance change.
  -- trg_purchases_category_selectable (0096) still refuses owner-withdrawal / fiscal-reserved categories.
  INSERT INTO purchases (id, supplier_id, counterparty_name, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature,
         paid_operation_id, is_current, version_seq, idempotency_key, created_by)
  VALUES (v_purchase, NULL, v_name, v_p.economic_date, v_p.amount, v_p.amount, p_expense_category_id, v_concept, p_nature,
          v_p.payment_operation_id, true, 0, 'EXPENSE-PENDING:' || v_p.id, v_uid);
  INSERT INTO expense_pending_resolution (pending_id, purchase_id, expense_category_id, nature, reason, resolved_by)
  VALUES (v_p.id, v_purchase, p_expense_category_id, p_nature, nullif(btrim(p_reason), ''), v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('expense_pending_classification', v_p.id::TEXT, 'EXPENSE_PENDING_CLASSIFIED',
          jsonb_build_object('status', 'SIN_CLASIFICAR', 'registered_by', v_p.created_by, 'registered_at', v_p.created_at,
                             'origin', v_p.origin, 'origin_ref', v_p.origin_ref, 'concept', v_p.concept),
          jsonb_build_object('status', 'CLASIFICADO', 'purchase_id', v_purchase, 'expense_category_id', p_expense_category_id, 'nature', p_nature,
                             'concept', v_concept, 'counterparty_name', v_name, 'payment_operation', v_p.payment_operation_id),
          coalesce(nullif(btrim(p_reason), ''), 'clasificación de egreso pendiente'), v_uid);
  RETURN jsonb_build_object('pending_id', v_p.id, 'purchase_id', v_purchase, 'payment_operation_id', v_p.payment_operation_id,
                            'status', 'CLASIFICADO', 'replayed', false);
END;
$$;
ALTER FUNCTION classify_pending_expense(BIGINT, UUID, purchase_nature, VARCHAR, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION classify_pending_expense(BIGINT, UUID, purchase_nature, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION classify_pending_expense(BIGINT, UUID, purchase_nature, VARCHAR, VARCHAR, TEXT) TO authenticated;

-- ── 4. atomicity: deferred integrity of payment ⇔ pending ⇔ resolution ⇔ purchase ──
CREATE OR REPLACE FUNCTION expense_pending_check(p_operation_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_op financial_operation%ROWTYPE;
  v_p  expense_pending_classification%ROWTYPE;
  v_n  INTEGER;
  v_ok INTEGER;
BEGIN
  SELECT * INTO v_op FROM financial_operation WHERE id = p_operation_id;
  SELECT * INTO v_p FROM expense_pending_classification WHERE payment_operation_id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_PENDING_INTEGRITY: operation % (%) has no pending expense', p_operation_id, v_op.external_ref;
  END IF;
  IF v_op.operation_type <> 'PURCHASE_PAYMENT' OR v_op.external_ref IS DISTINCT FROM 'EXPENSE-PENDING:' || v_p.id THEN
    RAISE EXCEPTION 'EXPENSE_PENDING_INTEGRITY: pending % is not tied to its own payment operation', v_p.id;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE financial_account_id = v_p.financial_account_id AND signed_amount = -v_p.amount
                                      AND effective_date = v_p.economic_date)
    INTO v_n, v_ok FROM financial_posting WHERE financial_operation_id = p_operation_id;
  IF v_n <> 1 OR v_ok <> 1 THEN
    RAISE EXCEPTION 'EXPENSE_PENDING_INTEGRITY: pending % needs exactly one posting of % on its account (found %)', v_p.id, -v_p.amount, v_n;
  END IF;
  -- a purchase on this payment exists only through the classification (resolution), with the pending's amount and date
  IF EXISTS (SELECT 1 FROM purchases WHERE paid_operation_id = p_operation_id)
     AND NOT EXISTS (SELECT 1 FROM expense_pending_resolution r JOIN purchases pu ON pu.id = r.purchase_id
                      WHERE r.pending_id = v_p.id AND pu.paid_operation_id = p_operation_id AND pu.supplier_id IS NULL
                        AND pu.amount_total = v_p.amount AND pu.economic_date = v_p.economic_date) THEN
    RAISE EXCEPTION 'EXPENSE_PENDING_INTEGRITY: pending % has a purchase without its classification (use classify_pending_expense)', v_p.id;
  END IF;
  IF EXISTS (SELECT 1 FROM purchases WHERE paid_operation_id = p_operation_id AND is_current
               AND (amount_total <> v_p.amount OR economic_date <> v_p.economic_date OR supplier_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'EXPENSE_PENDING_INTEGRITY: the current purchase of pending % differs from the registered payment', v_p.id;
  END IF;
END;
$$;
ALTER FUNCTION expense_pending_check(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_pending_check(BIGINT) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION expense_pending_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'financial_operation' THEN
    v_op := NEW.id;
  ELSIF TG_TABLE_NAME = 'financial_posting' THEN
    SELECT o.id INTO v_op FROM financial_operation o WHERE o.id = NEW.financial_operation_id AND o.external_ref LIKE 'EXPENSE-PENDING:%';
  ELSIF TG_TABLE_NAME = 'expense_pending_classification' THEN
    v_op := NEW.payment_operation_id;
  ELSIF TG_TABLE_NAME = 'expense_pending_resolution' THEN
    SELECT p.payment_operation_id INTO v_op FROM expense_pending_classification p WHERE p.id = NEW.pending_id;
  ELSIF TG_TABLE_NAME = 'purchases' THEN
    SELECT p.payment_operation_id INTO v_op FROM expense_pending_classification p WHERE p.payment_operation_id = NEW.paid_operation_id;
  END IF;
  IF v_op IS NOT NULL THEN
    PERFORM expense_pending_check(v_op);
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION expense_pending_integrity() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_pending_integrity() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER trg_expense_pending_operation AFTER INSERT ON financial_operation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.external_ref LIKE 'EXPENSE-PENDING:%') EXECUTE FUNCTION expense_pending_integrity();
CREATE CONSTRAINT TRIGGER trg_expense_pending_posting AFTER INSERT ON financial_posting DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION expense_pending_integrity();
CREATE CONSTRAINT TRIGGER trg_expense_pending_row AFTER INSERT ON expense_pending_classification DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION expense_pending_integrity();
CREATE CONSTRAINT TRIGGER trg_expense_pending_resolution_row AFTER INSERT ON expense_pending_resolution DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION expense_pending_integrity();
CREATE CONSTRAINT TRIGGER trg_expense_pending_purchase AFTER INSERT ON purchases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.paid_operation_id IS NOT NULL) EXECUTE FUNCTION expense_pending_integrity();

-- ── 5. a period with unclassified expenses cannot be closed (separate trigger; 0093's guard unchanged) ──
CREATE OR REPLACE FUNCTION expense_pending_close_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n   BIGINT;
  v_sum NUMERIC;
BEGIN
  IF OLD.status = 'OPEN' AND NEW.status IS DISTINCT FROM 'OPEN' THEN
    SELECT count(*), coalesce(sum(p.amount), 0) INTO v_n, v_sum FROM expense_pending_classification p
     WHERE p.economic_date BETWEEN NEW.periodo_fecha AND (NEW.periodo_fecha + INTERVAL '1 month' - INTERVAL '1 day')::DATE
       AND NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = p.payment_operation_id AND pu.is_current);
    IF v_n > 0 THEN
      RAISE EXCEPTION 'PENDING_EXPENSE_CLASSIFICATION: % egreso(s) sin clasificar en el período % (total %). Clasificalos antes de cerrarlo.',
        v_n, to_char(NEW.periodo_fecha, 'YYYY-MM'), v_sum;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION expense_pending_close_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION expense_pending_close_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_expense_pending_close_guard BEFORE UPDATE ON management_period
  FOR EACH ROW EXECUTE FUNCTION expense_pending_close_guard();

-- ── 6. the ERP list (ADMIN) ──────────────────────────────────────────────────
CREATE VIEW fin_expense_pending_classification
WITH (security_invoker = true)
AS
SELECT p.id AS pending_id,
       CASE WHEN pu.id IS NULL THEN 'SIN_CLASIFICAR' ELSE 'CLASIFICADO' END::TEXT AS status,
       p.economic_date, p.amount, p.financial_account_id, a.nombre::TEXT AS account_name, p.payment_method,
       p.concept::TEXT AS concept, p.counterparty_name::TEXT AS counterparty_name, p.origin::TEXT AS origin, p.origin_ref,
       p.payment_operation_id, p.created_by, p.created_at,
       pu.id AS purchase_id, pu.expense_category_id, ec.nombre::TEXT AS category_name, pu.nature,
       r.resolved_by AS classified_by, r.resolved_at AS classified_at
  FROM expense_pending_classification p
  JOIN financial_account a ON a.id = p.financial_account_id
  LEFT JOIN expense_pending_resolution r ON r.pending_id = p.id
  LEFT JOIN purchases pu ON pu.paid_operation_id = p.payment_operation_id AND pu.is_current
  LEFT JOIN expense_category ec ON ec.id = pu.expense_category_id
 WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_expense_pending_classification OWNER TO postgres;
REVOKE ALL ON fin_expense_pending_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_expense_pending_classification TO authenticated;

-- ── 7. P&L: GASTOS_SIN_CLASIFICAR (0070 body + one branch; pnl_summary + one appended column) ──
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
   WHERE pu.is_current

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
  -- [0102] a registered expense without a current purchase on its payment: SIN CLASIFICAR (once; the purchase replaces it)
  SELECT 'GASTOS_SIN_CLASIFICAR', ep.economic_date, -ep.amount,
         'expense_pending_classification', ep.id::TEXT, NULL::UUID, NULL::purchase_nature, NULL::UUID,
         (ep.concept || ' (sin clasificar)')::TEXT
    FROM expense_pending_classification ep
   WHERE NOT EXISTS (SELECT 1 FROM purchases pu WHERE pu.paid_operation_id = ep.payment_operation_id AND pu.is_current)
) u
WHERE (SELECT current_app_role()) = 'ADMIN';

-- pnl_summary: existing columns unchanged in name and order; "gastos_sin_clasificar" is appended and is part of the
-- operating result and of every later subtotal (an unclassified expense is an expense of the period)
CREATE OR REPLACE VIEW pnl_summary
WITH (security_invoker = true)
AS
WITH b AS (
  SELECT period,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'VENTAS_NETAS'), 0)               AS ventas_netas_devengadas,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'COSTOS_DIRECTOS'), 0)            AS costos_directos,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'COSTOS_INDIRECTOS'), 0)          AS costos_indirectos,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'DIFERENCIA_CAJA'), 0)            AS diferencia_caja,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'OTROS_INGRESOS_FINANCIEROS'), 0) AS otros_ingresos_financieros,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'REINVERSION'), 0)                AS reinversion,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'RETIROS'), 0)                    AS retiros,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'RESERVAS_INTERNAS'), 0)          AS reservas_internas,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'INVERSIONES'), 0)                AS inversiones,
         COALESCE(SUM(signed_amount) FILTER (WHERE bucket = 'GASTOS_SIN_CLASIFICAR'), 0)      AS gastos_sin_clasificar
    FROM pnl_line_item
   GROUP BY period
)
SELECT period,
       ventas_netas_devengadas, costos_directos, costos_indirectos,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja + gastos_sin_clasificar   AS resultado_operativo,
       otros_ingresos_financieros,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja + gastos_sin_clasificar
         + otros_ingresos_financieros                                                                   AS resultado_antes_de_reinversion,
       reinversion,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja + gastos_sin_clasificar
         + otros_ingresos_financieros + reinversion                                                     AS resultado_post_reinversion,
       retiros,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja + gastos_sin_clasificar
         + otros_ingresos_financieros + reinversion + retiros                                           AS disponible_post_retiros,
       reservas_internas,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja + gastos_sin_clasificar
         + otros_ingresos_financieros + reinversion + retiros + reservas_internas                       AS post_reservas,
       inversiones,
       ventas_netas_devengadas + costos_directos + costos_indirectos + diferencia_caja + gastos_sin_clasificar
         + otros_ingresos_financieros + reinversion + retiros + reservas_internas + inversiones         AS resultado_post_inversiones,
       diferencia_caja,
       gastos_sin_clasificar
  FROM b;
