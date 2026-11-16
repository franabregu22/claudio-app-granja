-- ============================================================================
-- TARGET V1 — 0129 PRODUCCIÓN SIN ASIGNACIONES DE LOTES (owner 2026-11-16)
--
--   The operator↔flock assignment confused more than it helped: an operator records production,
--   mortality and count adjustments on ANY flock (the flock must still be active on the date —
--   assert_flock_activity_date) and reads every flock.
--   * register_daily_production, rectify_daily_production, register_mortality,
--     register_count_adjustment: the 0057 bodies with ONLY the FLOCK_NOT_ASSIGNED check removed
--     (an operator still rectifies only the production it recorded: NOT_OWN_RECORD).
--   * the four operator SELECT policies (flocks, daily_production, population_events,
--     flock_feed_assignment) become role-only.
--   operator_assignments stays as history (close_flock still deactivates its rows); nothing reads it.
--   No data is written by this migration.
-- ============================================================================

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

DROP POLICY flocks_operator_assigned ON flocks;
CREATE POLICY flocks_operator_assigned ON flocks FOR SELECT
  USING (current_app_role() = 'OPERATOR');

DROP POLICY daily_production_operator_select ON daily_production;
CREATE POLICY daily_production_operator_select ON daily_production FOR SELECT
  USING (current_app_role() = 'OPERATOR');

DROP POLICY population_events_operator_select ON population_events;
CREATE POLICY population_events_operator_select ON population_events FOR SELECT
  USING (current_app_role() = 'OPERATOR');

DROP POLICY flock_feed_assignment_operator_select ON flock_feed_assignment;
CREATE POLICY flock_feed_assignment_operator_select ON flock_feed_assignment FOR SELECT
  USING (current_app_role() = 'OPERATOR');
