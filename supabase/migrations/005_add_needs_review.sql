-- ============================================================================
-- MIGRACIÓN 005: Agregar needs_review y economic_hash
-- ============================================================================
-- Propósito: Soportar versionado RAW con detección de cambios económicos
--
-- Campos agregados:
--   - needs_review: marcado cuando un source_record nuevo tiene cambio económico
--   - economic_hash: SHA256 de campos económicamente relevantes (para comparación rápida)
--
-- Backfill:
--   - Calcula economic_hash para todos los movimientos existentes usando
--     calc_economic_hash() function para garantizar canonicalización consistente
--     entre migración (SQL backfill) y RPC (inserción de nuevos versiones RAW)
-- ============================================================================

-- ============================================================================
-- PASO 1: Crear función auxiliar para calcular economic_hash
-- ============================================================================
-- Esta función debe usarse IDÉNTICAMENTE en:
--   1. Migración 005 (backfill de movimientos existentes)
--   2. RPC import_financial_pipeline (cálculo para nuevas versiones RAW)
--   3. Python importer (validación local antes de enviar a Supabase)
--
-- Canonicalización garantizada:
--   - NULL valores → string vacío ''
--   - NUMERIC → representación decimal estándar
--   - TIMESTAMP WITH TIME ZONE → ISO 8601 completo
--   - JSONB → serialización de texto (orden de claves canonicalizado por PostgreSQL)
--   - Algoritmo: SHA256 en hexadecimal

CREATE OR REPLACE FUNCTION calc_economic_hash(
  p_transaction_amount NUMERIC,
  p_settlement_amount NUMERIC,
  p_tax_amount NUMERIC,
  p_movement_class VARCHAR,
  p_transaction_date TIMESTAMP WITH TIME ZONE,
  p_settlement_date TIMESTAMP WITH TIME ZONE,
  p_payment_method VARCHAR,
  p_payment_detail VARCHAR,
  p_tax_detail JSONB
)
RETURNS VARCHAR(64) AS $$
DECLARE
  v_hash_input TEXT;
BEGIN
  -- Concatenar campos en orden canónico, NULLs como string vacío
  v_hash_input :=
    COALESCE(p_transaction_amount::TEXT, '') ||
    COALESCE(p_settlement_amount::TEXT, '') ||
    COALESCE(p_tax_amount::TEXT, '') ||
    COALESCE(p_movement_class, '') ||
    COALESCE(p_transaction_date::TEXT, '') ||
    COALESCE(p_settlement_date::TEXT, '') ||
    COALESCE(p_payment_method, '') ||
    COALESCE(p_payment_detail, '') ||
    COALESCE(p_tax_detail::TEXT, '');

  -- Retornar SHA256 en hexadecimal (64 caracteres)
  RETURN encode(digest(v_hash_input, 'sha256'), 'hex');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================================
-- PASO 2: Agregar columnas a mp_financial_movement
-- ============================================================================

ALTER TABLE mp_financial_movement
ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS economic_hash VARCHAR(64);

-- ============================================================================
-- PASO 3: Backfill economic_hash para movimientos existentes
-- ============================================================================
-- Calcula hash para todos los registros que aún no tengan (los importados antes
-- de esta migración). Garantiza que futuras versiones RAW puedan comparar económicamente.

UPDATE mp_financial_movement
SET economic_hash = calc_economic_hash(
  transaction_amount,
  settlement_amount,
  tax_amount,
  movement_class,
  transaction_date,
  settlement_date,
  payment_method,
  payment_detail,
  tax_detail
)
WHERE economic_hash IS NULL;

-- ============================================================================
-- PASO 4: Crear índice para búsquedas rápidas
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_mp_movement_needs_review
  ON mp_financial_movement(needs_review)
  WHERE needs_review = TRUE;

-- ============================================================================
-- PASO 5: Documentación
-- ============================================================================

COMMENT ON FUNCTION calc_economic_hash(NUMERIC, NUMERIC, NUMERIC, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE, VARCHAR, VARCHAR, JSONB) IS
  'Calcula SHA256 de campos económicamente relevantes de un movimiento. '
  'Usado en: backfill (migración 005), RPC import_financial_pipeline, validación Python. '
  'Campos incluidos: transaction_amount, settlement_amount, tax_amount, movement_class, '
  'transaction_date, settlement_date, payment_method, payment_detail, tax_detail';

COMMENT ON COLUMN mp_financial_movement.needs_review IS
  'BOOLEAN NOT NULL DEFAULT FALSE. TRUE cuando detectamos cambio económico en versión RAW '
  'de un source_external_id existente (diferentes económicamente a versiones previas). '
  'Requiere revisión manual por usuario para resolver discrepancia económica.';

COMMENT ON COLUMN mp_financial_movement.economic_hash IS
  'VARCHAR(64): SHA256 hexadecimal de: transaction_amount || settlement_amount || tax_amount || '
  'movement_class || transaction_date || settlement_date || payment_method || payment_detail || tax_detail. '
  'Usado para detectar rápidamente si una nueva versión RAW del mismo source_external_id tiene cambios económicos.';
