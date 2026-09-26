-- ============================================================================
-- TARGET V1 — 0026 CLASSIFICATION TABLES (Phase 19)
-- Authority: POSTGRES_SCHEMA_SPEC_V1.md Domain H (classification, classification_line)
--            TARGET_ARCHITECTURE_V2_FROZEN.md Parts 14 / 26 (no invented traceability)
--
-- classification_grade exists since 0004 (seeded in 0008) and is reused.
--
-- NO flock_id, NO shed_id, NO production reference anywhere: eggs from
-- different flocks are mixed before classification, and inventing
-- traceability is forbidden. Multiple sessions per day are allowed, so there
-- is NO uniqueness by date or by (date, location); retries are deduplicated by
-- idempotency_key only. No stored session total: it is SUM(quantity).
-- ============================================================================

CREATE TABLE classification (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key     UUID UNIQUE NOT NULL,
  classification_date DATE NOT NULL,                   -- period determinant (frozen Part 20)
  location            VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE classification ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_classification_date ON classification(classification_date);

-- Grade is an FK to classification_grade, never free text. Each grade appears
-- at most once per session.
CREATE TABLE classification_line (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  classification_id       UUID NOT NULL REFERENCES classification(id)       ON DELETE RESTRICT ON UPDATE CASCADE,
  classification_grade_id UUID NOT NULL REFERENCES classification_grade(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  quantity                INTEGER NOT NULL CHECK (quantity >= 0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(classification_id, classification_grade_id)
);
ALTER TABLE classification_line ENABLE ROW LEVEL SECURITY;
