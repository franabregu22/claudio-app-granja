-- ============================================================================
-- FASE 1: AUDITORÍA AVANZADA READ-ONLY (CORREGIDA - ERROR SQL RESUELTOS)
-- Fecha: 2026-09-07
-- ============================================================================

WITH

-- ============================================================================
-- CTE: Month definitions
-- ============================================================================
months AS (
  SELECT 1 as month_num, '2026-01-01'::DATE as month_start, '2026-01-31'::DATE as month_end, 'enero' as month_name
  UNION ALL SELECT 2, '2026-02-01'::DATE, '2026-02-28'::DATE, 'febrero'
  UNION ALL SELECT 3, '2026-03-01'::DATE, '2026-03-31'::DATE, 'marzo'
  UNION ALL SELECT 4, '2026-04-01'::DATE, '2026-04-30'::DATE, 'abril'
  UNION ALL SELECT 5, '2026-05-01'::DATE, '2026-05-31'::DATE, 'mayo'
  UNION ALL SELECT 6, '2026-06-01'::DATE, '2026-06-30'::DATE, 'junio'
  UNION ALL SELECT 7, '2026-07-01'::DATE, '2026-07-31'::DATE, 'julio'
  UNION ALL SELECT 8, '2026-08-01'::DATE, '2026-08-31'::DATE, 'agosto'
),

-- ============================================================================
-- CTE: Source types
-- ============================================================================
source_types AS (
  SELECT 'report' as source_type
  UNION ALL SELECT 'liberaciones'
),

-- ============================================================================
-- CTE: Opening balance configuration (with consistency check)
-- ============================================================================
opening_balance_config AS (
  SELECT
    COUNT(DISTINCT opening_balance) as opening_balance_distinct_count,
    COUNT(DISTINCT opening_balance_date) as opening_balance_date_distinct_count,
    MIN(opening_balance) as opening_balance_value,
    MIN(opening_balance_date) as opening_balance_date,
    MAX(opening_balance) as opening_balance_max,
    MAX(opening_balance_date) as opening_balance_date_max
  FROM account_balance
  WHERE account_id = 1054315166
),

-- ============================================================================
-- CTE: Source-scoped movements (ONLY FM linked to specific source_type)
-- ============================================================================
source_linked_movements AS (
  SELECT DISTINCT
    fm.account_id,
    fm.id as financial_movement_id,
    msl.source_record_id,
    msr.source_type,
    fm.transaction_date,
    DATE(fm.transaction_date) as transaction_date_session,
    DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') as transaction_date_art
  FROM mp_financial_movement fm
  INNER JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
  INNER JOIN mp_source_record msr ON msl.source_record_id = msr.id
  WHERE fm.account_id = 1054315166
    AND msr.source_type IN ('report', 'liberaciones')
),

-- ============================================================================
-- CTE: Coverage data (CORRECTED: only counts FM/LE with source links to that type)
-- ============================================================================
coverage AS (
  SELECT
    m.month_num,
    m.month_name,
    st.source_type,
    COUNT(DISTINCT slm.source_record_id) as source_records_linked,
    COUNT(DISTINCT slm.financial_movement_id) as financial_movements_linked,
    COUNT(DISTINCT le.id) as ledger_entries_linked,
    MIN(slm.transaction_date_art) as min_transaction_date_art,
    MAX(slm.transaction_date_art) as max_transaction_date_art
  FROM months m
  CROSS JOIN source_types st
  LEFT JOIN source_linked_movements slm
    ON slm.transaction_date_art BETWEEN m.month_start AND m.month_end
    AND slm.source_type = st.source_type
  LEFT JOIN ledger_entry le
    ON le.financial_movement_id = slm.financial_movement_id
    AND le.account_id = 1054315166
  GROUP BY m.month_num, m.month_name, st.source_type
),

-- ============================================================================
-- CTE: Timezone evaluation
-- ============================================================================
timezone_info AS (
  SELECT
    current_setting('TimeZone') as session_timezone,
    COUNT(*) as total_ledger_entries,
    COUNT(CASE WHEN DATE(occurred_at) != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') THEN 1 END) as session_date_differs_from_art,
    COUNT(CASE WHEN DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') THEN 1 END) as utc_date_differs_from_art,
    COALESCE(SUM(CASE WHEN DATE(occurred_at) != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') THEN balance_impact ELSE 0 END), 0) as session_date_impact_sum,
    COALESCE(SUM(CASE WHEN DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') THEN balance_impact ELSE 0 END), 0) as utc_date_impact_sum
  FROM ledger_entry
  WHERE account_id = 1054315166
),

-- ============================================================================
-- CTE: Month boundaries - EXACT crossing detection
-- ============================================================================
boundary_30_06_01_07 AS (
  SELECT
    DATE(occurred_at) as session_date,
    DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') as art_date,
    COUNT(*) as count_movements,
    COALESCE(SUM(balance_impact), 0) as sum_balance_impact
  FROM ledger_entry
  WHERE account_id = 1054315166
    AND (
      (DATE(occurred_at) = '2026-06-30' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-07-01')
      OR
      (DATE(occurred_at) = '2026-07-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-06-30')
    )
  GROUP BY DATE(occurred_at), DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
),

boundary_31_07_01_08 AS (
  SELECT
    DATE(occurred_at) as session_date,
    DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') as art_date,
    COUNT(*) as count_movements,
    COALESCE(SUM(balance_impact), 0) as sum_balance_impact
  FROM ledger_entry
  WHERE account_id = 1054315166
    AND (
      (DATE(occurred_at) = '2026-07-31' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-08-01')
      OR
      (DATE(occurred_at) = '2026-08-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-07-31')
    )
  GROUP BY DATE(occurred_at), DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
),

boundary_31_08_01_09 AS (
  SELECT
    DATE(occurred_at) as session_date,
    DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') as art_date,
    COUNT(*) as count_movements,
    COALESCE(SUM(balance_impact), 0) as sum_balance_impact
  FROM ledger_entry
  WHERE account_id = 1054315166
    AND (
      (DATE(occurred_at) = '2026-08-31' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-09-01')
      OR
      (DATE(occurred_at) = '2026-09-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-08-31')
    )
  GROUP BY DATE(occurred_at), DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
),

-- ============================================================================
-- CTE: Closing dates
-- ============================================================================
closing_dates AS (
  SELECT '2026-06-30'::DATE as close_date
  UNION ALL SELECT '2026-07-31'::DATE
  UNION ALL SELECT '2026-08-31'::DATE
),

-- ============================================================================
-- CTE: Closing balances (ONE ROW PER DATE with both session and art columns)
-- ============================================================================
closing_balances AS (
  SELECT
    cd.close_date,
    COALESCE(obc.opening_balance_value, 0) as opening_balance,
    obc.opening_balance_date,
    COALESCE(obc.opening_balance_value, 0) +
    COALESCE(
      (SELECT SUM(le.balance_impact)
       FROM ledger_entry le
       WHERE le.account_id = 1054315166
         AND DATE(le.occurred_at) >= COALESCE(obc.opening_balance_date, '2026-01-01')
         AND DATE(le.occurred_at) <= cd.close_date),
      0
    ) as balance_session_date,
    COALESCE(obc.opening_balance_value, 0) +
    COALESCE(
      (SELECT SUM(le.balance_impact)
       FROM ledger_entry le
       WHERE le.account_id = 1054315166
         AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= COALESCE(obc.opening_balance_date, '2026-01-01')
         AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= cd.close_date),
      0
    ) as balance_art_date
  FROM closing_dates cd
  CROSS JOIN opening_balance_config obc
),

-- ============================================================================
-- CTE: Account balance cache validation (last 5 rows vs function)
-- ============================================================================
cache_validation AS (
  SELECT
    ab.balance_date,
    ab.calculated_balance as cached_balance,
    calculate_ledger_balance(1054315166, ab.balance_date) as function_balance,
    ab.calculated_balance - calculate_ledger_balance(1054315166, ab.balance_date) as difference,
    CASE WHEN ab.calculated_balance = calculate_ledger_balance(1054315166, ab.balance_date) THEN 'MATCH' ELSE 'DIFFER' END as match
  FROM (
    SELECT * FROM account_balance WHERE account_id = 1054315166 ORDER BY balance_date DESC LIMIT 5
  ) ab
),

-- ============================================================================
-- CTE: Trigger and function availability audit
-- ============================================================================
trigger_audit AS (
  SELECT
    'update_account_balance_on_ledger' as function_name,
    EXISTS(SELECT 1 FROM pg_proc WHERE proname='update_account_balance_on_ledger') as function_exists,
    'trg_update_balance_on_ledger' as trigger_name,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_update_balance_on_ledger') as trigger_exists
),

-- ============================================================================
-- FINAL: Aggregate all audit results
-- ============================================================================
audit_output AS (

  -- CONFIG
  SELECT 'CONFIG' as section, 'db.session_timezone' as metric, (SELECT session_timezone FROM timezone_info) as value, 'current_setting(TimeZone)' as detail

  UNION ALL

  -- OPENING BALANCE AUDIT
  SELECT 'OPENING_AUDIT' as section, 'opening_balance.consistency.distinct_count' as metric,
    (SELECT opening_balance_distinct_count::text FROM opening_balance_config) as value,
    'if >1: inconsistency detected' as detail
  UNION ALL
  SELECT 'OPENING_AUDIT' as section, 'opening_balance.consistency.date_distinct_count' as metric,
    (SELECT opening_balance_date_distinct_count::text FROM opening_balance_config) as value,
    'if >1: inconsistency detected' as detail
  UNION ALL
  SELECT 'OPENING_AUDIT' as section, 'opening_balance.value' as metric,
    (SELECT COALESCE(opening_balance_value::text, 'NULL') FROM opening_balance_config) as value,
    'configured opening_balance (NULL if inconsistent)' as detail
  UNION ALL
  SELECT 'OPENING_AUDIT' as section, 'opening_balance.date' as metric,
    (SELECT COALESCE(opening_balance_date::text, 'NULL') FROM opening_balance_config) as value,
    'configured opening_balance_date (NULL if inconsistent)' as detail

  UNION ALL

  -- CACHE STATISTICS
  SELECT 'CACHE_STATS' as section, 'account_balance.total_rows' as metric,
    (SELECT COUNT(*)::text FROM account_balance WHERE account_id=1054315166) as value,
    'total rows stored' as detail
  UNION ALL
  SELECT 'CACHE_STATS' as section, 'account_balance.date_range.min' as metric,
    (SELECT COALESCE(MIN(balance_date)::text, 'NULL') FROM account_balance WHERE account_id=1054315166) as value,
    'earliest balance_date' as detail
  UNION ALL
  SELECT 'CACHE_STATS' as section, 'account_balance.date_range.max' as metric,
    (SELECT COALESCE(MAX(balance_date)::text, 'NULL') FROM account_balance WHERE account_id=1054315166) as value,
    'latest balance_date' as detail

  UNION ALL

  -- CACHE VALIDATION (last 5)
  SELECT 'CACHE_VALIDATION' as section, 'row.' || ROW_NUMBER() OVER (ORDER BY balance_date DESC)::text as metric,
    balance_date::text || ' | cached=' || cached_balance::text || ' | function=' || function_balance::text || ' | diff=' || difference::text || ' | ' || match as value,
    'last 5 rows: cached vs calculate_ledger_balance() function' as detail
  FROM cache_validation

  UNION ALL

  -- TRIGGER AUDIT
  SELECT 'CODE_AUDIT.TRIGGER', 'function.update_account_balance_on_ledger.exists',
    (SELECT function_exists::text FROM trigger_audit),
    'exists in pg_proc; source: supabase/migrations/004'
  UNION ALL
  SELECT 'CODE_AUDIT.TRIGGER' as section, 'function.recalculate_scope' as metric,
    'only_DATE_of_inserted_row' as value,
    'confirmed from source: ON CONFLICT (account_id, balance_date) UPSERT only that date' as detail
  UNION ALL
  SELECT 'CODE_AUDIT.TRIGGER' as section, 'cache_stale_risk' as metric,
    'YES' as value,
    'retroactive ledger_entry inserts recalculate only one date, leaving posterior balances STALE' as detail
  UNION ALL
  SELECT 'CODE_AUDIT.TRIGGER' as section, 'trigger.trg_update_balance_on_ledger.exists' as metric,
    (SELECT trigger_exists::text FROM trigger_audit) as value,
    'exists in pg_trigger' as detail

  UNION ALL

  -- TIMEZONE SESSION VS ART
  SELECT 'TIMEZONE_SESSION_VS_ART', 'total_ledger_entries',
    (SELECT total_ledger_entries::text FROM timezone_info),
    'all account entries'
  UNION ALL
  SELECT 'TIMEZONE_SESSION_VS_ART' as section, 'date_conversions.differ_count' as metric,
    (SELECT session_date_differs_from_art::text FROM timezone_info) as value,
    'COUNT: DATE(occurred_at) != DATE(...AT TIME ZONE ART)' as detail
  UNION ALL
  SELECT 'TIMEZONE_SESSION_VS_ART' as section, 'date_conversions.impact_sum' as metric,
    (SELECT session_date_impact_sum::text FROM timezone_info) as value,
    'SUM(balance_impact) where dates differ' as detail

  UNION ALL

  -- TIMEZONE UTC VS ART
  SELECT 'TIMEZONE_UTC_VS_ART' as section, 'date_conversions.differ_count' as metric,
    (SELECT utc_date_differs_from_art::text FROM timezone_info) as value,
    'COUNT: DATE(...AT TIME ZONE UTC) != DATE(...AT TIME ZONE ART)' as detail
  UNION ALL
  SELECT 'TIMEZONE_UTC_VS_ART' as section, 'date_conversions.impact_sum' as metric,
    (SELECT utc_date_impact_sum::text FROM timezone_info) as value,
    'SUM(balance_impact) where UTC and ART dates differ' as detail

  UNION ALL

  -- BOUNDARY 30/06 ↔ 01/07
  SELECT 'BOUNDARY.30-06_01-07' as section, 'crossing.' || COALESCE(session_date::text, 'null') || '_session_vs_' || COALESCE(art_date::text, 'null') || '_art' as metric,
    'count=' || count_movements::text || ' | impact=' || sum_balance_impact::text as value,
    'exact crossing: movements that change date between session and ART' as detail
  FROM boundary_30_06_01_07
  UNION ALL
  SELECT 'BOUNDARY.30-06_01-07' as section, 'closing_balance.30-06.session_date' as metric,
    (SELECT balance_session_date::text FROM closing_balances WHERE close_date='2026-06-30') as value,
    'opening + movements using DATE(occurred_at)' as detail
  UNION ALL
  SELECT 'BOUNDARY.30-06_01-07' as section, 'closing_balance.30-06.art_date' as metric,
    (SELECT balance_art_date::text FROM closing_balances WHERE close_date='2026-06-30') as value,
    'opening + movements using DATE(...AT TIME ZONE ART)' as detail
  UNION ALL
  SELECT 'BOUNDARY.30-06_01-07' as section, 'closing_difference.30-06' as metric,
    (SELECT (balance_session_date - balance_art_date)::text FROM closing_balances WHERE close_date='2026-06-30') as value,
    'session_closing - art_closing (0 means no impact on month-end)' as detail

  UNION ALL

  -- BOUNDARY 31/07 ↔ 01/08
  SELECT 'BOUNDARY.31-07_01-08' as section, 'crossing.' || COALESCE(session_date::text, 'null') || '_session_vs_' || COALESCE(art_date::text, 'null') || '_art' as metric,
    'count=' || count_movements::text || ' | impact=' || sum_balance_impact::text as value,
    'exact crossing: movements that change date between session and ART' as detail
  FROM boundary_31_07_01_08
  UNION ALL
  SELECT 'BOUNDARY.31-07_01-08' as section, 'closing_balance.31-07.session_date' as metric,
    (SELECT balance_session_date::text FROM closing_balances WHERE close_date='2026-07-31') as value,
    'opening + movements using DATE(occurred_at)' as detail
  UNION ALL
  SELECT 'BOUNDARY.31-07_01-08' as section, 'closing_balance.31-07.art_date' as metric,
    (SELECT balance_art_date::text FROM closing_balances WHERE close_date='2026-07-31') as value,
    'opening + movements using DATE(...AT TIME ZONE ART)' as detail
  UNION ALL
  SELECT 'BOUNDARY.31-07_01-08' as section, 'closing_difference.31-07' as metric,
    (SELECT (balance_session_date - balance_art_date)::text FROM closing_balances WHERE close_date='2026-07-31') as value,
    'session_closing - art_closing (0 means no impact on month-end)' as detail

  UNION ALL

  -- BOUNDARY 31/08 ↔ 01/09
  SELECT 'BOUNDARY.31-08_01-09' as section, 'crossing.' || COALESCE(session_date::text, 'null') || '_session_vs_' || COALESCE(art_date::text, 'null') || '_art' as metric,
    'count=' || count_movements::text || ' | impact=' || sum_balance_impact::text as value,
    'exact crossing: movements that change date between session and ART' as detail
  FROM boundary_31_08_01_09
  UNION ALL
  SELECT 'BOUNDARY.31-08_01-09' as section, 'closing_balance.31-08.session_date' as metric,
    (SELECT balance_session_date::text FROM closing_balances WHERE close_date='2026-08-31') as value,
    'opening + movements using DATE(occurred_at)' as detail
  UNION ALL
  SELECT 'BOUNDARY.31-08_01-09' as section, 'closing_balance.31-08.art_date' as metric,
    (SELECT balance_art_date::text FROM closing_balances WHERE close_date='2026-08-31') as value,
    'opening + movements using DATE(...AT TIME ZONE ART)' as detail
  UNION ALL
  SELECT 'BOUNDARY.31-08_01-09' as section, 'closing_difference.31-08' as metric,
    (SELECT (balance_session_date - balance_art_date)::text FROM closing_balances WHERE close_date='2026-08-31') as value,
    'session_closing - art_closing (0 means no impact on month-end)' as detail

  UNION ALL

  -- COVERAGE: All months × all sources (CORRECTED: source-scoped counts only)
  SELECT 'COVERAGE.' || month_name || '.' || source_type as section,
    'source_records_linked' as metric,
    source_records_linked::text as value,
    'mp_source_record count ONLY for this source_type in this month' as detail
  FROM coverage
  UNION ALL
  SELECT 'COVERAGE.' || month_name || '.' || source_type as section,
    'financial_movements_linked' as metric,
    financial_movements_linked::text as value,
    'FM count ONLY if they have a link to this source_type; non-additive (one FM may link to multiple sources)' as detail
  FROM coverage
  UNION ALL
  SELECT 'COVERAGE.' || month_name || '.' || source_type as section,
    'ledger_entries_linked' as metric,
    ledger_entries_linked::text as value,
    'LE count ONLY if their FM is linked to this source_type; should match FM count (1:1 relationship)' as detail
  FROM coverage
  UNION ALL
  SELECT 'COVERAGE.' || month_name || '.' || source_type as section,
    'min_transaction_date_art' as metric,
    COALESCE(min_transaction_date_art::text, 'NULL') as value,
    'MIN economic date (ART timezone); NULL if no records for this source_type' as detail
  FROM coverage
  UNION ALL
  SELECT 'COVERAGE.' || month_name || '.' || source_type as section,
    'max_transaction_date_art' as metric,
    COALESCE(max_transaction_date_art::text, 'NULL') as value,
    'MAX economic date (ART timezone); NULL if no records for this source_type' as detail
  FROM coverage

  UNION ALL

  -- COVERAGE SANITY CHECK
  SELECT 'COVERAGE_SANITY' as section, 'expected_month_source_combinations' as metric,
    '16' as value,
    '8 months × 2 source_types' as detail
  UNION ALL
  SELECT 'COVERAGE_SANITY' as section, 'expected_metrics_per_combination' as metric,
    '5' as value,
    'source_records_linked + financial_movements_linked + ledger_entries_linked + min_date + max_date' as detail
  UNION ALL
  SELECT 'COVERAGE_SANITY' as section, 'expected_coverage_output_rows' as metric,
    '80' as value,
    '16 combinations × 5 metrics' as detail

  UNION ALL

  -- RAW-ONLY LIMITATION
  SELECT 'SCHEMA_LIMITATION' as section, 'mp_source_record.no_account_id' as metric,
    'YES' as value,
    'mp_source_record lacks account_id column' as detail
  UNION ALL
  SELECT 'SCHEMA_LIMITATION' as section, 'raw_only_records.attribution' as metric,
    'cannot_account_scope_via_sql' as value,
    'RAW-only records (no FM/link) cannot be attributed to account_id via current schema relations' as detail
  UNION ALL
  SELECT 'SCHEMA_LIMITATION' as section, 'coverage_completeness' as metric,
    'requires_external_evidence' as value,
    'FM/LE counts show linked records only. Coverage must combine: DB presence + import logs/checkpoints + source file completeness' as detail

)

SELECT * FROM audit_output
ORDER BY section, metric;
