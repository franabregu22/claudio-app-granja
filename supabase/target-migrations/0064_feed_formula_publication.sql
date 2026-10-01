-- ============================================================================
-- TARGET V1 — 0064 FEED FORMULA PUBLICATION (ADR-013, owner decisions
-- D-FEED-1…5, Phase 27 acceptance fixes block 4)
--
--   * RPC 48 publish_feed_formula_version: the ONLY write path for formula
--     versions and lines. Atomic: version + every line, or nothing.
--   * One effective version per feed type on any date: EXCLUDE constraint over
--     (feed_type_id, [effective_from, effective_to]). Publishing at D closes the
--     open prior version at D − 1. A version starting on or before the latest
--     existing start is refused (fail closed: no replacement rule).
--   * Closing never cuts a version still used by manufacturing on/after D.
--   * Direct INSERT on feed_formula_version / feed_formula_line is revoked from
--     authenticated (the policies are dropped). Used-version line immutability
--     (trigger of 0029) is unchanged.
--   * register_feed_manufacturing refuses a version with no lines
--     (FORMULA_VERSION_EMPTY).
-- ============================================================================

-- ── one effective version per feed type ─────────────────────────────────────
ALTER TABLE feed_formula_version
  ADD CONSTRAINT excl_feed_formula_version_no_overlap
  EXCLUDE USING gist (feed_type_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);

-- ── direct writes are no longer an application write path ───────────────────
DROP POLICY IF EXISTS feed_formula_version_admin_insert ON feed_formula_version;
DROP POLICY IF EXISTS feed_formula_line_admin_insert    ON feed_formula_line;
REVOKE INSERT, UPDATE, DELETE ON feed_formula_version FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON feed_formula_line    FROM authenticated;

-- ── RPC 48 publish_feed_formula_version ─────────────────────────────────────
-- p_lines: [{ingredient_id, quantity_kg, unit_cost_snapshot?}]
CREATE OR REPLACE FUNCTION publish_feed_formula_version(
  p_feed_type_id   UUID,
  p_effective_from DATE,
  p_lines          JSONB,
  p_reason         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_line       JSONB;
  v_ingredient UUID;
  v_qty        NUMERIC;
  v_cost       NUMERIC;
  v_seen       UUID[] := '{}';
  v_prev       feed_formula_version;
  v_version    INTEGER;
  v_new_id     UUID;
  v_count      INTEGER := 0;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_effective_from IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM feed_type WHERE id = p_feed_type_id AND activo = true) THEN
    RAISE EXCEPTION 'FEED_TYPE_NOT_FOUND_OR_INACTIVE';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'EMPTY_LINE_SET';
  END IF;

  -- validate every line before any write
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_ingredient := (v_line->>'ingredient_id')::UUID;
    v_qty        := (v_line->>'quantity_kg')::NUMERIC;
    v_cost       := (v_line->>'unit_cost_snapshot')::NUMERIC;
    IF v_ingredient IS NULL OR NOT EXISTS (SELECT 1 FROM feed_ingredient WHERE id = v_ingredient AND activo = true) THEN
      RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: %', v_ingredient;
    END IF;
    IF v_ingredient = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_INGREDIENT: %', v_ingredient;
    END IF;
    v_seen := v_seen || v_ingredient;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> round(v_qty, 3) OR v_qty >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost <> round(v_cost, 2) OR v_cost >= 1e13) THEN
      RAISE EXCEPTION 'INVALID_COST';
    END IF;
  END LOOP;

  -- serialize publications of the same feed type
  PERFORM 1 FROM feed_type WHERE id = p_feed_type_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM feed_formula_version WHERE feed_type_id = p_feed_type_id AND effective_from >= p_effective_from) THEN
    RAISE EXCEPTION 'FORMULA_VERSION_DATE_CONFLICT: a version of this feed type already starts on or after %', p_effective_from;
  END IF;

  -- the version open on (or covering) D is closed at D − 1
  SELECT * INTO v_prev FROM feed_formula_version
   WHERE feed_type_id = p_feed_type_id
     AND (effective_to IS NULL OR effective_to >= p_effective_from)
   ORDER BY effective_from DESC LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM feed_manufacturing
                WHERE formula_version_id = v_prev.id AND manufacturing_date >= p_effective_from) THEN
      RAISE EXCEPTION 'FORMULA_VERSION_USED_AFTER_DATE: version % has manufacturing on or after %', v_prev.version, p_effective_from;
    END IF;
    UPDATE feed_formula_version SET effective_to = p_effective_from - 1 WHERE id = v_prev.id;
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_version FROM feed_formula_version WHERE feed_type_id = p_feed_type_id;

  INSERT INTO feed_formula_version (feed_type_id, version, effective_from, effective_to, created_by)
  VALUES (p_feed_type_id, v_version, p_effective_from, NULL, v_uid)
  RETURNING id INTO v_new_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg, unit_cost_snapshot)
    VALUES (v_new_id, (v_line->>'ingredient_id')::UUID, (v_line->>'quantity_kg')::NUMERIC, (v_line->>'unit_cost_snapshot')::NUMERIC);
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_formula_version', v_new_id::TEXT, 'PUBLISH',
          jsonb_build_object('feed_type_id', p_feed_type_id, 'version', v_version, 'effective_from', p_effective_from,
                             'line_count', v_count, 'closed_version_id', v_prev.id,
                             'closed_effective_to', CASE WHEN v_prev.id IS NULL THEN NULL ELSE p_effective_from - 1 END),
          p_reason, v_uid);

  RETURN jsonb_build_object('formula_version_id', v_new_id, 'version', v_version, 'line_count', v_count,
                            'closed_version_id', v_prev.id);
END;
$$;

ALTER  FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT) TO authenticated;

-- ── RPC 26 register_feed_manufacturing: refuse an empty version (ADR-013) ───
CREATE OR REPLACE FUNCTION register_feed_manufacturing(
  p_formula_version_id UUID,
  p_manufacturing_date DATE,
  p_quantity_kg        DECIMAL,
  p_idempotency_key    VARCHAR,
  p_batch_number       VARCHAR DEFAULT NULL,
  p_reason             TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid              UUID := auth.uid();
  v_role             TEXT;
  v_fv               feed_formula_version;
  v_manufacturing_id UUID;
BEGIN
  v_role := current_app_role();                    -- raises if the user is unknown or inactive
  IF p_quantity_kg IS NULL OR p_quantity_kg <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF EXISTS (SELECT 1 FROM feed_manufacturing WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_MANUFACTURING';
  END IF;

  SELECT * INTO v_fv FROM feed_formula_version WHERE id = p_formula_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FORMULA_VERSION_NOT_FOUND';
  END IF;
  IF p_manufacturing_date < v_fv.effective_from
     OR (v_fv.effective_to IS NOT NULL AND p_manufacturing_date > v_fv.effective_to) THEN
    RAISE EXCEPTION 'FORMULA_VERSION_NOT_EFFECTIVE: version is not effective on %', p_manufacturing_date;
  END IF;
  -- [ADR-013] a version without composition is never manufactured
  IF NOT EXISTS (SELECT 1 FROM feed_formula_line WHERE formula_version_id = p_formula_version_id) THEN
    RAISE EXCEPTION 'FORMULA_VERSION_EMPTY';
  END IF;

  PERFORM assert_period_open(p_manufacturing_date);

  PERFORM pg_advisory_xact_lock(hashtext('feed_formula_version'), hashtext(p_formula_version_id::TEXT));

  BEGIN
    INSERT INTO feed_manufacturing (formula_version_id, manufacturing_date, quantity_kg,
                                    batch_number, idempotency_key, created_by)
    VALUES (p_formula_version_id, p_manufacturing_date, p_quantity_kg,
            p_batch_number, p_idempotency_key, v_uid)
    RETURNING id INTO v_manufacturing_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_MANUFACTURING';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_manufacturing', v_manufacturing_id::TEXT, 'CREATE',
          jsonb_build_object('formula_version_id', p_formula_version_id,
                             'manufacturing_date', p_manufacturing_date,
                             'quantity_kg', p_quantity_kg),
          p_reason, v_uid);

  RETURN jsonb_build_object('manufacturing_id', v_manufacturing_id, 'quantity_kg', p_quantity_kg);
END;
$$;
