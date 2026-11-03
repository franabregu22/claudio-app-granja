-- ============================================================================
-- TARGET V1 — 0115 CHEQUES DEBITADOS ANTES DEL CORTE BANCARIO (owner GO "Lote 0115", 2026-11-03)
--
-- An own cheque / eCheq (direction ISSUED) whose real bank debit is a statement line BEFORE the active cut of its account is already
-- inside the opening balance of that cut (the bank balance on the anchor line). mark_supplier_instrument_debited would post the
-- debit again; cancelling would reopen the supplier debt. This lot records that debit without any money movement:
--   1. fin_instrument_precut_debit — the evidence: one row per instrument (its primary key) and per statement line (UNIQUE), the cut
--      it was checked against, the date of the line, the key and the reason. Immutable (fin_evidence_immutable_guard).
--   2. fin_instrument_precut_candidates(instrument) (ADMIN, STABLE): the statement lines that settle that instrument exactly — same
--      account, amount = −line, cheque number = bank reference (leading zeros ignored), on / after the issue date, PRE_CUTOVER under the
--      active cut (BNA: coverage and position, so the order within the anchor's day counts), with no active match and not used.
--   3. fin_mark_instrument_debited_precut(instrument, line, date, key, reason) (ADMIN): re-checks all of the above with the rows
--      locked (the account FOR SHARE, as fin_match_statement_line, so a cut change waits), the date must be the date of the line,
--      the instrument must still be ISSUED. Then: estado DEBITED with that date, one DEBITED instrument event WITHOUT operation, the
--      evidence row, one audit row. NO financial_operation, NO financial_posting: the balance of the account does not move. The
--      supplier account is not touched (the issue already lowered it). Idempotent by key (same instrument and line replay; a key used
--      for another pair is refused). The period of the date must be open (assert_period_open).
--   4. trg_financial_instrument_precut_final: an instrument debited before the cut never leaves DEBITED — reject_supplier_instrument
--      would credit back the account for a debit the ERP never posted.
-- Cheques debited after the cut keep the usual path: mark_supplier_instrument_debited + fin_match_statement_line.
-- No existing row, table or function changes. SECURITY DEFINER set +2.
-- ============================================================================

CREATE TABLE fin_instrument_precut_debit (
  financial_instrument_id UUID          PRIMARY KEY REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  statement_line_id       BIGINT        NOT NULL UNIQUE REFERENCES fin_statement_line(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  cutover_id              BIGINT        NOT NULL REFERENCES fin_statement_cutover(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  debited_date            DATE          NOT NULL,
  idempotency_key         VARCHAR(100)  NOT NULL UNIQUE,
  reason                  TEXT          NOT NULL,
  created_by              UUID          NOT NULL,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_fipd_key    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT chk_fipd_reason CHECK (btrim(reason) <> '')
);
CREATE TRIGGER trg_fin_instrument_precut_debit_immutable BEFORE UPDATE OR DELETE ON fin_instrument_precut_debit
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE fin_instrument_precut_debit ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_instrument_precut_debit OWNER TO postgres;
REVOKE ALL ON TABLE fin_instrument_precut_debit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE fin_instrument_precut_debit TO authenticated;
CREATE POLICY fin_instrument_precut_debit_admin_select ON fin_instrument_precut_debit FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── an instrument debited before the cut stays debited ──────────────────────────────────────────────────────────────────
CREATE FUNCTION fin_instrument_precut_final_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.estado = 'DEBITED' AND NEW.estado IS DISTINCT FROM OLD.estado
     AND EXISTS (SELECT 1 FROM fin_instrument_precut_debit d WHERE d.financial_instrument_id = OLD.id) THEN
    RAISE EXCEPTION 'PRECUT_DEBIT_FINAL: the instrument was debited before the bank cut; its debit is in the opening balance and cannot be reversed here';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION fin_instrument_precut_final_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_instrument_precut_final_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_financial_instrument_precut_final BEFORE UPDATE ON financial_instrument
  FOR EACH ROW EXECUTE FUNCTION fin_instrument_precut_final_guard();

-- ── internal: why a line does or does not settle an instrument before the cut ('OK' or the refusal code) ────────────────
CREATE FUNCTION fin_instrument_precut_check(p_inst financial_instrument, p_line fin_statement_line) RETURNS TEXT
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE
    WHEN p_inst.direction <> 'ISSUED' THEN 'WRONG_DIRECTION'
    WHEN p_inst.estado <> 'ISSUED' THEN 'INVALID_STATE'
    WHEN p_line.financial_account_id IS DISTINCT FROM p_inst.bank_account_id THEN 'LINE_NOT_IN_ACCOUNT'
    WHEN p_line.signed_amount IS DISTINCT FROM -p_inst.amount THEN 'AMOUNT_MISMATCH'
    WHEN coalesce(ltrim(btrim(p_line.bank_reference), '0'), '') = ''
      OR ltrim(btrim(p_line.bank_reference), '0') IS DISTINCT FROM ltrim(btrim(p_inst.cheque_number), '0') THEN 'CHEQUE_NUMBER_MISMATCH'
    WHEN p_line.value_date < p_inst.issued_date THEN 'DEBIT_BEFORE_ISSUE'
    WHEN fin_statement_line_cut_class(p_line.id) IS DISTINCT FROM 'PRE_CUTOVER' THEN 'NOT_PRE_CUTOVER'
    WHEN EXISTS (SELECT 1 FROM fin_statement_match m WHERE m.statement_line_id = p_line.id AND m.reversed_at IS NULL)
      OR EXISTS (SELECT 1 FROM fin_statement_charge_booking b WHERE b.statement_line_id = p_line.id)
      OR EXISTS (SELECT 1 FROM fin_instrument_precut_debit d WHERE d.statement_line_id = p_line.id) THEN 'LINE_ALREADY_USED'
    ELSE 'OK'
  END
$$;
ALTER FUNCTION fin_instrument_precut_check(financial_instrument, fin_statement_line) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_instrument_precut_check(financial_instrument, fin_statement_line) FROM PUBLIC, anon, authenticated, service_role;

-- ── RPC: the lines that settle one instrument before the cut (read only) ────────────────────────────────────────────────
CREATE FUNCTION fin_instrument_precut_candidates(p_instrument_id UUID)
RETURNS TABLE (statement_line_id BIGINT, value_date DATE, description_raw TEXT, bank_reference TEXT, signed_amount NUMERIC, running_balance NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inst financial_instrument;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  RETURN QUERY
  SELECT l.id, l.value_date, l.description_raw, l.bank_reference::TEXT, l.signed_amount, l.running_balance
    FROM fin_statement_line l
   WHERE l.financial_account_id = v_inst.bank_account_id
     AND l.signed_amount = -v_inst.amount
     AND fin_instrument_precut_check(v_inst, l) = 'OK'
   ORDER BY l.value_date, l.id;
END $$;
ALTER  FUNCTION fin_instrument_precut_candidates(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_instrument_precut_candidates(UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_instrument_precut_candidates(UUID) TO authenticated;

-- ── RPC: mark the instrument debited before the cut (no money moves) ────────────────────────────────────────────────────
CREATE FUNCTION fin_mark_instrument_debited_precut(p_instrument_id UUID, p_statement_line_id BIGINT, p_debited_date DATE,
                                                   p_idempotency_key VARCHAR, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_key    TEXT := btrim(p_idempotency_key);
  v_prev   fin_instrument_precut_debit;
  v_inst   financial_instrument;
  v_line   fin_statement_line;
  v_acc    financial_account;
  v_cut    BIGINT;
  v_check  TEXT;
  v_reason TEXT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF v_key IS NULL OR v_key = '' OR length(v_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fin_instrument_precut:' || v_key, 0));

  -- replay: the same key settles the same instrument with the same line once
  SELECT * INTO v_prev FROM fin_instrument_precut_debit WHERE idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.financial_instrument_id = p_instrument_id AND v_prev.statement_line_id = p_statement_line_id THEN
      RETURN jsonb_build_object('replayed', true, 'instrument_id', p_instrument_id, 'statement_line_id', p_statement_line_id,
                                'debited_date', v_prev.debited_date, 'estado', 'DEBITED');
    END IF;
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED: the key settled another instrument or line';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  SELECT * INTO v_line FROM fin_statement_line WHERE id = p_statement_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LINE_NOT_FOUND';
  END IF;
  -- the cut cannot change while this is decided (fin_resolve_statement_cutover takes NO KEY UPDATE on the same row)
  SELECT * INTO v_acc FROM financial_account WHERE id = v_line.financial_account_id FOR SHARE;
  IF p_debited_date IS DISTINCT FROM v_line.value_date THEN
    RAISE EXCEPTION 'DEBIT_DATE_MISMATCH: the bank debited on %', v_line.value_date;
  END IF;
  v_check := fin_instrument_precut_check(v_inst, v_line);
  IF v_check = 'INVALID_STATE' THEN
    RAISE EXCEPTION 'INVALID_STATE: expected ISSUED, found %', v_inst.estado;
  ELSIF v_check <> 'OK' THEN
    RAISE EXCEPTION '%: line % / instrument %', v_check, v_line.id, coalesce(v_inst.cheque_number, v_inst.id::text);
  END IF;
  PERFORM assert_period_open(v_line.value_date);
  SELECT id INTO v_cut FROM fin_statement_cutover WHERE financial_account_id = v_line.financial_account_id AND superseded_at IS NULL;

  v_reason := 'Débito anterior al corte: ' || v_line.description_raw || ' · ' || v_acc.nombre || ' ' || to_char(v_line.value_date, 'DD/MM/YYYY')
              || ' · línea ' || v_line.id || coalesce(' · ' || nullif(btrim(p_reason), ''), '');

  UPDATE financial_instrument SET estado = 'DEBITED', debited_date = v_line.value_date WHERE id = v_inst.id;
  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date, financial_operation_id, reason, created_by)
  VALUES (v_inst.id, 'DEBITED', v_line.value_date, NULL, v_reason, v_uid);
  INSERT INTO fin_instrument_precut_debit (financial_instrument_id, statement_line_id, cutover_id, debited_date, idempotency_key, reason, created_by)
  VALUES (v_inst.id, v_line.id, v_cut, v_line.value_date, v_key, v_reason, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', v_inst.id::TEXT, 'DEBIT_PRE_CUTOVER', jsonb_build_object('estado', 'ISSUED'),
          jsonb_build_object('estado', 'DEBITED', 'debited_date', v_line.value_date, 'statement_line_id', v_line.id, 'cutover_id', v_cut, 'amount', v_inst.amount),
          v_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'instrument_id', v_inst.id, 'statement_line_id', v_line.id, 'debited_date', v_line.value_date, 'estado', 'DEBITED');
END;
$$;
ALTER  FUNCTION fin_mark_instrument_debited_precut(UUID, BIGINT, DATE, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_mark_instrument_debited_precut(UUID, BIGINT, DATE, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_mark_instrument_debited_precut(UUID, BIGINT, DATE, VARCHAR, TEXT) TO authenticated;
