-- ============================================================================
-- TARGET V1 — 0088 MERCADO PAGO: CLASSIFY OUTFLOWS AND INFLOWS (owner GO 2026-10-15, META A)
--
-- Movements that cannot be classified automatically become operational from the UI, ALWAYS through the ERP's existing
-- routes (no parallel ledger) and ALWAYS resolved server-side from a minimal identifier (amount, date, movement and the
-- Mercado Pago account are never taken from the client).
--
-- OUTFLOWS — a payout (report movement 'transfer' / PAYOUT, report-only) whose destination is NO_OWN_ACCOUNT_MATCH (0084):
--   mp_classify_payout_outflow(p_source_id, p_classification, p_supplier_id, p_expense_category_id, p_nature, p_reason)
--     SUPPLIER_PAYMENT  → pay_supplier(supplier, |net|, payout date, MERCADOPAGO, MP, 'MP-OUTFLOW:<id>'):
--                         SUPPLIER_PAYMENT operation (MP −amount) + supplier_ledger PAYMENT. No P&L line (P&L is accrual:
--                         the purchase carries the cost).
--     EXPENSE           → register_purchase(supplier, payout date, |net|, category, nature, no lines, no attachment —
--                         ADR-010; the MP evidence is linked by this classification) + pay_supplier as above.
--                         P&L: the purchase, by category / nature, at the payout date.
--     OWNER_WITHDRAWAL  → register_management_event(RETIRO, payout date, |net|, 'MP-OUTFLOW:<id>', MP):
--                         OWNER_WITHDRAWAL operation (MP −amount); P&L "Retiros".
--   The payout movement is reconciled to the operation (assigned net). Own-account payouts keep their own flow (0087):
--   OWN_ACCOUNT_EXACT, DESTINATION_CONFLICT and an unknown destination are refused here. "Otra salida": not offered
--   (owner decision 15/10: deferred).
-- INFLOWS — an approved account_fund + debin_transfer payment left unapplied by 0086 (CLASSIFY_INFLOW):
--   own account     → mp_reclassify_inbound_own_transfer (0086, unchanged): one TRANSFER own account → MP.
--   client receipt  → mp_classify_inflow_as_collection(p_payment_id, p_client_id): the SAME application plan A1 uses
--                     (MP_SETTLEMENT gross + FEE + tax ADJUSTMENT, keys MPA:<t>:…), then, when a client is given,
--                     mp_allocate_to_client (client_ledger COLLECTION). No P&L line beyond the MP fee already reported.
--   "Otro ingreso": not offered (deferred). account_fund + cvu is unchanged (still auto-applied as a collection).
--
-- Every action is idempotent: a repeated call with the same choice writes nothing (replayed = true); a different
-- choice on a classified movement is refused (ALREADY_CLASSIFIED). The MP evidence is never modified.
--   1. mp_outflow_classification / mp_inflow_classification — immutable link rows (ADMIN SELECT only).
--   2. the two RPCs above (SECURITY DEFINER, ADMIN, EXECUTE authenticated only).
--   3. fin_mp_report_activity: a classified payout → CLASSIFIED_OUTFLOW; appended columns classification /
--      classification_detail (supplier or category name).
-- SECURITY DEFINER set 81 → 83.
-- ============================================================================

CREATE TABLE mp_outflow_classification (
  id                         BIGSERIAL PRIMARY KEY,
  source_id                  VARCHAR(40) NOT NULL UNIQUE,
  mp_financial_movement_id   BIGINT      NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  classification             VARCHAR(20) NOT NULL,
  supplier_id                UUID        REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_category_id        UUID        REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id                UUID        REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  management_event_id        UUID        REFERENCES management_event(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id     BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_run_id         UUID,
  destination_row_number     INTEGER,
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason                     TEXT,
  created_by                 UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_moc_classification CHECK (classification IN ('SUPPLIER_PAYMENT', 'EXPENSE', 'OWNER_WITHDRAWAL')),
  CONSTRAINT chk_moc_shape CHECK (
       (classification = 'SUPPLIER_PAYMENT' AND supplier_id IS NOT NULL AND purchase_id IS NULL AND management_event_id IS NULL)
    OR (classification = 'EXPENSE' AND supplier_id IS NOT NULL AND expense_category_id IS NOT NULL AND purchase_id IS NOT NULL AND management_event_id IS NULL)
    OR (classification = 'OWNER_WITHDRAWAL' AND supplier_id IS NULL AND purchase_id IS NULL AND management_event_id IS NOT NULL)),
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

CREATE TABLE mp_inflow_classification (
  id                         BIGSERIAL PRIMARY KEY,
  payment_id                 VARCHAR(30) NOT NULL UNIQUE,
  mp_financial_movement_id   BIGINT      NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  classification             VARCHAR(20) NOT NULL CHECK (classification IN ('COLLECTION')),
  cliente_id                 UUID        REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  client_allocation_id       UUID        REFERENCES mp_client_allocation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  settlement_operation_id    BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_by                 UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mic_client CHECK ((cliente_id IS NULL) = (client_allocation_id IS NULL))
);
ALTER TABLE mp_inflow_classification ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_mp_inflow_classification_immutable
  BEFORE UPDATE OR DELETE ON mp_inflow_classification
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE mp_inflow_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_inflow_classification TO authenticated;
REVOKE ALL ON SEQUENCE mp_inflow_classification_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY mp_inflow_classification_admin_select ON mp_inflow_classification
  FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── outflows ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_classify_payout_outflow(
  p_source_id           TEXT,
  p_classification      TEXT,
  p_supplier_id         UUID DEFAULT NULL,
  p_expense_category_id UUID DEFAULT NULL,
  p_nature              purchase_nature DEFAULT NULL,
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
  v_mp       UUID;
  v_mv       mp_financial_movement%ROWTYPE;
  v_match    RECORD;
  v_dest     RECORD;
  v_amt      NUMERIC(15,2);
  v_ref      TEXT;
  v_reason   TEXT;
  v_res      JSONB;
  v_op       BIGINT;
  v_purchase UUID;
  v_event    UUID;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_source_id IS NULL OR p_source_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID';
  END IF;
  IF p_classification IS NULL OR p_classification NOT IN ('SUPPLIER_PAYMENT', 'EXPENSE', 'OWNER_WITHDRAWAL') THEN
    RAISE EXCEPTION 'INVALID_CLASSIFICATION: SUPPLIER_PAYMENT, EXPENSE or OWNER_WITHDRAWAL';
  END IF;
  IF p_classification IN ('SUPPLIER_PAYMENT', 'EXPENSE') THEN
    IF p_supplier_id IS NULL OR NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id AND activo) THEN
      RAISE EXCEPTION 'SUPPLIER_REQUIRED: an active supplier is required';
    END IF;
  ELSIF p_supplier_id IS NOT NULL THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_ALLOWED: an owner withdrawal has no supplier';
  END IF;
  IF p_classification = 'EXPENSE' THEN
    IF p_expense_category_id IS NULL OR NOT EXISTS (SELECT 1 FROM expense_category WHERE id = p_expense_category_id AND activo) THEN
      RAISE EXCEPTION 'CATEGORY_REQUIRED: an active expense category is required';
    END IF;
  ELSIF p_expense_category_id IS NOT NULL OR p_nature IS NOT NULL THEN
    RAISE EXCEPTION 'CATEGORY_NOT_ALLOWED: only an expense carries a category / nature';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_payout_outflow:' || p_source_id, 0));

  -- idempotent: the same choice again writes nothing; another choice is refused
  SELECT * INTO v_row FROM mp_outflow_classification WHERE source_id = p_source_id;
  IF FOUND THEN
    IF v_row.classification = p_classification AND v_row.supplier_id IS NOT DISTINCT FROM p_supplier_id
       AND (p_classification <> 'EXPENSE' OR v_row.expense_category_id IS NOT DISTINCT FROM p_expense_category_id) THEN
      RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', true, 'classification', v_row.classification,
        'financial_operation_id', v_row.financial_operation_id, 'purchase_id', v_row.purchase_id, 'amount', v_row.amount);
    END IF;
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: payout % is already classified as %', p_source_id, v_row.classification;
  END IF;

  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  SELECT m.* INTO v_mv FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
   WHERE t.resource_type = 'report' AND t.resource_id = p_source_id || ':payout:D' AND t.transition = 'PAYOUT' AND t.transition_ref = ''
   FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_NOT_FOUND: no payout movement for %', p_source_id;
  END IF;
  IF v_mv.movement_kind <> 'transfer' OR v_mv.net_amount >= 0 THEN
    RAISE EXCEPTION 'NOT_A_PAYOUT';
  END IF;
  IF EXISTS (SELECT 1 FROM mp_reconciliation WHERE mp_financial_movement_id = v_mv.id) THEN
    RAISE EXCEPTION 'PAYOUT_ALREADY_APPLIED: the payout movement already has a financial operation';
  END IF;

  -- only an outflow to a non-own destination; own accounts use mp_confirm_payout_transfer (0087)
  SELECT * INTO v_match FROM fin_mp_payout_matches(v_mp) pm WHERE pm.source_id = p_source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DESTINATION_UNKNOWN: no stored destination for payout %', p_source_id;
  END IF;
  IF v_match.match_status = 'OWN_ACCOUNT_EXACT' THEN
    RAISE EXCEPTION 'OWN_ACCOUNT_PAYOUT: payout % goes to an own account — confirm it as a transfer', p_source_id;
  END IF;
  IF v_match.match_status IS DISTINCT FROM 'NO_OWN_ACCOUNT_MATCH' THEN
    RAISE EXCEPTION 'DESTINATION_REVIEW_REQUIRED: payout % is %', p_source_id, v_match.match_status;
  END IF;

  SELECT d.run_id, d.row_number INTO v_dest
    FROM fin_mp_payout_destination d JOIN fin_import_run r ON r.id = d.run_id
   WHERE d.source_id = p_source_id AND d.description = 'payout' AND r.source_kind = 'MP_RELEASE_REPORT' AND r.financial_account_id = v_mp
   ORDER BY d.created_at, d.run_id, d.row_number LIMIT 1;

  v_amt := -v_mv.net_amount;
  v_ref := 'MP-OUTFLOW:' || p_source_id;
  v_reason := coalesce(nullif(btrim(p_reason), ''),
    CASE p_classification WHEN 'SUPPLIER_PAYMENT' THEN 'Pago a proveedor por Mercado Pago (retiro ' || p_source_id || ')'
                          WHEN 'EXPENSE' THEN 'Gasto pagado por Mercado Pago (retiro ' || p_source_id || ')'
                          ELSE 'Retiro de socios por Mercado Pago (retiro ' || p_source_id || ')' END);

  IF p_classification = 'OWNER_WITHDRAWAL' THEN
    v_res := register_management_event('RETIRO', v_mv.occurred_date, v_amt, v_ref, v_reason, v_mp, NULL);
    v_event := (v_res ->> 'management_event_id')::UUID;
    v_op := (v_res ->> 'financial_operation_id')::BIGINT;
  ELSE
    IF p_classification = 'EXPENSE' THEN
      v_res := register_purchase(p_supplier_id, v_mv.occurred_date, v_amt, v_amt, p_expense_category_id, NULL,
                                 coalesce(p_nature, 'OPERATING'), '[]'::jsonb, '[]'::jsonb, 'MP-OUTFLOW-PURCHASE:' || p_source_id,
                                 NULL, NULL, NULL, NULL, v_reason);
      v_purchase := (v_res ->> 'purchase_id')::UUID;
    END IF;
    v_res := pay_supplier(p_supplier_id, v_amt, v_mv.occurred_date, 'MERCADOPAGO', v_mp, v_ref, v_reason);
    v_op := (v_res ->> 'financial_operation_id')::BIGINT;
  END IF;

  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_mv.id, v_op, v_mp, v_mv.net_amount, v_ref, NOW(), v_uid);

  INSERT INTO mp_outflow_classification (source_id, mp_financial_movement_id, classification, supplier_id, expense_category_id, purchase_id,
         management_event_id, financial_operation_id, destination_run_id, destination_row_number, amount, reason, created_by)
  VALUES (p_source_id, v_mv.id, p_classification, p_supplier_id, CASE WHEN p_classification = 'EXPENSE' THEN p_expense_category_id END,
          v_purchase, v_event, v_op, v_dest.run_id, v_dest.row_number, v_amt, v_reason, v_uid)
  RETURNING * INTO v_row;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_outflow_classification', v_row.id::TEXT, 'CLASSIFY_MP_OUTFLOW',
          jsonb_build_object('source_id', p_source_id, 'classification', p_classification, 'amount', v_amt, 'supplier_id', p_supplier_id,
                             'purchase_id', v_purchase, 'management_event_id', v_event, 'financial_operation', v_op), v_reason, v_uid);
  RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', false, 'classification', p_classification,
    'financial_operation_id', v_op, 'purchase_id', v_purchase, 'amount', v_amt);
END;
$$;
ALTER FUNCTION mp_classify_payout_outflow(TEXT, TEXT, UUID, UUID, purchase_nature, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_classify_payout_outflow(TEXT, TEXT, UUID, UUID, purchase_nature, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_classify_payout_outflow(TEXT, TEXT, UUID, UUID, purchase_nature, TEXT) TO authenticated;

-- ── inflows: client receipt ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_classify_inflow_as_collection(p_payment_id TEXT, p_client_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_row     mp_inflow_classification%ROWTYPE;
  v_mp      UUID;
  v_tid     BIGINT;
  v_mvid    BIGINT;
  v_mv      mp_financial_movement%ROWTYPE;
  v_src     mp_source_record%ROWTYPE;
  v_c       RECORD;
  v_op      BIGINT;
  v_settle  BIGINT;
  v_alloc   UUID;
  v_res     JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_payment_id IS NULL OR p_payment_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_inbound_reclassification:' || p_payment_id, 0));   -- same lock as 0086

  SELECT * INTO v_row FROM mp_inflow_classification WHERE payment_id = p_payment_id;
  IF FOUND THEN
    IF v_row.cliente_id IS NOT DISTINCT FROM p_client_id THEN
      RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', true, 'settlement_operation_id', v_row.settlement_operation_id,
        'client_allocation_id', v_row.client_allocation_id, 'amount', v_row.amount);
    END IF;
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: payment % is already classified as a collection', p_payment_id;
  END IF;
  IF EXISTS (SELECT 1 FROM mp_inbound_reclassification WHERE payment_id = p_payment_id) THEN
    RAISE EXCEPTION 'ALREADY_CLASSIFIED: payment % is an own-account transfer', p_payment_id;
  END IF;

  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;
  SELECT t.id, t.mp_financial_movement_id INTO v_tid, v_mvid FROM mp_transition_identity t
   WHERE t.resource_type = 'payment' AND t.resource_id = p_payment_id AND t.transition = 'APPROVAL' AND t.transition_ref = '';
  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: no approved inbound payment %', p_payment_id;
  END IF;
  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = v_mvid FOR UPDATE;
  IF v_mv.movement_kind <> 'payment' OR NOT (v_mv.gross_amount > 0 AND v_mv.fee_amount <= 0 AND v_mv.tax_amount <= 0 AND v_mv.net_amount > 0
       AND v_mv.gross_amount + v_mv.fee_amount + v_mv.tax_amount = v_mv.net_amount) THEN
    RAISE EXCEPTION 'NOT_AN_INBOUND_PAYMENT';
  END IF;
  SELECT * INTO v_src FROM mp_source_record WHERE id = v_mv.mp_source_record_id FOR UPDATE;
  IF v_src.event_data ->> 'operation_type' IS DISTINCT FROM 'account_fund' OR v_src.event_data ->> 'payment_method_id' IS DISTINCT FROM 'debin_transfer' THEN
    RAISE EXCEPTION 'NOT_A_CLASSIFIABLE_INFLOW: only an account_fund + debin_transfer inflow waits for classification';
  END IF;
  IF v_src.processing_status IN ('ERROR', 'IGNORED') THEN
    RAISE EXCEPTION 'SOURCE_NOT_APPLICABLE: source is %', v_src.processing_status;
  END IF;
  IF EXISTS (SELECT 1 FROM mp_reconciliation WHERE mp_financial_movement_id = v_mv.id) THEN
    RAISE EXCEPTION 'ALREADY_APPLIED: the payment already has a financial operation';
  END IF;
  IF p_client_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM clients WHERE id = p_client_id AND activo) THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  PERFORM assert_period_open(v_mv.occurred_date);

  -- the A1 application plan (0051), with the same keys: MP_SETTLEMENT gross, FEE, tax ADJUSTMENT
  FOR v_c IN SELECT * FROM (VALUES (1, format('MPA:%s:SETTLE', v_tid), 'MP_SETTLEMENT'::financial_operation_type, v_mv.gross_amount),
                                   (2, format('MPA:%s:FEE', v_tid), 'FEE'::financial_operation_type, v_mv.fee_amount),
                                   (3, format('MPA:%s:TAX', v_tid), 'ADJUSTMENT'::financial_operation_type, v_mv.tax_amount)) p(n, k, typ, amount)
              WHERE amount <> 0 ORDER BY n LOOP
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES (v_c.typ, v_mv.occurred_date, 'MP:' || v_c.k, 'mp_financial_movement', v_mv.id::TEXT, 'Ingreso DEBIN clasificado como cobro', v_uid)
    RETURNING id INTO v_op;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_op, v_mp, v_c.amount, v_mv.occurred_date, v_uid);
    INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_by)
    VALUES (v_mv.id, v_op, v_mp, v_c.amount, v_c.k, v_uid);
    IF v_c.n = 1 THEN v_settle := v_op; END IF;
  END LOOP;
  UPDATE mp_source_record SET processing_status = 'RECONCILED', processed_at = NOW()
   WHERE id = v_mv.mp_source_record_id AND processing_status <> 'RECONCILED'
     AND NOT EXISTS (SELECT 1 FROM mp_financial_movement m WHERE m.mp_source_record_id = v_mv.mp_source_record_id
                      AND m.net_amount <> coalesce((SELECT sum(r.assigned_amount) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), 0));

  IF p_client_id IS NOT NULL THEN
    v_res := mp_allocate_to_client(v_mv.id, p_client_id, v_mv.gross_amount, v_mv.occurred_date, 'MP-INFLOW-CLIENT:' || p_payment_id,
                                   'Ingreso DEBIN clasificado como cobro de cliente (pago ' || p_payment_id || ')');
    v_alloc := (v_res ->> 'allocation_id')::UUID;
  END IF;

  INSERT INTO mp_inflow_classification (payment_id, mp_financial_movement_id, classification, cliente_id, client_allocation_id,
         settlement_operation_id, amount, created_by)
  VALUES (p_payment_id, v_mv.id, 'COLLECTION', p_client_id, v_alloc, v_settle, v_mv.net_amount, v_uid)
  RETURNING * INTO v_row;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_inflow_classification', v_row.id::TEXT, 'CLASSIFY_MP_INFLOW',
          jsonb_build_object('payment_id', p_payment_id, 'classification', 'COLLECTION', 'gross', v_mv.gross_amount, 'net', v_mv.net_amount,
                             'cliente_id', p_client_id, 'client_allocation_id', v_alloc, 'settlement_operation', v_settle),
          'Ingreso DEBIN clasificado como cobro', v_uid);
  RETURN jsonb_build_object('classification_id', v_row.id, 'replayed', false, 'settlement_operation_id', v_settle,
    'client_allocation_id', v_alloc, 'amount', v_mv.net_amount);
END;
$$;
ALTER FUNCTION mp_classify_inflow_as_collection(TEXT, UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_classify_inflow_as_collection(TEXT, UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_classify_inflow_as_collection(TEXT, UUID) TO authenticated;

-- ── activity view: classified payouts ───────────────────────────────────────
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
         CASE WHEN oc.classification = 'EXPENSE' THEN ec.nombre || ' · ' || sp.nombre ELSE sp.nombre END::TEXT AS outflow_detail
    FROM s LEFT JOIN mp_inbound_reclassification ir ON ir.payment_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payment'
           LEFT JOIN mp_payout_transfer_confirmation pc ON pc.source_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payout'
           LEFT JOIN mp_outflow_classification oc ON oc.source_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payout'
           LEFT JOIN suppliers sp ON sp.id = oc.supplier_id
           LEFT JOIN expense_category ec ON ec.id = oc.expense_category_id
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
            OR (x.raw_row ->> 'DESCRIPTION' IN ('asset_management', 'payout') AND t.resource_type = 'report'
                AND t.resource_id = x.external_id)) AS financial_operation_id,
       (SELECT fa.nombre::TEXT FROM financial_account fa WHERE fa.id = x.own_account_id) AS counterpart_account_name,
       x.outflow_classification::TEXT AS classification,
       x.outflow_detail AS classification_detail
  FROM x
 WHERE (SELECT current_app_role()) = 'ADMIN';
