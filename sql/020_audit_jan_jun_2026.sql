-- FASE 1: SIMPLE MONTHLY INVENTORY (JAN-JUN 2026)
-- File: 020_audit_jan_jun_2026.sql
-- Purpose: Raw count of what exists in DB for each month (no classification)
-- Status: READ-ONLY (SELECT + WITH only)

WITH month_series AS (
  SELECT (DATE_TRUNC('month', d))::date AS month_start
  FROM GENERATE_SERIES('2026-01-01'::date, '2026-06-01'::date, '1 month'::interval) d
),

mfm_base AS (
  SELECT
    mfm.id,
    (mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS local_date,
    DATE_TRUNC('month', mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS month_start
  FROM mp_financial_movement mfm
  WHERE mfm.account_id = 1054315166
    AND mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
    AND mfm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
),

mfm_monthly AS (
  SELECT
    month_start,
    COUNT(*) AS mfm_count,
    MIN(local_date) AS mfm_min_date,
    MAX(local_date) AS mfm_max_date
  FROM mfm_base
  GROUP BY month_start
),

ledger_base AS (
  SELECT
    le.id,
    (le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS local_date,
    DATE_TRUNC('month', le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS month_start,
    le.balance_impact
  FROM ledger_entry le
  WHERE le.account_id = 1054315166
    AND le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
    AND le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
),

ledger_monthly AS (
  SELECT
    month_start,
    COUNT(*) AS ledger_count,
    MIN(local_date) AS ledger_min_date,
    MAX(local_date) AS ledger_max_date,
    COALESCE(SUM(balance_impact), 0) AS ledger_sum
  FROM ledger_base
  GROUP BY month_start
),

source_report_base AS (
  SELECT
    msr.id,
    (msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS local_date,
    DATE_TRUNC('month', msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS month_start
  FROM mp_source_record msr
  INNER JOIN mp_movement_source_link mmsl ON msr.id = mmsl.source_record_id
  INNER JOIN mp_financial_movement mfm ON mmsl.financial_movement_id = mfm.id
  WHERE mfm.account_id = 1054315166
    AND msr.source_type = 'report'
    AND msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
    AND msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
),

source_report_monthly AS (
  SELECT
    month_start,
    COUNT(*) AS report_source_records_count,
    MIN(local_date) AS report_min_observed_at,
    MAX(local_date) AS report_max_observed_at
  FROM source_report_base
  GROUP BY month_start
),

needs_review_base AS (
  SELECT
    msr.id,
    DATE_TRUNC('month', msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS month_start
  FROM mp_source_record msr
  WHERE msr.needs_review = true
    AND msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires' >= '2026-01-01'::date
    AND msr.observed_at AT TIME ZONE 'America/Argentina/Buenos_Aires' < '2026-07-01'::date
),

needs_review_monthly AS (
  SELECT
    month_start,
    COUNT(*) AS needs_review_count
  FROM needs_review_base
  GROUP BY month_start
)

SELECT
  TO_CHAR(ms.month_start, 'YYYY-MM') AS month,
  COALESCE(mfm.mfm_count, 0) AS mfm_count,
  mfm.mfm_min_date,
  mfm.mfm_max_date,
  COALESCE(lem.ledger_count, 0) AS ledger_count,
  lem.ledger_min_date,
  lem.ledger_max_date,
  COALESCE(lem.ledger_sum, 0) AS ledger_sum,
  COALESCE(srm.report_source_records_count, 0) AS report_source_records_count,
  srm.report_min_observed_at,
  srm.report_max_observed_at,
  COALESCE(nrm.needs_review_count, 0) AS needs_review_count
FROM month_series ms
LEFT JOIN mfm_monthly mfm ON ms.month_start = mfm.month_start
LEFT JOIN ledger_monthly lem ON ms.month_start = lem.month_start
LEFT JOIN source_report_monthly srm ON ms.month_start = srm.month_start
LEFT JOIN needs_review_monthly nrm ON ms.month_start = nrm.month_start
ORDER BY ms.month_start;
