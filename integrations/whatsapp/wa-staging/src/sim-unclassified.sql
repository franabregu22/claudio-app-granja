-- ============================================================================
-- ADR-025 stage 2 — schema sim: CONTRACT DOUBLE of register_unclassified_expense (ERP candidate 0102). STAGING ONLY.
-- Same parameter names, defaults, errors and return shape as the real RPC; the pending rows are kept in a table with the
-- real name (resolved first through search_path = sim, public), there are no postings / balances in sim.
-- ============================================================================
SET LOCAL search_path = sim, public, pg_temp;

CREATE TABLE IF NOT EXISTS sim.expense_pending_classification (
  id BIGSERIAL PRIMARY KEY, payment_operation_id BIGINT NOT NULL UNIQUE, financial_account_id UUID NOT NULL REFERENCES sim.financial_account(id),
  payment_method sim.payment_method NOT NULL, amount NUMERIC(15,2) NOT NULL CHECK (amount > 0), economic_date DATE NOT NULL,
  concept TEXT NOT NULL, counterparty_name TEXT, idempotency_key TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK (origin IN ('WHATSAPP', 'ERP')),
  origin_ref JSONB NOT NULL DEFAULT '{}'::jsonb, created_by UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION sim.register_unclassified_expense(p_economic_date date, p_amount_total numeric, p_concept varchar, p_paid_from_account_id uuid,
  p_payment_method sim.payment_method, p_idempotency_key varchar, p_counterparty_name varchar DEFAULT NULL, p_origin varchar DEFAULT 'ERP',
  p_origin_ref jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE v_uid UUID; v_p sim.expense_pending_classification; v_acc sim.financial_account; v_concept TEXT := nullif(btrim(p_concept), '');
        v_name TEXT := nullif(btrim(p_counterparty_name), ''); v_op BIGINT; v_id BIGINT;
BEGIN
  IF sim.current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  v_uid := auth.uid();
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required'; END IF;
  IF p_idempotency_key LIKE 'RECTIFY:%' OR p_idempotency_key LIKE 'EXPENSE-PENDING:%' THEN
    RAISE EXCEPTION 'RESERVED_IDEMPOTENCY_KEY: the prefixes RECTIFY: and EXPENSE-PENDING: are reserved';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('casual_purchase:' || p_idempotency_key, 0));
  SELECT * INTO v_p FROM sim.expense_pending_classification WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_p.amount = p_amount_total AND v_p.economic_date = p_economic_date AND v_p.financial_account_id = p_paid_from_account_id
       AND v_p.payment_method = p_payment_method AND v_p.concept = v_concept AND v_p.counterparty_name IS NOT DISTINCT FROM v_name THEN
      RETURN jsonb_build_object('pending_id', v_p.id, 'payment_operation_id', v_p.payment_operation_id, 'amount', v_p.amount, 'status', 'SIN_CLASIFICAR', 'replayed', true);
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: key % already registered a different expense', p_idempotency_key;
  END IF;
  IF EXISTS (SELECT 1 FROM sim.purchases WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: key % already registered a purchase', p_idempotency_key;
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 OR p_amount_total <> round(p_amount_total, 2) THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF v_concept IS NULL OR length(v_concept) > 100 THEN RAISE EXCEPTION 'CONCEPT_REQUIRED: a concept of 1 to 100 characters is required'; END IF;
  IF p_payment_method IS NULL OR p_payment_method = 'CHEQUE' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_METHOD: cash, transfer or Mercado Pago (a cheque goes to a registered supplier)';
  END IF;
  SELECT * INTO v_acc FROM sim.financial_account WHERE id = p_paid_from_account_id AND activo;
  IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE'; END IF;
  IF (v_acc.nombre = 'Mercado Pago' AND v_acc.account_type = 'EXTERNAL_SERVICE') OR p_payment_method = 'MERCADOPAGO' THEN
    RAISE EXCEPTION 'MP_USE_PENDING_OUTFLOW: a Mercado Pago outflow is already pending classification (fin_mp_pending_classification)';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('WHATSAPP', 'ERP') THEN RAISE EXCEPTION 'INVALID_ORIGIN'; END IF;
  v_op := nextval('sim.financial_operation_seq');
  INSERT INTO sim.expense_pending_classification (payment_operation_id, financial_account_id, payment_method, amount, economic_date, concept,
         counterparty_name, idempotency_key, origin, origin_ref, created_by)
  VALUES (v_op, p_paid_from_account_id, p_payment_method, p_amount_total, p_economic_date, v_concept, v_name, p_idempotency_key, p_origin,
          coalesce(p_origin_ref, '{}'::jsonb), v_uid) RETURNING id INTO v_id;
  INSERT INTO sim.audit_events (table_name, record_id, action, performed_by, reason, new_data)
  VALUES ('expense_pending_classification', v_id, 'EXPENSE_PENDING_REGISTERED', v_uid, p_reason,
          jsonb_build_object('amount', p_amount_total, 'origin', p_origin, 'origin_ref', p_origin_ref));
  RETURN jsonb_build_object('pending_id', v_id, 'payment_operation_id', v_op, 'amount', p_amount_total, 'status', 'SIN_CLASIFICAR', 'replayed', false);
END $$;

ALTER FUNCTION sim.register_unclassified_expense(date, numeric, varchar, uuid, sim.payment_method, varchar, varchar, varchar, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION sim.register_unclassified_expense(date, numeric, varchar, uuid, sim.payment_method, varchar, varchar, varchar, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE sim.expense_pending_classification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sim.expense_pending_classification FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE sim.expense_pending_classification_id_seq FROM PUBLIC, anon, authenticated, service_role;
