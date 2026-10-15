-- ============================================================================
-- TARGET V1 — 0091 GLOBAL MERCADO PAGO SOURCE INVARIANT (META A closure; ADR-019 / ADR-020 follow-up)
--
-- Invariant: every NEW operation that moves the Mercado Pago account is linked, IN THE SAME TRANSACTION, to
--   A. a real Mercado Pago movement (mp_reconciliation → mp_financial_movement → SOURCE_ID), or
--   B. an explicit, audited, specific exception (mp_source_exception), written only by dedicated ADMIN RPCs.
-- Otherwise the transaction is refused at COMMIT with MP_POSTING_REQUIRES_SOURCE — whatever the route (Cobros, Compras,
-- Cuentas a pagar, Tesorería, Retiro de socios, Fiscal, any future one). There is no generic bypass.
--
--   1. mp_source_exception — one immutable row per excepted operation (kind, amount, reason, evidence, actor).
--   2. mp_account_posting_guard() + CONSTRAINT TRIGGER trg_mp_account_posting_source (AFTER INSERT ON financial_posting,
--      DEFERRABLE INITIALLY DEFERRED): checked at commit, so routes that write the posting first and the link afterwards
--      inside one transaction (A1, RPC 41, 0086–0090 classifications) keep working. The function is SECURITY DEFINER (it
--      must see links whatever the committing role's RLS) and nobody can EXECUTE it directly.
--      Named historical exception: the cutover opening balance (operations whose source_entity_type is 'phase31_opening',
--      written only by the Phase 31 cutover runner) — so a full rebuild / rehearsal keeps working.
--   3. mp_admin_correction(p_amount, p_effective_date, p_reason, p_evidence_ref, p_idempotency_key) — SECURITY DEFINER,
--      ADMIN: an exceptional, signed ADJUSTMENT on Mercado Pago with its exception row and an audit event. Not a normal flow.
-- Existing rows are not touched (the trigger fires on new postings only). SECURITY DEFINER set 85 → 87.
-- ============================================================================

CREATE TABLE mp_source_exception (
  id                     BIGSERIAL PRIMARY KEY,
  financial_operation_id BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  kind                   VARCHAR(30) NOT NULL,
  amount                 NUMERIC(15,2) NOT NULL CHECK (amount <> 0),
  reason                 TEXT        NOT NULL CHECK (btrim(reason) <> ''),
  evidence_ref           TEXT        NOT NULL CHECK (btrim(evidence_ref) <> ''),
  created_by             UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_mse_kind CHECK (kind IN ('ADMIN_CORRECTION', 'COLLECTION_CORRECTION'))
);
ALTER TABLE mp_source_exception ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_mp_source_exception_immutable
  BEFORE UPDATE OR DELETE ON mp_source_exception
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE mp_source_exception FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE mp_source_exception TO authenticated;
REVOKE ALL ON SEQUENCE mp_source_exception_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY mp_source_exception_admin_select ON mp_source_exception
  FOR SELECT USING (current_app_role() = 'ADMIN');

CREATE OR REPLACE FUNCTION mp_account_posting_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM financial_account a WHERE a.id = NEW.financial_account_id AND a.nombre = 'Mercado Pago' AND a.account_type = 'EXTERNAL_SERVICE')
     AND NOT EXISTS (SELECT 1 FROM mp_reconciliation r WHERE r.financial_operation_id = NEW.financial_operation_id)
     AND NOT EXISTS (SELECT 1 FROM mp_source_exception e WHERE e.financial_operation_id = NEW.financial_operation_id)
     AND NOT EXISTS (SELECT 1 FROM financial_operation o WHERE o.id = NEW.financial_operation_id AND o.source_entity_type = 'phase31_opening') THEN
    RAISE EXCEPTION 'MP_POSTING_REQUIRES_SOURCE: operation % moves Mercado Pago without a Mercado Pago movement (SOURCE_ID) or an audited exception',
      NEW.financial_operation_id;
  END IF;
  RETURN NULL;
END;
$$;
ALTER FUNCTION mp_account_posting_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_account_posting_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE CONSTRAINT TRIGGER trg_mp_account_posting_source
  AFTER INSERT ON financial_posting
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION mp_account_posting_guard();

CREATE OR REPLACE FUNCTION mp_admin_correction(
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_reason          TEXT,
  p_evidence_ref    TEXT,
  p_idempotency_key VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_mp  UUID;
  v_ref TEXT;
  v_op  BIGINT;
  v_ex  mp_source_exception%ROWTYPE;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_amount IS NULL OR p_amount = 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'DATE_REQUIRED';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_evidence_ref IS NULL OR btrim(p_evidence_ref) = '' THEN
    RAISE EXCEPTION 'EVIDENCE_REQUIRED: an evidence reference is required for a Mercado Pago correction';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 70 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 70 characters required';
  END IF;
  v_ref := 'MP-ADMIN-CORRECTION:' || p_idempotency_key;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_ref, 0));
  SELECT e.* INTO v_ex FROM mp_source_exception e JOIN financial_operation o ON o.id = e.financial_operation_id WHERE o.external_ref = v_ref;
  IF FOUND THEN
    IF v_ex.amount = p_amount AND (SELECT effective_date FROM financial_operation WHERE id = v_ex.financial_operation_id) = p_effective_date THEN
      RETURN jsonb_build_object('financial_operation_id', v_ex.financial_operation_id, 'exception_id', v_ex.id, 'replayed', true);
    END IF;
    RAISE EXCEPTION 'DUPLICATE_CORRECTION: % already exists with other values', v_ref;
  END IF;
  SELECT id INTO v_mp FROM financial_account WHERE nombre = 'Mercado Pago' AND account_type = 'EXTERNAL_SERVICE' AND activo;
  IF v_mp IS NULL THEN
    RAISE EXCEPTION 'MP_ACCOUNT_MISSING';
  END IF;
  PERFORM assert_period_open(p_effective_date);

  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', p_effective_date, v_ref, 'mp_source_exception', p_idempotency_key, p_reason, v_uid)
  RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_mp, p_amount, p_effective_date, v_uid);
  INSERT INTO mp_source_exception (financial_operation_id, kind, amount, reason, evidence_ref, created_by)
  VALUES (v_op, 'ADMIN_CORRECTION', p_amount, p_reason, p_evidence_ref, v_uid)
  RETURNING * INTO v_ex;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('mp_source_exception', v_ex.id::TEXT, 'MP_ADMIN_CORRECTION',
          jsonb_build_object('amount', p_amount, 'effective_date', p_effective_date, 'evidence_ref', p_evidence_ref, 'financial_operation', v_op), p_reason, v_uid);
  RETURN jsonb_build_object('financial_operation_id', v_op, 'exception_id', v_ex.id, 'replayed', false);
END;
$$;
ALTER FUNCTION mp_admin_correction(NUMERIC, DATE, TEXT, TEXT, VARCHAR) OWNER TO postgres;
REVOKE ALL     ON FUNCTION mp_admin_correction(NUMERIC, DATE, TEXT, TEXT, VARCHAR) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION mp_admin_correction(NUMERIC, DATE, TEXT, TEXT, VARCHAR) TO authenticated;
