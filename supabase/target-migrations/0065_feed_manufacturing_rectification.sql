-- ============================================================================
-- TARGET V1 — 0065 FEED MANUFACTURING RECTIFICATION + CLASSIFICATION GRADE
-- "Rotos" INACTIVE (ADR-014, owner decisions D-FEED-8 / D-CLS-6, Phase 27
-- acceptance fixes block 4 follow-up)
--
--   * feed_manufacturing gets a version chain (version_seq, is_current,
--     supersedes_id, rectification_reason). RPC 49 rectify_feed_manufacturing
--     replaces one whole current record with a new version (mandatory reason);
--     the prior version stays exactly as it was and stops being current.
--   * Inventory / reporting: feed stock is never stored — it is the physical
--     count, and the only consumer of manufactured kg is
--     report_feed_consumption_interval, which now counts current versions only.
--     So the correction is the version filter itself; no compensating movement
--     is generated.
--   * Classification grade "Rotos" (Part 14 seed, 0008) is deactivated for new
--     entries (merge forward into "Descarte"). Historical lines are untouched and
--     still resolve their grade. The Production metric eggs_broken is unrelated.
-- ============================================================================

-- ── feed_manufacturing: version chain ───────────────────────────────────────
ALTER TABLE feed_manufacturing
  ADD COLUMN version_seq          INTEGER NOT NULL DEFAULT 0 CHECK (version_seq >= 0),
  ADD COLUMN is_current           BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN supersedes_id        UUID UNIQUE REFERENCES feed_manufacturing(id) ON DELETE RESTRICT,
  ADD COLUMN rectification_reason TEXT;
ALTER TABLE feed_manufacturing
  ADD CONSTRAINT chk_feed_manufacturing_version_chain
    CHECK ((supersedes_id IS NULL) = (version_seq = 0)
       AND (supersedes_id IS NULL) = (rectification_reason IS NULL));
CREATE INDEX idx_feed_manufacturing_current_date ON feed_manufacturing (manufacturing_date) WHERE is_current;

-- ── RPC 49 rectify_feed_manufacturing ───────────────────────────────────────
-- Replaces one whole current record. The manufacturing date is kept (it is the
-- period determinant); quantity, batch number and the formula version may change
-- (the version must be effective on that date and have composition).
-- ADMIN: any current record; OPERATOR: a current record of a chain it started.
CREATE OR REPLACE FUNCTION rectify_feed_manufacturing(
  p_idempotency_key    VARCHAR,
  p_manufacturing_id   UUID,
  p_quantity_kg        DECIMAL,
  p_reason             TEXT,
  p_batch_number       VARCHAR DEFAULT NULL,
  p_formula_version_id UUID DEFAULT NULL
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

  PERFORM pg_advisory_xact_lock(hashtext('feed_formula_version'), hashtext(v_version::TEXT));

  -- (a) the prior version stops being current, (b) the new version is inserted
  UPDATE feed_manufacturing SET is_current = false WHERE id = v_old.id;
  BEGIN
    INSERT INTO feed_manufacturing (formula_version_id, manufacturing_date, quantity_kg, batch_number, idempotency_key, created_by,
                                    version_seq, is_current, supersedes_id, rectification_reason)
    VALUES (v_version, v_old.manufacturing_date, p_quantity_kg, COALESCE(p_batch_number, v_old.batch_number), p_idempotency_key, v_uid,
            v_old.version_seq + 1, true, v_old.id, btrim(p_reason))
    RETURNING id INTO v_new_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_MANUFACTURING';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('feed_manufacturing', v_new_id::TEXT, 'RECTIFY',
          jsonb_build_object('manufacturing_id', v_old.id, 'version_seq', v_old.version_seq,
                             'formula_version_id', v_old.formula_version_id, 'quantity_kg', v_old.quantity_kg),
          jsonb_build_object('manufacturing_id', v_new_id, 'version_seq', v_old.version_seq + 1,
                             'formula_version_id', v_version, 'quantity_kg', p_quantity_kg),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('manufacturing_id', v_new_id, 'superseded_id', v_old.id,
                            'version_seq', v_old.version_seq + 1, 'quantity_kg', p_quantity_kg);
END;
$$;

ALTER  FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_feed_manufacturing(VARCHAR, UUID, DECIMAL, TEXT, VARCHAR, UUID) TO authenticated;

-- ── report_feed_consumption_interval: current versions only (ADR-014) ───────
CREATE OR REPLACE VIEW report_feed_consumption_interval
WITH (security_invoker = true)
AS
WITH c AS (
  SELECT feed_type_id,
         lag(id)          OVER w AS opening_count_id,
         lag(count_date)  OVER w AS opening_date,
         lag(quantity_kg) OVER w AS opening_kg,
         id                      AS closing_count_id,
         count_date              AS closing_date,
         quantity_kg             AS closing_kg
    FROM feed_inventory_count
  WINDOW w AS (PARTITION BY feed_type_id ORDER BY count_date)
), i AS (
  SELECT c.*,
         COALESCE((SELECT SUM(m.quantity_kg) FROM feed_manufacturing m
                     JOIN feed_formula_version v ON v.id = m.formula_version_id
                    WHERE v.feed_type_id = c.feed_type_id
                      AND m.is_current
                      AND m.manufacturing_date > c.opening_date AND m.manufacturing_date <= c.closing_date), 0) AS manufactured_kg,
         mv.external_sale_kg, mv.loss_kg, mv.adjustment_negative_kg, mv.adjustment_positive_kg,
         (SELECT round(SUM(fd.theoretical_feed_kg), 3) FROM report_flock_day fd
           WHERE fd.feed_type_id = c.feed_type_id
             AND fd.business_date > c.opening_date AND fd.business_date <= c.closing_date) AS theoretical_kg
    FROM c
   CROSS JOIN LATERAL (
     SELECT COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'EXTERNAL_SALE'), 0)       AS external_sale_kg,
            COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'LOSS'), 0)                AS loss_kg,
            COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'ADJUSTMENT_NEGATIVE'), 0) AS adjustment_negative_kg,
            COALESCE(SUM(quantity_kg) FILTER (WHERE movement_type = 'ADJUSTMENT_POSITIVE'), 0) AS adjustment_positive_kg
       FROM feed_movement fm
      WHERE fm.feed_type_id = c.feed_type_id
        AND fm.movement_date > c.opening_date AND fm.movement_date <= c.closing_date) mv
   WHERE c.opening_date IS NOT NULL
)
SELECT i.feed_type_id,
       ft.nombre                                     AS feed_type_nombre,
       i.opening_count_id,
       i.opening_date,
       i.closing_count_id,
       i.closing_date                                AS business_date,
       i.opening_kg,
       i.manufactured_kg,
       i.external_sale_kg,
       i.loss_kg,
       i.adjustment_negative_kg,
       i.adjustment_positive_kg,
       i.closing_kg,
       i.opening_kg + i.manufactured_kg - i.external_sale_kg - i.loss_kg - i.adjustment_negative_kg
         + i.adjustment_positive_kg - i.closing_kg   AS internal_consumption_kg,
       COALESCE(i.theoretical_kg, 0)                 AS theoretical_kg,
       i.opening_kg + i.manufactured_kg - i.external_sale_kg - i.loss_kg - i.adjustment_negative_kg
         + i.adjustment_positive_kg - i.closing_kg - COALESCE(i.theoretical_kg, 0) AS variance_kg
  FROM i
  LEFT JOIN feed_type ft ON ft.id = i.feed_type_id
 WHERE (SELECT current_app_role()) = 'ADMIN';

-- ── classification grade "Rotos": inactive for new entries (D-CLS-6) ────────
-- Merge forward into "Descarte". No line is reassigned or rewritten.
UPDATE classification_grade SET activo = false WHERE nombre = 'Rotos';
