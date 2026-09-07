-- ============================================================================
-- MIGRATION 008: June Reconciliation Framework
-- Status: ADDITIVE ONLY (no deletions, no modifications to existing)
-- Purpose: Add fingerprinting, resolution tracking, and exception handling
--          for June 2026 multi-settlement reconciliation
-- ============================================================================

-- ============================================================================
-- ADD COLUMNS TO mp_source_record (nullable for legacy compatibility)
-- ============================================================================

ALTER TABLE mp_source_record
ADD COLUMN account_id BIGINT NULL,
ADD COLUMN economic_row_fp TEXT NULL,
ADD COLUMN cross_source_fp TEXT NULL;

-- Indexes for new columns (partial, for new records only)
CREATE INDEX idx_source_record_account_id ON mp_source_record(account_id)
  WHERE account_id IS NOT NULL;

CREATE INDEX idx_source_record_econ_fp ON mp_source_record(account_id, economic_row_fp)
  WHERE account_id IS NOT NULL AND economic_row_fp IS NOT NULL;

CREATE INDEX idx_source_record_cross_fp ON mp_source_record(cross_source_fp)
  WHERE cross_source_fp IS NOT NULL;

-- ============================================================================
-- CREATE mp_source_link_resolution TABLE
-- Purpose: Track historical link resolutions (preserve audit trail)
-- ============================================================================

CREATE TABLE mp_source_link_resolution (
  id BIGSERIAL PRIMARY KEY,
  source_record_id BIGINT NOT NULL REFERENCES mp_source_record(id),
  historical_financial_movement_id BIGINT REFERENCES mp_financial_movement(id),
  resolved_financial_movement_id BIGINT NOT NULL REFERENCES mp_financial_movement(id),
  resolution_type TEXT NOT NULL,
    -- Values: 'COLLAPSED_DISTINCT_MOVEMENTS', 'PARTIAL_IMPORT', 'AMBIGUOUS_PENDING', etc.
  evidence_type TEXT NOT NULL,
    -- Values: 'REPORT_COEXISTENCE', 'CROSS_SOURCE_CORRELATION', 'METADATA', etc.
  reason_text TEXT,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  superseded_by_resolution_id BIGINT REFERENCES mp_source_link_resolution(id),
  superseded_at TIMESTAMP,
  detected_date DATE,
  resolved_at TIMESTAMP NOT NULL DEFAULT now(),
  resolved_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT check_resolution_chain CHECK (
    (superseded_by_resolution_id IS NULL AND is_current = TRUE) OR
    (superseded_by_resolution_id IS NOT NULL AND is_current = FALSE AND superseded_at IS NOT NULL)
  )
);

CREATE INDEX idx_source_link_resolution_source_id ON mp_source_link_resolution(source_record_id);
CREATE INDEX idx_source_link_resolution_resolved_fm ON mp_source_link_resolution(resolved_financial_movement_id);
CREATE INDEX idx_source_link_resolution_is_current ON mp_source_link_resolution(is_current)
  WHERE is_current = TRUE;

-- ============================================================================
-- CREATE mp_import_exception TABLE
-- Purpose: Track rows that cannot be automatically classified
-- ============================================================================

CREATE TABLE mp_import_exception (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  import_id TEXT,
    -- Batch identifier for tracing
  source_record_id BIGINT REFERENCES mp_source_record(id),
  exception_type TEXT NOT NULL,
    -- Values: 'AMBIGUOUS_VERSION_OR_DISTINCT', 'AMBIGUOUS_CORRELATION', etc.
  severity TEXT NOT NULL DEFAULT 'WARNING',
    -- Values: 'WARNING', 'ERROR'
  reason_text TEXT,
  requires_review BOOLEAN NOT NULL DEFAULT TRUE,
  reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at TIMESTAMP,
  reviewed_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT check_review_logic CHECK (
    (reviewed = FALSE AND reviewed_at IS NULL AND reviewed_by IS NULL) OR
    (reviewed = TRUE AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  )
);

CREATE INDEX idx_import_exception_account_import ON mp_import_exception(account_id, import_id);
CREATE INDEX idx_import_exception_source_record ON mp_import_exception(source_record_id);
CREATE INDEX idx_import_exception_requires_review ON mp_import_exception(requires_review)
  WHERE requires_review = TRUE;

-- ============================================================================
-- CREATE mp_financial_cycle TABLE (optional, for cycle metadata)
-- Purpose: Document economic cycles (reserve/investment, etc.)
-- ============================================================================

CREATE TABLE mp_financial_cycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id BIGINT NOT NULL,
  cycle_type TEXT NOT NULL,
    -- Values: 'RESERVE_INVESTMENT', etc.
  fm_outflow_id BIGINT NOT NULL REFERENCES mp_financial_movement(id),
  fm_return_id BIGINT NOT NULL REFERENCES mp_financial_movement(id),
  capital_outflow NUMERIC(15,2),
  capital_return NUMERIC(15,2),
  derived_yield NUMERIC(15,2),
  source_evidence TEXT NOT NULL,
    -- Values: 'MANUAL_VERIFICATION', 'AUTO_DETECTION', etc.
  verified_date DATE,
  verified_by TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX idx_financial_cycle_account ON mp_financial_cycle(account_id);
CREATE INDEX idx_financial_cycle_outflow ON mp_financial_cycle(fm_outflow_id);
CREATE INDEX idx_financial_cycle_return ON mp_financial_cycle(fm_return_id);

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- Tables added: 3 (mp_source_link_resolution, mp_import_exception, mp_financial_cycle)
-- Columns added to mp_source_record: 3 (all nullable for legacy compatibility)
-- No existing data modified.
-- No existing tables dropped or restructured.
-- ============================================================================
