-- ============================================================================
-- FASE 1: AUDITORÍA UNIFICADA EN ÚNICO RESULT SET
-- Fecha: 2026-09-07
-- Scope: 12 puntos de auditoría, READ-ONLY, resultado único UNION ALL
-- ============================================================================

-- PUNTO 3: Schema REAL de account_balance
SELECT 'PUNTO 3' as audit_point, 'account_balance.columns' as metric, column_name || ' (' || data_type || ')' as value, 'ordinal=' || ordinal_position::text as details
FROM information_schema.columns
WHERE table_name = 'account_balance' AND table_schema = 'public'

UNION ALL

-- PUNTO 4: Tabla accounts existe?
SELECT 'PUNTO 4', 'accounts.table.exists',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='accounts' AND table_schema='public') THEN 'YES' ELSE 'NO' END,
  'check for accounts table'

UNION ALL

-- PUNTO 5a: Balance al 2026-06-30
SELECT 'PUNTO 5a', 'balance.2026-06-30',
  COALESCE(SUM(balance_impact), 0)::text,
  'opening_balance(0) + SUM(balance_impact) until 06-30'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-06-30'

UNION ALL

-- PUNTO 5b: Movement_sum julio (con ART timezone)
SELECT 'PUNTO 5b', 'movement_sum.julio.with_ART_timezone',
  COALESCE(SUM(balance_impact), 0)::text,
  'SUM(balance_impact) only july 01-31 with ART timezone'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'

UNION ALL

-- PUNTO 5b-alt: Movement_sum julio (sin timezone)
SELECT 'PUNTO 5b-alt', 'movement_sum.julio.without_timezone',
  COALESCE(SUM(balance_impact), 0)::text,
  'SUM(balance_impact) using DATE(occurred_at) no TZ - current implementation'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at) BETWEEN '2026-07-01' AND '2026-07-31'

UNION ALL

-- PUNTO 5c: Balance al 2026-07-31 (con ART)
SELECT 'PUNTO 5c', 'balance.2026-07-31.with_ART_timezone',
  COALESCE(SUM(balance_impact), 0)::text,
  'opening_balance(0) + SUM(balance_impact) until 07-31 with ART'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-31'

UNION ALL

-- PUNTO 5d: Movement_sum agosto (con ART timezone)
SELECT 'PUNTO 5d', 'movement_sum.agosto.with_ART_timezone',
  COALESCE(SUM(balance_impact), 0)::text,
  'SUM(balance_impact) only august 01-31 with ART timezone'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- PUNTO 5d-alt: Movement_sum agosto (sin timezone)
SELECT 'PUNTO 5d-alt', 'movement_sum.agosto.without_timezone',
  COALESCE(SUM(balance_impact), 0)::text,
  'SUM(balance_impact) using DATE(occurred_at) no TZ - current implementation'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- PUNTO 5e: Balance al 2026-08-31 (con ART)
SELECT 'PUNTO 5e', 'balance.2026-08-31.with_ART_timezone',
  COALESCE(SUM(balance_impact), 0)::text,
  'opening_balance(0) + SUM(balance_impact) until 08-31 with ART'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31'

UNION ALL

-- PUNTO 6: Validar ecuación Julio
SELECT 'PUNTO 6-julio', 'equation.validation.06_30_plus_july_equals_07_31',
  CASE WHEN ABS((
    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-06-30')
    + (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31')
    - (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-31')
  )) < 0.01 THEN 'VALID ✓' ELSE 'INVALID ✗' END,
  'balance(06-30) + movement_sum(julio) = balance(07-31)'

UNION ALL

-- PUNTO 6: Validar ecuación Agosto
SELECT 'PUNTO 6-agosto', 'equation.validation.07_31_plus_august_equals_08_31',
  CASE WHEN ABS((
    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-31')
    + (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31')
    - (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31')
  )) < 0.01 THEN 'VALID ✓' ELSE 'INVALID ✗' END,
  'balance(07-31) + movement_sum(agosto) = balance(08-31)'

UNION ALL

-- PUNTO 7: Timezone comparison - Julio
SELECT 'PUNTO 7-julio', 'timezone.comparison.are_equal',
  CASE WHEN (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at) BETWEEN '2026-07-01' AND '2026-07-31')
       = (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31')
  THEN 'YES (no timezone impact)' ELSE 'NO (timezone affected results)' END,
  'Julio: DATE(occurred_at) vs DATE(occurred_at AT TIME ZONE ART)'

UNION ALL

-- PUNTO 7: Timezone comparison - Agosto
SELECT 'PUNTO 7-agosto', 'timezone.comparison.are_equal',
  CASE WHEN (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31')
       = (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31')
  THEN 'YES (no timezone impact)' ELSE 'NO (timezone affected results)' END,
  'Agosto: DATE(occurred_at) vs DATE(occurred_at AT TIME ZONE ART)'

UNION ALL

-- PUNTO 8: Movimientos en zona de riesgo medianoche UTC (JULIO)
SELECT 'PUNTO 8-julio', 'midnight_risk.count_UTC_vs_ART_differ',
  COUNT(*)::text,
  'movimientos julio donde DATE(UTC) != DATE(ART)'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'

UNION ALL

-- PUNTO 8: Impacto monetario de movimientos de medianoche (JULIO)
SELECT 'PUNTO 8-julio-impact', 'midnight_risk.total_balance_impact',
  COALESCE(SUM(balance_impact), 0)::text,
  'suma balance_impact de movimientos medianoche julio'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'

UNION ALL

-- PUNTO 8: Movimientos en zona de riesgo medianoche UTC (AGOSTO)
SELECT 'PUNTO 8-agosto', 'midnight_risk.count_UTC_vs_ART_differ',
  COUNT(*)::text,
  'movimientos agosto donde DATE(UTC) != DATE(ART)'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- PUNTO 8: Impacto monetario de movimientos de medianoche (AGOSTO)
SELECT 'PUNTO 8-agosto-impact', 'midnight_risk.total_balance_impact',
  COALESCE(SUM(balance_impact), 0)::text,
  'suma balance_impact de movimientos medianoche agosto'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- PUNTO 10: Semántica de -124,203.27
SELECT 'PUNTO 10', 'semantics.m124203_27_hypothesis',
  CASE
    WHEN ABS((SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31') - (-124203.27)) < 0.05
    THEN 'ES NETO DE PERÍODO AGOSTO'
    WHEN ABS((SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31') - (-124203.27)) < 0.05
    THEN 'ES SALDO ACUMULADO AL 2026-08-31'
    ELSE 'NO COINCIDE CON NINGUNA HIPÓTESIS'
  END,
  'determinar si -124203.27 es neto o acumulado'

UNION ALL

-- PUNTO 10 details: movement_sum agosto
SELECT 'PUNTO 10-detail', 'semantics.movement_sum_agosto_calculated',
  COALESCE(SUM(balance_impact), 0)::text,
  'actual movement_sum agosto'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- PUNTO 10 details: cumulative balance to 08-31
SELECT 'PUNTO 10-detail', 'semantics.cumulative_balance_to_08_31',
  COALESCE(SUM(balance_impact), 0)::text,
  'actual balance acumulado 2026-08-31'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31'

UNION ALL

-- PUNTO 11: Conteo total ledger_entry julio
SELECT 'PUNTO 11-julio', 'ledger_entry.count',
  COUNT(*)::text,
  'total ledger entries julio'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'

UNION ALL

-- PUNTO 11: Conteo total ledger_entry agosto
SELECT 'PUNTO 11-agosto', 'ledger_entry.count',
  COUNT(*)::text,
  'total ledger entries agosto'
FROM ledger_entry
WHERE account_id = 1054315166 AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'

UNION ALL

-- PUNTO 11: Min date
SELECT 'PUNTO 11-dates', 'ledger_entry.date_range.min_occurred_at',
  COALESCE(MIN(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::text, 'NULL'),
  'earliest movement in ledger'
FROM ledger_entry
WHERE account_id = 1054315166

UNION ALL

-- PUNTO 11: Max date
SELECT 'PUNTO 11-dates', 'ledger_entry.date_range.max_occurred_at',
  COALESCE(MAX(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::text, 'NULL'),
  'latest movement in ledger'
FROM ledger_entry
WHERE account_id = 1054315166

UNION ALL

-- BONUS: account_balance observations
SELECT 'BONUS', 'account_balance.observed_balance_mp.count_not_null',
  COUNT(*)::text,
  'existing reconciliation observations'
FROM account_balance
WHERE account_id = 1054315166 AND observed_balance_mp IS NOT NULL

UNION ALL

-- BONUS: account_balance variance records
SELECT 'BONUS', 'account_balance.variance.count_not_null',
  COUNT(*)::text,
  'existing variance records'
FROM account_balance
WHERE account_id = 1054315166 AND variance IS NOT NULL

UNION ALL

-- BONUS: opening_balance value
SELECT 'BONUS', 'account_balance.opening_balance.value',
  COALESCE((SELECT opening_balance::text FROM account_balance WHERE account_id = 1054315166 AND opening_balance IS NOT NULL LIMIT 1), 'NOT SET'),
  'configured opening balance'

UNION ALL

-- BONUS: opening_balance date
SELECT 'BONUS', 'account_balance.opening_balance.date',
  COALESCE((SELECT opening_balance_date::text FROM account_balance WHERE account_id = 1054315166 AND opening_balance_date IS NOT NULL LIMIT 1), 'NOT SET'),
  'configured opening balance date'

UNION ALL

-- PUNTO 12: Tabla reconciliation_snapshot
SELECT 'PUNTO 12', 'table.reconciliation_snapshot.exists',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='reconciliation_snapshot' AND table_schema='public') THEN 'YES' ELSE 'NO' END,
  'phase 1 table check'

UNION ALL

-- PUNTO 12: Tabla monthly_reconciliation
SELECT 'PUNTO 12', 'table.monthly_reconciliation.exists',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='monthly_reconciliation' AND table_schema='public') THEN 'YES' ELSE 'NO' END,
  'phase 1 table check'

UNION ALL

-- PUNTO 12: Tabla import_period_coverage
SELECT 'PUNTO 12', 'table.import_period_coverage.exists',
  CASE WHEN EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='import_period_coverage' AND table_schema='public') THEN 'YES' ELSE 'NO' END,
  'phase 1 table check'

ORDER BY audit_point, metric;