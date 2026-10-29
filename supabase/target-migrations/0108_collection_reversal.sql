-- ============================================================================
-- TARGET V1 — 0108 ANULAR / RECTIFICAR COBROS EN EFECTIVO Y BANCOS (Lote 1E, owner GO 2026-10-29)
--
-- A manual collection on a CASH or BANK_ACCOUNT account (register_collection) is annulled or rectified APPEND-ONLY: the
-- original collection, its client_ledger COLLECTION, its COLLECTION operation and posting stay as evidence; their effect is
-- compensated, at the ORIGINAL effective date (no retroactive correction of a closed period: that period must be open).
--   reverse_collection(p_collection_id, p_reason, p_idempotency_key) — SECURITY DEFINER, ADMIN:
--     1. ADJUSTMENT operation 'COLLECTION-REVERSAL:<id>' with ONE posting −amount on the original account;
--     2. client_ledger REVERSAL +amount for the original client (source 'collection_reversal');
--     3. collection_reversal row (kind ANNUL) + audit_events.
--   rectify_collection(p_collection_id, p_cliente_id, p_amount, p_financial_account_id, p_effective_date, p_reason,
--                      p_idempotency_key) — SECURITY DEFINER, ADMIN: steps 1–2, then register_collection of the correct
--     collection (receipt 'COLLECTION-RECTIFY:<id>', method from the account: CASH / TRANSFER) and the collection_reversal row
--     (kind RECTIFY, replacement_collection_id). ONE transaction: any refusal rolls everything back.
-- Guards (each before any write): ADMIN; reason; idempotency key; one effective reversal per collection (UNIQUE collection_id;
--   the same key replays the stored result, any other call → ALREADY_REVERSED); serialised per collection (advisory lock +
--   FOR UPDATE on the collection and on its posting, the row fin_match_statement_line locks); CASH / BANK_ACCOUNT only (a
--   Mercado Pago collection keeps its own circuits: mp_reverse_client_allocation / mp_correct_manual_collection; a rectification
--   never targets Mercado Pago); not a Feria collection (sales_session_id); not corrected nor a component of a 0092 correction;
--   no active bank-statement match on its posting (fin_reverse_statement_match first); period of the original open
--   (assert_period_open) and, for a rectification, register_collection's own checks on the new collection.
-- P&L / fiscal: untouched. pnl_line_item never reads financial_operation / financial_posting / client_ledger / collections
--   (0045, 0070, 0101); no fiscal document is created. report_balance_period follows the ledgers (net effect).
-- fin_customer_collections: an annulled / rectified original no longer counts for the customer (status ANNULLED / RECTIFIED);
--   a replacement is a normal collection; five columns are appended (reversal_kind, reversal_reason, reversal_at,
--   replacement_of, sales_session_id — the Feria session a collection belongs to, 0032 / 0070) — existing columns unchanged.
-- Bank reconciliation (owner decision 2026-10-29): fin_statement_match_collection_reversal_guard (BEFORE INSERT on
--   fin_statement_match, separate trigger; 0073 / 0075 / 0077 untouched) refuses a match on an annulled / rectified original's
--   COLLECTION posting (COLLECTION_REVERSED) and on a reversal's own compensating posting (COLLECTION_REVERSAL_NOT_MATCHABLE);
--   the replacement collection of a rectification is an ordinary collection and stays matchable. Concurrency: the reversal
--   locks the original posting FOR UPDATE before writing and fin_match_statement_line locks the same row FOR UPDATE before
--   inserting, so the two serialise; READ COMMITTED gives the later one a fresh snapshot per statement, so it sees the
--   other's committed match (BANK_MATCHED) or reversal (COLLECTION_REVERSED).
-- SECURITY DEFINER set +4 (2 RPC + collection_reversal_core + the match guard, which no API role can execute).
-- ============================================================================

CREATE TABLE collection_reversal (
  id                         BIGSERIAL PRIMARY KEY,
  collection_id              UUID        NOT NULL UNIQUE REFERENCES collections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  kind                       VARCHAR(10) NOT NULL CHECK (kind IN ('ANNUL', 'RECTIFY')),
  amount                     NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  reversal_operation_id      BIGINT      NOT NULL UNIQUE REFERENCES financial_operation(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  client_reversal_ledger_id  BIGINT      NOT NULL UNIQUE REFERENCES client_ledger(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  replacement_collection_id  UUID        UNIQUE REFERENCES collections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  idempotency_key            VARCHAR(100) NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  reason                     TEXT        NOT NULL CHECK (btrim(reason) <> ''),
  created_by                 UUID        REFERENCES perfiles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_cr_kind_replacement CHECK ((kind = 'RECTIFY') = (replacement_collection_id IS NOT NULL)),
  CONSTRAINT chk_cr_not_self CHECK (replacement_collection_id IS DISTINCT FROM collection_id)
);
ALTER TABLE collection_reversal ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_collection_reversal_immutable
  BEFORE UPDATE OR DELETE ON collection_reversal
  FOR EACH ROW EXECUTE FUNCTION fin_evidence_immutable_guard();
REVOKE ALL ON TABLE collection_reversal FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE collection_reversal TO authenticated;
REVOKE ALL ON SEQUENCE collection_reversal_id_seq FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY collection_reversal_admin_select ON collection_reversal
  FOR SELECT USING (current_app_role() = 'ADMIN');

-- ── shared core (not callable by any API role) ──────────────────────────────
-- Locks and checks the collection, books the compensating operation + client reversal. Returns the locked collection and
-- the two ids, or the stored row when this exact request was already done (replay).
CREATE OR REPLACE FUNCTION collection_reversal_core(
  p_collection_id   UUID,
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
  v_row    collection_reversal%ROWTYPE;
  v_c      collections%ROWTYPE;
  v_type   TEXT;
  v_post   BIGINT;
  v_client TEXT;
  v_op     BIGINT;
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
  PERFORM pg_advisory_xact_lock(hashtextextended('collection_reversal:' || p_collection_id::text, 0));

  SELECT * INTO v_row FROM collection_reversal WHERE collection_id = p_collection_id;
  IF FOUND THEN
    IF v_row.idempotency_key = p_idempotency_key AND v_row.kind = p_kind THEN
      RETURN jsonb_build_object('replayed', true, 'reversal_id', v_row.id, 'reversal_operation_id', v_row.reversal_operation_id,
        'client_reversal_ledger_id', v_row.client_reversal_ledger_id, 'replacement_collection_id', v_row.replacement_collection_id);
    END IF;
    RAISE EXCEPTION 'ALREADY_REVERSED: collection % was already annulled or rectified', p_collection_id;
  END IF;
  IF EXISTS (SELECT 1 FROM collection_reversal WHERE idempotency_key = p_idempotency_key) THEN
    RAISE EXCEPTION 'DUPLICATE_IDEMPOTENCY_KEY';
  END IF;

  SELECT * INTO v_c FROM collections WHERE id = p_collection_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_NOT_FOUND';
  END IF;
  SELECT account_type::TEXT INTO v_type FROM financial_account WHERE id = v_c.financial_account_id;
  IF v_type IS DISTINCT FROM 'CASH' AND v_type IS DISTINCT FROM 'BANK_ACCOUNT' THEN
    RAISE EXCEPTION 'COLLECTION_ACCOUNT_NOT_SUPPORTED: only cash and bank collections are annulled or rectified here';
  END IF;
  IF v_c.sales_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'FERIA_COLLECTION: a Feria collection is corrected through its closing';
  END IF;
  IF EXISTS (SELECT 1 FROM collection_correction WHERE collection_id = v_c.id OR cash_collection_id = v_c.id) THEN
    RAISE EXCEPTION 'PART_OF_CORRECTION: the collection belongs to a Mercado Pago collection correction';
  END IF;

  SELECT p.id INTO v_post
    FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id AND p.financial_account_id = v_c.financial_account_id
   WHERE o.operation_type = 'COLLECTION' AND o.source_entity_type = 'collections' AND o.source_entity_id = v_c.id::TEXT
   ORDER BY p.id LIMIT 1
   FOR UPDATE OF p;                                             -- the row fin_match_statement_line locks
  IF v_post IS NULL THEN
    RAISE EXCEPTION 'COLLECTION_POSTING_NOT_FOUND';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_statement_match WHERE financial_posting_id = v_post AND reversed_at IS NULL) THEN
    RAISE EXCEPTION 'BANK_MATCHED: the collection is reconciled with a bank statement line; reverse that match first';
  END IF;

  PERFORM assert_period_open(v_c.effective_date);
  SELECT nombre INTO v_client FROM clients WHERE id = v_c.cliente_id;

  INSERT INTO financial_operation (operation_type, effective_date, external_ref, source_entity_type, source_entity_id, reason, created_by)
  VALUES ('ADJUSTMENT', v_c.effective_date, 'COLLECTION-REVERSAL:' || v_c.id, 'collections', v_c.id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_op;
  INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date, created_by)
  VALUES (v_op, v_c.financial_account_id, -v_c.amount, v_c.effective_date, v_uid);

  INSERT INTO client_ledger (cliente_id, movement_type, signed_amount, effective_date, ledger_client_name, source_entity_type, source_entity_id, reason, created_by)
  VALUES (v_c.cliente_id, 'REVERSAL', v_c.amount, v_c.effective_date, v_client, 'collection_reversal', v_c.id::TEXT, p_reason, v_uid)
  RETURNING id INTO v_ledger;

  RETURN jsonb_build_object('replayed', false, 'reversal_operation_id', v_op, 'client_reversal_ledger_id', v_ledger, 'amount', v_c.amount,
    'cliente_id', v_c.cliente_id, 'effective_date', v_c.effective_date);
END;
$$;
ALTER FUNCTION collection_reversal_core(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION collection_reversal_core(UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ── Anular cobro ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reverse_collection(
  p_collection_id   UUID,
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
  v_id   BIGINT;
BEGIN
  v_core := collection_reversal_core(p_collection_id, 'ANNUL', p_reason, p_idempotency_key);
  IF (v_core ->> 'replayed')::BOOLEAN THEN
    RETURN v_core;
  END IF;
  INSERT INTO collection_reversal (collection_id, kind, amount, reversal_operation_id, client_reversal_ledger_id, idempotency_key, reason, created_by)
  VALUES (p_collection_id, 'ANNUL', (v_core ->> 'amount')::NUMERIC, (v_core ->> 'reversal_operation_id')::BIGINT,
          (v_core ->> 'client_reversal_ledger_id')::BIGINT, p_idempotency_key, btrim(p_reason), v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('collection_reversal', v_id::TEXT, 'ANNUL_COLLECTION',
          jsonb_build_object('collection_id', p_collection_id, 'amount', v_core -> 'amount', 'reversal_operation', v_core -> 'reversal_operation_id'),
          p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'reversal_id', v_id, 'reversal_operation_id', v_core -> 'reversal_operation_id',
    'client_reversal_ledger_id', v_core -> 'client_reversal_ledger_id', 'replacement_collection_id', NULL);
END;
$$;
ALTER FUNCTION reverse_collection(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION reverse_collection(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION reverse_collection(UUID, TEXT, TEXT) TO authenticated;

-- ── Rectificar cobro ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION rectify_collection(
  p_collection_id        UUID,
  p_cliente_id           UUID,
  p_amount               NUMERIC,
  p_financial_account_id UUID,
  p_effective_date       DATE,
  p_reason               TEXT,
  p_idempotency_key      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    UUID := auth.uid();
  v_core   JSONB;
  v_type   TEXT;
  v_method payment_method;
  v_res    JSONB;
  v_new    UUID;
  v_id     BIGINT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_DATE';
  END IF;
  SELECT account_type::TEXT INTO v_type FROM financial_account WHERE id = p_financial_account_id AND activo;
  v_method := CASE v_type WHEN 'CASH' THEN 'CASH'::payment_method WHEN 'BANK_ACCOUNT' THEN 'TRANSFER'::payment_method END;
  IF v_method IS NULL THEN
    RAISE EXCEPTION 'COLLECTION_ACCOUNT_NOT_SUPPORTED: the corrected collection goes to an active cash or bank account (Mercado Pago keeps its own circuit)';
  END IF;

  v_core := collection_reversal_core(p_collection_id, 'RECTIFY', p_reason, p_idempotency_key);
  IF (v_core ->> 'replayed')::BOOLEAN THEN
    RETURN v_core;
  END IF;
  IF p_cliente_id = (v_core ->> 'cliente_id')::UUID AND p_amount = (v_core ->> 'amount')::NUMERIC
     AND p_financial_account_id = (SELECT financial_account_id FROM collections WHERE id = p_collection_id)
     AND p_effective_date = (v_core ->> 'effective_date')::DATE THEN
    RAISE EXCEPTION 'NOTHING_TO_RECTIFY: the corrected collection is identical to the original';
  END IF;

  v_res := register_collection(p_cliente_id, p_amount, v_method, ('COLLECTION-RECTIFY:' || p_collection_id)::VARCHAR, p_effective_date,
                               p_financial_account_id, NULL, btrim(p_reason));
  v_new := (v_res ->> 'collection_id')::UUID;

  INSERT INTO collection_reversal (collection_id, kind, amount, reversal_operation_id, client_reversal_ledger_id, replacement_collection_id,
                                   idempotency_key, reason, created_by)
  VALUES (p_collection_id, 'RECTIFY', (v_core ->> 'amount')::NUMERIC, (v_core ->> 'reversal_operation_id')::BIGINT,
          (v_core ->> 'client_reversal_ledger_id')::BIGINT, v_new, p_idempotency_key, btrim(p_reason), v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_events (entity_type, entity_id, action, after_values, reason, performed_by)
  VALUES ('collection_reversal', v_id::TEXT, 'RECTIFY_COLLECTION',
          jsonb_build_object('collection_id', p_collection_id, 'amount', v_core -> 'amount', 'reversal_operation', v_core -> 'reversal_operation_id',
                             'replacement_collection_id', v_new, 'new_amount', p_amount, 'new_cliente_id', p_cliente_id,
                             'new_account_id', p_financial_account_id, 'new_effective_date', p_effective_date),
          p_reason, v_uid);
  RETURN jsonb_build_object('replayed', false, 'reversal_id', v_id, 'reversal_operation_id', v_core -> 'reversal_operation_id',
    'client_reversal_ledger_id', v_core -> 'client_reversal_ledger_id', 'replacement_collection_id', v_new);
END;
$$;
ALTER FUNCTION rectify_collection(UUID, UUID, NUMERIC, UUID, DATE, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL     ON FUNCTION rectify_collection(UUID, UUID, NUMERIC, UUID, DATE, TEXT, TEXT) FROM PUBLIC, anon, service_role;
GRANT  EXECUTE ON FUNCTION rectify_collection(UUID, UUID, NUMERIC, UUID, DATE, TEXT, TEXT) TO authenticated;

-- ── Cobros de clientes: the 0092 view, plus the reversal state ([0108] marks every change; existing columns unchanged) ──
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
         NULL::UUID AS sales_session_id
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
       reversal_kind::TEXT AS reversal_kind, reversal_reason, reversal_at, replacement_of, sales_session_id
  FROM manual
UNION ALL
SELECT row_id, business_date, created_at, cliente_id, client_name, amount, account_name, account_type, payment_method, notes,
       financial_operation_id, source_id,
       CASE WHEN component_of IS NOT NULL THEN 'CORRECTION' ELSE 'AUTO_MP' END AS origin,
       'ALLOCATED_TO_CUSTOMER' AS status,
       component_of AS correction_id,
       CASE WHEN component_of IS NOT NULL THEN 'COMPONENT' ELSE 'SINGLE' END AS correction_role,
       true AS counts_for_customer,
       reversal_kind::TEXT AS reversal_kind, reversal_reason, reversal_at, replacement_of, sales_session_id
  FROM mp
) u
WHERE (SELECT current_app_role()) = 'ADMIN';
ALTER VIEW fin_customer_collections OWNER TO postgres;
REVOKE ALL    ON fin_customer_collections FROM PUBLIC, anon, authenticated, service_role;
GRANT  SELECT ON fin_customer_collections TO authenticated;

-- ── Bank reconciliation: an annulled / rectified collection is not matched afterwards ──────────────────────
CREATE OR REPLACE FUNCTION fin_statement_match_collection_reversal_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_op financial_operation%ROWTYPE;
BEGIN
  SELECT * INTO v_op FROM financial_operation WHERE id = NEW.financial_operation_id;
  IF NOT FOUND THEN
    RETURN NEW;   -- the foreign key reports it
  END IF;
  IF v_op.operation_type = 'COLLECTION' AND v_op.source_entity_type = 'collections'
     AND EXISTS (SELECT 1 FROM collection_reversal WHERE collection_id::TEXT = v_op.source_entity_id) THEN
    RAISE EXCEPTION 'COLLECTION_REVERSED: collection % was annulled or rectified; it cannot be reconciled', v_op.source_entity_id;
  END IF;
  IF v_op.operation_type = 'ADJUSTMENT' AND v_op.external_ref LIKE 'COLLECTION-REVERSAL:%' THEN
    RAISE EXCEPTION 'COLLECTION_REVERSAL_NOT_MATCHABLE: the compensating entry of an annulled / rectified collection is not a bank movement';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION fin_statement_match_collection_reversal_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION fin_statement_match_collection_reversal_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_fin_statement_match_collection_reversal
  BEFORE INSERT ON fin_statement_match
  FOR EACH ROW EXECUTE FUNCTION fin_statement_match_collection_reversal_guard();
