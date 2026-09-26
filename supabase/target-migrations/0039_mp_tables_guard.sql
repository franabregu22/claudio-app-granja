-- ============================================================================
-- TARGET V1 — 0039 MERCADO PAGO TABLES AND RAW GUARD (Phase 23)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain L (mp_source_record,
--            mp_source_raw_guard / trg_mp_source_raw_guard,
--            mp_financial_movement, mp_reconciliation)
--            TARGET_ARCHITECTURE_V2_FROZEN.md Part 22 (immutable source →
--            normalized movement → N:N amount-assigned reconciliation →
--            internal operation/postings; MP is NOT a general ledger)
--            DATABASE_INVARIANTS_V1.md 21 (raw immutability)
--            ADR-003 (accepted 2026-09-25): two columns added to
--            mp_reconciliation —
--              idempotency_key       request identity of RPC 41
--              financial_account_id  the posting account the assignment refers to
--                                    (operation-side capacity per (operation, account))
--
-- No MP balance, no reconciled balance and no remaining amount is stored:
-- remaining_unassigned = net_amount − SUM(assigned_amount), derived.
-- mp_processing_status exists since 0002.
-- ============================================================================

-- ── mp_source_record ───────────────────────────────────────────────────────
CREATE TABLE mp_source_record (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ── RAW SOURCE DATA: immutable after insert ──
  source_type       VARCHAR(50) NOT NULL,                -- 'webhook' | 'api' | 'csv_import'
  external_id       VARCHAR(100) NOT NULL,               -- MP's own id (ADR-003: Liberaciones composite)
  event_data        JSONB NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL,                -- MP's timestamp
  occurred_date     DATE NOT NULL,                       -- period determinant, MP's own date
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ── PROCESSING METADATA: controlled mutable ──
  processing_status mp_processing_status NOT NULL DEFAULT 'PENDING',
  processed_at      TIMESTAMPTZ,
  processing_note   TEXT,
  UNIQUE(source_type, external_id)
);
ALTER TABLE mp_source_record ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_source_status ON mp_source_record(processing_status);
CREATE INDEX idx_mp_source_date   ON mp_source_record(occurred_date);

-- Deliberately SECURITY INVOKER (the PostgreSQL default): the guard only compares OLD against NEW
-- and crosses neither RLS nor any privilege, so elevation would add privilege for nothing.
-- It is therefore NOT part of the SECURITY DEFINER inventory in RLS_IMPLEMENTATION_SPEC_V1.md.
-- The trigger fires regardless of the caller's role, so the raw columns stay protected either way.
CREATE OR REPLACE FUNCTION mp_source_raw_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_type   IS DISTINCT FROM OLD.source_type
  OR NEW.external_id   IS DISTINCT FROM OLD.external_id
  OR NEW.event_data    IS DISTINCT FROM OLD.event_data
  OR NEW.occurred_at   IS DISTINCT FROM OLD.occurred_at
  OR NEW.occurred_date IS DISTINCT FROM OLD.occurred_date
  OR NEW.ingested_at   IS DISTINCT FROM OLD.ingested_at THEN
    RAISE EXCEPTION 'mp_source_record raw source data is immutable';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION mp_source_raw_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_source_raw_guard() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_mp_source_raw_guard
  BEFORE UPDATE ON mp_source_record
  FOR EACH ROW EXECUTE FUNCTION mp_source_raw_guard();

-- ── mp_financial_movement ──────────────────────────────────────────────────
CREATE TABLE mp_financial_movement (
  id                  BIGSERIAL PRIMARY KEY,
  mp_source_record_id UUID NOT NULL REFERENCES mp_source_record(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  movement_kind       VARCHAR(50) NOT NULL,              -- payment | fee | tax | settlement | yield | transfer
  gross_amount        NUMERIC(15,2) NOT NULL,
  fee_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  tax_amount          NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_amount          NUMERIC(15,2) NOT NULL,
  occurred_date       DATE NOT NULL,                     -- inherited from source; period determinant
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mp_source_record_id, movement_kind)
);
ALTER TABLE mp_financial_movement ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_movement_date ON mp_financial_movement(occurred_date);

-- ── mp_reconciliation ──────────────────────────────────────────────────────
-- N:N amount-assigned bridge. No invented correspondence: a movement may stay
-- unreconciled. [ADR-003] idempotency_key + financial_account_id.
CREATE TABLE mp_reconciliation (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mp_financial_movement_id BIGINT NOT NULL REFERENCES mp_financial_movement(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_operation_id   BIGINT NOT NULL REFERENCES financial_operation(id)   ON DELETE RESTRICT ON UPDATE CASCADE,
  financial_account_id     UUID   NOT NULL REFERENCES financial_account(id)     ON DELETE RESTRICT ON UPDATE CASCADE,
  assigned_amount          NUMERIC(15,2) NOT NULL CHECK (assigned_amount <> 0),
  idempotency_key          VARCHAR(100) UNIQUE NOT NULL,
  reconciled_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconciled_by            UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE(mp_financial_movement_id, financial_operation_id)
);
ALTER TABLE mp_reconciliation ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_mp_reconciliation_operation_account ON mp_reconciliation(financial_operation_id, financial_account_id);
