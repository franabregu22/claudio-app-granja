-- ============================================================================
-- TARGET V1 — 0062 BANK TAX (ADR-011, owner decision D-WALK-7)
-- Impuesto a los Débitos y Créditos bancarios, recorded manually by ADMIN as its
-- own treasury operation.
--   * financial_operation_type BANK_TAX, tax_kind DEBITOS_CREDITOS (additive).
--   * bank_tax_charge: the tax detail of a BANK_TAX operation and its
--     authoritative (FK) relation to the TRANSFER it belongs to, if any.
--   * RPC 46 register_bank_tax: ADMIN only; one BANK_TAX operation with ONE
--     negative posting on the taxed account; idempotent by external_ref (an
--     exact replay returns the original, a different payload is refused).
--     Refuses the Mercado Pago account (its account_tax stays deferred, V-3).
--   * report_bank_tax_period: period / tax_kind / account / amount paid.
-- transfer_between_accounts is unchanged. BANK_TAX never enters the P&L: no
-- P&L source reads financial_operation (fail-closed by construction).
-- The new enum values are used only inside function bodies and are compared as
-- text elsewhere, so ADD VALUE inside the runner's transaction is safe.
-- ============================================================================

ALTER TYPE financial_operation_type ADD VALUE 'BANK_TAX';
ALTER TYPE tax_kind ADD VALUE 'DEBITOS_CREDITOS';

-- ── bank_tax_charge ─────────────────────────────────────────────────────────
CREATE TABLE bank_tax_charge (
  financial_operation_id BIGINT      PRIMARY KEY REFERENCES financial_operation(id),
  tax_kind               tax_kind    NOT NULL,
  financial_account_id   UUID        NOT NULL REFERENCES financial_account(id),
  amount                 NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  related_operation_id   BIGINT      REFERENCES financial_operation(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID        NOT NULL
);
CREATE INDEX idx_bank_tax_charge_related ON bank_tax_charge (related_operation_id);

ALTER TABLE bank_tax_charge ENABLE ROW LEVEL SECURITY;
CREATE POLICY bank_tax_charge_admin_select ON bank_tax_charge
  FOR SELECT TO authenticated USING (current_app_role() = 'ADMIN');
ALTER  TABLE bank_tax_charge OWNER TO postgres;
REVOKE ALL    ON bank_tax_charge FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON bank_tax_charge TO authenticated;

-- ── RPC 46 register_bank_tax ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_bank_tax(
  p_account_id           UUID,
  p_amount               NUMERIC,
  p_effective_date       DATE,
  p_tax_kind             tax_kind,
  p_external_ref         VARCHAR,
  p_related_operation_id BIGINT DEFAULT NULL,
  p_reason               TEXT   DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid          UUID := auth.uid();
  v_existing     RECORD;
  v_operation_id BIGINT;
  v_posting_id   BIGINT;
BEGIN
  IF current_app_role() <> 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE';
  END IF;
  IF p_tax_kind IS NULL OR p_tax_kind::TEXT <> 'DEBITOS_CREDITOS' THEN
    RAISE EXCEPTION 'INVALID_TAX_KIND: only DEBITOS_CREDITOS is recorded manually';
  END IF;
  IF p_external_ref IS NULL OR btrim(p_external_ref) = '' THEN
    RAISE EXCEPTION 'EXTERNAL_REF_REQUIRED';
  END IF;

  -- idempotency: an exact replay returns the original operation
  SELECT o.id, o.operation_type::TEXT AS op_type, o.effective_date, b.tax_kind::TEXT AS tax_kind,
         b.financial_account_id, b.amount, b.related_operation_id
    INTO v_existing
    FROM financial_operation o
    LEFT JOIN bank_tax_charge b ON b.financial_operation_id = o.id
   WHERE o.external_ref = p_external_ref;
  IF FOUND THEN
    IF v_existing.op_type = 'BANK_TAX'
       AND v_existing.financial_account_id = p_account_id
       AND v_existing.amount = p_amount
       AND v_existing.effective_date = p_effective_date
       AND v_existing.tax_kind = p_tax_kind::TEXT
       AND v_existing.related_operation_id IS NOT DISTINCT FROM p_related_operation_id THEN
      RETURN jsonb_build_object('financial_operation_id', v_existing.id, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'DUPLICATE_BANK_TAX: operation with external_ref % already exists', p_external_ref;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM financial_account WHERE id = p_account_id AND activo = true) THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND_OR_INACTIVE';
  END IF;
  -- the Mercado Pago account (identity rule of 0048 / 0051): its account_tax is V-3, deferred
  IF EXISTS (SELECT 1 FROM financial_account
              WHERE id = p_account_id AND nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE') THEN
    RAISE EXCEPTION 'MP_ACCOUNT_NOT_ALLOWED: the Mercado Pago tax is not recorded manually';
  END IF;
  IF p_related_operation_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM financial_operation
                      WHERE id = p_related_operation_id AND operation_type::TEXT = 'TRANSFER') THEN
    RAISE EXCEPTION 'RELATED_TRANSFER_NOT_FOUND';
  END IF;

  PERFORM assert_period_open(p_effective_date);

  BEGIN
    INSERT INTO financial_operation (operation_type, effective_date, external_ref,
                                     source_entity_type, source_entity_id, reason, created_by)
    VALUES ('BANK_TAX', p_effective_date, p_external_ref,
            CASE WHEN p_related_operation_id IS NULL THEN NULL ELSE 'financial_operation' END,
            p_related_operation_id::TEXT, p_reason, v_uid)
    RETURNING id INTO v_operation_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DUPLICATE_BANK_TAX: operation with external_ref % already exists', p_external_ref;
  END;

  -- exactly one posting: the tax leaves the taxed account
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_operation_id, p_account_id, -p_amount, p_effective_date, v_uid)
  RETURNING id INTO v_posting_id;

  INSERT INTO bank_tax_charge (financial_operation_id, tax_kind, financial_account_id, amount, related_operation_id, created_by)
  VALUES (v_operation_id, p_tax_kind, p_account_id, p_amount, p_related_operation_id, v_uid);

  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('financial_operation', v_operation_id::TEXT, 'BANK_TAX',
          jsonb_build_object('account', p_account_id, 'amount', p_amount, 'effective_date', p_effective_date,
                             'tax_kind', p_tax_kind, 'related_operation_id', p_related_operation_id),
          p_reason, v_uid);

  RETURN jsonb_build_object('financial_operation_id', v_operation_id, 'posting_id', v_posting_id, 'replayed', false);
END;
$$;

ALTER  FUNCTION register_bank_tax(UUID, NUMERIC, DATE, tax_kind, VARCHAR, BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_bank_tax(UUID, NUMERIC, DATE, tax_kind, VARCHAR, BIGINT, TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION register_bank_tax(UUID, NUMERIC, DATE, tax_kind, VARCHAR, BIGINT, TEXT) FROM anon, service_role;
GRANT  EXECUTE ON FUNCTION register_bank_tax(UUID, NUMERIC, DATE, tax_kind, VARCHAR, BIGINT, TEXT) TO authenticated;

-- ── report_bank_tax_period (ADMIN) ──────────────────────────────────────────
-- Amount paid per month, tax kind and account. No computability percentage.
CREATE VIEW report_bank_tax_period
WITH (security_invoker = true)
AS
SELECT date_trunc('month', o.effective_date)::DATE AS period,
       b.tax_kind,
       b.financial_account_id,
       a.nombre::TEXT                               AS account_name,
       SUM(b.amount)                                AS amount_paid,
       count(*)                                     AS charges
  FROM bank_tax_charge b
  JOIN financial_operation o ON o.id = b.financial_operation_id
  JOIN financial_account   a ON a.id = b.financial_account_id
 WHERE (SELECT current_app_role()) = 'ADMIN'
 GROUP BY date_trunc('month', o.effective_date), b.tax_kind, b.financial_account_id, a.nombre;

ALTER  VIEW report_bank_tax_period OWNER TO postgres;
REVOKE ALL    ON report_bank_tax_period FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON report_bank_tax_period TO authenticated;
