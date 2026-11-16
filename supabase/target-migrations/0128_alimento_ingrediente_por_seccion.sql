-- ============================================================================
-- TARGET V1 — 0128 ALIMENTO: UN INGREDIENTE POR SECCIÓN (owner 2026-11-16)
--
--   Most recipes carry the same ingredient (e.g. carbonato de calcio) in Premezcla AND in
--   Macronutrientes. A formula version may now hold an ingredient once PER SECTION:
--   * feed_formula_line: UNIQUE (formula_version_id, ingredient_id) → (formula_version_id,
--     ingredient_id, section).
--   * publish_feed_formula_version (0125 body, same identity): the duplicate check is keyed by
--     ingredient + section.
--   The cost views already sum every line (each line at its ingredient cost): unchanged.
--   No data is written by this migration.
-- ============================================================================

ALTER TABLE feed_formula_line DROP CONSTRAINT feed_formula_line_formula_version_id_ingredient_id_key;
ALTER TABLE feed_formula_line ADD CONSTRAINT feed_formula_line_version_ingredient_section_key UNIQUE (formula_version_id, ingredient_id, section);

CREATE OR REPLACE FUNCTION publish_feed_formula_version(
  p_feed_type_id   UUID,
  p_effective_from DATE,
  p_lines          JSONB,
  p_reason         TEXT DEFAULT NULL,
  p_comment        TEXT DEFAULT NULL
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
  v_section    TEXT;
  v_seen       TEXT[] := '{}';   -- [0128] ingredient:section
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
    v_section    := COALESCE(v_line->>'section', 'MACRO');
    IF v_ingredient IS NULL OR NOT EXISTS (SELECT 1 FROM feed_ingredient WHERE id = v_ingredient AND activo = true) THEN
      RAISE EXCEPTION 'INGREDIENT_NOT_FOUND: %', v_ingredient;
    END IF;
    -- [0128] the same ingredient may be in Premezcla AND in Macronutrientes, once in each
    IF (v_ingredient::TEXT || ':' || v_section) = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_INGREDIENT: % in %', v_ingredient, v_section;
    END IF;
    v_seen := v_seen || (v_ingredient::TEXT || ':' || v_section);
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> round(v_qty, 3) OR v_qty >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF v_cost IS NOT NULL AND (v_cost < 0 OR v_cost <> round(v_cost, 2) OR v_cost >= 1e13) THEN
      RAISE EXCEPTION 'INVALID_COST';
    END IF;
    IF v_section NOT IN ('PREMIX', 'MACRO') THEN
      RAISE EXCEPTION 'INVALID_SECTION: %', v_section;
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

  INSERT INTO feed_formula_version (feed_type_id, version, effective_from, effective_to, created_by, comment)
  VALUES (p_feed_type_id, v_version, p_effective_from, NULL, v_uid, NULLIF(btrim(p_comment), ''))
  RETURNING id INTO v_new_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO feed_formula_line (formula_version_id, ingredient_id, quantity_kg, unit_cost_snapshot, section)
    VALUES (v_new_id, (v_line->>'ingredient_id')::UUID, (v_line->>'quantity_kg')::NUMERIC, (v_line->>'unit_cost_snapshot')::NUMERIC,
            COALESCE(v_line->>'section', 'MACRO')::feed_formula_section);
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_formula_version', v_new_id::TEXT, 'PUBLISH',
          jsonb_build_object('feed_type_id', p_feed_type_id, 'version', v_version, 'effective_from', p_effective_from,
                             'line_count', v_count, 'closed_version_id', v_prev.id,
                             'closed_effective_to', CASE WHEN v_prev.id IS NULL THEN NULL ELSE p_effective_from - 1 END,
                             'comment', NULLIF(btrim(p_comment), ''),
                             'lines', (SELECT jsonb_agg(jsonb_build_object('ingredient_id', l.ingredient_id, 'quantity_kg', l.quantity_kg, 'section', l.section)
                                                        ORDER BY l.section, l.quantity_kg DESC)
                                         FROM feed_formula_line l WHERE l.formula_version_id = v_new_id),
                             'previous_lines', (SELECT jsonb_agg(jsonb_build_object('ingredient_id', l.ingredient_id, 'quantity_kg', l.quantity_kg, 'section', l.section)
                                                                 ORDER BY l.section, l.quantity_kg DESC)
                                                  FROM feed_formula_line l WHERE l.formula_version_id = v_prev.id)),
          p_reason, v_uid);

  RETURN jsonb_build_object('formula_version_id', v_new_id, 'version', v_version, 'line_count', v_count,
                            'closed_version_id', v_prev.id);
END;
$$;
