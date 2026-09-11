-- ============================================================================
-- DIAGNÓSTICO: Qué pasó con la importación de 3375 registros
-- ============================================================================

-- [1] Contar source_records (deberían ser 3377)
SELECT 'source_records' as tabla, COUNT(*) as cantidad
FROM mp_source_record;

-- [2] Contar financial_movements por account_id
SELECT account_id, COUNT(*) as cantidad
FROM mp_financial_movement
GROUP BY account_id
ORDER BY cantidad DESC;

-- [3] Contar ledger_entries por account_id
SELECT account_id, COUNT(*) as cantidad
FROM ledger_entry
GROUP BY account_id
ORDER BY cantidad DESC;

-- [4] Ver distribution de movement_class
SELECT movement_class, COUNT(*) as cantidad
FROM mp_financial_movement
GROUP BY movement_class
ORDER BY cantidad DESC;

-- [5] Ver rango de fechas
SELECT
  MIN(transaction_date) as fecha_minima,
  MAX(transaction_date) as fecha_maxima,
  COUNT(DISTINCT DATE(transaction_date)) as dias_unicos
FROM mp_financial_movement;

-- [6] Verificar si hay source_records huérfanos (sin financial_movement)
SELECT COUNT(*) as source_records_sin_financial_movement
FROM mp_source_record sr
WHERE NOT EXISTS (
  SELECT 1 FROM mp_movement_source_link link
  WHERE link.source_record_id = sr.id
);

-- [7] Verificar si hay financial_movements sin ledger_entry
SELECT COUNT(*) as financial_movements_sin_ledger
FROM mp_financial_movement fm
WHERE NOT EXISTS (
  SELECT 1 FROM ledger_entry le
  WHERE le.financial_movement_id = fm.id
);

-- [8] Totales
SELECT
  (SELECT COUNT(*) FROM mp_source_record) as total_source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as total_financial_movements,
  (SELECT COUNT(*) FROM ledger_entry) as total_ledger_entries,
  (SELECT COUNT(*) FROM account_balance) as total_account_balance_rows;
