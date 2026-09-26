-- ============================================================================
-- TARGET V1 — 0004 SHARED MASTERS
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md "DOMAIN B — MASTERS"
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md, steps 2.2 and 2.3
--
-- Scope note: feed_formula_version and feed_formula_line are step 2.3 masters but
-- are NOT created here. feed_formula_line carries unit_cost_snapshot, whose
-- protection needs the cost-hiding machinery and the feed_formula_line_safe view
-- that belong to the Feed phase. No Foundations object depends on them.
-- ============================================================================

-- ── step 2.2: independent masters ──────────────────────────────────────────

CREATE TABLE sheds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     VARCHAR(100) UNIQUE NOT NULL,
  capacidad  BIGINT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sheds ENABLE ROW LEVEL SECURITY;

CREATE TABLE clients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     TEXT UNIQUE NOT NULL,
  fiscal_id  TEXT,
  contacto   TEXT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE TABLE products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       VARCHAR(255) UNIQUE NOT NULL,
  product_type product_type NOT NULL,
  unit_type    unit_type NOT NULL DEFAULT 'UNIT',
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

CREATE TABLE suppliers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     VARCHAR(255) UNIQUE NOT NULL,
  fiscal_id  TEXT,
  contacto   TEXT,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE TABLE financial_account (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       VARCHAR(100) UNIQUE NOT NULL,
  account_type account_type NOT NULL,
  activo       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE financial_account ENABLE ROW LEVEL SECURITY;

CREATE TABLE expense_category (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE expense_category ENABLE ROW LEVEL SECURITY;

CREATE TABLE classification_grade (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     VARCHAR(50) UNIQUE NOT NULL,
  activo     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE classification_grade ENABLE ROW LEVEL SECURITY;

CREATE TABLE projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(150) UNIQUE NOT NULL,
  descripcion TEXT,
  status      project_status NOT NULL DEFAULT 'ACTIVE',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE TABLE feed_type (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        VARCHAR(100) UNIQUE NOT NULL,
  feed_category feed_category NOT NULL,
  activo        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feed_type ENABLE ROW LEVEL SECURITY;

CREATE TABLE genetics_consumption_curve (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genetics_line            VARCHAR(100) NOT NULL,
  age_weeks                INTEGER NOT NULL CHECK (age_weeks >= 0),
  expected_g_per_bird_day  DECIMAL(10,3) NOT NULL CHECK (expected_g_per_bird_day >= 0),
  expected_laying_pct      DECIMAL(5,2)  CHECK (expected_laying_pct BETWEEN 0 AND 100),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(genetics_line, age_weeks)
);
ALTER TABLE genetics_consumption_curve ENABLE ROW LEVEL SECURITY;

-- ── step 2.3: masters with FKs to 2.2 ──────────────────────────────────────

CREATE TABLE price_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id     UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  price_list_type price_list_type NOT NULL,
  precio          NUMERIC(15,2) NOT NULL CHECK (precio >= 0),
  effective_from  DATE NOT NULL,
  effective_to    DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_price_history_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_price_history_current
  ON price_history(producto_id, price_list_type)
  WHERE effective_to IS NULL;

CREATE TABLE feed_ingredient (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) UNIQUE NOT NULL,
  unit_type   unit_type NOT NULL DEFAULT 'KG',
  supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  activo      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE feed_ingredient ENABLE ROW LEVEL SECURITY;
