-- ============================================================================
-- TARGET V1 — 0113 HISTORIAL FINANCIERO UNIFICADO (owner GO 2026-11-02)
--
-- Caja → Movimientos reads every financial operation once, from the first one, with real pagination. Read only: no table, column,
-- row, posting, balance or existing function changes, and nothing is written (STABLE).
--   1. fin_movement_class (internal, no API role can execute it): the kind and the user-facing name of an operation, from its type
--      and external_ref. One place, so the filter, the search and the screen agree. MP-PENDING, MP-PENDING-RELEASE and
--      EXPENSE-PENDING keep the names the account detail already shows.
--   2. fin_movement_history (RPC, ADMIN, SECURITY DEFINER): one row per financial_operation holding at least one posting (in the
--      account, when one is chosen), newest first by effective_date, then id (stable across pages), with the total of the filter
--      and each operation's postings and accounts. Filters: period, account, kind; search: name, reason, external_ref, operation
--      number, and the amount of any of its postings. Page size at most 100.
-- A declared Mercado Pago collection (ADR-027) and an unpaid obligation (ADR-026) have no financial_operation: they cannot appear.
-- A transfer is one operation with two postings: one row. The sum of an account's rows is that account's balance (Σ posting).
-- SECURITY DEFINER because financial_operation and financial_posting evaluate current_app_role() per row under RLS (the cost 0105
-- removed from the pending views); the ADMIN check runs once, first, and is the same rule those policies state.
-- SECURITY DEFINER set +1.
-- ============================================================================

CREATE FUNCTION fin_movement_class(p_type TEXT, p_ref TEXT, OUT kind TEXT, OUT label TEXT)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      WHEN p_ref LIKE 'MP-PENDING%' THEN 'PENDIENTE_MP'
      WHEN p_type = 'TRANSFER' THEN 'TRANSFERENCIA'
      WHEN p_ref LIKE 'MP-INBOUND-RECLASS:%' THEN 'OTRO'
      WHEN p_type IN ('COLLECTION', 'MP_SETTLEMENT', 'CHEQUE_CLEAR') THEN 'COBRO'
      WHEN p_type IN ('SUPPLIER_PAYMENT', 'PURCHASE_PAYMENT', 'FREIGHT_PAYMENT', 'INSTRUMENT_DEBIT', 'FISCAL_PAYMENT') THEN 'PAGO'
      WHEN p_type IN ('BANK_TAX', 'FEE') OR p_ref LIKE 'MP-OUTFLOW-TAX:%' OR (p_type = 'ADJUSTMENT' AND p_ref LIKE 'MP:%') THEN 'CARGO'
      ELSE 'OTRO'
    END,
    CASE
      WHEN p_ref LIKE 'MP-PENDING-RELEASE:%' THEN 'Clasificación de salida'
      WHEN p_ref LIKE 'MP-PENDING:%' THEN 'Pendiente de clasificar'
      WHEN p_ref LIKE 'EXPENSE-PENDING:%' THEN 'Gasto (sin clasificar al registrarse)'
      WHEN p_ref LIKE 'MP-INBOUND-RECLASS:%' THEN 'Reclasificación de entrada Mercado Pago'
      WHEN p_ref LIKE 'MP-OUTFLOW-TAX:%' THEN 'Impuesto Débitos/Créditos (Mercado Pago)'
      WHEN p_type = 'ADJUSTMENT' AND p_ref LIKE 'MP:%' THEN 'Impuesto de Mercado Pago'
      WHEN p_ref LIKE 'COLLECTION-CORRECTION%' THEN 'Corrección de cobro'
      WHEN p_ref LIKE 'PHASE31-OPENING%' THEN 'Saldo inicial'
      WHEN p_ref LIKE 'MP-HIST-OPENING-NEUTRALIZATION:%' THEN 'Neutralización de saldo inicial'
      WHEN p_type = 'TRANSFER' THEN 'Transferencia'
      WHEN p_type = 'FEE' THEN 'Comisión'
      WHEN p_type = 'COLLECTION' THEN 'Cobro'
      WHEN p_type = 'CHEQUE_CLEAR' THEN 'Cheque acreditado'
      WHEN p_type = 'CHEQUE_REJECTION' THEN 'Cheque rechazado'
      WHEN p_type = 'SUPPLIER_PAYMENT' THEN 'Pago a proveedor'
      WHEN p_type = 'PURCHASE_PAYMENT' THEN 'Pago de compra'
      WHEN p_type = 'FREIGHT_PAYMENT' THEN 'Pago de flete'
      WHEN p_type = 'INSTRUMENT_DEBIT' THEN 'Cheque debitado'
      WHEN p_type = 'INSTRUMENT_DEBIT_REVERSAL' THEN 'Reversión de cheque debitado'
      WHEN p_type = 'FISCAL_PAYMENT' THEN 'Pago fiscal'
      WHEN p_type = 'SESSION_CASH' THEN 'Efectivo de feria'
      WHEN p_type = 'MP_SETTLEMENT' THEN 'Cobro Mercado Pago'
      WHEN p_type = 'OWNER_WITHDRAWAL' THEN 'Retiro de socios'
      WHEN p_type = 'BANK_TAX' THEN 'Impuesto bancario'
      WHEN p_type = 'ADJUSTMENT' THEN 'Ajuste'
      ELSE p_type
    END;
$$;
ALTER  FUNCTION fin_movement_class(TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_movement_class(TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION fin_movement_history(
  p_from       DATE    DEFAULT NULL,
  p_to         DATE    DEFAULT NULL,
  p_account_id UUID    DEFAULT NULL,
  p_kind       TEXT    DEFAULT NULL,
  p_search     TEXT    DEFAULT NULL,
  p_amount     NUMERIC DEFAULT NULL,
  p_limit      INTEGER DEFAULT 50,
  p_offset     INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search TEXT := nullif(btrim(p_search), '');
  v_like   TEXT;
  v_amount NUMERIC := abs(p_amount);
  v_out    JSONB;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'INVALID_LIMIT: 1 to 100';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'INVALID_OFFSET';
  END IF;
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN
    RAISE EXCEPTION 'INVALID_RANGE: from after to';
  END IF;
  IF p_kind IS NOT NULL AND p_kind NOT IN ('TRANSFERENCIA', 'COBRO', 'PAGO', 'CARGO', 'PENDIENTE_MP', 'OTRO') THEN
    RAISE EXCEPTION 'INVALID_KIND';
  END IF;
  IF length(v_search) > 100 THEN
    RAISE EXCEPTION 'INVALID_SEARCH: at most 100 characters';
  END IF;
  -- what the user typed is text, never a pattern
  v_like := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  WITH f AS MATERIALIZED (
    SELECT o.id, o.effective_date, o.operation_type::TEXT AS operation_type, o.external_ref, o.reason, o.source_entity_type,
           o.created_at, o.created_by, c.kind, c.label
      FROM financial_operation o
     CROSS JOIN LATERAL fin_movement_class(o.operation_type::TEXT, o.external_ref) c
     WHERE (p_from IS NULL OR o.effective_date >= p_from)
       AND (p_to IS NULL OR o.effective_date <= p_to)
       AND (p_kind IS NULL OR c.kind = p_kind)
       AND EXISTS (SELECT 1 FROM financial_posting p
                    WHERE p.financial_operation_id = o.id AND (p_account_id IS NULL OR p.financial_account_id = p_account_id))
       AND ((v_search IS NULL AND v_amount IS NULL)
         OR (v_search IS NOT NULL AND (c.label ILIKE v_like OR o.reason ILIKE v_like OR o.external_ref ILIKE v_like OR o.id::TEXT = v_search))
         OR (v_amount IS NOT NULL AND EXISTS (SELECT 1 FROM financial_posting p
                    WHERE p.financial_operation_id = o.id AND abs(p.signed_amount) = v_amount
                      AND (p_account_id IS NULL OR p.financial_account_id = p_account_id))))
  ), page AS (
    SELECT * FROM f ORDER BY effective_date DESC, id DESC LIMIT p_limit OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'operation_id', g.id, 'effective_date', g.effective_date, 'kind', g.kind, 'label', g.label, 'operation_type', g.operation_type,
               'reason', g.reason, 'external_ref', g.external_ref, 'source_entity_type', g.source_entity_type,
               'created_at', g.created_at, 'created_by', g.created_by,
               'net_amount', m.net_amount, 'moved_amount', m.moved_amount, 'postings', m.postings) ORDER BY g.effective_date DESC, g.id DESC)
        FROM page g
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(p.signed_amount) FILTER (WHERE p_account_id IS NULL OR p.financial_account_id = p_account_id), 0) AS net_amount,
                greatest(coalesce(sum(p.signed_amount) FILTER (WHERE p.signed_amount > 0), 0), abs(coalesce(sum(p.signed_amount) FILTER (WHERE p.signed_amount < 0), 0))) AS moved_amount,
                jsonb_agg(jsonb_build_object('posting_id', p.id, 'account_id', a.id, 'account_name', a.nombre, 'signed_amount', p.signed_amount) ORDER BY p.signed_amount, p.id) AS postings
           FROM financial_posting p JOIN financial_account a ON a.id = p.financial_account_id
          WHERE p.financial_operation_id = g.id) m), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END;
$$;
ALTER  FUNCTION fin_movement_history(DATE, DATE, UUID, TEXT, TEXT, NUMERIC, INTEGER, INTEGER) OWNER TO postgres;
REVOKE ALL     ON FUNCTION fin_movement_history(DATE, DATE, UUID, TEXT, TEXT, NUMERIC, INTEGER, INTEGER) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION fin_movement_history(DATE, DATE, UUID, TEXT, TEXT, NUMERIC, INTEGER, INTEGER) TO authenticated;
