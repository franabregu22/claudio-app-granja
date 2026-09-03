-- Table to store raw MercadoPago data for debugging/analysis
CREATE TABLE IF NOT EXISTS mercadopago_raw (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  processed boolean DEFAULT false,
  creado_en timestamp DEFAULT now(),
  procesado_en timestamp
);

CREATE INDEX IF NOT EXISTS idx_mercadopago_processed ON mercadopago_raw(processed);
CREATE INDEX IF NOT EXISTS idx_mercadopago_created ON mercadopago_raw(creado_en DESC);
