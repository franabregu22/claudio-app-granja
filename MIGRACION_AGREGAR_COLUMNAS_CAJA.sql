-- Agregar columnas faltantes a movimientos_caja
ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS categoria VARCHAR(100),
ADD COLUMN IF NOT EXISTS subcategoria VARCHAR(100),
ADD COLUMN IF NOT EXISTS naturaleza_gasto VARCHAR(50),
ADD COLUMN IF NOT EXISTS aplica_impuesto_cheque BOOLEAN DEFAULT false;

-- Crear índices para filtros
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_categoria ON movimientos_caja(categoria);
CREATE INDEX IF NOT EXISTS idx_movimientos_caja_naturaleza ON movimientos_caja(naturaleza_gasto);
