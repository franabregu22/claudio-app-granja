-- Create mercadopago_movements table for money movements (rendimientos, comisiones, etc)
CREATE TABLE IF NOT EXISTS mercadopago_movements (
  id TEXT PRIMARY KEY,

  -- Movement type
  type VARCHAR(100),
  description TEXT,
  status VARCHAR(50) DEFAULT 'active',

  -- Amount info
  amount DECIMAL(15, 2),
  net_amount DECIMAL(15, 2),
  currency_id VARCHAR(10) DEFAULT 'ARS',

  -- Date
  date_created TIMESTAMP WITH TIME ZONE,

  -- Related info
  payer_id TEXT,
  related_resource TEXT,

  -- Details (JSON for flexible data)
  details JSONB,

  -- Raw data (complete JSON backup)
  raw_data JSONB,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_movements_date ON mercadopago_movements(date_created DESC);
CREATE INDEX IF NOT EXISTS idx_movements_type ON mercadopago_movements(type);
CREATE INDEX IF NOT EXISTS idx_movements_status ON mercadopago_movements(status);
