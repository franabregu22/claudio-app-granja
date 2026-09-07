-- FASE 1: RECONCILIATION TABLES MIGRATION
-- Migration: 007_reconciliation_tables.sql
-- Status: Ready for review (NOT executed)
-- Data: No data inserted
-- Reversibility: DROP TABLE IF EXISTS (cascades to views/functions)

BEGIN;

-- ============================================================
-- A. TABLES BASE
-- ============================================================

-- TABLE 1: import_period_coverage
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

CREATE INDEX IF NOT EXISTS idx_import_period_coverage_lookup
  ON import_period_coverage(account_id, period_start, period_end, source_type, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_import_period_coverage_by_account_period
  ON import_period_coverage(account_id, period_start, period_end, source_type);

-- TABLE 2: reconciliation_snapshot
CREATE TABLE IF NOT EXISTS reconciliation_snapshot (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,

  observed_balance NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  source_method VARCHAR(50) NOT NULL DEFAULT 'manual',
  source_detail VARCHAR(255),

  notes TEXT,
  created_by TEXT,

  supersedes_snapshot_id BIGINT,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_source_method CHECK (source_method = 'manual'),
  CONSTRAINT fk_supersedes FOREIGN KEY (supersedes_snapshot_id)
    REFERENCES reconciliation_snapshot(id) ON DELETE RESTRICT,
  CONSTRAINT supersedes_not_self CHECK (
    supersedes_snapshot_id IS NULL OR supersedes_snapshot_id != id
  )
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_snapshot_supersedes
  ON reconciliation_snapshot(supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_unique_successor
  ON reconciliation_snapshot(supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reconciliation_snapshot_root_unique
  ON reconciliation_snapshot(account_id, balance_date)
  WHERE supersedes_snapshot_id IS NULL;

-- TABLE 3: period_flow_observation
CREATE TABLE IF NOT EXISTS period_flow_observation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  observed_net NUMERIC(15,2) NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,

  source_method VARCHAR(50) NOT NULL DEFAULT 'manual',
  source_detail VARCHAR(255),

  notes TEXT,
  created_by TEXT,

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

CREATE INDEX IF NOT EXISTS idx_period_flow_observation_supersedes
  ON period_flow_observation(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_unique_successor
  ON period_flow_observation(supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_period_flow_observation_root_unique
  ON period_flow_observation(account_id, period_start, period_end)
  WHERE supersedes_observation_id IS NULL;

-- TABLE 4: monthly_reconciliation
CREATE TABLE IF NOT EXISTS monthly_reconciliation (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  reconciliation_scope VARCHAR(30) NOT NULL,

  closing_snapshot_id BIGINT,
  period_flow_observation_id BIGINT,

  status VARCHAR(30) NOT NULL DEFAULT 'pending',

  variance_approval_note TEXT,
  approved_by TEXT,
  approved_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

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
  CONSTRAINT fk_period_flow_observation FOREIGN KEY (period_flow_observation_id)
    REFERENCES period_flow_observation(id) ON DELETE RESTRICT,
  CONSTRAINT approval_consistency CHECK (
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

-- ============================================================
-- B. INDEXES + EVIDENCE TRIGGERS
-- ============================================================

-- TRIGGER: reconciliation_snapshot validate supersession
CREATE OR REPLACE FUNCTION reconciliation_snapshot_validate_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supersedes_snapshot_id IS NOT NULL THEN
    PERFORM 1 FROM reconciliation_snapshot
    WHERE id = NEW.supersedes_snapshot_id
      AND account_id = NEW.account_id
      AND balance_date = NEW.balance_date;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersedes_snapshot_id must reference same account_id and balance_date';
    END IF;

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

-- TRIGGER: reconciliation_snapshot prevent update
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

-- TRIGGER: reconciliation_snapshot prevent delete
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

-- TRIGGER: period_flow_observation validate supersession
CREATE OR REPLACE FUNCTION period_flow_observation_validate_supersession()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supersedes_observation_id IS NOT NULL THEN
    PERFORM 1 FROM period_flow_observation
    WHERE id = NEW.supersedes_observation_id
      AND account_id = NEW.account_id
      AND period_start = NEW.period_start
      AND period_end = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supersedes_observation_id must reference same account and period';
    END IF;

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

-- TRIGGER: period_flow_observation prevent update
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

-- TRIGGER: period_flow_observation prevent delete
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

-- ============================================================
-- C. COVERAGE VIEWS
-- ============================================================

-- VIEW: v_latest_coverage_evidence
CREATE OR REPLACE VIEW v_latest_coverage_evidence AS
WITH latest AS (
  SELECT
    id,
    account_id,
    period_start,
    period_end,
    source_type,
    coverage,
    import_checkpoint_id,
    validated_at,
    validated_by,
    coverage_notes,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, period_start, period_end, source_type
      ORDER BY created_at DESC, id DESC
    ) as rn
  FROM import_period_coverage
)
SELECT
  id,
  account_id,
  period_start,
  period_end,
  source_type,
  coverage,
  import_checkpoint_id,
  validated_at,
  validated_by,
  coverage_notes,
  created_at
FROM latest
WHERE rn = 1;

-- VIEW: v_period_coverage_status (BLOCKER 1 FIX: combined-authoritative)
CREATE OR REPLACE VIEW v_period_coverage_status AS
WITH latest_evidence AS (
  SELECT
    account_id,
    period_start,
    period_end,
    MAX(CASE WHEN source_type='report' THEN id END) as report_evidence_id,
    MAX(CASE WHEN source_type='liberaciones' THEN id END) as liberaciones_evidence_id,
    MAX(CASE WHEN source_type='combined' THEN id END) as combined_evidence_id,
    MAX(CASE WHEN source_type='report' THEN coverage END) as report_coverage,
    MAX(CASE WHEN source_type='liberaciones' THEN coverage END) as liberaciones_coverage,
    MAX(CASE WHEN source_type='combined' THEN coverage END) as combined_coverage,
    MAX(CASE WHEN source_type='combined' THEN import_checkpoint_id END) as combined_checkpoint_id
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
  COALESCE(report_evidence_id, 0) as report_evidence_id,
  COALESCE(liberaciones_evidence_id, 0) as liberaciones_evidence_id,
  COALESCE(combined_evidence_id, 0) as combined_evidence_id,
  combined_checkpoint_id,
  CASE
    WHEN combined_coverage IS NULL THEN 'unknown'
    WHEN combined_coverage = 'unknown' THEN 'unknown'
    WHEN combined_coverage = 'partial' THEN 'partial'
    WHEN combined_coverage = 'none' THEN 'none'
    WHEN combined_coverage = 'complete' THEN 'complete'
    ELSE 'unknown'
  END as period_coverage
FROM latest_evidence;

-- ============================================================
-- D. CANONICAL HELPERS
-- ============================================================

-- HELPER: calculate_account_balance_as_of (BLOCKER 1, ISSUE 2 FIX)
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
  v_balance_count INTEGER;
  v_date_count INTEGER;
  v_opening_balance NUMERIC(15,2);
  v_opening_balance_date DATE;
BEGIN
  -- Validate opening config: count distinct values
  SELECT
    COUNT(DISTINCT ab.opening_balance),
    COUNT(DISTINCT ab.opening_balance_date),
    CASE WHEN COUNT(*) = 0 THEN NULL ELSE MIN(ab.opening_balance) END,
    CASE WHEN COUNT(*) = 0 THEN NULL ELSE MIN(ab.opening_balance_date) END
  INTO v_balance_count, v_date_count, v_opening_balance, v_opening_balance_date
  FROM account_balance ab
  WHERE ab.account_id = p_account_id;

  -- Return exactly ONE row (ISSUE 2 FIX: guarantee one row always)
  IF v_balance_count IS NULL THEN
    -- No account_balance rows at all
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::NUMERIC(15,2), NULL::DATE, NULL::NUMERIC(15,2);
  ELSIF v_balance_count = 1 AND v_date_count = 1 THEN
    -- Config is consistent: return calculated balance
    RETURN QUERY
    SELECT
      TRUE,
      v_opening_balance,
      v_opening_balance_date,
      v_opening_balance + COALESCE(
        (SELECT SUM(balance_impact) FROM ledger_entry le
         WHERE le.account_id = p_account_id
           AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= v_opening_balance_date
           AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= p_as_of_date),
        0
      )::NUMERIC(15,2);
  ELSE
    -- Config is inconsistent (multiple distinct values)
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::NUMERIC(15,2), NULL::DATE, NULL::NUMERIC(15,2);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- HELPER: calculate_balance_chain_coverage (BLOCKER 2, ISSUE 1 FIX)
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
  v_opening_config_valid BOOLEAN;
  v_opening_balance_date DATE;
  v_required INTEGER;
  v_complete INTEGER;
BEGIN
  -- Get opening config validity and opening_balance_date
  SELECT ocv.opening_config_valid, ocv.opening_balance_date
  INTO v_opening_config_valid, v_opening_balance_date
  FROM (
    SELECT
      CASE WHEN COUNT(DISTINCT ab.opening_balance) = 1 AND COUNT(DISTINCT ab.opening_balance_date) = 1 THEN TRUE ELSE FALSE END as opening_config_valid,
      CASE WHEN COUNT(DISTINCT ab.opening_balance) = 1 AND COUNT(DISTINCT ab.opening_balance_date) = 1 THEN MIN(ab.opening_balance_date) ELSE NULL END as opening_balance_date
    FROM account_balance ab
    WHERE ab.account_id = p_account_id
  ) ocv;

  -- If config invalid or missing, return unavailable
  IF v_opening_config_valid IS NOT TRUE THEN
    RETURN QUERY SELECT p_account_id, p_period_start, p_period_end, FALSE, NULL, NULL, NULL, 'unavailable'::VARCHAR(20);
    RETURN;
  END IF;

  -- If period_end before opening_date, return unavailable
  IF p_period_end < v_opening_balance_date THEN
    RETURN QUERY SELECT p_account_id, p_period_start, p_period_end, TRUE, NULL, NULL, NULL, 'unavailable'::VARCHAR(20);
    RETURN;
  END IF;

  -- Generate required months and count complete ones
  WITH required_months AS (
    SELECT generate_series(
      DATE_TRUNC('month', v_opening_balance_date)::DATE,
      DATE_TRUNC('month', p_period_end)::DATE,
      INTERVAL '1 month'
    )::DATE as month_start
  ),
  month_periods AS (
    SELECT
      month_start,
      LEAST((month_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE, p_period_end) as month_end
    FROM required_months
  ),
  coverage_check AS (
    SELECT
      COUNT(*) as total_months,
      SUM(CASE WHEN pcs.period_coverage = 'complete' THEN 1 ELSE 0 END) as complete_count
    FROM month_periods mp
    LEFT JOIN v_period_coverage_status pcs ON pcs.account_id = p_account_id
      AND pcs.period_start = mp.month_start
      AND pcs.period_end = mp.month_end
  )
  SELECT cc.total_months, cc.complete_count
  INTO v_required, v_complete
  FROM coverage_check cc;

  -- Determine chain status
  RETURN QUERY SELECT
    p_account_id,
    p_period_start,
    p_period_end,
    TRUE,
    v_required,
    v_complete,
    v_required - COALESCE(v_complete, 0),
    CASE
      WHEN v_complete = v_required THEN 'complete'::VARCHAR(20)
      ELSE 'incomplete'::VARCHAR(20)
    END;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- E. MONTHLY RECONCILIATION TRIGGERS
-- ============================================================

-- TRIGGER: monthly_reconciliation validate references
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_references()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.closing_snapshot_id IS NOT NULL THEN
    PERFORM 1 FROM reconciliation_snapshot
    WHERE id = NEW.closing_snapshot_id
      AND account_id = NEW.account_id
      AND balance_date = NEW.period_end;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'closing_snapshot_id must reference same account_id and balance_date = period_end';
    END IF;
  END IF;

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

-- TRIGGER: monthly_reconciliation validate preconditions (BLOCKER 3, 5, 8 FIX)
CREATE OR REPLACE FUNCTION monthly_reconciliation_validate_preconditions()
RETURNS TRIGGER AS $$
DECLARE
  v_period_coverage VARCHAR(20);
  v_balance_chain_coverage VARCHAR(20);
  v_chain_info RECORD;
  v_observed_net NUMERIC(15,2);
  v_calculated_flow NUMERIC(15,2);
  v_balance_info RECORD;
  v_observed_balance NUMERIC(15,2);
BEGIN
  -- Only validate if status is 'reconciled' or 'variance_approved'
  IF NEW.status NOT IN ('reconciled', 'variance_approved') THEN
    RETURN NEW;
  END IF;

  -- Get period coverage
  SELECT period_coverage INTO v_period_coverage
  FROM v_period_coverage_status
  WHERE account_id = NEW.account_id
    AND period_start = NEW.period_start
    AND period_end = NEW.period_end;

  -- For either scope, period_coverage must be complete
  IF v_period_coverage != 'complete' THEN
    RAISE EXCEPTION 'Cannot reconcile: period_coverage = %', COALESCE(v_period_coverage, 'unknown');
  END IF;

  -- Scope-specific validation
  IF NEW.reconciliation_scope = 'period_flow' THEN
    -- Require period_flow_observation_id
    IF NEW.period_flow_observation_id IS NULL THEN
      RAISE EXCEPTION 'period_flow reconciliation requires period_flow_observation_id';
    END IF;

    -- Get observed_net
    SELECT observed_net INTO v_observed_net
    FROM period_flow_observation
    WHERE id = NEW.period_flow_observation_id;

    -- Calculate ledger period flow
    SELECT COALESCE(SUM(balance_impact), 0) INTO v_calculated_flow
    FROM ledger_entry le
    WHERE le.account_id = NEW.account_id
      AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN NEW.period_start AND NEW.period_end;

    -- For reconciled, require exact match
    IF NEW.status = 'reconciled' THEN
      IF ABS(v_observed_net - v_calculated_flow) > 0.00 THEN
        RAISE EXCEPTION 'period_flow reconciliation requires exact match (discrepancy=%). Use variance_approved to document', ABS(v_observed_net - v_calculated_flow);
      END IF;
    END IF;

  ELSIF NEW.reconciliation_scope = 'account_balance' THEN
    -- Require closing_snapshot_id
    IF NEW.closing_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'account_balance reconciliation requires closing_snapshot_id';
    END IF;

    -- Get balance chain coverage
    SELECT * INTO v_chain_info
    FROM calculate_balance_chain_coverage(NEW.account_id, NEW.period_start, NEW.period_end);

    IF v_chain_info.balance_chain_coverage != 'complete' THEN
      RAISE EXCEPTION 'account_balance reconciliation requires balance_chain_coverage = complete (current=%)', v_chain_info.balance_chain_coverage;
    END IF;

    -- Get observed_balance
    SELECT observed_balance INTO v_observed_balance
    FROM reconciliation_snapshot
    WHERE id = NEW.closing_snapshot_id;

    -- Calculate account balance using helper
    SELECT * INTO v_balance_info
    FROM calculate_account_balance_as_of(NEW.account_id, NEW.period_end);

    -- For reconciled, require exact match
    IF NEW.status = 'reconciled' THEN
      IF ABS(v_observed_balance - v_balance_info.calculated_balance) > 0.00 THEN
        RAISE EXCEPTION 'account_balance reconciliation requires exact match (variance=%). Use variance_approved to document', ABS(v_observed_balance - v_balance_info.calculated_balance);
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

-- TRIGGER: monthly_reconciliation update timestamp
CREATE OR REPLACE FUNCTION monthly_reconciliation_update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_monthly_reconciliation_update_timestamp
  BEFORE UPDATE ON monthly_reconciliation
  FOR EACH ROW
  EXECUTE FUNCTION monthly_reconciliation_update_timestamp();

-- Indexes on monthly_reconciliation
CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_account_date
  ON monthly_reconciliation(account_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_monthly_reconciliation_status
  ON monthly_reconciliation(account_id, status);

-- ============================================================
-- F. FINAL VIEWS
-- ============================================================

-- VIEW: v_balance_chain_coverage (BLOCKER 4 FIX: uses helper)
CREATE OR REPLACE VIEW v_balance_chain_coverage AS
WITH distinct_periods AS (
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

-- VIEW: v_monthly_reconciliation_summary (ISSUE 3 FIX: uses helpers)
CREATE OR REPLACE VIEW v_monthly_reconciliation_summary AS
WITH monthly_data AS (
  SELECT
    mr.id,
    mr.account_id,
    mr.period_start,
    mr.period_end,
    mr.reconciliation_scope,
    mr.closing_snapshot_id,
    mr.period_flow_observation_id,
    rs.observed_balance,
    rs.observed_at,
    rs.source_method as snapshot_source_method,
    rs.source_detail as snapshot_source_detail,
    pfo.observed_net,
    pfo.observed_at as flow_observed_at,
    pfo.source_method as flow_source_method,
    pfo.source_detail as flow_source_detail,
    mr.status,
    mr.variance_approval_note,
    mr.approved_by,
    mr.approved_at,
    mr.created_at,
    mr.updated_at
  FROM monthly_reconciliation mr
  LEFT JOIN reconciliation_snapshot rs ON rs.id = mr.closing_snapshot_id
  LEFT JOIN period_flow_observation pfo ON pfo.id = mr.period_flow_observation_id
),
opening_calc AS (
  SELECT
    md.account_id,
    md.period_start,
    ocb.opening_config_valid,
    ocb.opening_balance,
    ocb.opening_balance_date
  FROM monthly_data md
  CROSS JOIN LATERAL calculate_account_balance_as_of(md.account_id, md.period_start - 1) ocb
),
closing_calc AS (
  SELECT
    md.account_id,
    md.period_end,
    ccb.opening_config_valid as closing_config_valid,
    ccb.calculated_balance
  FROM monthly_data md
  CROSS JOIN LATERAL calculate_account_balance_as_of(md.account_id, md.period_end) ccb
),
period_flow_calc AS (
  SELECT
    md.account_id,
    md.period_start,
    md.period_end,
    COALESCE(SUM(le.balance_impact), 0) as period_movement_sum
  FROM monthly_data md
  LEFT JOIN ledger_entry le ON le.account_id = md.account_id
    AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN md.period_start AND md.period_end
  GROUP BY md.account_id, md.period_start, md.period_end
)
SELECT
  md.id,
  md.account_id,
  md.period_start,
  md.period_end,
  md.reconciliation_scope,

  -- Opening
  oc.opening_config_valid,
  oc.opening_balance,
  oc.opening_balance_date,

  -- Period movement
  pfc.period_movement_sum as period_movement_sum_calculated,

  -- Closing
  cc.closing_config_valid,
  cc.calculated_balance as closing_balance_calculated,
  md.observed_balance as closing_balance_observed,
  md.observed_at as closing_observed_at,
  md.snapshot_source_method,
  md.snapshot_source_detail,
  CASE WHEN cc.calculated_balance IS NOT NULL THEN md.observed_balance - cc.calculated_balance ELSE NULL END as account_balance_variance,
  NOT EXISTS (SELECT 1 FROM reconciliation_snapshot rs2 WHERE rs2.supersedes_snapshot_id = md.closing_snapshot_id) as closing_snapshot_is_current,

  -- Period flow
  md.observed_net as period_flow_observed,
  md.flow_observed_at,
  md.flow_source_method,
  md.flow_source_detail,
  CASE WHEN md.observed_net IS NOT NULL THEN md.observed_net - pfc.period_movement_sum ELSE NULL END as period_flow_discrepancy,
  NOT EXISTS (SELECT 1 FROM period_flow_observation pfo2 WHERE pfo2.supersedes_observation_id = md.period_flow_observation_id) as period_flow_observation_is_current,

  -- Coverage
  pcs.period_coverage,
  pcs.report_coverage,
  pcs.liberaciones_coverage,
  pcs.combined_coverage,
  pcs.combined_checkpoint_id,
  bcc.balance_chain_coverage,
  bcc.required_months,
  bcc.complete_months,
  bcc.missing_or_incomplete_months,

  -- Reconciliation decision
  md.status,
  md.variance_approval_note,
  md.approved_by,
  md.approved_at,
  md.created_at,
  md.updated_at
FROM monthly_data md
LEFT JOIN opening_calc oc ON oc.account_id = md.account_id AND oc.period_start = md.period_start
LEFT JOIN closing_calc cc ON cc.account_id = md.account_id AND cc.period_end = md.period_end
LEFT JOIN period_flow_calc pfc ON pfc.account_id = md.account_id AND pfc.period_start = md.period_start AND pfc.period_end = md.period_end
LEFT JOIN v_period_coverage_status pcs ON pcs.account_id = md.account_id AND pcs.period_start = md.period_start AND pcs.period_end = md.period_end
LEFT JOIN v_balance_chain_coverage bcc ON bcc.account_id = md.account_id AND bcc.period_start = md.period_start AND bcc.period_end = md.period_end;

COMMIT;
