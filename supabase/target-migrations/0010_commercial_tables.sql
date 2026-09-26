-- ============================================================================
-- TARGET V1 — 0010 COMMERCIAL TABLES (Phase 14, Slice 1)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md  Domain C (pedidos, pedido_lineas),
--                                        Domain D (client_ledger, collections),
--                                        Domain E (financial_operation, financial_posting)
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md steps 2.6 and 36–40
--
-- Creation order follows the FK graph: every referenced table already exists
-- (clients, products, perfiles, financial_account come from 0003/0004).
--
-- sales_session does not exist until Phase 21 (Feria). Both references to it
-- are created as plain UUID columns:
--   * pedidos.sales_session_id      -> cycle 1, FK deferred by the frozen order
--   * collections.sales_session_id  -> referenced table not yet built
-- Until the FK exists, a CHECK (sales_session_id IS NULL) stands in for it.
-- That is exactly what an FK to an empty sales_session table would enforce:
-- no non-null value can be valid. The Feria migration drops these two CHECKs
-- and adds the frozen FKs, so no dangling reference can exist when it does.
-- ============================================================================

-- ── pedidos ────────────────────────────────────────────────────────────────
-- No monto_total: the order total is SUM(pedido_lineas.subtotal) over the
-- current version. delivered_date is the period determinant; created_at is
-- metadata only.

CREATE TABLE pedidos (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_pedido      BIGINT UNIQUE,
  cliente_id         UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  estado             order_estado NOT NULL DEFAULT 'PENDING',
  sales_session_id   UUID,          -- FK to sales_session deferred (cycle 1); see header
  is_aggregated_retail BOOLEAN NOT NULL DEFAULT false,
  delivered_at       TIMESTAMPTZ,
  delivered_date     DATE,          -- = (delivered_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
  cancelled_at       TIMESTAMPTZ,
  cancelled_date     DATE,
  rectification_seq  INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_pedidos_delivered_coherent CHECK (
    (estado = 'DELIVERED' AND delivered_at IS NOT NULL AND delivered_date IS NOT NULL)
    OR (estado <> 'DELIVERED')),
  CONSTRAINT chk_pedidos_cancelled_coherent CHECK (
    (estado = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_date IS NOT NULL)
    OR (estado <> 'CANCELLED')),
  -- stand-in for the deferred FK; dropped by the Feria migration
  CONSTRAINT chk_pedidos_sales_session_fk_deferred CHECK (sales_session_id IS NULL)
);
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_pedidos_cliente        ON pedidos(cliente_id);
CREATE INDEX idx_pedidos_delivered_date ON pedidos(delivered_date) WHERE estado = 'DELIVERED';
CREATE INDEX idx_pedidos_session        ON pedidos(sales_session_id) WHERE sales_session_id IS NOT NULL;

-- ── pedido_lineas ──────────────────────────────────────────────────────────
-- precio_unitario and producto_nombre are the commercial SNAPSHOT: written once,
-- never updated (no UPDATE privilege for any application role).
-- version_seq + is_current carry set-level supersession on rectification.

CREATE TABLE pedido_lineas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id        UUID NOT NULL REFERENCES pedidos(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  producto_id      UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cantidad         DECIMAL(15,4) NOT NULL CHECK (cantidad > 0),
  precio_unitario  NUMERIC(15,2) NOT NULL CHECK (precio_unitario >= 0),  -- SNAPSHOT, immutable
  producto_nombre  VARCHAR(255)  NOT NULL,                               -- SNAPSHOT, immutable
  subtotal         NUMERIC(15,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
  version_seq      INTEGER NOT NULL DEFAULT 0,   -- 0 = original, N = Nth rectification
  is_current       BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE pedido_lineas ENABLE ROW LEVEL SECURITY;

-- At most ONE distinct current version_seq per order, any number of lines in it.
-- btree_gist (0001) supplies the GiST <> strategy for uuid and int4.
-- IMMEDIATE (default): also enforces retire-then-insert order in the rectify RPC.
ALTER TABLE pedido_lineas
  ADD CONSTRAINT excl_pedido_lineas_single_current_version
  EXCLUDE USING gist (pedido_id WITH =, version_seq WITH <>)
  WHERE (is_current);

CREATE INDEX idx_pedido_lineas_current ON pedido_lineas(pedido_id) WHERE is_current = true;
CREATE INDEX idx_pedido_lineas_version ON pedido_lineas(pedido_id, version_seq);

-- ── client_ledger ──────────────────────────────────────────────────────────
-- Signed, append-only. + increases client debt, - reduces it. No stored balance:
-- client balance = SUM(signed_amount). Written only by RPCs.

CREATE TABLE client_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  cliente_id         UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type      client_ledger_movement_type NOT NULL,
  signed_amount      NUMERIC(15,2) NOT NULL CHECK (signed_amount <> 0),
  effective_date     DATE NOT NULL,                     -- period determinant
  ledger_client_name VARCHAR(255) NOT NULL,             -- SNAPSHOT of clients.nombre at posting
  source_entity_type VARCHAR(50),                       -- 'pedido' | 'collections' | 'financial_instrument'
  source_entity_id   VARCHAR(100),
  reversal_of_id     BIGINT REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE client_ledger ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_client_ledger_cliente_date ON client_ledger(cliente_id, effective_date);
CREATE INDEX idx_client_ledger_source       ON client_ledger(source_entity_type, source_entity_id);

-- ── financial_operation ────────────────────────────────────────────────────
-- Parent of 1..N postings. Not double-entry: postings are real money movements
-- on real accounts, with no zero-sum requirement.

CREATE TABLE financial_operation (
  id                 BIGSERIAL PRIMARY KEY,
  operation_type     financial_operation_type NOT NULL,
  effective_date     DATE NOT NULL,                      -- period determinant
  external_ref       VARCHAR(100) UNIQUE,                -- idempotency key
  source_entity_type VARCHAR(50),
  source_entity_id   VARCHAR(100),
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE financial_operation ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_financial_operation_date ON financial_operation(effective_date);

-- ── financial_posting ──────────────────────────────────────────────────────
-- Account balance = SUM(signed_amount). Append-only; corrections are
-- compensating postings.

CREATE TABLE financial_posting (
  id                     BIGSERIAL PRIMARY KEY,
  financial_operation_id BIGINT NOT NULL REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id   UUID   NOT NULL REFERENCES financial_account(id)  ON DELETE RESTRICT ON UPDATE CASCADE,
  signed_amount          NUMERIC(15,2) NOT NULL CHECK (signed_amount <> 0),
  effective_date         DATE NOT NULL,                  -- period determinant
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE financial_posting ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_financial_posting_account_date ON financial_posting(financial_account_id, effective_date);
CREATE INDEX idx_financial_posting_operation    ON financial_posting(financial_operation_id);

-- ── collections ────────────────────────────────────────────────────────────
-- Never allocated to specific orders. Cheque reception belongs to receive_cheque
-- (Phase 16), enforced here by chk_collections_no_cheque.

CREATE TABLE collections (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id           UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount               NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_method       payment_method NOT NULL,
  receipt_id           VARCHAR(100) UNIQUE NOT NULL,     -- idempotency key
  effective_date       DATE NOT NULL,                    -- period determinant
  financial_account_id UUID REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  sales_session_id     UUID,                             -- FK to sales_session deferred; see header
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_collections_no_cheque CHECK (payment_method <> 'CHEQUE'),
  CONSTRAINT chk_collections_account_required CHECK (financial_account_id IS NOT NULL),
  -- stand-in for the deferred FK; dropped by the Feria migration
  CONSTRAINT chk_collections_sales_session_fk_deferred CHECK (sales_session_id IS NULL)
);
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_collections_cliente_date ON collections(cliente_id, effective_date);
