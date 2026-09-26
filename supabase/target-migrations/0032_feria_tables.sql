-- ============================================================================
-- TARGET V1 — 0032 FERIA TABLES (Phase 21)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain J (sales_session,
--            sales_session_movement, sales_session_cash_event), Domain C/D
--            (pedidos.sales_session_id, collections.sales_session_id)
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md step 3.6 (cycle 1:
--            fk_pedidos_sales_session, fk_sales_session_aggregated_pedido)
--            TARGET_ARCHITECTURE_V2_FROZEN.md Part 16
--            DATABASE_INVARIANTS_V1.md 28 (feria aggregation)
--
-- The session is the operational/physical event; the Pedido is the economic
-- fact. No sales table, no individual anonymous sale rows, no stored cash or
-- session balance.
--
-- The deferred-FK stand-ins of 0010 (CHECK sales_session_id IS NULL on pedidos
-- and collections) are replaced here by the frozen FKs, exactly as 0010 and the
-- dependency order announced. No dangling reference can exist when they are
-- added: the stand-ins held both columns NULL.
-- ============================================================================

-- ── sales_session ──────────────────────────────────────────────────────────
-- aggregated_pedido_id is created as a plain column; its FK is cycle 1 of step
-- 3.6 and is added below under its frozen name.
CREATE TABLE sales_session (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date         DATE NOT NULL,                   -- period determinant
  location             VARCHAR(100) NOT NULL,
  estado               session_estado NOT NULL DEFAULT 'OPEN',
  aggregated_pedido_id UUID,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  closed_at            TIMESTAMPTZ,
  closed_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key      VARCHAR(100) UNIQUE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sales_session ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_sales_session_date ON sales_session(session_date);

-- ── sales_session_movement ─────────────────────────────────────────────────
-- Physical movements only; quantities are physical, never economic.
CREATE TABLE sales_session_movement (
  id               BIGSERIAL PRIMARY KEY,
  sales_session_id UUID NOT NULL REFERENCES sales_session(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type    session_movement_type NOT NULL,      -- DISPATCH | RETURN | LOSS | ADJUSTMENT
  producto_id      UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cantidad         DECIMAL(15,4) NOT NULL CHECK (cantidad > 0),
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sales_session_movement ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_session_movement_session ON sales_session_movement(sales_session_id);

-- ── sales_session_cash_event ───────────────────────────────────────────────
-- COUNT events are observations and carry no financial operation; the others do.
CREATE TABLE sales_session_cash_event (
  id                     BIGSERIAL PRIMARY KEY,
  sales_session_id       UUID NOT NULL REFERENCES sales_session(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type             session_cash_event_type NOT NULL,  -- OPENING_FUND | EXPENSE | WITHDRAWAL | TRANSFER_OUT | COUNT
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  financial_account_id   UUID REFERENCES financial_account(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  expense_category_id    UUID REFERENCES expense_category(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_date             DATE NOT NULL,                     -- period determinant
  reason                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_session_expense_category CHECK (
    event_type <> 'EXPENSE' OR expense_category_id IS NOT NULL)
);
ALTER TABLE sales_session_cash_event ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_session_cash_session ON sales_session_cash_event(sales_session_id);

-- ── step 3.6, cycle 1: pedidos ↔ sales_session ─────────────────────────────
ALTER TABLE pedidos DROP CONSTRAINT chk_pedidos_sales_session_fk_deferred;
ALTER TABLE pedidos
  ADD CONSTRAINT fk_pedidos_sales_session
  FOREIGN KEY (sales_session_id) REFERENCES sales_session(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE sales_session
  ADD CONSTRAINT fk_sales_session_aggregated_pedido
  FOREIGN KEY (aggregated_pedido_id) REFERENCES pedidos(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- collections.sales_session_id (Domain D, inline FK in the frozen schema)
ALTER TABLE collections DROP CONSTRAINT chk_collections_sales_session_fk_deferred;
ALTER TABLE collections
  ADD CONSTRAINT collections_sales_session_id_fkey
  FOREIGN KEY (sales_session_id) REFERENCES sales_session(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── invariant 28 at schema level ───────────────────────────────────────────
-- "One sales_session produces at most one aggregated Pedido; anonymous retail
-- sales are never individual rows." close_sales_session is the writer, but the
-- ADMIN PENDING-order path (pedidos INSERT/UPDATE policies) could otherwise
-- create an aggregated retail Pedido outside a session or a second one inside
-- it. These two backstops make both impossible for every role.
ALTER TABLE pedidos
  ADD CONSTRAINT chk_pedidos_aggregated_has_session
  CHECK (NOT is_aggregated_retail OR sales_session_id IS NOT NULL);
CREATE UNIQUE INDEX idx_pedidos_one_aggregate_per_session
  ON pedidos(sales_session_id) WHERE is_aggregated_retail;
