-- Eliminar la columna 'estado' redundante de movimientos_caja
-- Ahora usamos solo 'movimiento_estado' para el estado de un movimiento
ALTER TABLE movimientos_caja
DROP COLUMN IF EXISTS estado;

-- Nota: movimiento_estado contiene los mismos valores ('pendiente', 'confirmado', 'cancelado')
-- y es la única columna de estado que se usa en la aplicación
