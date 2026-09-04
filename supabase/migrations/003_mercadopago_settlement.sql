-- Create table for settlement report movements
CREATE TABLE IF NOT EXISTS mercadopago_settlement (
  id BIGSERIAL PRIMARY KEY,

  -- Core fields from settlement report
  date_movement TIMESTAMP WITH TIME ZONE,
  source_id TEXT UNIQUE,
  record_type VARCHAR(100),
  movement_type VARCHAR(255),

  -- Amounts
  net_credit_amount DECIMAL(15, 2),
  net_debit_amount DECIMAL(15, 2),
  gross_amount DECIMAL(15, 2),

  -- Fees and deductions
  mp_fee_amount DECIMAL(15, 2),
  financing_fee_amount DECIMAL(15, 2),
  shipping_fee_amount DECIMAL(15, 2),
  taxes_amount DECIMAL(15, 2),

  -- Related info
  external_reference TEXT,
  related_source_id TEXT,
  coupon_amount DECIMAL(15, 2),

  -- Raw CSV data
  raw_line TEXT,

  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_settlement_date ON mercadopago_settlement(date_movement DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_type ON mercadopago_settlement(record_type);
CREATE INDEX IF NOT EXISTS idx_settlement_movement ON mercadopago_settlement(movement_type);
CREATE INDEX IF NOT EXISTS idx_settlement_source ON mercadopago_settlement(source_id);
