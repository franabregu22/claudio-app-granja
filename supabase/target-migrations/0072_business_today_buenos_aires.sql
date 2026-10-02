-- ============================================================================
-- TARGET V1 — 0072 BUSINESS "TODAY" IS BUENOS AIRES (timezone hardening, Phase 31 pre-provisioning)
--
-- The database session timezone is UTC by contract (Phase 31: target provisioning verifies
-- SHOW timezone = UTC). CURRENT_DATE is therefore the UTC calendar date, which is already "tomorrow"
-- in Argentina from 21:00 to 24:00. Business "today" is always
--   (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
-- (the convention of 0057 close_flock / register_flock and of every instant -> business-date conversion).
--
-- report_flock_day (0046, V6): the open-ended upper bound of the calculated daily series used
-- CURRENT_DATE, so between 21:00 and 24:00 Argentina time an extra (calculated, empty) day appeared.
-- The view is re-created byte-for-byte except that bound. Columns, owner, grants and
-- security_invoker are unchanged (CREATE OR REPLACE keeps them).
--
-- Not changed here: the 0031 OPERATOR policy on feed_formula_version that used CURRENT_DATE was
-- already replaced by 0067 (role-only history read), so no live object uses CURRENT_DATE after this
-- migration (asserted below).
-- ============================================================================

CREATE OR REPLACE VIEW report_flock_day
WITH (security_invoker = true)
AS
WITH d AS (
  SELECT f.id AS flock_id, f.shed_id, f.genetics_line, f.birth_date, f.initial_population,
         gs::DATE AS business_date
    FROM flocks f
   CROSS JOIN LATERAL generate_series(f.entry_date, COALESCE(f.exit_date, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE), INTERVAL '1 day') gs
), x AS (
  SELECT d.*,
         d.initial_population + COALESCE((SELECT SUM(pe.delta) FROM population_events pe
                                           WHERE pe.flock_id = d.flock_id AND pe.is_current
                                             AND pe.event_date <= d.business_date), 0) AS population,
         COALESCE((SELECT SUM(-pe.delta) FROM population_events pe
                    WHERE pe.flock_id = d.flock_id AND pe.is_current AND pe.event_type = 'MORTALITY'
                      AND pe.event_date = d.business_date), 0)                          AS mortality,
         COALESCE((SELECT SUM(pe.delta) FROM population_events pe
                    WHERE pe.flock_id = d.flock_id AND pe.is_current AND pe.event_type = 'COUNT_ADJUSTMENT'
                      AND pe.event_date = d.business_date), 0)                          AS count_adjustment,
         (d.business_date - d.birth_date) / 7.0                                         AS age_weeks_exact
    FROM d
)
SELECT x.flock_id,
       x.shed_id,
       sh.nombre                                          AS shed_nombre,
       x.genetics_line,
       x.business_date,
       date_trunc('month', x.business_date)::DATE         AS period,
       dp.id                                              AS daily_production_id,
       dp.eggs_total,
       dp.eggs_broken,
       dp.eggs_dirty,
       x.mortality,
       x.count_adjustment,
       x.population,
       round(x.age_weeks_exact, 4)                        AS age_weeks,
       floor(x.age_weeks_exact)::INTEGER                  AS curve_age_weeks,
       CASE WHEN dp.id IS NULL OR x.population <= 0 THEN NULL
            ELSE round(dp.eggs_total * 100.0 / x.population, 4) END AS laying_pct,
       cv.expected_laying_pct,
       cv.expected_g_per_bird_day,
       fa.feed_type_id,
       CASE WHEN fa.feed_type_id IS NOT NULL AND cv.expected_g_per_bird_day IS NOT NULL
            THEN round(x.population * cv.expected_g_per_bird_day / 1000, 6) END AS theoretical_feed_kg,
       CASE WHEN dp.id IS NULL THEN NULL
            ELSE (dp.eggs_broken > dp.eggs_total OR dp.eggs_dirty > dp.eggs_total) END AS quality_data_warning
  FROM x
  LEFT JOIN sheds sh ON sh.id = x.shed_id
  LEFT JOIN daily_production dp
         ON dp.flock_id = x.flock_id AND dp.production_date = x.business_date AND dp.is_current
  LEFT JOIN genetics_consumption_curve cv
         ON cv.genetics_line = x.genetics_line AND cv.age_weeks = floor(x.age_weeks_exact)::INTEGER
  LEFT JOIN LATERAL (SELECT a.feed_type_id FROM flock_feed_assignment a
                      WHERE a.flock_id = x.flock_id AND a.effective_from <= x.business_date
                        AND (a.effective_to IS NULL OR a.effective_to >= x.business_date)
                      ORDER BY a.effective_from DESC LIMIT 1) fa ON true;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE schemaname = 'public' AND definition ~* '\mCURRENT_DATE\M')
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND (qual ~* '\mCURRENT_DATE\M' OR with_check ~* '\mCURRENT_DATE\M'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ~* '\mCURRENT_DATE\M') THEN
    RAISE EXCEPTION 'TIMEZONE_CONTRACT: a public view / policy / function still uses CURRENT_DATE (business today is Buenos Aires)';
  END IF;
END $$;
