-- ============================================================================
-- TARGET V1 — 0019 PURCHASES AND FREIGHT TABLES (Phase 17, Slice 2)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain F (purchases, purchase_line,
--            purchase_attachment, freight, freight_allocation)
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md steps 2.7, 2.9 and 3.6 (cycle 2)
--            DATABASE_INVARIANTS_V1.md 22 (freight once), 23 (attachment),
--            24 (classification), 25 (invoice per supplier)
--
-- supplier_ledger already exists (0015) and is reused, never recreated.
--
-- Deferred references, handled exactly as the frozen dependency order says:
--
-- * cycle 2 — purchases.flock_id ↔ flocks.purchase_id. flocks exists since
--   0005 with purchase_id created WITHOUT its FK. With purchases created here
--   both sides now exist, so step 3.6 for cycle 2 runs in this migration:
--   fk_flocks_purchase and fk_purchases_flock, exactly as frozen.
--
-- * fiscal_document (step 2.4) belongs to Phase 22 (Fiscal) and does not
--   exist yet. purchases.fiscal_document_id and freight.fiscal_document_id are
--   created as plain UUID columns with a CHECK (… IS NULL) stand-in, the same
--   pattern as the sales_session references in 0010: exactly what an FK to an
--   empty fiscal_document table would enforce. The Fiscal migration drops the
--   two CHECKs and adds the frozen FKs.
-- ============================================================================

-- ── purchases ──────────────────────────────────────────────────────────────
-- Economic obligation recognised at economic_date. Payment state lives in the
-- supplier ledger, never here. Versioned: rectification retires the current
-- row and inserts a new version (is_current / version_seq).

CREATE TABLE purchases (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id            UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  economic_date          DATE NOT NULL,                     -- period determinant (frozen Part 20)
  amount_net             NUMERIC(15,2) NOT NULL CHECK (amount_net >= 0),
  amount_total           NUMERIC(15,2) NOT NULL CHECK (amount_total > 0),
  -- management classification (required)
  expense_category_id    UUID NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  subcategory            VARCHAR(100),
  nature                 purchase_nature NOT NULL,
  project_id             UUID REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- optional fiscal linkage (FK deferred to the Fiscal phase; see header)
  fiscal_document_id     UUID,
  supplier_invoice_number VARCHAR(100),
  -- optional productive linkage (cycle 2; FK added below)
  flock_id               UUID,
  -- versioning
  is_current             BOOLEAN NOT NULL DEFAULT true,
  version_seq            INTEGER NOT NULL DEFAULT 0,
  idempotency_key        VARCHAR(100) UNIQUE NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- stand-in for the deferred FK to fiscal_document; dropped by the Fiscal migration
  CONSTRAINT chk_purchases_fiscal_document_fk_deferred CHECK (fiscal_document_id IS NULL)
);
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;

-- Invoice number uniqueness is scoped BY SUPPLIER and to the current version, never global.
CREATE UNIQUE INDEX idx_purchases_supplier_invoice
  ON purchases(supplier_id, supplier_invoice_number)
  WHERE supplier_invoice_number IS NOT NULL AND is_current = true;

CREATE INDEX idx_purchases_economic_date ON purchases(economic_date) WHERE is_current = true;
CREATE INDEX idx_purchases_supplier      ON purchases(supplier_id);
CREATE INDEX idx_purchases_project       ON purchases(project_id) WHERE project_id IS NOT NULL;

-- ── purchase_line ──────────────────────────────────────────────────────────

CREATE TABLE purchase_line (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id        UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  producto_id        UUID REFERENCES products(id)         ON DELETE RESTRICT ON UPDATE CASCADE,
  feed_ingredient_id UUID REFERENCES feed_ingredient(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  descripcion        VARCHAR(255) NOT NULL,
  cantidad           DECIMAL(15,4) NOT NULL CHECK (cantidad > 0),
  unit_type          unit_type NOT NULL,
  precio_unitario    NUMERIC(15,2) NOT NULL CHECK (precio_unitario >= 0),
  subtotal           NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE purchase_line ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_purchase_line_purchase ON purchase_line(purchase_id);

-- ── purchase_attachment ────────────────────────────────────────────────────
-- Metadata of the uploaded object (Supabase Storage path). At least one per
-- purchase, written by register_purchase in the same transaction; carried
-- forward by rectify_purchase. No DELETE for any application role.

CREATE TABLE purchase_attachment (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id   UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  storage_path  TEXT NOT NULL,                    -- Supabase Storage object path
  file_name     VARCHAR(255) NOT NULL,
  content_type  VARCHAR(100) NOT NULL,
  byte_size     BIGINT CHECK (byte_size > 0),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(purchase_id, storage_path)
);
ALTER TABLE purchase_attachment ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_purchase_attachment_purchase ON purchase_attachment(purchase_id);

-- ── freight ────────────────────────────────────────────────────────────────
-- Independent economic operation. Its debt is recognised exactly once, by
-- register_freight.

CREATE TABLE freight (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id        UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  economic_date      DATE NOT NULL,                       -- period determinant (frozen Part 20)
  amount             NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  document_ref       VARCHAR(100),
  fiscal_document_id UUID,                                -- FK deferred to the Fiscal phase; see header
  expense_category_id UUID NOT NULL REFERENCES expense_category(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  is_current         BOOLEAN NOT NULL DEFAULT true,
  version_seq        INTEGER NOT NULL DEFAULT 0,
  idempotency_key    VARCHAR(100) UNIQUE NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- stand-in for the deferred FK to fiscal_document; dropped by the Fiscal migration
  CONSTRAINT chk_freight_fiscal_document_fk_deferred CHECK (fiscal_document_id IS NULL)
);
ALTER TABLE freight ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_freight_economic_date ON freight(economic_date) WHERE is_current = true;

-- ── freight_allocation ─────────────────────────────────────────────────────
-- Cost attribution only: no ledger, no posting, no fiscal component.
-- Landed cost = purchases.amount_total + SUM(allocated_amount) — derived, never stored.

CREATE TABLE freight_allocation (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  freight_id       UUID NOT NULL REFERENCES freight(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  purchase_id      UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  allocated_amount NUMERIC(15,2) NOT NULL CHECK (allocated_amount > 0),
  allocated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  allocated_by     UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(freight_id, purchase_id)
);
ALTER TABLE freight_allocation ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_freight_allocation_purchase ON freight_allocation(purchase_id);

-- ── step 3.6, cycle 2: flocks ↔ purchases (both tables now exist) ──────────

ALTER TABLE flocks
  ADD CONSTRAINT fk_flocks_purchase
  FOREIGN KEY (purchase_id) REFERENCES purchases(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE purchases
  ADD CONSTRAINT fk_purchases_flock
  FOREIGN KEY (flock_id) REFERENCES flocks(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
