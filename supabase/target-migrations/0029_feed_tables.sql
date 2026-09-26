-- ============================================================================
-- TARGET V1 — 0029 FEED TABLES (Phase 20)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain I (feed_formula_version,
--            feed_formula_line, feed_manufacturing, feed_movement,
--            feed_inventory_count, flock_feed_assignment)
--            TARGET_ARCHITECTURE_V2_FROZEN.md Part 15 (versions immutable once
--            used; manufacturing references the exact version; no
--            daily_feed_consumption), Part 26
--            DATABASE_INVARIANTS_V1.md 17 (formula_version_id and
--            unit_cost_snapshot are immutable snapshots)
--
-- feed_type, feed_ingredient, genetics_consumption_curve, flocks and pedidos
-- exist since 0004/0005/0010 and are reused unchanged.
--
-- Consumption is NEVER stored:
--   consumo interno = opening_count + manufacturing - external_output
--                     ± adjustments - closing_count          (per period, per feed type)
--   consumo teórico = population × genetics_consumption_curve(age) × assigned feed type
-- Both are derived at read time. There is no daily_feed_consumption table and
-- no per-flock consumption fact.
-- ============================================================================

-- ── feed_formula_version ───────────────────────────────────────────────────
CREATE TABLE feed_formula_version (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_type_id   UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version        INTEGER NOT NULL CHECK (version > 0),
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(feed_type_id, version),
  CONSTRAINT chk_formula_version_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE feed_formula_version ENABLE ROW LEVEL SECURITY;

-- ── feed_formula_line ──────────────────────────────────────────────────────
-- quantity_kg is per 100 kg batch. unit_cost_snapshot is cost data: OPERATOR
-- reads composition only through feed_formula_line_safe (0031).
CREATE TABLE feed_formula_line (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version_id UUID NOT NULL REFERENCES feed_formula_version(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ingredient_id      UUID NOT NULL REFERENCES feed_ingredient(id)      ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity_kg        DECIMAL(15,3) NOT NULL CHECK (quantity_kg > 0),
  unit_cost_snapshot NUMERIC(15,2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(formula_version_id, ingredient_id)
);
ALTER TABLE feed_formula_line ENABLE ROW LEVEL SECURITY;

-- ── feed_manufacturing ─────────────────────────────────────────────────────
CREATE TABLE feed_manufacturing (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_version_id UUID NOT NULL REFERENCES feed_formula_version(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  manufacturing_date DATE NOT NULL,                     -- period determinant
  quantity_kg        DECIMAL(15,3) NOT NULL CHECK (quantity_kg > 0),
  batch_number       VARCHAR(50),
  idempotency_key    VARCHAR(100) UNIQUE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE feed_manufacturing ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_feed_manufacturing_date ON feed_manufacturing(manufacturing_date);

-- ── feed_movement ──────────────────────────────────────────────────────────
-- Append-only. quantity_kg is always positive; the sign in the stock equation
-- comes from movement_type (EXTERNAL_SALE, LOSS, ADJUSTMENT_NEGATIVE subtract;
-- ADJUSTMENT_POSITIVE adds).
CREATE TABLE feed_movement (
  id            BIGSERIAL PRIMARY KEY,
  feed_type_id  UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type feed_movement_type NOT NULL,
  quantity_kg   DECIMAL(15,3) NOT NULL CHECK (quantity_kg > 0),
  movement_date DATE NOT NULL,                          -- period determinant
  pedido_id     UUID REFERENCES pedidos(id) ON DELETE RESTRICT ON UPDATE CASCADE,  -- when EXTERNAL_SALE
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE feed_movement ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_feed_movement_type_date ON feed_movement(feed_type_id, movement_date);

-- ── feed_inventory_count ───────────────────────────────────────────────────
-- A physical count is an observation, not a computed balance.
CREATE TABLE feed_inventory_count (
  id           BIGSERIAL PRIMARY KEY,
  feed_type_id UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  count_date   DATE NOT NULL,                           -- period determinant
  quantity_kg  DECIMAL(15,3) NOT NULL CHECK (quantity_kg >= 0),
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(feed_type_id, count_date)
);
ALTER TABLE feed_inventory_count ENABLE ROW LEVEL SECURITY;

-- ── flock_feed_assignment ──────────────────────────────────────────────────
-- Which feed type a flock receives. Input to consumo teórico only.
CREATE TABLE flock_feed_assignment (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flock_id       UUID NOT NULL REFERENCES flocks(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  feed_type_id   UUID NOT NULL REFERENCES feed_type(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_flock_feed_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE flock_feed_assignment ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_flock_feed_current ON flock_feed_assignment(flock_id) WHERE effective_to IS NULL;

-- ── formula version immutable once used (frozen Part 15, schema Domain I) ──
-- UPDATE / DELETE on both formula tables are closed by privileges (0031: no
-- application role holds them; invariant 17). The one remaining master path
-- that could alter a used version is the ADMIN INSERT policy on
-- feed_formula_line: adding a line to a version already referenced by
-- manufacturing would rewrite the recipe that batch was made with. This
-- trigger closes that path for every role, including the owner.
--
-- Race: register_feed_manufacturing takes the same transaction-level advisory
-- lock on the version before inserting, so a line insert and a first
-- manufacturing of one version are serialised and the check always sees the
-- committed state. (Row locks are not usable here: SELECT … FOR SHARE requires
-- UPDATE privilege, which no application role holds on this table.)
CREATE OR REPLACE FUNCTION reject_line_on_used_formula_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('feed_formula_version'), hashtext(NEW.formula_version_id::TEXT));
  IF EXISTS (SELECT 1 FROM feed_manufacturing WHERE formula_version_id = NEW.formula_version_id) THEN
    RAISE EXCEPTION 'FORMULA_VERSION_IN_USE: version % is referenced by manufacturing and is immutable',
      NEW.formula_version_id;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION reject_line_on_used_formula_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION reject_line_on_used_formula_version() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_feed_formula_line_used_version
  BEFORE INSERT ON feed_formula_line
  FOR EACH ROW EXECUTE FUNCTION reject_line_on_used_formula_version();
