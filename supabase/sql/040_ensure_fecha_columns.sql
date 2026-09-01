-- Asegurar que las columnas de fecha existan y tengan los tipos correctos
ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS fecha_operacion DATE NOT NULL DEFAULT CURRENT_DATE;

ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS fecha_pago DATE;

-- Crear índices para filtros rápidos
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_fecha_operacion
  ON movimientos_caja(fecha_operacion DESC);

CREATE INDEX IF NOT EXISTS idx_movimientos_caja_fecha_pago
  ON movimientos_caja(fecha_pago);

-- Nota:
-- fecha_operacion = cuándo ocurrió el movimiento (no cambia)
-- fecha_pago = cuándo se pagó (NULL si movimiento_estado='pendiente', debe tener valor si='confirmado')
