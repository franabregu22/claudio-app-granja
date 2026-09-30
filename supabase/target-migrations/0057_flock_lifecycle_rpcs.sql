-- ============================================================================
-- TARGET V1 — 0057 FLOCK LIFECYCLE (ADR-007)
-- Authority: .planning/adr/ADR-007_FLOCK_LIFECYCLE.md (ACCEPTED, owner decisions D-F27B-1, D-F27B-3…6)
--            RPC_CONTRACTS_V1.md 44 register_flock, 45 close_flock [ADR-007]
--            RLS_IMPLEMENTATION_SPEC_V1.md §flocks (the "privileged path" is RPC 44 / 45)
--            DATABASE_INVARIANTS_V1.md invariant 1 (one ACTIVE flock per shed) and
--            invariant 29 (no dated flock activity after flocks.exit_date) [ADR-007]
--
-- Adds:
--   * RPC 44 register_flock / RPC 45 close_flock (SECURITY DEFINER, ADMIN in-body check).
--     The SECURITY DEFINER set grows 60 → 62 (owner-approved, ADR-007 D-F27B-3).
--   * assert_flock_activity_date(): an INVOKER, owner-only helper (not callable by any API role).
-- Re-defines, with exactly one added line each (the helper call before the period guard; nothing else changes):
--   register_daily_production, rectify_daily_production, register_mortality, rectify_mortality,
--   register_count_adjustment (0024) and assign_flock_feed (0030).
--   CREATE OR REPLACE keeps their owner and EXECUTE grants.
--
-- No table, column, policy or table grant changes: flocks keeps no INSERT / UPDATE / DELETE grant.
-- Business today is the canonical (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE.
--
-- Locking:
--   * register_flock locks the shed row (FOR UPDATE): two registrations for one shed run one after the
--     other and the second gets SHED_OCCUPIED; the partial unique index idx_flocks_shed_active stays the
--     backstop (its unique_violation is reported with the same code).
--   * close_flock locks the flock row (FOR UPDATE). The helper takes FOR KEY SHARE on the flock, which
--     conflicts only with FOR UPDATE: a dated write concurrent with a close waits for it and then sees the
--     committed exit_date, while production writers still never block on assign_flock_feed's
--     FOR NO KEY UPDATE (0030 note unchanged).
-- ============================================================================

-- ── helper: no dated flock activity after the flock's exit date (invariant 29) ──
CREATE OR REPLACE FUNCTION assert_flock_activity_date(p_flock_id UUID, p_activity_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_exit DATE;
BEGIN
  SELECT exit_date INTO v_exit FROM flocks WHERE id = p_flock_id FOR KEY SHARE;
  -- a missing flock is left to the caller's own checks / foreign keys
  IF FOUND AND v_exit IS NOT NULL AND p_activity_date > v_exit THEN
    RAISE EXCEPTION 'ACTIVITY_AFTER_FLOCK_EXIT: % is after the flock exit date %', p_activity_date, v_exit;
  END IF;
END;
$$;
ALTER  FUNCTION assert_flock_activity_date(UUID, DATE) OWNER TO postgres;
REVOKE ALL ON FUNCTION assert_flock_activity_date(UUID, DATE) FROM PUBLIC, anon, authenticated, service_role;

-- ── RPC 44 register_flock ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_flock(
  p_shed_id            UUID,
  p_entry_date         DATE,
  p_initial_population BIGINT,
  p_genetics_line      VARCHAR DEFAULT NULL,
  p_birth_date         DATE    DEFAULT NULL,
  p_supplier_id        UUID    DEFAULT NULL,
  p_purchase_id        UUID    DEFAULT NULL,
  p_reason             TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_today    DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_shed     sheds;
  v_flock_id UUID;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;

  IF p_initial_population IS NULL OR p_initial_population < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: initial_population must be >= 0';
  END IF;
  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE: entry_date is required';
  END IF;
  IF p_entry_date > v_today THEN
    RAISE EXCEPTION 'INVALID_DATE: entry_date % is after the business date %', p_entry_date, v_today;
  END IF;
  IF p_birth_date IS NOT NULL AND p_birth_date > p_entry_date THEN
    RAISE EXCEPTION 'INVALID_DATE: birth_date % is after entry_date %', p_birth_date, p_entry_date;
  END IF;

  PERFORM assert_period_open(p_entry_date);

  SELECT * INTO v_shed FROM sheds WHERE id = p_shed_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SHED_NOT_FOUND';
  END IF;
  IF NOT v_shed.activo THEN
    RAISE EXCEPTION 'SHED_INACTIVE';
  END IF;
  IF EXISTS (SELECT 1 FROM flocks WHERE shed_id = p_shed_id AND estado = 'ACTIVE') THEN
    RAISE EXCEPTION 'SHED_OCCUPIED: the shed already has an ACTIVE flock';
  END IF;
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier_id) THEN
    RAISE EXCEPTION 'SUPPLIER_NOT_FOUND';
  END IF;
  IF p_purchase_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchases WHERE id = p_purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND';
  END IF;

  BEGIN
    INSERT INTO flocks (shed_id, estado, genetics_line, birth_date, entry_date, initial_population,
                        supplier_id, purchase_id, created_by)
    VALUES (p_shed_id, 'ACTIVE', NULLIF(trim(p_genetics_line), ''), p_birth_date, p_entry_date, p_initial_population,
            p_supplier_id, p_purchase_id, v_uid)
    RETURNING id INTO v_flock_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'SHED_OCCUPIED: the shed already has an ACTIVE flock';
  END;

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('flocks', v_flock_id::TEXT, 'CREATE',
          jsonb_build_object('shed_id', p_shed_id, 'entry_date', p_entry_date,
                             'initial_population', p_initial_population, 'estado', 'ACTIVE'),
          p_reason, v_uid);

  RETURN jsonb_build_object('flock_id', v_flock_id, 'shed_id', p_shed_id, 'entry_date', p_entry_date,
                            'initial_population', p_initial_population, 'estado', 'ACTIVE');
END;
$$;

-- ── RPC 45 close_flock ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION close_flock(
  p_flock_id  UUID,
  p_exit_date DATE,
  p_reason    TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_today   DATE := (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE;
  v_flock   flocks;
  v_closed  UUID[];
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_exit_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE: exit_date is required';
  END IF;

  SELECT * INTO v_flock FROM flocks WHERE id = p_flock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLOCK_NOT_FOUND';
  END IF;
  IF v_flock.estado <> 'ACTIVE' THEN
    RAISE EXCEPTION 'FLOCK_NOT_ACTIVE: current state is %', v_flock.estado;
  END IF;
  IF p_exit_date < v_flock.entry_date THEN
    RAISE EXCEPTION 'INVALID_DATE: exit_date % is before entry_date %', p_exit_date, v_flock.entry_date;
  END IF;
  IF p_exit_date > v_today THEN
    RAISE EXCEPTION 'INVALID_DATE: exit_date % is after the business date %', p_exit_date, v_today;
  END IF;

  -- invariant 29: no current dated activity may fall after the exit date
  IF EXISTS (SELECT 1 FROM daily_production
              WHERE flock_id = p_flock_id AND is_current AND production_date > p_exit_date)
     OR EXISTS (SELECT 1 FROM population_events
                 WHERE flock_id = p_flock_id AND is_current AND event_date > p_exit_date)
     OR EXISTS (SELECT 1 FROM flock_feed_assignment
                 WHERE flock_id = p_flock_id AND effective_from > p_exit_date) THEN
    RAISE EXCEPTION 'EXIT_BEFORE_RECORDED_ACTIVITY: the flock has activity dated after %', p_exit_date;
  END IF;

  PERFORM assert_period_open(p_exit_date);

  UPDATE flocks SET estado = 'RETIRED', exit_date = p_exit_date WHERE id = p_flock_id;

  -- D-F27B-5: the flock's active operator assignments end with it (rows kept as history)
  WITH closed AS (
    UPDATE operator_assignments SET activo = false
     WHERE flock_id = p_flock_id AND activo = true
    RETURNING id
  )
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_closed FROM closed;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('flocks', p_flock_id::TEXT, 'CLOSE',
          jsonb_build_object('estado', v_flock.estado, 'exit_date', v_flock.exit_date),
          jsonb_build_object('estado', 'RETIRED', 'exit_date', p_exit_date,
                             'deactivated_assignment_ids', to_jsonb(v_closed)),
          p_reason, v_uid);

  RETURN jsonb_build_object('flock_id', p_flock_id, 'shed_id', v_flock.shed_id, 'exit_date', p_exit_date,
                            'estado', 'RETIRED', 'deactivated_assignments', cardinality(v_closed));
END;
$$;

ALTER  FUNCTION register_flock(UUID, DATE, BIGINT, VARCHAR, DATE, UUID, UUID, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_flock(UUID, DATE, BIGINT, VARCHAR, DATE, UUID, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_flock(UUID, DATE, BIGINT, VARCHAR, DATE, UUID, UUID, TEXT) TO authenticated;

ALTER  FUNCTION close_flock(UUID, DATE, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION close_flock(UUID, DATE, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION close_flock(UUID, DATE, TEXT) TO authenticated;

-- ── invariant 29 in the existing dated flock-activity RPCs (one added line each) ──

-- register_daily_production: + assert_flock_activity_date (invariant 29)
CREATE OR REPLACE FUNCTION public.register_daily_production(p_flock_id uuid, p_production_date date, p_eggs_total integer, p_eggs_broken integer DEFAULT 0, p_eggs_dirty integer DEFAULT 0, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  PERFORM assert_flock_activity_date(p_flock_id, p_production_date);
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
$function$;

-- rectify_daily_production: + assert_flock_activity_date (invariant 29)
CREATE OR REPLACE FUNCTION public.rectify_daily_production(p_production_id uuid, p_new_eggs_total integer, p_new_eggs_broken integer, p_new_eggs_dirty integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  PERFORM assert_flock_activity_date(v_old.flock_id, v_old.production_date);
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
$function$;

-- register_mortality: + assert_flock_activity_date (invariant 29)
CREATE OR REPLACE FUNCTION public.register_mortality(p_flock_id uuid, p_event_date date, p_deaths bigint, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  PERFORM assert_flock_activity_date(p_flock_id, p_event_date);
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
$function$;

-- rectify_mortality: + assert_flock_activity_date (invariant 29)
CREATE OR REPLACE FUNCTION public.rectify_mortality(p_event_id bigint, p_new_deaths bigint, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  PERFORM assert_flock_activity_date(v_old.flock_id, v_old.event_date);
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
$function$;

-- register_count_adjustment: + assert_flock_activity_date (invariant 29)
CREATE OR REPLACE FUNCTION public.register_count_adjustment(p_flock_id uuid, p_event_date date, p_delta bigint, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  PERFORM assert_flock_activity_date(p_flock_id, p_event_date);
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
$function$;

-- assign_flock_feed: + assert_flock_activity_date (invariant 29)
CREATE OR REPLACE FUNCTION public.assign_flock_feed(p_flock_id uuid, p_feed_type_id uuid, p_effective_from date, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  PERFORM assert_flock_activity_date(p_flock_id, p_effective_from);
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
$function$;
