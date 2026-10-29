-- ============================================================================
-- TARGET V1 — 0109 NOMBRE Y APELLIDO DE USUARIOS (Lote 2A, owner GO 2026-10-29)
--
-- Master data only: no financial operation, no ledger, no P&L, no change to authentication, roles, permissions or history.
--   1. perfiles gains nombre / apellido, both optional (NULL = not loaded → the ERP shows "No disponible", never the e-mail).
--      Stored trimmed, non-empty, without control characters, at most 80 characters. Existing rows untouched (NULL).
--      Privileges unchanged: authenticated keeps SELECT only (rows still filtered by RLS: ADMIN every row, others their own);
--      no write privilege is granted on perfiles (no self-escalation, 0007).
--   2. set_profile_name(p_profile_id, p_nombre, p_apellido) — SECURITY DEFINER, ADMIN only: sets exactly these two columns of
--      an existing profile (blank → NULL), never rol_type / activo / email; audited (audit_events SET_NAME, before / after names).
--   3. fin_customer_collections: two columns appended — registered_by (collections.created_by / mp_client_allocation.created_by)
--      and reversal_by (collection_reversal.created_by) — the user ids already stored, so the ERP can name who registered and who
--      annulled / rectified a collection. Existing columns unchanged.
-- SECURITY DEFINER set +1.
-- ============================================================================

ALTER TABLE perfiles
  ADD COLUMN nombre   VARCHAR(80),
  ADD COLUMN apellido VARCHAR(80),
  ADD CONSTRAINT chk_perfiles_nombre CHECK (nombre IS NULL OR (nombre <> '' AND nombre = btrim(nombre) AND nombre !~ '[[:cntrl:]]')),
  ADD CONSTRAINT chk_perfiles_apellido CHECK (apellido IS NULL OR (apellido <> '' AND apellido = btrim(apellido) AND apellido !~ '[[:cntrl:]]'));
COMMENT ON COLUMN perfiles.nombre IS 'First name shown as the person responsible for an operation (0109); NULL = not loaded';
COMMENT ON COLUMN perfiles.apellido IS 'Last name shown as the person responsible for an operation (0109); NULL = not loaded';

-- ── set_profile_name (ADMIN) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_profile_name(
  p_profile_id UUID,
  p_nombre     TEXT,
  p_apellido   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_nombre   TEXT := nullif(btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g')), '');
  v_apellido TEXT := nullif(btrim(regexp_replace(coalesce(p_apellido, ''), '\s+', ' ', 'g')), '');
  v_old      perfiles%ROWTYPE;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF length(v_nombre) > 80 OR length(v_apellido) > 80 THEN
    RAISE EXCEPTION 'NAME_TOO_LONG: at most 80 characters';
  END IF;
  IF v_nombre ~ '[[:cntrl:]]' OR v_apellido ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'INVALID_NAME';
  END IF;
  SELECT * INTO v_old FROM perfiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND';
  END IF;
  IF v_old.nombre IS NOT DISTINCT FROM v_nombre AND v_old.apellido IS NOT DISTINCT FROM v_apellido THEN
    RETURN jsonb_build_object('profile_id', p_profile_id, 'changed', false);
  END IF;
  UPDATE perfiles SET nombre = v_nombre, apellido = v_apellido, updated_at = now() WHERE id = p_profile_id;
  INSERT INTO audit_events (entity_type, entity_id, action, before_values, after_values, reason, performed_by)
  VALUES ('perfiles', p_profile_id::TEXT, 'SET_NAME',
          jsonb_build_object('nombre', v_old.nombre, 'apellido', v_old.apellido),
          jsonb_build_object('nombre', v_nombre, 'apellido', v_apellido), NULL, v_uid);
  RETURN jsonb_build_object('profile_id', p_profile_id, 'changed', true);
END;
$$;
ALTER FUNCTION set_profile_name(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION set_profile_name(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION set_profile_name(UUID, TEXT, TEXT) TO authenticated;

-- ── Cobros de clientes: the 0108 view, plus who registered / annulled-rectified ([0109] marks every change) ──
CREATE OR REPLACE VIEW fin_customer_collections
WITH (security_invoker = true)
AS
WITH manual AS (
  SELECT 'C:' || c.id::TEXT AS row_id, c.effective_date AS business_date, c.created_at, c.cliente_id, cl.nombre::TEXT AS client_name,
         c.amount, a.nombre::TEXT AS account_name, a.account_type::TEXT AS account_type, c.payment_method::TEXT AS payment_method,
         o.reason AS notes, o.id AS financial_operation_id, NULL::TEXT AS source_id,
         cc_orig.id AS corrected_by, cc_comp.id AS component_of,
         cr.kind AS reversal_kind, cr.reason AS reversal_reason, cr.created_at AS reversal_at,
         CASE WHEN cr_rep.collection_id IS NOT NULL THEN 'C:' || cr_rep.collection_id::TEXT END AS replacement_of,
         c.sales_session_id,                                                       -- [0108] Feria
         c.created_by AS registered_by, cr.created_by AS reversal_by,              -- [0109] who registered / annulled-rectified
         EXISTS (SELECT 1 FROM financial_posting p JOIN fin_statement_match m ON m.financial_posting_id = p.id AND m.reversed_at IS NULL
                  WHERE p.financial_operation_id = o.id) AS bank_matched
    FROM collections c
    JOIN clients cl ON cl.id = c.cliente_id
    JOIN financial_account a ON a.id = c.financial_account_id
    LEFT JOIN financial_operation o ON o.operation_type = 'COLLECTION' AND o.source_entity_type = 'collections' AND o.source_entity_id = c.id::TEXT
    LEFT JOIN collection_correction cc_orig ON cc_orig.collection_id = c.id
    LEFT JOIN collection_correction cc_comp ON cc_comp.cash_collection_id = c.id
    LEFT JOIN collection_reversal cr ON cr.collection_id = c.id                      -- [0108]
    LEFT JOIN collection_reversal cr_rep ON cr_rep.replacement_collection_id = c.id  -- [0108]
), mp AS (
  SELECT 'A:' || al.id::TEXT AS row_id, al.effective_date AS business_date, al.created_at, al.cliente_id, cl.nombre::TEXT AS client_name,
         al.amount - coalesce((SELECT sum(-r.amount) FROM mp_client_allocation r WHERE r.reversal_of_id = al.id), 0) AS amount,
         'Mercado Pago'::TEXT AS account_name, 'EXTERNAL_SERVICE'::TEXT AS account_type, 'MERCADOPAGO'::TEXT AS payment_method,
         al.reason AS notes,
         (SELECT min(r.financial_operation_id) FROM mp_reconciliation r JOIN financial_operation o ON o.id = r.financial_operation_id
           WHERE r.mp_financial_movement_id = al.mp_financial_movement_id AND o.operation_type = 'MP_SETTLEMENT') AS financial_operation_id,
         t.resource_id::TEXT AS source_id, cc.id AS component_of,
         NULL::VARCHAR AS reversal_kind, NULL::TEXT AS reversal_reason, NULL::TIMESTAMPTZ AS reversal_at, NULL::TEXT AS replacement_of,
         NULL::UUID AS sales_session_id,
         al.created_by AS registered_by, NULL::UUID AS reversal_by                 -- [0109]
    FROM mp_client_allocation al
    JOIN clients cl ON cl.id = al.cliente_id
    JOIN mp_transition_identity t ON t.mp_financial_movement_id = al.mp_financial_movement_id
    LEFT JOIN collection_correction cc ON cc.client_allocation_id = al.id
   WHERE al.origin = 'ALLOCATION'
)
SELECT u.* FROM (
SELECT row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes,
       financial_operation_id, source_id,
       CASE WHEN component_of IS NOT NULL THEN 'CORRECTION'
            WHEN account_type = 'CASH' THEN 'CASH'
            WHEN account_type = 'BANK_ACCOUNT' THEN 'BANK'
            ELSE 'MANUAL_MP' END AS origin,
       CASE WHEN corrected_by IS NOT NULL THEN 'CORRECTED'
            WHEN reversal_kind = 'ANNUL' THEN 'ANNULLED'
            WHEN reversal_kind = 'RECTIFY' THEN 'RECTIFIED'
            WHEN account_type = 'EXTERNAL_SERVICE' THEN 'MANUAL_WITHOUT_SOURCE'
            WHEN account_type = 'BANK_ACCOUNT' AND bank_matched THEN 'CONCILIATED'
            WHEN account_type = 'BANK_ACCOUNT' THEN 'PENDING_RECONCILIATION'
            ELSE 'CASH' END AS status,
       coalesce(corrected_by, component_of) AS correction_id,
       CASE WHEN corrected_by IS NOT NULL THEN 'CORRECTED_ORIGINAL' WHEN component_of IS NOT NULL THEN 'COMPONENT' ELSE 'SINGLE' END AS correction_role,
       corrected_by IS NULL AND reversal_kind IS NULL AS counts_for_customer,
       reversal_kind::TEXT AS reversal_kind, reversal_reason, reversal_at, replacement_of, sales_session_id, registered_by, reversal_by
  FROM manual
UNION ALL
SELECT row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes,
       financial_operation_id, source_id,
       CASE WHEN component_of IS NOT NULL THEN 'CORRECTION' ELSE 'AUTO_MP' END AS origin,
       'ALLOCATED_TO_CUSTOMER' AS status,
       component_of AS correction_id,
       CASE WHEN component_of IS NOT NULL THEN 'COMPONENT' ELSE 'SINGLE' END AS correction_role,
       true AS counts_for_customer,
       reversal_kind::TEXT AS reversal_kind, reversal_reason, reversal_at, replacement_of, sales_session_id, registered_by, reversal_by
  FROM mp
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_customer_collections OWNER TO postgres;
REVOKE ALL    ON fin_customer_collections FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_customer_collections TO authenticated;
