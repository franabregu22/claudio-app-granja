-- ============================================================================
-- TARGET V1 — 0121 CUENTAS A PAGAR: PLAN DE PAGOS (CUOTAS), PAGO POR VENCIMIENTO Y LISTA DE PENDIENTES (owner GO 2026-11-13, caja-mejoras-v2)
--
-- No existing row, balance, posting, allocation, instrument or fiscal document changes. Nothing is backfilled. Nothing moves money
-- by itself: every payment still goes through the existing contract RPCs (pay_purchase_invoice 0119, pay_pending_expense 0106,
-- issue_purchase_instruments 0104), which keep their own rules, idempotency and audit.
--   1. payment_plan_item (append-only): an obligation (supplier invoice or pending expense, by its chain root) may be split into
--      due items (informal instalments) — each with its date and amount. A plan is VERSIONED: changing the payment form writes a new
--      version over what is still open; the old version stays as history. An obligation without a plan is ONE due item, as today
--      (its DUE / PLANNED dates, 0110).
--   2. payment_plan_item_link (append-only): which payment covers which item — a cash / transfer operation, or an own cheque / eCheq
--      allocated to the invoice (it counts while ISSUED or DEBITED; a rejected / cancelled one no longer covers the item).
--      fin_plan_link_payment (trigger, AFTER INSERT on purchase_payment_allocation and expense_payable_payment): a payment of an
--      obligation with a plan is linked to the item chosen by pay_plan_item / issue_plan_item_instruments (transaction-local setting
--      app.plan_item_id); a payment made anywhere else goes to the OLDEST open items first (owner decision 2026-11-13). A payment
--      already linked to the obligation (the earlier payments carried by assign_payable_to_supplier, 0110) is not linked twice.
--   3. set_payment_plan (ADMIN, idempotent, audited SET_PAYMENT_PLAN): the plan (1–60 items) must add up EXACTLY to what is open
--      now (the obligation's pending, own cheques excluded: they are items of their own); replacing a plan needs a reason.
--   4. pay_plan_item (ADMIN): pays (part of) ONE item by cash / transfer through the existing RPC of its obligation; never above the
--      item's open amount. issue_plan_item_instruments (ADMIN): pays (part of) ONE item with own cheques / eCheqs through
--      issue_purchase_instruments (a supplier invoice only: a cheque always needs a supplier).
--   5. fin_payables_due (view, security_invoker, ADMIN): every open due item once — plan items, obligations without plan (one item)
--      and own cheques / eCheqs to be debited. The open items of a plan always add up to the obligation's pending: a difference
--      left by a later rectification of the total is shown as its own row (DIFERENCIA) when it adds, and taken from the last
--      items when it subtracts — nothing is reconciled silently.
-- SECURITY DEFINER set +3 (set_payment_plan, pay_plan_item, issue_plan_item_instruments); +1 trigger function (owner-only).
-- ============================================================================

-- ── 1. the plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE payment_plan_item (
  id               BIGSERIAL PRIMARY KEY,
  purchase_root_id UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,   -- the obligation, whatever its version
  plan_version     INTEGER NOT NULL CHECK (plan_version >= 1),
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  due_date         DATE,                                                                         -- NULL: no date yet
  amount           NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  idempotency_key  VARCHAR(100) NOT NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT uq_ppi_version_seq UNIQUE (purchase_root_id, plan_version, seq)
);
CREATE INDEX idx_ppi_key ON payment_plan_item(idempotency_key);
CREATE TRIGGER trg_payment_plan_item_immutable BEFORE UPDATE OR DELETE ON payment_plan_item FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE payment_plan_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE payment_plan_item FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE payment_plan_item_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE payment_plan_item TO authenticated;
CREATE POLICY payment_plan_item_admin_select ON payment_plan_item FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE TABLE payment_plan_item_link (
  id                      BIGSERIAL PRIMARY KEY,
  item_id                 BIGINT NOT NULL REFERENCES payment_plan_item(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id  BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_instrument_id UUID REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                  NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  chosen                  BOOLEAN NOT NULL,                                                    -- true: the item was picked; false: oldest first
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ppil_one_payment CHECK ((financial_operation_id IS NULL) <> (financial_instrument_id IS NULL))
);
CREATE INDEX idx_ppil_item ON payment_plan_item_link(item_id);
CREATE INDEX idx_ppil_operation ON payment_plan_item_link(financial_operation_id) WHERE financial_operation_id IS NOT NULL;
CREATE TRIGGER trg_payment_plan_item_link_immutable BEFORE UPDATE OR DELETE ON payment_plan_item_link FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE payment_plan_item_link ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE payment_plan_item_link FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE payment_plan_item_link_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE payment_plan_item_link TO authenticated;
CREATE POLICY payment_plan_item_link_admin_select ON payment_plan_item_link FOR SELECT USING (current_app_role() = 'ADMIN');

-- The plan in force of an obligation (its latest version) and what covers each item (a rejected / cancelled cheque no longer does).
CREATE FUNCTION payment_plan_current_version(p_root UUID) RETURNS INTEGER LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT max(plan_version) FROM payment_plan_item WHERE purchase_root_id = p_root
$$;
CREATE FUNCTION payment_plan_item_covered(p_item BIGINT) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(sum(l.amount), 0) FROM payment_plan_item_link l LEFT JOIN financial_instrument i ON i.id = l.financial_instrument_id
   WHERE l.item_id = p_item AND (l.financial_operation_id IS NOT NULL OR i.estado::text IN ('ISSUED', 'DEBITED'))
$$;
-- What is open now in an obligation, own cheques excluded (they are items of their own): the pending of the payment calendar.
CREATE FUNCTION payment_plan_open_amount(p_root UUID) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce((SELECT sum(c.amount) FROM fin_payment_calendar c WHERE c.purchase_root_id = p_root AND c.item_kind IN ('FACTURA', 'GASTO')), 0)
$$;
ALTER FUNCTION payment_plan_current_version(UUID) OWNER TO postgres;
ALTER FUNCTION payment_plan_item_covered(BIGINT) OWNER TO postgres;
ALTER FUNCTION payment_plan_open_amount(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION payment_plan_current_version(UUID), payment_plan_item_covered(BIGINT), payment_plan_open_amount(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION payment_plan_current_version(UUID), payment_plan_item_covered(BIGINT), payment_plan_open_amount(UUID) TO authenticated;

-- ── 2. a payment of an obligation with a plan → its item(s) ──────────────────────────────────────────────────────────────
CREATE FUNCTION fin_plan_link_payment() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_root   UUID;
  v_op     BIGINT;
  v_ins    UUID;
  v_ver    INTEGER;
  v_rest   NUMERIC := NEW.amount;
  v_chosen BIGINT := nullif(current_setting('app.plan_item_id', true), '')::BIGINT;
  v_open   NUMERIC;
  v_take   NUMERIC;
  it       RECORD;
BEGIN
  IF TG_TABLE_NAME = 'purchase_payment_allocation' THEN
    v_root := NEW.purchase_root_id; v_op := NEW.financial_operation_id; v_ins := NEW.financial_instrument_id;
  ELSE
    SELECT purchase_root_id INTO v_root FROM expense_payable WHERE id = NEW.payable_id;
    v_op := NEW.financial_operation_id;
  END IF;
  v_ver := payment_plan_current_version(v_root);
  IF v_ver IS NULL THEN RETURN NEW; END IF;   -- no plan: one due item, nothing to link
  -- a payment already linked to this obligation (carried by assign_payable_to_supplier) is never linked twice
  IF v_op IS NOT NULL AND EXISTS (SELECT 1 FROM payment_plan_item_link l JOIN payment_plan_item p ON p.id = l.item_id
                                   WHERE l.financial_operation_id = v_op AND p.purchase_root_id = v_root) THEN
    RETURN NEW;
  END IF;
  IF v_chosen IS NOT NULL THEN
    SELECT * INTO it FROM payment_plan_item WHERE id = v_chosen AND purchase_root_id = v_root AND plan_version = v_ver;
    IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_ITEM_NOT_CURRENT: the chosen item is not in the plan in force of this obligation'; END IF;
    v_open := it.amount - payment_plan_item_covered(it.id);
    IF NEW.amount > v_open + 0.005 THEN RAISE EXCEPTION 'OVER_ITEM: the item has % open, the payment is %', v_open, NEW.amount; END IF;
    INSERT INTO payment_plan_item_link (item_id, financial_operation_id, financial_instrument_id, amount, chosen) VALUES (it.id, v_op, v_ins, NEW.amount, true);
    RETURN NEW;
  END IF;
  -- paid from elsewhere: the oldest open items first (by date, undated last, then order)
  FOR it IN SELECT * FROM payment_plan_item WHERE purchase_root_id = v_root AND plan_version = v_ver ORDER BY due_date NULLS LAST, seq LOOP
    EXIT WHEN v_rest <= 0;
    v_open := it.amount - payment_plan_item_covered(it.id);
    CONTINUE WHEN v_open <= 0;
    v_take := least(v_open, v_rest);
    INSERT INTO payment_plan_item_link (item_id, financial_operation_id, financial_instrument_id, amount, chosen) VALUES (it.id, v_op, v_ins, v_take, false);
    v_rest := v_rest - v_take;
  END LOOP;
  RETURN NEW;   -- what exceeds the plan (e.g. a later increase of the total) is the DIFERENCIA row of fin_payables_due
END $$;
ALTER FUNCTION fin_plan_link_payment() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_plan_link_payment() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_ppa_plan_link AFTER INSERT ON purchase_payment_allocation FOR EACH ROW EXECUTE FUNCTION fin_plan_link_payment();
CREATE TRIGGER trg_epp_plan_link AFTER INSERT ON expense_payable_payment FOR EACH ROW EXECUTE FUNCTION fin_plan_link_payment();

-- ── 3. set / replace the plan ────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION set_payment_plan(p_purchase_id UUID, p_items JSONB, p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_root  UUID;
  v_ver   INTEGER;
  v_open  NUMERIC;
  v_sum   NUMERIC := 0;
  v_n     INTEGER;
  v_rsn   TEXT := nullif(btrim(p_reason), '');
  x       JSONB;
  i       INTEGER := 0;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 OR length(p_idempotency_key) > 100 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('set_payment_plan:' || p_idempotency_key, 0));
  SELECT purchase_root_id, plan_version INTO v_root, v_ver FROM payment_plan_item WHERE idempotency_key = p_idempotency_key LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('replayed', true, 'purchase_root_id', v_root, 'plan_version', v_ver); END IF;

  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  v_root := purchase_chain_root(p_purchase_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('payment_plan:' || v_root::text, 0));
  v_ver := coalesce(payment_plan_current_version(v_root), 0);
  IF v_ver > 0 AND v_rsn IS NULL THEN RAISE EXCEPTION 'REASON_REQUIRED: changing a payment plan needs a reason'; END IF;
  v_open := payment_plan_open_amount(v_root);
  IF v_open <= 0 THEN RAISE EXCEPTION 'NOTHING_OPEN: the obligation has nothing left to plan'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_PLAN: an array of items is required'; END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'INVALID_PLAN: 1 to 60 items'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF (x ->> 'amount') IS NULL OR (x ->> 'amount')::numeric <= 0 OR round((x ->> 'amount')::numeric, 2) <> (x ->> 'amount')::numeric THEN
      RAISE EXCEPTION 'INVALID_PLAN: every item needs an amount above zero with at most 2 decimals';
    END IF;
    v_sum := v_sum + (x ->> 'amount')::numeric;
  END LOOP;
  IF v_sum <> v_open THEN RAISE EXCEPTION 'PLAN_TOTAL_MISMATCH: the items add up to %, what is open is %', v_sum, v_open; END IF;

  FOR x IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    i := i + 1;
    INSERT INTO payment_plan_item (purchase_root_id, plan_version, seq, due_date, amount, idempotency_key, reason, created_by)
    VALUES (v_root, v_ver + 1, i, nullif(x ->> 'due_date', '')::date, (x ->> 'amount')::numeric, p_idempotency_key, v_rsn, v_uid);
  END LOOP;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('purchases', v_root::text, 'SET_PAYMENT_PLAN',
          CASE WHEN v_ver > 0 THEN jsonb_build_object('plan_version', v_ver, 'items',
            (SELECT jsonb_agg(jsonb_build_object('seq', seq, 'due_date', due_date, 'amount', amount, 'covered', payment_plan_item_covered(id)) ORDER BY seq)
               FROM payment_plan_item WHERE purchase_root_id = v_root AND plan_version = v_ver)) END,
          jsonb_build_object('plan_version', v_ver + 1, 'open', v_open, 'items', p_items), v_rsn, v_uid);
  RETURN jsonb_build_object('replayed', false, 'purchase_root_id', v_root, 'plan_version', v_ver + 1, 'items', v_n);
END $$;
ALTER FUNCTION set_payment_plan(UUID, JSONB, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION set_payment_plan(UUID, JSONB, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION set_payment_plan(UUID, JSONB, VARCHAR, TEXT) TO authenticated;

-- ── 4. pay ONE item ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- The item of the plan in force, locked, with what is still open (own helper: shared by the two payment RPCs).
CREATE FUNCTION payment_plan_item_for_payment(p_item_id BIGINT, p_amount NUMERIC) RETURNS payment_plan_item
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE it payment_plan_item; v_open NUMERIC;
BEGIN
  SELECT * INTO it FROM payment_plan_item WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PLAN_ITEM_NOT_FOUND'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment_plan:' || it.purchase_root_id::text, 0));
  IF it.plan_version <> payment_plan_current_version(it.purchase_root_id) THEN RAISE EXCEPTION 'PLAN_ITEM_NOT_CURRENT: the plan was changed'; END IF;
  v_open := it.amount - payment_plan_item_covered(it.id);
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  IF p_amount > v_open THEN RAISE EXCEPTION 'OVER_ITEM: the item has % open, the payment is %', v_open, p_amount; END IF;
  RETURN it;
END $$;
ALTER FUNCTION payment_plan_item_for_payment(BIGINT, NUMERIC) OWNER TO postgres;
REVOKE ALL ON FUNCTION payment_plan_item_for_payment(BIGINT, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION pay_plan_item(p_item_id BIGINT, p_amount NUMERIC, p_effective_date DATE, p_payment_method payment_method, p_account_id UUID,
  p_idempotency_key VARCHAR, p_reference TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it payment_plan_item; v_payable UUID; v_res JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 90 characters required'; END IF;
  -- a replay returns what the underlying RPC recorded (it is idempotent by the same key), before any amount check
  IF EXISTS (SELECT 1 FROM purchase_payment_allocation WHERE idempotency_key = p_idempotency_key || ':ALLOC')
     OR EXISTS (SELECT 1 FROM expense_payable_payment WHERE idempotency_key = p_idempotency_key) THEN
    SELECT * INTO it FROM payment_plan_item WHERE id = p_item_id;
  ELSE
    it := payment_plan_item_for_payment(p_item_id, p_amount);
  END IF;
  IF it.id IS NULL THEN RAISE EXCEPTION 'PLAN_ITEM_NOT_FOUND'; END IF;
  SELECT g.payable_id INTO v_payable FROM fin_expense_payables g WHERE g.purchase_root_id = it.purchase_root_id AND g.pending > 0;
  PERFORM set_config('app.plan_item_id', it.id::text, true);
  IF v_payable IS NOT NULL THEN
    v_res := pay_pending_expense(v_payable, p_amount, p_effective_date, p_account_id, p_payment_method, p_idempotency_key, p_reference);
  ELSE
    v_res := pay_purchase_invoice(it.purchase_root_id, p_amount, p_effective_date, p_payment_method, p_account_id, p_idempotency_key, p_reference);
  END IF;
  PERFORM set_config('app.plan_item_id', '', true);
  RETURN v_res || jsonb_build_object('plan_item_id', it.id);
END $$;
ALTER FUNCTION pay_plan_item(BIGINT, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION pay_plan_item(BIGINT, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION pay_plan_item(BIGINT, NUMERIC, DATE, payment_method, UUID, VARCHAR, TEXT) TO authenticated;

CREATE FUNCTION issue_plan_item_instruments(p_item_id BIGINT, p_instruments JSONB, p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE it payment_plan_item; v_total NUMERIC := 0; v_cur UUID; v_res JSONB; x JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF jsonb_typeof(p_instruments) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_INSTRUMENTS'; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p_instruments) LOOP v_total := v_total + coalesce((x ->> 'amount')::numeric, 0); END LOOP;
  it := payment_plan_item_for_payment(p_item_id, v_total);
  SELECT id INTO v_cur FROM purchases WHERE is_current AND purchase_chain_root(id) = it.purchase_root_id;
  PERFORM set_config('app.plan_item_id', it.id::text, true);
  v_res := issue_purchase_instruments(v_cur, p_instruments, p_idempotency_key, p_reason);   -- refuses a purchase without supplier
  PERFORM set_config('app.plan_item_id', '', true);
  RETURN v_res || jsonb_build_object('plan_item_id', it.id);
END $$;
ALTER FUNCTION issue_plan_item_instruments(BIGINT, JSONB, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION issue_plan_item_instruments(BIGINT, JSONB, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION issue_plan_item_instruments(BIGINT, JSONB, VARCHAR, TEXT) TO authenticated;

-- ── 5. every open due item, once ────────────────────────────────────────────────────────────────────────────────────────
CREATE VIEW fin_payables_due WITH (security_invoker = true) AS
WITH ob AS (   -- the open obligations of the calendar (invoices and pending expenses), own cheques excluded
  SELECT c.purchase_root_id, c.item_kind AS obligation_kind, c.purchase_id, c.supplier_id, c.supplier_name, c.concept, c.document_number,
         c.economic_date, c.amount_total, c.amount AS open_amount, c.due_date, c.planned_date
    FROM fin_payment_calendar c WHERE c.item_kind IN ('FACTURA', 'GASTO')
), planned AS (
  SELECT ob.*, payment_plan_current_version(ob.purchase_root_id) AS ver FROM ob
), items AS (
  SELECT p.purchase_root_id, i.id AS item_id, i.seq, i.due_date AS item_date, i.amount,
         greatest(i.amount - payment_plan_item_covered(i.id), 0) AS item_open,
         count(*) OVER (PARTITION BY i.purchase_root_id) AS n_items, p.open_amount
    FROM planned p JOIN payment_plan_item i ON i.purchase_root_id = p.purchase_root_id AND i.plan_version = p.ver
), trimmed AS (   -- a lower total (rectification) is taken from the last items; never below zero
  SELECT t.*, sum(item_open) OVER (PARTITION BY purchase_root_id) AS items_open,
         coalesce(sum(item_open) OVER (PARTITION BY purchase_root_id ORDER BY seq DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS open_after
    FROM items t
)
SELECT 'ITEM:' || t.item_id AS row_key, CASE WHEN t.n_items > 1 THEN 'CUOTA' ELSE 'PAGO' END AS row_kind,
       p.obligation_kind, t.purchase_root_id, p.purchase_id, t.item_id, t.seq, t.n_items::int AS n_items, t.item_date AS due_date, NULL::date AS planned_date,
       t.amount AS item_amount,
       t.item_open - least(t.item_open, greatest(t.items_open - p.open_amount - t.open_after, 0)) AS amount,
       p.supplier_id, p.supplier_name, p.concept, p.document_number, p.economic_date, p.amount_total,
       NULL::text AS instrument_id, NULL::varchar AS cheque_number, NULL::text AS bank_account_name, NULL::text AS link_status
  FROM trimmed t JOIN planned p ON p.purchase_root_id = t.purchase_root_id
 WHERE t.item_open - least(t.item_open, greatest(t.items_open - p.open_amount - t.open_after, 0)) > 0
UNION ALL   -- a later increase of the total that no item carries yet
SELECT 'DIF:' || p.purchase_root_id, 'DIFERENCIA', p.obligation_kind, p.purchase_root_id, p.purchase_id, NULL, NULL, NULL, NULL, NULL, NULL,
       p.open_amount - x.items_open, p.supplier_id, p.supplier_name, p.concept, p.document_number, p.economic_date, p.amount_total, NULL, NULL, NULL, NULL
  FROM planned p JOIN (SELECT purchase_root_id, sum(item_open) AS items_open FROM items GROUP BY purchase_root_id) x ON x.purchase_root_id = p.purchase_root_id
 WHERE p.open_amount - x.items_open > 0
UNION ALL   -- an obligation without plan: one due item (its estimated payment date, else its due date)
SELECT 'OB:' || p.purchase_root_id, 'PAGO', p.obligation_kind, p.purchase_root_id, p.purchase_id, NULL, 1, 1, p.due_date, p.planned_date, p.open_amount,
       p.open_amount, p.supplier_id, p.supplier_name, p.concept, p.document_number, p.economic_date, p.amount_total, NULL, NULL, NULL, NULL
  FROM planned p WHERE p.ver IS NULL
UNION ALL   -- own cheques / eCheqs still to be debited
SELECT 'INS:' || c.item_id, c.item_kind, NULL, c.purchase_root_id, NULL, NULL, NULL, NULL, c.due_date, NULL, c.amount,
       c.amount, c.supplier_id, c.supplier_name, NULL, c.linked_invoice_number, c.economic_date, c.amount_total, c.item_id, c.document_number, c.bank_account_name, c.link_status
  FROM fin_payment_calendar c WHERE c.item_kind IN ('CHEQUE', 'ECHEQ');
ALTER VIEW fin_payables_due OWNER TO postgres;
REVOKE ALL ON fin_payables_due FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON fin_payables_due TO authenticated;
