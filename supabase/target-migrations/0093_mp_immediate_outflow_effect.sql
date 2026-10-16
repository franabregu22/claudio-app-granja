-- ============================================================================
-- TARGET V1 — 0093 MERCADO PAGO: IMMEDIATE BALANCE EFFECT OF REAL OUTFLOWS + PENDING CLASSIFICATION (ADR-021, ACCEPTED 2026-10-16)
--
-- A payout or an outbound payment is real money that already left Mercado Pago. It now reaches the balance when the release
-- report is processed; the classification only gives it its economic meaning and never moves Mercado Pago a second time.
--   1. mp_pending_outflow (one row per SOURCE_ID, immutable): the provisional effect — ADJUSTMENT 'MP-PENDING:<SOURCE_ID>',
--      one posting of the report's NET debit on Mercado Pago, reconciled to the movement (0091 holds). No purchase, no supplier
--      debt, no withdrawal, no credit elsewhere, no P&L line, no guessed classification.
--      mp_pending_outflow_resolution (one row per pending, immutable): its release — ADJUSTMENT 'MP-PENDING-RELEASE:<SOURCE_ID>',
--      +net on Mercado Pago, reconciled to the movement — written by the classification transaction. PENDING = no resolution.
--   2. mp_pending_outflow_post(source_id, run, actor) (INVOKER, owner-only): idempotent provisional of one outflow; payouts read
--      their movement directly (never fin_mp_payout_matches, which is ADMIN-only), outbound payments materialize through
--      mp_outflow_resolve (ADR-020). Outcomes: POSTED / EXISTS / APPLIED (already classified or confirmed) / NOT_ELIGIBLE
--      (pre-cutover, ignored, error, unknown).
--      mp_post_pending_outflow(source_id) (SECURITY DEFINER, ADMIN or service): recovery / backfill of one SOURCE_ID.
--   3. mp_pending_outflow_release(movement, actor, route) (INVOKER, owner-only): reversal + resolution + audit, idempotent.
--      Called by register_casual_purchase, mp_classify_payout_outflow and mp_confirm_payout_transfer before their classified
--      effect, in the same transaction. mp_outflow_resolve / mp_confirm_payout_transfer: the provisional and its release are not
--      "already applied".
--   4. mp_reconciliation_pending_guard (BEFORE INSERT on mp_reconciliation, SECURITY DEFINER, no EXECUTE): a movement whose
--      provisional is unresolved accepts no other reconciliation (MP_PENDING_NOT_RELEASED) — no double effect, by construction.
--   5. fin_ingest_mp_release_report: the 0081 body plus the provisional of every payout / outbound row, isolated per row in a
--      subtransaction (the boundary already used for yields). A failure keeps the evidence and the other rows; the appearance
--      gets review_code PROVISIONAL_NOT_POSTED; the outflow stays a technical exception and its day is not reconciled.
--   6. management_period_close_guard (BEFORE UPDATE on management_period, SECURITY DEFINER, no EXECUTE): a period with
--      pending classifications (PENDING_CLASSIFICATION) or unposted outflows (MP_UNPOSTED_OUTFLOWS) cannot be closed.
--   7. Views (security_invoker, ADMIN): fin_mp_pending_classification (provisional outflows + inflows from an own account
--      awaiting classification; NOT receipts without a client), fin_mp_technical_review (unposted outflows, report rows in
--      ERROR), fin_mp_report_day_status (official vs ERP per report day: RECONCILED only with gap 0 and no technical exception);
--      fin_mp_report_activity: an outflow with an unresolved provisional → PENDING_CLASSIFICATION.
-- SECURITY DEFINER set 88 → 91.
-- ============================================================================

-- ── 1. pending outflows and their resolution ──────────────────────────────────
CREATE TABLE mp_pending_outflow (
  id                       BIGSERIAL PRIMARY KEY,
  source_id                VARCHAR(30) NOT NULL UNIQUE,
  kind                     VARCHAR(10) NOT NULL,
  mp_financial_movement_id BIGINT      NOT NULL UNIQUE REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  mp_account_id            UUID        NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provisional_operation_id BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount                   NUMERIC(15,2) NOT NULL,
  occurred_date            DATE        NOT NULL,
  run_id                   UUID        REFERENCES fin_import_run(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_by               UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mpo_kind   CHECK (kind IN ('PAYOUT', 'OUTBOUND')),
  CONSTRAINT chk_mpo_amount CHECK (amount < 0),
  CONSTRAINT chk_mpo_source CHECK (source_id ~ '^[0-9]{1,20}$')
);
CREATE TABLE mp_pending_outflow_resolution (
  id                    BIGSERIAL PRIMARY KEY,
  pending_id            BIGINT      NOT NULL UNIQUE REFERENCES mp_pending_outflow(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reversal_operation_id BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  route                 VARCHAR(30) NOT NULL,
  resolved_by           UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  resolved_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mpor_route CHECK (route IN ('CASUAL_PURCHASE', 'EXPENSE', 'SUPPLIER_PAYMENT', 'OWNER_WITHDRAWAL', 'OWN_TRANSFER'))
);
CREATE TRIGGER trg_mp_pending_outflow_immutable BEFORE UPDATE OR DELETE ON mp_pending_outflow
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_mp_pending_outflow_resolution_immutable BEFORE UPDATE OR DELETE ON mp_pending_outflow_resolution
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE mp_pending_outflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE mp_pending_outflow_resolution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE mp_pending_outflow, mp_pending_outflow_resolution FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_pending_outflow, mp_pending_outflow_resolution TO authenticated;
REVOKE ALL ON SEQUENCE mp_pending_outflow_id_seq, mp_pending_outflow_resolution_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY mp_pending_outflow_admin_select ON mp_pending_outflow FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY mp_pending_outflow_resolution_admin_select ON mp_pending_outflow_resolution FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── 2. provisional of one outflow (idempotent; internal) ──────────────────────
CREATE OR REPLACE FUNCTION mp_pending_outflow_post(p_source_id TEXT, p_run_id UUID, p_uid UUID)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_mp   UUID;
  v_mv   mp_financial_movement%ROWTYPE;
  v_src  mp_source_record%ROWTYPE;
  v_out  RECORD;
  v_kind TEXT;
  v_op   BIGINT;
  v_pid  BIGINT;
BEGIN
  IF p_source_id IS NULL OR p_source_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_ID';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('mp_payout_outflow:' || p_source_id, 0));   -- the classification lock (0088 / 0090)
  IF EXISTS (SELECT 1 FROM mp_pending_outflow WHERE source_id = p_source_id) THEN
    RETURN 'EXISTS';
  END IF;
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  -- a payout: its movement, claimed by the release report (read directly: fin_mp_payout_matches is ADMIN-only)
  SELECT m.* INTO v_mv FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
   WHERE t.resource_type = 'report' AND t.resource_id = p_source_id || ':payout:D' AND t.transition = 'PAYOUT' AND t.transition_ref = ''
   FOR UPDATE OF m;
  IF FOUND THEN
    v_kind := 'PAYOUT';
    IF v_mv.movement_kind <> 'transfer' OR v_mv.net_amount >= 0 THEN
      RAISE EXCEPTION 'NOT_A_PAYOUT';
    END IF;
  ELSE
    -- an outbound payment (ADR-020): the parked report row, materialized by the resolver
    SELECT * INTO v_src FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = p_source_id || ':payment:D';
    IF NOT FOUND OR v_src.processing_status IN ('IGNORED', 'ERROR')
       OR coalesce((v_src.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (v_src.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC, 0) >= 0 THEN
      RETURN 'NOT_ELIGIBLE';   -- pre-cutover / ignored / error / no money: evidence only
    END IF;
    SELECT * INTO v_out FROM mp_outflow_resolve(p_source_id);
    SELECT * INTO v_mv FROM mp_financial_movement WHERE id = v_out.movement_id FOR UPDATE;
    v_kind := 'OUTBOUND';
  END IF;
  -- already classified / confirmed (history): it has its effect; nothing provisional
  IF EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = v_mv.id) THEN
    RETURN 'APPLIED';
  END IF;
  PERFORM assert_period_open(v_mv.occurred_date);

  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', v_mv.occurred_date, 'MP-PENDING:' || p_source_id, 'mp_financial_movement', v_mv.id::TEXT,
          'Mercado Pago: pendiente de clasificar (' || p_source_id || ')', p_uid)
  RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_mp, v_mv.net_amount, v_mv.occurred_date, p_uid);
  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (v_mv.id, v_op, v_mp, v_mv.net_amount, 'MP-PENDING:' || p_source_id, NOW(), p_uid);
  INSERT INTO mp_pending_outflow (source_id, kind, mp_financial_movement_id, mp_account_id, provisional_operation_id, amount, occurred_date, run_id, created_by)
  VALUES (p_source_id, v_kind, v_mv.id, v_mp, v_op, v_mv.net_amount, v_mv.occurred_date, p_run_id, p_uid)
  RETURNING id INTO v_pid;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_pending_outflow', v_pid::TEXT, 'MP_PENDING_OUTFLOW_POSTED',
          jsonb_build_object('source_id', p_source_id, 'kind', v_kind, 'amount', v_mv.net_amount, 'operation', v_op, 'run_id', p_run_id),
          'ADR-021: salida real de Mercado Pago, pendiente de clasificar', p_uid);
  RETURN 'POSTED';
END;
$$;
ALTER FUNCTION mp_pending_outflow_post(TEXT, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_pending_outflow_post(TEXT, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. release of the provisional (idempotent; internal; called by every classification route) ──
CREATE OR REPLACE FUNCTION mp_pending_outflow_release(p_movement_id BIGINT, p_uid UUID, p_route TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_p   mp_pending_outflow%ROWTYPE;
  v_op  BIGINT;
  v_rid BIGINT;
BEGIN
  SELECT * INTO v_p FROM mp_pending_outflow WHERE mp_financial_movement_id = p_movement_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM mp_pending_outflow_resolution WHERE pending_id = v_p.id) THEN
    RETURN false;
  END IF;
  PERFORM assert_period_open(v_p.occurred_date);
  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', v_p.occurred_date, 'MP-PENDING-RELEASE:' || v_p.source_id, 'mp_financial_movement', p_movement_id::TEXT,
          'Mercado Pago: salida clasificada (' || v_p.source_id || ')', p_uid)
  RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_p.mp_account_id, -v_p.amount, v_p.occurred_date, p_uid);
  INSERT INTO mp_reconciliation (mp_financial_movement_id, financial_operation_id, financial_account_id, assigned_amount, idempotency_key, reconciled_at, reconciled_by)
  VALUES (p_movement_id, v_op, v_p.mp_account_id, -v_p.amount, 'MP-PENDING-RELEASE:' || v_p.source_id, NOW(), p_uid);
  INSERT INTO mp_pending_outflow_resolution (pending_id, reversal_operation_id, route, resolved_by)
  VALUES (v_p.id, v_op, p_route, p_uid)
  RETURNING id INTO v_rid;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_pending_outflow', v_p.id::TEXT, 'MP_PENDING_OUTFLOW_RESOLVED',
          jsonb_build_object('source_id', v_p.source_id, 'route', p_route, 'reversal_operation', v_op, 'resolution_id', v_rid),
          'ADR-021: la salida pendiente se clasificó; Mercado Pago no se mueve dos veces', p_uid);
  RETURN true;
END;
$$;
ALTER FUNCTION mp_pending_outflow_release(BIGINT, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_pending_outflow_release(BIGINT, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── 4. no double effect: an unresolved provisional admits no other reconciliation ──
CREATE OR REPLACE FUNCTION mp_reconciliation_pending_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.idempotency_key LIKE 'MP-PENDING:%' OR NEW.idempotency_key LIKE 'MP-PENDING-RELEASE:%' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM mp_pending_outflow p WHERE p.mp_financial_movement_id = NEW.mp_financial_movement_id
              AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)) THEN
    RAISE EXCEPTION 'MP_PENDING_NOT_RELEASED: movement % holds an unresolved provisional; classify it through its route', NEW.mp_financial_movement_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION mp_reconciliation_pending_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_reconciliation_pending_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_mp_reconciliation_pending_guard BEFORE INSERT ON mp_reconciliation
  FOR EACH ROW EXECUTE FUNCTION mp_reconciliation_pending_guard();

-- ── recovery / backfill of one SOURCE_ID (ADMIN or service) ──────────────────
CREATE OR REPLACE FUNCTION mp_post_pending_outflow(p_source_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_outcome TEXT;
  v_p       mp_pending_outflow%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN or backend service role required';
  END IF;
  v_outcome := mp_pending_outflow_post(p_source_id, NULL, auth.uid());
  SELECT * INTO v_p FROM mp_pending_outflow WHERE source_id = p_source_id;
  RETURN jsonb_build_object('source_id', p_source_id, 'outcome', v_outcome, 'replayed', v_outcome <> 'POSTED',
    'pending_id', v_p.id, 'kind', v_p.kind, 'amount', v_p.amount, 'provisional_operation_id', v_p.provisional_operation_id);
END;
$$;
ALTER FUNCTION mp_post_pending_outflow(TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_post_pending_outflow(TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION mp_post_pending_outflow(TEXT) TO authenticated, service_role;

-- ── totals of a date range (internal; the period close guard) ────────────────
CREATE OR REPLACE FUNCTION mp_pending_classification_totals(p_from DATE, p_to DATE)
RETURNS TABLE (pending_count BIGINT, outgoing NUMERIC, incoming NUMERIC, unposted_count BIGINT)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH o AS (
    SELECT p.amount FROM mp_pending_outflow p
     WHERE p.occurred_date BETWEEN p_from AND p_to
       AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
  ), i AS (
    SELECT m.gross_amount FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
      JOIN mp_source_record ps ON ps.id = m.mp_source_record_id
     WHERE t.resource_type = 'payment' AND t.transition = 'APPROVAL' AND t.transition_ref = ''
       AND ps.event_data ->> 'operation_type' = 'account_fund' AND ps.event_data ->> 'payment_method_id' = 'debin_transfer'
       AND NOT EXISTS (SELECT 1 FROM mp_reconciliation rc WHERE rc.mp_financial_movement_id = m.id)
       AND m.occurred_date BETWEEN p_from AND p_to
  ), u AS (
    SELECT s.id FROM mp_source_record s
     WHERE s.source_type = 'csv_import' AND (s.external_id LIKE '%:payment:D' OR EXISTS (SELECT 1 FROM mp_transition_identity tp WHERE tp.resource_type = 'report' AND tp.resource_id = s.external_id AND tp.transition = 'PAYOUT'))
       AND s.processing_status NOT IN ('IGNORED', 'ERROR')
       AND (s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC < 0
       AND NOT EXISTS (SELECT 1 FROM mp_transition_identity t JOIN mp_reconciliation r ON r.mp_financial_movement_id = t.mp_financial_movement_id
                        WHERE t.resource_type = 'report' AND t.resource_id = s.external_id)
       AND s.occurred_date BETWEEN p_from AND p_to
  )
  SELECT (SELECT count(*) FROM o) + (SELECT count(*) FROM i), coalesce((SELECT sum(amount) FROM o), 0),
         coalesce((SELECT sum(gross_amount) FROM i), 0), (SELECT count(*) FROM u)
$$;
ALTER FUNCTION mp_pending_classification_totals(DATE, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_pending_classification_totals(DATE, DATE) FROM PUBLIC, anon, authenticated, service_role;

-- ── 6. a period with pending classifications / unposted outflows cannot be closed ──
CREATE OR REPLACE FUNCTION management_period_close_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v RECORD;
BEGIN
  IF OLD.status = 'OPEN' AND NEW.status IS DISTINCT FROM 'OPEN' THEN
    SELECT * INTO v FROM mp_pending_classification_totals(NEW.periodo_fecha, (NEW.periodo_fecha + INTERVAL '1 month' - INTERVAL '1 day')::DATE);
    IF v.pending_count > 0 THEN
      RAISE EXCEPTION 'PENDING_CLASSIFICATION: % movimiento(s) pendiente(s) de clasificar en el período % (salidas %, entradas %). Clasificalos antes de cerrarlo.',
        v.pending_count, to_char(NEW.periodo_fecha, 'YYYY-MM'), -v.outgoing, v.incoming;
    END IF;
    IF v.unposted_count > 0 THEN
      RAISE EXCEPTION 'MP_UNPOSTED_OUTFLOWS: % salida(s) de Mercado Pago sin registrar en el período % (revisión técnica) antes de cerrarlo.',
        v.unposted_count, to_char(NEW.periodo_fecha, 'YYYY-MM');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION management_period_close_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION management_period_close_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_management_period_close_guard BEFORE UPDATE ON management_period
  FOR EACH ROW EXECUTE FUNCTION management_period_close_guard();

-- ── 3b. resolver (0090 body; [0093] the provisional / its release are not "already applied") ──
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
                      EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = v_mv.id
                              AND NOT EXISTS (SELECT 1 FROM financial_operation po WHERE po.id = r.financial_operation_id AND po.external_ref LIKE 'MP-PENDING%')), v_run, v_row,   -- [0093]
                      v_kind, v_mv.gross_amount, v_mv.fee_amount, v_mv.tax_amount;
END;
$$;
ALTER FUNCTION mp_outflow_resolve(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_outflow_resolve(TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3c. register_casual_purchase (0090 body; [0093] release before the payment) ──
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

  -- [0093] ADR-021: the provisional effect of the outflow is released first (Mercado Pago never moves twice)
  IF p_mp_source_id IS NOT NULL THEN
    PERFORM mp_pending_outflow_release(v_out.movement_id, v_uid, 'CASUAL_PURCHASE');
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

-- ── 3d. mp_classify_payout_outflow (0090 body; [0093] release before the withdrawal / supplier payment) ──
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

  -- [0093] ADR-021: release the provisional effect before the classified effect
  PERFORM mp_pending_outflow_release(v_out.movement_id, v_uid, p_classification);

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

-- ── 3e. mp_confirm_payout_transfer (0087 body; [0093] release before the transfer) ──
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
  IF EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.mp_financial_movement_id = v_mv.id
              AND NOT EXISTS (SELECT 1 FROM financial_operation po WHERE po.id = r.financial_operation_id AND po.external_ref LIKE 'MP-PENDING%')) THEN   -- [0093]
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

  -- [0093] ADR-021: release the provisional effect before the transfer (Mercado Pago never moves twice)
  PERFORM mp_pending_outflow_release(v_mv.id, v_uid, 'OWN_TRANSFER');
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

-- ── 5. fin_ingest_mp_release_report (0081 body; [0093] provisional per payout / outbound row) ──
CREATE OR REPLACE FUNCTION fin_ingest_mp_release_report(
  p_actor          UUID,
  p_parser_version TEXT,
  p_format_code    TEXT,
  p_file_sha256    TEXT,
  p_storage_path   TEXT,
  p_file_name      TEXT,
  p_byte_size      BIGINT,
  p_coverage_from  DATE,
  p_coverage_to    DATE,
  p_source_meta    JSONB,
  p_reject_reason  TEXT,
  p_rows           JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_format  CONSTANT TEXT := 'MP_RELEASE_REPORT_CSV_V1';
  c_keys    CONSTANT TEXT[] := ARRAY['BALANCE_AMOUNT','BUSINESS_UNIT','DATE','DESCRIPTION','GROSS_AMOUNT',
    'MP_FEE_AMOUNT','NET_CREDIT_AMOUNT','NET_DEBIT_AMOUNT','PAYMENT_METHOD','PAYMENT_METHOD_TYPE',
    'PURCHASE_ID','SOURCE_ID','SUB_UNIT','TAXES_AMOUNT','TRANSACTION_APPROVAL_DATE'];
  c_amount  CONSTANT TEXT := '^-?[0-9]{1,13}(\.[0-9]{1,2})?$';
  c_ts      CONSTANT TEXT := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?[+-][0-9]{2}:[0-9]{2}$';
  v_acc      UUID;
  v_run      fin_import_run;
  v_latest   fin_import_run;
  v_run_id   UUID := gen_random_uuid();
  v_reject   TEXT := p_reject_reason;
  v_rows     JSONB := '[]'::jsonb;    -- validated rows with database-decided class / identity / outcome
  r          JSONB;
  e          JSONB;
  v_raw      JSONB;
  v_src      mp_source_record;
  v_p        RECORD;
  v_net      NUMERIC;
  v_xid      TEXT;
  v_seen     TEXT[] := ARRAY[]::TEXT[];
  v_invalid  BOOLEAN;
  v_note     TEXT;
  v_desc     TEXT;
  v_known    UUID;
  v_sid      UUID;
  v_status   mp_processing_status;
  v_mv       BIGINT;
  v_review   TEXT;
  v_bf       JSONB;
  v_n        INTEGER := 0;
  v_moves    INTEGER := 0;
  v_ninv     INTEGER := 0;
  v_new      INTEGER := 0;
  v_old      INTEGER := 0;
  v_ctl      INTEGER := 0;
  v_bf_new   INTEGER := 0;
  v_bf_skip  INTEGER := 0;
  v_yield    INTEGER := 0;
  v_yield_ko INTEGER := 0;
  v_prov     INTEGER := 0;   -- [0093]
  v_prov_ko  INTEGER := 0;   -- [0093]
  v_po       TEXT;           -- [0093]
BEGIN
  -- ── caller, actor, account ──
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;
  -- [0081] p_actor NULL = the daily scheduler (mp-report-daily, service_role; created_by NULL, ADR-018 §6.1);
  --        a non-NULL actor must still be an active ADMIN
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM perfiles WHERE id = p_actor AND activo AND rol_type = 'ADMIN') THEN
    RAISE EXCEPTION 'FORBIDDEN: the initiating actor is not an active ADMIN';
  END IF;
  SELECT id INTO v_acc FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;

  -- ── attempt fields (identical contract to 0078) ──
  IF p_parser_version IS NULL OR btrim(p_parser_version) = '' THEN
    RAISE EXCEPTION 'PARSER_VERSION_REQUIRED';
  END IF;
  IF p_file_sha256 IS NULL OR p_file_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_FILE_SHA256';
  END IF;
  IF p_storage_path IS DISTINCT FROM ('mp/' || v_acc::TEXT || '/' || p_file_sha256 || '.csv') THEN
    RAISE EXCEPTION 'EVIDENCE_PATH_INVALID: the original must be stored at mp/<account>/<sha256>.csv';
  END IF;
  IF p_file_name IS NULL OR btrim(p_file_name) = '' OR p_byte_size IS NULL OR p_byte_size <= 0 THEN
    RAISE EXCEPTION 'INVALID_FILE_METADATA';
  END IF;
  IF p_coverage_from IS NULL OR p_coverage_to IS NULL OR p_coverage_from > p_coverage_to THEN
    RAISE EXCEPTION 'INVALID_COVERAGE';
  END IF;
  IF p_source_meta IS NULL OR jsonb_typeof(p_source_meta) <> 'object' THEN
    RAISE EXCEPTION 'INVALID_SOURCE_META';
  END IF;
  IF p_reject_reason IS NOT NULL AND btrim(p_reject_reason) = '' THEN
    RAISE EXCEPTION 'REJECT_REASON_BLANK';
  END IF;
  IF (p_reject_reason IS NULL AND p_format_code IS DISTINCT FROM c_format)
     OR (p_reject_reason IS NOT NULL AND (p_format_code IS NOT NULL OR p_rows IS NOT NULL)) THEN
    RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: format_code / rows do not match the reject reason';
  END IF;

  -- ── one MP report ingestion at a time (report rows of different files may overlap) ──
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_mp_release_report_normal', 0));

  -- ── idempotency (§6.1, §12): same attempt, or an effective NORMAL run of these bytes → replay ──
  SELECT * INTO v_run FROM fin_import_run
   WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256 AND mode = 'NORMAL' AND parser_version = p_parser_version;
  IF NOT FOUND THEN
    SELECT * INTO v_run FROM fin_import_run
     WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256 AND mode = 'NORMAL' AND status <> 'REJECTED';
  END IF;
  IF FOUND THEN
    RETURN jsonb_build_object('run_id', v_run.id, 'status', v_run.status, 'replayed', true, 'rows_total', v_run.rows_total,
      'lines_new', v_run.lines_new, 'lines_known', v_run.lines_known, 'rows_ignored', v_run.rows_ignored,
      'rows_invalid', v_run.rows_invalid, 'reject_reason', v_run.reject_reason);
  END IF;
  -- the NORMAL attempt links to the latest attempt over the same bytes (e.g. the VALIDATION run, §9.3)
  SELECT * INTO v_latest FROM fin_import_run
   WHERE financial_account_id = v_acc AND file_sha256 = p_file_sha256
   ORDER BY created_at DESC, id DESC LIMIT 1;

  -- ── pass 1: validate every row with the frozen D1 parser; decide class and identity ──
  IF v_reject IS NULL THEN
    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
      RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: rows must be a JSON array';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
      v_n := v_n + 1;
      IF jsonb_typeof(r) <> 'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM ARRAY['raw_row', 'row_number'] THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: every row is exactly {row_number, raw_row}';
      END IF;
      IF jsonb_typeof(r -> 'row_number') IS DISTINCT FROM 'number' OR (r ->> 'row_number') IS DISTINCT FROM v_n::TEXT THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: row_number must be 1..n in file order';
      END IF;
      v_raw := r -> 'raw_row';
      IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object'
         OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_raw) k) IS DISTINCT FROM c_keys
         OR EXISTS (SELECT 1 FROM jsonb_each(v_raw) x WHERE jsonb_typeof(x.value) <> 'string') THEN
        RAISE EXCEPTION 'INVALID_ROWS_CONTRACT: raw_row must hold exactly the 15 Liberaciones keys as strings';
      END IF;
      v_desc := v_raw ->> 'DESCRIPTION';
      IF v_raw ->> 'SOURCE_ID' = '' AND v_desc = '' THEN
        IF fin_mp_control_row_valid(v_raw) THEN   -- [0080] a control row must itself be well-formed
          v_ctl := v_ctl + 1;
          v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'CONTROL', 'invalid', false);
        ELSE
          v_ninv := v_ninv + 1;
          v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'CONTROL', 'invalid', true,
                                                 'note', 'INVALID_CONTROL_ROW: control row amounts / DATE / empty fields do not match the layout');
        END IF;
        CONTINUE;
      END IF;
      v_moves := v_moves + 1;
      v_invalid := false; v_note := NULL; v_xid := NULL; v_src := NULL;
      v_net := NULL;
      IF (v_raw ->> 'NET_CREDIT_AMOUNT') ~ c_amount AND (v_raw ->> 'NET_DEBIT_AMOUNT') ~ c_amount THEN
        v_net := (v_raw ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (v_raw ->> 'NET_DEBIT_AMOUNT')::NUMERIC;
      END IF;
      v_xid := (v_raw ->> 'SOURCE_ID') || ':' || v_desc || ':' || CASE WHEN v_net > 0 THEN 'C' ELSE 'D' END;
      IF length(v_raw ->> 'SOURCE_ID') > 40 OR length(v_desc) > 40 THEN
        v_invalid := true; v_note := 'IDENTITY_TOO_LONG: SOURCE_ID / DESCRIPTION exceed the identity width';
      ELSE
        v_src.source_type := 'csv_import';
        v_src.external_id := v_xid;
        v_src.event_data := v_raw;
        IF (v_raw ->> 'DATE') ~ c_ts THEN
          v_src.occurred_at := (v_raw ->> 'DATE')::TIMESTAMPTZ;
          v_src.occurred_date := (v_src.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
        END IF;
        SELECT * INTO v_p FROM mp_parse_report_row(v_src);
        IF v_p.o_status = 'ERROR' THEN
          v_invalid := true; v_note := v_p.o_note;
        ELSIF v_desc = 'payment' AND (v_raw ->> 'SOURCE_ID') !~ '^[0-9]{1,20}$' THEN
          v_invalid := true; v_note := 'INVALID_SOURCE_ID: a payment row needs a numeric SOURCE_ID';
        ELSIF v_xid = ANY (v_seen) THEN
          v_invalid := true; v_note := format('DUPLICATE_IDENTITY: %s appears twice in the report', v_xid);
        END IF;
        v_seen := v_seen || v_xid;
      END IF;
      IF v_invalid THEN v_ninv := v_ninv + 1; END IF;
      v_rows := v_rows || jsonb_build_object('n', v_n, 'raw', v_raw, 'class', 'MOVEMENT', 'xid', v_xid, 'invalid', v_invalid,
                                             'note', v_note, 'at', v_src.occurred_at, 'date', v_src.occurred_date);
    END LOOP;
    IF v_ninv > 0 THEN
      v_reject := format('INVALID_ROWS: %s row(s) fail the Liberaciones contract', v_ninv);
    END IF;   -- [0080] a valid report without movement rows is PARSED with 0 effects (owner decision 2026-10-14)
  END IF;

  -- ── REJECTED: the run and its appearances as evidence; nothing reaches mp_source_record ──
  IF v_reject IS NOT NULL THEN
    INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path,
                                file_name, byte_size, coverage_from, coverage_to, status, reject_reason, rows_total, rows_ignored,
                                rows_invalid, source_meta, previous_run_id, created_by)
    VALUES (v_run_id, 'MP_RELEASE_REPORT', 'NORMAL', v_acc, p_format_code, p_parser_version, p_file_sha256, p_storage_path,
            left(p_file_name, 255), p_byte_size, p_coverage_from, p_coverage_to, 'REJECTED', v_reject, v_n, v_n - v_ninv, v_ninv,
            p_source_meta, v_latest.id, p_actor);
    INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, appearance_meta)
    SELECT v_run_id, (x ->> 'n')::INTEGER, 'MP_RELEASE_REPORT', 'NORMAL', x -> 'raw',
           CASE WHEN (x ->> 'invalid')::BOOLEAN THEN 'INVALID' ELSE 'IGNORED' END,
           CASE WHEN (x ->> 'invalid')::BOOLEAN THEN x ->> 'note' ELSE 'RUN_REJECTED' END,
           jsonb_build_object('row_class', x ->> 'class')
      FROM jsonb_array_elements(v_rows) x;
    RETURN jsonb_build_object('run_id', v_run_id, 'status', 'REJECTED', 'replayed', false, 'rows_total', v_n,
      'lines_new', 0, 'lines_known', 0, 'rows_ignored', v_n - v_ninv, 'rows_invalid', v_ninv, 'reject_reason', v_reject,
      'backfills_created', 0, 'backfills_existing', 0, 'yields_applied', 0, 'yields_not_applied', 0);
  END IF;

  -- ── outcome of every movement row (NEW / ALREADY_KNOWN), decided under the lock ──
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) WHERE value ->> 'class' = 'MOVEMENT' LOOP
    IF EXISTS (SELECT 1 FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = e ->> 'xid') THEN
      v_old := v_old + 1;
    ELSE
      v_new := v_new + 1;
    END IF;
  END LOOP;

  INSERT INTO fin_import_run (id, source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path,
                              file_name, byte_size, coverage_from, coverage_to, status, rows_total, lines_new, lines_known,
                              rows_ignored, source_meta, previous_run_id, created_by)
  VALUES (v_run_id, 'MP_RELEASE_REPORT', 'NORMAL', v_acc, p_format_code, p_parser_version, p_file_sha256, p_storage_path,
          left(p_file_name, 255), p_byte_size, p_coverage_from, p_coverage_to, 'PARSED', v_n, v_new, v_old, v_ctl,
          p_source_meta, v_latest.id, p_actor);

  -- ── pass 2: every row → source (if new) → RPC 40 (unchanged) → back-fill / yield application → appearance ──
  FOR e IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    IF e ->> 'class' = 'CONTROL' THEN
      INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, appearance_meta)
      VALUES (v_run_id, (e ->> 'n')::INTEGER, 'MP_RELEASE_REPORT', 'NORMAL', e -> 'raw', 'IGNORED', 'CONTROL_ROW',
              jsonb_build_object('row_class', 'CONTROL'));
      CONTINUE;
    END IF;
    v_review := NULL; v_note := NULL; v_mv := NULL;
    SELECT id INTO v_known FROM mp_source_record WHERE source_type = 'csv_import' AND external_id = e ->> 'xid';
    IF v_known IS NULL THEN
      INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
      VALUES ('csv_import', e ->> 'xid', e -> 'raw', (e ->> 'at')::TIMESTAMPTZ, (e ->> 'date')::DATE)
      RETURNING id INTO v_sid;
      PERFORM mp_normalize_source(v_sid);   -- RPC 40, unchanged: claims / parks / ignores exactly as frozen
      -- yield: the frozen auto-applicable pair (0052) is applied by A1, isolated from the ingestion
      SELECT m.id INTO v_mv FROM mp_financial_movement m WHERE m.mp_source_record_id = v_sid AND m.movement_kind = 'yield';
      IF v_mv IS NOT NULL THEN
        BEGIN
          PERFORM mp_apply_transition(v_mv);
          v_yield := v_yield + 1;
        EXCEPTION WHEN OTHERS THEN
          v_yield_ko := v_yield_ko + 1;
          v_review := 'YIELD_NOT_APPLIED';
          v_note := left(split_part(SQLERRM, ':', 1), 100);
        END;
      END IF;
    ELSE
      v_sid := v_known;
      IF (SELECT event_data FROM mp_source_record WHERE id = v_sid) IS DISTINCT FROM e -> 'raw' THEN
        v_review := 'CONTENT_DIFFERS';
        v_note := 'the report row differs from the stored source with the same identity (stored source kept)';
      END IF;
    END IF;
    -- inbound payment still parked after RPC 40 (not pre-cutover, not ERROR) → report back-fill (idempotent)
    SELECT processing_status INTO v_status FROM mp_source_record WHERE id = v_sid;
    IF e ->> 'xid' LIKE '%:payment:C' AND v_status = 'PENDING' THEN
      v_bf := mp_register_report_backfill(v_sid);
      IF (v_bf ->> 'created')::BOOLEAN THEN v_bf_new := v_bf_new + 1; ELSE v_bf_skip := v_bf_skip + 1; END IF;
    END IF;
    -- [0093] ADR-021: a real outflow (payout / outbound payment) reaches the Mercado Pago balance now — one provisional per
    --        SOURCE_ID, isolated per row (as the yields above); a failure is kept as a review code, never silent
    IF e ->> 'xid' LIKE '%:payout:D' OR e ->> 'xid' LIKE '%:payment:D' THEN
      BEGIN
        v_po := mp_pending_outflow_post(split_part(e ->> 'xid', ':', 1), v_run_id, p_actor);
        IF v_po = 'POSTED' THEN v_prov := v_prov + 1; END IF;
      EXCEPTION WHEN OTHERS THEN
        v_prov_ko := v_prov_ko + 1;
        v_review := 'PROVISIONAL_NOT_POSTED';
        v_note := left(SQLERRM, 160);
      END;
    END IF;
    INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, note, mp_source_record_id,
                                     appearance_meta, review_code)
    VALUES (v_run_id, (e ->> 'n')::INTEGER, 'MP_RELEASE_REPORT', 'NORMAL', e -> 'raw',
            CASE WHEN v_known IS NULL THEN 'NEW' ELSE 'ALREADY_KNOWN' END, v_note, v_sid,
            jsonb_build_object('row_class', 'MOVEMENT'), v_review);
  END LOOP;

  RETURN jsonb_build_object('run_id', v_run_id, 'status', 'PARSED', 'replayed', false, 'rows_total', v_n,
    'lines_new', v_new, 'lines_known', v_old, 'rows_ignored', v_ctl, 'rows_invalid', 0, 'reject_reason', NULL,
    'backfills_created', v_bf_new, 'backfills_existing', v_bf_skip, 'yields_applied', v_yield, 'yields_not_applied', v_yield_ko,
    'provisionals_posted', v_prov, 'provisionals_not_posted', v_prov_ko);   -- [0093]
END;
$$;
ALTER FUNCTION fin_ingest_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_ingest_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fin_ingest_mp_release_report(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, DATE, DATE, JSONB, TEXT, JSONB) TO service_role;

-- ── 7a. Caja → Pendientes de clasificar ───────────────────────────────────────
CREATE OR REPLACE VIEW fin_mp_pending_classification
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT 'OUT:' || p.source_id AS pending_key, p.source_id::TEXT AS source_id, p.kind::TEXT AS kind, 'OUT'::TEXT AS direction,
         p.occurred_date AS business_date, s.occurred_at, p.amount, -m.gross_amount AS economic_amount,
         (m.fee_amount + m.tax_amount) AS charges_amount, a.nombre::TEXT AS account_name,
         CASE p.kind WHEN 'PAYOUT' THEN 'payout' ELSE 'payment' END AS description,
         'PENDING'::TEXT AS status, true AS already_posted, p.provisional_operation_id AS financial_operation_id
    FROM mp_pending_outflow p
    JOIN mp_financial_movement m ON m.id = p.mp_financial_movement_id
    JOIN mp_source_record s ON s.id = m.mp_source_record_id
    JOIN financial_account a ON a.id = p.mp_account_id
   WHERE NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id)
  UNION ALL
  SELECT 'IN:' || t.resource_id, t.resource_id::TEXT, 'CLASSIFY_INFLOW', 'IN', m.occurred_date, ps.occurred_at, m.gross_amount, m.gross_amount,
         (m.fee_amount + m.tax_amount), 'Mercado Pago', 'payment', 'PENDING', false, NULL::BIGINT
    FROM mp_transition_identity t
    JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
    JOIN mp_source_record ps ON ps.id = m.mp_source_record_id
   WHERE t.resource_type = 'payment' AND t.transition = 'APPROVAL' AND t.transition_ref = ''
     AND ps.event_data ->> 'operation_type' = 'account_fund' AND ps.event_data ->> 'payment_method_id' = 'debin_transfer'
     AND NOT EXISTS (SELECT 1 FROM mp_reconciliation rc WHERE rc.mp_financial_movement_id = m.id)
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_pending_classification OWNER TO postgres;
REVOKE ALL    ON fin_mp_pending_classification FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_pending_classification TO authenticated;

-- ── 7b. Revisión técnica: real outflows without any financial effect, report rows in ERROR ──
CREATE OR REPLACE VIEW fin_mp_technical_review
WITH (security_invoker = true)
AS
SELECT u.* FROM (
  SELECT 'UNPOSTED_OUTFLOW'::TEXT AS issue, split_part(s.external_id, ':', 1) AS source_id, split_part(s.external_id, ':', 2) AS description,
         s.occurred_date AS business_date, s.occurred_at,
         ((s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC)::NUMERIC(15,2) AS amount,
         (SELECT l.review_code FROM fin_import_run_line l JOIN fin_import_run r ON r.id = l.run_id
           WHERE l.mp_source_record_id = s.id ORDER BY r.created_at DESC, l.row_number DESC LIMIT 1)::TEXT AS review_code,
         (SELECT left(l.note, 160) FROM fin_import_run_line l JOIN fin_import_run r ON r.id = l.run_id
           WHERE l.mp_source_record_id = s.id ORDER BY r.created_at DESC, l.row_number DESC LIMIT 1)::TEXT AS note
    FROM mp_source_record s
   WHERE s.source_type = 'csv_import' AND (s.external_id LIKE '%:payment:D' OR EXISTS (SELECT 1 FROM mp_transition_identity tp WHERE tp.resource_type = 'report' AND tp.resource_id = s.external_id AND tp.transition = 'PAYOUT'))
     AND s.processing_status NOT IN ('IGNORED', 'ERROR')
     AND (s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC < 0
     AND NOT EXISTS (SELECT 1 FROM mp_transition_identity t JOIN mp_reconciliation r ON r.mp_financial_movement_id = t.mp_financial_movement_id
                      WHERE t.resource_type = 'report' AND t.resource_id = s.external_id)
  UNION ALL
  SELECT 'REPORT_ROW_ERROR', split_part(s.external_id, ':', 1), split_part(s.external_id, ':', 2), s.occurred_date, s.occurred_at,
         CASE WHEN (s.event_data ->> 'NET_CREDIT_AMOUNT') ~ '^-?[0-9]{1,13}(\.[0-9]{1,2})?$' AND (s.event_data ->> 'NET_DEBIT_AMOUNT') ~ '^-?[0-9]{1,13}(\.[0-9]{1,2})?$'
              THEN ((s.event_data ->> 'NET_CREDIT_AMOUNT')::NUMERIC - (s.event_data ->> 'NET_DEBIT_AMOUNT')::NUMERIC)::NUMERIC(15,2) END,
         'REPORT_ROW_ERROR', left(s.processing_note, 160)
    FROM mp_source_record s
   WHERE s.source_type = 'csv_import' AND s.processing_status = 'ERROR'
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_technical_review OWNER TO postgres;
REVOKE ALL    ON fin_mp_technical_review FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_technical_review TO authenticated;

-- ── 7c. official vs ERP per report day (never RECONCILED with a technical exception) ──
CREATE OR REPLACE VIEW fin_mp_report_day_status
WITH (security_invoker = true)
AS
SELECT d.*, (d.erp_close - d.official_close)::NUMERIC(15,2) AS gap,
       CASE WHEN d.technical_count > 0 THEN 'INCOMPLETE'
            WHEN d.official_close IS NULL THEN 'NO_MOVEMENTS'
            WHEN d.erp_close = d.official_close THEN 'RECONCILED'
            ELSE 'GAP' END AS status
  FROM (
    SELECT r.id AS run_id, r.coverage_from, r.coverage_to AS business_date,
           (SELECT (l.raw_row ->> 'BALANCE_AMOUNT')::NUMERIC(15,2) FROM fin_import_run_line l
             WHERE l.run_id = r.id AND l.appearance_meta ->> 'row_class' = 'MOVEMENT'
             ORDER BY (l.raw_row ->> 'DATE')::TIMESTAMPTZ DESC, l.row_number DESC LIMIT 1) AS official_close,
           (SELECT coalesce(sum(p.signed_amount), 0)::NUMERIC(15,2) FROM financial_posting p
             WHERE p.financial_account_id = r.financial_account_id AND p.effective_date <= r.coverage_to) AS erp_close,
           (SELECT count(*) FROM fin_mp_technical_review t WHERE t.business_date BETWEEN r.coverage_from AND r.coverage_to) AS technical_count,
           (SELECT count(*) FROM fin_mp_pending_classification c WHERE c.business_date BETWEEN r.coverage_from AND r.coverage_to) AS pending_count
      FROM fin_import_run r
     WHERE r.source_kind = 'MP_RELEASE_REPORT' AND r.mode = 'NORMAL' AND r.status = 'PARSED'
  ) d
 WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_mp_report_day_status OWNER TO postgres;
REVOKE ALL    ON fin_mp_report_day_status FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_mp_report_day_status TO authenticated;

-- ── 7d. activity view (0090 body; [0093] PENDING_CLASSIFICATION) ──
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
         EXISTS (SELECT 1 FROM mp_pending_outflow po
                  WHERE po.source_id = s.raw_row ->> 'SOURCE_ID'
                    AND po.kind = CASE s.raw_row ->> 'DESCRIPTION' WHEN 'payout' THEN 'PAYOUT' ELSE 'OUTBOUND' END
                    AND (s.raw_row ->> 'DESCRIPTION' = 'payout' OR (s.raw_row ->> 'DESCRIPTION' = 'payment' AND s.external_id LIKE '%:D'))
                    AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution pr WHERE pr.pending_id = po.id)) AS pending_open,   -- [0093]
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
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' AND x.pending_open THEN 'PENDING_CLASSIFICATION'   -- [0093]
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payout' THEN 'PAYOUT'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D' AND x.outflow_classification IS NOT NULL THEN 'CLASSIFIED_OUTFLOW'
         WHEN x.raw_row ->> 'DESCRIPTION' = 'payment' AND x.external_id LIKE '%:D' AND x.pending_open THEN 'PENDING_CLASSIFICATION'   -- [0093]
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
