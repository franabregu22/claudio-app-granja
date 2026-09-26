-- ============================================================================
-- TARGET V1 — 0043 P&L MANAGEMENT SOURCES (Phase 24)
-- Authority: TARGET_ARCHITECTURE_V2_FROZEN.md Part 19 as amended by ADR-004
--            (accepted 2026-09-25):
--              * expense_category.pnl_cost_class (DIRECT | INDIRECT), mandatory,
--                no default — the managerial direct/indirect classification
--                ("Classification: direct/indirect per management needs", Part 8);
--              * management_event — append-only SOURCE management decisions for
--                RETIRO (outside Feria) and RESERVA_INTERNA, with compensating /
--                release events. It stores decisions, never calculated results;
--              * financial_operation_type OWNER_WITHDRAWAL — the treasury
--                consequence of a RETIRO (not TRANSFER, not SUPPLIER_PAYMENT).
--
-- No P&L result, balance or subtotal is stored anywhere (views in 0045).
-- ============================================================================

CREATE TYPE expense_cost_class AS ENUM ('DIRECT', 'INDIRECT');

-- Mandatory, no guessed default. expense_category is empty in the target model
-- (never seeded): real categories are mapped explicitly before migration.
ALTER TABLE expense_category ADD COLUMN pnl_cost_class expense_cost_class NOT NULL;

-- the treasury consequence of an owner withdrawal (RPC 43); the P&L authority
-- is the management_event, never this operation
ALTER TYPE financial_operation_type ADD VALUE 'OWNER_WITHDRAWAL';

CREATE TYPE management_event_type AS ENUM ('RETIRO', 'RESERVA_INTERNA');

-- ── management_event ───────────────────────────────────────────────────────
-- One row per management decision. amount is the magnitude (> 0). An original
-- event has compensates_event_id NULL; a compensation / release references the
-- original it offsets (same type, never beyond the original's amount — RPC 43).
-- RETIRO carries its treasury operation; RESERVA_INTERNA moves no money.
CREATE TABLE management_event (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type             management_event_type NOT NULL,
  effective_date         DATE NOT NULL,                                   -- period determinant
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  compensates_event_id   UUID REFERENCES management_event(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id   UUID REFERENCES financial_account(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id BIGINT UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key        VARCHAR(100) UNIQUE NOT NULL,
  reason                 TEXT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by             UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_management_event_treasury CHECK (
    (event_type = 'RETIRO' AND financial_account_id IS NOT NULL AND financial_operation_id IS NOT NULL)
    OR (event_type = 'RESERVA_INTERNA' AND financial_account_id IS NULL AND financial_operation_id IS NULL)),
  CONSTRAINT chk_management_event_reason CHECK (length(trim(reason)) > 0),
  CONSTRAINT chk_management_event_not_self CHECK (compensates_event_id IS DISTINCT FROM id)
);
ALTER TABLE management_event ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_management_event_type_date   ON management_event(event_type, effective_date);
CREATE INDEX idx_management_event_compensates ON management_event(compensates_event_id) WHERE compensates_event_id IS NOT NULL;
