-- ============================================================================
-- TARGET V1 — 0052 MERCADO PAGO AUTO-APPLICABLE HELPER SCOPE (ADR-006, pre-Step-8 alignment)
-- Authority: ADR006_RPC_CONTRACTS_V1 A1 "Supported kinds" (commit e3f493d);
--            ADR006_V2_PAYMENT_FIELD_EVIDENCE §15.1 (refunds fail closed); V-3 (chargeback /
--            account-tax report rows unobserved); V-4 direction correction (outbound never auto).
--
-- Redefines ONLY mp_is_auto_applicable. It now returns true only for the kinds A1 applies:
--   payment / APPROVAL, yield / YIELD.
-- refund / REFUND, chargeback / CHARGEBACK and account_tax / ACCOUNT_TAX are deferred until
-- evidence + an explicit amendment; transfer / PAYOUT and outbound-payment classifications are
-- never auto. Consumers: mp_apply_transition (NOT_AUTO_APPLICABLE for everything else) and the
-- RPC 41 AUTO_APPLICATION_PENDING guard. Still SECURITY INVOKER, owner-only EXECUTE.
-- ============================================================================

CREATE OR REPLACE FUNCTION mp_is_auto_applicable(p_movement_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM mp_financial_movement m
      JOIN mp_transition_identity t ON t.mp_financial_movement_id = m.id
     WHERE m.id = p_movement_id
       AND (m.movement_kind, t.transition) IN (('payment', 'APPROVAL'), ('yield', 'YIELD')))
$$;

ALTER FUNCTION mp_is_auto_applicable(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION mp_is_auto_applicable(BIGINT) FROM PUBLIC, anon, authenticated, service_role;
