-- ============================================================================
-- TARGET V1 — 0053 MERCADO PAGO AUTO ATTRIBUTION (ADR-006, Step 8 closure, POST-V-2)
-- Authority: ADR006_RPC_CONTRACTS_V1 C2 (deterministic evidence only) and C1 steps 5–6 /
--            writes; ADR006_V2_PAYMENT_FIELD_EVIDENCE (payer.id is opaque text;
--            external_reference optional).
--
-- Redefines ONLY mp_auto_allocate (same signature, SECURITY DEFINER, OWNER postgres,
-- service_role EXECUTE only — the 0048 grants are restated unchanged). The 0048 PRE-V-2 form
-- always returned NO_EVIDENCE; this form derives evidence from the claiming api_payment
-- snapshot of the payment / APPROVAL movement:
--   (a) external_reference exactly 'GST:C:<uuid>' → that client (when it exists);
--       exactly 'GST:P:<uuid>' → pedidos.cliente_id of that pedido (when it exists);
--       any other value, or null → no candidate from this axis.
--   (b) payload->'payer'->>'id' (opaque text; no cast) = mp_payer_client_map.mp_payer_id of the
--       ACTIVE mapping, exact text equality → the mapped client.
-- Candidate set = DISTINCT client ids of (a) ∪ (b). NONE results ({allocated:false, reason})
-- write nothing and raise nothing; structural failures (NOT_A_RECEIPT, RECEIPT_NOT_POSTED,
-- PERIOD_NOT_FOUND) still raise. No client parameter exists.
-- Writes (as C1, created_by NULL): client_ledger COLLECTION −bound; mp_client_allocation
-- ALLOCATION / AUTO, key MPAUTO:{approval transition id}; open attribution flag cleared;
-- audit MP_CLIENT_ALLOCATION. Never collections, financial_operation or financial_posting.
-- ============================================================================

CREATE OR REPLACE FUNCTION mp_auto_allocate(
  p_movement_id BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason   CONSTANT TEXT := 'ADR-006 auto-attribution';
  v_uuid_re  CONSTANT TEXT := '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
  v_mv       mp_financial_movement;
  v_tr       mp_transition_identity;
  v_src_st   mp_processing_status;
  v_assigned NUMERIC(15,2);
  v_payload  JSONB;
  v_extref   TEXT;
  v_payer    TEXT;
  v_ref_cli  UUID;
  v_map_id   UUID;
  v_map_cli  UUID;
  v_n        INTEGER;
  v_cliente  UUID;
  v_client   TEXT;
  v_period   management_period;
  v_active   NUMERIC(15,2);
  v_bound    NUMERIC(15,2);
  v_evidence JSONB := '{}'::JSONB;
  v_key      VARCHAR;
  v_alloc    UUID := gen_random_uuid();
  v_ledger   BIGINT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'FORBIDDEN: backend service role required';
  END IF;

  -- C1 steps 5–6
  SELECT * INTO v_mv FROM mp_financial_movement WHERE id = p_movement_id FOR UPDATE;   -- L5
  SELECT * INTO v_tr FROM mp_transition_identity WHERE mp_financial_movement_id = p_movement_id;
  IF v_mv.id IS NULL OR v_mv.movement_kind <> 'payment' OR v_tr.transition IS DISTINCT FROM 'APPROVAL' THEN
    RAISE EXCEPTION 'NOT_A_RECEIPT';
  END IF;
  SELECT processing_status INTO v_src_st FROM mp_source_record WHERE id = v_mv.mp_source_record_id;
  SELECT coalesce(sum(assigned_amount), 0) INTO v_assigned FROM mp_reconciliation WHERE mp_financial_movement_id = p_movement_id;
  IF v_src_st = 'ERROR' OR v_assigned <> v_mv.net_amount THEN
    RAISE EXCEPTION 'RECEIPT_NOT_POSTED';
  END IF;

  v_key := 'MPAUTO:' || v_tr.id;
  IF EXISTS (SELECT 1 FROM mp_client_allocation WHERE idempotency_key = v_key) THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'ALREADY_ALLOCATED');
  END IF;

  -- evidence: the claiming api_payment snapshot only (a report-fallback claim carries none)
  SELECT event_data INTO v_payload
    FROM mp_source_record WHERE id = v_tr.claimed_by_source_id AND source_type = 'api_payment';

  IF jsonb_typeof(v_payload -> 'external_reference') = 'string' THEN
    v_extref := v_payload ->> 'external_reference';
    IF v_extref ~ ('^GST:C:' || v_uuid_re || '$') THEN
      SELECT id INTO v_ref_cli FROM clients WHERE id = substr(v_extref, 7)::UUID;
    ELSIF v_extref ~ ('^GST:P:' || v_uuid_re || '$') THEN
      SELECT cliente_id INTO v_ref_cli FROM pedidos WHERE id = substr(v_extref, 7)::UUID;
    END IF;
  END IF;

  IF jsonb_typeof(v_payload -> 'payer' -> 'id') IN ('string', 'number') THEN
    v_payer := v_payload -> 'payer' ->> 'id';
    SELECT id, cliente_id INTO v_map_id, v_map_cli
      FROM mp_payer_client_map WHERE mp_payer_id = v_payer AND activo;
  END IF;

  SELECT count(DISTINCT c) INTO v_n FROM unnest(ARRAY[v_ref_cli, v_map_cli]) c WHERE c IS NOT NULL;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'NO_EVIDENCE');
  ELSIF v_n > 1 THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'AMBIGUOUS_EVIDENCE');
  END IF;
  v_cliente := coalesce(v_ref_cli, v_map_cli);
  IF v_ref_cli IS NOT NULL THEN
    v_evidence := v_evidence || jsonb_build_object('external_reference', v_extref);
  END IF;
  IF v_map_cli IS NOT NULL THEN
    v_evidence := v_evidence || jsonb_build_object('payer_map_id', v_map_id);
  END IF;

  SELECT nombre INTO v_client FROM clients WHERE id = v_cliente AND activo = true;
  IF v_client IS NULL THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'CLIENT_INACTIVE');
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_active FROM mp_client_allocation WHERE mp_financial_movement_id = p_movement_id;
  IF v_active <> 0 THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'ALREADY_ATTRIBUTED');
  END IF;

  -- L6 without raising on CLOSED (NONE state); a missing period is structural and raises
  SELECT * INTO v_period FROM management_period
   WHERE periodo_fecha = date_trunc('month', v_mv.occurred_date)::DATE FOR UPDATE;
  IF FOUND AND v_period.status <> 'OPEN' THEN
    RETURN jsonb_build_object('allocated', false, 'reason', 'PERIOD_CLOSED');
  END IF;
  PERFORM assert_period_open(v_mv.occurred_date);

  -- bound = effective applied receipt (identical to C1)
  SELECT v_mv.gross_amount - coalesce(sum(abs(m2.gross_amount)), 0) INTO v_bound
    FROM mp_transition_identity t2
    JOIN mp_financial_movement m2 ON m2.id = t2.mp_financial_movement_id
   WHERE t2.resource_type = v_tr.resource_type AND t2.resource_id = v_tr.resource_id
     AND t2.transition IN ('REFUND', 'CHARGEBACK')
     AND EXISTS (SELECT 1 FROM mp_reconciliation r
                  WHERE r.mp_financial_movement_id = m2.id AND r.idempotency_key = 'MPA:' || t2.id || ':SETTLE');
  IF v_bound <= 0 THEN
    RAISE EXCEPTION 'ALLOCATION_EXCEEDS_RECEIPT: effective receipt % leaves nothing to attribute', v_bound;
  END IF;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name,
                             source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_cliente, 'COLLECTION', -v_bound, v_mv.occurred_date, v_client,
          'mp_client_allocation', v_alloc::TEXT, v_reason, NULL)
  RETURNING id INTO v_ledger;

  INSERT INTO mp_client_allocation (id, mp_financial_movement_id, cliente_id, amount, origin, mode, effective_date,
                                    evidence, idempotency_key, client_ledger_id, reason, created_by)
  VALUES (v_alloc, p_movement_id, v_cliente, v_bound, 'ALLOCATION', 'AUTO', v_mv.occurred_date,
          v_evidence, v_key, v_ledger, v_reason, NULL);

  UPDATE mp_attribution_flag
     SET cleared_by = NULL, cleared_at = NOW(), clear_reason = 'FULLY_ASSIGNED'
   WHERE mp_financial_movement_id = p_movement_id AND cleared_at IS NULL;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_client_allocation', v_alloc::TEXT, 'MP_CLIENT_ALLOCATION',
          jsonb_build_object('movement_id', p_movement_id, 'cliente_id', v_cliente, 'amount', v_bound,
                             'mode', 'AUTO', 'client_ledger_id', v_ledger, 'evidence', v_evidence),
          v_reason, NULL);

  RETURN jsonb_build_object('allocated', true, 'allocation_id', v_alloc, 'client_ledger_id', v_ledger,
                            'cliente_id', v_cliente, 'amount', v_bound, 'effective_receipt', v_bound);
END;
$$;

ALTER FUNCTION mp_auto_allocate(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_auto_allocate(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mp_auto_allocate(BIGINT) TO service_role;
