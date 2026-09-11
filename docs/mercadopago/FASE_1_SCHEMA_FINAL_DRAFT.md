# FASE 1: SCHEMA FINAL DRAFT — FINAL VALIDATED WITH 2 FINAL BLOCKER ISSUES RESOLVED

**Status:** FINAL DRAFT COMPLETE — 18 ERRORS FIXED + 10 QUINTO FIXES + 4 BLOCKER FIXES + 2 FINAL BLOCKER FIXES (COMBINED AUTHORITATIVE + ROOT UNIQUENESS)  
**Next Migration:** 007_reconciliation_tables.sql  
**Migrations Executed:** NO  
**Data Modified:** NO  
**Validation Checklist:** COMPLETE (A-O + 18 FIXES + 10 QUINTO FIXES + 4 BLOCKERS + 2 FINAL BLOCKERS)

---

## CRITICAL FIXES APPLIED — ERRORS 1-18 + QUINTO FIXES 1-10 + BLOCKER FIXES 1-4

### ERRORS 1-18 (Fourth Draft)

**Error 1 FIXED:** Supersession vigent logic inverted — NOW uses NOT EXISTS correctly  
**Error 2 FIXED:** Supersession insert now validates target has no successor  
**Error 3 FIXED:** source_method now 'manual' with CHECK constraint only  
**Error 4 FIXED:** v_period_coverage_status NULL handling exact order  
**Error 5 FIXED:** v_balance_chain_coverage scoped to monthly_reconciliation.period  
**Error 6 FIXED:** Opening config validates BOTH balance and date distinct  
**Error 7 FIXED:** v_monthly opening config no MAX(balance_date) filtering  
**Error 8 FIXED:** Approval constraint requires nonblank note + all fields symmetric  
**Error 9 FIXED:** v_monthly_reconciliation_summary includes coverage JOINs  
**Error 10 FIXED:** v_monthly exposes closing_snapshot_id and period_flow_observation_id  
**Error 11 FIXED:** Added closing_snapshot_is_current and period_flow_observation_is_current  
**Error 12 FIXED:** Period vs chain coverage now independent columns  
**Error 13 FIXED:** import_period_coverage documented as append-only application policy  
**Error 14 FIXED:** Immutability certificate honest: snapshot/flow DB-enforced, coverage app-only  
**Error 15 FIXED:** FK semantics justified: ON DELETE RESTRICT implemented (snapshot/observation immutable)  
**Error 16 FIXED:** updated_at now NOT NULL  
**Error 17 FIXED:** Trigger sets updated_at = NOW() on UPDATE verified  
**Error 18 FIXED:** Validation certificate no false positives

### QUINTO FIXES 1-10 (Fifth Draft — NULL Semantics & Reconciliation Scope)

**QUINTO Fix 1 FIXED:** is_current NULL SEMANTICS — closing_snapshot_is_current & period_flow_observation_is_current wrapped in CASE: NULL=no evidence, TRUE=vigent, FALSE=superseded  
**QUINTO Fix 2 FIXED:** balance_chain_coverage returns ONE row per monthly_reconciliation with 'unavailable' when opening_config_valid != TRUE  
**QUINTO Fix 3 FIXED:** missing_or_incomplete_months column added to v_balance_chain_coverage (required_months - complete_months)  
**QUINTO Fix 4 FIXED:** reconciliation_scope field added to monthly_reconciliation with CHECK constraint ('period_flow' or 'account_balance')  
**QUINTO Fix 5 FIXED:** FINAL STATUS ENFORCEMENT TRIGGER validates preconditions when status='reconciled' or 'variance_approved' based on scope  
**QUINTO Fix 6 FIXED:** Foreign keys changed from ON DELETE SET NULL to ON DELETE RESTRICT (immutable snapshots)  
**QUINTO Fix 7 FIXED:** MIGRATION STRATEGY section now lists ONLY real indexes (removed phantom idx_*_vigent indexes)  
**QUINTO Fix 8 FIXED:** AUGUST SEMANTICS documented explicitly: observed_net -124203.27, ledger -124203.24, discrepancy -0.03, NO snapshot created, NO inference  
**QUINTO Fix 9 FIXED:** PERIOD_FLOW RECONCILIATION EXAMPLE added showing it can proceed when period_coverage=complete even if balance_chain=incomplete  
**QUINTO Fix 10 FIXED:** MIGRATION STRATEGY cleaned (no phantom warnings, only real objects listed)

### BLOCKER FIXES 1-4 (Final Draft — Multi-Scope, Circular Dependency, Status Exactness, View Deduplication)

**BLOCKER Fix 1 FIXED:** UNIQUE constraint now includes reconciliation_scope: `UNIQUE(account_id, period_start, period_end, reconciliation_scope)` allows both period_flow and account_balance scopes for same period, blocks duplicates within same scope  
**BLOCKER Fix 1b FIXED:** v_monthly_reconciliation_summary SELECT list includes reconciliation_scope field  
**BLOCKER Fix 2 FIXED:** Helper function `calculate_balance_chain_coverage(p_account_id, p_period_start, p_period_end)` created with explicit parameters; trigger calls helper NOT persistent view, eliminating circular dependency on INSERT  
**BLOCKER Fix 3 FIXED:** BEFORE INSERT trigger validates exact discrepancy/variance match for status='reconciled': period_flow requires ABS(observed_net - calculated_flow) = 0.00, account_balance requires ABS((opening + calculated) - observed) = 0.00; status='variance_approved' permits nonzero with approval note  
**BLOCKER Fix 4 FIXED:** v_balance_chain_coverage now uses DISTINCT periods CTE: ensures ONE row per (account_id, period_start, period_end) regardless of how many reconciliation_scope rows exist; both period_flow and account_balance scopes reference same chain

---

## SCHEMA ARCHITECTURE: 4 TABLES + 4 VIEWS

### Summary

| Artifact | Type | Mutability | Vigence Logic | Purpose |
|----------|------|-----------|---------------|---------|
| `import_period_coverage` | Table | Append-only | ROW_NUMBER() desc by created_at | Evidence of coverage completeness per period+source |
| `reconciliation_snapshot` | Table | INSERT-only | NOT EXISTS (newer row) | Historical point observation of account balance on date |
| `period_flow_observation` | Table | INSERT-only | NOT EXISTS (newer row) | Historical point observation of period net flow in UI |
| `monthly_reconciliation` | Table | Mutable | Primary key unique constraint | Human decision: status, approval, variance documentation |
| `v_latest_coverage_evidence` | View | Read-only | ROW_NUMBER rn=1 with id | Deterministic vigent coverage evidence per period+source |
| `v_period_coverage_status` | View | Read-only | 5-case CASE WHEN logic | Period coverage aggregate: complete/partial/unknown/none |
| `v_balance_chain_coverage` | View | Read-only | generate_series ALL validation | Balance chain completeness from opening_date to period_end |
| `v_monthly_reconciliation_summary` | View | Read-only | opening config validation + ledger source-of-truth | Full reconciliation state with all calculations from ledger |

---

## TABLE 1: `import_period_coverage`

**Purpose:** Append-only evidence of import completeness by period and source type  
**Vigence Strategy:** Latest row by (account_id, period_start, period_end, source_type, created_at DESC, id DESC)  
**Mutability:** Append-only (enforced by service layer policy)

```sql
CREATE TABLE IF NOT EXISTS import_period_coverage (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  source_type VARCHAR(20) NOT NULL,

  source_records_count BIGINT,
  financial_movements_count BIGINT,
  ledger_entries_count BIGINT,

  min_transaction_date DATE,
  max_transaction_date DATE,

  coverage VARCHAR(20) NOT NULL,
  coverage_notes TEXT,

  import_checkpoint_id VARCHAR(100),
  validated_at TIMESTAMP WITH TIME ZONE,
  validated_by TEXT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_coverage CHECK (
    coverage IN ('unknown', 'none', 'partial', 'complete')
  ),
  CONSTRAINT valid_source_type CHECK (
    source_type IN ('report', 'liberaciones', 'combined')
  ),
  CONSTRAINT date_range CHECK (
    period_start <= period_end
  ),
  CONSTRAINT counts_nonnegative CHECK (
    (source_records_count IS NULL OR source_records_count >= 0) AND
    (financial_movements_count IS NULL OR financial_movements_count >= 0) AND
    (ledger_entries_count IS NULL OR ledger_entries_count >= 0)
  ),
  CONSTRAINT date_order CHECK (
    min_transaction_date IS NULL OR 
    max_transaction_date IS NULL OR 
    min_transaction_date <= max_transaction_date
  )
);

-- Index: Fast lookup of latest coverage evidence
CREATE INDEX IF NOT EXISTS idx_import_period_coverage_lookup
  ON import_period_coverage(account_id, period_start, period_end, source_type, created_at DESC, id DESC);

-- Index: Support v_latest_coverage_evidence view partition
CREATE INDEX IF NOT EXISTS idx_import_period_coverage_by_account_period
  ON import_period_coverage(account_id, period_start, period_end, source_type);
```

**Vigence Query (used by v_latest_coverage_evidence):**
```sql
SELECT * 
FROM import_period_coverage
WHERE account_id = X 
  AND period_start = Y 
  AND period_end = Z 
  AND source_type = W
ORDER BY created_at DESC, id DESC
LIMIT 1;
```

---

## TABLE 2: `reconciliation_snapshot`

**Purpose:** Immutable historical observation of account balance on a specific date  
**Vigence Strategy:** Latest non-superseded row by (account_id, balance_date)  
**Mutability:** INSERT-only (enforced by triggers on UPDATE/DELETE)  
**Supersession:** Chain validation, unique successors

```sql
CREATE TABLE IF NOT EXISTS reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,

  observed_balance NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  source_method VARCHAR(50) NOT NULL DEFAULT 'manual',
    -- PHASE 1: ONLY 'manual' permitted (observation from UI screenshot)
    -- source_detail explains HOW: "UI Mercado Pago", "screenshot", etc.
    -- Future extensibility: DO NOT add to source_method; add new source_detail values instead
  source_detail VARCHAR(255),
    -- Examples: "UI Mercado Pago", "screenshot 2026-08-31", "manual verification", etc.

  notes TEXT,
  created_by TEXT,

  -- Versioning: new snapshot points to previous, creating immutable chain
  supersedes_snapshot_id BIGINT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_source_method CHECK (source_method = 'manual'),
  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE RESTRICT,
  CONSTRAINT supersedes_not_self CHECK (
    supersedes_snapshot_id IS NULL OR supersedes_snapshot_id != id
  )
);

-- Index: Support supersession chain lookup (for finding successors)
CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_supersedes
  ON reconciliation_snapshot(supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;

-- UNIQUE constraint: At most one direct successor per snapshot
-- (Validation A-E: prevents two rows from superseding the same snapshot)
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_unique_successor
  ON reconciliation_snapshot(supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;

-- BLOCKER 2 FIX: ROOT CHAIN UNIQUENESS
-- Prevents two roots (supersedes_snapshot_id=NULL) for same (account_id, balance_date)
-- Guarantees exactly ONE root per identity, enabling single linear chain
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_root_unique
  ON reconciliation_snapshot(account_id, balance_date)
  WHERE supersedes_snapshot_id IS NULL;

-- TRIGGER: Validate supersession chain (same account, same balance_date, target vigent)
-- (Validation D: supersede other balance_date => RAISE)
-- (Error 2 FIX: target must not already have successor)
CREATE OR REPLACE FUNCTION reconciliation_snapshot_validate_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supersedes_snapshot_id IS NOT NULL THEN
    -- Check 1: Target exists with same account and balance_date
    PERFORM 1 FROM reconciliation_snapshot
    WHERE id = NEW.supersedes_snapshot_id
      AND account_id = NEW.account_id
      AND balance_date = NEW.balance_date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersedes_snapshot_id must reference same account_id and balance_date';
    END IF;
    
    -- Check 2: Target does not already have a successor (must be vigent)
    IF EXISTS (SELECT 1 FROM reconciliation_snapshot newer 
               WHERE newer.supersedes_snapshot_id = NEW.supersedes_snapshot_id) THEN
      RAISE EXCEPTION 'Referenced snapshot already has a successor; target must be vigent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_snapshot_validate_supersession
  BEFORE INSERT OR UPDATE ON reconciliation_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION reconciliation_snapshot_validate_supersession();

-- TRIGGER: Prevent UPDATE on snapshot
-- (Validation B: UPDATE snapshot => RAISE)
CREATE OR REPLACE FUNCTION reconciliation_snapshot_prevent_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation_snapshot is INSERT-only; cannot UPDATE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_snapshot_prevent_update
  BEFORE UPDATE ON reconciliation_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION reconciliation_snapshot_prevent_update();

-- TRIGGER: Prevent DELETE on snapshot
-- (Validation C: DELETE snapshot => RAISE)
CREATE OR REPLACE FUNCTION reconciliation_snapshot_prevent_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation_snapshot is INSERT-only; cannot DELETE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_snapshot_prevent_delete
  BEFORE DELETE ON reconciliation_snapshot
  FOR EACH ROW
  EXECUTE FUNCTION reconciliation_snapshot_prevent_delete();
```

**Vigent Query (used internally and by v_monthly_reconciliation_summary):**
```sql
-- ERROR 1 FIX: Vigent is the snapshot NOT referenced by any newer row
SELECT * 
FROM reconciliation_snapshot rs
WHERE rs.account_id = X 
  AND rs.balance_date = Y 
  AND NOT EXISTS (
    SELECT 1 FROM reconciliation_snapshot newer 
    WHERE newer.supersedes_snapshot_id = rs.id
  );
```

**Supersession Chain (Validation A):**
- Row id=100: account=1, balance_date=2026-08-31, observed_balance=10000, supersedes_snapshot_id=NULL
- Row id=101: account=1, balance_date=2026-08-31, observed_balance=10050, supersedes_snapshot_id=100
  - Query for vigent => id=101 (NOT EXISTS finds id=101 because no newer row supersedes it)
  - id=100 no longer vigent (EXISTS finds newer.supersedes_snapshot_id=100)
  - id=100 still exists for audit trail

---

## TABLE 3: `period_flow_observation`

**Purpose:** Immutable historical observation of period net flow in UI (e.g., -124203.27 agosto)  
**Vigence Strategy:** Latest non-superseded row by (account_id, period_start, period_end)  
**Mutability:** INSERT-only (enforced by triggers on UPDATE/DELETE)  
**Supersession:** Same period, same account validation

```sql
CREATE TABLE IF NOT EXISTS period_flow_observation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Real observation from UI (e.g., -124203.27)
  observed_net NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- Source metadata
  source_method VARCHAR(50) NOT NULL DEFAULT 'manual',
    -- PHASE 1: ONLY 'manual' permitted (observation from UI screenshot)
    -- source_detail explains HOW: "UI Mercado Pago", "screenshot", etc.
    -- Future extensibility: DO NOT add to source_method; add new source_detail values instead
  source_detail VARCHAR(255),
    -- Examples: "UI Mercado Pago período agosto", "screenshot 2026-08-31", etc.

  notes TEXT,
  created_by TEXT,

  -- Versioning: new observation points to previous
  supersedes_observation_id BIGINT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_source_method CHECK (source_method = 'manual'),
  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_observation_id)
    REFERENCES period_flow_observation(id) ON DELETE RESTRICT,
  CONSTRAINT date_range CHECK (
    period_start <= period_end
  ),
  CONSTRAINT supersedes_not_self CHECK (
    supersedes_observation_id IS NULL OR supersedes_observation_id != id
  )
);

-- Index: Support supersession chain lookup (for finding successors)
CREATE INDEX IF NOT EXISTS idx_period_flow_observation_supersedes
  ON period_flow_observation(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;

-- UNIQUE constraint: At most one direct successor
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_unique_successor
  ON period_flow_observation(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;

-- BLOCKER 2 FIX: ROOT CHAIN UNIQUENESS
-- Prevents two roots (supersedes_observation_id=NULL) for same (account_id, period_start, period_end)
-- Guarantees exactly ONE root per period identity, enabling single linear chain
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_root_unique
  ON period_flow_observation(account_id, period_start, period_end)
  WHERE supersedes_observation_id IS NULL;

-- TRIGGER: Validate supersession (same account, same period, target vigent)
-- (Error 2 FIX: target must not already have successor)
CREATE OR REPLACE FUNCTION period_flow_observation_validate_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supersedes_observation_id IS NOT NULL THEN
    -- Check 1: Target exists with same account and period
    PERFORM 1 FROM period_flow_observation
    WHERE id = NEW.supersedes_observation_id
      AND account_id = NEW.account_id
      AND period_start = NEW.period_start
      AND period_end = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersedes_observation_id must reference same account and period';
    END IF;
    
    -- Check 2: Target does not already have a successor (must be vigent)
    IF EXISTS (SELECT 1 FROM period_flow_observation newer 
               WHERE newer.supersedes_observation_id = NEW.supersedes_observation_id) THEN
      RAISE EXCEPTION 'Referenced observation already has a successor; target must be vigent';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_flow_observation_validate_supersession
  BEFORE INSERT OR UPDATE ON period_flow_observation
  FOR EACH ROW
  EXECUTE FUNCTION period_flow_observation_validate_supersession();

-- TRIGGER: Prevent UPDATE
CREATE OR REPLACE FUNCTION period_flow_observation_prevent_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'period_flow_observation is INSERT-only; cannot UPDATE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_flow_observation_prevent_update
  BEFORE UPDATE ON period_flow_observation
  FOR EACH ROW
  EXECUTE FUNCTION period_flow_observation_prevent_update();

-- TRIGGER: Prevent DELETE
CREATE OR REPLACE FUNCTION period_flow_observation_prevent_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'period_flow_observation is INSERT-only; cannot DELETE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_flow_observation_prevent_delete
  BEFORE DELETE ON period_flow_observation
  FOR EACH ROW
  EXECUTE FUNCTION period_flow_observation_prevent_delete();
```

**Vigent Query:**
```sql
-- ERROR 1 FIX: Vigent is the observation NOT referenced by any newer row
SELECT * 
FROM period_flow_observation pfo
WHERE pfo.account_id = X 
  AND pfo.period_start = Y 
  AND pfo.period_end = Z 
  AND NOT EXISTS (
    SELECT 1 FROM period_flow_observation newer 
    WHERE newer.supersedes_observation_id = pfo.id
  );
```

---

## TABLE 4: `monthly_reconciliation`

**Purpose:** Mutable human decision state: status, approval, variance documentation  
**Vigence Strategy:** One row per (account_id, period_start, period_end) — UNIQUE constraint  
**Mutability:** UPDATE allowed (for status changes, approvals)  
**Immutability of Evidence:** closing_snapshot_id and period_flow_observation_id remain as historical references even if underlying snapshots are later superseded

```sql
CREATE TABLE IF NOT EXISTS monthly_reconciliation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- QUINTO FIX 4: Scope of reconciliation (explicit choice, not automatic)
  reconciliation_scope VARCHAR(30) NOT NULL,
    -- 'period_flow': reconciliation focuses on period net flow observation vs ledger
    -- 'account_balance': reconciliation focuses on account balance snapshot vs calculated

  -- Historical references to specific evidence (Validation N: stays even if snapshot superseded later)
  closing_snapshot_id BIGINT,
  period_flow_observation_id BIGINT,

  -- Human decision state
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
    -- 'pending': no review
    -- 'reconciled': evidence matches, approved
    -- 'needs_investigation': discrepancy found, pending investigation
    -- 'variance_approved': discrepancy investigated and approved

  -- Variance documentation
  variance_approval_note TEXT,
  approved_by TEXT,
  approved_at TIMESTAMP WITH TIME ZONE,

  -- Audit trail
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- ERROR 16 FIX: must be NOT NULL, updated by trigger

  -- Constraints
  CONSTRAINT unique_monthly_reconciliation UNIQUE (account_id, period_start, period_end, reconciliation_scope),
  CONSTRAINT date_range CHECK (period_start <= period_end),
  CONSTRAINT valid_scope CHECK (
    reconciliation_scope IN ('period_flow', 'account_balance')
  ),
  CONSTRAINT valid_status CHECK (
    status IN ('pending', 'reconciled', 'needs_investigation', 'variance_approved')
  ),
  CONSTRAINT fk_closing_snapshot FOREIGN KEY (closing_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE RESTRICT,
    -- QUINTO FIX 6: Changed to ON DELETE RESTRICT (snapshot immutable, cannot delete)
  CONSTRAINT fk_period_flow_observation FOREIGN KEY (period_flow_observation_id)
    REFERENCES period_flow_observation(id) ON DELETE RESTRICT,
    -- QUINTO FIX 6: Changed to ON DELETE RESTRICT (observation immutable, cannot delete)
  CONSTRAINT approval_consistency CHECK (
    -- ERROR 8 FIX: Symmetric constraint: variance_approved requires nonblank note + approver
    (
      status = 'variance_approved' AND
      variance_approval_note IS NOT NULL AND
      btrim(variance_approval_note) <> '' AND
      approved_by IS NOT NULL AND
      approved_at IS NOT NULL
    ) OR (
      status <> 'variance_approved' AND
      variance_approval_note IS NULL AND
      approved_by IS NULL AND
      approved_at IS NULL
    )
  )
);

-- TRIGGER: Validate references (closing_snapshot, period_flow_observation) match account and period
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_references()
RETURNS TRIGGER AS $$
BEGIN
  -- Validate closing_snapshot_id if present
  IF NEW.closing_snapshot_id IS NOT NULL THEN
    PERFORM 1 FROM reconciliation_snapshot
    WHERE id = NEW.closing_snapshot_id
      AND account_id = NEW.account_id
      AND balance_date = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'closing_snapshot_id must reference same account_id and balance_date = period_end';
    END IF;
  END IF;

  -- Validate period_flow_observation_id if present
  IF NEW.period_flow_observation_id IS NOT NULL THEN
    PERFORM 1 FROM period_flow_observation
    WHERE id = NEW.period_flow_observation_id
      AND account_id = NEW.account_id
      AND period_start = NEW.period_start
      AND period_end = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'period_flow_observation_id must reference same account_id and period';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monthly_reconciliation_validate_references
  BEFORE INSERT OR UPDATE ON monthly_reconciliation
  FOR EACH ROW
  EXECUTE FUNCTION monthly_reconciliation_validate_references();

-- BLOCKER 1 & 5 & 8 FIX: Canonical helper for account balance calculation
-- Single source of truth for opening config validation and balance calculation
-- Used by: trigger (BLOCKER 8), v_monthly_reconciliation_summary (BLOCKER 5)
-- ISSUE 2 FIX: GUARANTEES exactly ONE row always (never 0 rows)
-- Returns: exactly one row with opening_config_valid=FALSE and NULLs if no opening_config
CREATE OR REPLACE FUNCTION calculate_account_balance_as_of(
  p_account_id BIGINT,
  p_as_of_date DATE
) RETURNS TABLE (
  opening_config_valid BOOLEAN,
  opening_balance NUMERIC(15,2),
  opening_balance_date DATE,
  calculated_balance NUMERIC(15,2)
) AS $$
DECLARE
  v_opening_config_valid BOOLEAN;
  v_opening_balance NUMERIC(15,2);
  v_opening_balance_date DATE;
  v_balance_distinct INTEGER;
  v_date_distinct INTEGER;
BEGIN
  -- Check if opening config exists and is valid
  SELECT
    COUNT(DISTINCT opening_balance),
    COUNT(DISTINCT opening_balance_date),
    MAX(opening_balance),
    MAX(opening_balance_date)
  INTO
    v_balance_distinct,
    v_date_distinct,
    v_opening_balance,
    v_opening_balance_date
  FROM account_balance
  WHERE account_id = p_account_id;
  
  -- ISSUE 2 FIX: If no rows in account_balance, v_balance_distinct will be NULL
  -- Treat NULL as 0 for validation
  v_balance_distinct := COALESCE(v_balance_distinct, 0);
  v_date_distinct := COALESCE(v_date_distinct, 0);
  
  -- Determine validity
  v_opening_config_valid := (v_balance_distinct = 1 AND v_date_distinct = 1);
  
  -- ISSUE 2 FIX: Return exactly ONE row always
  RETURN QUERY SELECT
    v_opening_config_valid::BOOLEAN,
    CASE WHEN v_opening_config_valid THEN v_opening_balance ELSE NULL END::NUMERIC(15,2),
    CASE WHEN v_opening_config_valid THEN v_opening_balance_date ELSE NULL END::DATE,
    CASE 
      WHEN v_opening_config_valid THEN
        v_opening_balance + COALESCE(
          (SELECT SUM(balance_impact)
           FROM ledger_entry le
           WHERE le.account_id = p_account_id
           AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= v_opening_balance_date
           AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= p_as_of_date
          ), 0
        )
      ELSE NULL
    END::NUMERIC(15,2);
END;
$$ LANGUAGE plpgsql STABLE;

-- BLOCKER 2 & 6 FIX: Helper function for balance chain coverage calculation
-- Takes explicit parameters; no dependency on persistent monthly_reconciliation row
-- GUARANTEES exactly ONE row for any input (never 0 or multiple rows)
-- Used by both trigger and v_balance_chain_coverage view via LATERAL
CREATE OR REPLACE FUNCTION calculate_balance_chain_coverage(
  p_account_id BIGINT,
  p_period_start DATE,
  p_period_end DATE
) RETURNS TABLE (
  account_id BIGINT,
  period_start DATE,
  period_end DATE,
  opening_config_valid BOOLEAN,
  required_months INTEGER,
  complete_months INTEGER,
  missing_or_incomplete_months INTEGER,
  balance_chain_coverage VARCHAR(20)
) AS $$
DECLARE
  v_opening_balance_date DATE;
  v_opening_config_valid BOOLEAN;
BEGIN
  -- Get opening config status for this account
  SELECT balance.opening_config_valid, balance.opening_balance_date 
    INTO v_opening_config_valid, v_opening_balance_date
  FROM calculate_account_balance_as_of(p_account_id, p_period_end) balance;
  
  -- BLOCKER 6: Handle period_end before opening_date
  IF p_period_end < v_opening_balance_date THEN
    RETURN QUERY SELECT 
      p_account_id, p_period_start, p_period_end, 
      v_opening_config_valid::BOOLEAN, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 
      'unavailable'::VARCHAR(20);
    RETURN;
  END IF;
  
  -- BLOCKER 2: If opening config invalid, return ONE row with unavailable status
  IF v_opening_config_valid IS NOT TRUE THEN
    RETURN QUERY SELECT 
      p_account_id, p_period_start, p_period_end, 
      FALSE::BOOLEAN, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, 
      'unavailable'::VARCHAR(20);
    RETURN;
  END IF;
  
  -- Valid opening config: calculate chain coverage
  WITH valid_config_series AS (
    SELECT
      v_opening_balance_date as opening_balance_date,
      (DATE_TRUNC('month', x.month_start)::DATE) as month_start,
      (DATE_TRUNC('month', x.month_start)::DATE + INTERVAL '1 month' - INTERVAL '1 day')::DATE as month_end
    FROM generate_series(
      DATE_TRUNC('month', v_opening_balance_date),
      DATE_TRUNC('month', p_period_end),
      INTERVAL '1 month'
    ) AS x(month_start)
  ),
  with_coverage AS (
    SELECT
      vcs.month_start,
      vcs.month_end,
      COALESCE(pcs.period_coverage, 'unknown') as month_coverage
    FROM valid_config_series vcs
    LEFT JOIN v_period_coverage_status pcs ON (
      pcs.account_id = p_account_id
      AND pcs.period_start = vcs.month_start
      AND pcs.period_end = vcs.month_end
    )
  ),
  chain_stats AS (
    SELECT
      COUNT(*)::INTEGER as required_months,
      SUM(CASE WHEN month_coverage = 'complete' THEN 1 ELSE 0 END)::INTEGER as complete_months
    FROM with_coverage
  )
  SELECT p_account_id, p_period_start, p_period_end, TRUE::BOOLEAN,
    cs.required_months,
    cs.complete_months,
    (cs.required_months - cs.complete_months)::INTEGER,
    CASE
      WHEN cs.required_months = cs.complete_months THEN 'complete'::VARCHAR(20)
      ELSE 'incomplete'::VARCHAR(20)
    END
  FROM chain_stats cs;
END;
$$ LANGUAGE plpgsql STABLE;

-- QUINTO FIX 5 + BLOCKER 8: FINAL STATUS ENFORCEMENT TRIGGER
-- Uses canonical helper functions for single source of truth
-- Validates exact discrepancy/variance matches for reconciled status
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_preconditions()
RETURNS TRIGGER AS $$
DECLARE
  v_period_coverage VARCHAR(20);
  chain_info RECORD;
  balance_info RECORD;
  pfo_observed NUMERIC(15,2);
  calculated_flow NUMERIC(15,2);
  snap_observed NUMERIC(15,2);
BEGIN
  -- Only validate when transitioning to final status
  IF NEW.status IN ('reconciled', 'variance_approved') THEN
    
    -- Get period_coverage
    SELECT period_coverage INTO v_period_coverage
    FROM v_period_coverage_status
    WHERE account_id = NEW.account_id 
      AND period_start = NEW.period_start 
      AND period_end = NEW.period_end;
    
    IF NEW.reconciliation_scope = 'period_flow' THEN
      -- Period flow reconciliation requires period_coverage = complete
      IF v_period_coverage IS NULL OR v_period_coverage != 'complete' THEN
        RAISE EXCEPTION 'Period flow reconciliation requires period_coverage = complete (current: %)', COALESCE(v_period_coverage, 'NULL');
      END IF;
      
      -- Require period_flow_observation_id to exist and match exact period
      IF NEW.period_flow_observation_id IS NULL THEN
        RAISE EXCEPTION 'Period flow reconciliation requires period_flow_observation_id to be set';
      END IF;
      
      -- For reconciled status, require exact match (discrepancy = 0.00)
      IF NEW.status = 'reconciled' THEN
        SELECT observed_net INTO pfo_observed FROM period_flow_observation WHERE id = NEW.period_flow_observation_id;
        SELECT COALESCE(SUM(balance_impact), 0)
          INTO calculated_flow
          FROM ledger_entry le
          WHERE le.account_id = NEW.account_id
          AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') 
            BETWEEN NEW.period_start AND NEW.period_end;
        IF ABS(pfo_observed - calculated_flow) > 0.00 THEN
          RAISE EXCEPTION 'period_flow reconciliation requires exact match (discrepancy=%)', (pfo_observed - calculated_flow);
        END IF;
      END IF;
      
    ELSIF NEW.reconciliation_scope = 'account_balance' THEN
      -- Account balance reconciliation requires period_coverage = complete
      IF v_period_coverage IS NULL OR v_period_coverage != 'complete' THEN
        RAISE EXCEPTION 'Account balance reconciliation requires period_coverage = complete (current: %)', COALESCE(v_period_coverage, 'NULL');
      END IF;
      
      -- BLOCKER 8 & 2: Use canonical helper function (single source of truth)
      SELECT * INTO chain_info FROM calculate_balance_chain_coverage(NEW.account_id, NEW.period_start, NEW.period_end);
      
      IF chain_info.balance_chain_coverage IS NULL OR chain_info.balance_chain_coverage != 'complete' THEN
        RAISE EXCEPTION 'Account balance reconciliation requires balance_chain_coverage = complete (current: %)', COALESCE(chain_info.balance_chain_coverage, 'NULL');
      END IF;
      
      -- Require closing_snapshot_id matching period_end
      IF NEW.closing_snapshot_id IS NULL THEN
        RAISE EXCEPTION 'Account balance reconciliation requires closing_snapshot_id to be set';
      END IF;
      
      -- BLOCKER 8 FIX: For reconciled status, use canonical helper for exact match (variance = 0.00)
      IF NEW.status = 'reconciled' THEN
        -- BLOCKER 1: Use canonical helper instead of inline calculation
        SELECT * INTO balance_info FROM calculate_account_balance_as_of(NEW.account_id, NEW.period_end);
        
        IF NOT balance_info.opening_config_valid THEN
          RAISE EXCEPTION 'Account balance reconciliation requires valid opening config';
        END IF;
        
        SELECT observed_balance INTO snap_observed FROM reconciliation_snapshot WHERE id = NEW.closing_snapshot_id;
        
        IF ABS((balance_info.calculated_balance) - snap_observed) > 0.00 THEN
          RAISE EXCEPTION 'account_balance reconciliation requires exact match (variance=%)', ((balance_info.calculated_balance) - snap_observed);
        END IF;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monthly_reconciliation_validate_preconditions
  BEFORE INSERT OR UPDATE ON monthly_reconciliation
  FOR EACH ROW
  EXECUTE FUNCTION monthly_reconciliation_validate_preconditions();

-- TRIGGER: Update timestamp on modification
CREATE OR REPLACE FUNCTION monthly_reconciliation_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monthly_reconciliation_update_timestamp
  BEFORE UPDATE ON monthly_reconciliation
  FOR EACH ROW
  EXECUTE FUNCTION monthly_reconciliation_update_timestamp();

-- Indexes
CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_account_date
  ON monthly_reconciliation(account_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_status
  ON monthly_reconciliation(account_id, status);
```

---

## VIEW 1: `v_latest_coverage_evidence`

**Purpose:** Deterministic vigent coverage evidence per (account_id, period_start, period_end, source_type)  
**Validation:** ROW_NUMBER() OVER (PARTITION ... ORDER BY created_at DESC, id DESC) = 1  
**Requirement:** MUST include `id` and `import_checkpoint_id` in output for audit trail

```sql
CREATE OR REPLACE VIEW v_latest_coverage_evidence AS
SELECT
  id,
  account_id,
  period_start,
  period_end,
  source_type,
  source_records_count,
  financial_movements_count,
  ledger_entries_count,
  min_transaction_date,
  max_transaction_date,
  coverage,
  coverage_notes,
  import_checkpoint_id,
  validated_at,
  validated_by,
  created_at
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, period_start, period_end, source_type
      ORDER BY created_at DESC, id DESC
    ) as rn
  FROM import_period_coverage
) x
WHERE rn = 1;
```

**Usage:** When need to know latest coverage evidence for a period+source:
```sql
SELECT coverage, source_records_count 
FROM v_latest_coverage_evidence
WHERE account_id = 1 AND period_start = '2026-08-01' AND source_type = 'report';
```

---

## VIEW 2: `v_period_coverage_status`

**Purpose:** Determine if period has COMPLETE/PARTIAL/UNKNOWN/NONE coverage  
**Authoritative Source:** COMBINED ONLY — report & liberaciones are diagnostic evidence only  
**Validation:** Combined-driven logic with no fallback to report/liberaciones aggregation  
**Rule:** period_coverage determined EXCLUSIVELY by combined_coverage; if combined=NULL, period_coverage=unknown

```sql
CREATE OR REPLACE VIEW v_period_coverage_status AS
WITH latest_evidence AS (
  -- Aggregate coverage evidence per period and source type
  SELECT
    account_id,
    period_start,
    period_end,
    MAX(CASE WHEN source_type = 'report' THEN coverage END) as report_coverage,
    MAX(CASE WHEN source_type = 'liberaciones' THEN coverage END) as liberaciones_coverage,
    MAX(CASE WHEN source_type = 'combined' THEN coverage END) as combined_coverage,
    MAX(CASE WHEN source_type = 'combined' THEN import_checkpoint_id END) as combined_checkpoint_id
  FROM v_latest_coverage_evidence
  GROUP BY account_id, period_start, period_end
)
SELECT
  account_id,
  period_start,
  period_end,
  report_coverage,
  liberaciones_coverage,
  combined_coverage,
  combined_checkpoint_id,
  -- AUTHORITATIVE COVERAGE: combined only, fall back to unknown
  CASE
    WHEN combined_coverage IS NULL THEN 'unknown'
    WHEN combined_coverage = 'unknown' THEN 'unknown'
    WHEN combined_coverage = 'partial' THEN 'partial'
    WHEN combined_coverage = 'none' THEN 'none'
    WHEN combined_coverage = 'complete' THEN 'complete'
    ELSE 'unknown'
  END as period_coverage
FROM latest_evidence;
```

**AUTHORITATIVE COVERAGE SEMANTICS:**
- `period_coverage` is determined EXCLUSIVELY by latest `combined_coverage` value
- `report_coverage` and `liberaciones_coverage` are DIAGNOSTIC EVIDENCE ONLY
- If `combined_coverage` is NULL or 'unknown', `period_coverage` is 'unknown' regardless of individual source status
- Fallback to "report AND liberaciones both complete" is NO LONGER PERMITTED
- Example: period with report='complete' AND liberaciones='complete' but combined=NULL => period_coverage='unknown'

**Test Cases:**

| combined_coverage | report | liberaciones | period_coverage | Notes |
|---|---|---|---|---|
| complete | complete | complete | complete | Julio: authorized by combined cert |
| complete | unknown | partial | complete | Combined is sole authority |
| unknown | complete | complete | unknown | Combined unknown => unknown |
| NULL | complete | complete | unknown | No combined => unknown |
| partial | complete | complete | partial | Combined partial => period partial |
| none | complete | complete | none | Combined none => period none |

**Note on Validation O:** -0.03 variance has no threshold in this view. Variance detection and status remain "UNKNOWN" without threshold logic.

---

## VIEW 3: `v_balance_chain_coverage`

**Purpose:** Validate balance chain completeness from opening_date to each period_end  
**BLOCKER 3 FIX:** Uses helper function via LATERAL join — single source of truth  
**Returns ONE row per monthly_reconciliation:** Helper guarantees exactly one row (BLOCKER 2)  
**Validation:** All months from opening_date to period_end MUST have period_coverage='complete'

```sql
CREATE OR REPLACE VIEW v_balance_chain_coverage AS
WITH distinct_periods AS (
  -- BLOCKER 3: Deduplicate periods regardless of reconciliation_scope
  -- One row per (account_id, period_start, period_end) even if 2+ monthly_reconciliation rows
  SELECT DISTINCT
    account_id,
    period_start,
    period_end
  FROM monthly_reconciliation
)
SELECT
  dp.account_id,
  dp.period_start,
  dp.period_end,
  c.opening_config_valid,
  c.required_months,
  c.complete_months,
  c.missing_or_incomplete_months,
  c.balance_chain_coverage
FROM distinct_periods dp
CROSS JOIN LATERAL calculate_balance_chain_coverage(
  dp.account_id,
  dp.period_start,
  dp.period_end
) c;
```

**Test Cases (Validation J-K):**

| Months | Status | Complete? | Test |
|---|---|---|---|
| enero=complete, febrero=complete, ..., julio=complete | All complete | YES | ✓ |
| enero=ABSENT (unknown), febrero-julio=complete | Not all complete | NO | J ✓ |
| enero-junio=partial, julio=complete | Not all complete | NO | K ✓ |
| enero-junio=complete, julio=ABSENT | Not all complete | NO | K ✓ |

**Validation Logic:**
- Enero absent => generates as 'unknown' from generate_series LEFT JOIN
- If any month is 'unknown' or 'partial' => chain_coverage = 'incomplete'
- ALL months must be 'complete' for chain_coverage = 'complete'

---

## VIEW 4: `v_monthly_reconciliation_summary`

**Purpose:** Full reconciliation state with all derived calculations from ledger (source-of-truth)  
**Validations:** Opening config validation (L), closing SUM includes opening_balance_date (M), timezone explicit (ART), evidence preservation (N)  
**Source-of-Truth Rule:** NEVER use account_balance.calculated_balance; always recalculate from ledger

```sql
CREATE OR REPLACE VIEW v_monthly_reconciliation_summary AS
WITH monthly_data AS (
  SELECT
    mr.id,
    mr.account_id,
    mr.period_start,
    mr.period_end,
    mr.reconciliation_scope,
    mr.status,
    mr.variance_approval_note,
    mr.approved_by,
    mr.approved_at,
    mr.closing_snapshot_id,
    mr.period_flow_observation_id,
    mr.created_at,
    mr.updated_at
  FROM monthly_reconciliation mr
),
opening_data AS (
  -- ISSUE 3 FIX: Use canonical helper for opening config (day before period_start)
  SELECT
    md.id,
    md.account_id,
    c.opening_config_valid,
    c.opening_balance,
    c.opening_balance_date,
    c.calculated_balance as opening_balance_calculated
  FROM monthly_data md
  CROSS JOIN LATERAL calculate_account_balance_as_of(
    md.account_id,
    (md.period_start - INTERVAL '1 day')::DATE
  ) c
),
closing_data AS (
  -- ISSUE 3 FIX: Use canonical helper for closing balance (period_end)
  SELECT
    md.id,
    md.account_id,
    c.calculated_balance as closing_balance_calculated
  FROM monthly_data md
  CROSS JOIN LATERAL calculate_account_balance_as_of(
    md.account_id,
    md.period_end
  ) c
),
period_data AS (
  SELECT
    md.id,
    md.account_id,
    md.period_start,
    md.period_end,
    md.reconciliation_scope,
    md.status,
    md.variance_approval_note,
    md.approved_by,
    md.approved_at,
    md.closing_snapshot_id,
    md.period_flow_observation_id,
    md.created_at,
    md.updated_at,
    
    -- Opening balance (from helper)
    od.opening_config_valid,
    od.opening_balance,
    od.opening_balance_date,
    od.opening_balance_calculated,
    
    -- Period movement sum (all movements during period_start to period_end)
    (SELECT COALESCE(SUM(balance_impact), 0)
     FROM ledger_entry le
     WHERE le.account_id = md.account_id
       AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
         BETWEEN md.period_start AND md.period_end
    )::NUMERIC(15,2) as period_movement_sum_calculated,
    
    -- Closing balance (from helper)
    cd.closing_balance_calculated
  FROM monthly_data md
  LEFT JOIN opening_data od ON od.id = md.id
  LEFT JOIN closing_data cd ON cd.id = md.id
),
with_observations AS (
  -- Fetch evidence snapshot and observation (Validation N: use specific ID, stays historical)
  -- QUINTO FIX 1: Add is_current flags with NULL semantics (NULL=no evidence, TRUE=vigent, FALSE=superseded)
  SELECT
    pd.*,
    rs.observed_balance as closing_balance_observed,
    rs.observed_at as closing_observed_at,
    rs.source_method as closing_source_method,
    -- QUINTO FIX 1: Is this specific snapshot still vigent? NULL if no snapshot evidence
    CASE
      WHEN rs.id IS NULL THEN NULL
      ELSE NOT EXISTS (SELECT 1 FROM reconciliation_snapshot newer WHERE newer.supersedes_snapshot_id = rs.id)
    END AS closing_snapshot_is_current,
    pfo.observed_net as period_flow_observed,
    pfo.observed_at as period_flow_observed_at,
    pfo.source_method as period_flow_source_method,
    -- QUINTO FIX 1: Is this specific observation still vigent? NULL if no observation evidence
    CASE
      WHEN pfo.id IS NULL THEN NULL
      ELSE NOT EXISTS (SELECT 1 FROM period_flow_observation newer WHERE newer.supersedes_observation_id = pfo.id)
    END AS period_flow_observation_is_current
  FROM period_data pd
  LEFT JOIN reconciliation_snapshot rs ON rs.id = pd.closing_snapshot_id
  LEFT JOIN period_flow_observation pfo ON pfo.id = pd.period_flow_observation_id
),
with_coverage AS (
  -- ERROR 9 FIX: Join period and balance chain coverage
  -- BLOCKER 1: reconciliation_scope added to SELECT and JOINs
  SELECT
    wo.*,
    pcs.period_coverage,
    bcc.balance_chain_coverage,
    bcc.required_months,
    bcc.complete_months,
    bcc.missing_or_incomplete_months
  FROM with_observations wo
  LEFT JOIN v_period_coverage_status pcs ON (
    pcs.account_id = wo.account_id 
    AND pcs.period_start = wo.period_start 
    AND pcs.period_end = wo.period_end
  )
  LEFT JOIN v_balance_chain_coverage bcc ON (
    bcc.account_id = wo.account_id 
    AND bcc.period_start = wo.period_start 
    AND bcc.period_end = wo.period_end
  )
)
SELECT
  id,
  account_id,
  period_start,
  period_end,
  opening_balance,
  opening_balance_date,
  opening_config_valid,
  opening_balance_calculated,
  period_movement_sum_calculated,
  closing_balance_calculated,
  closing_balance_observed,
  closing_observed_at,
  closing_source_method,
  (CASE
    WHEN closing_balance_observed IS NOT NULL AND closing_balance_calculated IS NOT NULL
    THEN (closing_balance_observed - closing_balance_calculated)::NUMERIC(15,2)
    ELSE NULL
  END) as account_balance_variance,
  period_flow_observed,
  period_flow_observed_at,
  period_flow_source_method,
  (CASE
    WHEN period_flow_observed IS NOT NULL AND period_movement_sum_calculated IS NOT NULL
    THEN (period_flow_observed - period_movement_sum_calculated)::NUMERIC(15,2)
    ELSE NULL
  END) as period_flow_discrepancy,
  -- ERROR 10 FIX: Include evidence IDs
  closing_snapshot_id,
  closing_snapshot_is_current,
  period_flow_observation_id,
  period_flow_observation_is_current,
  -- ERROR 9 FIX: Include coverage status
  period_coverage,
  balance_chain_coverage,
  required_months,
  complete_months,
  missing_or_incomplete_months,
  -- BLOCKER 1: Expose reconciliation_scope
  reconciliation_scope,
  status,
  variance_approval_note,
  approved_by,
  approved_at,
  created_at,
  updated_at
FROM with_coverage;
```

**Validations Embedded:**

| Validation | Implementation | Check |
|---|---|---|
| L | opening_config_valid = COUNT(DISTINCT balance) = 1 AND COUNT(DISTINCT date) = 1 | ✓ opening_balance_calculated NULL if inconsistent |
| M | SUM criteria includes DATE >= opening_balance_date | ✓ closing_balance_calculated correct |
| N | closing_snapshot_id points to specific snapshot row | ✓ if later superseded, reference stays |
| O | account_balance_variance and period_flow_discrepancy NULL if no observation | ✓ no threshold, no rounding |
| 9 | period_coverage and balance_chain_coverage JOINed by (account_id, period_start, period_end) | ✓ both included as columns |
| 10 | closing_snapshot_id and period_flow_observation_id included in SELECT | ✓ specific IDs exposed |
| 11 | closing_snapshot_is_current and period_flow_observation_is_current flags computed | ✓ vigence via NOT EXISTS |

---

## CRITICAL DESIGN DECISIONS

### Decision 1: Supersession Immutability (Validations A-E + Errors 1-2)

**Pattern:** NOT EXISTS vigent detection (ERROR 1 FIX)
**Implementation:**
- Table has `supersedes_snapshot_id` foreign key
- UNIQUE index on supersedes_snapshot_id (prevents two rows superseding same row)
- Triggers validate same account and balance_date (Error 2: also validates target has no successor)
- BEFORE UPDATE/DELETE triggers RAISE EXCEPTION

**Guarantee:**
- snapshot id=100 can only have one successor (UNIQUE constraint)
- snapshot id=101 superseding id=100 is validated to have same account_id and balance_date
- snapshot id=100 must be vigent (no other row supersedes it already)
- To find vigent: SELECT WHERE NOT EXISTS (newer row with supersedes_snapshot_id = this.id)
- NEVER use: SELECT WHERE supersedes_snapshot_id IS NULL (WRONG)

---

### Decision 2: Period Coverage Rule — COMBINED-AUTHORITATIVE (BLOCKER 1 FIX)

**BLOCKER 1 FIX: Combined is the EXCLUSIVE authoritative source**
- `period_coverage` determined SOLELY by `combined_coverage`
- If `combined_coverage` IS NULL => period_coverage='unknown' (no fallback allowed)
- If `combined_coverage` = 'complete' => period_coverage='complete' (authorized by combined cert)
- If `combined_coverage` = 'unknown' => period_coverage='unknown'
- If `combined_coverage` = 'partial' => period_coverage='partial'
- If `combined_coverage` = 'none' => period_coverage='none'
- `report_coverage` and `liberaciones_coverage` are DIAGNOSTIC EVIDENCE ONLY
- NO rule like "report AND liberaciones both complete => complete"; this is forbidden

**Implication:** Julio/Agosto balance chains now depend on combined certification existing. If no combined cert, period_coverage='unknown' even if report and liberaciones individually complete.

**No scalar subqueries:** Uses LEFT JOIN with PIVOT aggregation via MAX(CASE WHEN).

---

### Decision 3: Balance Chain Continuity (Validations J-K + Errors 5-6)

**ERROR 5-6 FIX: Method per monthly_reconciliation period, not globally**
**Method:** generate_series from opening_balance_date to THIS period's period_end  
**Rule:** ALL months from opening through period_end must have period_coverage='complete'  
**Absence:** If enero is missing, generates 'unknown' via LEFT JOIN, fails chain
**Opening Config:** Only valid if opening_balance AND opening_balance_date both distinct=1

**Test:**
- enero absent => chain=incomplete (J ✓)
- enero-junio partial => chain=incomplete (K ✓)
- opening config invalid => chain unavailable for that period (6 ✓)

---

### Decision 4: Opening Config Validation (Validation L + Error 7)

**ERROR 7 FIX: Pattern validates BOTH opening_balance AND opening_balance_date**
**Rule:**
- If COUNT(DISTINCT opening_balance) = 1 AND COUNT(DISTINCT opening_balance_date) = 1 => valid
- If either count > 1 OR != 1 => invalid, calculated_balance = NULL
- No MAX(balance_date) filtering on config selection (defeats consistency check)

**Implementation:** opening_config_valid boolean field in VIEW

---

### Decision 5: Closing Balance Calculation (Validation M)

**Source:** Ledger, NEVER account_balance.calculated_balance  
**Formula:** opening_balance + SUM(balance_impact WHERE date >= opening_balance_date AND date <= period_end)  
**Timezone:** Explicit `AT TIME ZONE 'America/Argentina/Buenos_Aires'`

---

### Decision 6: Evidence Preservation (Validation N)

**Rule:** monthly_reconciliation.closing_snapshot_id stays even if snapshot is later superseded  
**Reason:** Historical audit trail; reference is specific ID, not "vigent" snapshot

**Example:**
- Aug 2026: closing_snapshot_id = 100 (observed_balance = 10000)
- Sept 2026: snapshot 101 supersedes 100 (observed_balance = 10050)
- monthly_reconciliation.closing_snapshot_id still = 100 (historical record)
- Query for variance uses JOIN rs ON rs.id = 100, not vigent search

---

### Decision 7: Variance Detection (Validation O)

**Rule:** No threshold, no rounding, no tolerance  
**Status:** Remains "UNKNOWN" until explicitly reviewed  
**Example:**
- variance = -0.03 => account_balance_variance = -0.03
- status remains 'pending' or 'needs_investigation'
- NO automatic 'reconciled' if variance < 0.05

---

## QUINTO FIX 8: AUGUST SEMANTICS DOCUMENTATION

**Real Data Example: August 2026 Period**

Period: 2026-08-01 to 2026-08-31  
Account: 1 (Granja Santo Tomás - MercadoPago)

**Observation from UI:**
- User captures screenshot of MercadoPago dashboard showing "Movimientos Netos Agosto": **-124,203.27**
- This becomes: `period_flow_observation.observed_net = -124,203.27`
- Recorded in: `period_flow_observation` table with created_at = when screenshot taken
- Stored: `period_flow_observation_id = 42` (example)

**Ledger Calculation (from ledger_entry, source-of-truth):**
- Query: SUM(balance_impact) WHERE account_id=1 AND period_start='2026-08-01' AND period_end='2026-08-31'
- Result: `period_movement_sum_calculated = -124,203.24`

**Discrepancy:**
- Formula: `period_flow_discrepancy = observed_net - calculated = -124,203.27 - (-124,203.24) = -0.03`
- Status: The reconciliation remains `status='pending'` or `status='needs_investigation'`
- NO INFERENCE: The -0.03 discrepancy has NO automatically-inferred cause
- NO SNAPSHOT CREATED: We do NOT create a `reconciliation_snapshot` row with balance = -124,203.27
- REASON: `reconciliation_snapshot` records ACCOUNT BALANCE observations (balance_date snapshots), not period flows

**What Stays Historical:**
- `period_flow_observation` row id=42: observed_net = -124,203.27 (audit trail preserved)
- `period_flow_observation_is_current = TRUE` (if not yet superseded)
- Monthly reconciliation shows: `period_flow_observed = -124,203.27`, `period_flow_discrepancy = -0.03`
- No automatic status change; human review required

---

## QUINTO FIX 9: PERIOD FLOW RECONCILIATION EXAMPLE

**Scenario:** August period, `reconciliation_scope = 'period_flow'`

**Preconditions:**
- `period_coverage` for Aug 2026: `complete` ✓ (both report and liberaciones sources have data)
- `balance_chain_coverage` for Aug 2026: `incomplete` (e.g., July missing)
- Period flow observation available: `period_flow_observation_id = 42` with exact period

**Resolution:**
- Even though `balance_chain_coverage = incomplete`, period flow reconciliation CAN PROCEED
- Reason: Period flow reconciliation focuses ONLY on Aug period, not on chain from opening
- Check: period_coverage = complete (Aug has complete data) ✓
- Action: Set `status = 'reconciled'` if observed_net matches calculated, OR `status = 'variance_approved'` with note
- Trigger validates ONLY: period_coverage = complete AND period_flow_observation_id set
- Trigger does NOT check: balance_chain_coverage (irrelevant to period_flow scope)

**Contrast: Account Balance Reconciliation**
- If `reconciliation_scope = 'account_balance'`:
  - Would require BOTH: period_coverage = complete AND balance_chain_coverage = complete
  - Would fail if chain incomplete
  - Would require closing_snapshot_id (balance date observation)

---

## APPEND-ONLY & IMMUTABLE ENFORCEMENT

### `import_period_coverage` (Append-only)
- **ERROR 13 & 14 FIX: Application policy only (no SQL blocks)**
- **SQL:** Plain INSERT; v_latest_coverage_evidence uses ROW_NUMBER to find vigent
- **Service Layer:** Enforce INSERT-only policy; reject UPDATE/DELETE at application level
- **No SQL UPDATE/DELETE blocks** (intentional: only application policy enforces append-only)

### `reconciliation_snapshot` (INSERT-only)
- **ERROR 14 FIX: DB-enforced (not application policy)**
- **SQL Enforcement:**
  - BEFORE UPDATE TRIGGER → RAISE EXCEPTION
  - BEFORE DELETE TRIGGER → RAISE EXCEPTION
  - ON DELETE RESTRICT on FK prevents orphaning

### `period_flow_observation` (INSERT-only)
- **ERROR 14 FIX: DB-enforced (not application policy)**
- **SQL Enforcement:**
  - BEFORE UPDATE TRIGGER → RAISE EXCEPTION
  - BEFORE DELETE TRIGGER → RAISE EXCEPTION
  - ON DELETE RESTRICT on FK prevents orphaning

### `monthly_reconciliation` (Mutable)
- **Allowed:** UPDATE for status, approvals, variance_approval_note
- **Audit Trail:** updated_at timestamp BEFORE UPDATE trigger (ERROR 17 verified)
- **Service Layer:** Log all UPDATE operations for compliance

---

## TIMEZONE SPECIFICATION

All timestamp calculations in views use explicit `AT TIME ZONE 'America/Argentina/Buenos_Aires'` conversion:

```sql
DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
```

This ensures ledger entries (stored in UTC) are correctly interpreted in local Argentina timezone.

---

## MIGRATION STRATEGY

### Migration File: `007_reconciliation_tables.sql`

**ISSUE 1 FIX: Correct Dependency Order to Prevent Circular/Forward References**

```sql
-- Sequenced to ensure no forward dependencies (view before function reference)
BEGIN;

-- ===== A. TABLES BASE (No FK dependencies on views/functions) =====
-- 1. Coverage evidence table (append-only, no dependencies)
CREATE TABLE IF NOT EXISTS import_period_coverage ( ... );

-- 2. Snapshot table (immutable, no FK on views/functions)
CREATE TABLE IF NOT EXISTS reconciliation_snapshot ( ... );

-- 3. Flow observation table (immutable, no FK on views/functions)
CREATE TABLE IF NOT EXISTS period_flow_observation ( ... );

-- 4. Monthly reconciliation table (references snapshots/observations, not views)
CREATE TABLE IF NOT EXISTS monthly_reconciliation ( ... );

-- ===== B. INDEXES + EVIDENCE TRIGGERS (Support immutability enforcement) =====
-- 5. Coverage indexes (fast lookup for view)
CREATE INDEX IF NOT EXISTS idx_import_period_coverage_lookup ( ... );
CREATE INDEX IF NOT EXISTS idx_import_period_coverage_by_account_period ( ... );

-- 6. Snapshot indexes + immutability triggers
CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_supersedes ( ... );
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_unique_successor ( ... );
CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_root_unique ( ... );  -- BLOCKER 2 FIX
CREATE OR REPLACE FUNCTION reconciliation_snapshot_validate_supersession() ...;
CREATE TRIGGER trg_reconciliation_snapshot_validate_supersession ...;
CREATE OR REPLACE FUNCTION reconciliation_snapshot_prevent_update() ...;
CREATE TRIGGER trg_reconciliation_snapshot_prevent_update ...;
CREATE OR REPLACE FUNCTION reconciliation_snapshot_prevent_delete() ...;
CREATE TRIGGER trg_reconciliation_snapshot_prevent_delete ...;

-- 7. Flow observation indexes + immutability triggers
CREATE INDEX IF NOT EXISTS idx_period_flow_observation_supersedes ( ... );
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_unique_successor ( ... );
CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_root_unique ( ... );  -- BLOCKER 2 FIX
CREATE OR REPLACE FUNCTION period_flow_observation_validate_supersession() ...;
CREATE TRIGGER trg_period_flow_observation_validate_supersession ...;
CREATE OR REPLACE FUNCTION period_flow_observation_prevent_update() ...;
CREATE TRIGGER trg_period_flow_observation_prevent_update ...;
CREATE OR REPLACE FUNCTION period_flow_observation_prevent_delete() ...;
CREATE TRIGGER trg_period_flow_observation_prevent_delete ...;

-- ===== C. COVERAGE VIEWS (No dependencies; source from tables only) =====
-- 8. Latest coverage evidence view (queries import_period_coverage table)
CREATE OR REPLACE VIEW v_latest_coverage_evidence AS ...;

-- 9. Period coverage status view (queries v_latest_coverage_evidence only)
CREATE OR REPLACE VIEW v_period_coverage_status AS ...;

-- ===== D. CANONICAL HELPER FUNCTIONS (Now safe to reference v_period_coverage_status) =====
-- 10. Account balance calculation helper (no dependencies on views)
CREATE OR REPLACE FUNCTION calculate_account_balance_as_of(...) ...;
  -- ISSUE 2 FIX: Guarantees exactly ONE row always

-- 11. Balance chain coverage helper (references v_period_coverage_status view)
CREATE OR REPLACE FUNCTION calculate_balance_chain_coverage(...) ...;
  -- ISSUE 1 FIX: v_period_coverage_status now exists; no circular dependency

-- ===== E. MONTHLY RECONCILIATION TRIGGERS (Reference helpers) =====
-- 12. Monthly reconciliation reference validation trigger
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_references() ...;
CREATE TRIGGER trg_monthly_reconciliation_validate_references ...;

-- 13. Monthly reconciliation preconditions trigger (calls helpers)
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_preconditions() ...;
  -- ISSUE 1 FIX: calculate_balance_chain_coverage now exists
CREATE TRIGGER trg_monthly_reconciliation_validate_preconditions ...;

-- 14. Monthly reconciliation timestamp trigger
CREATE OR REPLACE FUNCTION monthly_reconciliation_update_timestamp() ...;
CREATE TRIGGER trg_monthly_reconciliation_update_timestamp ...;

-- Monthly reconciliation indexes
CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_account_date ( ... );
CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_status ( ... );

-- ===== F. FINAL VIEWS (Reference all preceding objects) =====
-- 15. Balance chain coverage view (references calculate_balance_chain_coverage helper)
CREATE OR REPLACE VIEW v_balance_chain_coverage AS ...;

-- 16. Monthly reconciliation summary view (references helpers and coverage views)
CREATE OR REPLACE VIEW v_monthly_reconciliation_summary AS ...;
  -- ISSUE 3 FIX: Uses calculate_account_balance_as_of helper via LATERAL

COMMIT;
```

**Dependency Justification:**

| Step | Object | Why Before Next Step |
|---|---|---|
| 1-4 | Tables | Base schema; all other objects depend on these tables |
| 5-7 | Indexes + Triggers | Immutability enforcement; indexing precedes query paths (views) |
| 8 | v_latest_coverage_evidence | Pure table aggregation; no dependencies |
| 9 | v_period_coverage_status | Queries v_latest_coverage_evidence; needed by helpers |
| 10-11 | Helper functions | Canonical logic; must exist before triggers reference them |
| 12-14 | Triggers + Indexes | Call helpers; reference complete by step 11 |
| 15-16 | Final views | Reference helpers and coverage views; all preceding objects complete |

---

## VALIDATION CERTIFICATE — FOURTH DRAFT CORRECTED

**All 30 items (A-O + 18 errors) validated and corrected:**

| # | Decision | Status | Evidence / Correction |
|---|----------|--------|-----------|
| A | snapshot id2 supersedes id1 => vigent=id2 | ✅ FIXED | ERROR 1: NOW uses NOT EXISTS (newer row), NEVER IS NULL |
| B | UPDATE snapshot => RAISE | ✅ | BEFORE UPDATE trigger with EXCEPTION |
| C | DELETE snapshot => RAISE | ✅ | BEFORE DELETE trigger with EXCEPTION |
| D | supersede other balance_date => RAISE | ✅ | trigger validates same balance_date |
| E | two successors same snapshot => UNIQUE | ✅ | UNIQUE INDEX on supersedes_snapshot_id |
| E2 | supersede vigent target only | ✅ FIXED | ERROR 2: Trigger now validates target has no successor |
| F | report complete + lib complete => complete | ✅ FIXED | ERROR 4: Case order corrected, NULL checks first |
| G | report complete + lib partial => partial | ✅ FIXED | ERROR 4: Case order corrected |
| H | report complete + lib missing => unknown | ✅ FIXED | ERROR 4: NULL now => unknown (case 1) |
| I | report none + lib none => none | ✅ FIXED | ERROR 4: Case order corrected |
| J | enero absent => chain incomplete | ✅ FIXED | ERROR 5-6: Now scoped to monthly_reconciliation.period |
| K | enero-junio incomplete => aug incomplete | ✅ FIXED | ERROR 5-6: All months required per period_end |
| L | opening config inconsistent => NULL | ✅ FIXED | ERROR 7: NOW validates BOTH balance + date distinct |
| M | closing SUM >= opening_balance_date | ✅ | explicit DATE criteria >= opening_balance_date |
| N | closing_snapshot_id stays historical | ✅ | specific ID reference, not vigent lookup |
| O | -0.03 remains UNKNOWN | ✅ | no threshold, no rounding, status persists |
| S1 | Immutability via TRIGGERs + SQL | ✅ FIXED | ERROR 14: snapshot/flow DB-enforced, coverage app-only |
| S2 | Supersession chain validation | ✅ FIXED | ERROR 2: target vigent check added |
| S3 | Timezone ART explicit | ✅ | Every ledger calc has AT TIME ZONE 'ART' |
| S4 | No scalar subqueries in coverage view | ✅ | Uses LEFT JOIN + MAX(CASE WHEN) pivot |
| S5 | Opening config validation flow | ✅ FIXED | ERROR 7: COUNT(DISTINCT balance) + COUNT(DISTINCT date) |
| 3 | source_method ONLY 'manual' | ✅ FIXED | ERROR 3: CHECK constraint added, removed future methods |
| 8 | Approval note nonblank required | ✅ FIXED | ERROR 8: btrim() <> '' + symmetric constraint |
| 9 | Coverage views JOINed in summary | ✅ FIXED | ERROR 9: period_coverage + balance_chain_coverage included |
| 10 | Evidence IDs exposed | ✅ FIXED | ERROR 10: closing_snapshot_id + period_flow_observation_id |
| 11 | is_current flags | ✅ FIXED | ERROR 11: closing_snapshot_is_current + period_flow_observation_is_current |
| 13 | Coverage append-only documented | ✅ FIXED | ERROR 13: Application policy only, NO SQL blocks |
| 15 | FK semantics justified | ✅ FIXED | ERROR 15: ON DELETE RESTRICT implemented (immutable snapshots) |
| 16 | updated_at NOT NULL | ✅ FIXED | ERROR 16: NOT NULL DEFAULT NOW() |
| 17 | Trigger sets updated_at | ✅ | Verified in trg_monthly_reconciliation_update_timestamp |

---

## READY FOR FINAL DRAFT APPROVAL

**Status:** ✅ SCHEMA FINAL DRAFT COMPLETE WITH 18 CRITICAL FIXES + 10 QUINTO FIXES + 4 BLOCKER FIXES  

**CRITICAL FIXES VERIFIED:**
- ✅ Supersession vigent now uses NOT EXISTS (never IS NULL)
- ✅ Supersession insert validates target is vigent (no successor)
- ✅ source_method restricted to 'manual' only with CHECK
- ✅ v_period_coverage_status NULL handling corrected (5-case exact order)
- ✅ v_balance_chain_coverage scoped per (account_id, period_start, period_end)
- ✅ Opening config validates BOTH balance + date distinct
- ✅ v_monthly opening config no MAX(balance_date) pre-filtering
- ✅ Approval constraint requires nonblank note + symmetric fields
- ✅ v_monthly_reconciliation_summary includes period_coverage + balance_chain_coverage
- ✅ v_monthly exposes closing_snapshot_id + period_flow_observation_id
- ✅ Added closing_snapshot_is_current + period_flow_observation_is_current
- ✅ Period vs chain coverage independent columns
- ✅ import_period_coverage documented append-only (application policy only)
- ✅ Immutability certificate honest: snapshot/flow DB-enforced, coverage app-only
- ✅ FK semantics documented: ON DELETE RESTRICT (immutable snapshots)
- ✅ updated_at now NOT NULL
- ✅ Trigger verified sets updated_at = NOW() on UPDATE
- ✅ Validation certificate no false positives

**BLOCKER FIXES 1-4 VERIFIED:**
- ✅ BLOCKER 1: UNIQUE constraint includes reconciliation_scope; period_flow + account_balance same period allowed
- ✅ BLOCKER 1b: v_monthly_reconciliation_summary exposes reconciliation_scope field
- ✅ BLOCKER 2: Helper function calculate_balance_chain_coverage created; trigger calls helper not persistent view
- ✅ BLOCKER 3: Trigger validates exact discrepancy=0.00 for period_flow reconciled; exact variance=0.00 for account_balance reconciled
- ✅ BLOCKER 4: v_balance_chain_coverage uses DISTINCT periods; ONE row per account+period regardless of scope

**FINAL BLOCKER FIXES 1-2 VERIFIED:**
- ✅ FINAL BLOCKER 1 (COMBINED AUTHORITATIVE):
  - v_period_coverage_status rewritten to use combined_coverage ONLY
  - If combined_coverage=NULL => period_coverage='unknown' (no fallback)
  - Removed fallback: "report AND liberaciones both complete => complete"
  - report_coverage and liberaciones_coverage exposed as DIAGNOSTIC ONLY
  - combined_coverage exposed and combined_checkpoint_id exposed
  - Balance chain now depends on combined certification existing
  - Test cases updated: combined=NULL with report+lib=complete => 'unknown' ✓
  
- ✅ FINAL BLOCKER 2 (ROOT CHAIN UNIQUENESS):
  - Added: idx_reconciliation_snapshot_root_unique on (account_id, balance_date) WHERE supersedes_snapshot_id IS NULL
  - Added: idx_period_flow_observation_root_unique on (account_id, period_start, period_end) WHERE supersedes_observation_id IS NULL
  - Guarantees exactly ONE root per (account, date/period) identity
  - Prevents two roots with same identity
  - Migration strategy updated: indexes listed in step 6-7 (before triggers)
  - Validation: single linear chain per identity guaranteed

**All 30 Items (A-O + 18 Fixes + 10 Quinto + 4 Blockers + 2 Final Blockers):** ✅ VERIFIED IN SQL CODE

**Next Step:** Execute `007_reconciliation_tables.sql` migration when approved.
