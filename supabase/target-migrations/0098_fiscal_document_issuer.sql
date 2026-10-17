-- ============================================================================
-- TARGET V1 — 0098 FISCAL DOCUMENT ISSUER BY CUIT (ADR-024 §3, owner GO 2026-10-16)
--
-- "Solo crédito fiscal IVA" is a fiscal treatment, not an expense category: Fiscal → "Registrar comprobante manual"
-- (register_fiscal_document, CREDITO with IVA components) records the VAT credit with no money movement, no purchase, no
-- supplier payable and no P&L. Since 0088 the fiscal document model accepts a received document identified by the issuer CUIT
-- without a registered supplier; register_fiscal_document now exposes it: p_issuer_tax_id / p_issuer_name (appended, DEFAULT
-- NULL — every existing call keeps working). The validation stays in fiscal_document_insert (11-digit CUIT; a name requires the
-- CUIT; a supplier or an issuer for a received document). No financial write. SECURITY DEFINER set unchanged.
-- ============================================================================

DROP FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT);
CREATE OR REPLACE FUNCTION register_fiscal_document(
  p_document_type   fiscal_document_type,
  p_direction       fiscal_direction,
  p_document_date   DATE,
  p_fiscal_period   DATE,
  p_net_amount      NUMERIC,
  p_total_amount    NUMERIC,
  p_components      JSONB,
  p_supplier_id     UUID DEFAULT NULL,
  p_cliente_id      UUID DEFAULT NULL,
  p_external_number VARCHAR DEFAULT NULL,
  p_reason          TEXT DEFAULT NULL,
  p_issuer_tax_id   VARCHAR DEFAULT NULL,   -- [0098] a received document from an issuer without a registered supplier
  p_issuer_name     VARCHAR DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  RETURN fiscal_document_insert(p_document_type, p_direction, p_document_date, p_fiscal_period, p_net_amount, p_total_amount,
                                p_components, p_supplier_id, p_cliente_id, p_external_number,
                                nullif(btrim(p_issuer_tax_id), ''), nullif(btrim(p_issuer_name), ''), p_reason);
END;
$$;
ALTER  FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT, VARCHAR, VARCHAR) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT, VARCHAR, VARCHAR) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_fiscal_document(fiscal_document_type, fiscal_direction, DATE, DATE, NUMERIC, NUMERIC, JSONB, UUID, UUID, VARCHAR, TEXT, VARCHAR, VARCHAR) TO authenticated;
