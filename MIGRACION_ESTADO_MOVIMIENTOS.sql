-- Agregar campo 'estado' a movimientos_caja si no existe
-- Estados: 'pendiente' (a pagar) | 'confirmado' (ya pagó) | 'cancelado' (anulado)

ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS estado_pago VARCHAR(20) DEFAULT 'confirmado' CHECK (estado_pago IN ('pendiente', 'confirmado', 'cancelado'));

-- Hacer fecha_pago nullable (para movimientos pendientes)
ALTER TABLE movimientos_caja
ALTER COLUMN fecha_pago DROP NOT NULL;

-- Crear índice para filtrar pendientes rápidamente
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_estado_pago ON movimientos_caja(estado_pago, fecha_pago);

-- Nota: Todos los movimientos existentes quedan como 'confirmado' (el default)
