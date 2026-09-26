-- ============================================================================
-- TARGET V1 — 0024 PRODUCTION RPCs (Phase 18, Slice 3)
-- Authority: RPC_CONTRACTS_V1.md 18 register_daily_production
--                                19 rectify_daily_production
--                                20 register_mortality
--                                21 rectify_mortality
--                                22 register_count_adjustment
--            DATABASE_INVARIANTS_V1.md 2, 16; RLS_IMPLEMENTATION_SPEC_V1.md §8
--
-- Every function: SECURITY DEFINER, search_path = public, owner postgres,
-- actor = auth.uid(), role = current_app_role() (raises for unknown/inactive
-- users). OPERATOR authority (assigned flock, own record) is decided INSIDE
-- the functions; no table privilege or policy is widened. Period guard on the
-- frozen determinant before the first write. No ledger, no posting.
--
-- Technical completions (contract behaviour unchanged; each is tested):
--   * NULL quantities raise the contract's INVALID_QUANTITY (NULL < 0 / <= 0 /
--     = 0 would otherwise pass): eggs_total/broken/dirty, deaths, delta.
--   * register_daily_production also rejects negative / NULL eggs_broken and
--     eggs_dirty with INVALID_QUANTITY, the same code RPC 19 uses for them (the
--     schema CHECKs reject negatives either way; only the error code aligns).
--   * Concurrent duplicates can pass the EXISTS pre-checks and then hit the
--     partial unique index; the unique_violation is reported with the contract
--     code: DUPLICATE_PRODUCTION / MORTALITY_ALREADY_RECORDED (the latter still
--     reports the existing deaths value, re-read after the winner committed).
-- ============================================================================

-- ── 18. register_daily_production ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION register_daily_production(
  p_flock_id        UUID,
  p_production_date DATE,
  p_eggs_total      INTEGER,
  p_eggs_broken     INTEGER DEFAULT 0,
  p_eggs_dirty      INTEGER DEFAULT 0,
  p_reason          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           UUID := auth.uid();
  v_role          TEXT;
  v_production_id UUID;
BEGIN
  v_role := current_app_role();                     -- raises if the user is unknown or inactive
  IF v_role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                      WHERE operator_id = v_uid AND flock_id = p_flock_id AND activo = true) THEN
    RAISE EXCEPTION 'FLOCK_NOT_ASSIGNED: operator is not assigned to this flock';
  END IF;

  IF p_eggs_total IS NULL OR p_eggs_total < 0
     OR p_eggs_broken IS NULL OR p_eggs_broken < 0
     OR p_eggs_dirty IS NULL OR p_eggs_dirty < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM flocks WHERE id = p_flock_id AND estado = 'ACTIVE') THEN
    RAISE EXCEPTION 'FLOCK_NOT_ACTIVE';
  END IF;

  PERFORM assert_period_open(p_production_date);

  IF EXISTS (SELECT 1 FROM daily_production
              WHERE flock_id = p_flock_id AND production_date = p_production_date AND is_current = true) THEN
    RAISE EXCEPTION 'DUPLICATE_PRODUCTION: production already recorded for this flock on %; rectify it instead', p_production_date;
  END IF;

  BEGIN
    INSERT INTO daily_production (flock_id, production_date, eggs_total, eggs_broken, eggs_dirty,
           is_current, version_seq, created_by)
    VALUES (p_flock_id, p_production_date, p_eggs_total, p_eggs_broken, p_eggs_dirty, true, 0, v_uid)
    RETURNING id INTO v_production_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_PRODUCTION: production already recorded for this flock on %; rectify it instead', p_production_date;
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('daily_production', v_production_id::TEXT, 'CREATE',
          jsonb_build_object('flock_id', p_flock_id, 'production_date', p_production_date,
                             'eggs_total', p_eggs_total),
          p_reason, v_uid);

  RETURN jsonb_build_object('production_id', v_production_id, 'production_date', p_production_date,
                            'eggs_total', p_eggs_total);
END;
$$;

-- ── 19. rectify_daily_production ───────────────────────────────────────────
-- One RPC, two actors: ADMIN any current row; OPERATOR only its own rows on a
-- flock still assigned to it. Retire FIRST (idx_daily_production_current),
-- then insert, then point superseded_by. Original production_date governs.

CREATE OR REPLACE FUNCTION rectify_daily_production(
  p_production_id   UUID,
  p_new_eggs_total  INTEGER,
  p_new_eggs_broken INTEGER,
  p_new_eggs_dirty  INTEGER,
  p_reason          TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_role        TEXT;
  v_old         daily_production;
  v_new_version INTEGER;
  v_new_id      UUID;
BEGIN
  -- 1. authorize: the role is resolved internally, never from a parameter
  v_role := current_app_role();
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  SELECT * INTO v_old FROM daily_production WHERE id = p_production_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRODUCTION_NOT_FOUND';
  END IF;
  IF v_old.is_current = false THEN
    RAISE EXCEPTION 'ALREADY_SUPERSEDED';
  END IF;

  IF v_role = 'OPERATOR' THEN
    IF v_old.created_by IS DISTINCT FROM v_uid THEN
      RAISE EXCEPTION 'NOT_OWN_RECORD: an operator may only rectify production it recorded';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM operator_assignments
                    WHERE operator_id = v_uid AND flock_id = v_old.flock_id AND activo = true) THEN
      RAISE EXCEPTION 'FLOCK_NOT_ASSIGNED: operator is not currently assigned to this flock';
    END IF;
  END IF;
  -- ADMIN needs no extra predicate: any current row is rectifiable.

  -- 2. validate the replacement COMPLETELY before mutating anything
  IF p_new_eggs_total IS NULL OR p_new_eggs_total < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF p_new_eggs_broken IS NULL OR p_new_eggs_broken < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF p_new_eggs_dirty IS NULL OR p_new_eggs_dirty < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  -- 3. period guard on the ORIGINAL production_date (identical for both actors)
  PERFORM assert_period_open(v_old.production_date);

  v_new_version := v_old.version_seq + 1;

  -- 4. RETIRE the current row FIRST
  UPDATE daily_production SET is_current = false WHERE id = p_production_id;

  -- 5. THEN insert the corrected version, authored by the real actor
  INSERT INTO daily_production (flock_id, production_date, eggs_total, eggs_broken, eggs_dirty,
         is_current, version_seq, created_by)
  VALUES (v_old.flock_id, v_old.production_date, p_new_eggs_total, p_new_eggs_broken,
          p_new_eggs_dirty, true, v_new_version, v_uid)
  RETURNING id INTO v_new_id;

  -- 6. supersession pointer (replacement is strictly 1:1)
  UPDATE daily_production SET superseded_by = v_new_id WHERE id = p_production_id;

  -- 7. audit: actor and the role that authorized the correction
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('daily_production', p_production_id::TEXT, 'RECTIFY',
          jsonb_build_object('eggs_total', v_old.eggs_total, 'eggs_broken', v_old.eggs_broken,
                             'eggs_dirty', v_old.eggs_dirty, 'version', v_old.version_seq,
                             'created_by', v_old.created_by),
          jsonb_build_object('eggs_total', p_new_eggs_total, 'eggs_broken', p_new_eggs_broken,
                             'eggs_dirty', p_new_eggs_dirty, 'version', v_new_version,
                             'new_id', v_new_id, 'actor_role', v_role),
          p_reason, v_uid);

  RETURN jsonb_build_object('previous_id', p_production_id, 'new_id', v_new_id, 'version_seq', v_new_version);
END;
$$;

-- ── 20. register_mortality ─────────────────────────────────────────────────
-- delta stored negative. One current MORTALITY per flock/date; a duplicate
-- reports the existing value (frozen Part 11), no conflict record.

CREATE OR REPLACE FUNCTION register_mortality(
  p_flock_id   UUID,
  p_event_date DATE,
  p_deaths     BIGINT,
  p_reason     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_role     TEXT;
  v_existing population_events;
  v_event_id BIGINT;
BEGIN
  v_role := current_app_role();
  IF v_role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                      WHERE operator_id = v_uid AND flock_id = p_flock_id AND activo = true) THEN
    RAISE EXCEPTION 'FLOCK_NOT_ASSIGNED';
  END IF;

  IF p_deaths IS NULL OR p_deaths <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: deaths must be positive';
  END IF;
  PERFORM assert_period_open(p_event_date);

  SELECT * INTO v_existing FROM population_events
   WHERE flock_id = p_flock_id AND event_date = p_event_date
     AND event_type = 'MORTALITY' AND is_current = true;
  IF FOUND THEN
    RAISE EXCEPTION 'MORTALITY_ALREADY_RECORDED: % deaths already recorded for this flock on %; rectify instead',
      -v_existing.delta, p_event_date;
  END IF;

  BEGIN
    INSERT INTO population_events (flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by)
    VALUES (p_flock_id, 'MORTALITY', -p_deaths, p_event_date, true, 0, p_reason, v_uid)
    RETURNING id INTO v_event_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM population_events
     WHERE flock_id = p_flock_id AND event_date = p_event_date
       AND event_type = 'MORTALITY' AND is_current = true;
    RAISE EXCEPTION 'MORTALITY_ALREADY_RECORDED: % deaths already recorded for this flock on %; rectify instead',
      -v_existing.delta, p_event_date;
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('population_events', v_event_id::TEXT, 'MORTALITY',
          jsonb_build_object('flock_id', p_flock_id, 'event_date', p_event_date, 'deaths', p_deaths),
          p_reason, v_uid);

  RETURN jsonb_build_object('event_id', v_event_id, 'event_date', p_event_date, 'deaths', p_deaths);
END;
$$;

-- ── 21. rectify_mortality ──────────────────────────────────────────────────
-- ADMIN only. Retire first, insert replacement, point superseded_by. Old
-- business fields (flock_id, event_date, delta) are never modified.

CREATE OR REPLACE FUNCTION rectify_mortality(
  p_event_id   BIGINT,
  p_new_deaths BIGINT,
  p_reason     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid         UUID := auth.uid();
  v_old         population_events;
  v_new_version INTEGER;
  v_new_id      BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_new_deaths IS NULL OR p_new_deaths <= 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;

  SELECT * INTO v_old FROM population_events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND';
  END IF;
  IF v_old.event_type <> 'MORTALITY' THEN
    RAISE EXCEPTION 'NOT_A_MORTALITY_EVENT';
  END IF;
  IF v_old.is_current = false THEN
    RAISE EXCEPTION 'ALREADY_SUPERSEDED';
  END IF;

  PERFORM assert_period_open(v_old.event_date);

  v_new_version := v_old.version_seq + 1;

  -- retire first so the partial unique index never sees two current rows
  UPDATE population_events SET is_current = false WHERE id = p_event_id;

  INSERT INTO population_events (flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by)
  VALUES (v_old.flock_id, 'MORTALITY', -p_new_deaths, v_old.event_date, true, v_new_version, p_reason, v_uid)
  RETURNING id INTO v_new_id;

  UPDATE population_events SET superseded_by = v_new_id WHERE id = p_event_id;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('population_events', p_event_id::TEXT, 'RECTIFY_MORTALITY',
          jsonb_build_object('deaths', -v_old.delta, 'version', v_old.version_seq),
          jsonb_build_object('deaths', p_new_deaths, 'version', v_new_version, 'new_id', v_new_id),
          p_reason, v_uid);

  RETURN jsonb_build_object('previous_id', p_event_id, 'new_id', v_new_id, 'version_seq', v_new_version);
END;
$$;

-- ── 22. register_count_adjustment ──────────────────────────────────────────
-- Explicit, audited recount variance. Any number per flock/date; never
-- overwrites mortality.

CREATE OR REPLACE FUNCTION register_count_adjustment(
  p_flock_id   UUID,
  p_event_date DATE,
  p_delta      BIGINT,
  p_reason     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_role     TEXT;
  v_event_id BIGINT;
BEGIN
  v_role := current_app_role();
  IF v_role = 'OPERATOR'
     AND NOT EXISTS (SELECT 1 FROM operator_assignments
                      WHERE operator_id = v_uid AND flock_id = p_flock_id AND activo = true) THEN
    RAISE EXCEPTION 'FLOCK_NOT_ASSIGNED';
  END IF;

  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: delta must be non-zero';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: a count adjustment must be explained';
  END IF;

  PERFORM assert_period_open(p_event_date);

  INSERT INTO population_events (flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by)
  VALUES (p_flock_id, 'COUNT_ADJUSTMENT', p_delta, p_event_date, true, 0, p_reason, v_uid)
  RETURNING id INTO v_event_id;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('population_events', v_event_id::TEXT, 'COUNT_ADJUSTMENT',
          jsonb_build_object('flock_id', p_flock_id, 'event_date', p_event_date, 'delta', p_delta),
          p_reason, v_uid);

  RETURN jsonb_build_object('event_id', v_event_id, 'delta', p_delta);
END;
$$;

-- ── ownership and EXECUTE perimeter (RLS spec §4) ──────────────────────────

ALTER FUNCTION register_daily_production(UUID, DATE, INTEGER, INTEGER, INTEGER, TEXT) OWNER TO postgres;
ALTER FUNCTION rectify_daily_production(UUID, INTEGER, INTEGER, INTEGER, TEXT) OWNER TO postgres;
ALTER FUNCTION register_mortality(UUID, DATE, BIGINT, TEXT) OWNER TO postgres;
ALTER FUNCTION rectify_mortality(BIGINT, BIGINT, TEXT) OWNER TO postgres;
ALTER FUNCTION register_count_adjustment(UUID, DATE, BIGINT, TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION register_daily_production(UUID, DATE, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION rectify_daily_production(UUID, INTEGER, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION register_mortality(UUID, DATE, BIGINT, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION rectify_mortality(BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION register_count_adjustment(UUID, DATE, BIGINT, TEXT) FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION register_daily_production(UUID, DATE, INTEGER, INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rectify_daily_production(UUID, INTEGER, INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION register_mortality(UUID, DATE, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION rectify_mortality(BIGINT, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION register_count_adjustment(UUID, DATE, BIGINT, TEXT) TO authenticated;
