-- ============================================================================
-- TARGET V1 — 0125 ALIMENTO BALANCEADO: RECETAS, FABRICACIONES, CIERRE MENSUAL
-- (alimento-balanceado-v1, owner decisions 2026-11-14 / 2026-11-16, prototype stage 1)
--
--   Recetas
--     * feed_formula_line.section: every ingredient line is PREMIX (Premezcla, small
--       amounts, 3 decimals) or MACRO (Macronutrientes). Existing lines default MACRO.
--     * feed_formula_version.comment: optional, editable (set_feed_formula_comment),
--       every change audited. Changing ingredients is still a NEW version (RPC 48).
--     * feed_type.standard_batch_kg: the standard batch shown by default in
--       «Ver recetas»; changing it never creates a version (set_feed_type_standard_batch).
--     * feed_type.inactive_from: the date a recipe was deactivated (set_feed_type_active).
--     * RPC 48 publish_feed_formula_version gains p_comment and a per-line "section"
--       (default MACRO) — named-argument callers of the 4-argument form keep working.
--     * report_feed_recipe_change: recipe change history (audit_events), ADMIN.
--   Fabricaciones
--     * feed_manufacturing.notes (comment). RPC 26 / 49 gain p_notes (NULL on a
--       rectification keeps the previous comment; '' clears it).
--     * A manufacturing in a CLOSED feed month is refused (FEED_MONTH_CLOSED), on
--       register and on rectification. The general management-period lock stays.
--   Cierre mensual de stock
--     * feed_stock_period: one row per closed (or reopened) month.
--     * close_feed_month (ADMIN): the month-end stock of every active feed type (and of
--       every type manufactured in the month) → feed_inventory_count at the last day
--       of the month; the month becomes CLOSED. The previous month must be closed,
--       unless this is the first close. Re-closing a reopened month replaces its counts.
--     * reopen_feed_month (ADMIN, reason): only the latest closed month.
--     * report_feed_month: per feed type and closed month — opening (previous
--       month-end count), manufactured (current versions), movements, closing and
--       internal consumption. Consumption needs an opening count.
--
--   No ledger, no P&L, no cost here (0126). No data is written by this migration.
-- ============================================================================

-- ── recetas: columnas ───────────────────────────────────────────────────────
CREATE TYPE feed_formula_section AS ENUM ('PREMIX', 'MACRO');

ALTER TABLE feed_formula_line    ADD COLUMN section feed_formula_section NOT NULL DEFAULT 'MACRO';
ALTER TABLE feed_formula_version ADD COLUMN comment TEXT;
ALTER TABLE feed_type
  ADD COLUMN standard_batch_kg NUMERIC(15,3) NOT NULL DEFAULT 200
    CONSTRAINT chk_feed_type_standard_batch CHECK (standard_batch_kg > 0),
  ADD COLUMN inactive_from DATE;
ALTER TABLE feed_manufacturing   ADD COLUMN notes TEXT;

-- composition without cost, now with its section (columns appended; owner / grants kept)
CREATE OR REPLACE VIEW feed_formula_line_safe
WITH (security_invoker = false)
AS
  SELECT ffl.formula_version_id,
         ffl.ingredient_id,
         fi.nombre AS ingredient_name,
         ffl.quantity_kg,
         ffl.section
    FROM feed_formula_line ffl
    JOIN feed_ingredient   fi ON fi.id = ffl.ingredient_id;

-- ── cierre mensual: tabla y guardia ─────────────────────────────────────────
CREATE TABLE feed_stock_period (
  period        DATE PRIMARY KEY CONSTRAINT chk_feed_stock_period_month CHECK (period = date_trunc('month', period)::DATE),
  status        TEXT NOT NULL CONSTRAINT chk_feed_stock_period_status CHECK (status IN ('CLOSED', 'REOPENED')),
  comment       TEXT,
  closed_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  closed_at     TIMESTAMPTZ,
  reopened_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reopened_at   TIMESTAMPTZ,
  reopen_reason TEXT
);
ALTER TABLE feed_stock_period ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON feed_stock_period FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON feed_stock_period TO authenticated;
-- both roles read it (Fabricaciones shows closed months); writes only through the RPCs below
CREATE POLICY feed_stock_period_select ON feed_stock_period FOR SELECT
  USING (current_app_role() IN ('ADMIN', 'OPERATOR'));

CREATE OR REPLACE FUNCTION assert_feed_month_open(p_date DATE)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM feed_stock_period
              WHERE period = date_trunc('month', p_date)::DATE AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'FEED_MONTH_CLOSED: el stock de % está cerrado', to_char(p_date, 'MM/YYYY');
  END IF;
END;
$$;
ALTER  FUNCTION assert_feed_month_open(DATE) OWNER TO postgres;
REVOKE ALL     ON FUNCTION assert_feed_month_open(DATE) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION assert_feed_month_open(DATE) TO authenticated;

-- ── RPC 48 publish_feed_formula_version: sección por línea + comentario ─────
DROP FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT);
-- p_lines: [{ingredient_id, quantity_kg, section?: 'PREMIX'|'MACRO', unit_cost_snapshot?}]
CREATE FUNCTION publish_feed_formula_version(
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
    v_section    := COALESCE(v_line->>'section', 'MACRO');
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
ALTER  FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION publish_feed_formula_version(UUID, DATE, JSONB, TEXT, TEXT) TO authenticated;

-- ── comentario de versión ───────────────────────────────────────────────────
CREATE FUNCTION set_feed_formula_comment(p_formula_version_id UUID, p_comment TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_old feed_formula_version;
  v_new TEXT := NULLIF(btrim(p_comment), '');
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  SELECT * INTO v_old FROM feed_formula_version WHERE id = p_formula_version_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FORMULA_VERSION_NOT_FOUND';
  END IF;
  IF v_old.comment IS NOT DISTINCT FROM v_new THEN
    RAISE EXCEPTION 'NO_CHANGES';
  END IF;
  UPDATE feed_formula_version SET comment = v_new WHERE id = v_old.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('feed_formula_version', v_old.id::TEXT, 'COMMENT',
          jsonb_build_object('feed_type_id', v_old.feed_type_id, 'version', v_old.version, 'comment', v_old.comment),
          jsonb_build_object('feed_type_id', v_old.feed_type_id, 'version', v_old.version, 'comment', v_new), v_uid);
  RETURN jsonb_build_object('formula_version_id', v_old.id, 'comment', v_new);
END;
$$;
ALTER  FUNCTION set_feed_formula_comment(UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_feed_formula_comment(UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_feed_formula_comment(UUID, TEXT) TO authenticated;

-- ── batch estándar (no crea versión) ────────────────────────────────────────
CREATE FUNCTION set_feed_type_standard_batch(p_feed_type_id UUID, p_standard_batch_kg NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_old feed_type;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_standard_batch_kg IS NULL OR p_standard_batch_kg <= 0 OR p_standard_batch_kg <> round(p_standard_batch_kg, 3) OR p_standard_batch_kg >= 1e12 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  SELECT * INTO v_old FROM feed_type WHERE id = p_feed_type_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEED_TYPE_NOT_FOUND';
  END IF;
  IF v_old.standard_batch_kg = p_standard_batch_kg THEN
    RAISE EXCEPTION 'NO_CHANGES';
  END IF;
  UPDATE feed_type SET standard_batch_kg = p_standard_batch_kg WHERE id = v_old.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('feed_type', v_old.id::TEXT, 'STANDARD_BATCH',
          jsonb_build_object('standard_batch_kg', v_old.standard_batch_kg),
          jsonb_build_object('standard_batch_kg', p_standard_batch_kg), v_uid);
  RETURN jsonb_build_object('feed_type_id', v_old.id, 'standard_batch_kg', p_standard_batch_kg);
END;
$$;
ALTER  FUNCTION set_feed_type_standard_batch(UUID, NUMERIC) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_feed_type_standard_batch(UUID, NUMERIC) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_feed_type_standard_batch(UUID, NUMERIC) TO authenticated;

-- ── activar / desactivar receta (con fecha) ─────────────────────────────────
CREATE FUNCTION set_feed_type_active(p_feed_type_id UUID, p_active BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_old   feed_type;
  v_today DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_active IS NULL THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  SELECT * INTO v_old FROM feed_type WHERE id = p_feed_type_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FEED_TYPE_NOT_FOUND';
  END IF;
  IF v_old.activo = p_active THEN
    RAISE EXCEPTION 'NO_CHANGES';
  END IF;
  UPDATE feed_type SET activo = p_active, inactive_from = CASE WHEN p_active THEN NULL ELSE v_today END WHERE id = v_old.id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('feed_type', v_old.id::TEXT, CASE WHEN p_active THEN 'ACTIVATE' ELSE 'DEACTIVATE' END,
          jsonb_build_object('activo', v_old.activo, 'inactive_from', v_old.inactive_from),
          jsonb_build_object('activo', p_active, 'inactive_from', CASE WHEN p_active THEN NULL ELSE v_today END), v_uid);
  RETURN jsonb_build_object('feed_type_id', v_old.id, 'activo', p_active, 'inactive_from', CASE WHEN p_active THEN NULL ELSE v_today END);
END;
$$;
ALTER  FUNCTION set_feed_type_active(UUID, BOOLEAN) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_feed_type_active(UUID, BOOLEAN) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_feed_type_active(UUID, BOOLEAN) TO authenticated;

-- ── RPC 26 register_feed_manufacturing: comentario + mes cerrado ────────────
DROP FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT);
CREATE FUNCTION register_feed_manufacturing(
  p_formula_version_id UUID,
  p_manufacturing_date DATE,
  p_quantity_kg        DECIMAL,
  p_idempotency_key    VARCHAR,
  p_batch_number       VARCHAR DEFAULT NULL,
  p_reason             TEXT DEFAULT NULL,
  p_notes              TEXT DEFAULT NULL
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
  PERFORM assert_feed_month_open(p_manufacturing_date);

  PERFORM pg_advisory_xact_lock(hashtext('feed_formula_version'), hashtext(p_formula_version_id::TEXT));

  BEGIN
    INSERT INTO feed_manufacturing (formula_version_id, manufacturing_date, quantity_kg,
                                    batch_number, idempotency_key, created_by, notes)
    VALUES (p_formula_version_id, p_manufacturing_date, p_quantity_kg,
            p_batch_number, p_idempotency_key, v_uid, NULLIF(btrim(p_notes), ''))
    RETURNING id INTO v_manufacturing_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_MANUFACTURING';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_manufacturing', v_manufacturing_id::TEXT, 'CREATE',
          jsonb_build_object('formula_version_id', p_formula_version_id,
                             'manufacturing_date', p_manufacturing_date,
                             'quantity_kg', p_quantity_kg,
                             'notes', NULLIF(btrim(p_notes), '')),
          p_reason, v_uid);

  RETURN jsonb_build_object('manufacturing_id', v_manufacturing_id, 'quantity_kg', p_quantity_kg);
END;
$$;
ALTER  FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT, TEXT) TO authenticated;

-- ── RPC 49 rectify_feed_manufacturing: comentario + mes cerrado ─────────────
DROP FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID);
CREATE FUNCTION rectify_feed_manufacturing(
  p_idempotency_key    VARCHAR,
  p_manufacturing_id   UUID,
  p_quantity_kg        DECIMAL,
  p_reason             TEXT,
  p_batch_number       VARCHAR DEFAULT NULL,
  p_formula_version_id UUID DEFAULT NULL,
  p_notes              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_role    TEXT;
  v_old     feed_manufacturing;
  v_origin  UUID;
  v_fv      feed_formula_version;
  v_version UUID;
  v_new_id  UUID;
  v_notes   TEXT;
BEGIN
  v_role := current_app_role();                    -- raises if the user is unknown or inactive
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_quantity_kg IS NULL OR p_quantity_kg <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'EXTERNAL_REF_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM feed_manufacturing WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_MANUFACTURING';
  END IF;

  SELECT * INTO v_old FROM feed_manufacturing WHERE id = p_manufacturing_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MANUFACTURING_NOT_FOUND';
  END IF;
  -- the author of the chain is the author of its first version
  WITH RECURSIVE chain AS (
    SELECT id, supersedes_id, created_by FROM feed_manufacturing WHERE id = v_old.id
    UNION ALL
    SELECT m.id, m.supersedes_id, m.created_by FROM feed_manufacturing m JOIN chain c ON m.id = c.supersedes_id
  )
  SELECT created_by INTO v_origin FROM chain WHERE supersedes_id IS NULL;
  IF v_role <> 'ADMIN' AND v_origin IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'MANUFACTURING_NOT_FOUND';
  END IF;
  IF NOT v_old.is_current THEN
    RAISE EXCEPTION 'MANUFACTURING_SUPERSEDED';
  END IF;

  v_version := COALESCE(p_formula_version_id, v_old.formula_version_id);
  SELECT * INTO v_fv FROM feed_formula_version WHERE id = v_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FORMULA_VERSION_NOT_FOUND';
  END IF;
  IF v_old.manufacturing_date < v_fv.effective_from
     OR (v_fv.effective_to IS NOT NULL AND v_old.manufacturing_date > v_fv.effective_to) THEN
    RAISE EXCEPTION 'FORMULA_VERSION_NOT_EFFECTIVE: version is not effective on %', v_old.manufacturing_date;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM feed_formula_line WHERE formula_version_id = v_version) THEN
    RAISE EXCEPTION 'FORMULA_VERSION_EMPTY';
  END IF;

  PERFORM assert_period_open(v_old.manufacturing_date);
  PERFORM assert_feed_month_open(v_old.manufacturing_date);

  PERFORM pg_advisory_xact_lock(hashtext('feed_formula_version'), hashtext(v_version::TEXT));

  v_notes := CASE WHEN p_notes IS NULL THEN v_old.notes ELSE NULLIF(btrim(p_notes), '') END;

  -- (a) the prior version stops being current, (b) the new version is inserted
  UPDATE feed_manufacturing SET is_current = false WHERE id = v_old.id;
  BEGIN
    INSERT INTO feed_manufacturing (formula_version_id, manufacturing_date, quantity_kg, batch_number, idempotency_key, created_by,
                                    version_seq, is_current, supersedes_id, rectification_reason, notes)
    VALUES (v_version, v_old.manufacturing_date, p_quantity_kg, COALESCE(p_batch_number, v_old.batch_number), p_idempotency_key, v_uid,
            v_old.version_seq + 1, true, v_old.id, btrim(p_reason), v_notes)
    RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_MANUFACTURING';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('feed_manufacturing', v_new_id::TEXT, 'RECTIFY',
          jsonb_build_object('manufacturing_id', v_old.id, 'version_seq', v_old.version_seq,
                             'formula_version_id', v_old.formula_version_id, 'quantity_kg', v_old.quantity_kg, 'notes', v_old.notes),
          jsonb_build_object('manufacturing_id', v_new_id, 'version_seq', v_old.version_seq + 1,
                             'formula_version_id', v_version, 'quantity_kg', p_quantity_kg, 'notes', v_notes),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('manufacturing_id', v_new_id, 'superseded_id', v_old.id,
                            'version_seq', v_old.version_seq + 1, 'quantity_kg', p_quantity_kg);
END;
$$;
ALTER  FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID, TEXT) TO authenticated;

-- ── cierre mensual de stock ─────────────────────────────────────────────────
-- p_counts: [{feed_type_id, quantity_kg}] — month-end stock of every type that must be counted
CREATE FUNCTION close_feed_month(p_period DATE, p_counts JSONB, p_comment TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_today     DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_month_end DATE;
  v_row       feed_stock_period;
  v_count     JSONB;
  v_type      UUID;
  v_qty       NUMERIC;
  v_seen      UUID[] := '{}';
  v_missing   TEXT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_period IS NULL OR p_period <> date_trunc('month', p_period)::DATE THEN
    RAISE EXCEPTION 'INVALID_PERIOD';
  END IF;
  v_month_end := (p_period + INTERVAL '1 month - 1 day')::DATE;
  IF v_month_end > v_today THEN
    RAISE EXCEPTION 'FEED_MONTH_NOT_ENDED: el mes termina el %', to_char(v_month_end, 'DD/MM/YYYY');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('feed_stock_period'), 0);   -- one close / reopen at a time

  SELECT * INTO v_row FROM feed_stock_period WHERE period = p_period;
  IF FOUND AND v_row.status = 'CLOSED' THEN
    RAISE EXCEPTION 'FEED_MONTH_ALREADY_CLOSED';
  END IF;
  -- months close in order: the previous month must be closed, unless this is the first close
  IF EXISTS (SELECT 1 FROM feed_stock_period WHERE period < p_period)
     AND NOT EXISTS (SELECT 1 FROM feed_stock_period WHERE period = (p_period - INTERVAL '1 month')::DATE AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'FEED_PREVIOUS_MONTH_OPEN';
  END IF;
  IF EXISTS (SELECT 1 FROM feed_stock_period WHERE period > p_period AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'FEED_LATER_MONTH_CLOSED';
  END IF;

  IF p_counts IS NULL OR jsonb_typeof(p_counts) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_INPUT';
  END IF;
  FOR v_count IN SELECT value FROM jsonb_array_elements(p_counts) LOOP
    v_type := (v_count->>'feed_type_id')::UUID;
    v_qty  := (v_count->>'quantity_kg')::NUMERIC;
    IF v_type IS NULL OR NOT EXISTS (SELECT 1 FROM feed_type WHERE id = v_type) THEN
      RAISE EXCEPTION 'FEED_TYPE_NOT_FOUND: %', v_type;
    END IF;
    IF v_type = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_FEED_TYPE: %', v_type;
    END IF;
    v_seen := v_seen || v_type;
    IF v_qty IS NULL OR v_qty < 0 OR v_qty <> round(v_qty, 3) OR v_qty >= 1e12 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
  END LOOP;

  -- every active type, and every type manufactured in the month, is counted
  SELECT string_agg(ft.nombre, ', ' ORDER BY ft.nombre) INTO v_missing
    FROM feed_type ft
   WHERE NOT (ft.id = ANY (v_seen))
     AND (ft.activo
          OR EXISTS (SELECT 1 FROM feed_manufacturing m JOIN feed_formula_version v ON v.id = m.formula_version_id
                      WHERE v.feed_type_id = ft.id AND m.is_current
                        AND m.manufacturing_date BETWEEN p_period AND v_month_end));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FEED_COUNT_MISSING: %', v_missing;
  END IF;

  FOR v_count IN SELECT value FROM jsonb_array_elements(p_counts) LOOP
    INSERT INTO feed_inventory_count (feed_type_id, count_date, quantity_kg, reason, created_by)
    VALUES ((v_count->>'feed_type_id')::UUID, v_month_end, (v_count->>'quantity_kg')::NUMERIC,
            'Cierre ' || to_char(p_period, 'MM/YYYY'), v_uid)
    ON CONFLICT (feed_type_id, count_date)
      DO UPDATE SET quantity_kg = EXCLUDED.quantity_kg, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = NOW();
  END LOOP;

  INSERT INTO feed_stock_period (period, status, comment, closed_by, closed_at)
  VALUES (p_period, 'CLOSED', NULLIF(btrim(p_comment), ''), v_uid, NOW())
  ON CONFLICT (period) DO UPDATE SET status = 'CLOSED', comment = EXCLUDED.comment, closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, performed_by)
  VALUES ('feed_stock_period', p_period::TEXT, 'CLOSE',
          CASE WHEN v_row.period IS NULL THEN NULL ELSE to_jsonb(v_row) END,
          jsonb_build_object('period', p_period, 'counts', p_counts, 'comment', NULLIF(btrim(p_comment), '')), v_uid);

  RETURN jsonb_build_object('period', p_period, 'status', 'CLOSED', 'count_date', v_month_end, 'counted', array_length(v_seen, 1));
END;
$$;
ALTER  FUNCTION close_feed_month(DATE, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION close_feed_month(DATE, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION close_feed_month(DATE, JSONB, TEXT) TO authenticated;

CREATE FUNCTION reopen_feed_month(p_period DATE, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_row feed_stock_period;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('feed_stock_period'), 0);
  SELECT * INTO v_row FROM feed_stock_period WHERE period = p_period FOR UPDATE;
  IF NOT FOUND OR v_row.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'FEED_MONTH_NOT_CLOSED';
  END IF;
  IF EXISTS (SELECT 1 FROM feed_stock_period WHERE period > p_period AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'FEED_LATER_MONTH_CLOSED';
  END IF;
  UPDATE feed_stock_period SET status = 'REOPENED', reopened_by = v_uid, reopened_at = NOW(), reopen_reason = btrim(p_reason)
   WHERE period = p_period;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('feed_stock_period', p_period::TEXT, 'REOPEN', to_jsonb(v_row), jsonb_build_object('period', p_period, 'status', 'REOPENED'),
          btrim(p_reason), v_uid);
  RETURN jsonb_build_object('period', p_period, 'status', 'REOPENED');
END;
$$;
ALTER  FUNCTION reopen_feed_month(DATE, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION reopen_feed_month(DATE, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION reopen_feed_month(DATE, TEXT) TO authenticated;

-- ── reporte mensual de stock (ADMIN) ────────────────────────────────────────
-- One row per feed type and CLOSED month. opening = previous month-end count (NULL on the first
-- close: no consumption without an opening). Same consumption formula as report_feed_consumption_interval.
CREATE VIEW report_feed_month
WITH (security_invoker = true)
AS
SELECT ft.id                                                     AS feed_type_id,
       ft.nombre                                                 AS feed_type_nombre,
       p.period,
       op.quantity_kg                                            AS opening_kg,
       mf.manufactured_kg,
       mv.external_sale_kg, mv.loss_kg, mv.adjustment_negative_kg, mv.adjustment_positive_kg,
       cl.quantity_kg                                            AS closing_kg,
       CASE WHEN op.quantity_kg IS NULL THEN NULL
            ELSE op.quantity_kg + mf.manufactured_kg - mv.external_sale_kg - mv.loss_kg - mv.adjustment_negative_kg
                 + mv.adjustment_positive_kg - cl.quantity_kg END AS internal_consumption_kg
  FROM feed_stock_period p
  JOIN feed_inventory_count cl ON cl.count_date = (p.period + INTERVAL '1 month - 1 day')::DATE
  JOIN feed_type ft ON ft.id = cl.feed_type_id
  LEFT JOIN feed_inventory_count op ON op.feed_type_id = ft.id AND op.count_date = (p.period - INTERVAL '1 day')::DATE
 CROSS JOIN LATERAL (
   SELECT COALESCE(SUM(m.quantity_kg), 0) AS manufactured_kg
     FROM feed_manufacturing m JOIN feed_formula_version v ON v.id = m.formula_version_id
    WHERE v.feed_type_id = ft.id AND m.is_current
      AND m.manufacturing_date BETWEEN p.period AND (p.period + INTERVAL '1 month - 1 day')::DATE) mf
 CROSS JOIN LATERAL (
   SELECT COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'EXTERNAL_SALE'), 0)       AS external_sale_kg,
          COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'LOSS'), 0)                AS loss_kg,
          COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'ADJUSTMENT_NEGATIVE'), 0) AS adjustment_negative_kg,
          COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'ADJUSTMENT_POSITIVE'), 0) AS adjustment_positive_kg
     FROM feed_movement fm
    WHERE fm.feed_type_id = ft.id
      AND fm.movement_date BETWEEN p.period AND (p.period + INTERVAL '1 month - 1 day')::DATE) mv
 WHERE p.status = 'CLOSED'
   AND (SELECT current_app_role()) = 'ADMIN';

-- ── historial de modificaciones de recetas (ADMIN) ──────────────────────────
CREATE VIEW report_feed_recipe_change
WITH (security_invoker = true)
AS
SELECT ae.id, ae.performed_at, ae.performed_by,
       COALESCE(NULLIF(btrim(COALESCE(pf.nombre, '') || ' ' || COALESCE(pf.apellido, '')), ''), pf.email) AS performed_by_name,
       COALESCE(fv.feed_type_id, ft.id)                           AS feed_type_id,
       COALESCE(ftv.nombre, ft.nombre)                            AS feed_type_nombre,
       ae.entity_type, ae.action, ae.before_values, ae.after_values, ae.reason
  FROM audit_events ae
  LEFT JOIN feed_formula_version fv ON ae.entity_type = 'feed_formula_version' AND fv.id::TEXT = ae.entity_id
  LEFT JOIN feed_type ftv ON ftv.id = fv.feed_type_id
  LEFT JOIN feed_type ft  ON ae.entity_type = 'feed_type' AND ft.id::TEXT = ae.entity_id
  LEFT JOIN perfiles pf   ON pf.id = ae.performed_by
 WHERE ((ae.entity_type = 'feed_formula_version' AND ae.action IN ('PUBLISH', 'COMMENT'))
     OR (ae.entity_type = 'feed_type' AND ae.action IN ('STANDARD_BATCH', 'ACTIVATE', 'DEACTIVATE')))
   AND (SELECT current_app_role()) = 'ADMIN';

ALTER VIEW report_feed_month         OWNER TO postgres;
ALTER VIEW report_feed_recipe_change OWNER TO postgres;
REVOKE ALL ON report_feed_month, report_feed_recipe_change FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON report_feed_month, report_feed_recipe_change TO authenticated;
ALTER TABLE feed_stock_period OWNER TO postgres;
