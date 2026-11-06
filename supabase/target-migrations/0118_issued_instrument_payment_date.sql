-- ============================================================================
-- TARGET V1 — 0118 CHEQUES: FECHA DE PAGO CORREGIBLE ANTES DEL DÉBITO (owner GO 2026-11-06, mejoras acumuladas de Caja)
--
-- reschedule_issued_instrument (ADMIN): corrects the payment date (maturity_date) of an own cheque / eCheq that is still ISSUED
-- (not debited, cancelled or rejected). It changes ONLY that date: no amount, supplier, account, balance, posting, supplier-ledger
-- or instrument event changes (the payment calendar reads the date, so it moves there). Reason required; one audit_events row per
-- correction: action RESCHEDULE_PAYMENT_DATE, the date before and after, the reason and the user (performed_at = when).
-- SECURITY DEFINER set +1.
-- ============================================================================

CREATE FUNCTION reschedule_issued_instrument(
  p_instrument_id     UUID,
  p_new_maturity_date DATE,
  p_reason            TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_inst financial_instrument%ROWTYPE;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN RAISE EXCEPTION 'FORBIDDEN: ADMIN required'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF p_new_maturity_date IS NULL THEN RAISE EXCEPTION 'DATE_REQUIRED'; END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND'; END IF;
  IF v_inst.direction::text <> 'ISSUED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION: only an own (issued) cheque or eCheq has its payment date corrected here';
  END IF;
  IF v_inst.estado::text <> 'ISSUED' THEN
    RAISE EXCEPTION 'INVALID_STATE: only a cheque not yet debited, cancelled or rejected can change its payment date, found %', v_inst.estado;
  END IF;
  IF v_inst.issued_date IS NOT NULL AND p_new_maturity_date < v_inst.issued_date THEN
    RAISE EXCEPTION 'DATE_BEFORE_ISSUE: the payment date cannot be before the issue date %', v_inst.issued_date;
  END IF;
  IF p_new_maturity_date IS NOT DISTINCT FROM v_inst.maturity_date THEN
    RAISE EXCEPTION 'NOTHING_TO_CHANGE: the payment date is already %', p_new_maturity_date;
  END IF;

  UPDATE financial_instrument SET maturity_date = p_new_maturity_date WHERE id = p_instrument_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'RESCHEDULE_PAYMENT_DATE',
          jsonb_build_object('maturity_date', v_inst.maturity_date),
          jsonb_build_object('maturity_date', p_new_maturity_date),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'previous_maturity_date', v_inst.maturity_date,
                            'maturity_date', p_new_maturity_date);
END $$;
ALTER FUNCTION reschedule_issued_instrument(UUID, DATE, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION reschedule_issued_instrument(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION reschedule_issued_instrument(UUID, DATE, TEXT) TO authenticated;
