-- ============================================================================
-- TARGET V1 — 0015 INSTRUMENT TABLES (Phase 16, Cheques / eCheqs)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md  Domain E (financial_instrument,
--                                        financial_instrument_event),
--                                        Domain F (supplier_ledger)
--            IMPLEMENTATION_DEPENDENCY_ORDER_V1.md steps 37, 41, 42
--            DATABASE_INVARIANTS_V1.md 7, 18, 19, 20
--
-- supplier_ledger is listed by the roadmap under Slice 2 (Phase 17), but the
-- Phase 16 exit criterion requires it: endorsement (RPC 8), issued instruments
-- (RPC 10) and their rejections (RPCs 9, 12) write supplier debt. It is created
-- here exactly as frozen, as the minimal structural dependency; its FK targets
-- (suppliers, perfiles) exist since 0003/0004. No purchase, payment or freight
-- structure is created.
--
-- Creation order follows the FK graph: supplier_ledger (37) →
-- financial_instrument (41; clients, suppliers, financial_account, collections)
-- → financial_instrument_event (42; financial_operation from 0010).
-- ============================================================================

-- ── supplier_ledger ────────────────────────────────────────────────────────
-- Signed, append-only. + increases supplier debt, - reduces it. No stored
-- balance; payments are never allocated to invoices. Written only by RPCs.

CREATE TABLE supplier_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  supplier_id        UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_type      supplier_ledger_movement_type NOT NULL,
  signed_amount      NUMERIC(15,2) NOT NULL CHECK (signed_amount <> 0),
  effective_date     DATE NOT NULL,                        -- period determinant
  source_entity_type VARCHAR(50),                          -- 'purchases' | 'freight' | 'financial_instrument' | 'payment'
  source_entity_id   VARCHAR(100),
  reversal_of_id     BIGINT REFERENCES supplier_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE supplier_ledger ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_supplier_ledger_supplier_date ON supplier_ledger(supplier_id, effective_date);

-- ── financial_instrument ───────────────────────────────────────────────────
-- Current state of one cheque / eCheq. An instrument is NOT a financial
-- account. Identity is id; cheque_number is business data and NOT unique.
-- Idempotency: receipt_id (received) / external_ref (issued).

CREATE TABLE financial_instrument (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_type      financial_instrument_type NOT NULL,
  direction            instrument_direction NOT NULL,
  estado               instrument_estado NOT NULL,
  cheque_number        VARCHAR(50) NOT NULL,             -- business data; NOT globally unique
  amount               NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  maturity_date        DATE,
  -- provenance
  cliente_id           UUID REFERENCES clients(id)           ON DELETE RESTRICT ON UPDATE CASCADE,
  supplier_id          UUID REFERENCES suppliers(id)         ON DELETE RESTRICT ON UPDATE CASCADE,
  bank_account_id      UUID REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source_collection_id UUID REFERENCES collections(id)       ON DELETE RESTRICT ON UPDATE CASCADE,
  endorsed_to_supplier_id UUID REFERENCES suppliers(id)      ON DELETE RESTRICT ON UPDATE CASCADE,
  -- idempotency
  receipt_id           VARCHAR(100) UNIQUE,               -- set on RECEIVED (reception receipt)
  external_ref         VARCHAR(100) UNIQUE,               -- set on ISSUED (issuance reference)
  -- business dates (period determinants per lifecycle step)
  received_date        DATE,
  deposited_date       DATE,
  cleared_date         DATE,
  endorsed_date        DATE,
  issued_date          DATE,
  debited_date         DATE,
  rejected_date        DATE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by           UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_instrument_received_provenance CHECK (
    direction <> 'RECEIVED'
    OR (cliente_id IS NOT NULL AND received_date IS NOT NULL AND receipt_id IS NOT NULL)),
  CONSTRAINT chk_instrument_issued_provenance CHECK (
    direction <> 'ISSUED'
    OR (supplier_id IS NOT NULL AND issued_date IS NOT NULL AND bank_account_id IS NOT NULL)),
  CONSTRAINT chk_instrument_estado_direction CHECK (
    (direction = 'RECEIVED' AND estado IN ('RECEIVED','DEPOSITED','CLEARED','ENDORSED','REJECTED'))
    OR (direction = 'ISSUED' AND estado IN ('ISSUED','DEBITED','REJECTED','CANCELLED')))
);
ALTER TABLE financial_instrument ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_instrument_estado   ON financial_instrument(direction, estado);
CREATE INDEX idx_instrument_cliente  ON financial_instrument(cliente_id)  WHERE cliente_id IS NOT NULL;
CREATE INDEX idx_instrument_supplier ON financial_instrument(supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX idx_instrument_maturity ON financial_instrument(maturity_date);

-- ── financial_instrument_event ─────────────────────────────────────────────
-- Append-only lifecycle trail. One event per (instrument, event_type): a
-- lifecycle step can never be recorded twice. Complements audit_events.

CREATE TABLE financial_instrument_event (
  id                     BIGSERIAL PRIMARY KEY,
  financial_instrument_id UUID NOT NULL REFERENCES financial_instrument(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type             instrument_estado NOT NULL,
  event_date             DATE NOT NULL,                   -- period determinant
  financial_operation_id BIGINT REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE financial_instrument_event ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_instrument_event_unique
  ON financial_instrument_event(financial_instrument_id, event_type);
CREATE INDEX idx_instrument_event_date ON financial_instrument_event(event_date);
