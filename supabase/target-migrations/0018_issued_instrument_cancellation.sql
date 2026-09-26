-- ============================================================================
-- TARGET V1 — 0018 ISSUED INSTRUMENT CANCELLATION (Phase 16, ADR-001)
-- Authority: .planning/adr/ADR-001_ISSUED_INSTRUMENT_CANCELLATION.md (ACCEPTED)
--            RPC_CONTRACTS_V1.md 42 cancel_supplier_instrument          [ADR-001]
--            POSTGRES_SCHEMA_SPEC_V1.md financial_instrument.cancelled_date [ADR-001]
--            DATABASE_INVARIANTS_V1.md 12, 18, 19                          [ADR-001]
--
-- Makes the frozen transition ISSUED → CANCELLED executable. 0015–0017 are
-- untouched: the column and CHECK are added by ALTER, the RPC is new.
--
-- Economics: the issuer voids an instrument that was never debited. Supplier
-- debt reopens (+amount REVERSAL of the single INSTRUMENT_ISSUED entry); no
-- money moves (no financial_operation, no financial_posting).
-- ============================================================================

-- ── D3: period determinant + bidirectional coherence ───────────────────────
-- Existing rows: none is CANCELLED and none carries a cancelled_date, so the
-- CHECK validates immediately.

ALTER TABLE financial_instrument ADD COLUMN cancelled_date DATE;

ALTER TABLE financial_instrument ADD CONSTRAINT chk_instrument_cancelled_coherent CHECK (
  (estado = 'CANCELLED' AND cancelled_date IS NOT NULL)
  OR (estado <> 'CANCELLED' AND cancelled_date IS NULL));

-- ── D1 + D2: RPC 42 cancel_supplier_instrument ─────────────────────────────

CREATE OR REPLACE FUNCTION cancel_supplier_instrument(
  p_instrument_id  UUID,
  p_cancelled_date DATE,
  p_reason         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_inst         financial_instrument;
  v_issued_count INTEGER;
  v_issued_id    BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_inst FROM financial_instrument WHERE id = p_instrument_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSTRUMENT_NOT_FOUND';
  END IF;
  IF v_inst.direction <> 'ISSUED' THEN
    RAISE EXCEPTION 'WRONG_DIRECTION: cancellation applies to issued instruments';
  END IF;
  IF v_inst.estado <> 'ISSUED' THEN
    RAISE EXCEPTION 'INVALID_STATE: only an ISSUED (not yet debited) instrument can be cancelled, found %', v_inst.estado;
  END IF;

  PERFORM assert_period_open(p_cancelled_date);

  -- provenance resolved BEFORE any write: exactly one original issuance entry
  SELECT count(*), min(id) INTO v_issued_count, v_issued_id
    FROM supplier_ledger
   WHERE supplier_id = v_inst.supplier_id
     AND movement_type = 'INSTRUMENT_ISSUED'
     AND source_entity_type = 'financial_instrument'
     AND source_entity_id = p_instrument_id::TEXT;
  IF v_issued_count <> 1 THEN
    RAISE EXCEPTION 'ISSUANCE_LEDGER_INCONSISTENT: expected exactly 1 INSTRUMENT_ISSUED entry for instrument %, found %',
      p_instrument_id, v_issued_count;
  END IF;

  UPDATE financial_instrument SET estado = 'CANCELLED', cancelled_date = p_cancelled_date
   WHERE id = p_instrument_id;

  -- the issuance never settled the obligation: supplier debt reopens by reversing it
  INSERT INTO supplier_ledger (supplier_id, movement_type, signed_amount, effective_date,
         source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
  VALUES (v_inst.supplier_id, 'REVERSAL', v_inst.amount, p_cancelled_date,
          'financial_instrument', p_instrument_id::TEXT, v_issued_id, p_reason, v_uid);

  -- no financial_operation, no financial_posting: the bank was never debited

  INSERT INTO financial_instrument_event (financial_instrument_id, event_type, event_date,
         financial_operation_id, reason, created_by)
  VALUES (p_instrument_id, 'CANCELLED', p_cancelled_date, NULL, p_reason, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('financial_instrument', p_instrument_id::TEXT, 'CANCEL_ISSUED',
          jsonb_build_object('estado', 'ISSUED'),
          jsonb_build_object('estado', 'CANCELLED', 'cancelled_date', p_cancelled_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('instrument_id', p_instrument_id, 'estado', 'CANCELLED',
                            'cancelled_date', p_cancelled_date);
END;
$$;

ALTER  FUNCTION cancel_supplier_instrument(UUID, DATE, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION cancel_supplier_instrument(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION cancel_supplier_instrument(UUID, DATE, TEXT) TO authenticated;
