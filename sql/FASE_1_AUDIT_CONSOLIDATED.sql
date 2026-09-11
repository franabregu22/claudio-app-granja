-- ============================================================================
-- FASE 1: AUDITORÍA CONSOLIDADA READ-ONLY
-- Fecha: 2026-09-07
-- Scope: 14 puntos de auditoría sin modificar datos
-- ============================================================================

-- ============================================================================
-- PUNTO 3: Schema REAL de account_balance
-- ============================================================================
SELECT
  'PUNTO 3: Schema account_balance' as audit_point,
  t.tablename,
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default
FROM pg_tables t
LEFT JOIN information_schema.columns c
  ON t.tablename = c.table_name
  AND t.schemaname = c.table_schema
WHERE t.tablename = 'account_balance'
  AND t.schemaname = 'public'
ORDER BY c.ordinal_position;

-- Índices y constraints de account_balance
SELECT 'PUNTO 3: Índices account_balance' as type, indexname
FROM pg_indexes WHERE tablename = 'account_balance';

SELECT 'PUNTO 3: Constraints account_balance' as type,
  constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'account_balance' AND table_schema = 'public';

-- ============================================================================
-- PUNTO 4: Confirmar tabla accounts
-- ============================================================================
SELECT
  'PUNTO 4: Tabla accounts existe' as result,
  EXISTS(SELECT 1 FROM information_schema.tables
    WHERE table_name='accounts' AND table_schema='public') as exists;

-- Si existe, verificar estructura
SELECT
  'PUNTO 4: Schema accounts' as audit_point,
  c.column_name,
  c.data_type,
  c.is_nullable
FROM information_schema.columns c
WHERE c.table_name = 'accounts' AND c.table_schema = 'public'
ORDER BY c.ordinal_position;

-- ============================================================================
-- PUNTO 5: Calcular balances acumulados (READ-ONLY)
-- ============================================================================

-- 5a) Balance al 2026-06-30
SELECT
  'PUNTO 5a: Balance acumulado al 2026-06-30' as metric,
  COALESCE(SUM(balance_impact), 0) as calculated_value,
  'opening_balance (0) + SUM(balance_impact) where DATE(occurred_at) <= 2026-06-30' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-06-30';

-- 5b) Movement_sum solo julio (DATE explicit con ART)
SELECT
  'PUNTO 5b: movement_sum julio (DATE with ART)' as metric,
  COALESCE(SUM(balance_impact), 0) as movement_sum_julio,
  'SUM(balance_impact) BETWEEN 2026-07-01 AND 2026-07-31 (ART timezone)' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31';

-- 5b-alt) Movement_sum julio con DATE sin timezone (para comparación)
SELECT
  'PUNTO 5b-alt: movement_sum julio (DATE no TZ)' as metric,
  COALESCE(SUM(balance_impact), 0) as movement_sum_julio_no_tz,
  'SUM(balance_impact) BETWEEN 2026-07-01 AND 2026-07-31 (NO timezone)' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at) BETWEEN '2026-07-01' AND '2026-07-31';

-- 5c) Balance al 2026-07-31 (con ART)
SELECT
  'PUNTO 5c: Balance acumulado al 2026-07-31 (ART)' as metric,
  COALESCE(SUM(balance_impact), 0) as calculated_balance_07_31,
  'opening_balance (0) + SUM(balance_impact) where DATE(occurred_at AT TIME ZONE ART) <= 2026-07-31' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-31';

-- 5d) Movement_sum solo agosto (con ART)
SELECT
  'PUNTO 5d: movement_sum agosto (DATE with ART)' as metric,
  COALESCE(SUM(balance_impact), 0) as movement_sum_agosto,
  'SUM(balance_impact) BETWEEN 2026-08-01 AND 2026-08-31 (ART timezone)' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31';

-- 5d-alt) Movement_sum agosto sin timezone (para comparación)
SELECT
  'PUNTO 5d-alt: movement_sum agosto (DATE no TZ)' as metric,
  COALESCE(SUM(balance_impact), 0) as movement_sum_agosto_no_tz,
  'SUM(balance_impact) BETWEEN 2026-08-01 AND 2026-08-31 (NO timezone)' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31';

-- 5e) Balance al 2026-08-31 (con ART)
SELECT
  'PUNTO 5e: Balance acumulado al 2026-08-31 (ART)' as metric,
  COALESCE(SUM(balance_impact), 0) as calculated_balance_08_31,
  'opening_balance (0) + SUM(balance_impact) where DATE(occurred_at AT TIME ZONE ART) <= 2026-08-31' as formula
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31';

-- ============================================================================
-- PUNTO 6: Validar ecuaciones contables
-- ============================================================================
WITH balances AS (
  SELECT
    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
     WHERE account_id = 1054315166
       AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-06-30') as balance_06_30,

    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
     WHERE account_id = 1054315166
       AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31') as movement_sum_julio,

    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
     WHERE account_id = 1054315166
       AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-07-31') as balance_07_31,

    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
     WHERE account_id = 1054315166
       AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31') as movement_sum_agosto,

    (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
     WHERE account_id = 1054315166
       AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31') as balance_08_31
)
SELECT
  'PUNTO 6: Ecuación Julio' as equation,
  balance_06_30 + movement_sum_julio as calc_balance_07_31,
  balance_07_31 as actual_balance_07_31,
  (balance_06_30 + movement_sum_julio = balance_07_31) as equation_valid,
  ABS((balance_06_30 + movement_sum_julio) - balance_07_31) as variance
FROM balances
UNION ALL
SELECT
  'PUNTO 6: Ecuación Agosto' as equation,
  balance_07_31 + movement_sum_agosto as calc_balance_08_31,
  balance_08_31 as actual_balance_08_31,
  (balance_07_31 + movement_sum_agosto = balance_08_31) as equation_valid,
  ABS((balance_07_31 + movement_sum_agosto) - balance_08_31) as variance
FROM balances;

-- ============================================================================
-- PUNTO 7: Comparar cálculos con timezone (actual vs propuesto)
-- ============================================================================
SELECT
  'PUNTO 7: Comparación timezone - Julio' as metric,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at) BETWEEN '2026-07-01' AND '2026-07-31') as movement_sum_no_tz,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31') as movement_sum_with_tz,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at) BETWEEN '2026-07-01' AND '2026-07-31') =
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31') as are_equal
UNION ALL
SELECT
  'PUNTO 7: Comparación timezone - Agosto' as metric,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31') as movement_sum_no_tz,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31') as movement_sum_with_tz,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at) BETWEEN '2026-08-01' AND '2026-08-31') =
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31') as are_equal;

-- ============================================================================
-- PUNTO 8: Auditar zona de riesgo medianoche UTC
-- ============================================================================
SELECT
  'PUNTO 8: Movimientos medianoche UTC (JULIO)' as audit,
  COUNT(*) as count,
  COALESCE(SUM(balance_impact), 0) as total_impact
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'
UNION ALL
SELECT
  'PUNTO 8: Movimientos medianoche UTC (AGOSTO)' as audit,
  COUNT(*) as count,
  COALESCE(SUM(balance_impact), 0) as total_impact
FROM ledger_entry
WHERE account_id = 1054315166
  AND DATE(occurred_at AT TIME ZONE 'UTC') != DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31';

-- Detalles de movimientos en zona de riesgo (si existen)
SELECT
  'PUNTO 8-detail: Movimientos medianoche' as type,
  le.id,
  le.occurred_at,
  DATE(le.occurred_at AT TIME ZONE 'UTC') as date_utc,
  DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') as date_art,
  le.balance_impact,
  le.description
FROM ledger_entry le
WHERE le.account_id = 1054315166
  AND DATE(le.occurred_at AT TIME ZONE 'UTC') != DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
  AND DATE(le.occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-08-31'
LIMIT 100;

-- ============================================================================
-- PUNTO 10: Confirmar semántica de -124,203.27
-- ============================================================================
SELECT
  'PUNTO 10: Semántica -124,203.27' as hypothesis,
  'Es neto de período o saldo acumulado?' as question,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31') as movement_sum_agosto,
  (SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
   WHERE account_id = 1054315166
     AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31') as cumulative_balance_08_31,
  -124203.27 as observed_value,
  CASE
    WHEN ABS((SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
              WHERE account_id = 1054315166
                AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31') - (-124203.27)) < 0.05
    THEN 'ES NETO DE PERÍODO'
    WHEN ABS((SELECT COALESCE(SUM(balance_impact), 0) FROM ledger_entry
              WHERE account_id = 1054315166
                AND DATE(occurred_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= '2026-08-31') - (-124203.27)) < 0.05
    THEN 'ES SALDO ACUMULADO AL 31/08'
    ELSE 'DIFERENCIA NO COINCIDE'
  END as semantic_determination;

-- ============================================================================
-- PUNTO 11: Auditar coverage real julio/agosto
-- ============================================================================
SELECT
  'PUNTO 11: Coverage audit - Source counts Julio' as audit_point,
  fm.account_id,
  source_type,
  COUNT(DISTINCT fm.id) as movement_count,
  COUNT(DISTINCT msl.source_record_id) as source_record_count
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-07-01' AND '2026-07-31'
GROUP BY fm.account_id, source_type
UNION ALL
SELECT
  'PUNTO 11: Coverage audit - Source counts Agosto' as audit_point,
  fm.account_id,
  source_type,
  COUNT(DISTINCT fm.id) as movement_count,
  COUNT(DISTINCT msl.source_record_id) as source_record_count
FROM mp_financial_movement fm
JOIN mp_movement_source_link msl ON fm.id = msl.financial_movement_id
JOIN mp_source_record msr ON msl.source_record_id = msr.id
WHERE fm.account_id = 1054315166
  AND DATE(fm.transaction_date AT TIME ZONE 'America/Argentina/Buenos_Aires') BETWEEN '2026-08-01' AND '2026-08-31'
GROUP BY fm.account_id, source_type;

-- ============================================================================
-- PUNTO 12: Estado de tablas de reconciliación (si existen)
-- ============================================================================
SELECT
  'PUNTO 12: Tablas de reconciliación' as check_point,
  EXISTS(SELECT 1 FROM information_schema.tables
    WHERE table_name='reconciliation_snapshot' AND table_schema='public') as reconciliation_snapshot_exists,
  EXISTS(SELECT 1 FROM information_schema.tables
    WHERE table_name='monthly_reconciliation' AND table_schema='public') as monthly_reconciliation_exists,
  EXISTS(SELECT 1 FROM information_schema.tables
    WHERE table_name='import_period_coverage' AND table_schema='public') as import_period_coverage_exists;

-- ============================================================================
-- FIN AUDITORÍA CONSOLIDADA
-- ============================================================================
