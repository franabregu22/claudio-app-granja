-- ============================================================================
-- TARGET V1 — 0123 CARTERA DE CHEQUES: ENDOSO CONTRA UN VENCIMIENTO (owner GO 2026-11-13, caja-mejoras-v2; design approved on the prototype)
--
-- Nothing moves money: an endorsement never did (endorse_cheque, 0016: the supplier ledger −amount, no posting). No existing row changes;
-- nothing is backfilled. Client cheques keep entering through receive_cheque (now also from Cuentas corrientes → Registrar cobro) and
-- leave the wallet by deposit / credit (deposit_cheque, clear_cheque) or endorsement.
--   1. endorse_cheque_to_payable (ADMIN, idempotent, audited ENDORSE_TO_PAYABLE): endorses a client cheque in portfolio to the supplier of
--      ONE invoice, in one transaction — endorse_cheque (unchanged) + its allocation to that invoice (purchase_payment_allocation, by
--      financial_instrument_id) for what the invoice (or the chosen plan item, 0121) still has open; what exceeds it stays as the
--      supplier's credit (the ledger already took the whole cheque). A pending expense without supplier cannot take a cheque.
--   2. An endorsed cheque allocated to an invoice now counts as PAID wherever an allocation counts (same columns, same order):
--      purchase_allocated_amount, fin_purchase_payment_status (inside "debited": the invoice is settled by it) and
--      payment_plan_item_covered. A cheque rejected after the endorsement (reject_cheque) stops counting: the debt is open again.
-- SECURITY DEFINER set +1.
-- ============================================================================

-- ── 2. an endorsed cheque counts as paid ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION purchase_allocated_amount(p_root UUID) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(sum(a.amount), 0) FROM purchase_payment_allocation a LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id
   WHERE a.purchase_root_id = p_root AND (a.financial_operation_id IS NOT NULL OR i.estado IN ('ISSUED', 'DEBITED', 'ENDORSED'));
$$;

CREATE OR REPLACE FUNCTION payment_plan_item_covered(p_item BIGINT) RETURNS NUMERIC LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(sum(l.amount), 0) FROM payment_plan_item_link l LEFT JOIN financial_instrument i ON i.id = l.financial_instrument_id
   WHERE l.item_id = p_item AND (l.financial_operation_id IS NOT NULL OR i.estado::text IN ('ISSUED', 'DEBITED', 'ENDORSED'))
$$;

CREATE OR REPLACE VIEW fin_purchase_payment_status WITH (security_invoker = true) AS
  WITH cur AS (SELECT p.*, purchase_chain_root(p.id) AS root FROM purchases p WHERE p.is_current AND p.supplier_id IS NOT NULL),
  al AS (SELECT a.purchase_root_id,
                coalesce(sum(a.amount) FILTER (WHERE i.estado = 'ISSUED'), 0) AS scheduled,
                coalesce(sum(a.amount) FILTER (WHERE i.estado IN ('DEBITED', 'ENDORSED')), 0) AS debited,   -- 0123: an endorsed client cheque settles it
                coalesce(sum(a.amount) FILTER (WHERE a.financial_operation_id IS NOT NULL), 0) AS other_payments,
                count(*) FILTER (WHERE i.estado IN ('REJECTED', 'CANCELLED')) AS voided_instruments
           FROM purchase_payment_allocation a LEFT JOIN financial_instrument i ON i.id = a.financial_instrument_id GROUP BY a.purchase_root_id)
  SELECT cur.id AS purchase_id, cur.root AS purchase_root_id, cur.supplier_id, s.nombre AS supplier_name, cur.supplier_invoice_number,
         cur.fiscal_document_id, cur.economic_date, cur.amount_total,
         coalesce(al.scheduled, 0) AS scheduled, coalesce(al.debited, 0) AS debited, coalesce(al.other_payments, 0) AS other_payments,
         cur.amount_total - coalesce(al.scheduled, 0) - coalesce(al.debited, 0) - coalesce(al.other_payments, 0) AS pending,
         coalesce(al.voided_instruments, 0) AS voided_instruments,
         payment_date_current(cur.root, 'DUE') AS due_date, payment_date_current(cur.root, 'PLANNED') AS planned_date
    FROM cur JOIN suppliers s ON s.id = cur.supplier_id LEFT JOIN al ON al.purchase_root_id = cur.root;

-- ── 1. endorse a client cheque against ONE invoice (or ONE of its plan items) ─────────────────────────────────────────────
CREATE FUNCTION endorse_cheque_to_payable(p_instrument_id UUID, p_purchase_id UUID, p_item_id BIGINT, p_endorsed_date DATE,
  p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_inst   financial_instrument%ROWTYPE;
  v_cur    purchases%ROWTYPE;
  v_root   UUID;
  v_open   NUMERIC;
  v_item   payment_plan_item;
  v_alloc  NUMERIC;
  v_prev   purchase_payment_allocation%ROWTYPE;
  v_rsn    TEXT := nullif(btrim(p_reason), '');
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) = 0 OR length(p_idempotency_key) > 100 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('endorse_cheque_to_payable:' || p_idempotency_key, 0));
  SELECT * INTO v_prev FROM purchase_payment_allocation WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('replayed', true, 'instrument_id', v_prev.financial_instrument_id, 'purchase_root_id', v_prev.purchase_root_id, 'allocated', v_prev.amount);
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND'; END IF;
  IF v_inst.direction <> 'RECEIVED' OR v_inst.estado <> 'RECEIVED' THEN RAISE EXCEPTION 'INVALID_STATE: only a client cheque in portfolio can be endorsed, found %', v_inst.estado; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  v_root := purchase_chain_root(p_purchase_id);
  SELECT * INTO v_cur FROM purchases WHERE is_current AND purchase_chain_root(id) = v_root FOR UPDATE;
  IF v_cur.supplier_id IS NULL THEN RAISE EXCEPTION 'SUPPLIER_REQUIRED: a cheque is endorsed to a registered supplier''s invoice'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payment_plan:' || v_root::text, 0));
  v_open := v_cur.amount_total - purchase_allocated_amount(v_root);
  IF p_item_id IS NOT NULL THEN
    SELECT * INTO v_item FROM payment_plan_item WHERE id = p_item_id AND purchase_root_id = v_root;
    IF NOT FOUND OR v_item.plan_version <> payment_plan_current_version(v_root) THEN RAISE EXCEPTION 'PLAN_ITEM_NOT_CURRENT'; END IF;
    v_open := least(v_open, v_item.amount - payment_plan_item_covered(v_item.id));
  END IF;
  IF v_open <= 0 THEN RAISE EXCEPTION 'NOTHING_OPEN: the invoice (or the item) has nothing left to pay'; END IF;
  v_alloc := least(v_inst.amount, v_open);

  PERFORM endorse_cheque(p_instrument_id, v_cur.supplier_id, p_endorsed_date, coalesce(v_rsn, 'Endosado a ' || coalesce(v_cur.supplier_invoice_number, 'factura')));
  PERFORM set_config('app.plan_item_id', coalesce(p_item_id::text, ''), true);
  INSERT INTO purchase_payment_allocation (purchase_root_id, financial_instrument_id, amount, idempotency_key, reason, created_by)
  VALUES (v_root, p_instrument_id, v_alloc, p_idempotency_key, v_rsn, v_uid);
  PERFORM set_config('app.plan_item_id', '', true);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('purchases', v_root::text, 'ENDORSE_TO_PAYABLE',
          jsonb_build_object('instrument', p_instrument_id, 'cheque_number', v_inst.cheque_number, 'cheque_amount', v_inst.amount, 'allocated', v_alloc,
                             'supplier_credit', v_inst.amount - v_alloc, 'plan_item', p_item_id, 'date', p_endorsed_date), v_rsn, v_uid);
  RETURN jsonb_build_object('replayed', false, 'instrument_id', p_instrument_id, 'purchase_root_id', v_root, 'allocated', v_alloc,
                            'supplier_credit', v_inst.amount - v_alloc);
END $$;
ALTER FUNCTION endorse_cheque_to_payable(UUID, UUID, BIGINT, DATE, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION endorse_cheque_to_payable(UUID, UUID, BIGINT, DATE, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION endorse_cheque_to_payable(UUID, UUID, BIGINT, DATE, VARCHAR, TEXT) TO authenticated;
