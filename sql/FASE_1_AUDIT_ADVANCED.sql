-- ============================================================================
-- FASE 1: AUDITORÍA AVANZADA READ-ONLY
-- Fecha: 2026-09-07
-- Scope: timezone, month boundaries, cache stale risk, coverage detail
-- ============================================================================

-- ============================================================================
-- TIMEZONE DB ACTUAL
-- ============================================================================
SELECT 'CONFIG.1' as section, 'PostgreSQL.timezone' as metric, current_setting('TimeZone') as value, 'actual DB timezone' as detail

UNION ALL

-- ============================================================================
-- BORDES DE MES: 30/06 ↔ 01/07 (frontera junio-julio)
-- ============================================================================
SELECT 'BOUNDARY.30-06_to_01-07', 'count.UTC_vs_ART_differ',
  COUNT(*)::text,
  'movimientos en frontera donde DATE(UTC) != DATE(ART)'
FROM ledger_entry
WHERE account_id = 1054315166
  AND (
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-06-30' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-07-01')
    OR
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-07-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-06-30')
  )

UNION ALL

SELECT 'BOUNDARY.30-06_to_01-07', 'sum.balance_impact_frontera',
  COALESCE(SUM(balance_impact), 0)::text,
  'impacto total de movimientos en frontera'
FROM ledger_entry
WHERE account_id = 1054315166
  AND (
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-06-30' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-07-01')
    OR
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-07-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-06-30')
  )

UNION ALL

SELECT 'BOUNDARY.30-06_to_01-07', 'balance.2026-06-30.with_boundary',
  COALESCE(SUM(balance_impact), 0)::text,
  'balance 30/06 incluidas movimientos de medianoche UTC'
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-06-30'

UNION ALL

SELECT 'BOUNDARY.30-06_to_01-07', 'balance.2026-07-01.starting',
  COALESCE(SUM(balance_impact), 0)::text,
  'balance acumulado hasta 01/07 (incluye movimientos medianoche si UTC=30/06,ART=01/07)'
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-01'

UNION ALL

-- ============================================================================
-- BORDES DE MES: 31/07 ↔ 01/08 (frontera julio-agosto)
-- ============================================================================
SELECT 'BOUNDARY.31-07_to_01-08', 'count.UTC_vs_ART_differ',
  COUNT(*)::text,
  'movimientos en frontera donde DATE(UTC) != DATE(ART)'
FROM ledger_entry
WHERE account_id = 1054315166
  AND (
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-07-31' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-08-01')
    OR
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-08-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-07-31')
  )

UNION ALL

SELECT 'BOUNDARY.31-07_to_01-08', 'sum.balance_impact_frontera',
  COALESCE(SUM(balance_impact), 0)::text,
  'impacto total de movimientos en frontera'
FROM ledger_entry
WHERE account_id = 1054315166
  AND (
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-07-31' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-08-01')
    OR
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-08-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-07-31')
  )

UNION ALL

SELECT 'BOUNDARY.31-07_to_01-08', 'balance.2026-07-31.with_boundary',
  COALESCE(SUM(balance_impact), 0)::text,
  'balance 31/07 incluidas movimientos de medianoche UTC'
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-31'

UNION ALL

SELECT 'BOUNDARY.31-07_to_01-08', 'balance.2026-08-01.starting',
  COALESCE(SUM(balance_impact), 0)::text,
  'balance acumulado hasta 01/08 (incluye movimientos medianoche si UTC=31/07,ART=01/08)'
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-01'

UNION ALL

-- ============================================================================
-- BORDES DE MES: 31/08 ↔ 01/09 (frontera agosto-septiembre)
-- ============================================================================
SELECT 'BOUNDARY.31-08_to_01-09', 'count.UTC_vs_ART_differ',
  COUNT(*)::text,
  'movimientos en frontera donde DATE(UTC) != DATE(ART)'
FROM ledger_entry
WHERE account_id = 1054315166
  AND (
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-08-31' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-09-01')
    OR
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-09-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-08-31')
  )

UNION ALL

SELECT 'BOUNDARY.31-08_to_01-09', 'sum.balance_impact_frontera',
  COALESCE(SUM(balance_impact), 0)::text,
  'impacto total de movimientos en frontera'
FROM ledger_entry
WHERE account_id = 1054315166
  AND (
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-08-31' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-09-01')
    OR
    (DATE(occurred_at AT TIME ZONE 'UTC') = '2026-09-01' AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') = '2026-08-31')
  )

UNION ALL

SELECT 'BOUNDARY.31-08_to_01-09', 'balance.2026-08-31.with_boundary',
  COALESCE(SUM(balance_impact), 0)::text,
  'balance 31/08 incluidas movimientos de medianoche UTC'
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31'

UNION ALL

SELECT 'BOUNDARY.31-08_to_01-09', 'balance.2026-09-01.if_exists',
  COALESCE(SUM(balance_impact), 0)::text,
  'balance acumulado hasta 01/09 (si hay movimientos anteriores)'
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-09-01'

UNION ALL

-- ============================================================================
-- ACCOUNT_BALANCE CACHE: Cantidad y rango
-- ============================================================================
SELECT 'CACHE.account_balance', 'count.total_rows',
  COUNT(*)::text,
  'total rows en account_balance'
FROM account_balance
WHERE account_id = 1054315166

UNION ALL

SELECT 'CACHE.account_balance', 'date_range.min',
  COALESCE(MIN(balance_date)::text, 'NULL'),
  'earliest balance_date in account_balance'
FROM account_balance
WHERE account_id = 1054315166

UNION ALL

SELECT 'CACHE.account_balance', 'date_range.max',
  COALESCE(MAX(balance_date)::text, 'NULL'),
  'latest balance_date in account_balance'
FROM account_balance
WHERE account_id = 1054315166

UNION ALL

-- ============================================================================
-- ACCOUNT_BALANCE CACHE: Verificar stale risk (últimas 5 filas)
-- ============================================================================
SELECT 'CACHE.stale_risk', 'latest_5_rows.date_and_calculated_balance',
  balance_date::text || ' → ' || calculated_balance::text,
  'últimas 5 filas (ordenadas desc)'
FROM account_balance
WHERE account_id = 1054315166
ORDER BY balance_date DESC
LIMIT 5

UNION ALL

-- ============================================================================
-- ACCOUNT_BALANCE CACHE: Comparar últimos 3 valores contra función
-- ============================================================================
SELECT 'CACHE.validation', 'last_row.compare_function_vs_cache',
  'cached=' || ab.calculated_balance::text || ' | function=' ||
  (SELECT calculate_ledger_balance(1054315166, ab.balance_date))::text ||
  ' | match=' || CASE WHEN ab.calculated_balance = (SELECT calculate_ledger_balance(1054315166, ab.balance_date)) THEN 'YES' ELSE 'NO' END,
  'comparar account_balance.calculated_balance vs calculate_ledger_balance(account_id, balance_date)'
FROM (SELECT * FROM account_balance WHERE account_id = 1054315166 ORDER BY balance_date DESC LIMIT 1) ab

UNION ALL

-- ============================================================================
-- COVERAGE ENERO-AGOSTO: Por mes y source_type
-- ============================================================================
SELECT 'COVERAGE.enero', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries enero 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-01-01' AND '2026-01-31'

UNION ALL

SELECT 'COVERAGE.febrero', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries febrero 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01' AND '2026-02-28'

UNION ALL

SELECT 'COVERAGE.marzo', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries marzo 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01' AND '2026-03-31'

UNION ALL

SELECT 'COVERAGE.abril', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries abril 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01' AND '2026-04-30'

UNION ALL

SELECT 'COVERAGE.mayo', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries mayo 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-05-01' AND '2026-05-31'

UNION ALL

SELECT 'COVERAGE.junio', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries junio 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'

UNION ALL

SELECT 'COVERAGE.julio', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries julio 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'

UNION ALL

SELECT 'COVERAGE.agosto', 'movements.count',
  COUNT(DISTINCT fm.id)::text,
  'mp_financial_movement entries agosto 2026'
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- ============================================================================
-- LIBERACIONES PRESENTE: Por mes
-- ============================================================================
SELECT 'LIBERACIONES.enero', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records enero (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-01-01' AND '2026-01-31'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.febrero', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records febrero (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-02-01' AND '2026-02-28'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.marzo', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records marzo (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-03-01' AND '2026-03-31'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.abril', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records abril (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-04-01' AND '2026-04-30'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.mayo', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records mayo (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-05-01' AND '2026-05-31'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.junio', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records junio (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-06-01' AND '2026-06-30'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.julio', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records julio (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'
  AND msr.source_type = 'report'

UNION ALL

SELECT 'LIBERACIONES.agosto', 'count.liberaciones3_records',
  COUNT(DISTINCT fm.id)::text,
  'liberaciones records agosto (movement_class)'
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'
  AND msr.source_type = 'report'

UNION ALL

-- ============================================================================
-- SUMMARY: Ledger entries by source_type julio
-- ============================================================================
SELECT 'SOURCE_SUMMARY.julio', 'source=' || COALESCE(msr.source_type, 'NULL'),
  COUNT(DISTINCT le.id)::text,
  'ledger entries julio by source'
FROM ledger_entry le
LEFT JOIN mp_financial_movement fm ON le.financial_movement_id = fm.id
LEFT JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
LEFT JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE le.account_id = 1054315166
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'
GROUP BY msr.source_type

UNION ALL

-- ============================================================================
-- SUMMARY: Ledger entries by source_type agosto
-- ============================================================================
SELECT 'SOURCE_SUMMARY.agosto', 'source=' || COALESCE(msr.source_type, 'NULL'),
  COUNT(DISTINCT le.id)::text,
  'ledger entries agosto by source'
FROM ledger_entry le
LEFT JOIN mp_financial_movement fm ON le.financial_movement_id = fm.id
LEFT JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
LEFT JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE le.account_id = 1054315166
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'
GROUP BY msr.source_type

ORDER BY section, metric;
