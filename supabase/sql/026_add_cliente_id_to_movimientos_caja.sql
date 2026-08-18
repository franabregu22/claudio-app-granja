-- Add cliente_id field to movimientos_caja table
ALTER TABLE movimientos_caja
ADD COLUMN IF NOT EXISTS cliente_id UUID DEFAULT NULL;

-- Create foreign key to clientes
ALTER TABLE movimientos_caja
ADD CONSTRAINT fk_movimientos_cliente
FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL;

-- Create index for filtering by cliente
CREATE INDEX IF NOT EXISTS idx_movimientos_cliente_id ON movimientos_caja(cliente_id);
