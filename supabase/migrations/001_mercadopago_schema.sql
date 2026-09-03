-- Create mercadopago_raw table with mapped fields
CREATE TABLE IF NOT EXISTS mercadopago_raw (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Transaction info
  transaction_amount DECIMAL(15, 2) NOT NULL,
  currency_id VARCHAR(10) DEFAULT 'ARS',
  total_paid_amount DECIMAL(15, 2),
  net_received_amount DECIMAL(15, 2),

  -- Status
  status VARCHAR(50),
  status_detail VARCHAR(100),
  captured BOOLEAN DEFAULT false,

  -- Dates
  date_created TIMESTAMP WITH TIME ZONE,
  date_approved TIMESTAMP WITH TIME ZONE,
  money_release_date TIMESTAMP WITH TIME ZONE,

  -- Payer info
  payer_id TEXT,
  payer_email TEXT,
  payer_identification TEXT,

  -- Collector/business info
  collector_id BIGINT,
  issuer_id TEXT,

  -- Payment details
  payment_method VARCHAR(50),
  payment_type_id VARCHAR(50),
  authorization_code TEXT,
  statement_descriptor TEXT,

  -- Transaction details
  operation_type VARCHAR(50),
  description TEXT,
  installments INTEGER DEFAULT 1,

  -- Processing
  processed BOOLEAN DEFAULT false,

  -- Raw data (backup of complete JSON)
  raw_data JSONB,

  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_mercadopago_payer_id ON mercadopago_raw(payer_id);
CREATE INDEX IF NOT EXISTS idx_mercadopago_date_created ON mercadopago_raw(date_created DESC);
CREATE INDEX IF NOT EXISTS idx_mercadopago_status ON mercadopago_raw(status);
CREATE INDEX IF NOT EXISTS idx_mercadopago_processed ON mercadopago_raw(processed);

-- Create sync_metadata table to track last sync
CREATE TABLE IF NOT EXISTS sync_metadata (
  sync_type VARCHAR(50) PRIMARY KEY,
  last_sync_date TIMESTAMP WITH TIME ZONE,
  last_sync_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert initial metadata if not exists
INSERT INTO sync_metadata (sync_type, last_sync_date, last_sync_count)
VALUES ('mercadopago', NULL, 0)
ON CONFLICT (sync_type) DO NOTHING;
