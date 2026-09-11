-- ============================================================================
-- DIAGNÓSTICO: Qué datos necesita el frontend
-- ============================================================================

-- [1] Ver estructura de datos disponibles
SELECT
  'TABLA' as type,
  'mp_source_record' as name,
  'Raw versionado' as description
UNION ALL
SELECT 'TABLA', 'mp_financial_movement', 'Normalizado + clasificado'
UNION ALL
SELECT 'TABLA', 'mp_movement_source_link', 'Relación many-to-one'
UNION ALL
SELECT 'TABLA', 'ledger_entry', 'Impacto en balance'
UNION ALL
SELECT 'TABLA', 'account_balance', 'Saldo diario calculado'
;

-- [2] Ejemplo de un movimiento completo (JOIN de todas las tablas)
SELECT
  fm.id as movement_id,
  fm.account_id,
  fm.movement_class,
  fm.transaction_amount,
  fm.settlement_amount,
  fm.tax_amount,
  fm.tax_percentage,
  fm.payment_method,
  fm.payment_detail,
  fm.payer_name,
  fm.transaction_date,
  fm.settlement_date,
  le.balance_impact,
  le.category as ledger_category,
  le.occurred_at,
  sr.source_external_id,
  sr.payload_hash,
  COUNT(sr.id) as version_count
FROM mp_financial_movement fm
LEFT JOIN mp_movement_source_link link ON link.financial_movement_id = fm.id
LEFT JOIN mp_source_record sr ON sr.id = link.source_record_id
LEFT JOIN ledger_entry le ON le.financial_movement_id = fm.id
WHERE fm.account_id = 1054315166
GROUP BY fm.id, fm.account_id, fm.movement_class, fm.transaction_amount,
         fm.settlement_amount, fm.tax_amount, fm.tax_percentage,
         fm.payment_method, fm.payment_detail, fm.payer_name,
         fm.transaction_date, fm.settlement_date, le.balance_impact,
         le.category, le.occurred_at, sr.source_external_id, sr.payload_hash
LIMIT 10
;

-- [3] Contar por categoría
SELECT
  fm.movement_class,
  COUNT(*) as count,
  SUM(fm.transaction_amount) as total_transaction,
  SUM(fm.settlement_amount) as total_settlement,
  SUM(fm.tax_amount) as total_tax,
  SUM(le.balance_impact) as total_impact
FROM mp_financial_movement fm
LEFT JOIN ledger_entry le ON le.financial_movement_id = fm.id
WHERE fm.account_id = 1054315166
GROUP BY fm.movement_class
ORDER BY total_impact DESC
;

-- [4] Resumen de rendimientos (yield)
SELECT
  fm.movement_class,
  COUNT(*) as yield_count,
  SUM(fm.settlement_amount) as total_yield,
  AVG(fm.settlement_amount) as avg_yield,
  MIN(fm.transaction_date) as first_yield_date,
  MAX(fm.transaction_date) as last_yield_date
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND fm.movement_class = 'yield'
;

-- [5] Resumen de impuestos
SELECT
  COUNT(*) as tax_transactions,
  SUM(fm.tax_amount) as total_tax_paid,
  AVG(fm.tax_percentage) as avg_tax_percentage,
  MIN(fm.tax_amount) as min_tax,
  MAX(fm.tax_amount) as max_tax
FROM mp_financial_movement fm
WHERE fm.account_id = 1054315166
  AND fm.tax_amount != 0
;

-- [6] Saldo acumulado actual
SELECT
  balance_date,
  opening_balance,
  calculated_balance
FROM account_balance
WHERE account_id = 1054315166
ORDER BY balance_date DESC
LIMIT 1
;
