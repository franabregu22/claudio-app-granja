-- Eliminar la columna estado_pago (innecesaria, usamos movimiento_estado)
ALTER TABLE movimientos_caja
DROP COLUMN IF EXISTS estado_pago;

-- Eliminar el índice asociado
DROP INDEX IF EXISTS idx_movimientos_caja_estado_pago;

-- Nota: movimiento_estado ya existe y tiene los valores correctos
-- (confirmado, pendiente, cancelado)
