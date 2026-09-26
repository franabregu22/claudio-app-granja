-- ============================================================================
-- TARGET V1 — 0030 FEED RPCs (Phase 20)
-- Authority: RPC_CONTRACTS_V1.md 26 register_feed_manufacturing
--                                27 register_feed_inventory_count
--                                28 register_feed_movement
--                                29 assign_flock_feed
--            RLS_IMPLEMENTATION_SPEC_V1.md §4, §8 (RPCs 26–29 are the only writers)
--
-- No ledger, no posting, no consumption row. One transaction per call.
--
-- Technical completions (contract behaviour unchanged; each is tested):
--   * NULL quantity is INVALID_QUANTITY (NULL <= 0 / NULL < 0 would otherwise pass).
--   * A concurrent retry that passes the EXISTS pre-check and hits the UNIQUE
--     backstop is reported with the contract code (DUPLICATE_MANUFACTURING /
--     DUPLICATE_COUNT).
--   * RPC 26 takes the per-version advisory lock shared with
--     reject_line_on_used_formula_version (0029), so a version's composition
--     cannot change while its first manufacturing is being registered.
--   * RPC 29 locks the flock row (FOR NO KEY UPDATE, which does not block the
--     FK KEY SHARE locks of production writers) so concurrent reassignments of
--     one flock are applied one after the other, exactly as sequential calls:
--     history is preserved and one current assignment remains.
--   * NULL key / date / type are rejected by the frozen NOT NULL columns or the
--     Foundation guard (BUSINESS_DATE_REQUIRED); a missing feed type or Pedido
--     by the frozen foreign keys.
-- ============================================================================

-- ── 26. register_feed_manufacturing ────────────────────────────────────────
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

-- ── 27. register_feed_inventory_count ──────────────────────────────────────
CREATE OR REPLACE FUNCTION register_feed_inventory_count(
  p_feed_type_id UUID,
  p_count_date   DATE,
  p_quantity_kg  DECIMAL,
  p_reason       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_role     TEXT;
  v_count_id BIGINT;
BEGIN
  v_role := current_app_role();
  IF p_quantity_kg IS NULL OR p_quantity_kg < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  PERFORM assert_period_open(p_count_date);

  IF EXISTS (SELECT 1 FROM feed_inventory_count
              WHERE feed_type_id = p_feed_type_id AND count_date = p_count_date) THEN
    RAISE EXCEPTION 'DUPLICATE_COUNT: a count already exists for this feed type on %', p_count_date;
  END IF;

  BEGIN
    INSERT INTO feed_inventory_count (feed_type_id, count_date, quantity_kg, reason, created_by)
    VALUES (p_feed_type_id, p_count_date, p_quantity_kg, p_reason, v_uid)
    RETURNING id INTO v_count_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_COUNT: a count already exists for this feed type on %', p_count_date;
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_inventory_count', v_count_id::TEXT, 'CREATE',
          jsonb_build_object('feed_type_id', p_feed_type_id, 'count_date', p_count_date,
                             'quantity_kg', p_quantity_kg),
          p_reason, v_uid);

  RETURN jsonb_build_object('count_id', v_count_id);
END;
$$;

-- ── 28. register_feed_movement ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_feed_movement(
  p_feed_type_id  UUID,
  p_movement_type feed_movement_type,
  p_quantity_kg   DECIMAL,
  p_movement_date DATE,
  p_pedido_id     UUID DEFAULT NULL,
  p_reason        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_movement_id BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_quantity_kg IS NULL OR p_quantity_kg <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF p_movement_type = 'EXTERNAL_SALE' AND p_pedido_id IS NULL THEN
    RAISE EXCEPTION 'PEDIDO_REQUIRED: an external sale must reference its Pedido';
  END IF;
  IF p_movement_type <> 'EXTERNAL_SALE' AND (p_reason IS NULL OR length(trim(p_reason)) = 0) THEN
    RAISE EXCEPTION 'REASON_REQUIRED: adjustments and losses must be explained';
  END IF;

  PERFORM assert_period_open(p_movement_date);

  INSERT INTO feed_movement (feed_type_id, movement_type, quantity_kg, movement_date,
                             pedido_id, reason, created_by)
  VALUES (p_feed_type_id, p_movement_type, p_quantity_kg, p_movement_date,
          p_pedido_id, p_reason, v_uid)
  RETURNING id INTO v_movement_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('feed_movement', v_movement_id::TEXT, 'CREATE',
          jsonb_build_object('feed_type_id', p_feed_type_id, 'movement_type', p_movement_type,
                             'quantity_kg', p_quantity_kg, 'movement_date', p_movement_date),
          p_reason, v_uid);

  RETURN jsonb_build_object('movement_id', v_movement_id);
END;
$$;

-- ── 29. assign_flock_feed ──────────────────────────────────────────────────
-- A master assignment: no period guard.
CREATE OR REPLACE FUNCTION assign_flock_feed(
  p_flock_id       UUID,
  p_feed_type_id   UUID,
  p_effective_from DATE,
  p_reason         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_assignment_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  PERFORM 1 FROM flocks WHERE id = p_flock_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLOCK_NOT_FOUND';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM feed_type WHERE id = p_feed_type_id AND activo = true) THEN
    RAISE EXCEPTION 'FEED_TYPE_NOT_FOUND_OR_INACTIVE';
  END IF;

  -- close the open assignment, then open the new one (one current row per flock)
  UPDATE flock_feed_assignment SET effective_to = p_effective_from - 1
   WHERE flock_id = p_flock_id AND effective_to IS NULL;

  INSERT INTO flock_feed_assignment (flock_id, feed_type_id, effective_from, created_by)
  VALUES (p_flock_id, p_feed_type_id, p_effective_from, v_uid)
  RETURNING id INTO v_assignment_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('flock_feed_assignment', v_assignment_id::TEXT, 'ASSIGN',
          jsonb_build_object('flock_id', p_flock_id, 'feed_type_id', p_feed_type_id,
                             'effective_from', p_effective_from),
          p_reason, v_uid);

  RETURN jsonb_build_object('assignment_id', v_assignment_id);
END;
$$;

-- ── ownership and EXECUTE perimeter ────────────────────────────────────────
ALTER  FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_feed_manufacturing(UUID, DATE, DECIMAL, VARCHAR, VARCHAR, TEXT) TO authenticated;

ALTER  FUNCTION register_feed_inventory_count(UUID, DATE, DECIMAL, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_feed_inventory_count(UUID, DATE, DECIMAL, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_feed_inventory_count(UUID, DATE, DECIMAL, TEXT) TO authenticated;

ALTER  FUNCTION register_feed_movement(UUID, feed_movement_type, DECIMAL, DATE, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_feed_movement(UUID, feed_movement_type, DECIMAL, DATE, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_feed_movement(UUID, feed_movement_type, DECIMAL, DATE, UUID, TEXT) TO authenticated;

ALTER  FUNCTION assign_flock_feed(UUID, UUID, DATE, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION assign_flock_feed(UUID, UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION assign_flock_feed(UUID, UUID, DATE, TEXT) TO authenticated;
