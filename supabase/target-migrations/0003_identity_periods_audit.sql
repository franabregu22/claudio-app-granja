-- ============================================================================
-- TARGET V1 — 0003 IDENTITY, PERIOD CONTROL, AUDIT
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md "DOMAIN A"
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md, step 2.1
--
-- perfiles.id equals auth.users.id. The frozen spec declares it as a plain
-- UUID PRIMARY KEY with no DEFAULT and no FK to auth.users, so none is added
-- here: the spec is materialised as written, not improved. The linkage is
-- exercised behaviourally by the Foundations test suite.
-- ============================================================================

CREATE TABLE perfiles (
  id          UUID PRIMARY KEY,                -- equals auth.users.id
  email       VARCHAR(255) UNIQUE NOT NULL,
  rol_type    rol_type NOT NULL DEFAULT 'OPERATOR',
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE perfiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE management_period (
  id             BIGSERIAL PRIMARY KEY,
  periodo_fecha  DATE UNIQUE NOT NULL,         -- first day of month (YYYY-MM-01)
  status         management_period_status NOT NULL DEFAULT 'OPEN',
  closed_at      TIMESTAMPTZ,
  closed_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_periodo_fecha_is_month_start
    CHECK (periodo_fecha = date_trunc('month', periodo_fecha)::DATE)
);
ALTER TABLE management_period ENABLE ROW LEVEL SECURITY;

CREATE TABLE audit_events (
  id             BIGSERIAL PRIMARY KEY,
  entity_type    VARCHAR(100) NOT NULL,
  entity_id      VARCHAR(100) NOT NULL,
  action         VARCHAR(50)  NOT NULL,
  before_values  JSONB,
  after_values   JSONB,
  reason         TEXT,
  performed_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  performed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_actor  ON audit_events(performed_by, performed_at);
