-- FASE 1 FUNCIONAL: SEED COVERAGE JULIO/AGOSTO 2026
-- File: 015_seed_coverage_julio_agosto_2026.sql
-- Status: READ + WRITE (INSERT only, idempotent via WHERE NOT EXISTS)
-- Purpose: Load evidence of coverage for July and August 2026
-- Data source: FASE 0 validated ledger and source analysis
-- Account: 1054315166
-- Idempotence: WHERE NOT EXISTS prevents duplicate logical entries (account_id, period_start, period_end, source_type)
-- Conflict protection: RAISE EXCEPTION if evidence mismatch detected

BEGIN;

-- ============================================================
-- PRE-CHECK: DETECT CONFLICTING EVIDENCE
-- ============================================================

DO $$
DECLARE
  v_conflict_count INTEGER;
BEGIN
  -- Check for existing evidence that conflicts with our intended load
  SELECT COUNT(*) INTO v_conflict_count
  FROM import_period_coverage
  WHERE account_id = 1054315166
    AND (
      (period_start = '2026-07-01'::DATE AND period_end = '2026-07-31'::DATE AND source_type = 'report' AND coverage != 'complete') OR
      (period_start = '2026-07-01'::DATE AND period_end = '2026-07-31'::DATE AND source_type = 'liberaciones' AND coverage != 'partial') OR
      (period_start = '2026-07-01'::DATE AND period_end = '2026-07-31'::DATE AND source_type = 'combined' AND coverage != 'complete') OR
      (period_start = '2026-08-01'::DATE AND period_end = '2026-08-31'::DATE AND source_type = 'report' AND coverage != 'complete') OR
      (period_start = '2026-08-01'::DATE AND period_end = '2026-08-31'::DATE AND source_type = 'liberaciones' AND coverage != 'complete') OR
      (period_start = '2026-08-01'::DATE AND period_end = '2026-08-31'::DATE AND source_type = 'combined' AND coverage != 'complete')
    );

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION 'CONFLICT DETECTED: Existing evidence with different coverage status. Aborting load.';
  END IF;
END $$;

-- ============================================================
-- JULIO 2026: REPORT EVIDENCE
-- ============================================================
INSERT INTO import_period_coverage (
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
  validated_by,
  validated_at,
  created_at
)
SELECT
  1054315166,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'report',
  583,
  583,
  583,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'complete',
  'Report covers Jul 1-31: 583 movements (572 shared with Liberaciones, 11 report-only from Jul 1-3)',
  'fase1_manual_validation_2026',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM import_period_coverage
  WHERE account_id = 1054315166
    AND period_start = '2026-07-01'::DATE
    AND period_end = '2026-07-31'::DATE
    AND source_type = 'report'
);

-- ============================================================
-- JULIO 2026: LIBERACIONES EVIDENCE
-- ============================================================
INSERT INTO import_period_coverage (
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
  validated_by,
  validated_at,
  created_at
)
SELECT
  1054315166,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'liberaciones',
  640,
  588,
  588,
  '2026-07-04'::DATE,
  '2026-07-31'::DATE,
  'partial',
  'Liberaciones partial Jul 4-31: 588 movements, 16 definitive payouts (52 raw-only records); pre-checkpoint opening excluded; does not cover Jul 1-3',
  'fase1_manual_validation_2026',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM import_period_coverage
  WHERE account_id = 1054315166
    AND period_start = '2026-07-01'::DATE
    AND period_end = '2026-07-31'::DATE
    AND source_type = 'liberaciones'
);

-- ============================================================
-- JULIO 2026: COMBINED EVIDENCE (AUTHORITATIVE)
-- ============================================================
INSERT INTO import_period_coverage (
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
  validated_by,
  validated_at,
  created_at
)
SELECT
  1054315166,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'combined',
  NULL,
  NULL,
  NULL,
  '2026-07-01'::DATE,
  '2026-07-31'::DATE,
  'complete',
  'Combined authoritative evidence: Report covers Jul 1-31, Liberaciones adds 16 definitive payouts; 572 exact matches, 11 report-only, 16 payout-only; ledger sum validates to -4758185.73',
  'fase1_manual_validation_2026',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM import_period_coverage
  WHERE account_id = 1054315166
    AND period_start = '2026-07-01'::DATE
    AND period_end = '2026-07-31'::DATE
    AND source_type = 'combined'
);

-- ============================================================
-- AGOSTO 2026: REPORT EVIDENCE
-- ============================================================
INSERT INTO import_period_coverage (
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
  validated_by,
  validated_at,
  created_at
)
SELECT
  1054315166,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'report',
  716,
  716,
  716,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'complete',
  'Report covers Aug 1-31: 716 movements (716 exact matches with Liberaciones)',
  'fase1_manual_validation_2026',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM import_period_coverage
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE
    AND period_end = '2026-08-31'::DATE
    AND source_type = 'report'
);

-- ============================================================
-- AGOSTO 2026: LIBERACIONES EVIDENCE
-- ============================================================
INSERT INTO import_period_coverage (
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
  validated_by,
  validated_at,
  created_at
)
SELECT
  1054315166,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'liberaciones',
  798,
  726,
  726,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'complete',
  'Liberaciones complete Aug 1-31: 726 movements (10 definitive payouts; 72 raw-only records)',
  'fase1_manual_validation_2026',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM import_period_coverage
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE
    AND period_end = '2026-08-31'::DATE
    AND source_type = 'liberaciones'
);

-- ============================================================
-- AGOSTO 2026: COMBINED EVIDENCE (AUTHORITATIVE)
-- ============================================================
INSERT INTO import_period_coverage (
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
  validated_by,
  validated_at,
  created_at
)
SELECT
  1054315166,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'combined',
  NULL,
  NULL,
  NULL,
  '2026-08-01'::DATE,
  '2026-08-31'::DATE,
  'complete',
  'Combined authoritative evidence: 716 exact matches plus 10 definitive payouts from Liberaciones; ledger sum validates to -124203.24',
  'fase1_manual_validation_2026',
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM import_period_coverage
  WHERE account_id = 1054315166
    AND period_start = '2026-08-01'::DATE
    AND period_end = '2026-08-31'::DATE
    AND source_type = 'combined'
);

COMMIT;

-- ============================================================
-- READ-ONLY: VALIDATION RESULTS
-- ============================================================

-- Show all inserted coverage evidence
SELECT
  account_id,
  period_start,
  period_end,
  source_type,
  coverage,
  source_records_count,
  financial_movements_count,
  ledger_entries_count,
  validated_by,
  validated_at
FROM import_period_coverage
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE
ORDER BY period_start, source_type;

-- Show authoritative coverage status via view
SELECT
  account_id,
  period_start,
  period_end,
  report_coverage,
  liberaciones_coverage,
  combined_coverage,
  period_coverage,
  report_evidence_id,
  liberaciones_evidence_id,
  combined_evidence_id,
  combined_checkpoint_id
FROM v_period_coverage_status
WHERE account_id = 1054315166
  AND period_start >= '2026-07-01'::DATE
ORDER BY period_start;

-- Verify ledger sums still intact
SELECT
  'Ledger Sum Verification' as check_type,
  'julio_2026' as period,
  CAST(SUM(balance_impact) AS NUMERIC(15,2)) as total
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01'::DATE AND '2026-07-31'::DATE

UNION ALL

SELECT
  'Ledger Sum Verification',
  'agosto_2026',
  CAST(SUM(balance_impact) AS NUMERIC(15,2))
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01'::DATE AND '2026-08-31'::DATE;
