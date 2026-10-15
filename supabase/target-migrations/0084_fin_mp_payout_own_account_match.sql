-- ============================================================================
-- TARGET V1 — 0084 MERCADO PAGO PAYOUT OWN-ACCOUNT MATCH (READ-ONLY PROPOSAL) (ADR-018 §9.3, owner GO 2026-10-14)
--
-- LEVEL 1 rule validated on the real corpus (05/10 → BNA, 10/10 → BNA, 13/10 → no own account): the destination of a
-- payout (PAYOUT_BANK_ACCOUNT_NUMBER, stored privately by 0083) is compared EXACTLY with the active CBUs of the own
-- accounts. The result is only shown: no transfer, no posting, no classification is written. Auto-transfer stays OFF.
--
--   1. financial_account_identifier — own-account identifiers (type CBU / CVU / ACCOUNT_NUMBER / ALIAS / OTHER, value,
--      normalized value, primary / active, validity). Seeded with the CBUs already approved in fin_statement_account_config
--      (BNA, Patagonia) — no value typed here. PRIVATE: RLS on, SELECT for service_role only; anon / authenticated (ADMIN
--      included) have no privilege, so no full identifier is ever readable through the API.
--   2. fin_mp_payout_matches(p_account_id) — SECURITY DEFINER, STABLE, ADMIN only (current_app_role()), EXECUTE for
--      authenticated: one row per payout SOURCE_ID of that Mercado Pago account holding a stored destination, with
--      match_status OWN_ACCOUNT_EXACT | NO_OWN_ACCOUNT_MATCH | DESTINATION_CONFLICT, the matched account (id, name),
--      confidence (HIGH / NONE / REVIEW) and suggested_action (PROPOSE_INTERNAL_TRANSFER / CLASSIFY_OUTFLOW /
--      REVIEW_DESTINATION). It never returns a destination or identifier value. Writes nothing.
-- SECURITY DEFINER set 78 → 79.
-- ============================================================================

CREATE TABLE financial_account_identifier (
  id                   BIGSERIAL PRIMARY KEY,
  financial_account_id UUID        NOT NULL REFERENCES financial_account(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  identifier_type      VARCHAR(20) NOT NULL,
  identifier_value     TEXT        NOT NULL,
  normalized_value     TEXT        NOT NULL,
  is_primary           BOOLEAN     NOT NULL DEFAULT false,
  active               BOOLEAN     NOT NULL DEFAULT true,
  valid_from           DATE,
  valid_to             DATE,
  created_by           UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_fai_type       CHECK (identifier_type IN ('CBU', 'CVU', 'ACCOUNT_NUMBER', 'ALIAS', 'OTHER')),
  CONSTRAINT chk_fai_value      CHECK (btrim(identifier_value) <> '' AND length(identifier_value) <= 64),
  CONSTRAINT chk_fai_normalized CHECK (normalized_value <> '' AND normalized_value !~ '\s' AND length(normalized_value) <= 64),
  CONSTRAINT chk_fai_cbu        CHECK (identifier_type NOT IN ('CBU', 'CVU') OR normalized_value ~ '^[0-9]{22}$'),
  CONSTRAINT chk_fai_validity   CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
ALTER TABLE financial_account_identifier ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX uq_fai_active_value ON financial_account_identifier(identifier_type, normalized_value) WHERE active;
CREATE INDEX idx_fai_account ON financial_account_identifier(financial_account_id);
REVOKE ALL ON TABLE financial_account_identifier FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE financial_account_identifier TO service_role;
REVOKE ALL ON SEQUENCE financial_account_identifier_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY financial_account_identifier_service_select ON financial_account_identifier
  FOR SELECT USING (auth.role() = 'service_role');

-- seed: the CBUs already approved for the bank statement import (0074), one primary CBU per active configuration
INSERT INTO financial_account_identifier (financial_account_id, identifier_type, identifier_value, normalized_value, is_primary, active)
SELECT c.financial_account_id, 'CBU', c.expected_cbu, c.expected_cbu, true, true
  FROM fin_statement_account_config c
 WHERE c.activo;

CREATE OR REPLACE FUNCTION fin_mp_payout_matches(p_account_id UUID)
RETURNS TABLE (source_id TEXT, match_status TEXT, matched_account_id UUID, matched_account_name TEXT, confidence TEXT, suggested_action TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  RETURN QUERY
  WITH dest AS (
    SELECT d.source_id::TEXT AS sid, d.normalized_value AS v
      FROM fin_mp_payout_destination d
      JOIN fin_import_run r ON r.id = d.run_id
     WHERE r.source_kind = 'MP_RELEASE_REPORT' AND r.financial_account_id = p_account_id AND d.description = 'payout'
  ), per AS (
    SELECT sid, array_agg(DISTINCT v) AS vals FROM dest GROUP BY sid
  )
  SELECT per.sid,
         CASE WHEN cardinality(per.vals) > 1 THEN 'DESTINATION_CONFLICT'
              WHEN m.financial_account_id IS NOT NULL THEN 'OWN_ACCOUNT_EXACT'
              ELSE 'NO_OWN_ACCOUNT_MATCH' END,
         CASE WHEN cardinality(per.vals) = 1 THEN m.financial_account_id END,
         CASE WHEN cardinality(per.vals) = 1 THEN a.nombre::TEXT END,
         CASE WHEN cardinality(per.vals) > 1 THEN 'REVIEW' WHEN m.financial_account_id IS NOT NULL THEN 'HIGH' ELSE 'NONE' END,
         CASE WHEN cardinality(per.vals) > 1 THEN 'REVIEW_DESTINATION'
              WHEN m.financial_account_id IS NOT NULL THEN 'PROPOSE_INTERNAL_TRANSFER'
              ELSE 'CLASSIFY_OUTFLOW' END
    FROM per
    LEFT JOIN LATERAL (
      SELECT i.financial_account_id FROM financial_account_identifier i
       WHERE cardinality(per.vals) = 1 AND i.active AND i.identifier_type IN ('CBU', 'CVU') AND i.normalized_value = per.vals[1]
         AND (i.valid_from IS NULL OR i.valid_from <= CURRENT_DATE) AND (i.valid_to IS NULL OR i.valid_to >= CURRENT_DATE)
         AND i.financial_account_id <> p_account_id
       LIMIT 1) m ON true
    LEFT JOIN financial_account a ON a.id = m.financial_account_id
   ORDER BY per.sid;
END;
$$;
ALTER FUNCTION fin_mp_payout_matches(UUID) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_mp_payout_matches(UUID) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_mp_payout_matches(UUID) TO authenticated;
