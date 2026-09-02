-- Add impuesto_cheque column to track the 0.6% fee amount separately
ALTER TABLE movimientos_caja ADD COLUMN IF NOT EXISTS impuesto_cheque numeric(12,2) DEFAULT 0;
