-- Add fingerprint column for deduplication by economic data (not just payload)
-- Fingerprint = MD5(date | source_id | source_id | signed_impact | description)
-- Allows detecting same economic event even if payload is slightly different

ALTER TABLE mp_source_record
ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_mp_source_fingerprint
  ON mp_source_record(fingerprint);

COMMENT ON COLUMN mp_source_record.fingerprint IS
  'MD5 hash of economic attributes (date|source_id|source_id|amount|description) for deduplication';
