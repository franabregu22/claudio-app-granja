-- ============================================================================
-- TARGET V1 — 0068 PURCHASE FISCAL DOCUMENT (ATOMIC) + FISCAL PERIOD REPORT
-- (ADR-015, owner decisions D-FISCAL-1…8, Phase 27 acceptance fixes)
--
--   * RPC 50 register_purchase_with_fiscal_document: ONE transaction that calls
--     RPC 34 register_fiscal_document (direction CREDITO, the purchase supplier,
--     document date = economic date) and then RPC 13 register_purchase with the
--     new fiscal_document_id. Either both exist or neither does. RPCs 13 and 34
--     are unchanged; a purchase without fiscal data keeps calling RPC 13.
--   * report_fiscal_period (ADMIN): per fiscal period and tax kind, the loaded
--     component tax amounts by document direction (DEBITO = issued to clients,
--     CREDITO = received from suppliers). A CREDIT_NOTE contributes its amount
--     with the opposite sign (it reverses the loaded effect); stored amounts are
--     never rewritten. period_difference = debit − credit is informational only:
--     it is NOT a payable / balance-in-favour / filing amount, and nothing is
--     carried forward between periods.
--   * Purchases still enter the P&L by amount_total (ADR-004): no VAT is
--     subtracted from cost.
-- ============================================================================

-- ── RPC 50 register_purchase_with_fiscal_document ───────────────────────────
-- p_fiscal_components: [{tax_kind, base_amount, rate_applied, tax_amount, direction?}]
-- (direction defaults to CREDITO; amounts are stored exactly as supplied).
CREATE OR REPLACE FUNCTION register_purchase_with_fiscal_document(
  p_supplier_id            UUID,
  p_economic_date          DATE,
  p_amount_net             NUMERIC,
  p_amount_total           NUMERIC,
  p_expense_category_id    UUID,
  p_nature                 purchase_nature,
  p_lines                  JSONB,
  p_attachments            JSONB,
  p_idempotency_key        VARCHAR,
  p_fiscal_document_type   fiscal_document_type,
  p_fiscal_period          DATE,
  p_fiscal_net_amount      NUMERIC,
  p_fiscal_total_amount    NUMERIC,
  p_fiscal_components      JSONB,
  p_subcategory            VARCHAR DEFAULT NULL,
  p_project_id             UUID DEFAULT NULL,
  p_supplier_invoice_number VARCHAR DEFAULT NULL,
  p_flock_id               UUID DEFAULT NULL,
  p_reason                 TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_comp       JSONB;
  v_components JSONB := '[]'::JSONB;
  v_doc        JSONB;
  v_purchase   JSONB;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  -- a purchase is documented by an invoice / receipt; credit and debit notes are separate documents
  IF p_fiscal_document_type IS NULL OR p_fiscal_document_type::TEXT IN ('CREDIT_NOTE', 'DEBIT_NOTE') THEN
    RAISE EXCEPTION 'INVALID_DOCUMENT_TYPE: a purchase is documented by an invoice, receipt or other document';
  END IF;
  IF p_fiscal_net_amount IS NULL OR p_fiscal_net_amount < 0 OR p_fiscal_total_amount IS NULL OR p_fiscal_total_amount < 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_fiscal_components IS NULL OR jsonb_typeof(p_fiscal_components) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_COMPONENTS: components must be an array';
  END IF;
  FOR v_comp IN SELECT value FROM jsonb_array_elements(p_fiscal_components) LOOP
    IF v_comp->>'tax_kind' IS NULL OR v_comp->>'base_amount' IS NULL OR v_comp->>'rate_applied' IS NULL OR v_comp->>'tax_amount' IS NULL THEN
      RAISE EXCEPTION 'INVALID_COMPONENTS: tax_kind, base_amount, rate_applied and tax_amount are required';
    END IF;
    v_components := v_components || jsonb_build_object(
      'tax_kind', v_comp->>'tax_kind', 'direction', COALESCE(v_comp->>'direction', 'CREDITO'),
      'base_amount', v_comp->'base_amount', 'rate_applied', v_comp->'rate_applied', 'tax_amount', v_comp->'tax_amount');
  END LOOP;

  v_doc := register_fiscal_document(
    p_fiscal_document_type, 'CREDITO', p_economic_date, p_fiscal_period, p_fiscal_net_amount, p_fiscal_total_amount,
    v_components, p_supplier_id, NULL, p_supplier_invoice_number, p_reason);

  v_purchase := register_purchase(
    p_supplier_id, p_economic_date, p_amount_net, p_amount_total, p_expense_category_id, p_subcategory, p_nature,
    p_lines, p_attachments, p_idempotency_key, p_project_id, (v_doc->>'fiscal_document_id')::UUID,
    p_supplier_invoice_number, p_flock_id, p_reason);

  RETURN v_purchase || jsonb_build_object('fiscal_document_id', v_doc->'fiscal_document_id', 'component_count', v_doc->'component_count');
END;
$$;

ALTER  FUNCTION register_purchase_with_fiscal_document(UUID, DATE, NUMERIC, NUMERIC, UUID, purchase_nature, JSONB, JSONB, VARCHAR,
  fiscal_document_type, DATE, NUMERIC, NUMERIC, JSONB, VARCHAR, UUID, VARCHAR, UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION register_purchase_with_fiscal_document(UUID, DATE, NUMERIC, NUMERIC, UUID, purchase_nature, JSONB, JSONB, VARCHAR,
  fiscal_document_type, DATE, NUMERIC, NUMERIC, JSONB, VARCHAR, UUID, VARCHAR, UUID, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION register_purchase_with_fiscal_document(UUID, DATE, NUMERIC, NUMERIC, UUID, purchase_nature, JSONB, JSONB, VARCHAR,
  fiscal_document_type, DATE, NUMERIC, NUMERIC, JSONB, VARCHAR, UUID, VARCHAR, UUID, TEXT) TO authenticated;

-- ── report_fiscal_period (ADMIN) ────────────────────────────────────────────
CREATE VIEW report_fiscal_period
WITH (security_invoker = true)
AS
WITH c AS (
  SELECT d.fiscal_period,
         c.tax_kind,
         d.direction,
         d.id AS fiscal_document_id,
         CASE WHEN d.document_type = 'CREDIT_NOTE' THEN -c.tax_amount ELSE c.tax_amount END AS signed_tax_amount
    FROM fiscal_document d
    JOIN fiscal_document_component c ON c.fiscal_document_id = d.id
)
SELECT fiscal_period                                                               AS period,
       tax_kind,
       COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'DEBITO'), 0)      AS debit_amount,
       COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'CREDITO'), 0)     AS credit_amount,
       count(DISTINCT fiscal_document_id) FILTER (WHERE direction = 'DEBITO')       AS debit_documents,
       count(DISTINCT fiscal_document_id) FILTER (WHERE direction = 'CREDITO')      AS credit_documents,
       COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'DEBITO'), 0)
         - COALESCE(SUM(signed_tax_amount) FILTER (WHERE direction = 'CREDITO'), 0) AS period_difference
  FROM c
 WHERE (SELECT current_app_role()) = 'ADMIN'
 GROUP BY fiscal_period, tax_kind;

ALTER  VIEW report_fiscal_period OWNER TO postgres;
REVOKE ALL    ON report_fiscal_period FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON report_fiscal_period TO authenticated;
