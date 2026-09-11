-- Migration 006: Add 'liberaciones' to valid_source_type enum
-- Support for Liberaciones.csv import (secondary data source)

ALTER TABLE mp_source_record
DROP CONSTRAINT IF EXISTS valid_source_type;

ALTER TABLE mp_source_record
ADD CONSTRAINT valid_source_type CHECK (
  source_type IN ('report', 'api', 'webhook', 'liberaciones')
);

COMMENT ON CONSTRAINT valid_source_type ON mp_source_record IS
  'Valid source types: report (Account Money), api (historical), webhook (real-time), liberaciones (secondary payout data)';
