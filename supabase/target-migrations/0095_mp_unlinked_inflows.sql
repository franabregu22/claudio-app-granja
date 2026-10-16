-- ============================================================================
-- TARGET V1 — 0095 MERCADO PAGO UNLINKED INFLOWS (ADR-023, owner GO 2026-10-16)
--
-- A real Mercado Pago inflow affects the balance immediately and NEVER requires a classification: "Entrada sin vincular" is
-- a valid permanent state (no P&L, no period-close block). Linking to a customer / own account is optional enrichment.
-- Only unresolved real OUTFLOWS (OUTBOUND, PAYOUT) and unposted real outflows stay mandatory and block the close.
--
--   1. mp_is_auto_applicable: account_fund + debin_transfer is auto-applied again (A1 plan, like any approved payment).
--      The 0086 own-transfer reclassification of an APPLIED account_fund payment is unchanged (MP balance unchanged, the
--      source bank account −net, the bank line matched to that transfer — never a second bank movement).
--   2. mp_pending_classification_totals: outflows only (the historical INFLOW kind and the legacy unapplied account_fund +
--      DEBIN are no longer pending) → management_period_close_guard (unchanged body) blocks only on outflows.
--   3. fin_mp_pending_classification: mandatory outflows only; appended columns is_historical, destination_status,
--      destination_last4, matched_account_name (historical payouts; never a full account number).
--   4. fin_mp_unlinked_inflows: every inflow in the balance (payment / inflow APPROVAL) not fully linked to customers and not
--      reclassified as an own transfer — current and historical, safe columns only.
--   5. fin_mp_pending_summary: server-side counts / totals (mandatory current / historical, unlinked current / historical).
--   6. mp_allocate_to_client: payment AND inflow movements; without an explicit date the allocation takes the movement's date
--      when its month is OPEN, otherwise the current Buenos Aires business date (never reopening nor backdating a closed or
--      missing period); the source SOURCE_ID / date / rule are recorded. An explicit date keeps the previous contract.
--   7. Security: no API role reads a full payout account number — mp_historical_row.raw_row is not readable (column
--      privileges) and the ADMIN policy of mp_source_record hides the evidence rows holding a non-empty PAYOUT_BANK_ACCOUNT_NUMBER
--      (service role + SECURITY DEFINER keep server-side access); report_mp_movement_status keeps those movements (LEFT JOIN).
-- No financial write, no backfill (ADR-022 inflows are already in the balance). SECURITY DEFINER set unchanged (93).
-- ============================================================================

-- ── 1. account_fund + DEBIN applied immediately ─────────────────────────────
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
       AND (m.movement_kind, t.transition) IN (('payment', 'APPROVAL'), ('yield', 'YIELD')))
$$;

-- ── 2. pending totals: outflows only ────────────────────────────────────────
CREATE OR REPLACE FUNCTION mp_pending_classification_totals(p_from DATE, p_to DATE)
RETURNS TABLE (pending_count BIGINT, outgoing NUMERIC, incoming NUMERIC, unposted_count BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH o AS (
    SELECT p.amount FROM mp_pending_outflow p
     WHERE p.occurred_date BETWEEN p_from AND p_to
       AND p.kind IN ('PAYOUT', 'OUTBOUND')   -- [0095] an inflow is never a mandatory classification (ADR-023)
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
  ), u AS (
    SELECT s.id FROM mp_source_record s
     WHERE s.source_type = 'csv_import' AND (s.external_id LIKE '%:payment:D' OR EXISTS (SELECT 1 FROM mp_transition_identity tp WHERE tp.resource_type = 'report' AND tp.resource_id = s.external_id AND tp.transition = 'PAYOUT'))
       AND s.processing_status NOT IN ('IGNORED', 'ERROR')
       AND (s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC < 0
       AND NOT EXISTS (SELECT 1 FROM mp_transition_identity t JOIN mp_reconciliation r ON r.mp_financial_movement_id = t.mp_financial_movement_id
                        WHERE t.resource_type = 'report' AND t.resource_id = s.external_id)
       AND s.occurred_date BETWEEN p_from AND p_to
  )
  SELECT (SELECT count(*) FROM o), coalesce((SELECT sum(amount) FROM o), 0), 0::NUMERIC, (SELECT count(*) FROM u)
$$;
ALTER FUNCTION mp_pending_classification_totals(DATE, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_pending_classification_totals(DATE, DATE) FROM PUBLIC, anon, authenticated, service_role;

-- ── 7a. raw evidence: never API-readable ────────────────────────────────────
REVOKE SELECT ON TABLE mp_historical_row FROM authenticated;
GRANT SELECT (id, run_id, row_number, identity, source_id, description, direction, occurred_at, occurred_date, payment_method,
              net_amount, gross_amount, fee_amount, tax_amount, created_at) ON TABLE mp_historical_row TO authenticated;
DROP POLICY mp_source_admin_select ON mp_source_record;
CREATE POLICY mp_source_admin_select ON mp_source_record FOR SELECT
  USING (current_app_role() = 'ADMIN' AND coalesce(event_data ->> 'PAYOUT_BANK_ACCOUNT_NUMBER', '') = '');   -- the 16-column rows carry the key empty

CREATE OR REPLACE VIEW report_mp_movement_status
WITH (security_invoker = true)
AS
SELECT m.id                                           AS mp_financial_movement_id,
       m.mp_source_record_id,
       s.source_type,
       s.external_id,
       s.processing_status,
       m.occurred_date                                AS business_date,
       date_trunc('month', m.occurred_date)::DATE     AS period,
       m.movement_kind,
       m.gross_amount,
       m.fee_amount,
       m.tax_amount,
       m.net_amount,
       COALESCE(r.assigned_amount, 0)                 AS assigned_amount,
       m.net_amount - COALESCE(r.assigned_amount, 0)  AS remaining_unassigned,
       COALESCE(r.reconciliations, 0)                 AS reconciliations
  FROM mp_financial_movement m
  LEFT JOIN mp_source_record s ON s.id = m.mp_source_record_id   -- [0095] a protected evidence row never hides its movement
  LEFT JOIN (SELECT mp_financial_movement_id, SUM(assigned_amount) AS assigned_amount, count(*) AS reconciliations
               FROM mp_reconciliation
              GROUP BY mp_financial_movement_id) r ON r.mp_financial_movement_id = m.id
 WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW report_mp_movement_status OWNER TO postgres;
REVOKE ALL    ON report_mp_movement_status FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON report_mp_movement_status TO authenticated;

-- ── 3. mandatory pending: outflows only ─────────────────────────────────────
CREATE OR REPLACE VIEW fin_mp_pending_classification
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT 'OUT:' || p.source_id AS pending_key, p.source_id::TEXT AS source_id, p.kind::TEXT AS kind, 'OUT'::TEXT AS direction,
         p.occurred_date AS business_date, coalesce(s.occurred_at, h.occurred_at) AS occurred_at, p.amount, abs(m.gross_amount) AS economic_amount,
         (m.fee_amount + m.tax_amount) AS charges_amount, a.nombre::TEXT AS account_name,
         CASE p.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END AS description,
         'PENDING'::TEXT AS status, true AS already_posted, p.provisional_operation_id AS financial_operation_id,
         h.id IS NOT NULL AS is_historical,                                      -- [0095] ADR-022 evidence
         hp.destination_status::TEXT AS destination_status, hp.destination_last4::TEXT AS destination_last4,
         (SELECT x.nombre::TEXT FROM financial_account x WHERE x.id = hp.matched_account_id) AS matched_account_name
    FROM mp_pending_outflow p
    JOIN mp_financial_movement m ON m.id = p.mp_financial_movement_id
    LEFT JOIN mp_source_record s ON s.id = m.mp_source_record_id
    LEFT JOIN mp_historical_row h ON h.identity = p.source_id || ':' || CASE p.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END || ':D'
    LEFT JOIN mp_historical_payout hp ON hp.identity = h.identity
    JOIN financial_account a ON a.id = p.mp_account_id
   WHERE p.kind IN ('PAYOUT', 'OUTBOUND')
     AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_pending_classification OWNER TO postgres;
REVOKE ALL    ON fin_mp_pending_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_pending_classification TO authenticated;

-- ── 4. entradas sin vincular ────────────────────────────────────────────────
CREATE OR REPLACE VIEW fin_mp_unlinked_inflows
WITH (security_invoker = true)
AS
SELECT m.id AS movement_id,
       CASE WHEN t.resource_type = 'payment' THEN t.resource_id ELSE split_part(t.resource_id, ':', 1) END::TEXT AS source_id,
       s.occurred_at, m.occurred_date AS business_date, m.gross_amount AS amount, m.net_amount,
       CASE coalesce(s.event_data ->> 'payment_method_id', s.event_data ->> 'PAYMENT_METHOD')
         WHEN 'cvu' THEN 'CVU' WHEN 'debin_transfer' THEN 'DEBIN' ELSE 'RECEIPT' END AS inflow_subtype,
       coalesce(s.event_data ->> 'operation_type' = 'account_fund', false) AS account_fund,
       nullif(btrim(s.event_data ->> 'description'), '') AS description,
       h.id IS NOT NULL AS is_historical,
       coalesce(al.allocated, 0)::NUMERIC(15,2) AS allocated_amount,
       (m.gross_amount - coalesce(al.allocated, 0))::NUMERIC(15,2) AS remaining_amount
  FROM mp_financial_movement m
  JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id AND t.transition = 'APPROVAL'
  JOIN mp_source_record s ON s.id = m.mp_source_record_id
  LEFT JOIN mp_historical_row h ON s.source_type = 'csv_import' AND h.identity = s.external_id
  LEFT JOIN (SELECT mp_financial_movement_id, sum(amount) AS allocated FROM mp_client_allocation GROUP BY 1) al ON al.mp_financial_movement_id = m.id
 WHERE m.movement_kind IN ('payment', 'inflow') AND m.gross_amount > 0
   AND EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id)          -- in the balance
   AND NOT EXISTS (SELECT 1 FROM mp_inbound_reclassification x WHERE x.mp_financial_movement_id = m.id)   -- not an own transfer
   AND m.gross_amount - coalesce(al.allocated, 0) > 0
   AND (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_unlinked_inflows OWNER TO postgres;
REVOKE ALL    ON fin_mp_unlinked_inflows FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_unlinked_inflows TO authenticated;

-- ── 5. dashboard aggregates (never computed by downloading rows) ────────────
CREATE OR REPLACE VIEW fin_mp_pending_summary
WITH (security_invoker = true)
AS
SELECT b.bucket, coalesce(x.item_count, 0)::BIGINT AS item_count, coalesce(x.amount, 0)::NUMERIC(15,2) AS amount
  FROM (VALUES ('PENDING_CURRENT', 1), ('PENDING_HISTORICAL', 2), ('UNLINKED_CURRENT', 3), ('UNLINKED_HISTORICAL', 4)) b(bucket, ord)
  LEFT JOIN (
    SELECT CASE WHEN is_historical THEN 'PENDING_HISTORICAL' ELSE 'PENDING_CURRENT' END AS bucket, count(*) AS item_count, sum(amount) AS amount
      FROM fin_mp_pending_classification GROUP BY 1
    UNION ALL
    SELECT CASE WHEN is_historical THEN 'UNLINKED_HISTORICAL' ELSE 'UNLINKED_CURRENT' END, count(*), sum(remaining_amount)
      FROM fin_mp_unlinked_inflows GROUP BY 1
  ) x ON x.bucket = b.bucket
 WHERE (SELECT current_app_role()) = 'ADMIN'
 ORDER BY b.ord;
ALTER VIEW fin_mp_pending_summary OWNER TO postgres;
REVOKE ALL    ON fin_mp_pending_summary FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_pending_summary TO authenticated;

-- ── 6. customer linking: payment AND inflow; closed-period rule ─────────────
CREATE OR REPLACE FUNCTION mp_allocate_to_client(
  p_movement_id     BIGINT,
  p_cliente_id      UUID,
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_idempotency_key VARCHAR,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID;
  v_mv       mp_financial_movement;
  v_tr       mp_transition_identity;
  v_src_st   mp_processing_status;
  v_assigned NUMERIC(15,2);
  v_client   TEXT;
  v_active   NUMERIC(15,2);
  v_bound    NUMERIC(15,2);
  v_alloc    UUID := gen_random_uuid();
  v_ledger   BIGINT;
  v_eff      DATE;
  v_rule     TEXT;
  v_sid      TEXT;
  v_today    DATE := (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  v_uid := auth.uid();
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 97
     OR p_idempotency_key LIKE 'MPA:%' OR p_idempotency_key LIKE 'MPAUTO:%' OR p_idempotency_key LIKE 'MPREV:%' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 97 characters, no reserved prefix';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM mp_client_allocation WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_ALLOCATION';
  END IF;

  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE;   -- L5
  SELECT * INTO v_tr FROM mp_transition_identity WHERE mp_financial_movement_id = p_movement_id;
  -- [0095] a receipt (payment) or an inflow (ADR-022 historical CVU / DEBIN) approved and in the balance (ADR-023)
  IF v_mv.id IS NULL OR v_mv.movement_kind NOT IN ('payment', 'inflow') OR v_tr.transition IS DISTINCT FROM 'APPROVAL' OR v_mv.gross_amount <= 0 THEN
    RAISE EXCEPTION 'NOT_A_RECEIPT';
  END IF;
  SELECT processing_status INTO v_src_st FROM mp_source_record WHERE id = v_mv.mp_source_record_id;
  SELECT coalesce(sum(assigned_amount), 0) INTO v_assigned FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id;
  IF v_src_st = 'ERROR' OR v_assigned <> v_mv.net_amount THEN
    RAISE EXCEPTION 'RECEIPT_NOT_POSTED';
  END IF;
  SELECT nombre INTO v_client FROM clients WHERE id = p_cliente_id AND activo = true;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  -- [0095] ADR-023 §6: no explicit date → the movement's date when its month is OPEN, else today (never backdated / reopened)
  IF p_effective_date IS NULL THEN
    IF EXISTS (SELECT 1 FROM management_period WHERE periodo_fecha = date_trunc('month', v_mv.occurred_date)::DATE AND status = 'OPEN') THEN
      v_eff := v_mv.occurred_date; v_rule := 'SOURCE_DATE';
    ELSE
      v_eff := greatest(v_today, v_mv.occurred_date); v_rule := 'CURRENT_DATE_SOURCE_PERIOD_NOT_OPEN';
    END IF;
  ELSE
    v_eff := p_effective_date; v_rule := 'EXPLICIT';
  END IF;
  IF v_eff < v_mv.occurred_date THEN
    RAISE EXCEPTION 'EFFECTIVE_DATE_BEFORE_RECEIPT';
  END IF;
  PERFORM assert_period_open(v_eff);                                                  -- L6
  v_sid := CASE WHEN v_tr.resource_type = 'payment' THEN v_tr.resource_id ELSE split_part(v_tr.resource_id, ':', 1) END;

  -- bound = effective applied receipt: gross − Σ │gross│ of REFUND / CHARGEBACK movements of the
  -- same payment that mp_apply_transition has successfully applied (key MPA:{t}:SETTLE exists)
  SELECT coalesce(sum(amount), 0) INTO v_active FROM mp_client_allocation WHERE mp_financial_movement_id = p_movement_id;
  SELECT v_mv.gross_amount - coalesce(sum(abs(m2.gross_amount)), 0) INTO v_bound
    FROM mp_transition_identity t2
    JOIN mp_financial_movement m2 ON m2.id = t2.mp_financial_movement_id
   WHERE t2.resource_type = v_tr.resource_type AND t2.resource_id = v_tr.resource_id
     AND t2.transition IN ('REFUND', 'CHARGEBACK')
     AND EXISTS (SELECT 1 FROM mp_reconciliation r
                  WHERE r.mp_financial_movement_id = m2.id AND r.idempotency_key = 'MPA:' || t2.id || ':SETTLE');
  IF v_active + p_amount > v_bound THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_RECEIPT: % + % exceeds effective receipt %', v_active, p_amount, v_bound;
  END IF;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name,
                             source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'COLLECTION', -p_amount, v_eff, v_client,
          'mp_client_allocation', v_alloc::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger;

  INSERT INTO mp_client_allocation (id, mp_financial_movement_id, cliente_id, amount, origin, mode, effective_date,
                                    evidence, idempotency_key, client_ledger_id, reason, created_by)
  VALUES (v_alloc, p_movement_id, p_cliente_id, p_amount, 'ALLOCATION', 'MANUAL', v_eff,
          jsonb_build_object('reason', p_reason, 'source_id', v_sid, 'source_date', v_mv.occurred_date, 'effective_date_rule', v_rule),
          p_idempotency_key, v_ledger, p_reason, v_uid);

  IF v_active + p_amount = v_bound THEN
    UPDATE mp_attribution_flag
       SET cleared_by = v_uid, cleared_at = NOW(), clear_reason = 'FULLY_ASSIGNED'
     WHERE mp_financial_movement_id = p_movement_id AND cleared_at IS NULL;
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_client_allocation', v_alloc::TEXT, 'MP_CLIENT_ALLOCATION',
          jsonb_build_object('movement_id', p_movement_id, 'cliente_id', p_cliente_id, 'amount', p_amount,
                             'mode', 'MANUAL', 'client_ledger_id', v_ledger, 'source_id', v_sid, 'source_date', v_mv.occurred_date,
                             'effective_date', v_eff, 'effective_date_rule', v_rule),
          p_reason, v_uid);

  RETURN jsonb_build_object('allocation_id', v_alloc, 'client_ledger_id', v_ledger,
                            'active_attributed', v_active + p_amount, 'effective_receipt', v_bound,
                            'source_date', v_mv.occurred_date, 'effective_date', v_eff, 'effective_date_rule', v_rule);
END;
$$;
