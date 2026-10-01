-- ============================================================================
-- TARGET V1 — 0063 CLASSIFICATION ENTRY UNITS + RECTIFICATION
-- (ADR-012, owner decisions D-CLS-1…5, Phase 27 acceptance fixes block 4)
--
--   * Entry units UNIDAD / MAPLE. The canonical quantity stays individual eggs
--     (classification_line.quantity). The backend converts:
--       UNIDAD = 1 egg; MAPLE = 20 eggs for grade XL, 30 eggs for every other grade.
--     The grade is identified by its frozen name (classification_grade.nombre,
--     FROZEN Part 14 grade list). The entered quantity and unit are stored as typed.
--   * Pre-0063 lines were entered as eggs (the form had no unit), so they are
--     back-filled as entered_quantity = quantity, entered_unit = 'UNIDAD'.
--   * Rectification: RPC 47 rectify_classification replaces one whole session
--     with a new version (version_seq + 1, supersedes_id, mandatory reason).
--     The prior version stays as it was and only stops being current.
--   * report_classification_day counts current versions only.
--   * Classification still references no flock (FROZEN Part 14).
-- ============================================================================

CREATE TYPE classification_entry_unit AS ENUM ('UNIDAD', 'MAPLE');

-- ── classification: version chain ───────────────────────────────────────────
ALTER TABLE classification
  ADD COLUMN version_seq          INTEGER NOT NULL DEFAULT 0 CHECK (version_seq >= 0),
  ADD COLUMN is_current           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN supersedes_id        UUID UNIQUE REFERENCES classification(id) ON DELETE RESTRICT,
  ADD COLUMN rectification_reason TEXT;
ALTER TABLE classification
  ADD CONSTRAINT chk_classification_version_chain
    CHECK ((supersedes_id IS NULL) = (version_seq = 0)
       AND (supersedes_id IS NULL) = (rectification_reason IS NULL));
CREATE INDEX idx_classification_current_date ON classification (classification_date) WHERE is_current;

-- ── classification_line: original entry ─────────────────────────────────────
ALTER TABLE classification_line
  ADD COLUMN entered_quantity INTEGER,
  ADD COLUMN entered_unit     classification_entry_unit;
UPDATE classification_line SET entered_quantity = quantity, entered_unit = 'UNIDAD';
ALTER TABLE classification_line
  ALTER COLUMN entered_quantity SET NOT NULL,
  ALTER COLUMN entered_unit     SET NOT NULL,
  ADD CONSTRAINT chk_classification_line_entered CHECK (entered_quantity >= 0),
  ADD CONSTRAINT chk_classification_line_unidad  CHECK (entered_unit <> 'UNIDAD' OR quantity = entered_quantity);

-- ── RPC 25 register_classification (amended by ADR-012) ─────────────────────
-- p_lines: [{classification_grade_id, quantity, unit}], quantity = the number typed,
-- unit = 'UNIDAD' | 'MAPLE' (absent = 'UNIDAD', the pre-ADR-012 meaning).
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
  v_qty               BIGINT;
  v_unit              TEXT;
  v_grade             UUID;
  v_grade_name        TEXT;
  v_canonical         BIGINT;
  v_seen              UUID[] := '{}';
  v_rows              JSONB := '[]'::JSONB;
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

  -- validate and convert the complete line set before any write
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_qty   := (v_line->>'quantity')::BIGINT;
    v_unit  := COALESCE(v_line->>'unit', 'UNIDAD');
    v_grade := (v_line->>'classification_grade_id')::UUID;
    IF v_qty IS NULL OR v_qty < 0 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF v_unit NOT IN ('UNIDAD', 'MAPLE') THEN
      RAISE EXCEPTION 'INVALID_UNIT: %', v_unit;
    END IF;
    SELECT nombre INTO v_grade_name FROM classification_grade WHERE id = v_grade AND activo = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GRADE_NOT_FOUND: %', v_grade;
    END IF;
    IF v_grade = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_GRADE_IN_SESSION: grade % appears more than once', v_grade;
    END IF;
    v_seen := v_seen || v_grade;
    -- ADR-012 / D-CLS-1: MAPLE = 20 eggs for XL, 30 for every other grade
    v_canonical := v_qty * CASE WHEN v_unit = 'UNIDAD' THEN 1 WHEN v_grade_name = 'XL' THEN 20 ELSE 30 END;
    IF v_canonical > 2147483647 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    v_rows := v_rows || jsonb_build_object('grade', v_grade, 'entered_quantity', v_qty, 'entered_unit', v_unit, 'quantity', v_canonical);
  END LOOP;

  BEGIN
    INSERT INTO classification (idempotency_key, classification_date, location, created_by)
    VALUES (p_idempotency_key, p_classification_date, p_location, v_uid)
    RETURNING id INTO v_classification_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_CLASSIFICATION';
  END;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    INSERT INTO classification_line (classification_id, classification_grade_id, quantity, entered_quantity, entered_unit)
    VALUES (v_classification_id, (v_line->>'grade')::UUID, (v_line->>'quantity')::INTEGER,
            (v_line->>'entered_quantity')::INTEGER, (v_line->>'entered_unit')::classification_entry_unit);
    v_line_count := v_line_count + 1;
    v_total := v_total + (v_line->>'quantity')::BIGINT;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('classification', v_classification_id::TEXT, 'CREATE',
          jsonb_build_object('classification_date', p_classification_date,
                             'line_count', jsonb_array_length(p_lines),
                             'total_quantity', v_total),
          p_reason, v_uid);

  RETURN jsonb_build_object('classification_id', v_classification_id, 'line_count', v_line_count,
                            'total_quantity', v_total);
END;
$$;

-- ── RPC 47 rectify_classification (ADR-012) ─────────────────────────────────
-- Replaces one whole current session. ADMIN may rectify any current session;
-- OPERATOR only a current session it created (the sessions its RLS shows it).
CREATE OR REPLACE FUNCTION rectify_classification(
  p_idempotency_key   UUID,
  p_classification_id UUID,
  p_lines             JSONB,
  p_reason            TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_role       TEXT;
  v_old        classification;
  v_line       JSONB;
  v_qty        BIGINT;
  v_unit       TEXT;
  v_grade      UUID;
  v_grade_name TEXT;
  v_canonical  BIGINT;
  v_seen       UUID[] := '{}';
  v_rows       JSONB := '[]'::JSONB;
  v_new_id     UUID;
  v_old_total  BIGINT;
  v_total      BIGINT := 0;
BEGIN
  v_role := current_app_role();                    -- raises if the user is unknown or inactive
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'EMPTY_LINE_SET';
  END IF;
  IF EXISTS (SELECT 1 FROM classification WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_CLASSIFICATION';
  END IF;

  SELECT * INTO v_old FROM classification WHERE id = p_classification_id FOR UPDATE;
  IF NOT FOUND OR (v_role <> 'ADMIN' AND v_old.created_by IS DISTINCT FROM v_uid) THEN
    RAISE EXCEPTION 'CLASSIFICATION_NOT_FOUND';
  END IF;
  IF NOT v_old.is_current THEN
    RAISE EXCEPTION 'CLASSIFICATION_SUPERSEDED';
  END IF;

  PERFORM assert_period_open(v_old.classification_date);

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_qty   := (v_line->>'quantity')::BIGINT;
    v_unit  := COALESCE(v_line->>'unit', 'UNIDAD');
    v_grade := (v_line->>'classification_grade_id')::UUID;
    IF v_qty IS NULL OR v_qty < 0 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    IF v_unit NOT IN ('UNIDAD', 'MAPLE') THEN
      RAISE EXCEPTION 'INVALID_UNIT: %', v_unit;
    END IF;
    SELECT nombre INTO v_grade_name FROM classification_grade WHERE id = v_grade AND activo = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'GRADE_NOT_FOUND: %', v_grade;
    END IF;
    IF v_grade = ANY (v_seen) THEN
      RAISE EXCEPTION 'DUPLICATE_GRADE_IN_SESSION: grade % appears more than once', v_grade;
    END IF;
    v_seen := v_seen || v_grade;
    v_canonical := v_qty * CASE WHEN v_unit = 'UNIDAD' THEN 1 WHEN v_grade_name = 'XL' THEN 20 ELSE 30 END;
    IF v_canonical > 2147483647 THEN
      RAISE EXCEPTION 'INVALID_QUANTITY';
    END IF;
    v_rows := v_rows || jsonb_build_object('grade', v_grade, 'entered_quantity', v_qty, 'entered_unit', v_unit, 'quantity', v_canonical);
  END LOOP;

  SELECT COALESCE(SUM(quantity), 0) INTO v_old_total FROM classification_line WHERE classification_id = v_old.id;

  -- (a) the prior version stops being current, (b) the new version is inserted
  UPDATE classification SET is_current = false WHERE id = v_old.id;
  BEGIN
    INSERT INTO classification (idempotency_key, classification_date, location, created_by,
                                version_seq, is_current, supersedes_id, rectification_reason)
    VALUES (p_idempotency_key, v_old.classification_date, v_old.location, v_uid,
            v_old.version_seq + 1, true, v_old.id, btrim(p_reason))
    RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_CLASSIFICATION';
  END;

  FOR v_line IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    INSERT INTO classification_line (classification_id, classification_grade_id, quantity, entered_quantity, entered_unit)
    VALUES (v_new_id, (v_line->>'grade')::UUID, (v_line->>'quantity')::INTEGER,
            (v_line->>'entered_quantity')::INTEGER, (v_line->>'entered_unit')::classification_entry_unit);
    v_total := v_total + (v_line->>'quantity')::BIGINT;
  END LOOP;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('classification', v_new_id::TEXT, 'RECTIFY',
          jsonb_build_object('classification_id', v_old.id, 'version_seq', v_old.version_seq, 'total_quantity', v_old_total),
          jsonb_build_object('classification_id', v_new_id, 'version_seq', v_old.version_seq + 1, 'total_quantity', v_total),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('classification_id', v_new_id, 'superseded_id', v_old.id,
                            'version_seq', v_old.version_seq + 1, 'total_quantity', v_total);
END;
$$;

ALTER  FUNCTION rectify_classification(UUID, UUID, JSONB, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_classification(UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_classification(UUID, UUID, JSONB, TEXT) TO authenticated;

-- ── report_classification_day: current versions only (ADR-012) ──────────────
CREATE OR REPLACE VIEW report_classification_day
WITH (security_invoker = true)
AS
WITH g AS (
  SELECT c.classification_date, cl.classification_grade_id,
         SUM(cl.quantity)             AS quantity,
         array_agg(DISTINCT c.id)     AS classification_ids
    FROM classification c
    JOIN classification_line cl ON cl.classification_id = c.id
   WHERE c.is_current
   GROUP BY c.classification_date, cl.classification_grade_id
), s AS (
  SELECT classification_date, count(*) AS sessions
    FROM classification
   WHERE is_current
   GROUP BY classification_date
)
SELECT g.classification_date                              AS business_date,
       date_trunc('month', g.classification_date)::DATE   AS period,
       g.classification_grade_id,
       gr.nombre                                          AS grade_nombre,
       g.quantity,
       SUM(g.quantity) OVER (PARTITION BY g.classification_date) AS day_total,
       CASE WHEN SUM(g.quantity) OVER (PARTITION BY g.classification_date) > 0
            THEN round(g.quantity * 100.0 / SUM(g.quantity) OVER (PARTITION BY g.classification_date), 4) END AS share_pct,
       s.sessions                                         AS day_sessions,
       g.classification_ids
  FROM g
  JOIN s ON s.classification_date = g.classification_date
  LEFT JOIN classification_grade gr ON gr.id = g.classification_grade_id;
