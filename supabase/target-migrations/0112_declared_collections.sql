-- ============================================================================
-- TARGET V1 — 0112 COBROS DECLARADOS DE MERCADO PAGO (ADR-027, owner GO Lote 5, 2026-11-02)
--
-- A client says it paid by Mercado Pago: the collection lowers its current account and nothing else. The money enters the ERP only
-- through the usual Mercado Pago import; a declared collection is never linked to an individual movement.
--   1. declared_collection (one per declaration) / declared_collection_reversal (one per annulled or rectified declaration): immutable.
--      A declaration writes client_ledger COLLECTION −amount. No financial_operation, no financial_posting, no MP table: the Mercado
--      Pago balance cannot change. A negative client balance is a credit, as with every collection.
--   2. register_declared_collection / reverse_declared_collection / rectify_declared_collection (ADMIN, idempotent, audited): an
--      annulment writes client_ledger REVERSAL +amount at the original date; a rectification does that and a new declaration, in one
--      transaction. Both respect closed periods. They read and write nothing in collections / collection_reversal, whose contract
--      (a real financial operation) stays as it is.
--   3. fin_customer_collections: the declarations are appended as origin DECLARED_MP, status DECLARED / ANNULLED / RECTIFIED, no
--      operation, account_type DECLARED, so no reader can take them for money. The two existing branches are unchanged.
--   4. No double discount: trg_mp_client_allocation_manual_guard refuses a NEW manual client allocation of a Mercado Pago movement
--      (MP_CLIENT_ALLOCATION_DISABLED). That is the single door of mp_allocate_to_client and of
--      mp_classify_inflow_as_collection with a client; the classification without a client still works. Not refused: reversals of
--      existing allocations (mp_reverse_client_allocation), the historical correction mp_correct_manual_collection (net zero on
--      the client) and AUTO (mp_auto_allocate: production has no active mapping; refusing it would abort the worker's item, so it
--      stays as it is and the UI no longer creates mappings).
-- No existing row, function, table or period rule changes. Period close: only outflows block it (0095), so nothing here touches it.
-- SECURITY DEFINER set +5 (3 RPC + 2 internal cores no API role can execute).
-- ============================================================================

CREATE TABLE declared_collection (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id       UUID          NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount           NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  effective_date   DATE          NOT NULL,
  note             TEXT          CHECK (note IS NULL OR btrim(note) <> ''),
  client_ledger_id BIGINT        NOT NULL UNIQUE REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key  VARCHAR(100)  NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  created_by       UUID          REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX idx_declared_collection_cliente_date ON declared_collection(cliente_id, effective_date);

CREATE TABLE declared_collection_reversal (
  id                        BIGSERIAL PRIMARY KEY,
  declared_collection_id    UUID          NOT NULL UNIQUE REFERENCES declared_collection(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  kind                      VARCHAR(10)   NOT NULL CHECK (kind IN ('ANNUL', 'RECTIFY')),
  amount                    NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  client_reversal_ledger_id BIGINT        NOT NULL UNIQUE REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  replacement_id            UUID          UNIQUE REFERENCES declared_collection(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key           VARCHAR(100)  NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  reason                    TEXT          NOT NULL CHECK (btrim(reason) <> ''),
  created_by                UUID          REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_dcr_kind_replacement CHECK ((kind = 'RECTIFY') = (replacement_id IS NOT NULL)),
  CONSTRAINT chk_dcr_not_self CHECK (replacement_id IS DISTINCT FROM declared_collection_id)
);

CREATE TRIGGER trg_declared_collection_immutable BEFORE UPDATE OR DELETE ON declared_collection
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
CREATE TRIGGER trg_declared_collection_reversal_immutable BEFORE UPDATE OR DELETE ON declared_collection_reversal
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
ALTER TABLE declared_collection          ENABLE ROW LEVEL SECURITY;
ALTER TABLE declared_collection_reversal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE declared_collection, declared_collection_reversal FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE declared_collection, declared_collection_reversal TO authenticated;
REVOKE ALL ON SEQUENCE declared_collection_reversal_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY declared_collection_admin_select ON declared_collection FOR SELECT USING (current_app_role() = 'ADMIN');
CREATE POLICY declared_collection_reversal_admin_select ON declared_collection_reversal FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── shared core: one declaration (not callable by any API role) ─────────────
CREATE OR REPLACE FUNCTION declared_collection_new(
  p_cliente_id      UUID,
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_note            TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_client TEXT;
  v_id     UUID := gen_random_uuid();
  v_ledger BIGINT;
  v_note   TEXT := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE';
  END IF;
  SELECT nombre INTO v_client FROM clients WHERE id = p_cliente_id AND activo;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'CLIENT_NOT_FOUND_OR_INACTIVE';
  END IF;
  PERFORM assert_period_open(p_effective_date);

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (p_cliente_id, 'COLLECTION', -p_amount, p_effective_date, v_client, 'declared_collection', v_id::TEXT, v_note, v_uid)
  RETURNING id INTO v_ledger;
  INSERT INTO declared_collection (id, cliente_id, amount, effective_date, note, client_ledger_id, idempotency_key, created_by)
  VALUES (v_id, p_cliente_id, p_amount, p_effective_date, v_note, v_ledger, p_idempotency_key, v_uid);
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('declared_collection', v_id::TEXT, 'DECLARE_COLLECTION',
          jsonb_build_object('cliente_id', p_cliente_id, 'amount', p_amount, 'effective_date', p_effective_date, 'client_ledger_id', v_ledger),
          v_note, v_uid);
  RETURN jsonb_build_object('replayed', false, 'declared_collection_id', v_id, 'client_ledger_id', v_ledger);
END;
$$;
ALTER FUNCTION declared_collection_new(UUID, NUMERIC, DATE, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION declared_collection_new(UUID, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── Registrar cobro declarado ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION register_declared_collection(
  p_cliente_id      UUID,
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_note            TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row declared_collection%ROWTYPE;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) > 100 OR p_idempotency_key LIKE 'DECLARED-RECTIFY:%' THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters, no reserved prefix';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('declared_collection:' || p_idempotency_key, 0));
  SELECT * INTO v_row FROM declared_collection WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_row.cliente_id = p_cliente_id AND v_row.amount = p_amount AND v_row.effective_date = p_effective_date THEN
      RETURN jsonb_build_object('replayed', true, 'declared_collection_id', v_row.id, 'client_ledger_id', v_row.client_ledger_id);
    END IF;
    RAISE EXCEPTION 'DUPLICATE_IDEMPOTENCY_KEY';
  END IF;
  RETURN declared_collection_new(p_cliente_id, p_amount, p_effective_date, p_note, p_idempotency_key);
END;
$$;
ALTER FUNCTION register_declared_collection(UUID, NUMERIC, DATE, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION register_declared_collection(UUID, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION register_declared_collection(UUID, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

-- ── shared core: undo a declaration in client_ledger (not callable by any API role) ──
-- Returns the stored row when this exact request was already done (replay).
CREATE OR REPLACE FUNCTION declared_collection_undo(
  p_id              UUID,
  p_kind            TEXT,
  p_reason          TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_row    declared_collection_reversal%ROWTYPE;
  v_d      declared_collection%ROWTYPE;
  v_client TEXT;
  v_ledger BIGINT;
BEGIN
  IF current_app_role() IS DISTINCT FROM 'ADMIN' THEN
    RAISE EXCEPTION 'FORBIDDEN: ADMIN required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' OR length(p_idempotency_key) > 100 THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY: 1 to 100 characters';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('declared_collection_reversal:' || p_id::TEXT, 0));

  SELECT * INTO v_row FROM declared_collection_reversal WHERE declared_collection_id = p_id;
  IF FOUND THEN
    IF v_row.idempotency_key = p_idempotency_key AND v_row.kind = p_kind THEN
      RETURN jsonb_build_object('replayed', true, 'reversal_id', v_row.id, 'client_reversal_ledger_id', v_row.client_reversal_ledger_id, 'replacement_id', v_row.replacement_id);
    END IF;
    RAISE EXCEPTION 'ALREADY_REVERSED: declared collection % was already annulled or rectified', p_id;
  END IF;
  IF EXISTS (SELECT 1 FROM declared_collection_reversal WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_IDEMPOTENCY_KEY';
  END IF;

  SELECT * INTO v_d FROM declared_collection WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_NOT_FOUND';
  END IF;
  PERFORM assert_period_open(v_d.effective_date);
  SELECT nombre INTO v_client FROM clients WHERE id = v_d.cliente_id;

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, source_entity_id, reversal_of_id, reason, created_by)
  VALUES (v_d.cliente_id, 'REVERSAL', v_d.amount, v_d.effective_date, v_client, 'declared_collection_reversal', v_d.id::TEXT, v_d.client_ledger_id, p_reason, v_uid)
  RETURNING id INTO v_ledger;
  RETURN jsonb_build_object('replayed', false, 'client_reversal_ledger_id', v_ledger, 'amount', v_d.amount, 'cliente_id', v_d.cliente_id, 'effective_date', v_d.effective_date);
END;
$$;
ALTER FUNCTION declared_collection_undo(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION declared_collection_undo(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── Anular cobro declarado ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reverse_declared_collection(p_id UUID, p_reason TEXT, p_idempotency_key TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_core JSONB;
  v_id   BIGINT;
BEGIN
  v_core := declared_collection_undo(p_id, 'ANNUL', p_reason, p_idempotency_key);
  IF (v_core ->> 'replayed')::BOOLEAN THEN
    RETURN v_core;
  END IF;
  INSERT INTO declared_collection_reversal (declared_collection_id, kind, amount, client_reversal_ledger_id, idempotency_key, reason, created_by)
  VALUES (p_id, 'ANNUL', (v_core ->> 'amount')::NUMERIC, (v_core ->> 'client_reversal_ledger_id')::BIGINT, p_idempotency_key, btrim(p_reason), v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('declared_collection_reversal', v_id::TEXT, 'ANNUL_DECLARED_COLLECTION',
          jsonb_build_object('declared_collection_id', p_id, 'amount', v_core -> 'amount', 'client_reversal_ledger_id', v_core -> 'client_reversal_ledger_id'), p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'reversal_id', v_id, 'client_reversal_ledger_id', v_core -> 'client_reversal_ledger_id', 'replacement_id', NULL);
END;
$$;
ALTER FUNCTION reverse_declared_collection(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION reverse_declared_collection(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION reverse_declared_collection(UUID, TEXT, TEXT) TO authenticated;

-- ── Rectificar cobro declarado ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rectify_declared_collection(
  p_id              UUID,
  p_cliente_id      UUID,
  p_amount          NUMERIC,
  p_effective_date  DATE,
  p_reason          TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  UUID := auth.uid();
  v_core JSONB;
  v_res  JSONB;
  v_new  UUID;
  v_id   BIGINT;
BEGIN
  v_core := declared_collection_undo(p_id, 'RECTIFY', p_reason, p_idempotency_key);
  IF (v_core ->> 'replayed')::BOOLEAN THEN
    RETURN v_core;
  END IF;
  IF p_cliente_id = (v_core ->> 'cliente_id')::UUID AND p_amount = (v_core ->> 'amount')::NUMERIC AND p_effective_date = (v_core ->> 'effective_date')::DATE THEN
    RAISE EXCEPTION 'NOTHING_TO_RECTIFY: the corrected collection is identical to the original';
  END IF;

  v_res := declared_collection_new(p_cliente_id, p_amount, p_effective_date, p_reason, 'DECLARED-RECTIFY:' || p_id);
  v_new := (v_res ->> 'declared_collection_id')::UUID;
  INSERT INTO declared_collection_reversal (declared_collection_id, kind, amount, client_reversal_ledger_id, replacement_id, idempotency_key, reason, created_by)
  VALUES (p_id, 'RECTIFY', (v_core ->> 'amount')::NUMERIC, (v_core ->> 'client_reversal_ledger_id')::BIGINT, v_new, p_idempotency_key, btrim(p_reason), v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('declared_collection_reversal', v_id::TEXT, 'RECTIFY_DECLARED_COLLECTION',
          jsonb_build_object('declared_collection_id', p_id, 'amount', v_core -> 'amount', 'client_reversal_ledger_id', v_core -> 'client_reversal_ledger_id',
                             'replacement_id', v_new, 'new_amount', p_amount, 'new_cliente_id', p_cliente_id, 'new_effective_date', p_effective_date), p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'reversal_id', v_id, 'client_reversal_ledger_id', v_core -> 'client_reversal_ledger_id', 'replacement_id', v_new);
END;
$$;
ALTER FUNCTION rectify_declared_collection(UUID, UUID, NUMERIC, DATE, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_declared_collection(UUID, UUID, NUMERIC, DATE, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_declared_collection(UUID, UUID, NUMERIC, DATE, TEXT, TEXT) TO authenticated;

-- ── Cobros de clientes: the 0109 view, plus the declarations ([0112] marks every change; existing columns and branches unchanged) ──
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
), declared AS (                                                                   -- [0112] ADR-027
  SELECT 'D:' || d.id::TEXT AS row_id, d.effective_date AS business_date, d.created_at, d.cliente_id, cl.nombre::TEXT AS client_name, d.amount,
         d.note AS notes, r.kind AS reversal_kind, r.reason AS reversal_reason, r.created_at AS reversal_at,
         CASE WHEN rep.declared_collection_id IS NOT NULL THEN 'D:' || rep.declared_collection_id::TEXT END AS replacement_of,
         d.created_by AS registered_by, r.created_by AS reversal_by
    FROM declared_collection d
    JOIN clients cl ON cl.id = d.cliente_id
    LEFT JOIN declared_collection_reversal r ON r.declared_collection_id = d.id
    LEFT JOIN declared_collection_reversal rep ON rep.replacement_id = d.id
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
UNION ALL                                                                          -- [0112] no operation, no MP movement: never money
SELECT row_id, business_date, created_at, cliente_id, client_name, amount, 'Mercado Pago'::TEXT, 'DECLARED'::TEXT, 'MERCADOPAGO'::TEXT, notes,
       NULL::BIGINT, NULL::TEXT, 'DECLARED_MP'::TEXT,
       CASE reversal_kind WHEN 'ANNUL' THEN 'ANNULLED' WHEN 'RECTIFY' THEN 'RECTIFIED' ELSE 'DECLARED' END,
       NULL::BIGINT, 'SINGLE'::TEXT, reversal_kind IS NULL,
       reversal_kind::TEXT, reversal_reason, reversal_at, replacement_of, NULL::UUID, registered_by, reversal_by
  FROM declared
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_customer_collections OWNER TO postgres;
REVOKE ALL    ON fin_customer_collections FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_customer_collections TO authenticated;

-- ── no double discount: no new manual client allocation of a Mercado Pago movement ──
CREATE OR REPLACE FUNCTION client_allocation_manual_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.origin = 'ALLOCATION' AND NEW.mode = 'MANUAL'
     AND NOT (NEW.idempotency_key LIKE 'COLLECTION-CORRECTION-MP:%'     -- 0092: re-expresses a client collection that already counted (net zero)
              AND EXISTS (SELECT 1 FROM collections c WHERE 'COLLECTION-CORRECTION-MP:' || c.id = NEW.idempotency_key AND c.cliente_id = NEW.cliente_id)) THEN
    RAISE EXCEPTION 'MP_CLIENT_ALLOCATION_DISABLED: a Mercado Pago collection is declared from Cuentas corrientes, never assigned to a movement (ADR-027)';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION client_allocation_manual_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION client_allocation_manual_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_mp_client_allocation_manual_guard
  BEFORE INSERT ON mp_client_allocation
  FOR EACH ROW EXECUTE FUNCTION client_allocation_manual_guard();
