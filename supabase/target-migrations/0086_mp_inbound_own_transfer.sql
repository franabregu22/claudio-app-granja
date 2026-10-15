-- ============================================================================
-- TARGET V1 — 0086 MERCADO PAGO INBOUND OWN-ACCOUNT TRANSFERS (owner GO 2026-10-15)
--
-- Money the owner moves from an own bank account into Mercado Pago (MP "Ingresar dinero": operation_type account_fund,
-- here by DEBIN) is not a collection. Until now every approved inbound payment was auto-applied as MP_SETTLEMENT and
-- listed as "Cobro". This migration adds an explicit, append-only reclassification and stops the automatic collection for
-- the case the owner identified (account_fund + debin_transfer). account_fund by CVU keeps its current behaviour.
--
--   1. mp_inbound_reclassification — one immutable row per reclassified payment: the movement, the original settlement
--      operation (if it had been applied), the reversal operation, the TRANSFER operation, the source own account.
--   2. mp_reclassify_inbound_own_transfer(p_payment_id, p_from_account_id, p_reason) — SECURITY DEFINER, ADMIN only,
--      idempotent (a second call returns the existing row). Preconditions: the payment's APPROVAL movement exists, its
--      snapshot is account_fund, it has no client allocation, the source is an active own bank account. Effects:
--        applied as MP_SETTLEMENT (only that operation, no fee / tax) →
--          a) MP_SETTLEMENT reversal: MP −net, external_ref 'MP-INBOUND-RECLASS:<id>' (explicit; never a generic ADJUSTMENT)
--          b) TRANSFER own account → MP (transfer_between_accounts): source −net, MP +net, 'MP-INBOUND-TRANSFER:<id>'
--          the movement keeps its original reconciliation and is also reconciled to a) (−net) and b) (+net)
--        not applied yet (the new rule below) → only b), and the movement is reconciled to it (+net)
--      Result: MP balance unchanged by the reclassification, the source account −net, no P&L line (P&L does not read
--      financial operations; these payments carry no fee). The bank line can later be matched to b)'s source posting.
--   3. trigger: a reclassified movement can never be allocated to a client.
--   4. mp_is_auto_applicable: a payment whose snapshot is account_fund + debin_transfer is no longer auto-applied — it
--      stays NORMALIZED for classification (own transfer through 2., or a collection through mp_reconcile_movement).
--   5. fin_mp_report_activity: coverage OWN_TRANSFER (reclassified) and CLASSIFY_INFLOW (account_fund + DEBIN waiting),
--      plus the column counterpart_account_name (appended).
-- SECURITY DEFINER set 79 → 80 (the trigger function is INVOKER, owner-only).
-- ============================================================================

CREATE TABLE mp_inbound_reclassification (
  id                         BIGSERIAL PRIMARY KEY,
  payment_id                 VARCHAR(30) NOT NULL UNIQUE,
  mp_financial_movement_id   BIGINT      NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  settlement_operation_id    BIGINT      REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reversal_operation_id      BIGINT      UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  transfer_operation_id      BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source_account_id          UUID        NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reason                     TEXT,
  created_by                 UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mir_reversal CHECK ((settlement_operation_id IS NULL) = (reversal_operation_id IS NULL))
);
ALTER TABLE mp_inbound_reclassification ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_mp_inbound_reclassification_immutable
  BEFORE UPDATE OR DELETE ON mp_inbound_reclassification
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE mp_inbound_reclassification FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_inbound_reclassification TO authenticated;
REVOKE ALL ON SEQUENCE mp_inbound_reclassification_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY mp_inbound_reclassification_admin_select ON mp_inbound_reclassification
  FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE OR REPLACE FUNCTION mp_reclassify_inbound_own_transfer(p_payment_id TEXT, p_from_account_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_mp      UUID;
  v_row     mp_inbound_reclassification%ROWTYPE;
  v_mv      mp_financial_movement%ROWTYPE;
  v_src     mp_source_record%ROWTYPE;
  v_settle  BIGINT;
  v_others  INTEGER;
  v_rev     BIGINT;
  v_trf     BIGINT;
  v_res     JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_payment_id IS NULL OR p_payment_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_ID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_inbound_reclassification:' || p_payment_id, 0));

  -- idempotent: the same payment is reclassified once
  SELECT * INTO v_row FROM mp_inbound_reclassification WHERE payment_id = p_payment_id;
  IF FOUND THEN
    IF v_row.source_account_id IS DISTINCT FROM p_from_account_id THEN
      RAISE EXCEPTION 'ALREADY_RECLASSIFIED_FROM_ANOTHER_ACCOUNT';
    END IF;
    RETURN jsonb_build_object('reclassification_id', v_row.id, 'replayed', true, 'transfer_operation_id', v_row.transfer_operation_id,
      'reversal_operation_id', v_row.reversal_operation_id, 'amount', v_row.amount);
  END IF;

  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_from_account_id AND activo AND account_type = 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'SOURCE_ACCOUNT_INVALID: an active own bank account is required';
  END IF;

  SELECT m.* INTO v_mv FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
   WHERE t.resource_type = 'payment' AND t.resource_id = p_payment_id AND t.transition = 'APPROVAL' AND t.transition_ref = ''
   FOR UPDATE OF m;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND: no approved inbound payment %', p_payment_id;
  END IF;
  IF v_mv.movement_kind <> 'payment' OR v_mv.net_amount <= 0 THEN
    RAISE EXCEPTION 'NOT_AN_INBOUND_PAYMENT';
  END IF;
  SELECT * INTO v_src FROM mp_source_record WHERE id = v_mv.mp_source_record_id;
  IF v_src.event_data ->> 'operation_type' IS DISTINCT FROM 'account_fund' THEN
    RAISE EXCEPTION 'NOT_ACCOUNT_FUND: only an account_fund inflow can be an own-account transfer';
  END IF;
  IF EXISTS (SELECT 1 FROM mp_client_allocation WHERE mp_financial_movement_id = v_mv.id) THEN
    RAISE EXCEPTION 'CLIENT_ALLOCATION_EXISTS: reverse the client allocation first';
  END IF;

  -- the current application: nothing, or exactly the A1 MP_SETTLEMENT of the full net (no fee / tax operation)
  SELECT count(*) FILTER (WHERE o.operation_type <> 'MP_SETTLEMENT' OR r.assigned_amount <> v_mv.net_amount),
         min(o.id) FILTER (WHERE o.operation_type = 'MP_SETTLEMENT' AND r.assigned_amount = v_mv.net_amount)
    INTO v_others, v_settle
    FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
   WHERE r.mp_financial_movement_id = v_mv.id;
  IF v_others > 0 THEN
    RAISE EXCEPTION 'UNSUPPORTED_APPLICATION: the movement carries other operations (fee / tax / partial)';
  END IF;

  PERFORM assert_period_open(v_mv.occurred_date);
  IF v_settle IS NOT NULL THEN
    -- explicit reversal of the original settlement (same type, opposite sign, own idempotency key)
    INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
    VALUES ('MP_SETTLEMENT', v_mv.occurred_date, 'MP-INBOUND-RECLASS:' || p_payment_id, 'mp_inbound_reclassification', p_payment_id,
            coalesce(p_reason, 'Reclasificación: transferencia desde cuenta propia, no es cobro'), v_uid)
    RETURNING id INTO v_rev;
    INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
    VALUES (v_rev, v_mp, -v_mv.net_amount, v_mv.occurred_date, v_uid);
    INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
    VALUES (v_mv.id, v_rev, v_mp, -v_mv.net_amount, 'MP-INBOUND-RECLASS:' || p_payment_id, NOW(), v_uid);
  END IF;

  v_res := transfer_between_accounts(p_from_account_id, v_mp, v_mv.net_amount, v_mv.occurred_date, 'MP-INBOUND-TRANSFER:' || p_payment_id,
             coalesce(p_reason, 'Transferencia desde cuenta propia a Mercado Pago (pago MP ' || p_payment_id || ')'));
  v_trf := (v_res ->> 'financial_operation_id')::BIGINT;
  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_mv.id, v_trf, v_mp, v_mv.net_amount, 'MP-INBOUND-TRANSFER:' || p_payment_id, NOW(), v_uid);

  INSERT INTO mp_inbound_reclassification (payment_id, mp_financial_movement_id, settlement_operation_id, reversal_operation_id,
         transfer_operation_id, source_account_id, amount, reason, created_by)
  VALUES (p_payment_id, v_mv.id, v_settle, v_rev, v_trf, p_from_account_id, v_mv.net_amount, p_reason, v_uid)
  RETURNING * INTO v_row;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_inbound_reclassification', v_row.id::TEXT, 'RECLASSIFY',
          jsonb_build_object('payment_id', p_payment_id, 'amount', v_mv.net_amount, 'source_account', p_from_account_id,
                             'settlement_operation', v_settle, 'reversal_operation', v_rev, 'transfer_operation', v_trf), p_reason, v_uid);
  RETURN jsonb_build_object('reclassification_id', v_row.id, 'replayed', false, 'transfer_operation_id', v_trf,
    'reversal_operation_id', v_rev, 'amount', v_mv.net_amount);
END;
$$;
ALTER FUNCTION mp_reclassify_inbound_own_transfer(TEXT, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_reclassify_inbound_own_transfer(TEXT, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_reclassify_inbound_own_transfer(TEXT, UUID, TEXT) TO authenticated;

-- a reclassified own transfer is never a client receipt
CREATE OR REPLACE FUNCTION mp_own_transfer_allocation_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mp_inbound_reclassification WHERE mp_financial_movement_id = NEW.mp_financial_movement_id) THEN
    RAISE EXCEPTION 'OWN_TRANSFER_NOT_ALLOCATABLE: movement % is an own-account transfer', NEW.mp_financial_movement_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION mp_own_transfer_allocation_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_own_transfer_allocation_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_mp_client_allocation_own_transfer
  BEFORE INSERT ON mp_client_allocation
  FOR EACH ROW EXECUTE FUNCTION mp_own_transfer_allocation_guard();

-- account_fund + DEBIN (money pulled from the holder's own bank account) is no longer applied as a collection
CREATE OR REPLACE FUNCTION mp_is_auto_applicable(p_movement_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM mp_financial_movement m
      JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
     WHERE m.id = p_movement_id
       AND (m.movement_kind, t.transition) IN (('payment', 'APPROVAL'), ('yield', 'YIELD'))
       AND NOT EXISTS (SELECT 1 FROM mp_source_record s
                        WHERE s.id = m.mp_source_record_id
                          AND s.event_data ->> 'operation_type' = 'account_fund'
                          AND s.event_data ->> 'payment_method_id' = 'debin_transfer'))
$$;

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
  SELECT s.*, ir.source_account_id AS own_account_id,
         (SELECT NOT EXISTS (SELECT 1 FROM mp_reconciliation rc WHERE rc.mp_financial_movement_id = t.mp_financial_movement_id)
                 AND ps.event_data ->> 'operation_type' = 'account_fund' AND ps.event_data ->> 'payment_method_id' = 'debin_transfer'
            FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
            JOIN mp_source_record ps ON ps.id = m.mp_source_record_id
           WHERE t.id = s.approval_id) AS classify_inflow
    FROM s LEFT JOIN mp_inbound_reclassification ir ON ir.payment_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payment'
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
       (SELECT fa.nombre::TEXT FROM financial_account fa WHERE fa.id = x.own_account_id) AS counterpart_account_name
  FROM x
 WHERE (SELECT current_app_role()) = 'ADMIN';
