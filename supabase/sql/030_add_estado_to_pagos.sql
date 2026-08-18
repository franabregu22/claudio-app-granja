-- Add estado field to pagos table
ALTER TABLE pagos
ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'confirmado' CHECK (estado IN ('confirmado', 'cancelado'));

-- Create index for filtering by estado
CREATE INDEX IF NOT EXISTS idx_pagos_estado ON pagos(estado);
