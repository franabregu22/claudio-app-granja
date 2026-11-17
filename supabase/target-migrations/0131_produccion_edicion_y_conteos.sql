-- ============================================================================
-- TARGET V1 — 0131 PRODUCCIÓN: EDICIÓN DEL DÍA, NOTAS Y CONTEOS DE AVES (owner 2026-11-17)
--
--   «El lápiz abre el formulario que se cargó y se modifica ahí, siempre con motivo; etiqueta "modificado" con quién y qué.
--    Las notas aparecen en la tabla. En el ajuste de conteo pongo el total contado; historial con responsable; se puede borrar
--    el último conteo de cada lote. Pueden corregir todos.»
--
--   1. flock_day_note (flock, date) → the day's note (was only the audit reason of the registration). Backfilled from the
--      mortality registrations' reasons (version 0; the import markers «legacy:…» are not notes).
--      daily_production.recorded_time — the time of day the production was recorded («la hora de registro»; the form proposes
--      the current time, editable). Backfilled with the Buenos Aires time of the first version of the days recorded in the ERP;
--      NULL for the imported history (its creation time is the import, not the collection).
--   2. register_production_day(flock, date, eggs, broken, deaths, notes, time) — the day in ONE transaction (production with its
--      time — now when NULL —, mortality when > 0, note), through register_daily_production / register_mortality (their checks,
--      audits and 0129 rules unchanged).
--   3. edit_production_day(flock, date, eggs, broken, deaths, notes, time, reason) — ADMIN and OPERATOR on any record: the reason
--      is mandatory; production and mortality keep their version chains (retire → insert → superseded_by); mortality may go to 0
--      (the event is retired) or from 0 (a new event); time NULL keeps the recorded one; one audit_events row 'flock_day' EDIT
--      with before / after {eggs_total, eggs_broken, deaths, notes, time}. Eggs dirty are no longer collected (the version keeps
--      the old value; new days 0).
--   4. list_production_day_edits(from, to) — the modifications of the days in range with the actor's name (0109; «No disponible»):
--      the EDIT rows plus the earlier rectify_daily_production / rectify_mortality audits.
--      list_production_days(from, to) — per day: the recorded time and WHO LOADED it (the author of the first version of the
--      production — or of the mortality on a day without production —; «Importado» for the imported history).
--   5. bird_count — a count of birds by its TOTAL: computed = population the system had (initial + current events up to that
--      date), counted, and the COUNT_ADJUSTMENT event of the difference (none when equal). register_bird_count refuses a date
--      before the flock's last valid count; void_bird_count voids ONLY the flock's last valid count (its event is retired:
--      the population goes back). list_bird_counts names the people. The one existing count adjustment is backfilled.
--   register_count_adjustment / rectify_daily_production / rectify_mortality stay (the ERP stops calling them).
--   SECURITY DEFINER set +7.
-- ============================================================================

-- ── 1. notes ────────────────────────────────────────────────────────────────
CREATE TABLE flock_day_note (
  flock_id   UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  note_date  DATE NOT NULL,
  notes      TEXT NOT NULL CHECK (btrim(notes) <> '' AND length(notes) <= 500),
  created_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (flock_id, note_date)
);
ALTER TABLE flock_day_note ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE flock_day_note FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE flock_day_note TO authenticated;
CREATE POLICY flock_day_note_select ON flock_day_note FOR SELECT USING (current_app_role() IN ('ADMIN', 'OPERATOR'));

INSERT INTO flock_day_note (flock_id, note_date, notes, created_by, created_at)
SELECT DISTINCT ON (pe.flock_id, pe.event_date) pe.flock_id, pe.event_date, left(btrim(pe.reason), 500), pe.created_by, pe.created_at
  FROM population_events pe
 WHERE pe.event_type = 'MORTALITY' AND pe.version_seq = 0
   AND coalesce(btrim(pe.reason), '') <> '' AND pe.reason NOT LIKE 'legacy:%'
 ORDER BY pe.flock_id, pe.event_date, pe.id;

ALTER TABLE daily_production ADD COLUMN recorded_time TIME(0);
COMMENT ON COLUMN daily_production.recorded_time IS 'Time of day the production was recorded (0131; Buenos Aires, editable); NULL = not known (imported history)';
UPDATE daily_production dp
   SET recorded_time = (r.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::TIME(0)
  FROM (SELECT DISTINCT ON (d.flock_id, d.production_date) d.flock_id, d.production_date, d.created_at
          FROM daily_production d
         WHERE d.version_seq = 0
           AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_type = 'daily_production' AND a.entity_id = d.id::TEXT
                              AND a.action = 'CREATE' AND a.reason LIKE 'legacy:%')
         ORDER BY d.flock_id, d.production_date, d.created_at) r
 WHERE r.flock_id = dp.flock_id AND r.production_date = dp.production_date;

-- ── 2. register the day ────────────────────────────────────────────────────
CREATE FUNCTION register_production_day(p_flock_id UUID, p_date DATE, p_eggs_total INTEGER, p_eggs_broken INTEGER, p_deaths BIGINT, p_notes TEXT,
                                        p_recorded_time TIME DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_role  TEXT;
  v_notes TEXT := nullif(btrim(coalesce(p_notes, '')), '');
  v_prod  JSONB;
  v_time  TIME(0);
BEGIN
  v_role := current_app_role();
  IF p_eggs_total IS NULL OR p_eggs_total < 0 OR coalesce(p_eggs_broken, 0) < 0 OR coalesce(p_deaths, 0) < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF coalesce(p_eggs_broken, 0) > p_eggs_total THEN
    RAISE EXCEPTION 'BROKEN_EXCEEDS_TOTAL: broken eggs are part of the total';
  END IF;
  IF length(v_notes) > 500 THEN
    RAISE EXCEPTION 'NOTES_TOO_LONG: at most 500 characters';
  END IF;
  v_prod := register_daily_production(p_flock_id, p_date, p_eggs_total, coalesce(p_eggs_broken, 0), 0, v_notes);
  v_time := coalesce(p_recorded_time, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::TIME)::TIME(0);
  UPDATE daily_production SET recorded_time = v_time WHERE id = (v_prod->>'production_id')::UUID;
  IF coalesce(p_deaths, 0) > 0 THEN
    PERFORM register_mortality(p_flock_id, p_date, p_deaths, v_notes);
  END IF;
  IF v_notes IS NOT NULL THEN
    INSERT INTO flock_day_note (flock_id, note_date, notes, created_by) VALUES (p_flock_id, p_date, v_notes, v_uid)
    ON CONFLICT (flock_id, note_date) DO UPDATE SET notes = EXCLUDED.notes, updated_by = v_uid, updated_at = now();
  END IF;
  RETURN v_prod || jsonb_build_object('deaths', coalesce(p_deaths, 0), 'notes', v_notes, 'time', to_char(v_time, 'HH24:MI'));
END $$;

-- ── 3. edit the day ────────────────────────────────────────────────────────
CREATE FUNCTION edit_production_day(p_flock_id UUID, p_date DATE, p_eggs_total INTEGER, p_eggs_broken INTEGER, p_deaths BIGINT,
                                    p_notes TEXT, p_recorded_time TIME, p_reason TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_role    TEXT;
  v_notes   TEXT := nullif(btrim(coalesce(p_notes, '')), '');
  v_deaths  BIGINT := coalesce(p_deaths, 0);
  v_broken  INTEGER := coalesce(p_eggs_broken, 0);
  v_prod    daily_production;
  v_mort    population_events;
  v_note    flock_day_note;
  v_before  JSONB;
  v_after   JSONB;
  v_new_id  UUID;
  v_new_ev  BIGINT;
  v_version INTEGER;
  v_time    TIME(0);
BEGIN
  v_role := current_app_role();
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF (p_eggs_total IS NOT NULL AND p_eggs_total < 0) OR v_broken < 0 OR v_deaths < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY';
  END IF;
  IF p_eggs_total IS NOT NULL AND v_broken > p_eggs_total THEN
    RAISE EXCEPTION 'BROKEN_EXCEEDS_TOTAL: broken eggs are part of the total';
  END IF;
  IF length(v_notes) > 500 THEN
    RAISE EXCEPTION 'NOTES_TOO_LONG: at most 500 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM flocks WHERE id = p_flock_id) THEN
    RAISE EXCEPTION 'FLOCK_NOT_FOUND';
  END IF;
  PERFORM assert_flock_activity_date(p_flock_id, p_date);
  PERFORM assert_period_open(p_date);

  SELECT * INTO v_prod FROM daily_production WHERE flock_id = p_flock_id AND production_date = p_date AND is_current FOR UPDATE;
  SELECT * INTO v_mort FROM population_events
   WHERE flock_id = p_flock_id AND event_date = p_date AND event_type = 'MORTALITY' AND is_current FOR UPDATE;
  SELECT * INTO v_note FROM flock_day_note WHERE flock_id = p_flock_id AND note_date = p_date FOR UPDATE;

  IF v_prod.id IS NOT NULL AND p_eggs_total IS NULL THEN
    RAISE EXCEPTION 'EGGS_REQUIRED: the day has production; enter its eggs';
  END IF;
  IF v_prod.id IS NULL AND p_eggs_total IS NULL AND v_mort.id IS NULL AND v_deaths = 0 AND v_note.notes IS NULL AND v_notes IS NULL THEN
    RAISE EXCEPTION 'DAY_NOT_FOUND';
  END IF;

  -- the time: NULL keeps the recorded one (a new production: now)
  v_time := CASE WHEN p_eggs_total IS NULL THEN NULL
                 ELSE coalesce(p_recorded_time, v_prod.recorded_time,
                               CASE WHEN v_prod.id IS NULL THEN (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::TIME END)::TIME(0) END;
  v_before := jsonb_build_object('eggs_total', v_prod.eggs_total, 'eggs_broken', v_prod.eggs_broken,
                                 'deaths', coalesce(-v_mort.delta, 0), 'notes', v_note.notes, 'time', to_char(v_prod.recorded_time, 'HH24:MI'));
  v_after  := jsonb_build_object('eggs_total', p_eggs_total, 'eggs_broken', CASE WHEN p_eggs_total IS NULL THEN NULL ELSE v_broken END,
                                 'deaths', v_deaths, 'notes', v_notes, 'time', to_char(v_time, 'HH24:MI'));
  IF v_before = v_after THEN
    RAISE EXCEPTION 'NO_CHANGES';
  END IF;

  -- production: a new version (or the first one)
  IF v_prod.id IS NOT NULL AND (v_prod.eggs_total <> p_eggs_total OR v_prod.eggs_broken <> v_broken
                                OR v_prod.recorded_time IS DISTINCT FROM v_time) THEN
    UPDATE daily_production SET is_current = false WHERE id = v_prod.id;
    INSERT INTO daily_production (flock_id, production_date, eggs_total, eggs_broken, eggs_dirty, is_current, version_seq, created_by, recorded_time)
    VALUES (p_flock_id, p_date, p_eggs_total, v_broken, v_prod.eggs_dirty, true, v_prod.version_seq + 1, v_uid, v_time)
    RETURNING id INTO v_new_id;
    UPDATE daily_production SET superseded_by = v_new_id WHERE id = v_prod.id;
  ELSIF v_prod.id IS NULL AND p_eggs_total IS NOT NULL THEN
    SELECT coalesce(max(version_seq) + 1, 0) INTO v_version FROM daily_production WHERE flock_id = p_flock_id AND production_date = p_date;
    INSERT INTO daily_production (flock_id, production_date, eggs_total, eggs_broken, eggs_dirty, is_current, version_seq, created_by, recorded_time)
    VALUES (p_flock_id, p_date, p_eggs_total, v_broken, 0, true, v_version, v_uid, v_time);
  END IF;

  -- mortality: a new version, retired (0) or a first event
  IF coalesce(-v_mort.delta, 0) <> v_deaths THEN
    IF v_mort.id IS NOT NULL THEN
      UPDATE population_events SET is_current = false WHERE id = v_mort.id;
    END IF;
    IF v_deaths > 0 THEN
      SELECT coalesce(max(version_seq) + 1, 0) INTO v_version FROM population_events
       WHERE flock_id = p_flock_id AND event_date = p_date AND event_type = 'MORTALITY';
      INSERT INTO population_events (flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by)
      VALUES (p_flock_id, 'MORTALITY', -v_deaths, p_date, true, v_version, p_reason, v_uid)
      RETURNING id INTO v_new_ev;
      IF v_mort.id IS NOT NULL THEN
        UPDATE population_events SET superseded_by = v_new_ev WHERE id = v_mort.id;
      END IF;
    END IF;
  END IF;

  -- note
  IF v_note.notes IS DISTINCT FROM v_notes THEN
    IF v_notes IS NULL THEN
      DELETE FROM flock_day_note WHERE flock_id = p_flock_id AND note_date = p_date;
    ELSIF v_note.notes IS NULL THEN
      INSERT INTO flock_day_note (flock_id, note_date, notes, created_by) VALUES (p_flock_id, p_date, v_notes, v_uid);
    ELSE
      UPDATE flock_day_note SET notes = v_notes, updated_by = v_uid, updated_at = now() WHERE flock_id = p_flock_id AND note_date = p_date;
    END IF;
  END IF;

  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('flock_day', p_flock_id::TEXT || '|' || p_date::TEXT, 'EDIT', v_before, v_after || jsonb_build_object('actor_role', v_role),
          btrim(p_reason), v_uid);

  RETURN jsonb_build_object('flock_id', p_flock_id, 'date', p_date, 'before', v_before, 'after', v_after);
END $$;

-- ── 4. who modified what ───────────────────────────────────────────────────
CREATE FUNCTION list_production_day_edits(p_from DATE, p_to DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role TEXT;
BEGIN
  v_role := current_app_role();
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('flock_id', e.flock_id, 'date', e.d, 'at', e.performed_at,
             'actor', coalesce(nullif(concat_ws(' ', pf.nombre, pf.apellido), ''), 'No disponible'),
             'before', e.before_values, 'after', e.after_values, 'reason', e.reason) ORDER BY e.performed_at, e.id)
      FROM (
        SELECT a.id, split_part(a.entity_id, '|', 1)::UUID AS flock_id, split_part(a.entity_id, '|', 2)::DATE AS d, a.performed_at,
               a.performed_by, a.before_values, a.after_values - 'actor_role' AS after_values, a.reason
          FROM audit_events a WHERE a.entity_type = 'flock_day' AND a.action = 'EDIT'
        UNION ALL
        SELECT a.id, dp.flock_id, dp.production_date, a.performed_at, a.performed_by,
               jsonb_build_object('eggs_total', a.before_values->'eggs_total', 'eggs_broken', a.before_values->'eggs_broken'),
               jsonb_build_object('eggs_total', a.after_values->'eggs_total', 'eggs_broken', a.after_values->'eggs_broken'), a.reason
          FROM audit_events a JOIN daily_production dp ON dp.id::TEXT = a.entity_id
         WHERE a.entity_type = 'daily_production' AND a.action = 'RECTIFY'
        UNION ALL
        SELECT a.id, pe.flock_id, pe.event_date, a.performed_at, a.performed_by,
               jsonb_build_object('deaths', a.before_values->'deaths'), jsonb_build_object('deaths', a.after_values->'deaths'), a.reason
          FROM audit_events a JOIN population_events pe ON pe.id::TEXT = a.entity_id
         WHERE a.entity_type = 'population_events' AND a.action = 'RECTIFY_MORTALITY'
      ) e
      LEFT JOIN perfiles pf ON pf.id = e.performed_by
     WHERE e.d BETWEEN p_from AND p_to), '[]'::jsonb);
END $$;

CREATE FUNCTION list_production_days(p_from DATE, p_to DATE)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role TEXT;
BEGIN
  v_role := current_app_role();
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('flock_id', x.flock_id, 'date', x.d, 'time', to_char(x.t, 'HH24:MI'),
             'by', CASE WHEN x.legacy THEN 'Importado'
                        WHEN x.uid IS NULL THEN NULL
                        ELSE coalesce(nullif(concat_ws(' ', pf.nombre, pf.apellido), ''), 'No disponible') END) ORDER BY x.d, x.flock_id)
      FROM (
        SELECT k.flock_id, k.d,
               (SELECT c.recorded_time FROM daily_production c WHERE c.flock_id = k.flock_id AND c.production_date = k.d AND c.is_current) AS t,
               coalesce(fp.created_by, fm.created_by) AS uid,
               CASE WHEN fp.id IS NOT NULL THEN EXISTS (SELECT 1 FROM audit_events a WHERE a.entity_type = 'daily_production'
                                                          AND a.entity_id = fp.id::TEXT AND a.action = 'CREATE' AND a.reason LIKE 'legacy:%')
                    ELSE coalesce(fm.reason LIKE 'legacy:%', false) END AS legacy
          FROM (SELECT flock_id, production_date AS d FROM daily_production WHERE production_date BETWEEN p_from AND p_to
                UNION
                SELECT flock_id, event_date FROM population_events WHERE event_type = 'MORTALITY' AND event_date BETWEEN p_from AND p_to) k
          LEFT JOIN LATERAL (SELECT f.id, f.created_by FROM daily_production f WHERE f.flock_id = k.flock_id AND f.production_date = k.d
                              ORDER BY f.version_seq, f.created_at LIMIT 1) fp ON true
          LEFT JOIN LATERAL (SELECT m.created_by, m.reason FROM population_events m WHERE m.flock_id = k.flock_id AND m.event_date = k.d
                                AND m.event_type = 'MORTALITY' ORDER BY m.version_seq, m.created_at LIMIT 1) fm ON true
      ) x
      LEFT JOIN perfiles pf ON pf.id = x.uid), '[]'::jsonb);
END $$;

-- ── 5. bird counts ─────────────────────────────────────────────────────────
CREATE TABLE bird_count (
  id                  BIGSERIAL PRIMARY KEY,
  flock_id            UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  count_date          DATE NOT NULL,
  counted             BIGINT NOT NULL CHECK (counted >= 0),
  computed            BIGINT NOT NULL,
  population_event_id BIGINT UNIQUE REFERENCES population_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason              TEXT CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 200)),
  created_by          UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at           TIMESTAMPTZ,
  voided_by           UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  void_reason         TEXT,
  CONSTRAINT chk_bird_count_event CHECK ((population_event_id IS NULL) = (counted = computed))
);
CREATE INDEX idx_bird_count_flock ON bird_count(flock_id, count_date);
ALTER TABLE bird_count ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE bird_count FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE bird_count TO authenticated;
REVOKE ALL ON SEQUENCE bird_count_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY bird_count_select ON bird_count FOR SELECT USING (current_app_role() IN ('ADMIN', 'OPERATOR'));

-- the existing count adjustments as counts (computed = the population without it up to its date)
INSERT INTO bird_count (flock_id, count_date, counted, computed, population_event_id, reason, created_by, created_at)
SELECT pe.flock_id, pe.event_date, c.computed + pe.delta, c.computed, pe.id, nullif(left(btrim(coalesce(pe.reason, '')), 200), ''),
       pe.created_by, pe.created_at
  FROM population_events pe
  JOIN flocks f ON f.id = pe.flock_id
 CROSS JOIN LATERAL (SELECT f.initial_population + coalesce((SELECT sum(o.delta) FROM population_events o
                       WHERE o.flock_id = pe.flock_id AND o.is_current AND o.event_date <= pe.event_date AND o.id <> pe.id), 0) AS computed) c
 WHERE pe.event_type = 'COUNT_ADJUSTMENT' AND pe.is_current
 ORDER BY pe.id;

CREATE FUNCTION register_bird_count(p_flock_id UUID, p_date DATE, p_counted BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_role     TEXT;
  v_reason   TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_initial  BIGINT;
  v_computed BIGINT;
  v_last     DATE;
  v_event    BIGINT;
  v_id       BIGINT;
BEGIN
  v_role := current_app_role();
  IF p_counted IS NULL OR p_counted < 0 THEN
    RAISE EXCEPTION 'INVALID_QUANTITY: the counted birds must be zero or more';
  END IF;
  IF length(v_reason) > 200 THEN
    RAISE EXCEPTION 'REASON_TOO_LONG: at most 200 characters';
  END IF;
  SELECT initial_population INTO v_initial FROM flocks WHERE id = p_flock_id FOR UPDATE;   -- one count at a time per flock
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLOCK_NOT_FOUND';
  END IF;
  PERFORM assert_flock_activity_date(p_flock_id, p_date);
  PERFORM assert_period_open(p_date);
  SELECT max(count_date) INTO v_last FROM bird_count WHERE flock_id = p_flock_id AND voided_at IS NULL;
  IF v_last > p_date THEN
    RAISE EXCEPTION 'COUNT_BEFORE_LAST: the flock has a count on %; a count cannot be earlier', v_last;
  END IF;
  v_computed := v_initial + coalesce((SELECT sum(delta) FROM population_events
                                       WHERE flock_id = p_flock_id AND is_current AND event_date <= p_date), 0);
  IF p_counted <> v_computed THEN
    INSERT INTO population_events (flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by)
    VALUES (p_flock_id, 'COUNT_ADJUSTMENT', p_counted - v_computed, p_date, true, 0,
            coalesce(v_reason, 'Conteo de aves: ' || p_counted), v_uid)
    RETURNING id INTO v_event;
  END IF;
  INSERT INTO bird_count (flock_id, count_date, counted, computed, population_event_id, reason, created_by)
  VALUES (p_flock_id, p_date, p_counted, v_computed, v_event, v_reason, v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('bird_count', v_id::TEXT, 'BIRD_COUNT',
          jsonb_build_object('flock_id', p_flock_id, 'date', p_date, 'counted', p_counted, 'computed', v_computed,
                             'difference', p_counted - v_computed, 'event_id', v_event), v_reason, v_uid);
  RETURN jsonb_build_object('count_id', v_id, 'counted', p_counted, 'computed', v_computed, 'difference', p_counted - v_computed);
END $$;

CREATE FUNCTION void_bird_count(p_count_id BIGINT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_role   TEXT;
  v_reason TEXT := nullif(btrim(coalesce(p_reason, '')), '');
  v_flock  UUID;
  v_c      bird_count;
BEGIN
  v_role := current_app_role();
  SELECT flock_id INTO v_flock FROM bird_count WHERE id = p_count_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COUNT_NOT_FOUND';
  END IF;
  PERFORM 1 FROM flocks WHERE id = v_flock FOR UPDATE;                                     -- serialised with register_bird_count
  SELECT * INTO v_c FROM bird_count WHERE id = p_count_id FOR UPDATE;
  IF v_c.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_VOIDED';
  END IF;
  IF EXISTS (SELECT 1 FROM bird_count b WHERE b.flock_id = v_c.flock_id AND b.voided_at IS NULL AND b.id <> v_c.id
                AND (b.count_date, b.id) > (v_c.count_date, v_c.id)) THEN
    RAISE EXCEPTION 'NOT_LAST_COUNT: only the last count of the flock can be deleted';
  END IF;
  PERFORM assert_period_open(v_c.count_date);
  IF v_c.population_event_id IS NOT NULL THEN
    UPDATE population_events SET is_current = false WHERE id = v_c.population_event_id;
  END IF;
  UPDATE bird_count SET voided_at = now(), voided_by = v_uid, void_reason = v_reason WHERE id = p_count_id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, reason, performed_by)
  VALUES ('bird_count', p_count_id::TEXT, 'VOID_BIRD_COUNT',
          jsonb_build_object('flock_id', v_c.flock_id, 'date', v_c.count_date, 'counted', v_c.counted, 'computed', v_c.computed,
                             'event_id', v_c.population_event_id), v_reason, v_uid);
  RETURN jsonb_build_object('count_id', p_count_id, 'voided', true);
END $$;

CREATE FUNCTION list_bird_counts(p_flock_id UUID DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_role TEXT;
BEGIN
  v_role := current_app_role();
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', b.id, 'flock_id', b.flock_id, 'date', b.count_date, 'counted', b.counted,
             'computed', b.computed, 'difference', b.counted - b.computed, 'reason', b.reason, 'at', b.created_at,
             'by', coalesce(nullif(concat_ws(' ', c.nombre, c.apellido), ''), 'No disponible'),
             'voided_at', b.voided_at,
             'voided_by', CASE WHEN b.voided_at IS NULL THEN NULL ELSE coalesce(nullif(concat_ws(' ', v.nombre, v.apellido), ''), 'No disponible') END,
             'void_reason', b.void_reason) ORDER BY b.count_date DESC, b.id DESC)
      FROM bird_count b
      LEFT JOIN perfiles c ON c.id = b.created_by
      LEFT JOIN perfiles v ON v.id = b.voided_by
     WHERE p_flock_id IS NULL OR b.flock_id = p_flock_id), '[]'::jsonb);
END $$;

-- ── privileges ─────────────────────────────────────────────────────────────
ALTER FUNCTION register_production_day(UUID, DATE, INTEGER, INTEGER, BIGINT, TEXT, TIME) OWNER TO postgres;
ALTER FUNCTION edit_production_day(UUID, DATE, INTEGER, INTEGER, BIGINT, TEXT, TIME, TEXT) OWNER TO postgres;
ALTER FUNCTION list_production_day_edits(DATE, DATE) OWNER TO postgres;
ALTER FUNCTION list_production_days(DATE, DATE) OWNER TO postgres;
ALTER FUNCTION register_bird_count(UUID, DATE, BIGINT, TEXT) OWNER TO postgres;
ALTER FUNCTION void_bird_count(BIGINT, TEXT) OWNER TO postgres;
ALTER FUNCTION list_bird_counts(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION register_production_day(UUID, DATE, INTEGER, INTEGER, BIGINT, TEXT, TIME) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION edit_production_day(UUID, DATE, INTEGER, INTEGER, BIGINT, TEXT, TIME, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION list_production_day_edits(DATE, DATE) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION list_production_days(DATE, DATE) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION register_bird_count(UUID, DATE, BIGINT, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION void_bird_count(BIGINT, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION list_bird_counts(UUID) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION register_production_day(UUID, DATE, INTEGER, INTEGER, BIGINT, TEXT, TIME) TO authenticated;
GRANT EXECUTE ON FUNCTION edit_production_day(UUID, DATE, INTEGER, INTEGER, BIGINT, TEXT, TIME, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION list_production_day_edits(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION list_production_days(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION register_bird_count(UUID, DATE, BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION void_bird_count(BIGINT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION list_bird_counts(UUID) TO authenticated;
