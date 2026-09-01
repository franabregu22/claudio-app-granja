-- Agregar columna movimiento_estado a movimientos_caja
ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS movimiento_estado VARCHAR(20) DEFAULT 'confirmado' CHECK (movimiento_estado IN ('pendiente', 'confirmado', 'cancelado'));

-- Asegurar que fecha_pago sea nullable
ALTER TABLE movimientos_caja
ALTER COLUMN fecha_pago DROP NOT NULL;

-- Crear índice para filtrar por estado
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_movimiento_estado ON movimientos_caja(movimiento_estado);

-- Nota: Todos los movimientos existentes quedan como 'confirmado' (el default)
