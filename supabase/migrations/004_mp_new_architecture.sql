-- ============================================================================
-- FASE 0: Nueva arquitectura de Mercado Pago (Account Money Report)
-- ============================================================================
-- Tablas:
-- 1. mp_source_record — Datos RAW versionados (una fila por versión)
-- 2. mp_financial_movement — Movimiento normalizado (one per economic event)
-- 3. mp_movement_source_link — Relación many-to-one (source records → financial movement)
-- 4. ledger_entry — Impacto en balance
-- 5. account_balance — Saldo calculado por día + opening balance
-- ============================================================================

-- ============================================================================
-- 1. mp_source_record — Registro RAW versionado
-- ============================================================================

CREATE TABLE IF NOT EXISTS mp_source_record (
  id BIGSERIAL PRIMARY KEY,

  -- Identificación de fuente
  source_type VARCHAR(20) NOT NULL,          -- 'report', 'api', 'webhook'
  source_external_id VARCHAR(100) NOT NULL,  -- SOURCE_ID del CSV, event_id, etc.

  -- Versionado de contenido (permite múltiples observaciones del mismo objeto)
  payload_hash VARCHAR(64) NOT NULL,         -- SHA256(raw_data)

  -- Datos RAW exactos (sin modificación)
  raw_data JSONB NOT NULL,

  -- Auditoría
  observed_at TIMESTAMP WITH TIME ZONE NOT NULL,  -- Cuándo se vio este payload
  received_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  processing_status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'processed', 'error'
  processing_error TEXT,

  -- Deduplicación: permite múltiples versiones del mismo objeto (diferente hash)
  UNIQUE(source_type, source_external_id, payload_hash),

  CONSTRAINT valid_source_type CHECK (source_type IN ('report', 'api', 'webhook'))
);

CREATE INDEX IF NOT EXISTS idx_mp_source_type_id
  ON mp_source_record(source_type, source_external_id);
CREATE INDEX IF NOT EXISTS idx_mp_source_payload_hash
  ON mp_source_record(payload_hash);
CREATE INDEX IF NOT EXISTS idx_mp_source_observed_at
  ON mp_source_record(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mp_source_status
  ON mp_source_record(processing_status);

-- ============================================================================
-- 2. mp_financial_movement — Movimiento normalizado
-- ============================================================================

CREATE TABLE IF NOT EXISTS mp_financial_movement (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,

  -- Clasificación
  movement_class VARCHAR(30) NOT NULL,       -- 'payment_in', 'payment_out', 'yield',
                                              -- 'transfer_in', 'transfer_out', 'unclassified'

  -- Importes (de source record principal)
  transaction_amount DECIMAL(15,2),          -- TRANSACTION_AMOUNT (del CSV)
  settlement_amount DECIMAL(15,2) NOT NULL,  -- SETTLEMENT_NET_AMOUNT (principal)
  tax_amount DECIMAL(15,2),                  -- TAXES_AMOUNT (del CSV)

  -- Detalle de impuestos
  tax_detail JSONB,                          -- JSON parseado de TAX_DETAIL
  tax_percentage DECIMAL(5,4),               -- Diagnóstico: |tax_amount| / transaction_amount

  -- Método de pago
  payment_method VARCHAR(30),                -- 'available_money', 'bank_transfer', etc
  payment_detail VARCHAR(50),                -- 'debin_transfer', 'cvu', 'visa', etc

  -- Pagador
  payer_name VARCHAR(255),
  payer_id_type VARCHAR(20),                 -- 'CUIT', 'CUIL'
  payer_id_number VARCHAR(20),

  -- Fechas
  transaction_date TIMESTAMP WITH TIME ZONE NOT NULL,
  settlement_date TIMESTAMP WITH TIME ZONE,

  -- Auditoría
  normalized_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Referencias opcionales
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

-- ============================================================================
-- 3. mp_movement_source_link — Relación many-to-one
-- ============================================================================

CREATE TABLE IF NOT EXISTS mp_movement_source_link (
  id BIGSERIAL PRIMARY KEY,

  financial_movement_id BIGINT NOT NULL,
  source_record_id BIGINT NOT NULL,

  -- Cuál source record fue el principal para normalizar
  is_primary BOOLEAN DEFAULT FALSE,

  -- Auditoría
  linked_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Evitar duplicar la misma relación
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
CREATE INDEX IF NOT EXISTS idx_mp_link_primary
  ON mp_movement_source_link(financial_movement_id, is_primary)
  WHERE is_primary = TRUE;

-- ============================================================================
-- 4. ledger_entry — Impacto en balance
-- ============================================================================

CREATE TABLE IF NOT EXISTS ledger_entry (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  financial_movement_id BIGINT NOT NULL UNIQUE,  -- 1:1 relación

  -- Impacto económico (valor canónico para balance)
  balance_impact DECIMAL(15,2) NOT NULL,     -- = settlement_amount

  -- Categoría financiera
  category VARCHAR(30) NOT NULL,             -- 'income', 'expense', 'interest_income', 'transfer', 'other'

  -- Trazabilidad
  source_reference VARCHAR(100),             -- "SOURCE_ID=1234 (report, api)"
  description VARCHAR(255),
  observation TEXT,                          -- Notas, UNCLASSIFIED reason, etc

  -- Fechas
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,  -- transaction_date
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
CREATE INDEX IF NOT EXISTS idx_ledger_category
  ON ledger_entry(category);

-- ============================================================================
-- 5. account_balance — Saldo calculado por día
-- ============================================================================

CREATE TABLE IF NOT EXISTS account_balance (
  id BIGSERIAL PRIMARY KEY,

  account_id BIGINT NOT NULL,
  balance_date DATE NOT NULL,

  -- Saldo inicial configurado (una sola vez por account)
  opening_balance DECIMAL(15,2),             -- Saldo al opening_balance_date
  opening_balance_date DATE,                 -- Generalmente 2026-01-01
  opening_balance_source VARCHAR(100),       -- 'manual', 'mp_report', etc
  opening_balance_set_at TIMESTAMP WITH TIME ZONE,

  -- Calculado: opening_balance + SUM(balance_impact desde opening_balance_date)
  calculated_balance DECIMAL(15,2) NOT NULL,

  -- Observado (OPCIONAL, ingresado manualmente por usuario)
  observed_balance_mp DECIMAL(15,2),

  -- Auditoría
  variance DECIMAL(15,2),                    -- observed - calculated
  variance_note TEXT,

  last_synced_at TIMESTAMP WITH TIME ZONE,
  sync_source VARCHAR(20),                   -- 'report', 'api', 'manual'

  UNIQUE(account_id, balance_date)
);

CREATE INDEX IF NOT EXISTS idx_balance_account_date
  ON account_balance(account_id, balance_date DESC);

-- ============================================================================
-- 6. FUNCIÓN: Calcular balance
-- ============================================================================

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
  -- Obtener opening balance
  SELECT opening_balance, opening_balance_date
  INTO v_opening_balance, v_opening_date
  FROM account_balance
  WHERE account_id = p_account_id
  ORDER BY opening_balance_date DESC NULLS LAST
  LIMIT 1;

  -- Default: opening_balance = 0, opening_date = 2026-01-01
  v_opening_balance := COALESCE(v_opening_balance, 0);
  v_opening_date := COALESCE(v_opening_date, '2026-01-01'::DATE);

  -- Sumar impactos desde opening_date hasta p_as_of_date
  SELECT COALESCE(SUM(balance_impact), 0)
  INTO v_sum_impact
  FROM ledger_entry
  WHERE account_id = p_account_id
    AND DATE(occurred_at) >= v_opening_date
    AND DATE(occurred_at) <= p_as_of_date;

  RETURN v_opening_balance + v_sum_impact;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- 7. TRIGGER: Auto-calcular account_balance al insertar ledger_entry
-- ============================================================================

CREATE OR REPLACE FUNCTION update_account_balance_on_ledger()
RETURNS TRIGGER AS $$
BEGIN
  -- Actualizar o crear el balance del día
  INSERT INTO account_balance (
    account_id,
    balance_date,
    calculated_balance,
    sync_source
  ) VALUES (
    NEW.account_id,
    DATE(NEW.occurred_at),
    calculate_ledger_balance(NEW.account_id, DATE(NEW.occurred_at)),
    'ledger_entry'
  )
  ON CONFLICT (account_id, balance_date)
  DO UPDATE SET
    calculated_balance = calculate_ledger_balance(NEW.account_id, DATE(NEW.occurred_at)),
    last_synced_at = NOW();

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists (safe way to handle re-runs)
DROP TRIGGER IF EXISTS trg_update_balance_on_ledger ON ledger_entry;

CREATE TRIGGER trg_update_balance_on_ledger
AFTER INSERT OR UPDATE ON ledger_entry
FOR EACH ROW
EXECUTE FUNCTION update_account_balance_on_ledger();

-- ============================================================================
-- 8. COMENTARIOS (documentación)
-- ============================================================================

COMMENT ON TABLE mp_source_record IS
  'Registro RAW versionado. Una fila por observación única de un source record.
   Permite múltiples versiones del mismo objeto (diferente payload_hash).
   NO se sobrescriben datos históricos.';

COMMENT ON TABLE mp_financial_movement IS
  'Movimiento financiero normalizado y clasificado.
   Relación many-to-one: muchos mp_source_record pueden apuntar a uno solo.
   settlement_amount es el valor canónico para balance_impact.';

COMMENT ON TABLE mp_movement_source_link IS
  'Relación many-to-one entre source records y financial movements.
   Permite correlacionar múltiples fuentes (Report + API + Webhook) del mismo evento.';

COMMENT ON TABLE ledger_entry IS
  '1:1 con mp_financial_movement. Impacto económico en la cuenta.
   balance_impact = settlement_amount. Relación 1:1 con financial_movement.';

COMMENT ON TABLE account_balance IS
  'Saldo calculado por día. opening_balance + SUM(balance_impact desde opening_date).
   observed_balance_mp es opcional (manual, para conciliación).
   variance = observed - calculated (para debugging).';

-- ============================================================================
-- FIN MIGRACIÓN 004
-- ============================================================================
