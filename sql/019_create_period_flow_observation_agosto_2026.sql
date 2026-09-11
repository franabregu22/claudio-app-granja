-- FASE 1 FUNCIONAL: CREATE PERIOD_FLOW_OBSERVATION AGOSTO 2026
-- File: 019_create_period_flow_observation_agosto_2026.sql
-- Status: READ + WRITE (INSERT + UPDATE only, no DELETE)
-- Purpose: Record observed period flow from Mercado Pago UI for August 2026
-- Observed value: -124203.27 (from UI)
-- Ledger sum: -124203.24 (from import)
-- Variance: -0.03 (cause unknown — not inference)
-- Account: 1054315166

BEGIN;

-- ============================================================
-- CREATE PERIOD_FLOW_OBSERVATION FOR AGOSTO 2026
-- ============================================================

-- Insert observation (IF not already exists as root)
WITH observation_insert AS (
  INSERT INTO period_flow_observation (
    account_id,
    period_start,
    period_end,
    observed_net,
    observed_at,
    source_method,
    source_detail,
    created_by
  )
  SELECT
    1054315166,
    '2026-08-01'::DATE,
    '2026-08-31'::DATE,
    -124203.27::NUMERIC(15,2),
    NOW(),
    'manual',
    'Mercado Pago UI — monthly period net manually transcribed',
    'fase1_manual_validation_2026'
  WHERE NOT EXISTS (
    SELECT 1 FROM period_flow_observation
    WHERE account_id = 1054315166
      AND period_start = '2026-08-01'::DATE
      AND period_end = '2026-08-31'::DATE
      AND supersedes_observation_id IS NULL
  )
  RETURNING id
)
-- Update monthly_reconciliation to link this observation
UPDATE monthly_reconciliation
SET period_flow_observation_id = (
  SELECT id FROM observation_insert
  UNION ALL
  SELECT id FROM period_flow_observation
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE
    AND period_end = '2026-08-31'::DATE
    AND supersedes_observation_id IS NULL
  LIMIT 1
)
WHERE account_id = 1054315166
  AND period_start = '2026-08-01'::DATE
  AND period_end = '2026-08-31'::DATE
  AND reconciliation_scope = 'period_flow'
  AND period_flow_observation_id IS NULL;

COMMIT;

-- ============================================================
-- READ-ONLY: VALIDATION
-- ============================================================

-- Show observation created
SELECT
  id as observation_id,
  account_id,
  period_start,
  period_end,
  observed_net,
  source_method,
  source_detail,
  created_by,
  created_at
FROM period_flow_observation
WHERE account_id = 1054315166
  AND period_start = '2026-08-01'::DATE
  AND period_end = '2026-08-31'::DATE
  AND supersedes_observation_id IS NULL
ORDER BY created_at DESC
LIMIT 1;

-- Show monthly_reconciliation linked
SELECT
  id as monthly_reconciliation_id,
  account_id,
  period_start,
  period_end,
  reconciliation_scope,
  status,
  period_flow_observation_id,
  closing_snapshot_id
FROM monthly_reconciliation
WHERE account_id = 1054315166
  AND period_start = '2026-08-01'::DATE
  AND period_end = '2026-08-31'::DATE
  AND reconciliation_scope = 'period_flow';

-- Show variance comparison
SELECT
  'Variance Analysis' as analysis_type,
  'agosto_2026' as period,
  -124203.27 as observed_from_ui,
  -124203.24 as ledger_sum,
  -0.03 as variance_amount,
  'cause unknown' as variance_explanation
WHERE EXISTS (
  SELECT 1 FROM period_flow_observation pfo
  WHERE pfo.account_id = 1054315166
    AND pfo.period_start = '2026-08-01'::DATE
    AND pfo.period_end = '2026-08-31'::DATE
);
