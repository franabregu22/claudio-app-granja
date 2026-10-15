-- ============================================================================
-- TARGET V1 — 0087 MERCADO PAGO PAYOUT → OWN ACCOUNT: CONFIRMED TRANSFER (owner GO 2026-10-15, META A)
--
-- A payout (MP "Retiro") is report-only: the release report creates its movement (movement_kind 'transfer', transition
-- PAYOUT, net < 0) but no financial operation, so the ERP MP balance does not yet show the money leaving. 0084 compares
-- the payout destination with the own-account CBUs (OWN_ACCOUNT_EXACT / NO_OWN_ACCOUNT_MATCH / DESTINATION_CONFLICT)
-- and only shows the proposal. This migration lets ADMIN confirm an OWN_ACCOUNT_EXACT payout as ONE internal transfer.
--
--   1. mp_payout_transfer_confirmation — one immutable row per confirmed payout: the SOURCE_ID, the movement, the
--      destination evidence (the fin_mp_payout_destination appearance it was matched on), the MP and the destination
--      accounts, the amount and the TRANSFER operation.
--   2. mp_confirm_payout_transfer(p_source_id) — SECURITY DEFINER, ADMIN only. The ONLY input is the SOURCE_ID: the server
--      resolves the payout movement, its amount and date, the Mercado Pago account and the matched destination account
--      (fin_mp_payout_matches, 0084). Accepted only for OWN_ACCOUNT_EXACT; NO_OWN_ACCOUNT_MATCH, DESTINATION_CONFLICT and
--      an unknown destination are refused. Effect: transfer_between_accounts(MP → destination, |net|, payout date,
--      'MP-PAYOUT-TRANSFER:<SOURCE_ID>') — MP −amount, destination +amount, no P&L line — and the movement is reconciled
--      to it (assigned −amount). Idempotent: a second call writes nothing and returns replayed = true. The payout
--      evidence (source record, report line, destination row) is never modified. The bank line of the destination can
--      later be matched (fin_statement_match) to this operation's destination posting.
--   3. fin_mp_report_activity: a confirmed payout row is OWN_TRANSFER with counterpart_account_name = the destination
--      (financial_operation_id = the transfer, through the movement's reconciliation). Columns unchanged.
-- SECURITY DEFINER set 80 → 81.
-- ============================================================================

CREATE TABLE mp_payout_transfer_confirmation (
  id                         BIGSERIAL PRIMARY KEY,
  source_id                  VARCHAR(40) NOT NULL UNIQUE,
  mp_financial_movement_id   BIGINT      NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_run_id         UUID        NOT NULL,
  destination_row_number     INTEGER     NOT NULL,
  mp_account_id              UUID        NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_account_id     UUID        NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  transfer_operation_id      BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_by                 UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_mptc_destination FOREIGN KEY (destination_run_id, destination_row_number)
    REFERENCES fin_mp_payout_destination(run_id, row_number) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_mptc_accounts CHECK (mp_account_id <> destination_account_id)
);
ALTER TABLE mp_payout_transfer_confirmation ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_mp_payout_transfer_confirmation_immutable
  BEFORE UPDATE OR DELETE ON mp_payout_transfer_confirmation
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE mp_payout_transfer_confirmation FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_payout_transfer_confirmation TO authenticated;
REVOKE ALL ON SEQUENCE mp_payout_transfer_confirmation_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY mp_payout_transfer_confirmation_admin_select ON mp_payout_transfer_confirmation
  FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE OR REPLACE FUNCTION mp_confirm_payout_transfer(p_source_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_row    mp_payout_transfer_confirmation%ROWTYPE;
  v_mp     UUID;
  v_mv     mp_financial_movement%ROWTYPE;
  v_match  RECORD;
  v_dest   RECORD;
  v_ref    TEXT;
  v_res    JSONB;
  v_trf    BIGINT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_source_id IS NULL OR p_source_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_payout_transfer:' || p_source_id, 0));

  -- idempotent: a payout is confirmed once; a repeated call writes nothing
  SELECT * INTO v_row FROM mp_payout_transfer_confirmation WHERE source_id = p_source_id;
  IF FOUND THEN
    RETURN jsonb_build_object('confirmation_id', v_row.id, 'replayed', true, 'transfer_operation_id', v_row.transfer_operation_id,
      'amount', v_row.amount, 'destination_account', (SELECT nombre FROM financial_account WHERE id = v_row.destination_account_id));
  END IF;

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
  IF EXISTS (SELECT 1 FROM mp_reconciliation WHERE mp_financial_movement_id = v_mv.id) THEN
    RAISE EXCEPTION 'PAYOUT_ALREADY_APPLIED: the payout movement already has a financial operation';
  END IF;

  -- the destination is resolved server-side only: exact own-account match (0084), never a client value
  SELECT * INTO v_match FROM fin_mp_payout_matches(v_mp) pm WHERE pm.source_id = p_source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DESTINATION_UNKNOWN: no stored destination for payout %', p_source_id;
  END IF;
  IF v_match.match_status IS DISTINCT FROM 'OWN_ACCOUNT_EXACT' OR v_match.matched_account_id IS NULL THEN
    RAISE EXCEPTION 'NOT_OWN_ACCOUNT_EXACT: payout % is %', p_source_id, v_match.match_status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = v_match.matched_account_id AND activo AND account_type = 'BANK_ACCOUNT') THEN
    RAISE EXCEPTION 'DESTINATION_ACCOUNT_INVALID: the matched account is not an active own bank account';
  END IF;
  SELECT d.run_id, d.row_number INTO v_dest
    FROM fin_mp_payout_destination d JOIN fin_import_run r ON r.id = d.run_id
   WHERE d.source_id = p_source_id AND d.description = 'payout' AND r.source_kind = 'MP_RELEASE_REPORT' AND r.financial_account_id = v_mp
   ORDER BY d.created_at, d.run_id, d.row_number LIMIT 1;

  v_ref := 'MP-PAYOUT-TRANSFER:' || p_source_id;
  v_res := transfer_between_accounts(v_mp, v_match.matched_account_id, -v_mv.net_amount, v_mv.occurred_date, v_ref,
             'Retiro de Mercado Pago a cuenta propia (payout ' || p_source_id || ')');
  v_trf := (v_res ->> 'financial_operation_id')::BIGINT;
  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_mv.id, v_trf, v_mp, v_mv.net_amount, v_ref, NOW(), v_uid);

  INSERT INTO mp_payout_transfer_confirmation (source_id, mp_financial_movement_id, destination_run_id, destination_row_number,
         mp_account_id, destination_account_id, amount, transfer_operation_id, created_by)
  VALUES (p_source_id, v_mv.id, v_dest.run_id, v_dest.row_number, v_mp, v_match.matched_account_id, -v_mv.net_amount, v_trf, v_uid)
  RETURNING * INTO v_row;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_payout_transfer_confirmation', v_row.id::TEXT, 'CONFIRM_PAYOUT_TRANSFER',
          jsonb_build_object('source_id', p_source_id, 'amount', v_row.amount, 'destination_account', v_row.destination_account_id,
                             'transfer_operation', v_trf), 'Retiro confirmado como transferencia entre cuentas propias', v_uid);
  RETURN jsonb_build_object('confirmation_id', v_row.id, 'replayed', false, 'transfer_operation_id', v_trf,
    'amount', v_row.amount, 'destination_account', v_match.matched_account_name);
END;
$$;
ALTER FUNCTION mp_confirm_payout_transfer(TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_confirm_payout_transfer(TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_confirm_payout_transfer(TEXT) TO authenticated;

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
           WHERE t.id = s.approval_id) AS classify_inflow
    FROM s LEFT JOIN mp_inbound_reclassification ir ON ir.payment_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payment'
           LEFT JOIN mp_payout_transfer_confirmation pc ON pc.source_id = s.raw_row ->> 'SOURCE_ID' AND s.raw_row ->> 'DESCRIPTION' = 'payout'
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
