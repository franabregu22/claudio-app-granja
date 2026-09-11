-- ============================================================================
-- SCRIPT DE TEST DE IDEMPOTENCIA - ETAPA 4
-- ============================================================================
-- INSTRUCCIONES:
-- 1. Ejecutar SOLO en un entorno STAGING/DEVELOPMENT, NUNCA en producción
-- 2. Este script:
--    a) Verifica estado de tablas
--    b) Aplica la migración 004 si no existe
--    c) Importa el CSV la primera vez
--    d) Verifica resultados
--    e) Simula segunda importación (idempotencia)
--    f) Valida versionado de payloads
-- ============================================================================

-- PASO 0: Verificar que NO estamos en producción (si lo sabes)
-- (Usuario debe asegurar esto manualmente)

-- ============================================================================
-- PASO 1: CREAR TABLAS SI NO EXISTEN (Migración 004)
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS mp_source_record (
  id BIGSERIAL PRIMARY KEY,
  source_type VARCHAR(20) NOT NULL,
  source_external_id VARCHAR(100) NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  raw_data JSONB NOT NULL,
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processing_status VARCHAR(20) DEFAULT 'pending',
  processing_error TEXT,
  UNIQUE(source_type, source_external_id, payload_hash),
  CONSTRAINT valid_source_type CHECK (source_type IN ('report', 'api', 'webhook'))
);

CREATE INDEX IF NOT EXISTS idx_mp_source_type_id
  ON mp_source_record(source_type, source_external_id);
CREATE INDEX IF NOT EXISTS idx_mp_source_payload_hash
  ON mp_source_record(payload_hash);
CREATE INDEX IF NOT EXISTS idx_mp_source_status
  ON mp_source_record(processing_status);

CREATE TABLE IF NOT EXISTS mp_financial_movement (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  movement_class VARCHAR(30) NOT NULL,
  transaction_amount DECIMAL(15,2),
  settlement_amount DECIMAL(15,2) NOT NULL,
  tax_amount DECIMAL(15,2),
  tax_detail JSONB,
  tax_percentage DECIMAL(5,4),
  payment_method VARCHAR(30),
  payment_detail VARCHAR(50),
  payer_name VARCHAR(255),
  payer_id_type VARCHAR(20),
  payer_id_number VARCHAR(20),
  transaction_date TIMESTAMP WITH TIME ZONE NOT NULL,
  settlement_date TIMESTAMP WITH TIME ZONE,
  normalized_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  order_id VARCHAR(30),
  external_reference VARCHAR(255),
  bank_transfer_id VARCHAR(30),
  CONSTRAINT settlement_not_null CHECK (settlement_amount IS NOT NULL),
  CONSTRAINT valid_movement_class CHECK (
    movement_class IN ('payment_in', 'payment_out', 'yield',
                       'transfer_in', 'transfer_out', 'unclassified')
  )
);

CREATE INDEX IF NOT EXISTS idx_mp_movement_account_date
  ON mp_financial_movement(account_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_mp_movement_class
  ON mp_financial_movement(movement_class);

CREATE TABLE IF NOT EXISTS mp_movement_source_link (
  id BIGSERIAL PRIMARY KEY,
  financial_movement_id BIGINT NOT NULL,
  source_record_id BIGINT NOT NULL,
  is_primary BOOLEAN DEFAULT FALSE,
  linked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(financial_movement_id, source_record_id),
  CONSTRAINT fk_financial_movement
    FOREIGN KEY (financial_movement_id)
    REFERENCES mp_financial_movement(id) ON DELETE CASCADE,
  CONSTRAINT fk_source_record
    FOREIGN KEY (source_record_id)
    REFERENCES mp_source_record(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mp_link_movement
  ON mp_movement_source_link(financial_movement_id);
CREATE INDEX IF NOT EXISTS idx_mp_link_source
  ON mp_movement_source_link(source_record_id);

CREATE TABLE IF NOT EXISTS ledger_entry (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  financial_movement_id BIGINT NOT NULL UNIQUE,
  balance_impact DECIMAL(15,2) NOT NULL,
  category VARCHAR(30) NOT NULL,
  source_reference VARCHAR(100),
  description VARCHAR(255),
  observation TEXT,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT balance_not_null CHECK (balance_impact IS NOT NULL),
  CONSTRAINT valid_category CHECK (
    category IN ('income', 'expense', 'interest_income', 'transfer', 'other')
  ),
  CONSTRAINT fk_financial_movement
    FOREIGN KEY (financial_movement_id)
    REFERENCES mp_financial_movement(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ledger_account_date
  ON ledger_entry(account_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS account_balance (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,
  opening_balance DECIMAL(15,2),
  opening_balance_date DATE,
  opening_balance_source VARCHAR(100),
  opening_balance_set_at TIMESTAMP WITH TIME ZONE,
  calculated_balance DECIMAL(15,2) NOT NULL,
  observed_balance_mp DECIMAL(15,2),
  variance DECIMAL(15,2),
  variance_note TEXT,
  last_synced_at TIMESTAMP WITH TIME ZONE,
  sync_source VARCHAR(20),
  UNIQUE(account_id, balance_date)
);

CREATE INDEX IF NOT EXISTS idx_balance_account_date
  ON account_balance(account_id, balance_date DESC);

-- Función de cálculo de balance
CREATE OR REPLACE FUNCTION calculate_ledger_balance(
  p_account_id BIGINT,
  p_as_of_date DATE
)
RETURNS DECIMAL AS $$
DECLARE
  v_opening_balance DECIMAL(15,2);
  v_opening_date DATE;
  v_sum_impact DECIMAL(15,2);
BEGIN
  SELECT opening_balance, opening_balance_date
  INTO v_opening_balance, v_opening_date
  FROM account_balance
  WHERE account_id = p_account_id
  ORDER BY opening_balance_date DESC NULLS LAST
  LIMIT 1;

  v_opening_balance := COALESCE(v_opening_balance, 0);
  v_opening_date := COALESCE(v_opening_date, '2026-01-01'::DATE);

  SELECT COALESCE(SUM(balance_impact), 0)
  INTO v_sum_impact
  FROM ledger_entry
  WHERE account_id = p_account_id
    AND DATE(occurred_at) >= v_opening_date
    AND DATE(occurred_at) <= p_as_of_date;

  RETURN v_opening_balance + v_sum_impact;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;

-- ============================================================================
-- PASO 2: LIMPIAR DATOS DE TEST PREVIOS (SOLO DATOS, NO SCHEMA)
-- ============================================================================
-- Descomenta esto si quieres un test limpio desde cero:
-- DELETE FROM ledger_entry;
-- DELETE FROM mp_movement_source_link;
-- DELETE FROM mp_financial_movement;
-- DELETE FROM mp_source_record;
-- DELETE FROM account_balance;

-- ============================================================================
-- PASO 3: VERIFICAR ESTADO ANTES (BASELINE)
-- ============================================================================

SELECT
  'ANTES DE IMPORTACIÓN' as fase,
  (SELECT COUNT(*) FROM mp_source_record) as source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as financial_movements,
  (SELECT COUNT(*) FROM mp_movement_source_link) as movement_links,
  (SELECT COUNT(*) FROM ledger_entry) as ledger_entries,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'yield') as yields,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'unclassified') as unclassified
;

-- ============================================================================
-- PASO 4: IMPORTACIÓN (Primera vez)
-- El SQL generado por import_mp_report.py va aquí
-- Reemplazar la sección siguiente con el contenido de scripts/import_mp_report.sql
-- ============================================================================

-- TODO: Insertar contenido de import_mp_report.sql aquí
-- (El usuario reemplazará manualmente esta sección)

-- ============================================================================
-- PASO 5: VERIFICAR RESULTADOS DESPUÉS PRIMERA IMPORTACIÓN
-- ============================================================================

SELECT
  'DESPUÉS 1RA IMPORTACIÓN' as fase,
  (SELECT COUNT(*) FROM mp_source_record) as source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as financial_movements,
  (SELECT COUNT(*) FROM mp_movement_source_link) as movement_links,
  (SELECT COUNT(*) FROM ledger_entry) as ledger_entries,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'yield') as yields,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'unclassified') as unclassified,
  (SELECT SUM(transaction_amount)::NUMERIC(15,2) FROM mp_financial_movement) as total_transaction_amount,
  (SELECT SUM(settlement_amount)::NUMERIC(15,2) FROM mp_financial_movement) as total_settlement_amount,
  (SELECT SUM(tax_amount)::NUMERIC(15,2) FROM mp_financial_movement) as total_taxes,
  (SELECT SUM(balance_impact)::NUMERIC(15,2) FROM ledger_entry) as total_balance_impact
;

-- Verificar yields específicamente
SELECT
  'RENDIMIENTOS DETECTADOS' as verificacion,
  COUNT(*) as cantidad,
  SUM(settlement_amount)::NUMERIC(15,2) as total
FROM mp_financial_movement
WHERE movement_class = 'yield'
;

-- ============================================================================
-- PASO 6: SIMULACIÓN DE SEGUNDA IMPORTACIÓN (IDEMPOTENCIA)
-- Se intenta insertar exactamente los mismos 716 registros
-- RESULTADO ESPERADO: 0 inserts (todos ignorados por UNIQUE constraint)
-- ============================================================================

-- TODO: Repetir el contenido de import_mp_report.sql aquí
-- (Sin cambios, exacto, para probar deduplicación)

-- ============================================================================
-- PASO 7: VERIFICAR IDEMPOTENCIA
-- ============================================================================

SELECT
  'DESPUÉS 2DA IMPORTACIÓN (debe ser igual a anterior)' as fase,
  (SELECT COUNT(*) FROM mp_source_record) as source_records,
  (SELECT COUNT(*) FROM mp_financial_movement) as financial_movements,
  (SELECT COUNT(*) FROM mp_movement_source_link) as movement_links,
  (SELECT COUNT(*) FROM ledger_entry) as ledger_entries
;

-- ============================================================================
-- PASO 8: TEST DE VERSIONADO (Simular payload modificado)
-- ============================================================================
-- Esto simula que Mercado Pago actualiza el contenido de un movimiento
-- Debe:
-- 1. Crear una nueva versión RAW porque cambió el hash
-- 2. No crear nuevo financial_movement
-- 3. Mantener trazabilidad con la versión anterior

-- Ejemplo: Modificar el primer source record
-- Nota: Este es un test manual. El usuario debe ejecutar solo si quiere probar versionado.

/*
-- Obtener primer SOURCE_ID
WITH first_record AS (
  SELECT source_external_id FROM mp_source_record LIMIT 1
)
INSERT INTO mp_source_record (
  source_type, source_external_id, payload_hash, raw_data,
  observed_at, received_at, processing_status
)
SELECT
  source_type,
  source_external_id,
  'modified_hash_12345'::VARCHAR(64),
  jsonb_set(raw_data, '{SETTLEMENT_NET_AMOUNT}', '"9999.99"'),
  NOW()::TIMESTAMP WITH TIME ZONE,
  NOW(),
  'processed'
FROM mp_source_record
WHERE source_external_id = (SELECT source_external_id FROM first_record)
LIMIT 1;

-- Verificar que se creó nueva versión
SELECT
  source_external_id, payload_hash, COUNT(*)
FROM mp_source_record
WHERE source_external_id = (SELECT source_external_id FROM first_record)
GROUP BY source_external_id, payload_hash;
*/

-- ============================================================================
-- PASO 9: VALIDACIONES FINALES
-- ============================================================================

-- Duplicados en source records (no debe haber)
SELECT 'VERIFICACIÓN: Duplicados source_record' as check_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT (source_type, source_external_id, payload_hash)) as unique_combinations,
  CASE WHEN COUNT(*) = COUNT(DISTINCT (source_type, source_external_id, payload_hash))
    THEN 'OK' ELSE 'ERROR' END as status
FROM mp_source_record;

-- Duplicados en financial movements (no debe haber)
SELECT 'VERIFICACIÓN: Duplicados financial_movements' as check_name,
  COUNT(*) as total_records,
  COUNT(DISTINCT id) as unique_ids,
  CASE WHEN COUNT(*) = COUNT(DISTINCT id)
    THEN 'OK' ELSE 'ERROR' END as status
FROM mp_financial_movement;

-- Movimientos sin source link
SELECT 'VERIFICACIÓN: Financial movements sin source link' as check_name,
  COUNT(*) as orphaned_movements
FROM mp_financial_movement m
WHERE NOT EXISTS (SELECT 1 FROM mp_movement_source_link WHERE financial_movement_id = m.id);

-- Ledger entries sin financial movement
SELECT 'VERIFICACIÓN: Ledger entries huérfanos' as check_name,
  COUNT(*) as orphaned_ledger
FROM ledger_entry le
WHERE NOT EXISTS (SELECT 1 FROM mp_financial_movement WHERE id = le.financial_movement_id);

-- Source records sin procesar
SELECT 'VERIFICACIÓN: Source records pending' as check_name,
  COUNT(*) as pending_records
FROM mp_source_record
WHERE processing_status = 'pending';

-- Movimientos unclassified (debe haber 0)
SELECT 'VERIFICACIÓN: Movimientos unclassified' as check_name,
  COUNT(*) as unclassified_count,
  CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'ERROR' END as status
FROM mp_financial_movement
WHERE movement_class = 'unclassified';

-- Totales financieros finales
SELECT 'TOTALES FINALES' as resumen,
  (SELECT SUM(transaction_amount)::NUMERIC(15,2) FROM mp_financial_movement) as transaction_amount_total,
  (SELECT SUM(settlement_amount)::NUMERIC(15,2) FROM mp_financial_movement) as settlement_amount_total,
  (SELECT SUM(tax_amount)::NUMERIC(15,2) FROM mp_financial_movement) as tax_amount_total,
  (SELECT SUM(balance_impact)::NUMERIC(15,2) FROM ledger_entry) as balance_impact_total,
  (SELECT COUNT(*) FROM mp_financial_movement WHERE movement_class = 'yield') as yield_count,
  (SELECT SUM(settlement_amount)::NUMERIC(15,2) FROM mp_financial_movement WHERE movement_class = 'yield') as yield_total
;

-- ============================================================================
-- FIN DEL SCRIPT
-- ============================================================================
-- RESULTADO ESPERADO:
-- ✓ Tablas creadas sin errores
-- ✓ Primera importación: 716 source records, 716 financial movements, 0 duplicados
-- ✓ Segunda importación: 0 nuevos registros (todos ignorados por UNIQUE)
-- ✓ Versionado: Nueva versión con diferente hash conserva trazabilidad
-- ✓ Todos los movimientos clasificados (0 unclassified)
-- ✓ Totales exactos: SETTLEMENT_AMOUNT = $10,780,612.05
-- ============================================================================
