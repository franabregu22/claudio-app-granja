-- ============================================================================
-- TARGET V1 — 0035 FISCAL TABLES (Phase 22)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain K (fiscal_document,
--            fiscal_document_component, fiscal_obligation,
--            fiscal_obligation_installment, fiscal_payment), Domain F
--            (purchases.fiscal_document_id, freight.fiscal_document_id)
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md steps 2.4 and 2.14
--            TARGET_ARCHITECTURE_V2_FROZEN.md Part 18 (separate layer; does NOT
--            duplicate economic operations; historical rates preserved)
--            DATABASE_INVARIANTS_V1.md 17 (rate_applied snapshot), 25 (document
--            number unique per supplier, never globally)
--
-- The fiscal layer documents taxes; it never recreates a purchase, a Pedido, a
-- ledger movement or a money movement. Rates are snapshots supplied per
-- document; there is no tax-rate table and no hardcoded rate.
--
-- The deferred-FK stand-ins of 0019 (CHECK fiscal_document_id IS NULL on
-- purchases and freight) are replaced here by the frozen FKs, exactly as 0019
-- announced. No dangling reference can exist: the stand-ins held both NULL.
-- ============================================================================

-- ── fiscal_document ────────────────────────────────────────────────────────
CREATE TABLE fiscal_document (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type   fiscal_document_type NOT NULL,
  direction       fiscal_direction NOT NULL,             -- CREDITO = received, DEBITO = issued
  document_date   DATE NOT NULL,                         -- period determinant (document period)
  fiscal_period   DATE NOT NULL,                         -- tax period, month start
  supplier_id     UUID REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cliente_id      UUID REFERENCES clients(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  external_number VARCHAR(100),                          -- number issued by AFIP/ARCA or supplier
  net_amount      NUMERIC(15,2) NOT NULL CHECK (net_amount >= 0),
  total_amount    NUMERIC(15,2) NOT NULL CHECK (total_amount >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_fiscal_period_month_start
    CHECK (fiscal_period = date_trunc('month', fiscal_period)::DATE),
  CONSTRAINT chk_fiscal_counterparty CHECK (
    (direction = 'CREDITO' AND supplier_id IS NOT NULL)
    OR (direction = 'DEBITO' AND cliente_id IS NOT NULL))
);
ALTER TABLE fiscal_document ENABLE ROW LEVEL SECURITY;
-- unique per supplier, never globally (invariant 25)
CREATE UNIQUE INDEX idx_fiscal_document_supplier_number
  ON fiscal_document(supplier_id, external_number)
  WHERE supplier_id IS NOT NULL AND external_number IS NOT NULL;
CREATE INDEX idx_fiscal_document_period ON fiscal_document(fiscal_period);

-- ── fiscal_document_component ──────────────────────────────────────────────
-- rate_applied is the SNAPSHOT of the rate actually used (invariant 17).
CREATE TABLE fiscal_document_component (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_document_id UUID NOT NULL REFERENCES fiscal_document(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  tax_kind           tax_kind NOT NULL,
  direction          fiscal_direction NOT NULL,          -- IVA débito vs IVA crédito
  base_amount        NUMERIC(15,2) NOT NULL CHECK (base_amount >= 0),
  rate_applied       NUMERIC(7,4)  NOT NULL CHECK (rate_applied >= 0),
  tax_amount         NUMERIC(15,2) NOT NULL CHECK (tax_amount >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE fiscal_document_component ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_fiscal_component_document ON fiscal_document_component(fiscal_document_id);

-- ── fiscal_obligation ──────────────────────────────────────────────────────
-- status is materialised bookkeeping maintained ONLY by pay_fiscal_obligation.
CREATE TABLE fiscal_obligation (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_kind      tax_kind NOT NULL,
  fiscal_period DATE NOT NULL,                           -- period determinant (tax period)
  amount        NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  due_date      DATE,
  status        fiscal_obligation_status NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_obligation_period_month_start
    CHECK (fiscal_period = date_trunc('month', fiscal_period)::DATE),
  UNIQUE(tax_kind, fiscal_period)
);
ALTER TABLE fiscal_obligation ENABLE ROW LEVEL SECURITY;

-- ── fiscal_obligation_installment ──────────────────────────────────────────
-- A payment plan: it splits the obligation, it is not another liability.
CREATE TABLE fiscal_obligation_installment (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_obligation_id UUID NOT NULL REFERENCES fiscal_obligation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  installment_number   INTEGER NOT NULL CHECK (installment_number > 0),
  amount               NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  due_date             DATE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(fiscal_obligation_id, installment_number)
);
ALTER TABLE fiscal_obligation_installment ENABLE ROW LEVEL SECURITY;

-- ── fiscal_payment ─────────────────────────────────────────────────────────
-- The real money outflow: one FISCAL_PAYMENT operation + one posting per row.
CREATE TABLE fiscal_payment (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_obligation_id   UUID NOT NULL REFERENCES fiscal_obligation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  installment_id         UUID REFERENCES fiscal_obligation_installment(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  effective_date         DATE NOT NULL,                  -- period determinant (payment month)
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  financial_account_id   UUID NOT NULL REFERENCES financial_account(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id BIGINT NOT NULL REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key        VARCHAR(100) UNIQUE NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE fiscal_payment ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_fiscal_payment_obligation ON fiscal_payment(fiscal_obligation_id);

-- ── deferred references of 0019: purchases / freight → fiscal_document ─────
ALTER TABLE purchases DROP CONSTRAINT chk_purchases_fiscal_document_fk_deferred;
ALTER TABLE purchases
  ADD CONSTRAINT purchases_fiscal_document_id_fkey
  FOREIGN KEY (fiscal_document_id) REFERENCES fiscal_document(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE freight DROP CONSTRAINT chk_freight_fiscal_document_fk_deferred;
ALTER TABLE freight
  ADD CONSTRAINT freight_fiscal_document_id_fkey
  FOREIGN KEY (fiscal_document_id) REFERENCES fiscal_document(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
