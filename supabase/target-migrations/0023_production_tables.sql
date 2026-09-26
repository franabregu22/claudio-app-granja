-- ============================================================================
-- TARGET V1 — 0023 PRODUCTION TABLES (Phase 18, Slice 3)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain G (population_events, daily_production)
--            DATABASE_INVARIANTS_V1.md 1 (one ACTIVE flock per shed),
--            2 (one current MORTALITY per flock/date), 16 (1:1 superseded_by)
--
-- flocks, sheds and operator_assignments exist since 0004/0005 and are reused
-- unchanged. The flocks ↔ purchases cycle-2 FKs were added in 0019.
--
-- Population is NEVER stored:
--   current_population = flocks.initial_population
--                      + SUM(population_events.delta WHERE is_current)
-- ============================================================================

-- ── population_events ──────────────────────────────────────────────────────
-- MORTALITY (delta < 0) and COUNT_ADJUSTMENT (delta <> 0, either sign).
-- 1:1 replacement on rectification, so superseded_by is meaningful here.

CREATE TABLE population_events (
  id            BIGSERIAL PRIMARY KEY,
  flock_id      UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type    population_event_type NOT NULL,
  delta         BIGINT NOT NULL CHECK (delta <> 0),
  event_date    DATE NOT NULL,                        -- period determinant
  is_current    BOOLEAN NOT NULL DEFAULT true,
  superseded_by BIGINT REFERENCES population_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version_seq   INTEGER NOT NULL DEFAULT 0,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE population_events ENABLE ROW LEVEL SECURITY;

-- Max ONE current MORTALITY per (flock, date). COUNT_ADJUSTMENT is intentionally unconstrained.
CREATE UNIQUE INDEX idx_population_events_mortality_current
  ON population_events(flock_id, event_date)
  WHERE event_type = 'MORTALITY' AND is_current = true;

CREATE INDEX idx_population_events_flock_date ON population_events(flock_id, event_date);

-- ── daily_production ───────────────────────────────────────────────────────
-- Physical fact; no ledger, no posting. Separate from mortality even when one
-- screen captures both. No classification_session_id (frozen Part 26).

CREATE TABLE daily_production (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id        UUID NOT NULL REFERENCES flocks(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  production_date DATE NOT NULL,                       -- period determinant
  eggs_total      INTEGER NOT NULL CHECK (eggs_total >= 0),
  eggs_broken     INTEGER NOT NULL DEFAULT 0 CHECK (eggs_broken >= 0),
  eggs_dirty      INTEGER NOT NULL DEFAULT 0 CHECK (eggs_dirty  >= 0),
  is_current      BOOLEAN NOT NULL DEFAULT true,
  superseded_by   UUID REFERENCES daily_production(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version_seq     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE daily_production ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX idx_daily_production_current
  ON daily_production(flock_id, production_date)
  WHERE is_current = true;

CREATE INDEX idx_daily_production_flock_date ON daily_production(flock_id, production_date);
