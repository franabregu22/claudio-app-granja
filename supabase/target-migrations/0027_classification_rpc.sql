-- ============================================================================
-- TARGET V1 — 0027 CLASSIFICATION RPC (Phase 19)
-- Authority: RPC_CONTRACTS_V1.md 25 register_classification
--            RLS_IMPLEMENTATION_SPEC_V1.md §8 (RPC 25 is the only writer)
--
-- OPERATOR or ADMIN. No flock parameter exists or is accepted, and no
-- operator_assignments check applies: classification has no flock. No
-- ledger, no posting. One transaction per call.
--
-- Technical completions (contract behaviour unchanged; each is tested):
--   * NULL / non-array p_lines is EMPTY_LINE_SET (jsonb_array_length(NULL)
--     would otherwise be NULL and skip the check).
--   * NULL line quantity is INVALID_QUANTITY (NULL < 0 would otherwise pass).
--   * A grade repeated inside one p_lines set is rejected up front, before any
--     write, with DUPLICATE_GRADE_IN_SESSION. The frozen schema already rejects
--     it through UNIQUE(classification_id, classification_grade_id); this only
--     replaces the raw unique_violation with a clear error. Quantities are
--     never merged.
--   * A concurrent retry with the same idempotency_key that passes the EXISTS
--     pre-check and hits the UNIQUE index is reported as DUPLICATE_CLASSIFICATION.
--   * A NULL idempotency_key or classification_date is rejected by the
--     frozen NOT NULL column / the Foundation guard (BUSINESS_DATE_REQUIRED).
-- ============================================================================

CREATE OR REPLACE FUNCTION register_classification(
  p_idempotency_key     UUID,
  p_classification_date DATE,
  p_lines               JSONB,
  p_location            VARCHAR DEFAULT NULL,
  p_reason              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid               UUID := auth.uid();
  v_role              TEXT;
  v_line              JSONB;
  v_qty               INTEGER;
  v_grade             UUID;
  v_seen              UUID[] := '{}';
  v_classification_id UUID;
  v_line_count        INTEGER := 0;
  v_total             BIGINT := 0;
BEGIN
  v_role := current_app_role();                    -- raises if the user is unknown or inactive
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'EMPTY_LINE_SET';
  END IF;

  IF EXISTS (SELECT 1 FROM classification WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_CLASSIFICATION';
  END IF;

  PERFORM assert_period_open(p_classification_date);

  -- validate the complete line set before any write
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_qty   := (v_line->>'quantity')::INTEGER;
    v_grade := (v_line->>'classification_grade_id')::UUID;
    IF v_qty IS NULL OR v_qty < 0 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM classification_grade WHERE id = v_grade AND activo = true) THEN
      RAISE EXCEPTION 'GRADE_NOT_FOUND: %', v_grade;
    END IF;
    IF v_grade = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_GRADE_IN_SESSION: grade % appears more than once', v_grade;
    END IF;
    v_seen := v_seen || v_grade;
  END LOOP;

  BEGIN
    INSERT INTO classification (idempotency_key, classification_date, location, created_by)
    VALUES (p_idempotency_key, p_classification_date, p_location, v_uid)
    RETURNING id INTO v_classification_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_CLASSIFICATION';
  END;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO classification_line (classification_id, classification_grade_id, quantity)
    VALUES (v_classification_id, (v_line->>'classification_grade_id')::UUID, (v_line->>'quantity')::INTEGER);
    v_line_count := v_line_count + 1;
    v_total := v_total + (v_line->>'quantity')::INTEGER;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('classification', v_classification_id::TEXT, 'CREATE',
          jsonb_build_object('classification_date', p_classification_date,
                             'line_count', jsonb_array_length(p_lines)),
          p_reason, v_uid);

  RETURN jsonb_build_object('classification_id', v_classification_id, 'line_count', v_line_count,
                            'total_quantity', v_total);
END;
$$;

ALTER  FUNCTION register_classification(UUID, DATE, JSONB, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_classification(UUID, DATE, JSONB, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_classification(UUID, DATE, JSONB, VARCHAR, TEXT) TO authenticated;
