-- ============================================================================
-- TARGET V1 — 0005 MINIMAL STRUCTURAL DEPENDENCY + operator_assignments
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md "DOMAIN A / DOMAIN G"
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md, steps 2.8 and 3.6
--
-- operator_assignments is a Foundations object and carries
--   operator_assignments.flock_id -> flocks(id)
-- so `flocks` must exist. The dependency order places flocks at step 2.8,
-- immediately before operator_assignments, and this is the minimal structural
-- dependency the design explicitly provides for.
--
-- ONLY the table is created. No Production behaviour is brought forward: no
-- population_events, no daily_production, no weighings, no temperature records,
-- and none of RPCs 18-24. Those belong to the Production phase.
--
-- flocks.purchase_id is created WITHOUT its foreign key, exactly as step 2.8
-- prescribes: purchases does not exist yet, and the flocks <-> purchases cycle
-- is resolved at step 3.6 in the phase that creates purchases.
-- ============================================================================

CREATE TABLE flocks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shed_id            UUID NOT NULL REFERENCES sheds(id)     ON DELETE RESTRICT ON UPDATE CASCADE,
  estado             flock_estado NOT NULL DEFAULT 'ACTIVE',
  genetics_line      VARCHAR(100),
  birth_date         DATE,
  entry_date         DATE NOT NULL,
  initial_population BIGINT NOT NULL CHECK (initial_population >= 0),
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id        UUID,   -- FK deferred to step 3.6 (cycle 2), purchases not yet created
  exit_date          DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE flocks ENABLE ROW LEVEL SECURITY;

-- Invariant 1: at most one ACTIVE flock per shed. Partial uniqueness is an index,
-- because PostgreSQL has no partial UNIQUE constraint.
CREATE UNIQUE INDEX idx_flocks_shed_active ON flocks(shed_id) WHERE estado = 'ACTIVE';

CREATE TABLE operator_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  UUID NOT NULL REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  flock_id     UUID NOT NULL REFERENCES flocks(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  activo       BOOLEAN NOT NULL DEFAULT true,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by  UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(operator_id, flock_id)
);
ALTER TABLE operator_assignments ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_operator_assignments_operator ON operator_assignments(operator_id) WHERE activo = true;
